// Wallet state v2: a plain JSON object the caller persists, like v1's. It holds
// note secrets, so store it encrypted. One state belongs to one key set (named
// by its `ownerRoot`) and one program, and covers every asset.

import { PublicKey } from "@solana/web3.js";

import { bytesToHex, hexToBytes } from "../bytes.js";
import { FIELD_MODULUS, MAX_AMOUNT, PAYMENT_CODE_GAP, PROGRAM_ID } from "../constants.js";
import { ConsolidationRequiredError, InsufficientBalanceError, LochError, SyncError } from "../errors.js";
import { assertAmount } from "../field.js";
import { MerkleTree } from "../merkle.js";
import { type AssetTable, assetId } from "./asset.js";
import { LEAVES_PER_TRANSACTION_V2, TREE_DEPTH_V2 } from "./constants.js";
import type { TransactV2Event } from "./codec.js";
import { type FullViewingKey, MAX_ADDRESS_INDEX, type PaymentCodeV2, ownerOf, paymentCodeAtV2, paymentCodeSecretV2 } from "./keys.js";
import { type NoteSourceV2, type NoteV2, type PaymentCodeCandidateV2, noteCommitmentV2, noteNullifierV2, openNoteV2 } from "./note.js";
import type { TransactionTime } from "../events.js";

export const WALLET_STATE_V2_VERSION = 2;

/** One of the wallet's notes as stored; bigints are decimal strings. */
export interface StoredNoteV2 {
  leafIndex: number;
  /** The note's asset, by mint (base58). */
  mint: string;
  amount: string;
  blinding: string;
  /** Diversifier of the address it was paid to, hex. */
  d: string;
  commitment: string;
  nullifier: string;
  spent: boolean;
}

export interface PaymentCodeCountsV2 {
  issued: number;
  used: number;
}

/** Everything a v2 wallet keeps between sessions. */
export interface WalletStateV2 {
  version: 2;
  programId: string;
  /** `Poseidon(ak, nk)` of the key set, decimal: names the wallet without revealing a key. */
  ownerRoot: string;
  /** Every leaf of the v2 tree in index order, decimal strings. Always a multiple of four. */
  leaves: string[];
  /** The wallet's notes with a non-zero amount, in leaf order. */
  notes: StoredNoteV2[];
  lastSignature: string | null;
  paymentCodes?: PaymentCodeCountsV2;
}

/** A note of the wallet, ready to spend. */
export interface OwnedNoteV2 extends NoteV2 {
  mint: PublicKey;
  d: Uint8Array;
  leafIndex: number;
  commitment: bigint;
  nullifier: bigint;
  spent: boolean;
}

/** A note the wallet just received, with how it was addressed and, when known, when. */
export interface ReceivedNoteV2 extends OwnedNoteV2, TransactionTime {
  source: NoteSourceV2;
}

export function createWalletStateV2(keys: Pick<FullViewingKey, "ownerRoot">, programId: PublicKey = PROGRAM_ID): WalletStateV2 {
  return { version: WALLET_STATE_V2_VERSION, programId: programId.toBase58(), ownerRoot: keys.ownerRoot.toString(), leaves: [], notes: [], lastSignature: null };
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
function decimalBelow(value: unknown, limit: bigint): bigint | null {
  if (typeof value !== "string" || value.length > 78 || !DECIMAL.test(value)) return null;
  const parsed = BigInt(value);
  return parsed < limit ? parsed : null;
}

/**
 * Checks a state that came back from storage: shapes, ranges, leaf order,
 * and that every note is the leaf at its index for this wallet's `ownerRoot`.
 *
 * @throws SyncError `state`.
 */
export function parseWalletStateV2(value: unknown): WalletStateV2 {
  const fail = (what: string): never => {
    throw new SyncError("state", `wallet state v2 is unusable: ${what}`);
  };
  if (typeof value !== "object" || value === null) return fail("not an object");
  const state = value as Partial<WalletStateV2>;
  if (state.version !== WALLET_STATE_V2_VERSION) return fail("unknown version");
  try {
    if (typeof state.programId !== "string" || new PublicKey(state.programId).toBase58() !== state.programId) return fail("programId");
  } catch {
    return fail("programId");
  }
  const ownerRoot = decimalBelow(state.ownerRoot, FIELD_MODULUS);
  if (ownerRoot === null) return fail("ownerRoot");
  if (!Array.isArray(state.leaves) || state.leaves.length % LEAVES_PER_TRANSACTION_V2 !== 0 || state.leaves.length > 2 ** TREE_DEPTH_V2) return fail("leaves");
  if (!state.leaves.every((leaf) => decimalBelow(leaf, FIELD_MODULUS) !== null)) return fail("leaves must be field elements");
  if (state.lastSignature !== null && typeof state.lastSignature !== "string") return fail("lastSignature");
  if (!Array.isArray(state.notes)) return fail("notes");
  let previous = -1;
  for (const note of state.notes as Partial<StoredNoteV2>[]) {
    const index = note?.leafIndex;
    if (typeof index !== "number" || !Number.isInteger(index) || index <= previous || index >= state.leaves.length) return fail("a note's leaf index");
    previous = index;
    const amount = decimalBelow(note.amount, MAX_AMOUNT + 1n);
    const blinding = decimalBelow(note.blinding, 1n << 248n);
    if (amount === null || blinding === null || decimalBelow(note.nullifier, FIELD_MODULUS) === null || typeof note.spent !== "boolean") return fail("a note is malformed");
    if (typeof note.d !== "string" || !/^[0-9a-f]{32}$/.test(note.d)) return fail("a note's diversifier");
    let mint: PublicKey;
    try {
      mint = new PublicKey(note.mint as string);
    } catch {
      return fail("a note's mint");
    }
    const commitment = noteCommitmentV2({ asset: assetId(mint), amount, owner: ownerOf(ownerRoot, hexToBytes(note.d)), blinding });
    if (note.commitment !== commitment.toString() || state.leaves[index] !== note.commitment) return fail("a note does not match its leaf");
  }
  if (state.paymentCodes !== undefined) {
    const c = state.paymentCodes as Partial<PaymentCodeCountsV2> | null;
    const ok = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < MAX_ADDRESS_INDEX;
    if (!c || !ok(c.issued) || !ok(c.used)) return fail("payment code counts");
  }
  return state as WalletStateV2;
}

export function paymentCodeCountsV2(state: Pick<WalletStateV2, "paymentCodes">): PaymentCodeCountsV2 {
  return { issued: state.paymentCodes?.issued ?? 0, used: state.paymentCodes?.used ?? 0 };
}

function assertOwn(state: WalletStateV2, keys: Pick<FullViewingKey, "ownerRoot">): void {
  if (state.version !== WALLET_STATE_V2_VERSION) throw new SyncError("state", "wallet state v2 has an unknown version");
  if (state.ownerRoot !== keys.ownerRoot.toString()) throw new SyncError("state", "wallet state v2 belongs to a different key set");
}

/**
 * Hands out the next payment code: its own unlinkable address and a secret.
 * The rules of v1: at most {@link PAYMENT_CODE_GAP} unpaid in a row.
 *
 * @throws LochError `PAYMENT_CODE_LIMIT`.
 */
export function issuePaymentCodeV2(
  state: WalletStateV2,
  keys: Pick<FullViewingKey, "ownerRoot" | "ivk" | "dk" | "paymentCodeRoot">,
): { state: WalletStateV2; code: PaymentCodeV2; index: number } {
  assertOwn(state, keys);
  const { issued, used } = paymentCodeCountsV2(state);
  const index = Math.max(issued, used);
  if (index - used >= PAYMENT_CODE_GAP) {
    throw new LochError("PAYMENT_CODE_LIMIT", `${PAYMENT_CODE_GAP} payment codes in a row have not been paid yet: reuse one of them`);
  }
  return { state: { ...state, paymentCodes: { issued: index + 1, used } }, code: paymentCodeAtV2(keys, index), index };
}

function toOwned(note: StoredNoteV2, ownerRoot: bigint): OwnedNoteV2 {
  const mint = new PublicKey(note.mint);
  const d = hexToBytes(note.d);
  return {
    asset: assetId(mint),
    amount: BigInt(note.amount),
    owner: ownerOf(ownerRoot, d),
    blinding: BigInt(note.blinding),
    mint,
    d,
    leafIndex: note.leafIndex,
    commitment: BigInt(note.commitment),
    nullifier: BigInt(note.nullifier),
    spent: note.spent,
  };
}

export function ownedNotesV2(state: WalletStateV2): OwnedNoteV2[] {
  const ownerRoot = BigInt(state.ownerRoot);
  return state.notes.map((note) => toOwned(note, ownerRoot));
}

/** Unspent notes, optionally of one mint only. */
export function unspentNotesV2(state: WalletStateV2, mint?: PublicKey): OwnedNoteV2[] {
  return ownedNotesV2(state).filter((note) => !note.spent && (!mint || note.mint.equals(mint)));
}

/** Shielded balance per mint (base58 -> base units). */
export function balancesV2(state: WalletStateV2): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const note of state.notes) if (!note.spent) out.set(note.mint, (out.get(note.mint) ?? 0n) + BigInt(note.amount));
  return out;
}

export function treeFromStateV2(state: WalletStateV2): MerkleTree {
  return MerkleTree.fromLeaves(state.leaves.map(BigInt), TREE_DEPTH_V2);
}

/** What {@link applyEventsV2} returns. */
export interface AppliedEventsV2 {
  state: WalletStateV2;
  received: ReceivedNoteV2[];
  spent: OwnedNoteV2[];
  appended: bigint[];
}

/**
 * Applies a batch of `TransactV2` events: appends four leaves per event,
 * trial-decrypts the three outputs and the swap leaf, and marks the wallet's
 * notes whose nullifier the events spent. The rules of v1's `applyEvents`:
 * events continue the state without a gap; events for known leaves must match
 * and are skipped; a note counts only if its commitment matches.
 *
 * @throws SyncError `gap`, `mismatch`, `state`.
 */
export function applyEventsV2(
  state: WalletStateV2,
  events: readonly (TransactV2Event & Partial<TransactionTime>)[],
  keys: FullViewingKey,
  assets: AssetTable,
): AppliedEventsV2 {
  assertOwn(state, keys);
  const leaves = state.leaves.slice();
  let notes = state.notes.slice();
  const appended: bigint[] = [];
  const receivedAt = new Map<number, TransactionTime & { source: NoteSourceV2 }>();
  const { issued } = paymentCodeCountsV2(state);
  let { used } = paymentCodeCountsV2(state);
  const codes: PaymentCodeCandidateV2[] = [];
  const lookAhead = () => {
    const end = Math.min(Math.max(issued, used) + PAYMENT_CODE_GAP, MAX_ADDRESS_INDEX);
    for (let index = codes.length; index < end; index++) codes.push({ index, secret: paymentCodeSecretV2(keys.paymentCodeRoot, index) });
  };
  lookAhead();
  const nullifiers = new Set<string>();

  for (const event of [...events].sort((a, b) => a.firstIndex - b.firstIndex)) {
    for (const nullifier of event.nullifiers) nullifiers.add(nullifier.toString());
    if (event.firstIndex < leaves.length) {
      event.commitments.forEach((commitment, i) => {
        if (leaves[event.firstIndex + i] !== commitment.toString()) {
          throw new SyncError("mismatch", `the chain reports a different commitment for leaf ${event.firstIndex + i} than the local state holds`);
        }
      });
      continue;
    }
    if (event.firstIndex !== leaves.length) throw new SyncError("gap", `missing events: expected leaf ${leaves.length}, got leaf ${event.firstIndex}`);
    if (leaves.length + LEAVES_PER_TRANSACTION_V2 > 2 ** TREE_DEPTH_V2) throw new SyncError("mismatch", "more leaves than the tree can hold");
    for (const commitment of event.commitments) {
      if (commitment < 0n || commitment >= FIELD_MODULUS) throw new SyncError("mismatch", "a commitment is not a field element");
      leaves.push(commitment.toString());
      appended.push(commitment);
    }
    const outputs: Array<{ encrypted: Uint8Array; amount?: bigint }> = event.encryptedOutputs.map((encrypted) => ({ encrypted }));
    if (event.swap) outputs.push({ encrypted: event.swap.encryptedOutput, amount: event.swap.amountOut });
    outputs.forEach((output, position) => {
      const leafIndex = event.firstIndex + position;
      const opened = openNoteV2(output.encrypted, keys, event.commitments[position]!, assets, codes, output.amount);
      if (!opened) return;
      const { note, d, source } = opened;
      if (typeof source === "object" && source.code >= used) {
        used = source.code + 1;
        lookAhead();
      }
      if (note.amount === 0n) return;
      const asset = assets.byId(note.asset)!;
      receivedAt.set(leafIndex, { slot: event.slot, blockTime: event.blockTime, source });
      notes.push({
        leafIndex,
        mint: asset.mint.toBase58(),
        amount: note.amount.toString(),
        blinding: note.blinding.toString(),
        d: bytesToHex(d),
        commitment: event.commitments[position]!.toString(),
        nullifier: noteNullifierV2(keys.nk, event.commitments[position]!, leafIndex).toString(),
        spent: false,
      });
    });
  }

  notes.sort((a, b) => a.leafIndex - b.leafIndex);
  const spentAt = new Set<number>();
  notes = notes.map((note) => {
    if (note.spent || !nullifiers.has(note.nullifier)) return note;
    spentAt.add(note.leafIndex);
    return { ...note, spent: true };
  });
  const ownerRoot = BigInt(state.ownerRoot);
  const pick = (indices: { has(i: number): boolean }) => notes.filter((n) => indices.has(n.leafIndex)).map((n) => toOwned(n, ownerRoot));
  const counted = used > 0 || state.paymentCodes !== undefined ? { paymentCodes: { issued: Math.max(issued, used), used } } : {};
  return {
    state: { ...state, leaves, notes, ...counted },
    received: pick(receivedAt).map((note) => ({ ...note, ...receivedAt.get(note.leafIndex)! })),
    spent: pick(spentAt),
    appended,
  };
}

/**
 * Chooses one or two unspent notes of one mint covering `required` (amount
 * plus fee), as v1's `selectNotes`: the smallest single note, else the
 * smallest pair.
 *
 * @throws InsufficientBalanceError, ConsolidationRequiredError.
 */
export function selectNotesV2(notes: readonly OwnedNoteV2[], mint: PublicKey, required: bigint): OwnedNoteV2[] {
  assertAmount(required, "required");
  if (required === 0n) return [];
  const usable = notes.filter((n) => !n.spent && n.amount > 0n && n.mint.equals(mint));
  const sorted = [...usable].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : a.leafIndex - b.leafIndex));
  const single = sorted.find((n) => n.amount >= required);
  if (single) return [single];
  let best: [OwnedNoteV2, OwnedNoteV2] | null = null;
  let bestSum = 0n;
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const sum = sorted[low]!.amount + sorted[high]!.amount;
    if (sum >= required) {
      if (!best || sum < bestSum) {
        best = [sorted[low]!, sorted[high]!];
        bestSum = sum;
      }
      high--;
    } else {
      low++;
    }
  }
  if (best) return best.sort((a, b) => a.leafIndex - b.leafIndex);
  const available = usable.reduce((s, n) => s + n.amount, 0n);
  if (available < required) throw new InsufficientBalanceError(required, available);
  throw new ConsolidationRequiredError(required, available, sorted.slice(-2).reduce((s, n) => s + n.amount, 0n));
}

/** The two largest unspent notes of `mint`. */
export function consolidationCandidatesV2(notes: readonly OwnedNoteV2[], mint: PublicKey): OwnedNoteV2[] {
  const usable = notes.filter((n) => !n.spent && n.amount > 0n && n.mint.equals(mint));
  if (usable.length < 2) return [];
  return [...usable].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.leafIndex - b.leafIndex)).slice(0, 2);
}

/** Internal: throws unless `state` belongs to `keys` and `programId`. */
export function assertStateV2Matches(state: WalletStateV2, keys: Pick<FullViewingKey, "ownerRoot">, programId: PublicKey): void {
  assertOwn(state, keys);
  if (state.programId !== programId.toBase58()) throw new LochError("INVALID_ARGUMENT", "wallet state v2 belongs to a different program");
}
