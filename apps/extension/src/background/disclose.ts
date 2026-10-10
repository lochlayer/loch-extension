// What the user can take out of the wallet to show someone: a payment receipt, a
// source-of-funds report, a viewing key, and the code of a claim link they paid for. Each is
// made only when the interface asks for it, from the vault's records, and handed to the
// interface as text. None of it is sent anywhere by Loch.

import {
  LochError,
  PROGRAM_ID,
  buildSourceReport,
  decodeShieldedAddress,
  encodeClaim,
  encodeReceipt,
  encodeSourceReport,
  encodeViewingKey,
  noteCommitment,
  nullifierOfOpening,
  viewingKeyOf,
} from "@loch/sdk";

import { fromBase64 } from "../shared/bytes.js";
import type { ClaimCodeReply, ReceiptReply, SourceReportReply, ViewingKeyReply } from "../shared/view.js";
import type { Core } from "./core.js";
import { landed, landedRecord, toTransactRecord } from "./records.js";
import type { WalletRuntime } from "./store.js";

async function active(core: Core): Promise<WalletRuntime> {
  const address = await core.store.active();
  const runtime = address ? await core.store.runtime(address) : null;
  if (!runtime) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
  return runtime;
}

/** The record of the confirmed activity entry `id`, and the entry. */
function recordFor(runtime: WalletRuntime, id: string, kind: "send" | "surface") {
  const entry = runtime.activity.find((item) => item.id === id && item.kind === kind && item.status === "confirmed");
  const record = entry ? landedRecord(runtime.records, id, runtime.state) : null;
  if (!entry || !record) throw new LochError("INVALID_ARGUMENT", "this device has no record of that transaction");
  return { entry, record };
}

export async function receiptFor(core: Core, id: string): Promise<ReceiptReply> {
  const runtime = await active(core);
  const { entry, record } = recordFor(runtime, id, "send");
  if (!record.paid) throw new LochError("INVALID_ARGUMENT", "that transaction paid nobody");
  const recipient = decodeShieldedAddress(record.paid.to);
  const receipt = encodeReceipt({
    programId: PROGRAM_ID,
    // Either nullifier finds the transaction; both are public.
    nullifier: nullifierOfOpening(toTransactRecord(record).inputs[0]),
    ...(entry.signature ? { signature: entry.signature } : {}),
    recipient,
    note: { amount: BigInt(record.paid.amount), publicKey: recipient.publicKey, blinding: BigInt(record.paid.blinding) },
  });
  return { receipt };
}

export async function sourceReportFor(core: Core, id: string): Promise<SourceReportReply> {
  const runtime = await active(core);
  const { record } = recordFor(runtime, id, "surface");
  const signatures = new Map(runtime.activity.filter((item) => item.signature).map((item) => [item.id, item.signature!]));
  const leaves = new Set(runtime.state.leaves);
  const all = runtime.records.filter((item) => leaves.has(item.outputs[0])).map((item) => toTransactRecord(item, signatures.get(item.flowId)));
  const report = buildSourceReport(toTransactRecord(record, signatures.get(id)), all, PROGRAM_ID);
  // What the reader will be told is not traced: a note on the trail that no record here created.
  const created = new Set(all.flatMap((item) => item.outputs.map(String)));
  const undisclosed = [report.withdrawal, ...report.history].flatMap((item) => item.inputs).filter((input) => input.note.amount > 0n && !created.has(noteCommitment(input.note).toString())).length;
  return { report: encodeSourceReport(report), transactions: report.history.length + 1, undisclosed };
}

export async function claimCodeFor(core: Core, id: string): Promise<ClaimCodeReply> {
  const runtime = await active(core);
  const record = runtime.records.find((item) => item.flowId === id && item.claim && item.paid && landed(item, runtime.state));
  if (!record?.paid || !record.claim) throw new LochError("INVALID_ARGUMENT", "this device has no claim link for that transaction");
  const leafIndex = runtime.state.leaves.lastIndexOf(record.paid.commitment);
  if (leafIndex < 0) throw new LochError("STALE_STATE", "the payment is not on chain yet");
  const code = encodeClaim({ secret: fromBase64(record.claim), amount: BigInt(record.paid.amount), blinding: BigInt(record.paid.blinding), leafIndex });
  return { code, amount: record.paid.amount };
}

export async function viewingKeyFor(core: Core): Promise<ViewingKeyReply> {
  return { key: encodeViewingKey(viewingKeyOf((await active(core)).keys)) };
}
