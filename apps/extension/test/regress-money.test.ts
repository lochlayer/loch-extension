// Regression tests for the security review's money findings, adapted from the reviewer's
// demonstrations (extsec-review/unit/money.test.ts, withhold.test.ts, feecap.test.ts). Each of
// these scenarios ended, before the fix, with a withdrawal paid twice, a transfer shown as done
// that never happened, or a fee above the user's limit in a proof.
//
//   finding 1   a retry never proves with other notes while an earlier proof may still land
//   finding 4   a relayer's answer is a claim: "sent" needs the chain, "not sent" releases nothing
//   finding 11  the fee limit is the worker's, whatever the interface sends

import { base58 } from "@scure/base";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { MockRelayer } from "../e2e/mock/services.js";
import type { SpendRecord } from "../src/background/core.js";
import { cancelFlow, dismissFlow, retryFlow, startSpend } from "../src/background/flows.js";
import { handleUi } from "../src/background/router.js";
import { syncWalletNow } from "../src/background/sync.js";
import { failureCopy, plainText } from "../src/shared/copy.js";
import type { Snapshot } from "../src/shared/view.js";
import { type Harness, RELAYER, createHarness, settle } from "./harness.js";
import { connect, dive, fund, otherPoolTransactions, shielded, strangerAddress } from "./steps.js";

const SOL = 1_000_000_000n;
const FEE = 2_500_000n;
const RELAYER2 = "https://relayer2.test";
const JSON_HEADERS = { "content-type": "application/json" };
const unavailable = () => new Response(JSON.stringify({ error: { code: "unavailable", message: "try later" } }), { status: 503, headers: JSON_HEADERS });

type Relay = { inputNullifiers: string[]; outputCommitments: string[]; extData: { fee: string; recipient: string } };

async function ready(h: Harness, deposits: bigint[]): Promise<void> {
  await connect(h);
  fund(h, 30n * SOL);
  for (const amount of deposits) await dive(h, amount);
}

const snap = async (h: Harness) => ((await handleUi(h.core, { loch: "ui", type: "state" })) as { ok: true; value: Snapshot }).value;
const activity = async (h: Harness) => (await snap(h)).activity.map((entry) => `${entry.kind}:${entry.status}`);
const shared = (a: Relay, b: Relay) => a.inputNullifiers.filter((nullifier) => b.inputNullifiers.includes(nullifier));

/** A second relayer, honest, with its own key, reachable at RELAYER2. Returns it once the harness can route to it. */
function secondRelayer(h: Harness, feeLamports = FEE): MockRelayer {
  const key = Keypair.generate();
  h.chain.airdrop(key.publicKey, 10n * SOL);
  const relayer = new MockRelayer({ chain: h.chain, keypair: key, feeLamports });
  const inner = h.transport;
  h.transport = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== RELAYER2) return inner(input, init);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const reply = await relayer.handle(init.method ?? "GET", url.pathname, body);
    if (reply.drop) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: JSON_HEADERS });
  };
  return relayer;
}

/** A relayer that answers every relay request with "unavailable" and keeps what it was given. */
function withholding(h: Harness, answer: () => Response = unavailable): { kept: Relay[] } {
  const kept: Relay[] = [];
  const inner = h.transport;
  h.transport = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === RELAYER && url.pathname === "/v1/relay") {
      kept.push(JSON.parse(String(init.body)) as Relay);
      return answer();
    }
    return inner(input, init);
  };
  return { kept };
}

// --------------------------------------------------------------------------- finding 1

describe("finding 1: a retry spends the notes of the earlier attempt, so only one of the two can land", () => {
  it("a relayer that says 'unavailable', keeps the request and moves its fee: 'Try again' proves with the SAME notes, and the relayer can land only one", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]); // two notes of 1 SOL each
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h);
    // Attempt 1: it quotes FEE at "checking" and FEE - 1 at "proving". Attempt 2: FEE again, so
    // the kept proof (which pays FEE - 1) is not enough for it and a new one is needed.
    const inner = h.transport;
    let infoCalls = 0;
    h.transport = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin !== RELAYER || url.pathname !== "/v1/info") return inner(input, init);
      const body = (await (await inner(input, init)).json()) as { feeLamports: string };
      if (++infoCalls === 2) body.feeLamports = (FEE - 1n).toString();
      return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
    };

    const proofsBefore = h.prover.calls;
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h)) as SpendRecord;
    expect(first.failure).toMatchObject({ code: "relayer-unavailable", retry: true, moved: "unknown" });
    expect(h.prover.calls).toBe(proofsBefore + 1);
    const firstInputs = [...first.inputs!];

    // The user does what the failure screen says: Try again.
    await retryFlow(h.core);
    const second = (await settle(h)) as SpendRecord;
    expect(h.prover.calls).toBe(proofsBefore + 2);
    // The same notes, exactly. Before the fix: disjoint notes, and both proofs landed.
    expect(second.inputs).toEqual(firstInputs);
    expect(kept).toHaveLength(2);
    expect(kept[0]!.outputCommitments).not.toEqual(kept[1]!.outputCommitments);
    expect(shared(kept[0]!, kept[1]!)).toHaveLength(1);
    // Both are remembered: either may be the one that lands.
    expect(second.proofs).toHaveLength(2);

    // The relayer now submits BOTH kept requests.
    h.relayer.feeLamports = FEE - 1n;
    const r1 = await h.relayer.handle("POST", "/v1/relay", kept[0]);
    const r2 = await h.relayer.handle("POST", "/v1/relay", kept[1]);
    expect(r1.status).toBe(200);
    expect(r2).toMatchObject({ status: 409, body: { error: { code: "nullifier_spent" } } });

    // The destination was paid once.
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
    await syncWalletNow(h.core, h.wallet.address);
    expect(await shielded(h)).toMatchObject({ balance: 2n * SOL - SOL / 2n - (FEE - 1n), settling: 0 });
    // And the wallet says what happened: the first proof landed, with the fee that proof paid.
    expect((await snap(h)).activity[0]).toMatchObject({ kind: "surface", status: "confirmed", amount: (SOL / 2n).toString(), fee: (FEE - 1n).toString() });
    expect((await h.core.flow())?.status).toBe("done");
  });

  it("when the kept proof still suits the relayer, 'Try again' sends that same proof again and makes no new one", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h);
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    await settle(h);
    const proofs = h.prover.calls;
    await retryFlow(h.core);
    await settle(h);
    expect(h.prover.calls).toBe(proofs);
    expect(kept).toHaveLength(2);
    expect(kept[1]).toEqual(kept[0]);
    expect((await h.relayer.handle("POST", "/v1/relay", kept[1])).status).toBe(200);
    expect((await h.relayer.handle("POST", "/v1/relay", kept[0])).status).toBe(409);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
  });

  it("two proofs of one flow, landed in the other order: still one payment", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h);
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    await settle(h);
    // A relayer with another key needs another proof.
    const relayer2 = secondRelayer(h);
    relayer2.script.push("unavailable");
    let second: Relay | null = null;
    const inner = h.transport;
    h.transport = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin === RELAYER2 && url.pathname === "/v1/relay") second = JSON.parse(String(init.body)) as Relay;
      return inner(input, init);
    };
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { relayerUrl: RELAYER2 } });
    await retryFlow(h.core);
    await settle(h);
    expect(second).not.toBeNull();
    expect(shared(kept[0]!, second!)).toHaveLength(1);
    // The second relayer sends first, the first one after it.
    expect((await relayer2.handle("POST", "/v1/relay", second)).status).toBe(200);
    expect((await h.relayer.handle("POST", "/v1/relay", kept[0])).status).toBe(409);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
  });

  it("two honest relayers: 'choose another relayer in settings' and try again spends the same notes, and the slow first relayer is refused by the chain", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    const relayer2 = secondRelayer(h);
    const inner = h.transport;
    let delayed: unknown = null;
    h.transport = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin === RELAYER && url.pathname === "/v1/relay") {
        delayed = JSON.parse(String(init.body)); // relayer 1 has it; its connection drops; it sends a bit later
        throw new TypeError("fetch failed");
      }
      return inner(input, init);
    };
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h)) as SpendRecord;
    expect(first.failure).toMatchObject({ code: "relayer-unreachable", retry: true, moved: "unknown" });
    // The advice on the sheet is still there, and now it is safe to follow.
    const copy = failureCopy(first.failure!, { kind: "surface", proofKept: true });
    expect(copy.lines.map(plainText).join(" ")).toContain("choose another relayer in settings and try again here");
    expect(copy.lines.map(plainText).join(" ")).toContain("the same notes are spent, so it cannot be paid twice");

    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { relayerUrl: RELAYER2 } })).toMatchObject({ ok: true });
    await retryFlow(h.core);
    const second = (await settle(h)) as SpendRecord;
    expect(second.status).toBe("done");
    expect(second.inputs).toEqual(first.inputs); // before the fix: other notes
    expect(relayer2.sent).toHaveLength(1);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);

    // Relayer 1 was only slow: it now sends what it was given. Honest behaviour.
    const late = await h.relayer.handle("POST", "/v1/relay", delayed);
    expect(late).toMatchObject({ status: 409, body: { error: { code: "nullifier_spent" } } });
    expect(h.chain.balance(destination)).toBe(SOL / 2n); // before the fix: 1 SOL
    await syncWalletNow(h.core, h.wallet.address);
    expect(await shielded(h)).toMatchObject({ balance: 2n * SOL - SOL / 2n - FEE, settling: 0 });
  });

  it("the other relayer asks more: the user agrees to the new fee in the same flow, and the notes stay the same", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h);
    const relayer2 = secondRelayer(h, FEE + 1000n);
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h)) as SpendRecord;
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { relayerUrl: RELAYER2 } });
    await retryFlow(h.core);
    const asked = (await settle(h)) as SpendRecord;
    // Not back to the form (a new flow would pick other notes): the flow stays, retryable.
    expect(asked.failure).toMatchObject({ code: "fee-changed", amount: (FEE + 1000n).toString(), limit: FEE.toString(), moved: "unknown", retry: true });
    expect(asked.inputs).toEqual(first.inputs);
    expect(h.core.flowView(asked).bound).toBe(true);

    // "Agree and try again": the interface sends the new fee with the retry.
    expect(await handleUi(h.core, { loch: "ui", type: "flow-retry", fee: (FEE + 1000n).toString() })).toMatchObject({ ok: true });
    const done = (await settle(h)) as SpendRecord;
    expect(done.status).toBe("done");
    expect(done.inputs).toEqual(first.inputs);
    expect(done.request?.extData.fee).toBe((FEE + 1000n).toString());
    expect(relayer2.sent).toHaveLength(1);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
    // The withheld first request cannot land any more.
    expect((await h.relayer.handle("POST", "/v1/relay", kept[0])).status).toBe(409);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
    // A fee above the limit cannot be agreed to, whoever asks.
    expect(await handleUi(h.core, { loch: "ui", type: "flow-retry", fee: "900000000" })).toMatchObject({ ok: false });
  });

  it("a relayer that answers 'fee_too_low' and keeps the request does not get a second set of notes either", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h, () => new Response(JSON.stringify({ error: { code: "fee_too_low", message: "the fee is below this relayer's" } }), { status: 400, headers: JSON_HEADERS }));
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h)) as SpendRecord;
    // Before the fix this dropped the notes and sent the user back to the form.
    expect(first.failure).toMatchObject({ code: "fee-changed", moved: "unknown", retry: true });
    expect(first.inputs).toHaveLength(1);
    expect(await shielded(h)).toMatchObject({ settling: 1, spendable: SOL });
    expect(await activity(h)).toEqual(["surface:unknown", "dive:confirmed", "dive:confirmed"]);
    h.relayer.feeLamports = FEE + 500n;
    await retryFlow(h.core, FEE + 500n);
    const second = (await settle(h)) as SpendRecord;
    expect(second.inputs).toEqual(first.inputs);
    expect(shared(kept[0]!, kept[1]!)).toHaveLength(1);
  });

  it("the earlier notes do not cover the new fee: the flow stops, it does not reach for other notes", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    withholding(h);
    const relayer2 = secondRelayer(h, FEE + 1000n);
    // Everything one note holds, to the lamport, at the first relayer's fee.
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL - FEE, fee: FEE });
    const first = (await settle(h)) as SpendRecord;
    expect(first.inputs).toHaveLength(1);
    const proofs = h.prover.calls;
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { relayerUrl: RELAYER2 } });
    await retryFlow(h.core, FEE + 1000n);
    const stopped = (await settle(h)) as SpendRecord;
    expect(stopped.failure).toMatchObject({ code: "reserved-short", moved: "unknown", retry: true, amount: SOL.toString(), limit: (SOL + 1000n).toString() });
    expect(stopped.inputs).toEqual(first.inputs);
    expect(h.prover.calls).toBe(proofs); // no second proof was made
    expect(relayer2.requests.filter((request) => request.path === "/v1/relay")).toEqual([]);
    // The other note is untouched and free.
    expect(await shielded(h)).toMatchObject({ spendable: SOL, settling: 1 });
  });

  it("cancelling a retry lets nothing go: the earlier request is still out", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    withholding(h);
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h)) as SpendRecord;
    // A new proof is needed (another relayer), and the user cancels while it is being made.
    secondRelayer(h);
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { relayerUrl: RELAYER2 } });
    const proving = { release: () => {} };
    const original = h.env.prover.prove.bind(h.env.prover);
    h.env.prover.prove = async (input) => {
      await new Promise<void>((resolve) => (proving.release = resolve));
      return original(input);
    };
    await retryFlow(h.core);
    await settle(h, (flow) => flow.step === "proving");
    await cancelFlow(h.core);
    proving.release();
    const cancelled = (await settle(h)) as SpendRecord;
    expect(cancelled.failure).toMatchObject({ code: "cancelled", moved: "unknown", retry: true });
    expect(cancelled.inputs).toEqual(first.inputs);
    expect(cancelled.proofs).toHaveLength(1);
    expect(await shielded(h)).toMatchObject({ settling: 1, spendable: SOL });
  });

  it("the notes are let go when the chain shows them spent by something else, and only then does a retry use other notes", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h);
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h)) as SpendRecord;

    // The same wallet on another device spends the same note.
    const other = createHarness({ shared: { chain: h.chain, relayer: h.relayer, screener: h.screener, wallet: h.wallet, clock: h.clock, requests: [], tabs: new Map(), held: [], nextTab: { id: 900 } } });
    await connect(other);
    await startSpend(other.core, "send", { to: strangerAddress(), amount: SOL / 4n, fee: FEE });
    const elsewhere = (await settle(other)) as SpendRecord;
    expect(elsewhere.status).toBe("done");
    expect(elsewhere.inputs).toEqual(first.inputs);

    // The withheld request is dead: one of its nullifiers exists.
    expect((await h.relayer.handle("POST", "/v1/relay", kept[0])).status).toBe(409);
    await retryFlow(h.core);
    const second = (await settle(h)) as SpendRecord;
    // The relayer still withholds; what matters is which notes the new proof spends.
    expect(second.inputs).toHaveLength(1);
    expect(second.inputs).not.toEqual(first.inputs);
    expect(second.proofs).toHaveLength(1);
    expect(shared(kept[0]!, kept[1]!)).toEqual([]);
    // Both were this flow's, and only the second can land.
    expect((await h.relayer.handle("POST", "/v1/relay", kept[1])).status).toBe(200);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
  });

  it("the notes are let go when the proof's root has left the on-chain root history", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h);
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h)) as SpendRecord;

    await otherPoolTransactions(h, 63);
    await syncWalletNow(h.core, h.wallet.address);
    expect((await shielded(h)).settling).toBe(1); // 63 later roots: the proof's root is the oldest still accepted
    await otherPoolTransactions(h, 1);
    await retryFlow(h.core);
    const second = (await settle(h)) as SpendRecord;
    // A fresh start: one proof on record, made against the current root.
    expect(second.proofs).toHaveLength(1);
    expect(second.proofs![0]!.root).not.toBe(first.proofs![0]!.root);
    // The old request is refused by the program now, so the two cannot both land.
    expect(await h.relayer.handle("POST", "/v1/relay", kept[0])).toMatchObject({ status: 409, body: { error: { code: "unknown_root" } } });
    expect((await h.relayer.handle("POST", "/v1/relay", kept[1])).status).toBe(200);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
  });

  it("'unknown_root' from the relayer: the proof is made again with the same notes, without asking", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    const inner = h.transport;
    const kept: Relay[] = [];
    h.transport = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin === RELAYER && url.pathname === "/v1/relay") {
        kept.push(JSON.parse(String(init.body)) as Relay);
        // It refuses the first as "close to eviction" (and keeps it); the second it sends.
        if (kept.length === 1) return new Response(JSON.stringify({ error: { code: "unknown_root", message: "the root is close to eviction" } }), { status: 409, headers: JSON_HEADERS });
      }
      return inner(input, init);
    };
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const done = (await settle(h)) as SpendRecord;
    expect(done.status).toBe("done");
    expect(done.reproved).toBe(1);
    expect(shared(kept[0]!, kept[1]!)).toHaveLength(1);
    // The first one, whose root is in fact still valid, cannot land beside it.
    expect((await h.relayer.handle("POST", "/v1/relay", kept[0])).status).toBe(409);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
  });

  it("the worker restarts between attempts: the flow still knows its notes", async () => {
    const h = createHarness();
    await ready(h, [SOL, SOL]);
    const destination = Keypair.generate().publicKey;
    withholding(h);
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const first = (await settle(h)) as SpendRecord;
    const again = h.restart();
    const relayer2 = secondRelayer(again);
    await handleUi(again.core, { loch: "ui", type: "settings", patch: { relayerUrl: RELAYER2 } });
    await retryFlow(again.core);
    const second = (await settle(again)) as SpendRecord;
    expect(second.status).toBe("done");
    expect(second.inputs).toEqual(first.inputs);
    expect(relayer2.sent).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------- finding 4

describe("finding 4: what a relayer says is a claim, and the chain decides", () => {
  it("(a) a made-up signature does not make a transfer: nothing is recorded as done, and the notes stay reserved", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const destination = Keypair.generate().publicKey;
    const fake = base58.encode(new Uint8Array(64).fill(7));
    const inner = h.transport;
    h.transport = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin === RELAYER && url.pathname === "/v1/relay") return new Response(JSON.stringify({ signature: fake }), { status: 200, headers: JSON_HEADERS });
      return inner(input, init);
    };
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const flow = (await settle(h)) as SpendRecord;
    // Before the fix: status "done", "Surfaced.", a confirmed row carrying the made-up id.
    expect(flow.status).toBe("failed");
    expect(flow.failure).toMatchObject({ code: "relayer-unconfirmed", moved: "unknown", retry: true });
    expect(flow.signature).toBeUndefined();
    expect(h.chain.balance(destination)).toBe(0n);
    const view = await snap(h);
    expect(view.activity[0]).toMatchObject({ kind: "surface", status: "unknown" });
    expect(view.activity[0]).not.toHaveProperty("signature");
    expect(JSON.stringify(view.activity)).not.toContain(fake);
    expect(view.shielded).toMatchObject({ settling: 1, spendable: "0", balance: (2n * SOL - SOL / 2n - FEE).toString() });
    const copy = failureCopy(flow.failure!, { kind: "surface" });
    expect(copy.title).toBe("The chain does not show the transfer");

    // Three minutes later, and an hour later, it is still "not known", and the note is still reserved.
    for (const wait of [3 * 60 * 1000 + 1, 60 * 60 * 1000]) {
      h.clock.now += wait;
      await syncWalletNow(h.core, h.wallet.address);
      const later = await snap(h);
      expect(later.activity[0]).toMatchObject({ kind: "surface", status: "unknown" });
      expect(later.shielded).toMatchObject({ settling: 1, spendable: "0" });
    }
  });

  it("(a) a real transfer is recorded once the chain shows it, with the id the relayer gave", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const destination = Keypair.generate().publicKey;
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const flow = (await settle(h)) as SpendRecord;
    expect(flow.status).toBe("done");
    expect((await snap(h)).activity[0]).toMatchObject({ kind: "surface", status: "confirmed", signature: h.relayer.sent[0] });
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
  });

  it("(b) 'unavailable' is what the relayer says: the notes stay reserved for as long as the request can land, and a late landing is recorded", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h);
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    const failed = await settle(h);
    expect(failed.failure).toMatchObject({ code: "relayer-unavailable", moved: "unknown" });
    // The sheet says what is known, not "Nothing was sent".
    const text = failureCopy(failed.failure!, { kind: "surface", shielded: "2000000000" }).lines.map(plainText).join(" ");
    expect(text).toContain("The relayer says it did not send it");
    expect(text).toContain("stay reserved");
    expect(text).not.toContain("Nothing was sent");

    await dismissFlow(h.core); // the user closes the sheet
    h.clock.now += 3 * 60 * 1000 + 1;
    await syncWalletNow(h.core, h.wallet.address);
    // Before the fix: balance back to 2 SOL, nothing settling, no activity row.
    expect((await snap(h)).shielded).toMatchObject({ balance: (2n * SOL - SOL / 2n - FEE).toString(), settling: 1 });
    expect(await activity(h)).toEqual(["surface:unknown", "dive:confirmed"]);

    h.clock.now += 60 * 60 * 1000; // an hour later, no other pool activity
    expect((await h.relayer.handle("POST", "/v1/relay", kept[0])).status).toBe(200);
    expect(h.chain.balance(destination)).toBe(SOL / 2n);
    await syncWalletNow(h.core, h.wallet.address);
    const end = await snap(h);
    expect(end.shielded).toMatchObject({ balance: (2n * SOL - SOL / 2n - FEE).toString(), settling: 0 });
    expect(end.activity[0]).toMatchObject({ kind: "surface", status: "confirmed", amount: (SOL / 2n).toString(), counterparty: destination.toBase58(), fee: FEE.toString() });
  });

  it("(b) a late landing gets a row even when none was there", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const destination = Keypair.generate().publicKey;
    const { kept } = withholding(h);
    await startSpend(h.core, "surface", { to: destination.toBase58(), amount: SOL / 2n, fee: FEE });
    await settle(h);
    await dismissFlow(h.core);
    const runtime = (await h.core.store.runtime(h.wallet.address))!;
    runtime.activity = runtime.activity.filter((entry) => entry.kind !== "surface");
    await h.core.store.saveActivity(runtime);
    expect((await h.relayer.handle("POST", "/v1/relay", kept[0])).status).toBe(200);
    await syncWalletNow(h.core, h.wallet.address);
    expect((await snap(h)).activity[0]).toMatchObject({ kind: "surface", status: "confirmed", amount: (SOL / 2n).toString(), counterparty: destination.toBase58() });
  });

  it("(b) a request that can no longer land is marked as not having happened, and its notes come back", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const { kept } = withholding(h);
    await startSpend(h.core, "surface", { to: Keypair.generate().publicKey.toBase58(), amount: SOL / 2n, fee: FEE });
    await settle(h);
    await dismissFlow(h.core);
    await otherPoolTransactions(h, 64);
    await syncWalletNow(h.core, h.wallet.address);
    expect((await snap(h)).shielded).toMatchObject({ balance: (2n * SOL).toString(), settling: 0, spendable: (2n * SOL).toString() });
    expect((await activity(h))[0]).toBe("surface:failed");
    expect((await h.relayer.handle("POST", "/v1/relay", kept[0])).status).toBe(409);
  });

  it("a failed flow on screen turns into 'done' when a sync finds its transfer", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const { kept } = withholding(h);
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    expect((await settle(h)).status).toBe("failed");
    await h.relayer.handle("POST", "/v1/relay", kept[0]);
    await syncWalletNow(h.core, h.wallet.address); // what the open popup does every 20 seconds
    expect(await h.core.flow()).toMatchObject({ status: "done", step: "done" });
    expect((await h.core.flow())?.failure).toBeUndefined();
  });
});

// -------------------------------------------------------------------------- finding 11

describe("finding 11: the fee limit is enforced by the worker", () => {
  it("an agreed fee above the limit is refused when the spend starts, whatever sent it", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const proofs = h.prover.calls;
    // Only an extension page could send this; the form never does.
    for (const type of ["send", "surface"] as const) {
      const to = type === "send" ? strangerAddress() : Keypair.generate().publicKey.toBase58();
      expect(await handleUi(h.core, { loch: "ui", type, to, amount: (SOL / 2n).toString(), fee: "900000000" })).toMatchObject({ ok: false, error: { message: "fee:above-limit" } });
    }
    expect(await handleUi(h.core, { loch: "ui", type: "consolidate", fee: "5000001" })).toMatchObject({ ok: false });
    expect(await h.core.flow()).toBeNull();
    expect(h.prover.calls).toBe(proofs);
    await expect(startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: 900_000_000n })).rejects.toThrow("fee:above-limit");
  });

  it("the proof is never made for more than the limit, even when the relayer raises its fee between the check and the proof", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const inner = h.transport;
    let infoCalls = 0;
    h.transport = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin !== RELAYER || url.pathname !== "/v1/info") return inner(input, init);
      const body = (await (await inner(input, init)).json()) as { feeLamports: string };
      if (++infoCalls >= 2) body.feeLamports = "900000000"; // 0.9 SOL from the "proving" step on
      return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
    };
    const proofs = h.prover.calls;
    // The agreed fee is the limit itself: the most the interface can send.
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: 5_000_000n });
    const flow = (await settle(h)) as SpendRecord;
    expect(flow.failure).toMatchObject({ code: "fee-changed", moved: "no", amount: "900000000", limit: "5000000" });
    expect(flow.request).toBeUndefined();
    expect(h.prover.calls).toBe(proofs);
  });

  it("the limit in force when the proof is made is the one that counts: lowered while a spend is under way, it binds that spend", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    const proofs = h.prover.calls;
    // The user lowers the limit below the relayer's fee just after the flow has checked it.
    const inner = h.transport;
    let lowered = false;
    h.transport = async (input, init = {}) => {
      const url = new URL(String(input));
      if (!lowered && url.origin === RELAYER && url.pathname === "/v1/info") {
        lowered = true;
        await handleUi(h.core, { loch: "ui", type: "settings", patch: { maxFeeLamports: "1000000" } });
      }
      return inner(input, init);
    };
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    const flow = (await settle(h)) as SpendRecord;
    // Before the fix the proof was bounded by the agreed fee alone, and went out paying 0.0025 SOL
    // against a limit of 0.001 SOL.
    expect(flow.failure).toMatchObject({ code: "fee-changed", moved: "no", amount: FEE.toString(), limit: "1000000" });
    expect(flow.request).toBeUndefined();
    expect(h.prover.calls).toBe(proofs);
    expect(h.relayer.sent).toEqual([]);
    // And a flow that is tried again after the limit was lowered is stopped at the check.
    await retryFlow(h.core, FEE).catch(() => undefined);
    h.transport = inner;
    const again = createHarness();
    await ready(again, [2n * SOL]);
    again.relayer.infoDown = true;
    await startSpend(again.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await settle(again);
    again.relayer.infoDown = false;
    await handleUi(again.core, { loch: "ui", type: "settings", patch: { maxFeeLamports: "1000000" } });
    await retryFlow(again.core);
    expect((await settle(again)).failure).toMatchObject({ code: "fee-above-limit", limit: "1000000" });
  });
});
