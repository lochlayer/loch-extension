// Wallet state: a plain JSON object the caller persists. It holds the note
// secrets (amounts, blindings, nullifiers), so store it encrypted.

import { PublicKey } from "@solana/web3.js";

import { type PaymentCode, paymentCodeAt } from "./address.js";
import { FIELD_MODULUS, MAX_AMOUNT, PAYMENT_CODE_GAP, PROGRAM_ID, TREE_DEPTH } from "./constants.js";
import { ConsolidationRequiredError, InsufficientBalanceError, LochError, SyncError } from "./errors.js";
import { type NewCommitmentEvent, type TransactionTime, transactionTime } from "./events.js";
import { assertAmount } from "./field.js";
import { type LochKeys, MAX_PAYMENT_CODE_INDEX, paymentCodeSecret } from "./keys.js";
import { MerkleTree } from "./merkle.js";
import { type Note, type NoteSource, type PaymentCodeCandidate, noteCommitment, noteNullifier, openNote } from "./note.js";

/** Version of the {@link WalletState} layout this SDK reads and writes. */
export const WALLET_STATE_VERSION = 1;

/** One of the wallet's own notes as stored in {@link WalletState}; bigints are decimal strings. */
export interface StoredNote {
  /** Position of the commitment in the tree. */
  leafIndex: number;
  amount: string;
  blinding: string;
  commitment: string;
  nullifier: string;
  /** True once a transaction that spends the nullifier was seen on chain. */
  spent: boolean;
}

/**
 * Everything a wallet keeps between sessions. Plain JSON: persist it with
 * `JSON.stringify`. One state belongs to one key set and one program.
 */
export interface WalletState {
  version: 1;
  /** Program the state was synced from (base58). */
  programId: string;
  /** Poseidon public key of the owner (decimal string). */
  publicKey: string;
  /** Every leaf of the pool's tree in index order (decimal strings). */
  leaves: string[];
  /** The owner's notes with a non-zero amount, ordered by leaf index. */
  notes: StoredNote[];
  /** Newest transaction signature already processed; sync resumes after it. */
  lastSignature: string | null;
  /** The wallet's payment codes. Absent in a state that never had any, which reads as both counts 0. */
  paymentCodes?: PaymentCodeCounts;
}

/**
 * Where a wallet stands with its payment codes. Codes are numbered from 0 and
 * follow from the keys, so these two counts are all there is to keep.
 *
 * `issued - used` never exceeds {@link PAYMENT_CODE_GAP} when codes are handed
 * out with {@link issuePaymentCode}, and a sync looks for notes on every code
 * below `max(issued, used) + PAYMENT_CODE_GAP`. Together that means a wallet
 * restored from an empty state finds every note that was ever paid to a code.
 */
export interface PaymentCodeCounts {
  /** How many codes this wallet state has handed out: the next one gets this index. */
  issued: number;
  /** One more than the highest code index a note has arrived on; 0 if none has. */
  used: number;
}

/** One of the wallet's own notes, ready to spend. */
export interface OwnedNote extends Note {
  leafIndex: number;
  commitment: bigint;
  nullifier: bigint;
  spent: boolean;
}

/**
 * A note the wallet just received, with the `slot` and the `blockTime` of the
 * transaction that created it when the event carried them (events from
 * `fetchEvents` do). They are what the RPC reported, unverified, and they are
 * not part of {@link WalletState}: the stored layout has no place for them.
 * A wallet that wants to show when a note arrived keeps them in its own
 * records at this point; later, `ownedNotes(state)` cannot give them back.
 */
export interface ReceivedNote extends OwnedNote, TransactionTime {
  /**
   * How the note was addressed: to the plain address, by the wallet to itself
   * (change, a deposit), or to one of its payment codes. Like the time, this
   * is not kept in {@link WalletState}.
   */
  source: NoteSource;
}

/** An empty state for `keys` on `programId`. */
export function createWalletState(keys: Pick<LochKeys, "publicKey">, programId: PublicKey = PROGRAM_ID): WalletState {
  return {
    version: WALLET_STATE_VERSION,
    programId: programId.toBase58(),
    publicKey: keys.publicKey.toString(),
    leaves: [],
    notes: [],
    lastSignature: null,
  };
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
// Longest decimal form of a value below 2^256.
const MAX_DECIMAL_DIGITS = 78;

/** A decimal string as a bigint, or null if it is not one or is not below `limit`. */
function decimalBelow(value: unknown, limit: bigint): bigint | null {
  if (typeof value !== "string" || value.length > MAX_DECIMAL_DIGITS || !DECIMAL.test(value)) return null;
  const parsed = BigInt(value);
  return parsed < limit ? parsed : null;
}

/**
 * Checks a state object that came back from storage and returns it typed.
 *
 * Everything the rest of the SDK relies on is checked here, so a state that
 * passes does not fail later for being malformed: the program id is a public
 * key; the owner key, every leaf, commitment and nullifier are field elements;
 * the leaf count is even (leaves come in pairs); amounts are below 2^64 and
 * blindings below 2^248; the notes are in strictly increasing leaf order (so
 * none appears twice), each one sits at its leaf, and each one's commitment
 * is `Poseidon(amount, publicKey, blinding)`.
 *
 * It cannot check that the leaves are the chain's: the next sync does, and
 * fails with `mismatch` if they are not.
 *
 * @throws SyncError (`reason: "state"`) if the version is unknown or any of the above does not hold.
 */
export function parseWalletState(value: unknown): WalletState {
  const fail = (what: string): never => {
    throw new SyncError("state", `wallet state is unusable: ${what}`);
  };
  if (typeof value !== "object" || value === null) return fail("not an object");
  const state = value as Partial<WalletState>;
  if (state.version !== WALLET_STATE_VERSION) return fail("unknown version");
  if (typeof state.programId !== "string") return fail("programId missing");
  try {
    if (new PublicKey(state.programId).toBase58() !== state.programId) return fail("programId is not a base58 public key");
  } catch {
    return fail("programId is not a base58 public key");
  }
  const publicKey = decimalBelow(state.publicKey, FIELD_MODULUS);
  if (publicKey === null) return fail("publicKey must be a decimal field element");
  if (!Array.isArray(state.leaves)) return fail("leaves missing");
  if (state.leaves.length > 2 ** TREE_DEPTH) return fail("more leaves than the tree can hold");
  if (state.leaves.length % 2 !== 0) return fail("an odd number of leaves (every transaction appends two)");
  if (!state.leaves.every((leaf) => decimalBelow(leaf, FIELD_MODULUS) !== null)) return fail("leaves must be decimal field elements");
  if (state.lastSignature !== null && typeof state.lastSignature !== "string") return fail("lastSignature must be a string or null");
  if (!Array.isArray(state.notes)) return fail("notes missing");
  let previous = -1;
  for (const note of state.notes as Partial<StoredNote>[]) {
    if (typeof note !== "object" || note === null) return fail("a stored note is malformed");
    const { leafIndex } = note;
    if (typeof leafIndex !== "number" || !Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= state.leaves.length) {
      return fail("a stored note has a leaf index outside the tree");
    }
    if (leafIndex <= previous) return fail("stored notes must be in increasing leaf order, each leaf at most once");
    previous = leafIndex;
    const amount = decimalBelow(note.amount, MAX_AMOUNT + 1n);
    const blinding = decimalBelow(note.blinding, 1n << 248n);
    if (amount === null || blinding === null || decimalBelow(note.nullifier, FIELD_MODULUS) === null || typeof note.spent !== "boolean") {
      return fail("a stored note is malformed");
    }
    if (typeof note.commitment !== "string" || state.leaves[leafIndex] !== note.commitment) {
      return fail("a stored note is not the leaf at its index");
    }
    if (noteCommitment({ amount, publicKey, blinding }).toString() !== note.commitment) {
      return fail("a stored note does not match its commitment");
    }
  }
  if (state.paymentCodes !== undefined) {
    const counts = state.paymentCodes as Partial<PaymentCodeCounts> | null;
    const isCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_PAYMENT_CODE_INDEX;
    if (typeof counts !== "object" || counts === null || !isCount(counts.issued) || !isCount(counts.used)) {
      return fail("the payment code counts are malformed");
    }
  }
  return state as WalletState;
}

/** The payment code counts of a state; both 0 for a state that has none. */
export function paymentCodeCounts(state: Pick<WalletState, "paymentCodes">): PaymentCodeCounts {
  return { issued: state.paymentCodes?.issued ?? 0, used: state.paymentCodes?.used ?? 0 };
}

/** What {@link issuePaymentCode} returns. */
export interface IssuedPaymentCode {
  /** The new state, which counts the code. Persist it. The input state is not modified. */
  state: WalletState;
  /** The code to hand to one payer (`encodePaymentCode`). */
  code: PaymentCode;
  /** Its index. */
  index: number;
}

/**
 * Hands out the wallet's next payment code and counts it in the state.
 *
 * A code is for one payer, who may pay to it as often as they like. Every
 * code ever handed out costs every later sync one cheap decryption attempt
 * per output in the pool, so codes are not something to mint by the hundred.
 *
 * At most {@link PAYMENT_CODE_GAP} codes may be outstanding beyond the last
 * one that was paid. That is what lets a wallet restored from nothing but its
 * keys find every such note: it looks that far ahead and no further.
 *
 * The count lives in this state only. A second device with the same wallet
 * numbers its codes from 0 as well and hands out the same ones; both devices
 * still find every note, but two payers may then hold the same secret.
 *
 * @throws LochError `PAYMENT_CODE_LIMIT` when {@link PAYMENT_CODE_GAP} codes
 *   in a row are unpaid (reuse one of them: `paymentCodeAt`), SyncError
 *   `state` if the state does not belong to `keys`.
 */
export function issuePaymentCode(state: WalletState, keys: Pick<LochKeys, "publicKey" | "encryptionPublic" | "paymentCodeRoot">): IssuedPaymentCode {
  if (state.version !== WALLET_STATE_VERSION) throw new SyncError("state", "wallet state has an unknown version");
  if (state.publicKey !== keys.publicKey.toString()) throw new SyncError("state", "wallet state belongs to a different key set");
  const { issued, used } = paymentCodeCounts(state);
  const index = Math.max(issued, used);
  if (index - used >= PAYMENT_CODE_GAP || index > MAX_PAYMENT_CODE_INDEX) {
    throw new LochError("PAYMENT_CODE_LIMIT", `${PAYMENT_CODE_GAP} payment codes in a row have not been paid yet: reuse one of them`);
  }
  return { state: { ...state, paymentCodes: { issued: index + 1, used } }, code: paymentCodeAt(keys, index), index };
}

function toOwned(note: StoredNote, publicKey: bigint): OwnedNote {
  return {
    amount: BigInt(note.amount),
    publicKey,
    blinding: BigInt(note.blinding),
    leafIndex: note.leafIndex,
    commitment: BigInt(note.commitment),
    nullifier: BigInt(note.nullifier),
    spent: note.spent,
  };
}

/** All of the wallet's notes, spent and unspent, ordered by leaf index. */
export function ownedNotes(state: WalletState): OwnedNote[] {
  const publicKey = BigInt(state.publicKey);
  return state.notes.map((note) => toOwned(note, publicKey));
}

/** The wallet's spendable notes, ordered by leaf index. */
export function unspentNotes(state: WalletState): OwnedNote[] {
  return ownedNotes(state).filter((note) => !note.spent);
}

/** Shielded balance in lamports: the sum of unspent notes. */
export function balance(state: WalletState): bigint {
  let total = 0n;
  for (const note of state.notes) if (!note.spent) total += BigInt(note.amount);
  return total;
}

/** Rebuilds the Merkle tree from the state's leaves (about two Poseidon hashes per leaf). */
export function treeFromState(state: WalletState): MerkleTree {
  return MerkleTree.fromLeaves(state.leaves.map(BigInt));
}

/** What {@link applyEvents} returns. */
export interface AppliedEvents {
  /** The new state. The input state is not modified. */
  state: WalletState;
  /**
   * Notes with a non-zero amount that these events delivered to the wallet,
   * with the spent flag they have in `state` and, where the event had them,
   * the `slot` and `blockTime` of the transaction that created each.
   */
  received: ReceivedNote[];
  /** Notes of the wallet, old or just received, that the given nullifiers mark as spent now. */
  spent: OwnedNote[];
  /** Leaves appended, in index order. */
  appended: bigint[];
}

/**
 * Applies what a batch of pool transactions did to a state: appends the
 * leaves of the `NewCommitment` events, trial-decrypts every encrypted output
 * with `keys`, and marks as spent every note of the wallet whose nullifier is
 * among `nullifiers` (the nullifiers those same transactions spent, as
 * `fetchEvents` returns them).
 *
 * A note is accepted only if it decrypts and its recomputed commitment equals
 * the event's commitment. Zero-amount notes (padding) are not recorded.
 *
 * Three kinds of note are looked for: notes to the wallet's address, notes
 * the wallet sent to itself, and notes paid to its payment codes, for every
 * code below `max(issued, used) + PAYMENT_CODE_GAP`. A note found on a code
 * moves `used` (and with it the range) forward.
 *
 * Spent detection is complete as long as every batch is applied in order: a
 * note can only be spent by a transaction after the one that created it, so
 * its nullifier arrives in the same batch as the note or in a later one, and
 * both cases are covered here.
 *
 * Events must continue the state without a gap. Events for leaves the state
 * already has are accepted if they carry the same commitment and are skipped.
 *
 * @throws SyncError `gap` if an index is skipped, `mismatch` if an event
 *   contradicts a known leaf, `state` if `keys` do not belong to the state.
 */
export function applyEvents(
  state: WalletState,
  events: readonly NewCommitmentEvent[],
  keys: LochKeys,
  nullifiers: readonly bigint[] = [],
): AppliedEvents {
  if (state.version !== WALLET_STATE_VERSION) throw new SyncError("state", "wallet state has an unknown version");
  if (state.publicKey !== keys.publicKey.toString()) throw new SyncError("state", "wallet state belongs to a different key set");
  const leaves = state.leaves.slice();
  let notes = state.notes.slice();
  // Leaf index of every note received, with how it was addressed and when its transaction happened (if the event says).
  const receivedAt = new Map<number, TransactionTime & { source: NoteSource }>();
  const appended: bigint[] = [];
  const { issued } = paymentCodeCounts(state);
  let { used } = paymentCodeCounts(state);
  // The secrets of the codes being looked for. Grown when a note arrives on one near the end.
  const codes: PaymentCodeCandidate[] = [];
  const lookAhead = () => {
    const end = Math.min(Math.max(issued, used) + PAYMENT_CODE_GAP, MAX_PAYMENT_CODE_INDEX + 1);
    for (let index = codes.length; index < end; index++) codes.push({ index, secret: paymentCodeSecret(keys.paymentCodeRoot, index) });
  };
  lookAhead();
  for (const event of [...events].sort((a, b) => a.index - b.index)) {
    if (event.index < leaves.length) {
      if (leaves[event.index] !== event.commitment.toString()) {
        throw new SyncError("mismatch", `the chain reports a different commitment for leaf ${event.index} than the local state holds`);
      }
      continue;
    }
    if (event.index !== leaves.length) {
      throw new SyncError("gap", `missing events: expected leaf ${leaves.length}, got leaf ${event.index}`);
    }
    if (leaves.length >= 2 ** TREE_DEPTH) throw new SyncError("mismatch", "more leaves than the tree can hold");
    if (typeof event.commitment !== "bigint" || event.commitment < 0n || event.commitment >= FIELD_MODULUS) {
      throw new SyncError("mismatch", `the commitment reported for leaf ${event.index} is not a field element`);
    }
    leaves.push(event.commitment.toString());
    appended.push(event.commitment);
    const opened = openNote(event.encryptedOutput, keys, event.commitment, codes);
    if (!opened) continue;
    const { note, source } = opened;
    if (typeof source === "object" && source.code >= used) {
      // Counted even for a zero amount: the code is in use, and a restored wallet must look past it.
      used = source.code + 1;
      lookAhead();
    }
    if (note.amount === 0n) continue;
    receivedAt.set(event.index, { ...transactionTime(event), source });
    notes.push({
      leafIndex: event.index,
      amount: note.amount.toString(),
      blinding: note.blinding.toString(),
      commitment: event.commitment.toString(),
      nullifier: noteNullifier(note, event.index, keys.privateKey).toString(),
      spent: false,
    });
  }

  const spentAt = new Set<number>();
  if (nullifiers.length > 0) {
    const seen = new Set(nullifiers.map(String));
    notes = notes.map((note) => {
      if (note.spent || !seen.has(note.nullifier)) return note;
      spentAt.add(note.leafIndex);
      return { ...note, spent: true };
    });
  }

  const publicKey = BigInt(state.publicKey);
  const owned = (indices: { has(index: number): boolean }) => notes.filter((note) => indices.has(note.leafIndex)).map((note) => toOwned(note, publicKey));
  // The time goes on the returned notes only: the stored ones keep the layout they have.
  const received: ReceivedNote[] = owned(receivedAt).map((note) => ({ ...note, ...receivedAt.get(note.leafIndex)! }));
  // A state that has nothing to do with payment codes keeps the layout it had.
  const counted = used > 0 || state.paymentCodes !== undefined ? { paymentCodes: { issued: Math.max(issued, used), used } } : {};
  return { state: { ...state, leaves, notes, ...counted }, received, spent: owned(spentAt), appended };
}

/**
 * Chooses the notes to spend for `required` lamports (amount plus fee). A
 * transaction has two inputs, so the answer is one or two notes:
 *
 * 1. the smallest single note that covers `required`; otherwise
 * 2. the pair with the smallest sum that covers it (ties: older notes first).
 *
 * Returns an empty array when `required` is 0.
 *
 * @throws InsufficientBalanceError if all notes together do not cover it.
 * @throws ConsolidationRequiredError if they do, but no two notes do.
 */
export function selectNotes(notes: readonly OwnedNote[], required: bigint): OwnedNote[] {
  assertAmount(required, "required");
  if (required === 0n) return [];
  const usable = notes.filter((note) => !note.spent && note.amount > 0n);
  // Ascending by amount, then by age, so the first match is also the oldest.
  const sorted = [...usable].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : a.leafIndex - b.leafIndex));

  const single = sorted.find((note) => note.amount >= required);
  if (single) return [single];

  let best: [OwnedNote, OwnedNote] | null = null;
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

  const available = usable.reduce((sum, note) => sum + note.amount, 0n);
  if (available < required) throw new InsufficientBalanceError(required, available);
  const largest = sorted.slice(-2).reduce((sum, note) => sum + note.amount, 0n);
  throw new ConsolidationRequiredError(required, available, largest);
}

/** The two largest unspent notes: what a consolidation transfer merges. Empty if there are fewer than two. */
export function consolidationCandidates(notes: readonly OwnedNote[]): OwnedNote[] {
  const usable = notes.filter((note) => !note.spent && note.amount > 0n);
  if (usable.length < 2) return [];
  return [...usable].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.leafIndex - b.leafIndex)).slice(0, 2);
}

/** Internal: throws unless `state` belongs to `keys` and `programId`. */
export function assertStateMatches(state: WalletState, keys: Pick<LochKeys, "publicKey">, programId: PublicKey): void {
  if (state.version !== WALLET_STATE_VERSION) throw new SyncError("state", "wallet state has an unknown version");
  if (state.publicKey !== keys.publicKey.toString()) throw new SyncError("state", "wallet state belongs to a different key set");
  if (state.programId !== programId.toBase58()) throw new LochError("INVALID_ARGUMENT", "wallet state belongs to a different program");
}
