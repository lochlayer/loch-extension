// Typed errors. What is safe to log: `name`, `code`, `message` and every
// enumerable property. None of them holds a key, a blinding or an amount of a
// private note, so `console.error(error)`, `JSON.stringify` and error reporters
// that walk own properties print nothing secret. The few values that are
// private (a balance, the amount being sent) are non-enumerable properties:
// code can read them, logging does not show them. `cause` is whatever the
// underlying library threw and is not covered by this promise.

/** Stable machine-readable codes of {@link LochError}. */
export type LochErrorCode =
  /** A caller-supplied value is malformed or out of range. */
  | "INVALID_ARGUMENT"
  /** The key-derivation signature is not a valid signature of the derivation message. */
  | "INVALID_SIGNATURE"
  /** A shielded address or a payment code failed to decode; see {@link AddressError.reason}. */
  | "INVALID_ADDRESS"
  /** Too many payment codes in a row are unpaid; reuse one of them. */
  | "PAYMENT_CODE_LIMIT"
  /** Instruction data, account data or an event could not be decoded. */
  | "DECODE_FAILED"
  /** The relayer's fee is above the maximum the caller allowed. */
  | "FEE_TOO_HIGH"
  /** The shielded balance is smaller than amount + fee. */
  | "INSUFFICIENT_BALANCE"
  /** The balance is sufficient but spread over more than two notes. */
  | "CONSOLIDATION_REQUIRED"
  /** The withdrawal would leave the recipient below the rent-exempt minimum. */
  | "RECIPIENT_BELOW_RENT_EXEMPT"
  /** The deposit exceeds the pool's per-transaction cap. */
  | "DEPOSIT_TOO_LARGE"
  /** Deposits are paused by the pool admin. */
  | "DEPOSITS_PAUSED"
  /** The local tree does not contain what the transaction needs; sync first. */
  | "STALE_STATE"
  /** Local state and the chain disagree, or events are missing. */
  | "SYNC_FAILED"
  /** A pool account does not exist or is not owned by the program. */
  | "ACCOUNT_NOT_FOUND"
  /** Witness generation or proving failed. */
  | "PROOF_FAILED"
  /** The serialised transaction is larger than a Solana packet. */
  | "TRANSACTION_TOO_LARGE"
  /** The program (or the system program on its behalf) rejected the transaction. */
  | "PROGRAM_ERROR";

/** Base class of every error the SDK throws on purpose. */
export class LochError extends Error {
  /** Stable machine-readable code. */
  readonly code: LochErrorCode;

  constructor(code: LochErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LochError";
    this.code = code;
  }
}

/** Why a shielded address was rejected. */
export type AddressErrorReason = "encoding" | "prefix" | "checksum" | "length" | "public_key_range" | "encryption_key";

/** A shielded address or a payment code that cannot be decoded. */
export class AddressError extends LochError {
  /** What exactly is wrong with the address. */
  readonly reason: AddressErrorReason;

  constructor(reason: AddressErrorReason, message: string) {
    super("INVALID_ADDRESS", message);
    this.name = "AddressError";
    this.reason = reason;
  }
}

/** Defines read-only properties that code can read but logging and serialisation skip. */
function hidden(target: object, values: Record<string, bigint>): void {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(target, name, { value, enumerable: false, writable: false, configurable: false });
  }
}

/**
 * The relayer asks for more than the caller allowed (`SpendContext.maxFee`).
 * Nothing was proven or sent. Both values are public: the fee is part of the
 * transaction a relayer would have sent.
 */
export class FeeTooHighError extends LochError {
  /** The fee that was asked for, in lamports. */
  readonly fee: bigint;
  /** The maximum the caller allowed, in lamports. */
  readonly maxFee: bigint;

  constructor(fee: bigint, maxFee: bigint) {
    super("FEE_TOO_HIGH", `the relayer fee of ${fee} lamports exceeds the maximum of ${maxFee} lamports allowed for this transaction`);
    this.name = "FeeTooHighError";
    this.fee = fee;
    this.maxFee = maxFee;
  }
}

/**
 * The wallet does not hold enough shielded lamports. `required` and
 * `available` are private amounts: they are non-enumerable, so logging the
 * error does not print them.
 */
export class InsufficientBalanceError extends LochError {
  /** Lamports needed: amount plus fee. Not enumerable. */
  declare readonly required: bigint;
  /** Lamports in unspent notes. Not enumerable. */
  declare readonly available: bigint;

  constructor(required: bigint, available: bigint) {
    super("INSUFFICIENT_BALANCE", "shielded balance is smaller than amount plus fee");
    this.name = "InsufficientBalanceError";
    hidden(this, { required, available });
  }
}

/**
 * The balance covers amount + fee, but no two notes do. A transaction spends
 * at most two notes, so merge notes first with `prepareConsolidation`
 * (a private transfer to self), sync, and try again. The amounts are private
 * and non-enumerable, as in {@link InsufficientBalanceError}.
 */
export class ConsolidationRequiredError extends LochError {
  /** Lamports needed: amount plus fee. Not enumerable. */
  declare readonly required: bigint;
  /** Lamports in unspent notes. Not enumerable. */
  declare readonly available: bigint;
  /** Value of the two largest unspent notes together. Not enumerable. */
  declare readonly largestPair: bigint;

  constructor(required: bigint, available: bigint, largestPair: bigint) {
    super(
      "CONSOLIDATION_REQUIRED",
      "the balance is spread over more than two notes; send a consolidation transfer to self first",
    );
    this.name = "ConsolidationRequiredError";
    hidden(this, { required, available, largestPair });
  }
}

/** Local state and the chain disagree, or events could not be fetched completely. */
export class SyncError extends LochError {
  /**
   * What to do about it:
   *
   * - `mismatch`: the local state is not a prefix of the chain (a wrong leaf,
   *   a fork that undid what was synced, a pool that was reset). Discard the
   *   state and sync from `createWalletState`. An RPC node that is far behind
   *   and does not know the last synced transaction yet is reported the same
   *   way, because it looks the same; starting over is then merely slower.
   * - `gap`, `unavailable`: the RPC did not deliver a complete, consistent
   *   view (a missing transaction, a node that lags, a listing that does not
   *   advance). The state is still good: try again, or use another endpoint.
   * - `state`: the state object is unusable (wrong keys, wrong program,
   *   malformed). Do not retry with it.
   */
  readonly reason: "gap" | "mismatch" | "unavailable" | "state";

  constructor(reason: SyncError["reason"], message: string, options?: { cause?: unknown }) {
    super("SYNC_FAILED", message, options);
    this.name = "SyncError";
    this.reason = reason;
  }
}

/**
 * Names of the `loch_pool` errors, in code order starting at 6000. 6000 to
 * 6010 are frozen; 6011 to 6016 were appended when the program was hardened.
 * The program may append more: codes beyond this list are reported as
 * `Unknown`, never guessed.
 */
export const PROGRAM_ERROR_NAMES = [
  "InvalidProof",
  "UnknownRoot",
  "TreeFull",
  "RecipientMismatch",
  "RelayerMismatch",
  "MissingScreenerSignature",
  "DepositTooLarge",
  "DepositsPaused",
  "EncryptedOutputTooLarge",
  "AmountOutOfRange",
  "PoseidonError",
  "NonCanonicalFieldElement",
  "ZeroProofElement",
  "InvalidProgramData",
  "NotUpgradeAuthority",
  "TreeNotPairAligned",
  "InvalidDestination",
] as const;

/** A `loch_pool` error name. */
export type ProgramErrorName = (typeof PROGRAM_ERROR_NAMES)[number];

/** First custom error code Anchor assigns to a program's own errors. */
export const PROGRAM_ERROR_BASE = 6000;

/** `loch_pool` error codes by name (InvalidProof = 6000 ... InvalidDestination = 6016). */
export const PROGRAM_ERROR_CODES: Readonly<Record<ProgramErrorName, number>> = Object.freeze(
  Object.fromEntries(PROGRAM_ERROR_NAMES.map((name, i) => [name, PROGRAM_ERROR_BASE + i])) as Record<ProgramErrorName, number>,
);

/**
 * What a rejected transaction means:
 *
 * - a `loch_pool` error by name;
 * - `NullifierAlreadySpent`: the system program refused to create a nullifier
 *   account that exists;
 * - `AccountAlreadyInUse`: the system program refused to create an account
 *   that exists, and that account is not one of the transaction's nullifier
 *   accounts (a second `initialize`, for example). It says nothing about a
 *   note;
 * - `InsufficientFundsForRent`: the runtime rejected the transaction after the
 *   program ran, because a withdrawal or a fee would leave its destination
 *   below the rent-exempt minimum;
 * - `ComputeBudgetExceeded`: the transaction ran out of compute units (raise
 *   the limit);
 * - `Unknown`: any custom code this SDK version does not know.
 */
export type ProgramErrorKind =
  | ProgramErrorName
  | "NullifierAlreadySpent"
  | "AccountAlreadyInUse"
  | "InsufficientFundsForRent"
  | "ComputeBudgetExceeded"
  | "Unknown";

/** The program rejected the transaction. Produced by `parseProgramError`. */
export class ProgramError extends LochError {
  /** What went wrong. */
  readonly kind: ProgramErrorKind;
  /** Custom error number (6000 and up for `loch_pool`, 0 for "already in use"); null if there is none. */
  readonly number: number | null;
  /** Program logs the error was read from, if any. */
  readonly logs: readonly string[];

  constructor(kind: ProgramErrorKind, number: number | null, message: string, logs: readonly string[] = []) {
    super("PROGRAM_ERROR", message);
    this.name = "ProgramError";
    this.kind = kind;
    this.number = number;
    this.logs = logs;
  }
}

/**
 * The proof was made against a root the program no longer keeps (or never
 * had). Sync, rebuild the transaction against the new root, prove again.
 */
export class UnknownRootError extends ProgramError {
  constructor(message: string, logs: readonly string[] = []) {
    super("UnknownRoot", PROGRAM_ERROR_CODES.UnknownRoot, message, logs);
    this.name = "UnknownRootError";
  }
}

/**
 * An input note was already spent (or a dummy nullifier was reused): the
 * nullifier account exists. Sync to refresh spent flags before retrying.
 */
export class NullifierSpentError extends ProgramError {
  constructor(message: string, logs: readonly string[] = []) {
    super("NullifierAlreadySpent", 0, message, logs);
    this.name = "NullifierSpentError";
  }
}
