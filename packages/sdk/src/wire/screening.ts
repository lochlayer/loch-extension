// The deposit screening handshake: what the service must check before it
// signs, and how the client applies the signature it gets back.

import { ed25519 } from "@noble/curves/ed25519";
import { base64 } from "@scure/base";
import { type AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, VersionedTransaction } from "@solana/web3.js";

import { bytesToBigIntLE } from "../bytes.js";
import type { TransactArgs } from "../codec.js";
import { LIGHTHOUSE_PROGRAM_ID, PROGRAM_ID } from "../constants.js";
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
  /** Value of the SetLoadedAccountsDataSizeLimit instruction in bytes, or null. */
  loadedAccountsDataSizeLimit: number | null;
  /** How many Lighthouse assertion instructions a wallet added. */
  lighthouseInstructions: number;
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
  /**
   * The pool's address lookup table, which a deposit may load accounts from.
   * It must be frozen. Omitted: a deposit that uses a lookup table is refused.
   */
  lookupTable?: AddressLookupTableAccount | null;
}

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 4;
/** Most Lighthouse instructions a deposit may carry. Phantom adds one or two. */
export const MAX_LIGHTHOUSE_INSTRUCTIONS = 8;

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
 * Accepted: a v0 message whose instructions are exactly one `transact` with
 * `ext_amount > 0`, at most one each of SetComputeUnitLimit,
 * SetComputeUnitPrice and SetLoadedAccountsDataSizeLimit, and at most
 * {@link MAX_LIGHTHOUSE_INSTRUCTIONS} instructions of the Lighthouse assertion
 * program, which a wallet may add (Phantom does) and which can only make the
 * transaction fail; exactly two required signers, the fee payer (the
 * depositor) and the screener, which must be `options.screener`; the screener
 * appears only in the screener slot of `transact`, read-only, and in no
 * other instruction; signer, recipient and relayer are all the depositor;
 * every account is the one the program derives. The message may load
 * accounts from one address lookup table, `options.lookupTable` (the pool's),
 * which must be frozen: its addresses never change, so the accounts inspected
 * here are the accounts that run.
 *
 * The account list and the message header must be those of a deposit too:
 * no account is listed twice (counting the ones loaded from the table), every
 * account is used by an instruction, and the header gives each account
 * exactly the signer and writable flags a deposit has (docs/protocol.md
 * section 11): the depositor a writable signer, the screener a read-only
 * signer, the tree, the vault and the two nullifier records writable, the
 * config, the system program and the program ids read-only. An account that
 * only a Lighthouse instruction names may be writable (a Lighthouse memory
 * account) but is never a signer. A message that marks the tree read-only or
 * the config writable is not the deposit the protocol describes, whatever it
 * would do on chain.
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
  const table = options.lookupTable ?? null;
  if (table && table.state.authority !== undefined) {
    throw new WireError("internal", "options.lookupTable must be frozen: a table that can still change could load other accounts than the ones inspected", 500);
  }

  const { message } = transaction;
  if (message.version !== 0) return fail("the transaction must be version 0");
  const lookups = message.addressTableLookups;
  if (lookups.length > 1) return fail("at most one address lookup table is allowed");
  if (lookups.length === 1 && !(table && lookups[0]!.accountKey.equals(table.key))) return fail("the only lookup table allowed is the pool's");
  // Every account the transaction uses, by the index the instructions use: the static keys,
  // then the writable and the read-only ones loaded from the table.
  let keys: PublicKey[];
  try {
    keys = message.getAccountKeys({ addressLookupTableAccounts: table ? [table] : [] }).keySegments().flat();
  } catch {
    return fail("a lookup names an address the pool's table does not have");
  }
  const { header } = message;
  if (header.numRequiredSignatures !== 2 || header.numReadonlySignedAccounts !== 1) {
    return fail("expected exactly two signers: the depositor and the read-only screener");
  }
  if (transaction.signatures.length !== 2) return fail("expected exactly two signature slots");
  const staticKeys = message.staticAccountKeys.length;
  if (!Number.isInteger(header.numReadonlyUnsignedAccounts) || header.numReadonlyUnsignedAccounts < 0 || header.numReadonlyUnsignedAccounts > staticKeys - 2) {
    return fail("the message header does not fit its account list");
  }
  if (new Set(keys.map((key) => key.toBase58())).size !== keys.length) return fail("an account is listed twice");

  let decoded: DecodedTransact | null = null;
  let transactIndexes: readonly number[] = [];
  let computeUnitLimit: number | null = null;
  let computeUnitPrice: bigint | null = null;
  let loadedAccountsDataSizeLimit: number | null = null;
  let lighthouse = 0;
  const lighthouseAccounts = new Set<number>();
  const programs = new Set<number>();
  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program) return fail("an instruction refers to a missing program");
    if (instruction.accountKeyIndexes.some((index) => index >= keys.length)) return fail("an instruction refers to a missing account");
    programs.add(instruction.programIdIndex);
    if (program.equals(ComputeBudgetProgram.programId)) {
      const { data } = instruction;
      if (instruction.accountKeyIndexes.length !== 0) return fail("a compute budget instruction lists accounts");
      if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length === 5 && computeUnitLimit === null) {
        computeUnitLimit = Number(bytesToBigIntLE(data.subarray(1)));
      } else if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length === 9 && computeUnitPrice === null) {
        computeUnitPrice = bytesToBigIntLE(data.subarray(1));
      } else if (data[0] === SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT && data.length === 5 && loadedAccountsDataSizeLimit === null) {
        loadedAccountsDataSizeLimit = Number(bytesToBigIntLE(data.subarray(1)));
      } else {
        return fail("only one SetComputeUnitLimit, one SetComputeUnitPrice and one SetLoadedAccountsDataSizeLimit are allowed");
      }
    } else if (program.equals(programId)) {
      if (decoded) return fail("more than one loch_pool instruction");
      try {
        decoded = decodeTransactInstruction(instruction, keys);
      } catch {
        return fail("the loch_pool instruction is not a well-formed transact call");
      }
      transactIndexes = instruction.accountKeyIndexes;
    } else if (program.equals(LIGHTHOUSE_PROGRAM_ID)) {
      if (++lighthouse > MAX_LIGHTHOUSE_INSTRUCTIONS) return fail(`more than ${MAX_LIGHTHOUSE_INSTRUCTIONS} Lighthouse instructions`);
      for (const index of instruction.accountKeyIndexes) lighthouseAccounts.add(index);
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
  // The screener's key may sit in the screener slot only: in no other slot of transact, and
  // in no other instruction, as an account or as a program. (It is listed once, above.)
  const named: [string, PublicKey][] = Object.entries(accounts).filter((entry): entry is [string, PublicKey] => entry[1] !== null);
  if (named.some(([name, key]) => name !== "screener" && key.equals(screener))) {
    return fail("the screener's key is used as another account");
  }
  if (lighthouseAccounts.has(1) || programs.has(1)) return fail("the screener's key is used by another instruction");

  // The flags each account has, as the runtime reads them: by index. What a deposit makes of
  // each account: the fee payer signs and pays, a program id is only executed, the accounts
  // of transact have the roles of section 11, and an account only Lighthouse names is not a
  // signer. (Compute budget instructions list no accounts.)
  const expected = keys.map((_, index) => ({ used: index === 0, signer: index === 0, writable: index === 0, free: false }));
  for (const index of programs) expected[index]!.used = true;
  transactIndexes.forEach((index, slot) => {
    const account = expected[index]!;
    const role = DEPOSIT_ACCOUNT_ROLES[slot]!;
    account.used = true;
    account.signer ||= role.signer;
    account.writable ||= role.writable;
  });
  for (const index of lighthouseAccounts) {
    const account = expected[index]!;
    // Writable or not, as the wallet chose, when nothing else gives it a role.
    account.free = !account.used;
    account.used = true;
  }
  if (expected.some((account) => !account.used)) return fail("the account list holds an account that no instruction uses");
  for (const [index, account] of expected.entries()) {
    const signer = message.isAccountSigner(index);
    const writable = message.isAccountWritable(index);
    if (signer !== account.signer || (!account.free && writable !== account.writable) || (programs.has(index) && writable)) {
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
      loadedAccountsDataSizeLimit,
      lighthouseInstructions: lighthouse,
      screenerSignatureIndex: 1,
      message: message.serialize(),
    },
  };
}

/**
 * Inserts the screening authority's signature into a deposit transaction, at
 * the screener's signer index. Call it on the transaction the wallet signed,
 * after it signed: a wallet warns about a transaction another key signed
 * before it (Phantom does), and may add instructions of its own (Lighthouse
 * assertions), which a signature made earlier would not cover.
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
