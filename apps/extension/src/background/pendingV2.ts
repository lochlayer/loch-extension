// Spends in the v2 pool that were sent from this device and that the v2 wallet state does not
// show yet. The rules of pending.ts, unchanged, over the v2 state: a spend ends when the chain
// shows it landed, or shows that it can no longer land (a note spent by something else, every
// root of its proofs gone from the root history); a deposit also when its blockhash must have
// expired. Each spend is in one asset, and the totals are per asset.
//
// Pure functions over plain data. Nothing here touches the network.

import { type OwnedNoteV2, type WalletStateV2, ownedNotesV2, unspentNotesV2 } from "@loch/sdk/v2";

import type { FlowKind } from "../shared/view.js";
import { type ChainRoots, DEPOSIT_TTL_MS, type PendingEntry, type ProofRoot, spendExpired } from "./pending.js";

export interface PendingSpendV2 {
  flowId: string;
  kind: FlowKind;
  /** The asset the transaction moves (base58 mint). A swap's input asset. */
  mint: string;
  /** Commitments (decimal) of the notes it spends. Empty for a deposit. */
  inputs: string[];
  /** Commitments (decimal) of the notes it creates: three per proof, in proof order (a swap's fourth leaf is not known before it runs). */
  outputs: string[];
  /** Base units of `mint` that leave the shielded balance if it lands (amount plus fee). */
  leaving: string;
  /** Base units of `mint` that arrive (a deposit). */
  arriving: string;
  createdAt: number;
  outcome: "unknown" | "refused";
  proofs?: ProofRoot[];
  entry?: PendingEntry & { mint?: string };
}

export interface ReconciledV2 {
  remaining: PendingSpendV2[];
  landed: PendingSpendV2[];
  released: PendingSpendV2[];
}

function spentOf(state: WalletStateV2): Set<string> {
  return new Set(state.notes.filter((note) => note.spent).map((note) => note.commitment));
}

/** Its outputs are leaves and its own notes are spent. */
export function hasLandedV2(spend: Pick<PendingSpendV2, "inputs" | "outputs">, state: WalletStateV2, spent = spentOf(state), leaves = new Set(state.leaves)): boolean {
  if (!spend.outputs.some((commitment) => leaves.has(commitment))) return false;
  return spend.inputs.every((commitment) => spent.has(commitment));
}

export function inputSpentV2(spend: Pick<PendingSpendV2, "inputs">, state: WalletStateV2, spent = spentOf(state)): boolean {
  return spend.inputs.some((commitment) => spent.has(commitment));
}

/** The fee of the proof that landed: three outputs per proof, in the order of `proofs`. */
export function landedFeeV2(spend: Pick<PendingSpendV2, "outputs" | "proofs">, state: WalletStateV2): string | undefined {
  const leaves = new Set(state.leaves);
  const proofs = spend.proofs ?? [];
  for (let i = 0; i < proofs.length; i++) {
    if (spend.outputs.slice(3 * i, 3 * i + 3).some((commitment) => leaves.has(commitment))) return proofs[i]!.fee;
  }
  return undefined;
}

export function reconcilePendingV2(pending: readonly PendingSpendV2[], state: WalletStateV2, now: number, chain: ChainRoots | null): ReconciledV2 {
  const result: ReconciledV2 = { remaining: [], landed: [], released: [] };
  const leaves = new Set(state.leaves);
  const spent = spentOf(state);
  for (const entry of pending) {
    if (hasLandedV2(entry, state, spent, leaves)) result.landed.push(entry);
    else if (entry.outcome === "refused") result.released.push(entry);
    else if (inputSpentV2(entry, state, spent)) result.released.push(entry);
    else if (entry.kind === "dive" ? now - entry.createdAt > DEPOSIT_TTL_MS : spendExpired(entry, chain)) result.released.push(entry);
    else result.remaining.push(entry);
  }
  return result;
}

export function lockedCommitmentsV2(pending: readonly PendingSpendV2[]): Set<string> {
  const locked = new Set<string>();
  for (const entry of pending) if (entry.outcome !== "refused") for (const commitment of entry.inputs) locked.add(commitment);
  return locked;
}

/** A copy of `state` with every locked note marked spent: the SDK's coin selection cannot pick it. */
export function withLocksV2(state: WalletStateV2, pending: readonly PendingSpendV2[]): WalletStateV2 {
  const locked = lockedCommitmentsV2(pending);
  if (locked.size === 0) return state;
  return { ...state, notes: state.notes.map((note) => (locked.has(note.commitment) ? { ...note, spent: true } : note)) };
}

/** A copy of `state` with every note except `commitments` marked spent. */
export function onlyNotesV2(state: WalletStateV2, commitments: readonly string[]): WalletStateV2 {
  const keep = new Set(commitments);
  return { ...state, notes: state.notes.map((note) => (keep.has(note.commitment) ? note : { ...note, spent: true })) };
}

export function spendableNotesV2(state: WalletStateV2, pending: readonly PendingSpendV2[], mint?: string): OwnedNoteV2[] {
  const locked = lockedCommitmentsV2(pending);
  return unspentNotesV2(state).filter((note) => !locked.has(note.commitment.toString()) && (!mint || note.mint.toBase58() === mint));
}

export interface AssetTotals {
  mint: string;
  /** What the synced state holds. */
  confirmed: bigint;
  /** After every pending spend that can still land has landed. */
  expected: bigint;
  spendable: bigint;
  /** The two largest spendable notes: the most one transaction can move. */
  largestPair: bigint;
  notes: number;
}

/** Totals per asset, every asset with a note or a pending spend. */
export function assetTotals(state: WalletStateV2, pending: readonly PendingSpendV2[]): { assets: AssetTotals[]; settling: number } {
  const unspent = unspentNotesV2(state);
  const present = new Set(unspent.map((note) => note.commitment.toString()));
  const live = pending.filter((entry) => entry.outcome !== "refused" && entry.inputs.every((commitment) => present.has(commitment)));
  const mints = new Set([...unspent.map((note) => note.mint.toBase58()), ...live.map((entry) => entry.mint)]);
  const assets = [...mints].map((mint) => {
    const notes = unspent.filter((note) => note.mint.toBase58() === mint);
    const confirmed = notes.reduce((sum, note) => sum + note.amount, 0n);
    const leaving = live.filter((entry) => entry.mint === mint).reduce((sum, entry) => sum + BigInt(entry.leaving), 0n);
    const spendable = spendableNotesV2(state, pending, mint);
    const sorted = spendable.map((note) => note.amount).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    return {
      mint,
      confirmed,
      expected: leaving > confirmed ? 0n : confirmed - leaving,
      spendable: spendable.reduce((sum, note) => sum + note.amount, 0n),
      largestPair: (sorted[0] ?? 0n) + (sorted[1] ?? 0n),
      notes: notes.length,
    };
  });
  return { assets, settling: live.length };
}

export { ownedNotesV2 };
