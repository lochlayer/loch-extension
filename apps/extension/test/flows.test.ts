import { LIGHTHOUSE_PROGRAM_ID, vaultPda } from "@loch/sdk";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import type { DiveRecord, SpendRecord, UnlockRecord } from "../src/background/core.js";
import { cancelFlow, chooseWallet, resumeFlow, retryFlow, startDive, startSpend, startUnlock } from "../src/background/flows.js";
import { handleUi } from "../src/background/router.js";
import type { WalletRecord } from "../src/background/store.js";
import { syncWalletNow } from "../src/background/sync.js";
import { DEPOSIT_OVERHEAD, SYSTEM_RENT_MINIMUM } from "../src/shared/constants.js";
import { fromBase64 } from "../src/shared/bytes.js";
import type { Snapshot } from "../src/shared/view.js";
import { POOL_LOOKUP_TABLE } from "../e2e/mock/chain.js";
import { CONNECT, type Harness, RELAYER, RPC, SCREENER, createHarness, settle } from "./harness.js";
import { connect, dive, fund, otherPoolTransactions, shielded, strangerAddress } from "./steps.js";

const SOL = 1_000_000_000n;
const FEE = 2_500_000n;

async function snapshot(h: Harness): Promise<Snapshot> {
  const reply = await handleUi(h.core, { loch: "ui", type: "state" });
  if (!reply.ok) throw new Error("no snapshot");
  return reply.value as Snapshot;
}

async function ready(h: Harness, deposits: bigint[] = [2n * SOL]): Promise<void> {
  await connect(h);
  fund(h, 20n * SOL);
  for (const amount of deposits) await dive(h, amount);
}

// ------------------------------------------------------------------------ unlock

describe("unlock", () => {
  it("connects a new wallet: connect, the same signature twice, a vault, a sync", async () => {
    const h = createHarness();
    await startUnlock(h.core, null);
    const choosing = await settle(h);
    expect(choosing).toMatchObject({ kind: "unlock", step: "choosing", status: "waiting" });
    expect((choosing as UnlockRecord).wallets.map((wallet) => wallet.name)).toEqual(["Phantom"]);
    await chooseWallet(h.core, "Phantom");
    const flow = await settle(h);
    expect(flow).toMatchObject({ status: "done", step: "done", address: h.wallet.address });
    expect(h.wallet.prompts.map((prompt) => prompt.kind)).toEqual(["connect", "signMessage", "signMessage"]);

    const view = await snapshot(h);
    expect(view.active).toBe(h.wallet.address);
    expect(view.wallets).toEqual([{ address: h.wallet.address, walletName: "Phantom", unlocked: true }]);
    expect(view.shielded?.address).toMatch(/^loch1[a-z0-9]{109}$/);
    expect(view.shielded?.balance).toBe("0");
    expect(view.sync.status).toBe("synced");
    // The connect tab the extension opened is closed again.
    expect(h.tabs.size).toBe(0);
  });

  it("the flow the interface sees never holds a signature", async () => {
    const h = createHarness();
    h.holdWallet = true;
    await startUnlock(h.core, null);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    await settle(h);
    await h.releaseWallet(); // connect
    await settle(h);
    await h.releaseWallet(); // first signature
    const stored = (await settle(h)) as UnlockRecord;
    expect(stored.step).toBe("signing-again");
    expect(stored.first).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    const view = await snapshot(h);
    expect(JSON.stringify(view)).not.toContain(stored.first);
    expect(view.flow).not.toHaveProperty("first");
  });

  it("a wallet that signs the same message differently each time is refused", async () => {
    const h = createHarness();
    h.wallet.randomised = true;
    await startUnlock(h.core, null);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    const flow = await settle(h);
    expect(flow.failure).toMatchObject({ code: "not-deterministic", moved: "no" });
    expect((flow as UnlockRecord).first).toBeUndefined();
    expect(await h.core.store.wallets()).toEqual([]);
    expect(h.session.dump()).not.toHaveProperty(`secret:${h.wallet.address}`);
  });

  it("a signature that does not verify for the address is refused", async () => {
    const h = createHarness();
    const original = h.wallet.answer.bind(h.wallet);
    h.wallet.answer = (request) => {
      const answer = original(request);
      if (request.kind === "signMessage" && answer.ok && answer.value.kind === "signMessage") {
        return { ok: true, value: { kind: "signMessage", signature: Buffer.alloc(64, 9).toString("base64") } };
      }
      return answer;
    };
    await startUnlock(h.core, null);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    expect((await settle(h)).failure).toMatchObject({ code: "bad-signature" });
  });

  it("the user says no in the wallet: nothing is stored, and trying again works", async () => {
    const h = createHarness();
    h.wallet.decisions.push("approve", "reject");
    await startUnlock(h.core, null);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    const flow = await settle(h);
    expect(flow.failure).toMatchObject({ code: "wallet-rejected", retry: true });
    expect(await h.core.store.wallets()).toEqual([]);

    await retryFlow(h.core);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    expect((await settle(h)).status).toBe("done");
  });

  it("no wallet on the connect page", async () => {
    const h = createHarness();
    h.wallet.features = ["standard:connect"];
    await startUnlock(h.core, null);
    expect((await settle(h)).failure).toMatchObject({ code: "no-wallet", retry: true });
  });

  it("the connect page does not load", async () => {
    const h = createHarness();
    h.env.tabs.create = async () => {
      h.tabs.set(999, "about:blank");
      return { id: 999 };
    };
    await startUnlock(h.core, null);
    expect((await settle(h)).failure).toMatchObject({ code: "connect-page", retry: true });
  });

  it("a new browser session asks for the one signature again and restores the encrypted state", async () => {
    const h = createHarness();
    await ready(h);
    const before = await shielded(h);
    expect(before.balance).toBe(2n * SOL);

    // The browser closes: session storage and memory are gone, the disk stays.
    await h.session.clear();
    const next = createHarness({ local: h.local, shared: { ...h, nextTab: { id: 500 } } });
    let view = await snapshot(next);
    expect(view.wallets[0]).toMatchObject({ address: h.wallet.address, unlocked: false });
    expect(view.shielded).toBeNull();
    expect(view.activity).toEqual([]);

    h.wallet.prompts.length = 0;
    await startUnlock(next.core, h.wallet.address);
    expect((await settle(next)).status).toBe("done");
    expect(h.wallet.prompts.map((prompt) => prompt.kind)).toEqual(["connect", "signMessage"]);
    view = await snapshot(next);
    expect(view.shielded?.balance).toBe((2n * SOL).toString());
    expect(view.activity.map((entry) => entry.kind)).toEqual(["dive"]);
  });

  it("a signature that does not open the vault changes nothing", async () => {
    const h = createHarness();
    await ready(h);
    await h.session.clear();
    // The stored vault was made with another key (here: its salt is replaced).
    const wallets = (await h.local.get<WalletRecord[]>("wallets"))!;
    await h.local.set("wallets", [{ ...wallets[0]!, salt: Buffer.alloc(32, 3).toString("base64") }]);
    const next = createHarness({ local: h.local, shared: { ...h, nextTab: { id: 500 } } });
    await startUnlock(next.core, h.wallet.address);
    const flow = await settle(next);
    expect(flow.failure).toMatchObject({ code: "signature-changed", retry: true });
    expect(await next.core.store.isUnlocked(h.wallet.address)).toBe(false);
  });

  it("the wallet is on another account", async () => {
    const h = createHarness();
    await ready(h, []);
    await h.session.clear();
    const next = createHarness({ local: h.local, shared: { ...h, nextTab: { id: 500 } } });
    const expected = h.wallet.address;
    Object.assign(h.wallet, { keypair: Keypair.generate() });
    await startUnlock(next.core, expected);
    expect((await settle(next)).failure).toMatchObject({ code: "wrong-account" });
  });

  it("the service worker restarts while the wallet's prompt is open", async () => {
    const h = createHarness();
    h.holdWallet = true;
    await startUnlock(h.core, null);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    await settle(h);
    expect(h.held.map((entry) => entry.request.kind)).toEqual(["connect"]);

    // The browser stops the worker. The next event (the wallet's answer) starts a new one.
    const again = h.restart();
    again.holdWallet = true;
    await resumeFlow(again.core);
    expect(await again.core.flow()).toMatchObject({ step: "connecting", status: "waiting" });
    await again.releaseWallet();
    await settle(again);
    const third = again.restart();
    third.holdWallet = false;
    await resumeFlow(third.core);
    await third.releaseWallet();
    const flow = await settle(third);
    expect(flow).toMatchObject({ status: "done" });
    expect((await snapshot(third)).shielded).not.toBeNull();
  });

  it("the service worker restarts while it was opening the connect page", async () => {
    const h = createHarness();
    await h.session.set("flow", { id: "x", kind: "unlock", connectUrl: CONNECT, address: null, expected: null, walletName: null, wallets: [], discoveries: 3, firstTime: true, status: "running", step: "discovering", stepStartedAt: 1, createdAt: 1, attempt: 1 });
    await resumeFlow(h.core);
    expect(await settle(h)).toMatchObject({ step: "choosing", status: "waiting" });
  });

  it("a wallet prompt left unanswered for too long fails cleanly", async () => {
    const h = createHarness();
    h.holdWallet = true;
    await startUnlock(h.core, null);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    await settle(h);
    h.clock.now += 6 * 60 * 1000;
    const again = h.restart();
    await resumeFlow(again.core);
    expect((await again.core.flow())?.failure).toMatchObject({ code: "wallet-timeout", retry: true });
    // The answer that finally arrives is for nobody.
    await again.releaseWallet();
    expect((await again.core.flow())?.status).toBe("failed");
  });

  it("supports more than one public address, each with its own vault", async () => {
    const h = createHarness();
    await ready(h);
    const first = h.wallet.address;
    Object.assign(h.wallet, { keypair: Keypair.generate() });
    await connect(h);
    const second = h.wallet.address;
    let view = await snapshot(h);
    expect(view.wallets.map((wallet) => wallet.address)).toEqual([first, second]);
    expect(view.active).toBe(second);
    expect(view.shielded?.balance).toBe("0");
    await handleUi(h.core, { loch: "ui", type: "select", address: first });
    view = await snapshot(h);
    expect(view.active).toBe(first);
    expect(view.shielded?.balance).toBe((2n * SOL).toString());
  });

  it("lock drops the secrets; forget removes everything about the address from this device", async () => {
    const h = createHarness();
    await ready(h);
    const address = h.wallet.address;
    expect(Object.keys(h.session.dump())).toContain(`secret:${address}`);

    await handleUi(h.core, { loch: "ui", type: "lock" });
    expect(Object.keys(h.session.dump())).not.toContain(`secret:${address}`);
    expect((await snapshot(h)).shielded).toBeNull();
    expect(Object.keys(h.local.dump()).filter((key) => key.includes(address)).length).toBeGreaterThan(0);

    await handleUi(h.core, { loch: "ui", type: "forget", address });
    const left = JSON.stringify({ local: h.local.dump(), session: h.session.dump() });
    expect(left).not.toContain(address);
    expect((await snapshot(h)).wallets).toEqual([]);
  });

  it("what is on disk says nothing about balances, notes or activity", async () => {
    const h = createHarness();
    await ready(h);
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    expect((await settle(h)).status).toBe("done");
    const runtime = (await h.core.store.runtime(h.wallet.address))!;
    const disk = JSON.stringify(h.local.dump());
    for (const note of runtime.state.notes) {
      expect(disk).not.toContain(note.blinding);
      expect(disk).not.toContain(note.nullifier);
      expect(disk).not.toContain(note.commitment);
    }
    expect(disk).not.toContain(runtime.keys.privateKey.toString());
    expect(disk).not.toContain(runtime.shieldedAddress);
    expect(disk).not.toContain('"kind"');
    expect(disk).not.toContain("2000000000");
    // The public address and the wallet's name are there in the clear, and nothing else about it.
    const stored = h.local.dump();
    expect(Object.keys(stored).sort()).toEqual(["active", "settings", `vault:${h.wallet.address}:activity`, `vault:${h.wallet.address}:records`, `vault:${h.wallet.address}:state`, "wallets"]);
  });
});

// ----------------------------------------------------------------------- dive in

describe("dive in", () => {
  it("screens, has the wallet sign, sends and confirms; the amounts are exact", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.wallet.prompts.length = 0;
    await startDive(h.core, 5n * SOL);
    const flow = (await settle(h)) as DiveRecord;
    expect(flow).toMatchObject({ status: "done", step: "done" });
    expect(flow.signature).toBeTruthy();

    expect(h.wallet.prompts.map((prompt) => prompt.kind)).toEqual(["signTransaction"]);
    expect(h.screener.requests).toEqual(["/v1/info", "/v1/screen"]);
    // The wallet is shown the deposit with no signature in it (Phantom warns about one signed
    // before it); the screener's signature is put back before sending.
    const [prompt] = h.wallet.prompts;
    const shown = VersionedTransaction.deserialize(fromBase64(prompt?.kind === "signTransaction" ? prompt.transaction : ""));
    expect(shown.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    // Compiled with the pool's lookup table the screening service named, with the loaded-data
    // limit Phantom asks for, and simulated before the wallet was asked.
    expect(shown.message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58())).toEqual([POOL_LOOKUP_TABLE.toBase58()]);
    expect(shown.message.compiledInstructions.some((instruction) => instruction.data[0] === 4 && instruction.data.length === 5)).toBe(true);
    expect(shown.serialize().length).toBeLessThan(1_232 - 100);
    expect(h.chain.calls.indexOf("simulateTransaction")).toBeGreaterThan(-1);
    expect(h.chain.calls.indexOf("simulateTransaction")).toBeLessThan(h.chain.calls.indexOf("sendTransaction"));
    expect(h.chain.balance(h.wallet.address)).toBe(10n * SOL - 5n * SOL - DEPOSIT_OVERHEAD);
    expect(h.chain.balance(vaultPda())).toBe(SYSTEM_RENT_MINIMUM + 5n * SOL);

    const view = await snapshot(h);
    expect(view.shielded).toMatchObject({ balance: (5n * SOL).toString(), spendable: (5n * SOL).toString(), notes: 1, settling: 0 });
    expect(view.publicBalance).toBe((5n * SOL - DEPOSIT_OVERHEAD).toString());
    expect(view.activity).toMatchObject([{ kind: "dive", status: "confirmed", amount: (5n * SOL).toString(), counterparty: h.wallet.address, signature: flow.signature }]);
    expect(h.tabs.size).toBe(0);
  });

  it("deposits paused", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.chain.paused = true;
    await startDive(h.core, SOL);
    expect((await settle(h)).failure).toMatchObject({ code: "deposits-paused", moved: "no", retry: false });
    expect(h.prover.calls).toBe(0);
  });

  it("above the pool's maximum", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 100n * SOL);
    await startDive(h.core, 11n * SOL);
    expect((await settle(h)).failure).toMatchObject({ code: "above-max", limit: (10n * SOL).toString() });
    expect(h.prover.calls).toBe(0);
  });

  it("not enough public balance once fees and rent are counted", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, SOL);
    await startDive(h.core, SOL);
    expect((await settle(h)).failure).toMatchObject({
      code: "insufficient-public",
      amount: SOL.toString(),
      limit: (SOL + DEPOSIT_OVERHEAD + SYSTEM_RENT_MINIMUM).toString(),
    });
    expect(h.screener.requests).toEqual([]);
  });

  it("screening denied: said plainly, with no detail", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.screener.denied.add(h.wallet.address);
    await startDive(h.core, SOL);
    const flow = await settle(h);
    expect(flow.failure).toEqual({ code: "screening-denied", moved: "no", retry: false });
    expect(h.wallet.prompts.filter((prompt) => prompt.kind === "signTransaction")).toEqual([]);
    expect(h.chain.balance(h.wallet.address)).toBe(10n * SOL);
  });

  it("the screening service does not answer", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.screener.down = true;
    await startDive(h.core, SOL);
    expect((await settle(h)).failure).toMatchObject({ code: "screener-unreachable", retry: true });
    h.screener.down = false;
    await retryFlow(h.core);
    expect((await settle(h)).status).toBe("done");
  });

  it("the wallet rejects: nothing moved, the proof is kept, and trying again does not prove again", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.wallet.decisions.push("reject");
    await startDive(h.core, SOL);
    const failed = await settle(h);
    expect(failed.failure).toMatchObject({ code: "wallet-rejected", moved: "no", retry: true });
    expect(h.core.flowView(failed).proofKept).toBe(true);
    expect(h.prover.calls).toBe(1);
    expect(h.chain.balance(h.wallet.address)).toBe(10n * SOL);
    expect((await snapshot(h)).activity).toEqual([]);

    await retryFlow(h.core);
    expect((await settle(h)).status).toBe("done");
    expect(h.prover.calls).toBe(1);
    expect((await shielded(h)).balance).toBe(SOL);
  });

  it("a wallet that hands back a different transaction is caught before anything is sent", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.wallet.tamper = true;
    await startDive(h.core, SOL);
    expect((await settle(h)).failure).toMatchObject({ code: "wallet-changed-transaction", moved: "no" });
    expect(h.chain.calls).not.toContain("sendTransaction");
    expect(h.chain.balance(h.wallet.address)).toBe(10n * SOL);
  });

  it("a wallet that adds Lighthouse assertions: the screener co-signs what the wallet signed, and it lands", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.wallet.lighthouse = true;
    await startDive(h.core, SOL);
    const flow = (await settle(h)) as DiveRecord;
    expect(flow.failure).toBeUndefined();
    expect(flow.status).toBe("done");
    // Screened twice: the deposit as built, then as the wallet returned it.
    expect(h.screener.screened).toHaveLength(2);
    const sent = h.chain.transactions.at(-1)!.transaction;
    expect(sent.message.staticAccountKeys.some((key) => key.equals(LIGHTHOUSE_PROGRAM_ID))).toBe(true);
    expect(sent.message.addressTableLookups).toHaveLength(1);
    expect((await shielded(h)).balance).toBe(SOL);
  });

  it("a wallet that changes the deposit itself is caught before anything is sent", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.wallet.rewrite = true;
    await startDive(h.core, SOL);
    expect((await settle(h)).failure).toMatchObject({ code: "wallet-changed-transaction", moved: "no" });
    expect(h.screener.screened).toHaveLength(1);
    expect(h.chain.calls).not.toContain("sendTransaction");
    expect(h.chain.balance(h.wallet.address)).toBe(10n * SOL);
  });

  it("a screening service that names no lookup table gets the deposit as before", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.screener.lookupTable = null;
    await startDive(h.core, SOL);
    expect((await settle(h)).status).toBe("done");
    const sent = h.chain.transactions.at(-1)!.transaction;
    expect(sent.message.addressTableLookups).toEqual([]);
    expect(sent.message.compiledInstructions.some((instruction) => instruction.data[0] === 4 && instruction.data.length === 5)).toBe(false);
  });

  it("a deposit the simulation says would fail stops before the wallet is asked", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.wallet.prompts.length = 0;
    h.chain.simulate = async () => ({ err: { InstructionError: [2, { Custom: 6007 }] }, logs: ["Program log: AnchorError occurred. Error Code: DepositsPaused. Error Number: 6007. Error Message: DepositsPaused."] });
    await startDive(h.core, SOL);
    expect((await settle(h)).failure).toMatchObject({ code: "deposits-paused", moved: "no" });
    expect(h.wallet.prompts.filter((prompt) => prompt.kind === "signTransaction")).toEqual([]);
    expect(h.screener.requests).not.toContain("/v1/screen");
  });

  it("the service worker restarts while proving: the step is done again, nothing is lost", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.prover.hang = true;
    await startDive(h.core, SOL);
    await settle(h, (flow) => flow.step === "proving");
    expect(h.prover.calls).toBe(1);

    const again = h.restart();
    await resumeFlow(again.core);
    expect((await settle(again)).status).toBe("done");
    expect(again.prover.calls).toBe(1);
    expect((await shielded(again)).balance).toBe(SOL);
  });

  it("the service worker restarts while the wallet is asking: the answer still completes the deposit", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.holdWallet = true;
    await startDive(h.core, SOL);
    const waiting = await settle(h);
    expect(waiting).toMatchObject({ step: "signing", status: "waiting" });

    const again = h.restart();
    await resumeFlow(again.core);
    expect(await again.core.flow()).toMatchObject({ step: "signing", status: "waiting" });
    await again.releaseWallet();
    expect((await settle(again)).status).toBe("done");
    // One proof only: the restart did not throw the first one away.
    expect(h.prover.calls + again.prover.calls).toBe(1);
    expect((await shielded(again)).balance).toBe(SOL);
  });

  it("the service worker restarts after the deposit was sent: it is not sent twice and is confirmed", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    await startDive(h.core, SOL);
    const done = (await settle(h)) as DiveRecord;
    // Put the record back to the moment after sending, as a worker stopped there would have left it.
    await h.session.set("flow", { ...done, status: "running", step: "sending" });
    const again = h.restart();
    await resumeFlow(again.core);
    expect((await settle(again)).status).toBe("done");
    expect(h.chain.transactions.filter((tx) => tx.signature === done.signature)).toHaveLength(1);
    expect(h.chain.balance(h.wallet.address)).toBe(10n * SOL - SOL - DEPOSIT_OVERHEAD);
  });

  it("a blockhash that expired while the wallet waited: nothing moved, try again", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.holdWallet = true;
    await startDive(h.core, SOL);
    await settle(h);
    h.chain.height += 400;
    await h.releaseWallet();
    const flow = await settle(h);
    expect(flow.failure).toMatchObject({ code: "expired", moved: "no", retry: true });
    expect(h.chain.balance(h.wallet.address)).toBe(10n * SOL);
    h.holdWallet = false;
    await retryFlow(h.core);
    expect((await settle(h)).status).toBe("done");
    expect(h.prover.calls).toBe(1);
  });

  it("cancel while the wallet is asking", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    h.holdWallet = true;
    await startDive(h.core, SOL);
    await settle(h);
    await cancelFlow(h.core);
    expect((await h.core.flow())?.failure).toMatchObject({ code: "cancelled", moved: "no" });
    await h.releaseWallet();
    expect(h.chain.calls).not.toContain("sendTransaction");
  });
});

// ---------------------------------------------------------------- send privately

describe("send privately", () => {
  it("proves, relays and syncs; the fee is the one the user saw", async () => {
    const h = createHarness();
    await ready(h);
    const relayerBefore = h.chain.balance(h.relayer.options.keypair.publicKey);
    const to = strangerAddress();
    await startSpend(h.core, "send", { to, amount: SOL / 2n, fee: FEE });
    const flow = (await settle(h)) as SpendRecord;
    expect(flow).toMatchObject({ status: "done", kind: "send" });
    expect(flow.request?.extData.fee).toBe(FEE.toString());
    expect(flow.signature).toBe(h.relayer.sent[0]);

    const view = await snapshot(h);
    expect(view.shielded).toMatchObject({ balance: (2n * SOL - SOL / 2n - FEE).toString(), settling: 0, notes: 1 });
    expect(view.activity[0]).toMatchObject({ kind: "send", status: "confirmed", amount: (SOL / 2n).toString(), fee: FEE.toString(), counterparty: to });
    // The relayer is paid exactly the fee, out of the pool, and pays the transaction's costs itself.
    expect(h.chain.balance(h.relayer.options.keypair.publicKey)).toBe(relayerBefore + FEE - 5_000n - 2n * 953_520n);
    // The user's wallet does not appear in the transaction.
    const relayed = h.chain.transactions.at(-1)!;
    expect(relayed.accounts).not.toContain(h.wallet.address);
    expect(h.wallet.prompts.at(-1)?.kind).not.toBe("signMessage");
  });

  it("the relayer does not answer: the outcome is unknown, the notes stay reserved, and trying again sends the same proof", async () => {
    const h = createHarness();
    await ready(h);
    const proofs = h.prover.calls;
    h.relayer.script.push("drop");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    const failed = (await settle(h)) as SpendRecord;
    // The request had left when the connection broke. Nobody can say it was not received.
    expect(failed.failure).toMatchObject({ code: "relayer-unreachable", moved: "unknown", retry: true });
    expect(failed.failure?.detail).toContain("relayer.test");
    expect(h.core.flowView(failed)).toMatchObject({ proofKept: true, bound: true, step: "sending" });
    expect(h.prover.calls).toBe(proofs + 1);
    expect(h.relayer.sent).toEqual([]);
    // The notes of that request stay reserved, the balance counts it as sent, and the list says so.
    expect(await shielded(h)).toMatchObject({ settling: 1, balance: 2n * SOL - SOL / 2n - FEE });
    expect((await snapshot(h)).activity.map((entry) => `${entry.kind}:${entry.status}`)).toEqual(["send:unknown", "dive:confirmed"]);

    await retryFlow(h.core);
    const done = (await settle(h)) as SpendRecord;
    expect(done.status).toBe("done");
    expect(h.prover.calls).toBe(proofs + 1);
    expect(done.inputs).toEqual(failed.inputs);
    expect((await shielded(h)).balance).toBe(2n * SOL - SOL / 2n - FEE);
    expect((await snapshot(h)).activity[0]).toMatchObject({ kind: "send", status: "confirmed" });
    expect(done.attempt).toBe(2);
  });

  it("the relayer cannot be reached before anything was handed over: nothing was sent", async () => {
    const h = createHarness();
    await ready(h);
    h.relayer.infoDown = true;
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    const failed = await settle(h);
    expect(failed.failure).toMatchObject({ code: "relayer-unreachable", moved: "no", retry: true });
    expect(h.core.flowView(failed)).toMatchObject({ bound: false, proofKept: false });
    expect(await shielded(h)).toMatchObject({ settling: 0, balance: 2n * SOL });
    expect((await snapshot(h)).activity.map((entry) => entry.kind)).toEqual(["dive"]);
  });

  it("the relayer relayed but its answer was lost: the chain is asked, and the transfer is reported as done", async () => {
    const h = createHarness();
    await ready(h);
    h.relayer.script.push("relay-then-drop");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    const flow = await settle(h);
    expect(flow.status).toBe("done");
    expect(flow.failure).toBeUndefined();
    expect((await shielded(h)).balance).toBe(2n * SOL - SOL / 2n - FEE);
    expect((await snapshot(h)).activity[0]).toMatchObject({ kind: "send", status: "confirmed" });
  });

  it("the relayer is out of service", async () => {
    const h = createHarness();
    await ready(h);
    h.relayer.script.push("unavailable");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    expect((await settle(h)).failure).toMatchObject({ code: "relayer-unavailable", retry: true });
    h.relayer.infoDown = true;
    await retryFlow(h.core);
    expect((await settle(h)).failure).toMatchObject({ code: "relayer-unreachable", retry: true });
  });

  it("the relayer raises its fee after the user agreed: nothing is proven for more than was shown", async () => {
    const h = createHarness();
    await ready(h);
    const proofs = h.prover.calls;
    h.relayer.feeLamports = 3_000_000n;
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    expect((await settle(h)).failure).toMatchObject({ code: "fee-changed", amount: "3000000", limit: FEE.toString(), moved: "no" });
    expect(h.prover.calls).toBe(proofs);
  });

  it("a relayer's fee above the user's own limit is refused", async () => {
    const h = createHarness();
    await ready(h);
    const proofs = h.prover.calls;
    h.relayer.feeLamports = 2n * SOL;
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    expect((await settle(h)).failure).toMatchObject({ code: "fee-above-limit", amount: (2n * SOL).toString(), limit: "5000000", moved: "no" });
    expect(h.prover.calls).toBe(proofs);
    expect((await shielded(h)).balance).toBe(2n * SOL);
  });

  it("more than the shielded balance", async () => {
    const h = createHarness();
    await ready(h);
    await startSpend(h.core, "send", { to: strangerAddress(), amount: 2n * SOL, fee: FEE });
    expect((await settle(h)).failure).toMatchObject({ code: "insufficient-shielded", amount: (2n * SOL).toString(), limit: (2n * SOL + FEE).toString() });
  });

  it("an amount spread over more than two notes: consolidate first, then send", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL, SOL]);
    expect(await shielded(h)).toMatchObject({ balance: 3n * SOL, notes: 3, largestPair: (2n * SOL).toString() });
    const to = strangerAddress();
    await startSpend(h.core, "send", { to, amount: 5n * SOL / 2n, fee: FEE });
    expect((await settle(h)).failure).toMatchObject({ code: "consolidation-needed", count: 3 });
    await h.core.clearFlow();

    await startSpend(h.core, "consolidate", { amount: 0n, fee: FEE });
    expect((await settle(h)).status).toBe("done");
    await h.core.clearFlow();
    expect(await shielded(h)).toMatchObject({ balance: 3n * SOL - FEE, notes: 2 });

    await startSpend(h.core, "send", { to, amount: 5n * SOL / 2n, fee: FEE });
    expect((await settle(h)).status).toBe("done");
    expect((await shielded(h)).balance).toBe(3n * SOL - 2n * FEE - 5n * SOL / 2n);
    expect((await snapshot(h)).activity.map((entry) => entry.kind)).toEqual(["send", "consolidate", "dive", "dive", "dive"]);
  });

  it("cancel while proving: nothing is sent and no note stays reserved", async () => {
    const h = createHarness();
    await ready(h);
    const proving = { release: () => {} };
    const original = h.env.prover.prove.bind(h.env.prover);
    h.env.prover.prove = async (input) => {
      await new Promise<void>((resolve) => (proving.release = resolve));
      return original(input);
    };
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await settle(h, (flow) => flow.step === "proving");
    expect(h.core.flowView((await h.core.flow())!).cancellable).toBe(true);
    await cancelFlow(h.core);
    proving.release();
    expect((await settle(h)).failure).toMatchObject({ code: "cancelled", moved: "no" });
    expect(h.relayer.sent).toEqual([]);
    expect(await shielded(h)).toMatchObject({ balance: 2n * SOL, spendable: 2n * SOL, settling: 0 });
  });

  it("the service worker restarts while proving: the proof is made again and the transfer goes through once", async () => {
    const h = createHarness();
    await ready(h);
    h.prover.hang = true;
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await settle(h, (flow) => flow.step === "proving");
    const again = h.restart();
    await resumeFlow(again.core);
    expect((await settle(again)).status).toBe("done");
    expect(h.relayer.sent).toHaveLength(1);
    expect((await shielded(again)).balance).toBe(2n * SOL - SOL / 2n - FEE);
  });

  it("the service worker restarts while the relayer has the request, and it had not landed: nothing is proven with other notes", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    h.relayer.script.push("hang");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    const sending = (await settle(h, (flow) => flow.step === "sending" && h.relayer.requests.some((r) => r.path === "/v1/relay"))) as SpendRecord;

    const again = h.restart();
    await resumeFlow(again.core);
    const flow = (await again.core.flow()) as SpendRecord;
    expect(flow.failure).toEqual({ code: "interrupted", moved: "unknown", retry: true });
    expect(flow.request).toEqual(sending.request);
    // While the outcome is unknown the note stays reserved and the balance counts it as gone.
    expect(await shielded(again)).toMatchObject({ balance: 2n * SOL - SOL / 2n - FEE, spendable: SOL, settling: 1 });
    expect((await snapshot(again)).activity[0]).toMatchObject({ kind: "send", status: "unknown" });

    // Trying again sends the same proof: the same nullifiers, so at most one can ever land.
    await retryFlow(again.core);
    expect((await settle(again)).status).toBe("done");
    expect(again.prover.calls).toBe(0);
    expect(h.relayer.sent).toHaveLength(1);
    expect(await shielded(again)).toMatchObject({ balance: 2n * SOL - SOL / 2n - FEE, settling: 0 });
    expect((await snapshot(again)).activity[0]).toMatchObject({ kind: "send", status: "confirmed" });
  });

  it("the service worker restarts while the relayer has the request, and it did land: reported as done, not sent again", async () => {
    const h = createHarness();
    await ready(h);
    h.relayer.script.push("relay-then-hang");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await settle(h, () => h.relayer.sent.length === 1);
    const again = h.restart();
    await resumeFlow(again.core);
    expect(await again.core.flow()).toMatchObject({ status: "done" });
    expect(h.relayer.requests.filter((r) => r.path === "/v1/relay")).toHaveLength(1);
    expect((await shielded(again)).balance).toBe(2n * SOL - SOL / 2n - FEE);
  });

  it("between submitting and the next sync the spent note is not offered again", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    h.relayer.script.push("hang");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h, (flow) => flow.step === "sending")) as SpendRecord;
    const runtime = (await h.core.store.runtime(h.wallet.address))!;
    // The SDK's state still calls the note unspent. The pending record is what protects it.
    expect(runtime.state.notes.filter((note) => !note.spent)).toHaveLength(2);
    expect(runtime.pending).toHaveLength(1);
    expect(runtime.pending[0]).toMatchObject({ inputs: first.inputs, outcome: "unknown" });

    // A second transfer made now (a new worker, the first request still out) must use the other note.
    const again = h.restart();
    await again.session.remove("flow");
    await startSpend(again.core, "send", { to: strangerAddress(), amount: SOL / 4n, fee: FEE });
    const second = (await settle(again)) as SpendRecord;
    expect(second.status).toBe("done");
    expect(second.inputs).toHaveLength(1);
    expect(second.inputs![0]).not.toBe(first.inputs![0]);
    expect(await shielded(again)).toMatchObject({ balance: 2n * SOL - SOL / 2n - SOL / 4n - 2n * FEE, settling: 1 });

    // Time does not release the first one's note: its proof is valid until its root leaves the
    // program's history, and the relayer still has it.
    for (const wait of [3 * 60 * 1000 + 1, 60 * 60 * 1000, 24 * 60 * 60 * 1000]) {
      again.clock.now += wait;
      await syncWalletNow(again.core, h.wallet.address);
      expect(await shielded(again)).toMatchObject({ balance: 2n * SOL - SOL / 2n - SOL / 4n - 2n * FEE, settling: 1 });
    }

    // 64 further pool transactions push its root out of the history (the second transfer above
    // was the first of them). Now it cannot land, and a sync that reads the tree account lets
    // the note go.
    await otherPoolTransactions(again, 62);
    await syncWalletNow(again.core, h.wallet.address);
    expect((await shielded(again)).settling).toBe(1);
    await otherPoolTransactions(again, 1);
    await syncWalletNow(again.core, h.wallet.address);
    expect(await shielded(again)).toMatchObject({ balance: 2n * SOL - SOL / 4n - FEE, settling: 0 });
    // The relayer, if it tried now, would be refused by the program.
    expect((await h.relayer.handle("POST", "/v1/relay", first.request)).body).toMatchObject({ error: { code: "unknown_root" } });
  });

  it("everything spendable is reserved: says so instead of calling the balance too low", async () => {
    const h = createHarness();
    await ready(h);
    h.relayer.script.push("hang");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await settle(h, (flow) => flow.step === "sending");
    const again = h.restart();
    await again.session.remove("flow");
    await startSpend(again.core, "send", { to: strangerAddress(), amount: SOL / 4n, fee: FEE });
    expect((await settle(again)).failure).toMatchObject({ code: "notes-busy" });
  });
});

// ----------------------------------------------------------------------- surface

describe("surface", () => {
  it("pays the destination exactly the amount and the relayer exactly the fee", async () => {
    const h = createHarness();
    await ready(h);
    const destination = Keypair.generate().publicKey;
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL, fee: FEE });
    const flow = await settle(h);
    expect(flow.status).toBe("done");
    expect(h.chain.balance(destination)).toBe(SOL);
    expect((await shielded(h)).balance).toBe(2n * SOL - SOL - FEE);
    expect((await snapshot(h)).activity[0]).toMatchObject({ kind: "surface", status: "confirmed", amount: SOL.toString(), counterparty: destination.toBase58(), fee: FEE.toString() });
    // The destination is not asked about before the withdrawal is public.
    expect(h.chain.calls.filter((method) => method === "getAccountInfo" || method === "getBalance").length).toBeGreaterThan(0);
  });

  it("below what a new address must receive", async () => {
    const h = createHarness();
    await ready(h);
    const proofs = h.prover.calls;
    await startSpend(h.core, "surface", { to: Keypair.generate().publicKey.toBase58(), amount: 500_000n, fee: FEE });
    expect((await settle(h)).failure).toMatchObject({ code: "below-minimum", limit: "1000000" });
    expect(h.prover.calls).toBe(proofs);
  });

  it("warns about what links the withdrawal to the deposit, and lets the user go on", async () => {
    const h = createHarness();
    await ready(h);
    const fresh = Keypair.generate().publicKey.toBase58();
    const warnings = async (to: string, amount: bigint) => {
      const reply = await handleUi(h.core, { loch: "ui", type: "surface-warnings", to, amount: amount.toString(), fee: FEE.toString() });
      return reply.ok ? (reply.value as { id: string }[]).map((warning) => warning.id) : null;
    };
    // Just dived in with 2 SOL from this wallet.
    expect(await warnings(fresh, SOL)).toEqual(["soon-after"]);
    expect(await warnings(fresh, 2n * SOL - FEE)).toEqual(["same-amount", "soon-after"]);
    expect(await warnings(h.wallet.address, 2n * SOL - FEE)).toEqual(["same-address", "same-amount", "soon-after"]);
    h.clock.now += 40 * 24 * 60 * 60 * 1000;
    expect(await warnings(fresh, 2n * SOL - FEE)).toEqual([]);
    expect(await warnings(h.wallet.address, SOL)).toEqual(["same-address"]);

    // The warnings do not stop the withdrawal.
    await startSpend(h.core, "surface", { to: h.wallet.address, amount: 2n * SOL - FEE, fee: FEE });
    expect((await settle(h)).status).toBe("done");
    expect((await shielded(h)).balance).toBe(0n);
  });
});

// ------------------------------------------------------------------------ general

describe("the worker as a whole", () => {
  it("one action at a time", async () => {
    const h = createHarness();
    await ready(h);
    h.relayer.script.push("hang");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await settle(h, (flow) => flow.step === "sending");
    expect(await handleUi(h.core, { loch: "ui", type: "dive", amount: SOL.toString() })).toMatchObject({ ok: false });
  });

  it("sync finds what someone else sent and what another device spent", async () => {
    const alice = createHarness();
    await ready(alice);
    const bob = createHarness({ shared: { ...alice, wallet: new (alice.wallet.constructor as new () => typeof alice.wallet)(), tabs: new Map(), held: [], nextTab: { id: 700 } } });
    await connect(bob);
    const bobAddress = (await shielded(bob)).address;

    await startSpend(alice.core, "send", { to: bobAddress, amount: SOL / 2n, fee: FEE });
    expect((await settle(alice)).status).toBe("done");

    // Bob never touched the chain: he finds the note from the pool's events alone.
    await syncWalletNow(bob.core, bob.wallet.address);
    const view = await snapshot(bob);
    expect(view.shielded?.balance).toBe((SOL / 2n).toString());
    expect(view.activity).toMatchObject([{ kind: "receive", status: "confirmed", amount: (SOL / 2n).toString() }]);
    expect(view.activity[0]).not.toHaveProperty("counterparty");
  });

  it("a first sync on a new device reports what it finds as restored, not as received", async () => {
    const h = createHarness();
    await ready(h, [SOL, 2n * SOL]);
    const fresh = createHarness({ shared: { ...h, tabs: new Map(), held: [], nextTab: { id: 800 } } });
    await connect(fresh);
    const view = await snapshot(fresh);
    expect(view.shielded?.balance).toBe((3n * SOL).toString());
    expect(view.activity).toMatchObject([{ kind: "restored", amount: (3n * SOL).toString(), count: 2 }]);
  });

  it("the RPC endpoint is down: the last state stays readable and the status says so", async () => {
    const h = createHarness();
    await ready(h);
    h.chain.down = true;
    const sync = await syncWalletNow(h.core, h.wallet.address);
    expect(sync.status).toBe("unreachable");
    expect(sync.detail).toContain("rpc.test");
    const view = await snapshot(h);
    expect(view.shielded?.balance).toBe((2n * SOL).toString());
    expect(view.activity).toHaveLength(1);
    h.chain.down = false;
    expect((await syncWalletNow(h.core, h.wallet.address)).status).toBe("synced");
  });

  it("no request ever goes anywhere but the three configured endpoints", async () => {
    const h = createHarness();
    await ready(h);
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 4n, fee: FEE });
    await settle(h);
    await h.core.clearFlow();
    await startSpend(h.core, "surface", { to: Keypair.generate().publicKey.toBase58(), amount: SOL / 4n, fee: FEE });
    await settle(h);
    expect(new Set(h.requests)).toEqual(new Set([RPC, RELAYER, SCREENER]));
  });

  it("no secret appears in what the interface is given", async () => {
    const h = createHarness();
    await ready(h);
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 4n, fee: FEE });
    await settle(h);
    const runtime = (await h.core.store.runtime(h.wallet.address))!;
    const view = JSON.stringify(await snapshot(h));
    expect(view).not.toContain(runtime.keys.privateKey.toString());
    expect(view).not.toContain(Buffer.from(runtime.keys.encryptionSecret).toString("base64"));
    expect(view).not.toContain(h.session.dump()[`secret:${h.wallet.address}`] as string);
    for (const note of runtime.state.notes) {
      expect(view).not.toContain(note.blinding);
      expect(view).not.toContain(note.nullifier);
    }
  });
});
