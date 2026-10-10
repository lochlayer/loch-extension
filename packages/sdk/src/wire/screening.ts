// The deposit screening handshake: what the service must check before it
// signs, and how the client applies the signature it gets back.

import { ed25519 } from "@noble/curves/ed25519";
import { base64 } from "@scure/base";
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from "@solana/web3.js";

import { bytesToBigIntLE } from "../bytes.js";
import type { TransactArgs } from "../codec.js";
import { PROGRAM_ID } from "../constants.js";
import { type DecodedTransact, type TransactAccounts, decodeTransactInstruction, transactAccountsProblem } from "../instruction.js";
import { type ScreenRequest, type ScreenResponse, WireError, type WireResult } from "./types.js";

/** What a deposit transaction does, as established by {@link inspectDepositTransaction}. */
export interface DepositInspection {
  /** Fee payer, signer of the deposit and source of the lamports. */
  depositor: PublicKey;
  /** The screening authority the transaction expects a signature from. */
  screener: PublicKey;
  /** Lamports moved from the depositor into the pool (`ext_amount`). */
  amount: bigint;
  /** `ext_data.fee`: paid from the vault back to the depositor. */
  fee: bigint;
  /** The decoded `transact` arguments. */
  args: TransactArgs;
  /** The `transact` accounts by name. */
  accounts: TransactAccounts;
  /** Value of the SetComputeUnitLimit instruction, or null if there is none. */
  computeUnitLimit: number | null;
  /** Value of the SetComputeUnitPrice instruction in micro-lamports, or null. */
  computeUnitPrice: bigint | null;
  /** Position of the screener's signature in `transaction.signatures`. */
  screenerSignatureIndex: number;
  /** The exact bytes the screening authority signs: the serialised message. */
  message: Uint8Array;
}

/** Options of {@link inspectDepositTransaction}. */
export interface InspectDepositOptions {
  /**
   * The screening authority the transaction must name: the service's own key
   * (or, for a client checking its own deposit, `PoolConfig.screener`).
   * Required: a deposit that names any other key in the screener slot is not
   * one this authority can sign, and signing it would throw instead of
   * producing a refusal.
   */
  screener: PublicKey;
  /** Defaults to the devnet program id. */
  programId?: PublicKey;
}

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

/**
 * What each account of `transact` is in a deposit, in account order: config,
 * tree, vault, nullifier0, nullifier1, recipient, relayer, screener, signer,
 * system program (docs/protocol.md section 11).
 */
const DEPOSIT_ACCOUNT_ROLES: readonly { signer: boolean; writable: boolean }[] = [
  { signer: false, writable: false },
  { signer: false, writable: true },
  { signer: false, writable: true },
  { signer: false, writable: true },
  { signer: false, writable: true },
  { signer: false, writable: true },
  { signer: false, writable: true },
  { signer: true, writable: false },
  { signer: true, writable: true },
  { signer: false, writable: false },
];

/**
 * Parses `ScreenRequest.transaction`. The bytes must be exactly one
 * transaction in the encoding a serialiser produces: bytes that follow the
 * transaction are refused, and so is a second spelling of the same
 * transaction (a length written with more bytes than it needs), so what the
 * service signs is byte for byte what the client sent.
 *
 * Fails with `invalid_transaction`.
 */
export function parseScreenTransaction(request: ScreenRequest): WireResult<VersionedTransaction> {
  const fail = (why: string): WireResult<VersionedTransaction> => ({ ok: false, error: new WireError("invalid_transaction", why, 400) });
  let bytes: Uint8Array;
  let transaction: VersionedTransaction;
  try {
    bytes = base64.decode(request.transaction);
    transaction = VersionedTransaction.deserialize(bytes);
  } catch {
    return fail("the transaction could not be deserialised");
  }
  // The deserialiser reads one transaction and ignores whatever comes after it.
  let canonical: Uint8Array;
  try {
    canonical = transaction.serialize();
  } catch {
    return fail("the transaction could not be deserialised");
  }
  const same = (length: number) => canonical.subarray(0, length).every((byte, index) => byte === bytes[index]);
  if (canonical.length < bytes.length && same(canonical.length)) return fail("bytes follow the transaction");
  if (canonical.length !== bytes.length || !same(canonical.length)) return fail("the transaction is not in canonical encoding");
  return { ok: true, value: transaction };
}

/**
 * Checks that a transaction is exactly one canonical `loch_pool` deposit and
 * nothing else. The screening service must call this before it signs: its
 * signature authorises the whole message, so any other instruction, or the
 * screener's key in any other role, could spend the screener's own funds.
 *
 * Accepted: a v0 message without lookup tables whose instructions are at most
 * one SetComputeUnitLimit, at most one SetComputeUnitPrice and exactly one
 * `transact` with `ext_amount > 0`; exactly two required signers, the fee
 * payer (the depositor) and the screener, which must be `options.screener`;
 * the screener appears only in the screener slot, read-only; signer,
 * recipient and relayer are all the depositor; every account is the one the
 * program derives.
 *
 * The account list and the message header must be those of a deposit too:
 * no account is listed twice, every account is used by an instruction, and
 * the header gives each account exactly the signer and writable flags a
 * deposit has (docs/protocol.md section 11): the depositor a writable signer,
 * the screener a read-only signer, the tree, the vault and the two nullifier
 * records writable, the config, the system program and the program ids
 * read-only. A message that marks the tree read-only or the config writable
 * is not the deposit the protocol describes, whatever it would do on chain.
 *
 * Not checked here (the service's own job): the amount against its cap, the
 * pause flag, the blockhash, and the screening policy itself. That the bytes
 * the client sent are this transaction and nothing more is checked by
 * {@link parseScreenTransaction}.
 *
 * Fails with `invalid_transaction` and a message that says what is wrong.
 */
export function inspectDepositTransaction(
  transaction: VersionedTransaction,
  options: InspectDepositOptions,
): WireResult<DepositInspection> {
  const programId = options?.programId ?? PROGRAM_ID;
  const fail = (why: string): WireResult<DepositInspection> => ({
    ok: false,
    error: new WireError("invalid_transaction", `not a plain Loch deposit: ${why}`, 400),
  });
  const expectedScreener = options?.screener;
  if (typeof expectedScreener?.equals !== "function") {
    throw new WireError("internal", "inspectDepositTransaction needs the screening authority's public key (options.screener)", 500);
  }

  const { message } = transaction;
  if (message.version !== 0) return fail("the transaction must be version 0");
  if (message.addressTableLookups.length !== 0) return fail("address lookup tables are not allowed");
  const keys = message.staticAccountKeys;
  const { header } = message;
  if (header.numRequiredSignatures !== 2 || header.numReadonlySignedAccounts !== 1) {
    return fail("expected exactly two signers: the depositor and the read-only screener");
  }
  if (transaction.signatures.length !== 2) return fail("expected exactly two signature slots");

  let decoded: DecodedTransact | null = null;
  let computeUnitLimit: number | null = null;
  let computeUnitPrice: bigint | null = null;
  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program) return fail("an instruction refers to a missing program");
    if (program.equals(ComputeBudgetProgram.programId)) {
      const { data } = instruction;
      if (instruction.accountKeyIndexes.length !== 0) return fail("a compute budget instruction lists accounts");
      if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length === 5 && computeUnitLimit === null) {
        computeUnitLimit = Number(bytesToBigIntLE(data.subarray(1)));
      } else if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length === 9 && computeUnitPrice === null) {
        computeUnitPrice = bytesToBigIntLE(data.subarray(1));
      } else {
        return fail("only one SetComputeUnitLimit and one SetComputeUnitPrice are allowed");
      }
    } else if (program.equals(programId)) {
      if (decoded) return fail("more than one loch_pool instruction");
      try {
        decoded = decodeTransactInstruction(instruction, keys);
      } catch {
        return fail("the loch_pool instruction is not a well-formed transact call");
      }
    } else {
      return fail("it contains an instruction for another program");
    }
  }
  if (!decoded) return fail("there is no loch_pool instruction");

  const problem = transactAccountsProblem(decoded, programId);
  if (problem) return fail(problem);
  const { args, accounts } = decoded;
  if (args.extData.extAmount <= 0n) return fail("ext_amount is not positive");

  const depositor = keys[0]!;
  const screener = accounts.screener;
  if (!screener) return fail("the screener account is missing");
  if (!screener.equals(expectedScreener)) return fail("it names a different screening authority");
  if (screener.equals(depositor)) return fail("the screener cannot be the depositor");
  if (!keys[1]!.equals(screener)) return fail("the second signer is not the screener");
  if (!accounts.signer.equals(depositor)) return fail("the deposit signer is not the fee payer");
  if (!accounts.recipient.equals(depositor) || !accounts.relayer.equals(depositor)) {
    return fail("recipient and relayer must both be the depositor");
  }
  // The screener's key may sit in the screener slot only.
  const named: [string, PublicKey][] = Object.entries(accounts).filter((entry): entry is [string, PublicKey] => entry[1] !== null);
  if (named.some(([name, key]) => name !== "screener" && key.equals(screener))) {
    return fail("the screener's key is used as another account");
  }

  // The account list and the header, as the runtime reads them: by index.
  const signers = header.numRequiredSignatures;
  const readonlySigners = header.numReadonlySignedAccounts;
  const readonlyUnsigned = header.numReadonlyUnsignedAccounts;
  if (!Number.isInteger(readonlyUnsigned) || readonlyUnsigned < 0 || readonlyUnsigned > keys.length - signers) {
    return fail("the message header does not fit its account list");
  }
  if (new Set(keys.map((key) => key.toBase58())).size !== keys.length) return fail("an account is listed twice");
  // What a deposit makes of each account: the fee payer signs and pays, a
  // program id is only executed, and the accounts of transact have the roles
  // of section 11. (Compute budget instructions list no accounts.)
  const expected = keys.map((_, index) => ({ used: index === 0, signer: index === 0, writable: index === 0 }));
  for (const instruction of message.compiledInstructions) {
    expected[instruction.programIdIndex]!.used = true;
    instruction.accountKeyIndexes.forEach((index, slot) => {
      const account = expected[index]!;
      const role = DEPOSIT_ACCOUNT_ROLES[slot]!;
      account.used = true;
      account.signer ||= role.signer;
      account.writable ||= role.writable;
    });
  }
  if (expected.some((account) => !account.used)) return fail("the account list holds an account that no instruction uses");
  for (const [index, account] of expected.entries()) {
    const signer = index < signers;
    const writable = signer ? index < signers - readonlySigners : index < keys.length - readonlyUnsigned;
    if (signer !== account.signer || writable !== account.writable) {
      return fail("the message header gives an account other signer or writable flags than a deposit has");
    }
  }

  return {
    ok: true,
    value: {
      depositor,
      screener,
      amount: args.extData.extAmount,
      fee: args.extData.fee,
      args,
      accounts,
      computeUnitLimit,
      computeUnitPrice,
      screenerSignatureIndex: 1,
      message: message.serialize(),
    },
  };
}

/**
 * Inserts the screening authority's signature into a deposit transaction, at
 * the screener's signer index. Call it before the wallet signs: wallets keep
 * signatures that are already there, and some rewrite transactions that have
 * none.
 *
 * The signature is verified against the transaction message first, so a
 * screener that signed something else is caught here and not by the cluster.
 * The transaction is modified in place and returned.
 *
 * @throws WireError `bad_response` if the response is malformed, the screener
 *   is not a signer of this transaction, or the signature does not verify.
 */
export function applyScreenerSignature(transaction: VersionedTransaction, response: ScreenResponse): VersionedTransaction {
  let screener: PublicKey;
  let signature: Uint8Array;
  try {
    screener = new PublicKey(response.screener);
    signature = base64.decode(response.signature);
  } catch (cause) {
    throw new WireError("bad_response", "the screener's answer is malformed", null, { cause });
  }
  if (signature.length !== 64) throw new WireError("bad_response", "the screener's signature is not 64 bytes");
  const { message } = transaction;
  const index = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).findIndex((key) => key.equals(screener));
  if (index < 0) throw new WireError("bad_response", "the screener that answered is not a signer of this transaction");
  let valid = false;
  try {
    valid = ed25519.verify(signature, message.serialize(), screener.toBytes());
  } catch {
    valid = false;
  }
  if (!valid) throw new WireError("bad_response", "the screener's signature does not match this transaction");
  transaction.signatures[index] = signature;
  return transaction;
}
