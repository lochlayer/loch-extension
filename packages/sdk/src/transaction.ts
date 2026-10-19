// Wrapping a `transact` instruction into a v0 transaction.

import { base58 } from "@scure/base";
import { ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { AddressLookupTableAccount, PublicKey } from "@solana/web3.js";

import { DEFAULT_COMPUTE_UNIT_LIMIT, MAX_TRANSACTION_SIZE } from "./constants.js";
import { LochError } from "./errors.js";
import { toWeb3Buffer } from "./instruction.js";

/** Parameters of {@link buildTransactTransaction}. */
export interface BuildTransactionParams {
  /** The `transact` instruction (`PreparedTransact.instruction` or `buildTransactInstruction`). */
  instruction: TransactionInstruction;
  /** Fee payer and first signer: the depositor for a deposit, the relayer otherwise. */
  payer: PublicKey;
  /** A recent blockhash (`connection.getLatestBlockhash()`). */
  recentBlockhash: string;
  /** Compute-unit limit. Default {@link DEFAULT_COMPUTE_UNIT_LIMIT}; the runtime's default of 200k is too tight. */
  computeUnitLimit?: number;
  /** Priority fee in micro-lamports per compute unit. Omitted: no price instruction. */
  computeUnitPrice?: number | bigint;
  /**
   * Loaded-account-data limit in bytes (SetLoadedAccountsDataSizeLimit). Omitted: no such
   * instruction. A deposit sets `DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT`.
   */
  loadedAccountsDataSizeLimit?: number;
  /** An address lookup table to compress the account list with. */
  lookupTable?: AddressLookupTableAccount | null;
}

/**
 * Builds an unsigned v0 `VersionedTransaction`: SetComputeUnitLimit, an
 * optional SetComputeUnitPrice, an optional SetLoadedAccountsDataSizeLimit,
 * then the `transact` instruction.
 *
 * @throws LochError `TRANSACTION_TOO_LARGE` if the result exceeds 1232 bytes,
 *   `INVALID_ARGUMENT` for a bad compute-unit setting or blockhash.
 */
export function buildTransactTransaction(params: BuildTransactionParams): VersionedTransaction {
  const units = params.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  if (!Number.isInteger(units) || units <= 0 || units > 1_400_000) {
    throw new LochError("INVALID_ARGUMENT", "computeUnitLimit must be an integer from 1 to 1,400,000");
  }
  let blockhashBytes = 0;
  try {
    blockhashBytes = base58.decode(params.recentBlockhash).length;
  } catch {
    blockhashBytes = 0;
  }
  if (blockhashBytes !== 32) throw new LochError("INVALID_ARGUMENT", "recentBlockhash must be a base58 blockhash");
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (params.computeUnitPrice !== undefined) {
    const microLamports = BigInt(params.computeUnitPrice);
    if (microLamports < 0n || microLamports >= 1n << 64n) {
      throw new LochError("INVALID_ARGUMENT", "computeUnitPrice must fit in an unsigned 64-bit integer");
    }
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  if (params.loadedAccountsDataSizeLimit !== undefined) {
    const bytes = params.loadedAccountsDataSizeLimit;
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 0xffff_ffff) {
      throw new LochError("INVALID_ARGUMENT", "loadedAccountsDataSizeLimit must be a positive 32-bit integer");
    }
    instructions.push(setLoadedAccountsDataSizeLimit(bytes));
  }
  instructions.push(params.instruction);

  let transaction: VersionedTransaction;
  try {
    const message = new TransactionMessage({
      payerKey: params.payer,
      recentBlockhash: params.recentBlockhash,
      instructions,
    }).compileToV0Message(params.lookupTable ? [params.lookupTable] : []);
    transaction = new VersionedTransaction(message);
  } catch (cause) {
    throw new LochError("INVALID_ARGUMENT", "the transaction message could not be compiled", { cause });
  }
  let size: number;
  try {
    size = transaction.serialize().length;
  } catch (cause) {
    // web3.js serialises into a fixed packet-sized buffer and throws when it overflows.
    throw new LochError("TRANSACTION_TOO_LARGE", `the transaction exceeds ${MAX_TRANSACTION_SIZE} bytes`, { cause });
  }
  if (size > MAX_TRANSACTION_SIZE) {
    throw new LochError("TRANSACTION_TOO_LARGE", `the transaction is ${size} bytes; the limit is ${MAX_TRANSACTION_SIZE}`);
  }
  return transaction;
}

/** Compute budget instruction 4, SetLoadedAccountsDataSizeLimit(u32 bytes): web3.js 1.x has no helper for it. */
export function setLoadedAccountsDataSizeLimit(bytes: number): TransactionInstruction {
  const data = new Uint8Array(5);
  data[0] = 4;
  new DataView(data.buffer).setUint32(1, bytes, true);
  return new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: toWeb3Buffer(data) });
}
