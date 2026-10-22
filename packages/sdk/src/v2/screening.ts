// The screening handshake for v2 deposits (docs/v2.md section 7, docs/services.md): what a
// screening service checks before it co-signs a `transact_v2` deposit. The same rules as v1's
// `inspectDepositTransaction` (wire/screening.ts), for the v2 account list: exactly one
// canonical deposit, the compute budget, wallet assertions, and nothing else; the screening
// key in its slot only, read-only.

import { type AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";

import { bytesToBigIntBE, bytesToBigIntLE } from "../bytes.js";
import { LIGHTHOUSE_PROGRAM_ID, PROGRAM_ID } from "../constants.js";
import { type AnyTransaction, TransactionV1 } from "../transactionV1.js";
import { MAX_LIGHTHOUSE_INSTRUCTIONS } from "../wire/screening.js";
import { WireError, type WireResult } from "../wire/types.js";
import { type TransactArgsV2, decodeV2Data, isV2Data } from "./codec.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "./constants.js";
import { assetPda, configV2Pda, eventAuthorityPda, nullifierV2Pda, treeV2Pda, vaultV2Pda } from "./program.js";

/** What a v2 deposit does, as {@link inspectDepositTransactionV2} established it. */
export interface DepositInspectionV2 {
  /** Fee payer and signer: the depositor. */
  depositor: PublicKey;
  screener: PublicKey;
  /** The asset deposited. */
  mint: PublicKey;
  /** Base units moved into the pool (`ext_amount`). */
  amount: bigint;
  /** A token deposit's source token account (the token program checks it is the depositor's); null for SOL. */
  source: PublicKey | null;
  args: TransactArgsV2;
  version: 0 | 1;
  computeUnitLimit: number | null;
  computeUnitPrice: bigint | null;
  priorityFeeLamports: bigint | null;
  loadedAccountsDataSizeLimit: number | null;
  lighthouseInstructions: number;
  screenerSignatureIndex: number;
  /** The exact bytes the screening authority signs. */
  message: Uint8Array;
}

export interface InspectDepositV2Options {
  screener: PublicKey;
  programId?: PublicKey;
  /** The pool's frozen lookup table, for a version-0 deposit. */
  lookupTable?: AddressLookupTableAccount | null;
}

/** Number of accounts of `transact_v2` (docs/v2.md section 7). */
export const TRANSACT_V2_ACCOUNTS = 14;
/** Slot of the screening authority among them. */
export const TRANSACT_V2_SCREENER_SLOT = 8;

/** True when `data` is a `transact_v2` or `swap_v2` instruction. */
export const isTransactV2Data = isV2Data;

/**
 * Checks that a transaction is exactly one canonical v2 deposit and nothing else. Fails with
 * `invalid_transaction`. Not checked here: caps, pause, blockhash, the screening policy.
 */
export function inspectDepositTransactionV2(transaction: AnyTransaction, options: InspectDepositV2Options): WireResult<DepositInspectionV2> {
  const programId = options.programId ?? PROGRAM_ID;
  const fail = (why: string): WireResult<DepositInspectionV2> => ({ ok: false, error: new WireError("invalid_transaction", `not a plain Loch v2 deposit: ${why}`, 400) });
  const expectedScreener = options.screener;
  if (typeof expectedScreener?.equals !== "function") throw new WireError("internal", "inspectDepositTransactionV2 needs the screening authority's public key", 500);
  const table = options.lookupTable ?? null;
  if (table && table.state.authority !== undefined) throw new WireError("internal", "options.lookupTable must be frozen", 500);

  const { message } = transaction;
  if (message.version !== 0 && message.version !== 1) return fail("the transaction must be version 0 or 1");
  if (message.version === 1 && !(transaction instanceof TransactionV1)) return fail("a version 1 transaction must be read with deserializeTransaction");
  const lookups = message.addressTableLookups;
  if (lookups.length > 1) return fail("at most one address lookup table is allowed");
  if (lookups.length === 1 && !(table && lookups[0]!.accountKey.equals(table.key))) return fail("the only lookup table allowed is the pool's");
  let keys: PublicKey[];
  try {
    keys = message.getAccountKeys({ addressLookupTableAccounts: table ? [table] : [] }).keySegments().flat();
  } catch {
    return fail("a lookup names an address the pool's table does not have");
  }
  const { header } = message;
  if (header.numRequiredSignatures !== 2 || header.numReadonlySignedAccounts !== 1) return fail("expected exactly two signers: the depositor and the read-only screener");
  if (transaction.signatures.length !== 2) return fail("expected exactly two signature slots");
  if (header.numReadonlyUnsignedAccounts > message.staticAccountKeys.length - 2) return fail("the message header does not fit its account list");
  if (new Set(keys.map((key) => key.toBase58())).size !== keys.length) return fail("an account is listed twice");

  let args: TransactArgsV2 | null = null;
  let slots: readonly number[] = [];
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
      if (data[0] === 2 && data.length === 5 && computeUnitLimit === null) computeUnitLimit = Number(bytesToBigIntLE(data.subarray(1)));
      else if (data[0] === 3 && data.length === 9 && computeUnitPrice === null) computeUnitPrice = bytesToBigIntLE(data.subarray(1));
      else if (data[0] === 4 && data.length === 5 && loadedAccountsDataSizeLimit === null) loadedAccountsDataSizeLimit = Number(bytesToBigIntLE(data.subarray(1)));
      else return fail("only one SetComputeUnitLimit, one SetComputeUnitPrice and one SetLoadedAccountsDataSizeLimit are allowed");
    } else if (program.equals(programId)) {
      if (args) return fail("more than one loch_pool instruction");
      let decoded;
      try {
        decoded = decodeV2Data(instruction.data);
      } catch {
        return fail("the loch_pool instruction is not a well-formed transact_v2 call");
      }
      if (decoded.kind !== "transact") return fail("a swap is not a deposit");
      if (instruction.accountKeyIndexes.length !== TRANSACT_V2_ACCOUNTS) return fail("the loch_pool instruction does not have the accounts of transact_v2");
      args = decoded.args;
      slots = instruction.accountKeyIndexes;
    } else if (program.equals(LIGHTHOUSE_PROGRAM_ID)) {
      if (++lighthouse > MAX_LIGHTHOUSE_INSTRUCTIONS) return fail(`more than ${MAX_LIGHTHOUSE_INSTRUCTIONS} Lighthouse instructions`);
      for (const index of instruction.accountKeyIndexes) lighthouseAccounts.add(index);
    } else {
      return fail("it contains an instruction for another program");
    }
  }
  if (!args) return fail("there is no loch_pool instruction");
  let priorityFeeLamports: bigint | null = null;
  if (message.version === 1) {
    const config = message.transactionConfig;
    computeUnitLimit = config.computeUnitLimit;
    computeUnitPrice = null;
    loadedAccountsDataSizeLimit = config.loadedAccountsDataSizeLimit;
    priorityFeeLamports = config.priorityFee === null ? null : BigInt(config.priorityFee);
  }

  const ext = args.extData;
  if (ext.extAmount <= 0n) return fail("ext_amount is not positive");
  if (!ext.recipient.equals(PublicKey.default)) return fail("a deposit names no recipient");
  const mint = ext.asset;
  const native = mint.equals(NATIVE_MINT);
  const at = (slot: number) => keys[slots[slot]!]!;
  const depositor = keys[0]!;
  const screener = at(TRANSACT_V2_SCREENER_SLOT);
  // Each slot: the account it must hold (null: any account but the signers and the program), signer, writable.
  const expectSlots: [PublicKey | null, boolean, boolean][] = [
    [configV2Pda(programId), false, false],
    [treeV2Pda(programId), false, true],
    [nullifierV2Pda(bytesToBigIntBE(args.inputNullifiers[0]), programId), false, true],
    [nullifierV2Pda(bytesToBigIntBE(args.inputNullifiers[1]), programId), false, true],
    [assetPda(mint, programId), false, false],
    [vaultV2Pda(mint, programId), false, true],
    native ? [programId, false, false] : [null, false, true],
    [programId, false, false],
    [expectedScreener, true, false],
    [depositor, true, true],
    native ? [programId, false, false] : [TOKEN_PROGRAM_ID, false, false],
    [SystemProgram.programId, false, false],
    [eventAuthorityPda(programId), false, false],
    [programId, false, false],
  ];
  for (const [slot, [key]] of expectSlots.entries()) {
    if (key && !at(slot).equals(key)) {
      if (slot === TRANSACT_V2_SCREENER_SLOT) return fail("it names a different screening authority");
      if (slot === 9) return fail("the deposit signer is not the fee payer");
      return fail(`account ${slot} of transact_v2 is not the one the program derives`);
    }
  }
  if (screener.equals(depositor)) return fail("the screener cannot be the depositor");
  if (!keys[1]!.equals(screener)) return fail("the second signer is not the screener");
  const source = native ? null : at(6);
  if (source && (source.equals(depositor) || source.equals(screener) || source.equals(programId))) return fail("the source token account is not one");
  if (slots.filter((index) => index === 1).length !== 1) return fail("the screener's key is used as another account");
  if (lighthouseAccounts.has(1) || programs.has(1)) return fail("the screener's key is used by another instruction");

  // The flags the runtime reads, by index: the deposit's roles, nothing more.
  const expected = keys.map((_, index) => ({ used: index === 0, signer: index === 0, writable: index === 0, free: false }));
  for (const index of programs) expected[index]!.used = true;
  slots.forEach((index, slot) => {
    const account = expected[index]!;
    const [, signer, writable] = expectSlots[slot]!;
    account.used = true;
    account.signer ||= signer;
    account.writable ||= writable;
  });
  for (const index of lighthouseAccounts) {
    const account = expected[index]!;
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
      mint,
      amount: ext.extAmount,
      source,
      args,
      version: message.version,
      computeUnitLimit,
      computeUnitPrice,
      priorityFeeLamports,
      loadedAccountsDataSizeLimit,
      lighthouseInstructions: lighthouse,
      screenerSignatureIndex: 1,
      message: message.serialize(),
    },
  };
}
