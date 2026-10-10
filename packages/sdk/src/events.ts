// Anchor events of loch_pool, read from transaction logs.

import { base58 } from "@scure/base";
import type { PublicKey } from "@solana/web3.js";

import { ByteReader, base64ToBytes, bytesToBigIntBE, equalBytes } from "./bytes.js";
import { type TransactArgs, decodeTransactArgs, isTransactData } from "./codec.js";
import {
  FIELD_MODULUS,
  MAX_ENCRYPTED_OUTPUT_LENGTH,
  NEW_COMMITMENT_DISCRIMINATOR,
  NEW_NULLIFIERS_DISCRIMINATOR,
  PROGRAM_ID,
  TREE_DEPTH,
} from "./constants.js";

/**
 * When the cluster processed a transaction, as an RPC node reported it. Both
 * values are the node's word: nothing in a sync verifies them (the root check
 * covers the leaves, not when they were appended), so they are for display and
 * for a wallet's own records, not for decisions.
 */
export interface TransactionTime {
  /** Slot of the transaction. Absent when the source did not say. */
  slot?: number;
  /**
   * Block time of the transaction: Unix time in seconds. Absent when the node
   * does not know it (it is not kept for every block) or the source did not say.
   */
  blockTime?: number;
}

/**
 * `NewCommitment { index, commitment, encrypted_output }`: one leaf appended to the tree.
 *
 * `slot` and `blockTime` are not part of the event the program emits: they
 * belong to the transaction that carried it, and are filled in by
 * `fetchEvents`, which has that transaction. Events read from logs alone
 * (`parseEventLogs`) do not have them.
 */
export interface NewCommitmentEvent extends TransactionTime {
  /** Leaf index. */
  index: number;
  /** The leaf, as a field element. */
  commitment: bigint;
  /** The encrypted note published with it. */
  encryptedOutput: Uint8Array;
}

const wholeNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/**
 * The slot and block time among the given sources, first one that has each;
 * a property is present in the result only when its value is known. A block
 * time of zero is "unknown", as some nodes report it.
 */
export function transactionTime(...sources: readonly ({ slot?: unknown; blockTime?: unknown } | null | undefined)[]): TransactionTime {
  const time: TransactionTime = {};
  for (const source of sources) {
    const slot = wholeNumber(source?.slot);
    const blockTime = wholeNumber(source?.blockTime);
    if (time.slot === undefined && slot !== undefined) time.slot = slot;
    if (time.blockTime === undefined && blockTime !== undefined && blockTime > 0) time.blockTime = blockTime;
  }
  return time;
}

/** `NewNullifiers { nullifiers }`: the two nullifiers one transaction spent. */
export interface NewNullifiersEvent {
  nullifiers: [bigint, bigint];
}

/** Events found in one transaction's logs. */
export interface ParsedLogs {
  commitments: NewCommitmentEvent[];
  nullifiers: NewNullifiersEvent[];
  /** The runtime cut the logs off ("Log truncated"): events may be missing. */
  truncated: boolean;
}

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const EXIT = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed: .*)$/;
const DATA_PREFIX = "Program data: ";

function decodeEvent(data: Uint8Array, out: ParsedLogs): void {
  if (data.length < 8) return;
  const discriminator = data.subarray(0, 8);
  const reader = new ByteReader(data.subarray(8));
  try {
    if (equalBytes(discriminator, NEW_COMMITMENT_DISCRIMINATOR)) {
      const index = reader.u64();
      const commitment = bytesToBigIntBE(reader.take(32));
      const encryptedOutput = reader.vec(MAX_ENCRYPTED_OUTPUT_LENGTH);
      // The program only stores canonical field elements; anything else is not one of its events.
      if (reader.remaining !== 0 || index >= BigInt(2 ** TREE_DEPTH) || commitment >= FIELD_MODULUS) return;
      out.commitments.push({ index: Number(index), commitment, encryptedOutput });
    } else if (equalBytes(discriminator, NEW_NULLIFIERS_DISCRIMINATOR)) {
      const nullifiers: [bigint, bigint] = [bytesToBigIntBE(reader.take(32)), bytesToBigIntBE(reader.take(32))];
      if (reader.remaining !== 0 || nullifiers.some((nullifier) => nullifier >= FIELD_MODULUS)) return;
      out.nullifiers.push({ nullifiers });
    }
  } catch {
    // Not one of our events after all; ignore the line.
  }
}

/**
 * Extracts `NewCommitment` and `NewNullifiers` events from a transaction's
 * log messages.
 *
 * Only "Program data:" lines logged while `programId` itself is executing are
 * read. The invoke/success lines are written by the runtime and cannot be
 * forged by a program, so another program in the same transaction cannot
 * inject events by logging look-alike data.
 *
 * The logs alone do not say whether the transaction SUCCEEDED. The runtime
 * can reject a transaction after the program returned (a withdrawal that
 * leaves its destination below the rent-exempt minimum, for example): such a
 * transaction has all three events and a `success` line in its logs and
 * changed nothing. Use the events only when the transaction's `err` is null.
 */
export function parseEventLogs(logs: readonly string[] | null | undefined, programId: PublicKey = PROGRAM_ID): ParsedLogs {
  const out: ParsedLogs = { commitments: [], nullifiers: [], truncated: false };
  if (!logs) return out;
  const self = programId.toBase58();
  const stack: string[] = [];
  for (const line of logs) {
    if (line === "Log truncated") {
      out.truncated = true;
      continue;
    }
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    if (stack[stack.length - 1] !== self || !line.startsWith(DATA_PREFIX)) continue;
    // sol_log_data separates slices with spaces; Anchor's emit! writes one slice.
    const first = line.slice(DATA_PREFIX.length).split(" ")[0]!;
    let data: Uint8Array;
    try {
      data = base64ToBytes(first);
    } catch {
      continue;
    }
    decodeEvent(data, out);
  }
  return out;
}

/** The parts of a confirmed transaction {@link transactCallsOf} reads. A web3.js `VersionedTransactionResponse` fits. */
export interface TransactionLike {
  /** Slot the transaction was processed in. */
  slot?: number;
  /** Block time in Unix seconds, or null when the node does not know it. */
  blockTime?: number | null;
  transaction: {
    message: {
      staticAccountKeys: readonly PublicKey[];
      compiledInstructions: readonly { programIdIndex: number; data: Uint8Array }[];
    };
  };
  meta: {
    err: unknown;
    logMessages?: readonly string[] | null;
    innerInstructions?: readonly { index: number; instructions: readonly { programIdIndex: number; data: string }[] }[] | null;
    loadedAddresses?: { writable: readonly PublicKey[]; readonly: readonly PublicKey[] } | null;
  } | null;
}

/** True when all five field values of a `transact` call are canonical, as the program requires. */
function hasCanonicalValues(args: TransactArgs): boolean {
  return [args.root, ...args.inputNullifiers, ...args.outputCommitments].every((bytes) => bytesToBigIntBE(bytes) < FIELD_MODULUS);
}

/**
 * Every `transact` call a confirmed transaction made to `programId`, top-level
 * or through CPI, in execution order. This is the same information as the
 * events minus the leaf index, and unlike logs it cannot be truncated.
 *
 * Meaningful for a transaction that succeeded: every instruction of it then
 * ran to the end. Instruction data the program could not have accepted (not
 * decodable, a value that is not below r) is skipped.
 */
export function transactCallsOf(tx: TransactionLike, programId: PublicKey = PROGRAM_ID): TransactArgs[] {
  const { message } = tx.transaction;
  const keys = [
    ...message.staticAccountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const calls: TransactArgs[] = [];
  const visit = (programIdIndex: number, data: Uint8Array) => {
    if (!keys[programIdIndex]?.equals(programId) || !isTransactData(data)) return;
    let args: TransactArgs;
    try {
      // The program ignores bytes after the arguments, so tolerate them here too.
      args = decodeTransactArgs(data, { allowTrailingBytes: true });
    } catch {
      return;
    }
    if (hasCanonicalValues(args)) calls.push(args);
  };
  const inner = new Map<number, readonly { programIdIndex: number; data: string }[]>();
  for (const group of tx.meta?.innerInstructions ?? []) inner.set(group.index, group.instructions);
  message.compiledInstructions.forEach((instruction, index) => {
    visit(instruction.programIdIndex, instruction.data);
    for (const nested of inner.get(index) ?? []) {
      let data: Uint8Array;
      try {
        data = base58.decode(nested.data);
      } catch {
        continue;
      }
      visit(nested.programIdIndex, data);
    }
  });
  return calls;
}

/** One new leaf found in a transaction; `index` is null when the logs could not provide it. */
export interface TransactionCommitment {
  index: number | null;
  commitment: bigint;
  encryptedOutput: Uint8Array;
}

/** What one confirmed, successful transaction did to the pool. */
export interface TransactionEffects {
  /** The leaves it appended, in order. */
  commitments: TransactionCommitment[];
  /** The nullifiers it spent: two per `transact` call. */
  nullifiers: bigint[];
}

/**
 * The commitments one confirmed, successful transaction appended and the
 * nullifiers it spent. A failed transaction did neither, whatever its logs
 * say.
 *
 * Two sources say the same thing: the `NewCommitment` / `NewNullifiers` events
 * in the logs, which also carry the leaf indices, and the instruction data of
 * every `transact` call. The events are used when the logs are complete (not
 * missing, not truncated, one `NewNullifiers` for every two `NewCommitment`,
 * and no fewer events than the instruction data accounts for). Otherwise the
 * instruction data is used; leaf indices are then null and the caller numbers
 * the leaves by position.
 */
export function effectsOf(tx: TransactionLike, programId: PublicKey = PROGRAM_ID): TransactionEffects {
  if (!tx.meta || tx.meta.err) return { commitments: [], nullifiers: [] };
  const parsed = parseEventLogs(tx.meta.logMessages, programId);
  const fromLogs: TransactionEffects = {
    commitments: parsed.commitments,
    nullifiers: parsed.nullifiers.flatMap((event) => event.nullifiers),
  };
  const calls = transactCallsOf(tx, programId);
  const logsComplete = Boolean(tx.meta.logMessages) && !parsed.truncated && fromLogs.commitments.length === fromLogs.nullifiers.length;
  if (logsComplete && fromLogs.commitments.length >= 2 * calls.length) return fromLogs;
  if (2 * calls.length < fromLogs.commitments.length) return fromLogs;
  return {
    commitments: calls.flatMap((args) => [
      { index: null, commitment: bytesToBigIntBE(args.outputCommitments[0]), encryptedOutput: args.extData.encryptedOutput0 },
      { index: null, commitment: bytesToBigIntBE(args.outputCommitments[1]), encryptedOutput: args.extData.encryptedOutput1 },
    ]),
    nullifiers: calls.flatMap((args) => args.inputNullifiers.map(bytesToBigIntBE)),
  };
}

/** The commitments one confirmed, successful transaction appended, in order. See {@link effectsOf}. */
export function commitmentsOf(tx: TransactionLike, programId: PublicKey = PROGRAM_ID): TransactionCommitment[] {
  return effectsOf(tx, programId).commitments;
}
