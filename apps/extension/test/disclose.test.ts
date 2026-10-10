// Claim links, receipts, source-of-funds reports, the viewing key and the CSV export: made by the
// worker from the vault's records, and checked here the way a stranger would check them, with
// the SDK against the chain.

import { decodeClaim, decodeReceipt, decodeSourceReport, decodeViewingKey, fetchEvents, verifyReceipt, verifySourceReport, viewNotes } from "@loch/sdk";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { startSpend } from "../src/background/flows.js";
import { handleUi } from "../src/background/router.js";
import { activityCsv } from "../src/shared/export.js";
import type { ClaimCheck, ClaimCodeReply, ReceiptReply, Snapshot, SourceReportReply, UiRequest, ViewingKeyReply } from "../src/shared/view.js";
import { type Harness, TestWallet, createHarness, settle } from "./harness.js";
import { connect, dive, fund, shielded, strangerAddress } from "./steps.js";

const SOL = 1_000_000_000n;
const FEE = 2_500_000n;

async function ui<T>(h: Harness, request: UiRequest): Promise<T> {
  const reply = await handleUi(h.core, request);
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.value as T;
}

async function ready(h: Harness, deposits: bigint[] = [2n * SOL]): Promise<void> {
  await connect(h);
  fund(h, 20n * SOL);
  for (const amount of deposits) await dive(h, amount);
}

async function done(h: Harness): Promise<string> {
  const flow = await settle(h);
  expect(flow.failure).toBeUndefined();
  expect(flow.status).toBe("done");
  await h.core.clearFlow();
  return flow.id;
}

/** A second person's browser on the same chain and services. */
function another(h: Harness): Harness {
  return createHarness({ shared: { chain: h.chain, relayer: h.relayer, screener: h.screener, wallet: new TestWallet(), clock: h.clock, requests: [], tabs: new Map(), held: [], nextTab: { id: 500 } } });
}

const connection = async (h: Harness) => (await h.core.chain()).chain.connection;
const activity = async (h: Harness) => (await ui<Snapshot>(h, { loch: "ui", type: "state" })).activity;

describe("claim link", () => {
  it("pays a link, and someone with nothing but the link collects it", async () => {
    const h = createHarness();
    await ready(h);
    await ui(h, { loch: "ui", type: "send-claim", amount: (SOL / 2n).toString(), fee: FEE.toString() });
    const id = await done(h);
    // The amount, the fee of the payment, and the fee of collecting it, paid ahead.
    expect((await shielded(h)).balance).toBe(2n * SOL - SOL / 2n - 2n * FEE);
    const entry = (await activity(h)).find((item) => item.id === id)!;
    expect(entry).toMatchObject({ kind: "send", status: "confirmed", claim: true, record: true });
    expect(entry.counterparty).toBeUndefined();

    const { code, amount } = await ui<ClaimCodeReply>(h, { loch: "ui", type: "claim-code", id });
    expect(amount).toBe((SOL / 2n + FEE).toString());
    expect(decodeClaim(code).amount).toBe(SOL / 2n + FEE);
    // The link's secret is in no snapshot.
    expect(JSON.stringify(await h.core.snapshot())).not.toContain(code);

    const bob = another(h);
    await connect(bob);
    const link = `https://lochlayer.com/claim#${code}`;
    expect(await ui<ClaimCheck>(bob, { loch: "ui", type: "claim-check", code: link })).toEqual({ ok: true, amount: amount, own: false });
    await ui(bob, { loch: "ui", type: "claim", code: link, fee: FEE.toString() });
    const running = await bob.core.flow();
    expect(JSON.stringify(bob.core.flowView(running!))).not.toContain(code);
    const claimId = await done(bob);
    expect((await shielded(bob)).balance).toBe(SOL / 2n);
    // One entry for it, and it is the collection, not an anonymous "received".
    expect((await activity(bob)).map((item) => [item.id, item.kind, item.amount, item.fee])).toEqual([[claimId, "claim", (SOL / 2n).toString(), FEE.toString()]]);

    // The link is spent. A second collection is told so before anything is proven.
    const proofs = h.prover.calls;
    await ui(h, { loch: "ui", type: "claim", code, fee: FEE.toString() });
    expect((await settle(h)).failure).toMatchObject({ code: "claim-taken", moved: "no" });
    expect(h.prover.calls).toBe(proofs);
  });

  it("the payer takes an uncollected link back", async () => {
    const h = createHarness();
    await ready(h);
    await ui(h, { loch: "ui", type: "send-claim", amount: (SOL / 4n).toString(), fee: FEE.toString() });
    const id = await done(h);
    const { code } = await ui<ClaimCodeReply>(h, { loch: "ui", type: "claim-code", id });
    expect(await ui<ClaimCheck>(h, { loch: "ui", type: "claim-check", code })).toMatchObject({ ok: true, own: true });
    await ui(h, { loch: "ui", type: "claim", code, fee: FEE.toString() });
    await done(h);
    // Back, less the fee of the payment and the fee of collecting.
    expect((await shielded(h)).balance).toBe(2n * SOL - 2n * FEE);
  });

  it("a link survives a restart of the worker: the code is made from what is on disk", async () => {
    const h = createHarness();
    await ready(h);
    await ui(h, { loch: "ui", type: "send-claim", amount: (SOL / 4n).toString(), fee: FEE.toString() });
    const id = await done(h);
    const { code } = await ui<ClaimCodeReply>(h, { loch: "ui", type: "claim-code", id });
    const again = h.restart();
    expect((await ui<ClaimCodeReply>(again, { loch: "ui", type: "claim-code", id })).code).toBe(code);
  });

  it("refuses what is not a code, a code for a note that is not there, and a note below the fee", async () => {
    const h = createHarness();
    await ready(h);
    expect(await ui<ClaimCheck>(h, { loch: "ui", type: "claim-check", code: "  " })).toEqual({ ok: false, reason: "empty" });
    expect(await ui<ClaimCheck>(h, { loch: "ui", type: "claim-check", code: strangerAddress() })).toEqual({ ok: false, reason: "not-a-code" });

    await ui(h, { loch: "ui", type: "send-claim", amount: "1000", fee: FEE.toString() });
    const id = await done(h);
    const { code } = await ui<ClaimCodeReply>(h, { loch: "ui", type: "claim-code", id });
    const broken = `${code.slice(0, -1)}${code.endsWith("q") ? "p" : "q"}`;
    expect(await ui<ClaimCheck>(h, { loch: "ui", type: "claim-check", code: broken })).toEqual({ ok: false, reason: "checksum" });

    // The relayer raised its fee above what the link carries for it.
    h.relayer.feeLamports = FEE + 2_000n;
    await ui(h, { loch: "ui", type: "claim", code, fee: (FEE + 2_000n).toString() });
    expect((await settle(h)).failure).toMatchObject({ code: "claim-too-small" });
  });
});

describe("receipt", () => {
  it("is made for a confirmed payment and checks out against the chain", async () => {
    const h = createHarness();
    await ready(h);
    const to = strangerAddress();
    await startSpend(h.core, "send", { to, amount: SOL / 2n, fee: FEE });
    const id = await done(h);
    const { receipt } = await ui<ReceiptReply>(h, { loch: "ui", type: "receipt", id });
    const verified = await verifyReceipt(await connection(h), decodeReceipt(receipt));
    expect(verified).toMatchObject({ ok: true, amount: SOL / 2n, recipient: to });
    expect((await activity(h)).find((item) => item.id === id)).toMatchObject({ record: true, signature: verified.ok ? verified.signature : "" });
  });

  it("is not made for a deposit, a withdrawal, or a transaction this device has no record of", async () => {
    const h = createHarness();
    await ready(h);
    const [deposit] = await activity(h);
    expect((await handleUi(h.core, { loch: "ui", type: "receipt", id: deposit!.id })).ok).toBe(false);
    expect((await handleUi(h.core, { loch: "ui", type: "receipt", id: "nothing" })).ok).toBe(false);
  });
});

describe("source-of-funds report", () => {
  it("traces a withdrawal through a payment's change back to the deposits", async () => {
    const h = createHarness();
    await ready(h, [SOL, 2n * SOL]);
    // Spends both notes; the change is what the withdrawal then spends.
    await startSpend(h.core, "send", { to: strangerAddress(), amount: 5n * (SOL / 2n), fee: FEE });
    await done(h);
    const destination = Keypair.generate().publicKey.toBase58();
    await startSpend(h.core, "surface", { to: destination, amount: SOL / 4n, fee: FEE });
    const id = await done(h);

    const reply = await ui<SourceReportReply>(h, { loch: "ui", type: "source-report", id });
    expect(reply).toMatchObject({ transactions: 4, undisclosed: 0 });
    const verified = await verifySourceReport(await connection(h), decodeSourceReport(reply.report));
    expect(verified).toMatchObject({ ok: true, complete: true, transactions: 4, withdrawal: { recipient: destination, amount: SOL / 4n, fee: FEE } });
    if (!verified.ok) throw new Error(verified.problem);
    expect(verified.origins.map((origin) => [origin.kind, origin.amount, origin.kind === "deposit" ? origin.depositor : null]).sort()).toEqual([
      ["deposit", SOL, h.wallet.address],
      ["deposit", 2n * SOL, h.wallet.address],
    ]);
    // The report says nothing of who was paid on the way.
    expect(reply.report).not.toContain("loch1");
  });

  it("says what it cannot trace: money that came from someone else", async () => {
    const h = createHarness();
    await ready(h);
    const bob = another(h);
    await connect(bob);
    const bobAddress = (await shielded(bob)).address;
    await startSpend(h.core, "send", { to: bobAddress, amount: SOL, fee: FEE });
    await done(h);
    await bob.core.clearFlow();
    await handleUi(bob.core, { loch: "ui", type: "sync" });
    await vi_waitFor(async () => (await shielded(bob)).balance === SOL);
    await startSpend(bob.core, "surface", { to: Keypair.generate().publicKey.toBase58(), amount: SOL / 2n, fee: FEE });
    const id = await done(bob);
    const reply = await ui<SourceReportReply>(bob, { loch: "ui", type: "source-report", id });
    expect(reply).toMatchObject({ transactions: 1, undisclosed: 1 });
    const verified = await verifySourceReport(await connection(bob), decodeSourceReport(reply.report));
    expect(verified).toMatchObject({ ok: true, complete: false, origins: [{ kind: "undisclosed", amount: SOL }] });
  });
});

async function vi_waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the condition did not come true");
}

describe("viewing key", () => {
  it("reads what the wallet received and holds no spending key", async () => {
    const h = createHarness();
    await ready(h);
    await startSpend(h.core, "send", { to: strangerAddress(), amount: SOL / 2n, fee: FEE });
    await done(h);
    const { key } = await ui<ViewingKeyReply>(h, { loch: "ui", type: "viewing-key" });
    const runtime = (await h.core.store.runtime(h.wallet.address))!;
    const decoded = decodeViewingKey(key);
    expect(decoded.publicKey).toBe(runtime.keys.publicKey);
    expect("privateKey" in decoded).toBe(false);
    const { events } = await fetchEvents(await connection(h));
    expect(viewNotes(events, decoded).map((note) => [note.amount, note.source])).toEqual([
      [2n * SOL, "self"],
      [2n * SOL - SOL / 2n - FEE, "self"],
    ]);
  });

  it("is refused while the wallet is locked", async () => {
    const h = createHarness();
    await ready(h);
    await handleUi(h.core, { loch: "ui", type: "lock" });
    expect((await handleUi(h.core, { loch: "ui", type: "viewing-key" })).ok).toBe(false);
  });
});

describe("activity as CSV", () => {
  it("lists every entry oldest first, signed, and never as a formula", () => {
    const csv = activityCsv([
      { id: "b", kind: "send", status: "confirmed", at: Date.UTC(2026, 9, 10, 12), amount: "500000000", fee: "2500000", counterparty: "loch1abc", signature: "5sig" },
      { id: "a", kind: "dive", status: "confirmed", at: Date.UTC(2026, 9, 10, 11), amount: "2000000000", counterparty: '=cmd|"x"' },
      { id: "c", kind: "send", status: "unknown", at: Date.UTC(2026, 9, 10, 13), amount: "1", claim: true },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "date_utc,action,status,amount_sol,relayer_fee_sol,counterparty,transaction",
      '2026-10-10T11:00:00.000Z,Dived in,Confirmed,2,,"\'=cmd|""x""",',
      "2026-10-10T12:00:00.000Z,Sent privately,Confirmed,-0.5,0.0025,loch1abc,5sig",
      "2026-10-10T13:00:00.000Z,Paid to a claim link,Outcome not known yet,-0.000000001,,,",
      "",
    ]);
  });
});
