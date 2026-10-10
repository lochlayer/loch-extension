// Spends that were sent from this device and that the wallet state does not show yet.
//
// The SDK's wallet state has no notion of "pending": a note stays unspent in it until a sync
// sees the transaction that spends it. Between handing a request to a relayer and that sync,
// this module is what stops the same notes from being offered to another transaction, and what
// keeps the displayed balance from counting value that is on its way out.
//
// A proof that was handed to a relayer stays valid for as long as its root is in the program's
// root history, whatever the relayer says about it. So a pending spend ends in one of three
// ways, and each is decided from the chain, never from the clock or from a relayer's answer:
//
//   landed     its output commitments are leaves of the tree and its input notes are spent
//   released   it can no longer land: it was never handed over (cancelled), one of its inputs
//              was spent by something else, or every root its proofs were made against has left
//              the on-chain root history
//   (stays)    otherwise, for as long as it takes
//
// A deposit is different: it is a signed transaction, valid only while its blockhash is, so a
// deposit that has been absent for longer than that is released by the clock.
//
// Pure functions over plain data. Nothing here touches the network.

import { type OwnedNote, type TreeAccount, type WalletState, ownedNotes, unspentNotes } from "@loch/sdk";

import type { FlowKind } from "../shared/view.js";

/** What a proof was made against: enough to tell, from the tree account, whether it can still be accepted. */
export interface ProofRoot {
  /** The Merkle root the proof names, decimal. Null for a spend recorded before roots were kept. */
  root: string | null;
  /** How many leaves the tree had when the proof was made. */
  leaves: number;
  /** The relayer fee this proof pays, lamports. A flow's proofs may differ in it. */
  fee?: string;
}

/** What the activity list needs if a spend lands after its flow is gone. */
export interface PendingEntry {
  amount: string;
  fee?: string;
  counterparty?: string;
}

export interface PendingSpend {
  flowId: string;
  kind: FlowKind;
  /** Commitments (decimal) of the notes the transaction spends. Empty for a deposit. */
  inputs: string[];
  /**
   * Commitments (decimal) of the notes it creates: two per proof. A flow that proved more than
   * once (always with the same inputs) lists the outputs of every proof, because any one of them
   * may be the one that lands.
   */
  outputs: string[];
  /** Lamports that leave the shielded balance if it lands: amount plus fee (the fee alone for a consolidation, nothing for a deposit). */
  leaving: string;
  /** Lamports that arrive in the shielded balance if it lands (a deposit). */
  arriving: string;
  /** Milliseconds. */
  createdAt: number;
  /**
   * unknown: handed over, or about to be; it may land.
   * refused: it never left this device (cancelled before it was sent); it cannot land.
   */
  outcome: "unknown" | "refused";
  /** The roots its proofs were made against. Absent for a deposit. */
  proofs?: ProofRoot[];
  /** For the activity list. */
  entry?: PendingEntry;
}

/**
 * How long an unconfirmed DEPOSIT is treated as possibly still landing. A Solana transaction is
 * valid for 150 blocks after its blockhash, about 60 to 90 seconds. Three minutes is past that.
 * Spends are not released by the clock: see the top of this file.
 */
export const DEPOSIT_TTL_MS = 3 * 60 * 1000;

/** The tree account's view of which roots the program still accepts. */
export interface ChainRoots {
  /** Leaves in the on-chain tree. */
  nextIndex: number;
  /** The root history, decimal. Unused slots are "0". */
  roots: string[];
}

export function chainRootsOf(tree: Pick<TreeAccount, "nextIndex" | "roots">): ChainRoots {
  return { nextIndex: tree.nextIndex, roots: tree.roots.map((root) => root.toString()) };
}

/**
 * True when the program can no longer accept a proof made against `proof`, as far as `chain`
 * shows. The chain must be at or past the state the proof was made in (a node that lags behind
 * it has not seen that root yet, which is not the same as having dropped it) and the root must
 * be absent from the history.
 */
export function proofExpired(proof: ProofRoot, chain: ChainRoots): boolean {
  if (chain.nextIndex < proof.leaves) return false;
  if (proof.root === null) {
    // No root on record: wait until the history cannot hold anything that old. A slot is one
    // transaction at most, and a transaction is two leaves.
    return chain.nextIndex >= proof.leaves + 2 * chain.roots.length;
  }
  return proof.root !== "0" && !chain.roots.includes(proof.root);
}

/** True when none of a spend's proofs can be accepted any more. False when that cannot be told. */
export function spendExpired(entry: Pick<PendingSpend, "proofs">, chain: ChainRoots | null): boolean {
  if (!chain || !entry.proofs || entry.proofs.length === 0) return false;
  return entry.proofs.every((proof) => proofExpired(proof, chain));
}

export interface Reconciled {
  remaining: PendingSpend[];
  landed: PendingSpend[];
  released: PendingSpend[];
}

function spentCommitments(state: WalletState): Set<string> {
  return new Set(ownedNotes(state).filter((note) => note.spent).map((note) => note.commitment.toString()));
}

/** Whether a synced `state` shows that the transaction behind `spend` is on chain. */
export function hasLanded(spend: Pick<PendingSpend, "inputs" | "outputs">, state: WalletState, spent = spentCommitments(state), leaves = new Set(state.leaves)): boolean {
  if (!spend.outputs.some((commitment) => leaves.has(commitment))) return false;
  // Its own notes must be gone as well. Output commitments alone are public once a request is
  // out, and anyone who knows a note can put its commitment into the tree with a deposit.
  return spend.inputs.every((commitment) => spent.has(commitment));
}

/**
 * The fee of the proof that landed, when the spend made several: `outputs` lists two commitments
 * per proof, in the order of `proofs`. Undefined when it cannot be told.
 */
export function landedFee(spend: Pick<PendingSpend, "outputs" | "proofs">, state: WalletState): string | undefined {
  const leaves = new Set(state.leaves);
  const proofs = spend.proofs ?? [];
  for (let i = 0; i < proofs.length; i++) {
    const pair = spend.outputs.slice(2 * i, 2 * i + 2);
    if (pair.some((commitment) => leaves.has(commitment))) return proofs[i]!.fee;
  }
  return undefined;
}

/** Whether a synced `state` shows one of the spend's input notes spent (by this spend or by anything else). */
export function inputSpent(spend: Pick<PendingSpend, "inputs">, state: WalletState, spent = spentCommitments(state)): boolean {
  return spend.inputs.some((commitment) => spent.has(commitment));
}

/**
 * Sorts pending spends by what a freshly synced `state` shows. `chain` is the on-chain root
 * history read after that sync, or null when it could not be read (then nothing is released
 * for age).
 */
export function reconcilePending(pending: readonly PendingSpend[], state: WalletState, now: number, chain: ChainRoots | null = null): Reconciled {
  const result: Reconciled = { remaining: [], landed: [], released: [] };
  if (pending.length === 0) return result;
  const leaves = new Set(state.leaves);
  const spent = spentCommitments(state);
  for (const entry of pending) {
    if (hasLanded(entry, state, spent, leaves)) result.landed.push(entry);
    else if (entry.outcome === "refused") result.released.push(entry);
    else if (inputSpent(entry, state, spent)) result.released.push(entry);
    else if (entry.kind === "dive" ? now - entry.createdAt > DEPOSIT_TTL_MS : spendExpired(entry, chain)) result.released.push(entry);
    else result.remaining.push(entry);
  }
  return result;
}

/** Commitments of notes that a pending spend may still consume. */
export function lockedCommitments(pending: readonly PendingSpend[]): Set<string> {
  const locked = new Set<string>();
  for (const entry of pending) {
    if (entry.outcome === "refused") continue;
    for (const commitment of entry.inputs) locked.add(commitment);
  }
  return locked;
}

/** Unspent notes that no pending spend has a claim on. */
export function spendableNotes(state: WalletState, pending: readonly PendingSpend[]): OwnedNote[] {
  const locked = lockedCommitments(pending);
  return unspentNotes(state).filter((note) => !locked.has(note.commitment.toString()));
}

/**
 * A copy of `state` in which every locked note is marked spent, so that the SDK's coin selection
 * cannot pick it. The original is not changed.
 */
export function withLocks(state: WalletState, pending: readonly PendingSpend[]): WalletState {
  const locked = lockedCommitments(pending);
  if (locked.size === 0) return state;
  return { ...state, notes: state.notes.map((note) => (locked.has(note.commitment) ? { ...note, spent: true } : note)) };
}

/**
 * A copy of `state` in which every note except `commitments` is marked spent: the SDK's coin
 * selection can then choose among those notes and no others. Used when a flow proves again, so
 * that the new proof spends what the earlier one spends. The original is not changed.
 */
export function onlyNotes(state: WalletState, commitments: readonly string[]): WalletState {
  const keep = new Set(commitments);
  return { ...state, notes: state.notes.map((note) => (keep.has(note.commitment) ? note : { ...note, spent: true })) };
}

export interface ShieldedTotals {
  /** What the synced state holds. */
  confirmed: bigint;
  /** What it will hold once every pending spend that can still land has landed. Never shown higher than this. */
  expected: bigint;
  /** What can be spent right now. */
  spendable: bigint;
  /** The two largest spendable notes: the most one transaction can move. */
  largestPair: bigint;
  /** Pending spends that can still land. */
  settling: number;
  notes: number;
}

export function shieldedTotals(state: WalletState, pending: readonly PendingSpend[]): ShieldedTotals {
  const unspent = unspentNotes(state);
  const confirmed = unspent.reduce((sum, note) => sum + note.amount, 0n);
  const present = new Set(unspent.map((note) => note.commitment.toString()));
  // A spend counts while every note it would consume is here and unspent. One whose notes this
  // state does not hold (another cluster, a pool that was reset) takes nothing off this balance.
  const live = pending.filter((entry) => entry.outcome !== "refused" && entry.inputs.every((commitment) => present.has(commitment)));
  // Deposits on their way in are not counted until the chain shows them: the balance must never
  // show more than there is.
  const leaving = live.reduce((sum, entry) => sum + BigInt(entry.leaving), 0n);
  const spendable = spendableNotes(state, pending);
  const sorted = spendable.map((note) => note.amount).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return {
    confirmed,
    expected: leaving > confirmed ? 0n : confirmed - leaving,
    spendable: spendable.reduce((sum, note) => sum + note.amount, 0n),
    largestPair: (sorted[0] ?? 0n) + (sorted[1] ?? 0n),
    settling: live.length,
    notes: unspent.length,
  };
}
