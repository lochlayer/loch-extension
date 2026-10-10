// Chain sync: walk the tree account's transaction history, collect the new
// commitments and the spent nullifiers, apply them to the wallet state and
// check the result against the on-chain tree.
//
// Everything sync asks the RPC for is the same for every Loch client: the
// pool's transaction list, those transactions, and the tree account. Nothing
// depends on the wallet's keys or notes, so an RPC that watches the requests
// learns that this client uses Loch and nothing about which notes are its own.

import { PublicKey } from "@solana/web3.js";
import type { Connection, Finality } from "@solana/web3.js";

import { fetchTreeAccount } from "./accounts.js";
import { DEFAULT_COMMITMENT, PROGRAM_ID } from "./constants.js";
import { SyncError } from "./errors.js";
import { type NewCommitmentEvent, type TransactionEffects, type TransactionLike, type TransactionTime, effectsOf, transactionTime } from "./events.js";
import type { LochKeys } from "./keys.js";
import type { MerkleTree } from "./merkle.js";
import { treePda } from "./pda.js";
import { type OwnedNote, type ReceivedNote, type WalletState, applyEvents, assertStateMatches, ownedNotes, treeFromState } from "./wallet.js";

/** The RPC methods sync uses. A web3.js `Connection` satisfies it. */
export type SyncConnection = Pick<Connection, "getSignaturesForAddress" | "getTransaction" | "getAccountInfo">;

/** Progress of {@link fetchEvents}. */
export interface SyncProgress {
  /** Transactions downloaded so far. */
  fetched: number;
  /** Transactions to download in this round. */
  total: number;
}

/** Options of {@link fetchEvents}. */
export interface FetchEventsOptions {
  /** Defaults to {@link PROGRAM_ID}. */
  programId?: PublicKey;
  /** Stop at this signature (exclusive): the last one already processed. */
  until?: string | null;
  /**
   * Leaf index expected for the first new commitment. Only used when the
   * first transaction's logs cannot provide indices. Default 0.
   */
  nextIndex?: number;
  /** `confirmed` (default, {@link DEFAULT_COMMITMENT}) or `finalized`. */
  commitment?: Finality;
  /** Signatures requested per page, 1 to 1000. Default 1000, the RPC maximum. */
  pageSize?: number;
  /** Transactions fetched in parallel. Default 4; public RPCs rate-limit. */
  concurrency?: number;
  /** Called after every downloaded transaction. Nothing is logged anywhere else. */
  onProgress?: (progress: SyncProgress) => void;
  /** Aborts between requests; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** What {@link fetchEvents} returns. */
export interface FetchedEvents {
  /**
   * New commitments in leaf order, indices contiguous. Each carries the
   * `slot` and the `blockTime` of the transaction that appended it, as far as
   * the RPC reported them (see {@link NewCommitmentEvent}).
   */
  events: NewCommitmentEvent[];
  /** Every nullifier the downloaded transactions spent: two per `transact`, dummies included. */
  nullifiers: bigint[];
  /** Newest signature seen (pass it as `until` next time), or the `until` given if there was nothing new. */
  lastSignature: string | null;
  /** Successful transactions downloaded. */
  transactions: number;
}

/** One entry of the signature listing, with what the listing says about when it happened. */
interface Listed {
  signature: string;
  failed: boolean;
  slot?: number;
  blockTime?: number | null;
}

const SIGNATURE_PAGE = 1000;
const FETCH_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;
// Version-1 transactions exist on Solana today; a lower value makes the RPC reject them.
const MAX_TRANSACTION_VERSION = 1;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchTransaction(
  connection: Pick<Connection, "getTransaction">,
  signature: string,
  commitment: Finality,
  signal?: AbortSignal,
): Promise<TransactionLike> {
  let lastError: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    try {
      const tx = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION });
      // A node can list a signature before it serves the transaction; retry rather than skip.
      if (tx) return tx;
    } catch (error) {
      lastError = error;
    }
    if (attempt < FETCH_ATTEMPTS - 1) await sleep(RETRY_BASE_MS * 2 ** attempt, signal);
  }
  throw new SyncError("unavailable", `the RPC did not return transaction ${signature}; nothing was skipped, try again`, { cause: lastError });
}

/**
 * Downloads what happened in the pool since `until`: the new commitments and
 * the nullifiers that were spent.
 *
 * Pages `getSignaturesForAddress` on the tree PDA from newest to oldest until
 * `until`, fetches every successful transaction with
 * `maxSupportedTransactionVersion: 1`, and reads the events from the logs
 * (from the instruction data when logs are missing or truncated). The leaf
 * indices must be contiguous; a transaction that cannot be fetched is an
 * error, never skipped. A signature listed twice is fetched once, and a
 * listing that stops advancing is an error instead of an endless loop.
 *
 * The listing contains every transaction that names the tree account, not
 * only pool transactions, and each one costs a request. See "What v1 does not
 * protect" in docs/protocol.md.
 *
 * Every event carries the slot and the block time of its transaction, as the
 * RPC reported them with the transaction (or, failing that, with the
 * listing): no request is made for them. They are the node's word and are not
 * checked by anything; a node that does not know a block's time leaves it out.
 *
 * Privacy: the RPC sees that this client reads the pool's history, which
 * every Loch client does. Nothing here depends on the wallet's keys.
 *
 * @throws SyncError `gap` if indices are not contiguous, `unavailable` if the
 *   RPC fails to return a listed transaction or keeps returning the same page
 *   of signatures.
 */
export async function fetchEvents(
  connection: Pick<Connection, "getSignaturesForAddress" | "getTransaction">,
  options: FetchEventsOptions = {},
): Promise<FetchedEvents> {
  const programId = options.programId ?? PROGRAM_ID;
  const commitment = options.commitment ?? DEFAULT_COMMITMENT;
  const until = options.until ?? undefined;
  const { signal, onProgress } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const pageSize = Math.min(SIGNATURE_PAGE, Math.max(1, Math.floor(options.pageSize ?? SIGNATURE_PAGE)));

  // Newest first, as the RPC returns them. The RPC is not trusted to list each
  // signature once (page boundaries on load-balanced nodes) or to honour `before`.
  const listed: Listed[] = [];
  const seen = new Map<string, Listed>();
  let before: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await connection.getSignaturesForAddress(treePda(programId), { before, until, limit: pageSize }, commitment);
    let fresh = 0;
    for (const entry of page) {
      const known = seen.get(entry.signature);
      if (known) {
        // Listed again. Skip it only as failed if every listing says so: the transaction itself is checked once fetched.
        known.failed &&= entry.err !== null;
        continue;
      }
      const item: Listed = { signature: entry.signature, failed: entry.err !== null, slot: entry.slot, blockTime: entry.blockTime };
      seen.set(entry.signature, item);
      listed.push(item);
      fresh++;
    }
    if (page.length < pageSize) break;
    if (fresh === 0) {
      throw new SyncError("unavailable", "the RPC returned a page of signatures that were all listed before: the listing does not advance; try again");
    }
    before = page[page.length - 1]!.signature;
  }
  const lastSignature = listed[0]?.signature ?? options.until ?? null;

  // Oldest first from here on.
  const pending = listed.filter((entry) => !entry.failed).reverse();
  const perTransaction: (TransactionEffects & { time: TransactionTime })[] = new Array(pending.length);
  let cursor = 0;
  let fetched = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null) {
      const position = cursor++;
      const entry = pending[position];
      if (!entry) return;
      try {
        const tx = await fetchTransaction(connection, entry.signature, commitment, signal);
        // When it happened: the transaction's own word first, the listing's where the transaction does not say.
        perTransaction[position] = { ...effectsOf(tx, programId), time: transactionTime(tx, entry) };
      } catch (error) {
        // Stop the other workers too: an incomplete download is of no use.
        failure ??= { error };
        return;
      }
      onProgress?.({ fetched: ++fetched, total: pending.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;

  // Order within a slot is the RPC's; when every transaction carries indices, trust those instead.
  let groups = perTransaction.filter((effects) => effects.commitments.length > 0);
  if (groups.every((group) => group.commitments[0]!.index !== null)) {
    groups = [...groups].sort((a, b) => a.commitments[0]!.index! - b.commitments[0]!.index!);
  }

  const events: NewCommitmentEvent[] = [];
  let expected: number | null = null;
  for (const group of groups) {
    for (const item of group.commitments) {
      if (expected === null) expected = item.index ?? options.nextIndex ?? 0;
      if (item.index !== null && item.index !== expected) {
        throw new SyncError("gap", `leaf indices are not contiguous: expected ${expected}, got ${item.index}`);
      }
      events.push({ index: expected, commitment: item.commitment, encryptedOutput: item.encryptedOutput, ...group.time });
      expected++;
    }
  }
  const nullifiers = perTransaction.flatMap((effects) => effects.nullifiers);
  return { events, nullifiers, lastSignature, transactions: pending.length };
}

/** Options of {@link syncWallet}. */
export interface SyncOptions extends Omit<FetchEventsOptions, "until" | "nextIndex" | "programId"> {
  /**
   * The tree that corresponds to `state`, kept from a previous sync, to avoid
   * rebuilding it from the leaves. It is NOT modified: sync works on a copy
   * and returns the new tree in the result, so a failed or a concurrent sync
   * can never leave the caller's tree out of step with the state it holds.
   */
  tree?: MerkleTree;
  /**
   * Fetch rounds spent trying to catch up with a chain that keeps moving, or
   * waiting for a node that lags. Default 5. After the last round sync settles
   * for a state that is verified but a few transactions old (see
   * {@link SyncResult.behind}); with `maxRounds: 1` it does so at once.
   */
  maxRounds?: number;
}

/** What {@link syncWallet} returns. */
export interface SyncResult {
  /** The new state to persist. The input state is not modified. */
  state: WalletState;
  /** The tree for the new state: pass it to the `prepare*` functions and to the next sync. A new object. */
  tree: MerkleTree;
  /**
   * Notes received since the last sync (non-zero amounts), with the spent flag
   * they have in `state`, and with the `slot` and `blockTime` of the
   * transaction that created each, as far as the RPC reported them. The state
   * does not keep those two: a wallet that wants to date its notes stores them
   * in its own records, from here.
   */
  received: ReceivedNote[];
  /** Notes found spent since the last sync. */
  spent: OwnedNote[];
  /** Leaves added to the tree. */
  newLeaves: number;
  /**
   * Transactions the chain already had beyond this state when it was
   * verified. 0 unless the pool kept moving during the sync. A state that is
   * behind is still correct: its root is one the program accepts (it keeps
   * the last 64), and the next sync continues from it.
   */
  behind: number;
}

/**
 * Brings a wallet state up to date with the chain: state in, state out.
 *
 * 1. Fetches what happened after `state.lastSignature` ({@link fetchEvents}).
 * 2. Appends the leaves, trial-decrypts the outputs with `keys`, and marks
 *    the wallet's notes whose nullifier one of those transactions spent. A
 *    spend always comes after the note it spends, so this finds every spend
 *    without asking the RPC about the wallet's own nullifiers.
 * 3. Reads the on-chain tree and requires the local tree to be what the chain
 *    has, or had within its last 64 transactions (the program keeps that many
 *    roots, one per transaction). If the chain moved meanwhile it fetches
 *    again, up to `maxRounds` times, and then settles for the verified state
 *    it has: see {@link SyncResult.behind}.
 *
 * Neither `state` nor `options.tree` is modified, so overlapping calls do not
 * disturb each other. Persist `result.state`; keep `result.tree`.
 *
 * At commitment `confirmed` (the default) a fork can in rare cases undo what
 * was synced; the next sync then fails with `mismatch`, and the fix is to
 * start again from {@link createWalletState}. Use `finalized` to rule it out.
 *
 * @throws SyncError, see {@link SyncError.reason}: `mismatch` (the local state
 *   is not a prefix of the chain, or the chain no longer has the transaction
 *   the state was synced to: discard it), `gap` or `unavailable` (try again),
 *   `state` (the state does not belong to `keys`, or is malformed).
 */
export async function syncWallet(
  connection: SyncConnection,
  state: WalletState,
  keys: LochKeys,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const programId = programOf(state);
  assertStateMatches(state, keys, programId);
  const commitment = options.commitment ?? DEFAULT_COMMITMENT;
  const maxRounds = Math.max(1, Math.floor(options.maxRounds ?? 5));
  const tree = workingTree(state, options.tree);
  const startSize = tree.size;

  let current = state;
  // The newest transaction the local leaves are known to come from: the one the
  // state was synced to, until a round appends leaves from this node's own listing.
  let anchor = state.lastSignature;
  let behind = 0;
  // Leaf index of every note received, with when its transaction happened.
  const receivedAt = new Map<number, TransactionTime & Pick<ReceivedNote, "source">>();
  const spentAt = new Set<number>();
  // True while the node serving the tree account is behind the local state: nothing new to fetch until it catches up.
  let waitingForAccount = false;
  for (let round = 0; ; round++) {
    // Null when this round did not fetch.
    let appended: number | null = null;
    if (!waitingForAccount) {
      const batch = await fetchEvents(connection, {
        ...options,
        programId,
        commitment,
        until: current.lastSignature,
        nextIndex: current.leaves.length,
      });
      const applied = applyEvents(current, batch.events, keys, batch.nullifiers);
      tree.append(applied.appended);
      appended = applied.appended.length;
      if (appended > 0) anchor = batch.lastSignature;
      for (const note of applied.received) receivedAt.set(note.leafIndex, { ...transactionTime(note), source: note.source });
      for (const note of applied.spent) spentAt.add(note.leafIndex);
      current = { ...applied.state, lastSignature: batch.lastSignature };
    }
    waitingForAccount = false;

    const onChain = await fetchTreeAccount(connection, programId, commitment);
    const ahead = onChain.nextIndex - tree.size;
    if (ahead === 0) {
      if (onChain.root !== tree.root) {
        throw new SyncError(
          "mismatch",
          `the local Merkle root differs from the on-chain root at ${tree.size} leaves; discard this state and sync from an empty one`,
        );
      }
      break;
    }
    const lastRound = round >= maxRounds - 1;

    if (ahead > 0) {
      // Transactions landed after the signature list was read. The local tree
      // is still checkable: the program records one root per transaction and
      // keeps the last `roots.length`, so the root at the local leaf count
      // sits `lag` slots behind the newest one.
      const lag = Math.ceil(ahead / 2);
      const history = onChain.roots.length;
      if (lag < history) {
        const slot = (((onChain.currentRootIndex - lag) % history) + history) % history;
        if (onChain.roots[slot] !== tree.root) {
          throw new SyncError(
            "mismatch",
            `the local Merkle root at ${tree.size} leaves is not the root the chain had at that point; discard this state and sync from an empty one`,
          );
        }
        if (lastRound) {
          behind = lag;
          break;
        }
      } else if (lastRound) {
        throw new SyncError(
          "unavailable",
          `could not catch up with the pool: ${tree.size} leaves locally, ${onChain.nextIndex} on chain, more than the root history covers; try again`,
        );
      }
      // Fetch the rest at once. Wait only when this round found nothing new:
      // then the node that lists signatures is behind the one serving accounts.
      if (appended === 0) await sleep(RETRY_BASE_MS * (round + 1), options.signal);
      else options.signal?.throwIfAborted();
      continue;
    }

    // The tree account has fewer leaves than the local state: the node lags,
    // or the chain no longer contains what was synced. First, what the node
    // has must be a prefix of the local leaves.
    const prefix = tree.clone();
    prefix.truncate(Math.max(0, onChain.nextIndex));
    if (prefix.root !== onChain.root) {
      throw new SyncError(
        "mismatch",
        `the chain has ${onChain.nextIndex} leaves with a root that differs from the local state's first ${onChain.nextIndex}; discard this state and sync from an empty one`,
      );
    }
    if (lastRound) {
      // A node that knows the transaction the state was synced to merely
      // serves an older account: try again later. One that still does not
      // know it, after this much patience, is on a chain where that
      // transaction never happened (a rollback at `confirmed`, or a pool that
      // was reset) or is far behind. The two cannot be told apart from here,
      // and the answer is the same: a sync from an empty state is always
      // correct, it only costs more requests.
      if (!(await signatureKnown(connection, anchor, commitment))) {
        throw new SyncError(
          "mismatch",
          `the chain has ${onChain.nextIndex} leaves, the local state ${tree.size}, and the last synced transaction is unknown to it: it was rolled back or the pool was reset (or the node is far behind); discard this state and sync from an empty one`,
        );
      }
      throw new SyncError(
        "unavailable",
        `the RPC serves an older tree than this state was synced to: ${tree.size} leaves locally, ${onChain.nextIndex} on chain; try again`,
      );
    }
    waitingForAccount = true;
    await sleep(RETRY_BASE_MS * (round + 1), options.signal);
  }

  const notes = ownedNotes(current);
  return {
    state: current,
    tree,
    received: notes.filter((note) => receivedAt.has(note.leafIndex)).map((note) => ({ ...note, ...receivedAt.get(note.leafIndex)! })),
    spent: notes.filter((note) => spentAt.has(note.leafIndex)),
    newLeaves: tree.size - startSize,
    behind,
  };
}

/** The tree sync works on: a copy of the caller's, or one rebuilt from the state. */
function workingTree(state: WalletState, cached: MerkleTree | undefined): MerkleTree {
  if (cached) {
    const size = cached.size;
    if (size !== state.leaves.length || (size > 0 && cached.leaves[size - 1]!.toString() !== state.leaves[size - 1])) {
      throw new SyncError("state", "the tree passed to syncWallet does not belong to this state");
    }
    return cached.clone();
  }
  try {
    return treeFromState(state);
  } catch (cause) {
    throw new SyncError("state", "wallet state is unusable: its leaves are not a valid tree", { cause });
  }
}

/** Whether the node can still serve the transaction with this signature. */
async function signatureKnown(connection: Pick<Connection, "getTransaction">, signature: string | null, commitment: Finality): Promise<boolean> {
  if (signature === null) return false;
  try {
    return (await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: MAX_TRANSACTION_VERSION })) !== null;
  } catch {
    // An RPC failure is not evidence that the transaction is gone.
    return true;
  }
}

function programOf(state: WalletState): PublicKey {
  try {
    return new PublicKey(state.programId);
  } catch {
    throw new SyncError("state", "wallet state has an invalid programId");
  }
}
