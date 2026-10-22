// The activity log: what this wallet did, as far as this device knows. It is kept in the vault,
// because the chain cannot give it back: a sender cannot decrypt the notes it sent.
//
// Entries come from two places. The flows write one when they submit a transaction. A sync
// adds what it finds that no flow of this device explains: notes received from someone else,
// and notes that were already there when this device first looked.

import type { ReceivedNote } from "@loch/sdk";
import { type ReceivedNoteV2, noteInner } from "@loch/sdk/v2";

import { isNative } from "../shared/assets.js";

import type { ActivityEntry, ActivityStatus } from "../shared/view.js";

export const MAX_ACTIVITY = 500;

/** Newest first, capped. */
export function addActivity(list: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  const without = list.filter((item) => item.id !== entry.id);
  return [entry, ...without].sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY);
}

export function setActivityStatus(list: readonly ActivityEntry[], id: string, status: ActivityStatus, signature?: string): ActivityEntry[] {
  return list.map((item) => (item.id === id ? { ...item, status, ...(signature ? { signature } : {}) } : item));
}

export interface ReceivedInput {
  /** Notes a sync found, with the block time of the transaction that made each, where the node gave one. */
  received: readonly ReceivedNote[];
  /** Commitments (decimal) of outputs this device created itself: deposits, change, consolidations. */
  ownOutputs: ReadonlySet<string>;
  /** True for the first sync of a wallet on this device: what it finds predates the device. */
  firstSync: boolean;
  /** Index of the payment code behind the wallet's pay link, if it has one. */
  payLink?: number | null;
  now: number;
}

/**
 * When a received note arrived: the block time of its transaction, as the RPC endpoint reported
 * it (unverified, and only for display), or the moment this device found it when the node gave
 * none or gave one that cannot be right.
 */
function arrivedAt(note: ReceivedNote, now: number): number {
  const at = typeof note.blockTime === "number" && Number.isFinite(note.blockTime) ? Math.round(note.blockTime * 1000) : Number.NaN;
  // Not in the future, and not before Solana existed.
  return at > 1_580_000_000_000 && at <= now ? at : now;
}

/**
 * Activity entries for notes a sync found. Notes this device created are not activity of their
 * own (the flow that made them already has an entry). On a first sync everything found is one
 * "restored" entry: this device cannot know whether those notes were deposits, change or gifts.
 */
export function entriesForReceived(input: ReceivedInput): ActivityEntry[] {
  const foreign = input.received.filter((note) => note.amount > 0n && !input.ownOutputs.has(note.commitment.toString()));
  if (foreign.length === 0) return [];
  if (input.firstSync) {
    const unspent = foreign.filter((note) => !note.spent);
    if (unspent.length === 0) return [];
    const total = unspent.reduce((sum, note) => sum + note.amount, 0n);
    return [{ id: `restored-${unspent[0]!.leafIndex}`, kind: "restored", status: "confirmed", at: input.now, amount: total.toString(), count: unspent.length }];
  }
  const viaPayLink = (note: ReceivedNote) =>
    input.payLink !== null && input.payLink !== undefined && typeof note.source === "object" && note.source.code === input.payLink;
  return foreign.map((note) => ({
    id: `rx-${note.leafIndex}`,
    kind: "receive" as const,
    status: "confirmed" as const,
    at: arrivedAt(note, input.now),
    amount: note.amount.toString(),
    ...(viaPayLink(note) ? { via: "pay-link" as const } : {}),
  }));
}

/**
 * Activity entries for v2 notes a sync found, by the rules of `entriesForReceived`. A note this
 * device made is no activity of its own: its commitment is among `ownOutputs`, or, for a swap's
 * output (whose commitment is only known once the swap ran), its inner commitment is, as
 * `swap:<flow id>:<inner>`; the swap's entry is given the amount it returned instead.
 */
export function entriesForReceivedV2(
  input: Omit<ReceivedInput, "received"> & { received: readonly ReceivedNoteV2[]; activity: readonly ActivityEntry[] },
): { entries: ActivityEntry[]; activity: ActivityEntry[] } {
  let activity = [...input.activity];
  const swaps = new Map<string, string>();
  for (const item of input.ownOutputs) {
    const match = /^swap:([^:]+):(\d+)$/.exec(item);
    if (match) swaps.set(match[2]!, match[1]!);
  }
  const foreign: ReceivedNoteV2[] = [];
  for (const note of input.received) {
    if (note.amount <= 0n || input.ownOutputs.has(note.commitment.toString())) continue;
    const flowId = swaps.get(noteInner(note.owner, note.blinding).toString());
    if (flowId) {
      activity = activity.map((item) => (item.id === flowId ? { ...item, amountOut: note.amount.toString(), toMint: note.mint.toBase58() } : item));
      continue;
    }
    foreign.push(note);
  }
  const mintOf = (note: ReceivedNoteV2) => (isNative(note.mint.toBase58()) ? {} : { mint: note.mint.toBase58() });
  if (foreign.length === 0) return { entries: [], activity };
  if (input.firstSync) {
    const unspent = foreign.filter((note) => !note.spent);
    // One entry per asset: amounts of different assets do not add up.
    const byMint = new Map<string, ReceivedNoteV2[]>();
    for (const note of unspent) byMint.set(note.mint.toBase58(), [...(byMint.get(note.mint.toBase58()) ?? []), note]);
    const entries = [...byMint.values()].map((notes) => ({
      id: `restored2-${notes[0]!.leafIndex}`,
      kind: "restored" as const,
      status: "confirmed" as const,
      at: input.now,
      amount: notes.reduce((sum, note) => sum + note.amount, 0n).toString(),
      count: notes.length,
      pool: 2 as const,
      ...mintOf(notes[0]!),
    }));
    return { entries, activity };
  }
  const viaPayLink = (note: ReceivedNoteV2) => input.payLink !== null && input.payLink !== undefined && typeof note.source === "object" && note.source.code === input.payLink;
  const entries = foreign.map((note) => ({
    id: `rx2-${note.leafIndex}`,
    kind: "receive" as const,
    status: "confirmed" as const,
    at: arrivedAtV2(note, input.now),
    amount: note.amount.toString(),
    pool: 2 as const,
    ...mintOf(note),
    ...(viaPayLink(note) ? { via: "pay-link" as const } : {}),
  }));
  return { entries, activity };
}

function arrivedAtV2(note: ReceivedNoteV2, now: number): number {
  const at = typeof note.blockTime === "number" && Number.isFinite(note.blockTime) ? Math.round(note.blockTime * 1000) : Number.NaN;
  return at > 1_580_000_000_000 && at <= now ? at : now;
}
