// The record of this wallet's own transactions: for each one, its two input notes opened and,
// where it paid somebody, the note it paid with. Kept in the vault, because the chain cannot
// give any of it back: a dummy input and a note sent to someone else are known to nobody but
// the device that made them.
//
// Three things are made from a record, each only when the user asks: a payment receipt, a
// source-of-funds report, and the code of a claim link (docs/protocol.md, section 16).
//
// A record is written when a proof is made, before it leaves the device, so a spend that lands
// late (or after a restart) has one. A proof that never lands leaves a record that describes
// nothing on chain; `landed` is what tells the two apart, and such records are dropped after a
// day.

import type { InputOpening, PreparedTransact, TransactRecord, WalletState } from "@loch/sdk";

export interface StoredInput {
  amount: string;
  publicKey: string;
  blinding: string;
  leafIndex: number;
  tag: string;
}

/** The note a transaction paid to somebody else, opened. */
export interface PaidNote {
  /** The shielded address that was paid (for a claim link: the address of the claim's keys). */
  to: string;
  amount: string;
  blinding: string;
  commitment: string;
}

export interface TxRecord {
  flowId: string;
  /** Milliseconds: when the proof was made. */
  createdAt: number;
  inputs: [StoredInput, StoredInput];
  /** Commitments (decimal) of the two notes the transaction creates. */
  outputs: [string, string];
  paid?: PaidNote;
  /** SECRET. The secret of the claim link this transaction paid for, base64. */
  claim?: string;
}

export const MAX_RECORDS = 1000;
/** A proof names a root the program forgets within 64 transactions; a day is far past any of that. */
const UNLANDED_TTL_MS = 24 * 60 * 60 * 1000;

const storedInput = (input: InputOpening): StoredInput => ({
  amount: input.note.amount.toString(),
  publicKey: input.note.publicKey.toString(),
  blinding: input.note.blinding.toString(),
  leafIndex: input.leafIndex,
  tag: input.tag.toString(),
});

/** The record of a proof that was just made. `ownKey`: the wallet's owner key; an output of any other key with value in it is the payment. */
export function recordOf(flowId: string, prepared: PreparedTransact, ownKey: bigint, now: number, payee?: { to: string; claim?: string }): TxRecord {
  const sent = payee ? prepared.outputs.find((output) => output.note.publicKey !== ownKey && output.note.amount > 0n) : undefined;
  return {
    flowId,
    createdAt: now,
    inputs: [storedInput(prepared.inputs[0]), storedInput(prepared.inputs[1])],
    outputs: [prepared.outputs[0].commitment.toString(), prepared.outputs[1].commitment.toString()],
    ...(sent && payee ? { paid: { to: payee.to, amount: sent.note.amount.toString(), blinding: sent.note.blinding.toString(), commitment: sent.commitment.toString() } } : {}),
    ...(payee?.claim ? { claim: payee.claim } : {}),
  };
}

/** Whether the chain, as `state` has it, shows the record's transaction: its outputs are leaves. */
export function landed(record: TxRecord, state: Pick<WalletState, "leaves">): boolean {
  // Newest leaves first: what is asked about is nearly always recent.
  return state.leaves.lastIndexOf(record.outputs[0]) >= 0;
}

/** Adds a record, newest last; drops records of proofs that are a day old and never landed, and the oldest beyond the cap. */
export function addRecord(list: readonly TxRecord[], record: TxRecord, state: Pick<WalletState, "leaves">, now: number): TxRecord[] {
  const leaves = new Set(state.leaves);
  const kept = list.filter((item) => now - item.createdAt < UNLANDED_TTL_MS || leaves.has(item.outputs[0]));
  return [...kept, record].slice(-MAX_RECORDS);
}

/** The record of the proof of `flowId` that landed, if one did. */
export function landedRecord(list: readonly TxRecord[], flowId: string, state: Pick<WalletState, "leaves">): TxRecord | null {
  return list.find((record) => record.flowId === flowId && landed(record, state)) ?? null;
}

/** A stored record as the SDK's disclosure functions take it. */
export function toTransactRecord(record: TxRecord, signature?: string): TransactRecord {
  const input = (stored: StoredInput): InputOpening => ({
    note: { amount: BigInt(stored.amount), publicKey: BigInt(stored.publicKey), blinding: BigInt(stored.blinding) },
    leafIndex: stored.leafIndex,
    tag: BigInt(stored.tag),
  });
  return {
    ...(signature ? { signature } : {}),
    inputs: [input(record.inputs[0]), input(record.inputs[1])],
    outputs: [BigInt(record.outputs[0]), BigInt(record.outputs[1])],
  };
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const isDecimal = (value: unknown): value is string => typeof value === "string" && value.length <= 78 && DECIMAL.test(value);

function isStoredInput(value: unknown): value is StoredInput {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Partial<StoredInput>;
  return isDecimal(input.amount) && isDecimal(input.publicKey) && isDecimal(input.blinding) && isDecimal(input.tag) && Number.isSafeInteger(input.leafIndex);
}

/** What came back from the vault, with anything that is not a record left out. */
export function parseRecords(value: unknown): TxRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TxRecord => {
    if (typeof item !== "object" || item === null) return false;
    const record = item as Partial<TxRecord>;
    if (typeof record.flowId !== "string" || !Number.isSafeInteger(record.createdAt)) return false;
    if (!Array.isArray(record.inputs) || record.inputs.length !== 2 || !record.inputs.every(isStoredInput)) return false;
    if (!Array.isArray(record.outputs) || record.outputs.length !== 2 || !record.outputs.every(isDecimal)) return false;
    if (record.claim !== undefined && typeof record.claim !== "string") return false;
    const { paid } = record;
    return paid === undefined || (typeof paid === "object" && paid !== null && typeof paid.to === "string" && isDecimal(paid.amount) && isDecimal(paid.blinding) && isDecimal(paid.commitment));
  });
}
