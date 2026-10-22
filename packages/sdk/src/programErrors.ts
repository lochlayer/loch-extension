// Turning a rejected transaction into a typed error.

import type { PublicKey } from "@solana/web3.js";

import { NullifierSpentError, PROGRAM_ERROR_BASE, PROGRAM_ERROR_NAMES, ProgramError, type ProgramErrorName, UnknownRootError } from "./errors.js";
import type { FieldLike } from "./field.js";
import { nullifierPda } from "./pda.js";

const MESSAGES: Record<ProgramErrorName, string> = {
  InvalidProof: "the proof did not verify: wrong prover artifacts, or the ext data sent differs from what was proven",
  UnknownRoot: "the Merkle root is no longer in the program's recent history: sync and prove again",
  TreeFull: "the pool's Merkle tree is full",
  RecipientMismatch: "the recipient account differs from the ext data",
  RelayerMismatch: "the relayer account differs from the ext data",
  MissingScreenerSignature: "deposits need the screening authority's signature",
  DepositTooLarge: "the deposit exceeds the pool's per-transaction cap",
  DepositsPaused: "deposits are paused; withdrawals and transfers still work",
  EncryptedOutputTooLarge: "an encrypted output is larger than 256 bytes",
  AmountOutOfRange: "an amount is out of range",
  PoseidonError: "the Poseidon syscall failed",
  NonCanonicalFieldElement: "the root, a nullifier or a commitment is not below the field modulus",
  ZeroProofElement: "a proof element is all zero bytes",
  InvalidProgramData: "initialize: the program data account does not belong to this program",
  NotUpgradeAuthority: "initialize: only the program's upgrade authority can initialise the pool",
  TreeNotPairAligned: "the tree holds an odd number of leaves",
  InvalidDestination: "a withdrawal or a fee would be paid to the vault or to an account the pool owns, where it could never be withdrawn",
  InvalidEncryptedOutputLength: "an encrypted output is neither empty nor 103 bytes",
  AssetMismatch: "the asset account, the ext data's asset and the amount do not agree",
  MissingAsset: "a deposit or withdrawal needs its asset account",
  AssetDepositsDisabled: "deposits of this asset are disabled; withdrawals and transfers still work",
  InvalidVault: "the vault or the vault authority is not the asset's",
  InvalidTokenProgram: "not the SPL Token program",
  InvalidTokenAccount: "not a usable token account",
  InvalidMint: "not an initialized SPL Token mint",
  InvalidRouter: "the swap's router is not the pool's",
  InvalidEscrow: "a swap escrow is not what the swap made of it",
  SwapInputNotSpent: "the router did not take exactly the swap's input",
  SwapOutputTooSmall: "the swap returned less than its minimum",
  InvalidSwap: "malformed swap",
};

const ANCHOR_LOG = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/;
const CUSTOM_HEX = /custom program error: 0x([0-9a-fA-F]+)/;
const ALREADY_IN_USE = /already in use/;
// The system program names the account it refused to create: "Allocate: account Address { address: <base58>, base: None } already in use".
const IN_USE_ADDRESS = /\baddress: ([1-9A-HJ-NP-Za-km-z]{32,44})\b/;
// Written by the runtime around every program invocation; a program cannot log these lines itself.
const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const EXIT = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed: .*)$/;
// Anchor logs the name of the instruction it dispatches to.
const ANCHOR_INSTRUCTION = /^Program log: Instruction: (\w+)$/;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** The instructions of loch_pool that create nullifier records (v1, v2, swap), and nullifier records are all they create besides swap escrows. */
const TRANSACTS = new Set(["Transact", "TransactV2", "SwapV2"]);
// The transaction error is `{ InsufficientFundsForRent: { account_index } }`; web3.js words it as below.
const RENT = /InsufficientFundsForRent|insufficient funds for rent/i;
// `{ InstructionError: [n, "ComputationalBudgetExceeded"] }`, and the log lines of the two runtimes.
const COMPUTE_BUDGET = /ComputationalBudgetExceeded|exceeded CUs meter|Computational budget exceeded/i;

function collect(source: unknown): { logs: string[]; text: string[]; custom: number | null } {
  const logs: string[] = [];
  const text: string[] = [];
  let custom: number | null = null;
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (value === null || value === undefined || depth > 4 || seen.has(value)) return;
    if (typeof value === "string") {
      text.push(value);
      return;
    }
    if (typeof value !== "object") return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === "string")) logs.push(...(value as string[]));
      else if (value.length === 2 && typeof value[0] === "number") visit(value[1], depth + 1); // [index, error]
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.Custom === "number") custom ??= record.Custom;
    if ("InsufficientFundsForRent" in record) text.push("InsufficientFundsForRent");
    for (const key of ["logs", "transactionLogs", "logMessages"]) {
      const list = record[key];
      if (Array.isArray(list)) logs.push(...list.filter((item): item is string => typeof item === "string"));
    }
    if (typeof record.message === "string") text.push(record.message);
    for (const key of ["InstructionError", "err", "value", "cause", "transactionError", "error", "data"]) {
      visit(record[key], depth + 1);
    }
  };
  visit(source, 0);
  return { logs, text, custom };
}

/** What {@link parseProgramError} may be told about the transaction that failed. */
export interface ProgramErrorContext {
  /**
   * The input nullifiers of the transaction (`TransactArgs.inputNullifiers`,
   * or `publicInputs.inputNullifiers` of a prepared transaction). With them an
   * "already in use" failure is compared with the transaction's own nullifier
   * accounts instead of being inferred from the shape of the logs.
   */
  nullifiers?: readonly FieldLike[];
  /** The program the nullifier accounts belong to. Defaults to the devnet program id. */
  programId?: PublicKey;
  /**
   * The transaction's nullifier accounts themselves, in place of `nullifiers`:
   * v2 records live under another seed (`nullifierV2Pda`).
   */
  nullifierAccounts?: readonly PublicKey[];
}

/**
 * Where the system program's "already in use" came from, as far as the logs
 * say: the account it names, and the Anchor instruction that was running in
 * the program that called the system program.
 */
function inUseOrigin(logs: readonly string[]): { address: string | null; instruction: string | null; topLevel: boolean } | null {
  // One frame per program on the call stack; `program` is null where the logs do not show the invocation.
  const stack: { program: string | null; instruction: string | null }[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      stack.length = Math.min(stack.length, Math.max(0, depth - 1));
      while (stack.length < depth - 1 && stack.length < 8) stack.push({ program: null, instruction: null });
      stack.push({ program: invoke[1]!, instruction: null });
      continue;
    }
    if (EXIT.test(line)) {
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    const instruction = ANCHOR_INSTRUCTION.exec(line);
    if (instruction) {
      // The first one a program logs is Anchor's own; later lines of the same shape are the handler's.
      if (top && top.instruction === null) top.instruction = instruction[1]!;
      continue;
    }
    if (!ALREADY_IN_USE.test(line)) continue;
    const address = IN_USE_ADDRESS.exec(line)?.[1] ?? null;
    // The line is the system program's; the program that asked it to create the account is one frame below.
    const caller = top?.program === SYSTEM_PROGRAM ? stack[stack.length - 2] : undefined;
    return { address, instruction: caller?.instruction ?? null, topLevel: top?.program === SYSTEM_PROGRAM && stack.length === 1 };
  }
  return null;
}

/**
 * Whether an "already in use" failure is about one of the transaction's
 * nullifier accounts: true, false, or null when what was given does not say.
 */
function inUseIsNullifier(logs: readonly string[], context: ProgramErrorContext | undefined): boolean | null {
  const origin = inUseOrigin(logs);
  if (!origin) return null;
  if (origin.address !== null && context?.nullifierAccounts) {
    return context.nullifierAccounts.some((account) => account.toBase58() === origin.address);
  }
  if (origin.address !== null && context?.nullifiers) {
    return context.nullifiers.some((nullifier) => {
      try {
        return nullifierPda(nullifier, context.programId).toBase58() === origin.address;
      } catch {
        return false; // Not a field element: no account of that nullifier exists.
      }
    });
  }
  // Created by a system instruction of the transaction itself, not by a program on its behalf.
  if (origin.topLevel) return false;
  if (origin.instruction !== null) return TRANSACTS.has(origin.instruction);
  return null;
}

/**
 * Maps a failed send, simulation or confirmation to a typed
 * {@link ProgramError}, or returns null when it does not look like a program
 * rejection at all (a network error, an expired blockhash, ...).
 *
 * Accepts whatever is at hand: an array of log lines, a web3.js
 * `SendTransactionError`, a simulation result (`{ err, logs }`), a
 * transaction error (`{ InstructionError: [1, { Custom: 6001 }] }`) or an
 * error message string.
 *
 * - 6000 to 6016 become a `ProgramError` with the matching `kind`;
 *   `UnknownRoot` is an {@link UnknownRootError} (sync, prove again).
 * - The system program's "already in use" (custom error 0) on one of the
 *   transaction's nullifier accounts becomes a {@link NullifierSpentError}:
 *   the note is spent. Which account it was is taken from what is given, in
 *   this order: the account the log line names, compared with the nullifier
 *   accounts of `context.nullifiers`; otherwise the logs around the line (the
 *   runtime's invoke lines and Anchor's `Instruction:` line): under `Transact`
 *   it is a nullifier record, the only kind of account `transact` creates.
 *   An "already in use" that is shown not to be about a nullifier account (a
 *   second `initialize`, where it is the config account; a system instruction
 *   of the transaction itself; an account that is none of the given
 *   nullifiers') becomes `kind: "AccountAlreadyInUse"`, which says nothing
 *   about any note. When neither source says which account it was (a bare
 *   "already in use" line, an error message without logs), the answer is
 *   `NullifierSpentError`, as it was before this distinction existed.
 * - Two rejections by the runtime itself, which carry no custom code:
 *   `InsufficientFundsForRent` (a withdrawal or fee would leave its
 *   destination below the rent-exempt minimum; the program had already run
 *   to the end and logged its events, see docs/program.md) and
 *   `ComputeBudgetExceeded` (the compute-unit limit was too low).
 * - Any other custom code, including variants added to the program after this
 *   SDK was built, becomes `kind: "Unknown"` with the number and, when the
 *   logs have it, Anchor's own name and message.
 *
 * `context` is optional and only ever makes the answer more exact.
 */
export function parseProgramError(source: unknown, context?: ProgramErrorContext): ProgramError | null {
  const { logs, text, custom } = collect(source);
  const lines = [...logs, ...text];

  let number: number | null = custom;
  let anchorName: string | null = null;
  let anchorMessage: string | null = null;
  for (const line of lines) {
    const anchor = ANCHOR_LOG.exec(line);
    if (anchor) {
      anchorName = anchor[1]!;
      number = Number(anchor[2]);
      anchorMessage = anchor[3]!;
      break;
    }
  }
  if (number === null) {
    for (const line of lines) {
      const hex = CUSTOM_HEX.exec(line);
      if (hex) {
        number = Number.parseInt(hex[1]!, 16);
        break;
      }
    }
  }
  const inUse = lines.some((line) => ALREADY_IN_USE.test(line));
  if (number === null && !inUse) {
    if (lines.some((line) => RENT.test(line))) {
      return new ProgramError(
        "InsufficientFundsForRent",
        null,
        "the transaction would leave an account below the rent-exempt minimum: the withdrawal or the fee is too small for its destination",
        logs,
      );
    }
    if (lines.some((line) => COMPUTE_BUDGET.test(line))) {
      return new ProgramError("ComputeBudgetExceeded", null, "the transaction ran out of compute units: set a higher compute-unit limit", logs);
    }
    return null;
  }

  if (inUse && (number === null || number === 0)) {
    if (inUseIsNullifier(logs, context) === false) {
      return new ProgramError(
        "AccountAlreadyInUse",
        0,
        "an account the transaction creates already exists, and it is not one of the transaction's nullifier accounts: no note is shown to be spent (for initialize: the pool is already initialised)",
        logs,
      );
    }
    return new NullifierSpentError("a nullifier account already exists: an input note is already spent", logs);
  }
  if (number !== null && number >= PROGRAM_ERROR_BASE && number < PROGRAM_ERROR_BASE + PROGRAM_ERROR_NAMES.length) {
    const kind = PROGRAM_ERROR_NAMES[number - PROGRAM_ERROR_BASE]!;
    // If the logs name a different error for this number, the program is newer than this table.
    if (anchorName === null || anchorName === kind) {
      return kind === "UnknownRoot" ? new UnknownRootError(MESSAGES.UnknownRoot, logs) : new ProgramError(kind, number, MESSAGES[kind], logs);
    }
  }
  const described = anchorName ? `${anchorName}: ${anchorMessage}` : "no description in the logs";
  return new ProgramError("Unknown", number, `the transaction failed with custom program error ${number} (${described})`, logs);
}
