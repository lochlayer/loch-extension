/**
 * @loch/sdk: the Loch client SDK. Keys, shielded addresses, notes and their
 * encryption, the commitment tree, chain sync, Groth16 proving, and building
 * `loch_pool::transact` calls that match the circuit and the program byte for
 * byte.
 *
 * Runs in Node 22, in a page and in a Manifest V3 extension. No telemetry and
 * no network access of its own: the only requests are the RPC calls on the
 * `connection` the caller passes in and, through the wire clients, the calls
 * the caller asks for. The SDK writes nothing to the console (the one line
 * snarkjs prints when a witness fails is described at `createSnarkjsProver`).
 * Secrets never appear in error messages or in what logging an error shows.
 *
 * Devnet only, unaudited. Never use with real funds.
 *
 * Entry points: `@loch/sdk` (everything except the filesystem helpers),
 * `@loch/sdk/wire` (relayer and screener protocol, without the prover),
 * `@loch/sdk/node` (loads the prover artifacts from disk).
 */

export {
  DEFAULT_COMMITMENT,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  ENCRYPTED_NOTE_LENGTH,
  FIELD_MODULUS,
  KEY_DERIVATION_MESSAGE,
  MAX_ENCRYPTED_OUTPUT_LENGTH,
  MAX_TRANSACTION_SIZE,
  PAYMENT_CODE_GAP,
  NEW_COMMITMENT_DISCRIMINATOR,
  NEW_NULLIFIERS_DISCRIMINATOR,
  PROGRAM_ID,
  SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM,
  TRANSACT_DISCRIMINATOR,
  TREE_DEPTH,
} from "./constants.js";

export {
  AddressError,
  ConsolidationRequiredError,
  FeeTooHighError,
  InsufficientBalanceError,
  LochError,
  NullifierSpentError,
  PROGRAM_ERROR_CODES,
  ProgramError,
  SyncError,
  UnknownRootError,
} from "./errors.js";
export type { AddressErrorReason, LochErrorCode, ProgramErrorKind, ProgramErrorName } from "./errors.js";
export { parseProgramError } from "./programErrors.js";
export type { ProgramErrorContext } from "./programErrors.js";

export { bytesToField, fieldToBytes, publicAmountField } from "./field.js";
export type { FieldLike } from "./field.js";

export { deriveKeys, keyDerivationMessage, paymentCodeSecret } from "./keys.js";
export type { LochKeys } from "./keys.js";
export {
  decodePaymentCode,
  decodeRecipient,
  decodeShieldedAddress,
  encodePaymentCode,
  encodeShieldedAddress,
  isPaymentCode,
  isShieldedAddress,
  paymentCodeAt,
} from "./address.js";
export type { PaymentCode, ShieldedAddress } from "./address.js";

export { createNote, encryptNote, noteCommitment, noteNullifier, openNote, tryDecryptNote } from "./note.js";
export type { Note, NoteOpeningKeys, NoteSource, OpenedNote, PaymentCodeCandidate } from "./note.js";

export { MerkleTree, merkleRootFromPath } from "./merkle.js";
export type { MerklePath, MerkleTreeJSON, MerkleTreeSnapshot } from "./merkle.js";

export { configPda, nullifierPda, treePda, vaultPda } from "./pda.js";

export {
  decodeProof,
  decodeTransactArgs,
  encodeExtData,
  encodeProof,
  encodeTransactArgs,
  extDataHash,
  proofEncodingProblem,
  transactPublicInputs,
} from "./codec.js";
export type { ExtData, Groth16Proof, ProofBytes, TransactArgs } from "./codec.js";
export { buildTransactInstruction, decodeTransactInstruction, transactAccountsProblem } from "./instruction.js";
export type { CompiledInstructionLike, DecodedTransact, TransactAccounts, TransactSigners } from "./instruction.js";
export { buildTransactTransaction } from "./transaction.js";
export type { BuildTransactionParams } from "./transaction.js";

export {
  areNullifiersSpent,
  decodePoolConfig,
  decodeTreeAccount,
  fetchPoolConfig,
  fetchRecipientRent,
  fetchTreeAccount,
  isKnownRoot,
  isNullifierSpent,
} from "./accounts.js";
export type { PoolConfig, RecipientRent, TreeAccount } from "./accounts.js";

export { parseEventLogs } from "./events.js";
export type { NewCommitmentEvent, NewNullifiersEvent, ParsedLogs, TransactionTime } from "./events.js";
export { fetchEvents, syncWallet } from "./sync.js";
export type { FetchEventsOptions, FetchedEvents, SyncConnection, SyncOptions, SyncProgress, SyncResult } from "./sync.js";

export {
  WALLET_STATE_VERSION,
  applyEvents,
  balance,
  createWalletState,
  issuePaymentCode,
  ownedNotes,
  parseWalletState,
  paymentCodeCounts,
  selectNotes,
  treeFromState,
  unspentNotes,
} from "./wallet.js";
export type { AppliedEvents, IssuedPaymentCode, OwnedNote, PaymentCodeCounts, ReceivedNote, StoredNote, WalletState } from "./wallet.js";

export { createSnarkjsProver, terminateProver, verifyProof } from "./prover.js";
export type { CircuitInput, ProofResult, Prover, SnarkjsProverOptions, VerificationKey } from "./prover.js";

export { prepareConsolidation, prepareDeposit, prepareTransact, prepareTransfer, prepareWithdrawal } from "./transact.js";
export type {
  OutputRequest,
  PrepareDepositParams,
  PrepareTransactParams,
  PrepareTransferParams,
  PrepareWithdrawalParams,
  PreparedOutput,
  PreparedSpend,
  PreparedTransact,
  SpendContext,
  SpendInput,
  TransactPublicInputs,
} from "./transact.js";

export * from "./wire.js";
