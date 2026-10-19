// Regression tests for the security review's privacy findings, adapted from the reviewer's
// demonstrations (extsec-review/unit/privacy.test.ts and browser/attack.spec.ts, test D).
//
//   finding 3   a website cannot test whether an address is this browser's Loch wallet
//   finding 6   a spend or a sync does not name the public address to the RPC endpoint (the
//               interface reads the public balance live, next to a spend too: the owner's
//               decision of 2026-10-19)
//   finding 9   "forget this wallet" holds against a sync or a scan that is under way
//   item 12     a first-time recipient does not interrupt unless the user asked for that

import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { startSpend } from "../src/background/flows.js";
import { reviewTransactions } from "../src/background/review.js";
import { handleContent, handleUi } from "../src/background/router.js";
import { syncWalletNow } from "../src/background/sync.js";
import { toBase64 } from "../src/shared/bytes.js";
import { MAX_SITE_ACCOUNTS } from "../src/shared/messages.js";
import type { PublicBalanceReply, Snapshot } from "../src/shared/view.js";
import { type Harness, RELAYER, RPC, createHarness, settle } from "./harness.js";
import { connect, dive, fund, strangerAddress } from "./steps.js";

const SOL = 1_000_000_000n;
const FEE = 2_500_000n;
const NOW_S = 1_790_000_000;
const DAPP = "https://dapp.example/";
const OTHER = "https://other.example/";

const snap = async (h: Harness) => ((await handleUi(h.core, { loch: "ui", type: "state" })) as { ok: true; value: Snapshot }).value;
const readBalance = async (h: Harness) => ((await handleUi(h.core, { loch: "ui", type: "public-balance" })) as { ok: true; value: PublicBalanceReply }).value;

/** Every request the worker makes, as an RPC endpoint and a relayer would see them, in order. */
function record(h: Harness): { log: string[]; bodies: string[] } {
  const log: string[] = [];
  const bodies: string[] = [];
  const inner = h.transport;
  h.transport = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === RPC && typeof init.body === "string") {
      bodies.push(init.body);
      const body = JSON.parse(init.body) as { method: string } | { method: string }[];
      for (const call of Array.isArray(body) ? body : [body]) log.push(`RPC ${call.method}`);
    } else if (url.origin === RELAYER) log.push(`RELAYER ${init.method ?? "GET"} ${url.pathname}`);
    return inner(input, init);
  };
  return { log, bodies };
}

function transferTo(from: PublicKey, to: string, sol: number): string {
  const tx = new Transaction({ feePayer: from, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(to), lamports: Math.round(sol * 1e9) }));
  return toBase64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** A connected, unlocked wallet with a leak scan: the state in which a review can produce a warning. */
async function scanned() {
  const h = createHarness();
  await connect(h);
  const regular = Keypair.generate().publicKey.toBase58();
  const funder = Keypair.generate().publicKey.toBase58();
  h.chain.seedTransfers(h.wallet.address, [
    { dir: "in", counterparty: funder, sol: 3, time: NOW_S - 86_400 },
    { dir: "out", counterparty: regular, sol: 0.5, time: NOW_S - 80_000 },
    { dir: "out", counterparty: regular, sol: 0.5, time: NOW_S - 70_000 },
    { dir: "in", counterparty: funder, sol: 1.25, time: NOW_S - 120 },
  ]);
  await handleUi(h.core, { loch: "ui", type: "scan-start" });
  for (const deadline = Date.now() + 20_000; Date.now() < deadline && (await h.core.snapshot()).scan.status !== "done"; ) await new Promise((resolve) => setImmediate(resolve));
  expect((await h.core.snapshot()).scan.status).toBe("done");
  h.tabs.set(9, DAPP);
  h.tabs.set(10, OTHER);
  return { h, regular, funder };
}

const review = (h: Harness, tab: number, url: string, account: string, transactions: string[]) => handleContent(h.core, h.sender(tab, url), { loch: "content", type: "review", account, transactions });
const given = (h: Harness, tab: number, url: string, accounts: string[]) => handleContent(h.core, h.sender(tab, url), { loch: "content", type: "accounts", accounts });

// --------------------------------------------------------------------------- finding 3

describe("finding 3: a review is made only for an account the site was given by the wallet", () => {
  it("a page that was never connected learns nothing: every address gets the same 'pass', the Loch wallet's own included", async () => {
    const { h, regular } = await scanned();
    const real = h.wallet.address;
    // In reality: the public list of addresses that deposited into the pool.
    const candidates = Array.from({ length: 299 }, () => Keypair.generate().publicKey.toBase58());
    candidates.splice(137, 0, real);
    const answers = new Set<string>();
    for (const account of candidates) {
      // A transfer that WOULD draw a warning if it were reviewed: a recurring recipient.
      answers.add(JSON.stringify(await review(h, 9, DAPP, account, [transferTo(new PublicKey(account), regular, 0.2)])));
    }
    // Before the fix: 299 x "pass" and one "warn", for the user's address.
    expect([...answers]).toEqual([JSON.stringify({ action: "pass" })]);
  });

  it("once the wallet has given the site the account, its transactions are reviewed, on that site only", async () => {
    const { h, regular } = await scanned();
    const tx = [transferTo(h.wallet.keypair.publicKey, regular, 0.2)];
    expect(await review(h, 9, DAPP, h.wallet.address, tx)).toEqual({ action: "pass" });
    await given(h, 9, DAPP, [h.wallet.address]);
    expect(await review(h, 9, DAPP, h.wallet.address, tx)).toMatchObject({ action: "warn" });
    // Another origin was given nothing.
    expect(await review(h, 10, OTHER, h.wallet.address, tx)).toEqual({ action: "pass" });
    // What goes to the page's process: the warning and the transfer the page itself supplied.
    expect(Object.keys(await review(h, 9, DAPP, h.wallet.address, tx)).sort()).toEqual(["action", "transfers", "warnings"]);
  });

  it("a site cannot rotate through candidates: the first few addresses it was given are all it gets", async () => {
    const { h, regular } = await scanned();
    const others = Array.from({ length: MAX_SITE_ACCOUNTS }, () => Keypair.generate().publicKey.toBase58());
    await given(h, 9, DAPP, others);
    // The list is full. A page that makes the wallet objects report the real address now gets nothing for it.
    await given(h, 9, DAPP, [h.wallet.address]);
    expect(await review(h, 9, DAPP, h.wallet.address, [transferTo(h.wallet.keypair.publicKey, regular, 0.2)])).toEqual({ action: "pass" });
    const stored = (await h.session.get<Record<string, string[]>>("sites"))!;
    expect(stored[new URL(DAPP).origin]).toEqual(others);
  });

  it("with the wrapper off nothing is recorded and nothing is reviewed", async () => {
    const { h, regular } = await scanned();
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { wrapperEnabled: false } });
    await given(h, 9, DAPP, [h.wallet.address]);
    expect(await h.session.get("sites")).toBeUndefined();
    expect(await review(h, 9, DAPP, h.wallet.address, [transferTo(h.wallet.keypair.publicKey, regular, 0.2)])).toEqual({ action: "pass" });
  });
});

// ----------------------------------------------------------------------------- item 12

describe("item 12: the warning interrupts for findings of medium severity or higher", () => {
  it("a first-time recipient alone does not interrupt, unless the user asked to be warned about those", async () => {
    const { h } = await scanned();
    await given(h, 9, DAPP, [h.wallet.address]);
    const stranger = Keypair.generate().publicKey.toBase58();
    const tx = [transferTo(h.wallet.keypair.publicKey, stranger, 0.2)];
    expect((await snap(h)).settings.warnFirstRecipients).toBe(false);
    expect(await review(h, 9, DAPP, h.wallet.address, tx)).toEqual({ action: "pass" });

    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { warnFirstRecipients: true } })).toMatchObject({ ok: true });
    const warned = await review(h, 9, DAPP, h.wallet.address, tx);
    expect(warned).toMatchObject({ action: "warn", transfers: [{ to: stranger, amount: "0.200 SOL" }] });
    expect("warnings" in warned && warned.warnings.map((warning) => `${warning.id}:${warning.severity}`)).toEqual(["new-counterparty:low"]);
  });

  it("medium findings interrupt by default, and a low one does not ride along with them", async () => {
    const { h, regular } = await scanned();
    await given(h, 9, DAPP, [h.wallet.address]);
    const stranger = Keypair.generate().publicKey.toBase58();
    const recurring = await reviewTransactions(h.core, new URL(DAPP).origin, h.wallet.address, [transferTo(h.wallet.keypair.publicKey, regular, 0.2)]);
    expect(recurring.action === "warn" && recurring.warnings.map((warning) => warning.id)).toEqual(["recurring-counterparty"]);
    // An amount that just arrived, passed straight on to someone new: medium, plus the low "new link".
    const passed = await reviewTransactions(h.core, new URL(DAPP).origin, h.wallet.address, [transferTo(h.wallet.keypair.publicKey, stranger, 1.25)]);
    expect(passed.action === "warn" && passed.warnings.map((warning) => warning.id)).toEqual(["amount-pass-through"]);
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { warnFirstRecipients: true } });
    const both = await reviewTransactions(h.core, new URL(DAPP).origin, h.wallet.address, [transferTo(h.wallet.keypair.publicKey, stranger, 1.25)]);
    expect(both.action === "warn" && both.warnings.map((warning) => warning.id).sort()).toEqual(["amount-pass-through", "new-counterparty"]);
  });
});

// --------------------------------------------------------------------------- finding 6

describe("finding 6: the public address is not named to the RPC endpoint around a private spend", () => {
  it("a send, a surface, a combine and the syncs around them: no RPC request carries the public address", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 20n * SOL);
    for (const amount of [SOL, SOL, SOL]) await dive(h, amount);
    const { log, bodies } = record(h);
    const address = h.wallet.address;

    await syncWalletNow(h.core, address); // what the open popup does every 20 seconds
    await handleUi(h.core, { loch: "ui", type: "sync" });
    await handleUi(h.core, { loch: "ui", type: "quote", want: "spend" });
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    expect((await settle(h)).status).toBe("done");
    await h.core.clearFlow();
    await startSpend(h.core, "surface", { to: Keypair.generate().publicKey.toBase58(), amount: SOL / 4n, fee: FEE });
    expect((await settle(h)).status).toBe("done");
    await h.core.clearFlow();
    await startSpend(h.core, "consolidate", { amount: 0n, fee: FEE });
    expect((await settle(h)).status).toBe("done");
    await h.core.clearFlow();
    await handleUi(h.core, { loch: "ui", type: "select", address });
    await syncWalletNow(h.core, address);

    expect(log.filter((line) => line === "RELAYER POST /v1/relay")).toHaveLength(3);
    expect(log.some((line) => line === "RPC getSignaturesForAddress")).toBe(true);
    // Before the fix: getBalance(<the user's address>) before and after every relay.
    expect(log).not.toContain("RPC getBalance");
    expect(bodies.filter((body) => body.includes(address))).toEqual([]);
    // What the endpoint was asked instead is what every Loch client asks.
    expect([...new Set(log.filter((line) => line.startsWith("RPC ")))].sort()).toEqual(["RPC getAccountInfo", "RPC getGenesisHash", "RPC getSignaturesForAddress", "RPC getTransaction"]);
  });

  it("connecting and syncing show no public balance: it is 'not read yet' until the user asks", async () => {
    const h = createHarness();
    const { bodies } = record(h);
    await connect(h);
    fund(h, 12n * SOL);
    await syncWalletNow(h.core, h.wallet.address);
    expect(await snap(h)).toMatchObject({ publicBalance: null, publicBalanceAt: null });
    expect(bodies.filter((body) => body.includes(h.wallet.address))).toEqual([]);

    // The refresh control, or opening the dive-in form.
    expect(await readBalance(h)).toEqual({ status: "read", lamports: (12n * SOL).toString(), at: h.clock.now });
    expect(await snap(h)).toMatchObject({ publicBalance: (12n * SOL).toString(), publicBalanceAt: h.clock.now });
    expect(bodies.filter((body) => body.includes(h.wallet.address))).toHaveLength(1);
  });

  it("the balance is read when asked during a private spend and right after one (no quiet period)", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 20n * SOL);
    await dive(h, 2n * SOL);

    h.relayer.script.push("hang");
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await settle(h, (flow) => flow.step === "sending" && h.relayer.requests.some((request) => request.path === "/v1/relay"));
    expect(await readBalance(h)).toMatchObject({ status: "read" });

  });

  it("a finished spend does not hold the balance back either", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 20n * SOL);
    await dive(h, 2n * SOL);
    await startSpend(h.core, "surface", { to: Keypair.generate().publicKey.toBase58(), amount: SOL / 2n, fee: FEE });
    expect((await settle(h)).status).toBe("done");
    await h.core.clearFlow();
    expect(await readBalance(h)).toEqual({ status: "read", lamports: expect.any(String), at: h.clock.now });
  });

  it("a dive-in reads it: a deposit is public and comes from that address", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10n * SOL);
    await dive(h, 5n * SOL);
    const view = await snap(h);
    expect(BigInt(view.publicBalance!)).toBeLessThan(5n * SOL);
    expect(view.publicBalanceAt).not.toBeNull();
  });
});

// --------------------------------------------------------------------------- finding 9

describe("finding 9: forget this wallet on this device", () => {
  /** Holds every request for the pool's history until released, as a slow endpoint would. */
  function slowHistory(h: Harness) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    const inner = h.transport;
    let gated = true;
    h.transport = async (input, init = {}) => {
      if (gated && new URL(String(input)).origin === RPC && String(init.body).includes("getSignaturesForAddress")) {
        reached();
        await gate;
      }
      return inner(input, init);
    };
    return {
      atGate,
      open: () => {
        gated = false;
        release();
      },
    };
  }

  async function withNewsOnChain() {
    const h = createHarness();
    await connect(h);
    fund(h, 20n * SOL);
    await dive(h, SOL);
    // Something new is on chain for this wallet: its own second deposit, made from another device.
    const other = createHarness({ shared: { chain: h.chain, relayer: h.relayer, screener: h.screener, wallet: h.wallet, clock: h.clock, requests: h.requests, tabs: h.tabs, held: h.held, nextTab: { id: 900 } } });
    await connect(other);
    await dive(other, SOL);
    return h;
  }

  const holds = (h: Harness, address: string) => JSON.stringify({ local: h.local.dump(), session: h.session.dump() }).includes(address);

  it("a sync that is in flight when Forget is pressed writes nothing back", async () => {
    const h = await withNewsOnChain();
    const address = h.wallet.address;
    const slow = slowHistory(h);
    const sync = syncWalletNow(h.core, address); // what the open popup does every 20 seconds
    await slow.atGate;
    expect(await handleUi(h.core, { loch: "ui", type: "forget", address })).toMatchObject({ ok: true });
    expect(holds(h, address)).toBe(false);
    slow.open();
    await sync;
    await new Promise((resolve) => setImmediate(resolve));
    // Before the fix: vault:<address>:state, :activity and view:<address> were back.
    expect(Object.keys(h.local.dump()).sort()).toEqual(["settings", "wallets"]);
    expect(holds(h, address)).toBe(false);
    expect((await snap(h)).wallets).toEqual([]);
  });

  it("forgetting stops the sync asking the endpoint on", async () => {
    const h = await withNewsOnChain();
    const address = h.wallet.address;
    const slow = slowHistory(h);
    const sync = syncWalletNow(h.core, address);
    await slow.atGate;
    await handleUi(h.core, { loch: "ui", type: "forget", address });
    const before = h.chain.calls.length;
    slow.open();
    await sync;
    // The request that was already out is answered; none follows it.
    expect(h.chain.calls.slice(before).filter((method) => method === "getTransaction")).toEqual([]);
    expect(h.core.syncing.size).toBe(0);
  });

  it("a scan that is in flight writes nothing back either", async () => {
    const h = createHarness();
    await connect(h);
    const address = h.wallet.address;
    h.chain.seedTransfers(address, [{ dir: "in", counterparty: Keypair.generate().publicKey.toBase58(), sol: 3, time: NOW_S - 86_400 }]);
    const slow = slowHistory(h);
    await handleUi(h.core, { loch: "ui", type: "scan-start" });
    await slow.atGate;
    await handleUi(h.core, { loch: "ui", type: "forget", address });
    slow.open();
    for (let i = 0; i < 50 && h.core.scanAbort !== null; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(h.core.scanAbort).toBeNull();
    expect(holds(h, address)).toBe(false);
  });

  it("a flow that is running for the wallet cannot write it back", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 20n * SOL);
    await dive(h, 2n * SOL);
    const address = h.wallet.address;
    h.relayer.script.push("unavailable");
    const slow = slowHistory(h);
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await slow.atGate; // the flow's own sync, in "checking"
    await handleUi(h.core, { loch: "ui", type: "forget", address });
    slow.open();
    await h.core.driving;
    await new Promise((resolve) => setImmediate(resolve));
    expect(holds(h, address)).toBe(false);
    expect(await h.core.flow()).toBeNull();
  });

  it("the same wallet can be connected again afterwards and works", async () => {
    const h = await withNewsOnChain();
    const address = h.wallet.address;
    await handleUi(h.core, { loch: "ui", type: "forget", address });
    await connect(h);
    expect((await snap(h)).shielded?.balance).toBe((2n * SOL).toString());
    expect(Object.keys(h.local.dump()).filter((key) => key.includes(address)).length).toBeGreaterThan(0);
  });

  it("locking has the same effect on a sync that is under way: it writes nothing after the lock", async () => {
    const h = await withNewsOnChain();
    const address = h.wallet.address;
    const state = h.local.dump()[`vault:${address}:state`];
    const slow = slowHistory(h);
    const sync = syncWalletNow(h.core, address);
    await slow.atGate;
    await handleUi(h.core, { loch: "ui", type: "lock" });
    slow.open();
    await sync;
    expect(h.local.dump()[`vault:${address}:state`]).toEqual(state);
  });
});
