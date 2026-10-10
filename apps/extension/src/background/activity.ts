// The activity log: what this wallet did, as far as this device knows. It is kept in the vault,
// because the chain cannot give it back: a sender cannot decrypt the notes it sent.
//
// Entries come from two places. The flows write one when they submit a transaction. A sync
// adds what it finds that no flow of this device explains: notes received from someone else,
// and notes that were already there when this device first looked.

import type { ReceivedNote } from "@loch/sdk";

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
  return foreign.map((note) => ({
    id: `rx-${note.leafIndex}`,
    kind: "receive" as const,
    status: "confirmed" as const,
    at: arrivedAt(note, input.now),
    amount: note.amount.toString(),
  }));
}
