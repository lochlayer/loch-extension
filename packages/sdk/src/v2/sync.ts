// Sync v2: walk the history of the v2 tree account, read the `TransactV2`
// events, apply them to the wallet state and check the result against the
// on-chain tree. The same requests as v1's sync (the pool's transaction list,
// those transactions, the tree account), the same for every client.

import { PublicKey } from "@solana/web3.js";
import type { Connection, Finality } from "@solana/web3.js";

import { DEFAULT_COMMITMENT, PROGRAM_ID } from "../constants.js";
import { SyncError } from "../errors.js";
import { type TransactionLike, transactionTime } from "../events.js";
import type { MerkleTree } from "../merkle.js";
import type { AssetTable } from "./asset.js";
import { LEAVES_PER_TRANSACTION_V2 } from "./constants.js";
import { type TimedTransactV2Event, transactV2EventsOf } from "./events.js";
import type { FullViewingKey } from "./keys.js";
import { fetchTreeV2Account, treeV2Pda } from "./program.js";
import {
  type OwnedNoteV2,
  type ReceivedNoteV2,
  type WalletStateV2,
  applyEventsV2,
  assertStateV2Matches,
  ownedNotesV2,
  treeFromStateV2,
} from "./wallet.js";

export type SyncConnectionV2 = Pick<Connection, "getSignaturesForAddress" | "getTransaction" | "getAccountInfo">;

export interface FetchEventsV2Options {
  programId?: PublicKey;
  until?: string | null;
  commitment?: Finality;
  pageSize?: number;
  concurrency?: number;
  onProgress?: (progress: { fetched: number; total: number }) => void;
  signal?: AbortSignal;
}

export interface FetchedEventsV2 {
  /** Events in leaf order, contiguous. */
  events: TimedTransactV2Event[];
  lastSignature: string | null;
  transactions: number;
}

const FETCH_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

async function fetchTransaction(connection: Pick<Connection, "getTransaction">, signature: string, commitment: Finality, signal?: AbortSignal): Promise<TransactionLike> {
  let lastError: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    try {
      const tx = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 1 });
      if (tx) return tx as unknown as TransactionLike;
    } catch (error) {
      lastError = error;
    }
    if (attempt < FETCH_ATTEMPTS - 1) await sleep(RETRY_BASE_MS * 2 ** attempt, signal);
  }
  throw new SyncError("unavailable", `the RPC did not return transaction ${signature}; nothing was skipped, try again`, { cause: lastError });
}

/**
 * Downloads the `TransactV2` events since `until`, oldest first, with leaf
 * indices checked to be contiguous. A transaction that cannot be fetched is an
 * error, never skipped.
 *
 * @throws SyncError `gap`, `unavailable`.
 */
export async function fetchEventsV2(connection: Pick<Connection, "getSignaturesForAddress" | "getTransaction">, options: FetchEventsV2Options = {}): Promise<FetchedEventsV2> {
  const programId = options.programId ?? PROGRAM_ID;
  const commitment = options.commitment ?? DEFAULT_COMMITMENT;
  const pageSize = Math.min(1000, Math.max(1, Math.floor(options.pageSize ?? 1000)));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const listed: { signature: string; failed: boolean; slot?: number; blockTime?: number | null }[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const page = await connection.getSignaturesForAddress(treeV2Pda(programId), { before, until: options.until ?? undefined, limit: pageSize }, commitment);
    let fresh = 0;
    for (const entry of page) {
      if (seen.has(entry.signature)) continue;
      seen.add(entry.signature);
      listed.push({ signature: entry.signature, failed: entry.err !== null, slot: entry.slot, blockTime: entry.blockTime });
      fresh++;
    }
    if (page.length < pageSize) break;
    if (fresh === 0) throw new SyncError("unavailable", "the RPC's signature listing does not advance; try again");
    before = page[page.length - 1]!.signature;
  }
  const lastSignature = listed[0]?.signature ?? options.until ?? null;
  const pending = listed.filter((entry) => !entry.failed).reverse();
  const results: TimedTransactV2Event[][] = new Array(pending.length);
  let cursor = 0;
  let fetched = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (failure === null) {
      const position = cursor++;
      const entry = pending[position];
      if (!entry) return;
      try {
        const tx = await fetchTransaction(connection, entry.signature, commitment, options.signal);
        const time = transactionTime(tx, entry);
        results[position] = transactV2EventsOf(tx, programId).map((event) => ({ ...event, ...time }));
      } catch (error) {
        failure ??= { error };
        return;
      }
      options.onProgress?.({ fetched: ++fetched, total: pending.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  const events = results.flat().sort((a, b) => a.firstIndex - b.firstIndex);
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.firstIndex !== events[i - 1]!.firstIndex + LEAVES_PER_TRANSACTION_V2) {
      throw new SyncError("gap", `leaf indices are not contiguous: ${events[i - 1]!.firstIndex} then ${events[i]!.firstIndex}`);
    }
  }
  return { events, lastSignature, transactions: pending.length };
}

export interface SyncOptionsV2 extends Omit<FetchEventsV2Options, "until" | "programId"> {
  tree?: MerkleTree;
  maxRounds?: number;
}

export interface SyncResultV2 {
  state: WalletStateV2;
  tree: MerkleTree;
  received: ReceivedNoteV2[];
  spent: OwnedNoteV2[];
  newLeaves: number;
  /** Transactions the chain had beyond the verified state. */
  behind: number;
}

/**
 * Brings a v2 wallet state up to date: fetch, apply, then require the local
 * tree to be the chain's, or to have been the chain's within its last 64
 * transactions (one root per transaction, four leaves each). Neither `state`
 * nor `options.tree` is modified.
 *
 * @throws SyncError `mismatch` (discard the state and sync from empty), `gap`
 *   or `unavailable` (try again), `state`.
 */
export async function syncWalletV2(
  connection: SyncConnectionV2,
  state: WalletStateV2,
  keys: FullViewingKey,
  assets: AssetTable,
  options: SyncOptionsV2 = {},
): Promise<SyncResultV2> {
  let programId: PublicKey;
  try {
    programId = new PublicKey(state.programId);
  } catch {
    throw new SyncError("state", "wallet state v2 has an invalid programId");
  }
  assertStateV2Matches(state, keys, programId);
  const commitment = options.commitment ?? DEFAULT_COMMITMENT;
  const maxRounds = Math.max(1, Math.floor(options.maxRounds ?? 5));
  let tree: MerkleTree;
  if (options.tree) {
    if (options.tree.size !== state.leaves.length) throw new SyncError("state", "the tree passed to syncWalletV2 does not belong to this state");
    tree = options.tree.clone();
  } else {
    tree = treeFromStateV2(state);
  }
  const startSize = tree.size;
  let current = state;
  let behind = 0;
  const received = new Map<number, ReceivedNoteV2>();
  const spent = new Set<number>();
  for (let round = 0; ; round++) {
    const batch = await fetchEventsV2(connection, { ...options, programId, commitment, until: current.lastSignature });
    const applied = applyEventsV2(current, batch.events, keys, assets);
    tree.append(applied.appended);
    for (const note of applied.received) received.set(note.leafIndex, note);
    for (const note of applied.spent) spent.add(note.leafIndex);
    current = { ...applied.state, lastSignature: batch.lastSignature };

    const onChain = await fetchTreeV2Account(connection, programId, commitment);
    const ahead = onChain.nextIndex - tree.size;
    const lastRound = round >= maxRounds - 1;
    if (ahead === 0) {
      if (onChain.root !== tree.root) throw new SyncError("mismatch", `the local v2 root differs from the chain's at ${tree.size} leaves; discard this state and sync from an empty one`);
      break;
    }
    if (ahead > 0) {
      const lag = Math.ceil(ahead / LEAVES_PER_TRANSACTION_V2);
      const history = onChain.roots.length;
      if (lag < history) {
        const slot = (((onChain.currentRootIndex - lag) % history) + history) % history;
        if (onChain.roots[slot] !== tree.root) throw new SyncError("mismatch", `the local v2 root at ${tree.size} leaves is not the one the chain had; discard this state and sync from an empty one`);
        if (lastRound) {
          behind = lag;
          break;
        }
      } else if (lastRound) {
        throw new SyncError("unavailable", `could not catch up with the v2 pool: ${tree.size} leaves locally, ${onChain.nextIndex} on chain`);
      }
      if (applied.appended.length === 0) await sleep(RETRY_BASE_MS * (round + 1), options.signal);
      continue;
    }
    // The node serves an older tree than the local state.
    if (lastRound) throw new SyncError("unavailable", `the RPC serves an older v2 tree than this state: ${tree.size} leaves locally, ${onChain.nextIndex} on chain; try again`);
    await sleep(RETRY_BASE_MS * (round + 1), options.signal);
  }
  const notes = ownedNotesV2(current);
  return {
    state: current,
    tree,
    received: [...received.values()].map((note) => ({ ...note, spent: notes.find((n) => n.leafIndex === note.leafIndex)?.spent ?? note.spent })),
    spent: notes.filter((note) => spent.has(note.leafIndex)),
    newLeaves: tree.size - startSize,
    behind,
  };
}
