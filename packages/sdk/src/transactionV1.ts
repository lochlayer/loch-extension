// Version 1 transactions (SIMD-0385). web3.js 1.99 reads them but cannot write them
// (`MessageV1.serialize` throws), so every v1 byte string is read here, never by web3.js:
// a message web3.js parsed could not be signed, checked or sent again.
//
// A v1 transaction has no address lookup tables, carries its compute budget in the message
// itself (a config mask and values, not ComputeBudget instructions) and may be 4,096 bytes
// long. Its signatures come last and cover every byte before them:
//
//   129 | header (3 x u8) | config mask (u32 LE) | lifetime (32) | instruction count (u8)
//   | address count (u8) | addresses (32 each) | config values (4 bytes per mask bit)
//   | per instruction: program index (u8), account count (u8), data length (u16 LE)
//   | per instruction: account indexes, then data | signatures (64 each)
//
// `TransactionV1` has the members of `VersionedTransaction` that the deposit code uses
// (`message`, `signatures`, `serialize`, `sign`), and `MessageV1` those of web3.js's own
// v1 message (`transactionConfig` included), so most code takes either.

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import {
  type MessageCompiledInstruction,
  type MessageHeader,
  PublicKey,
  type Signer,
  type TransactionConfig,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { DEFAULT_COMPUTE_UNIT_LIMIT } from "./constants.js";
import { LochError } from "./errors.js";

/** The first byte of a v1 transaction. No earlier format starts with it. */
export const TRANSACTION_V1_VERSION_BYTE = 129;
/** Largest v1 transaction, in bytes (SIMD-0296). */
export const MAX_TRANSACTION_V1_SIZE = 4096;
const MAX_ADDRESSES = 64;
const MAX_INSTRUCTIONS = 64;
const MAX_SIGNATURES = 12;

const FEE_BITS = 0b11;
const COMPUTE_UNIT_LIMIT_BIT = 1 << 2;
const LOADED_ACCOUNTS_DATA_SIZE_BIT = 1 << 3;
const HEAP_SIZE_BIT = 1 << 4;
const KNOWN_BITS = FEE_BITS | COMPUTE_UNIT_LIMIT_BIT | LOADED_ACCOUNTS_DATA_SIZE_BIT | HEAP_SIZE_BIT;

/** No resource request: the runtime's minimum for each (SIMD-0385). */
const NO_CONFIG: TransactionConfig = { computeUnitLimit: null, heapSize: null, loadedAccountsDataSizeLimit: null, priorityFee: null };

/** A v1 message. */
export class MessageV1 {
  readonly header: MessageHeader;
  /** The resource requests; `priorityFee` is the total in lamports, not a price per unit. */
  readonly transactionConfig: Readonly<TransactionConfig>;
  readonly recentBlockhash: string;
  readonly staticAccountKeys: PublicKey[];
  readonly compiledInstructions: MessageCompiledInstruction[];

  constructor(fields: {
    header: MessageHeader;
    transactionConfig?: Partial<TransactionConfig>;
    recentBlockhash: string;
    staticAccountKeys: PublicKey[];
    compiledInstructions: MessageCompiledInstruction[];
  }) {
    this.header = { ...fields.header };
    this.transactionConfig = { ...NO_CONFIG, ...fields.transactionConfig };
    this.recentBlockhash = fields.recentBlockhash;
    this.staticAccountKeys = [...fields.staticAccountKeys];
    this.compiledInstructions = fields.compiledInstructions.map((instruction) => ({
      programIdIndex: instruction.programIdIndex,
      accountKeyIndexes: [...instruction.accountKeyIndexes],
      data: Uint8Array.from(instruction.data),
    }));
  }

  get version(): 1 {
    return 1;
  }

  /** A v1 message loads no account from a lookup table. */
  get addressTableLookups(): [] {
    return [];
  }

  /** The accounts by the index the instructions use: the static keys, the only segment there is. */
  getAccountKeys(_options?: unknown): { keySegments(): PublicKey[][] } {
    const keys = [...this.staticAccountKeys];
    return { keySegments: () => [keys] };
  }

  isAccountSigner(index: number): boolean {
    return index < this.header.numRequiredSignatures;
  }

  isAccountWritable(index: number): boolean {
    const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = this.header;
    if (index < numRequiredSignatures) return index < numRequiredSignatures - numReadonlySignedAccounts;
    return index < this.staticAccountKeys.length - numReadonlyUnsignedAccounts;
  }

  /** The bytes every signature covers: the transaction up to its signatures. */
  serialize(): Uint8Array {
    const { header, transactionConfig: config } = this;
    let mask = 0;
    const values: Uint8Array[] = [];
    if (config.priorityFee !== null) {
      mask |= FEE_BITS;
      values.push(u64(config.priorityFee));
    }
    if (config.computeUnitLimit !== null) {
      mask |= COMPUTE_UNIT_LIMIT_BIT;
      values.push(u32(config.computeUnitLimit));
    }
    if (config.loadedAccountsDataSizeLimit !== null) {
      mask |= LOADED_ACCOUNTS_DATA_SIZE_BIT;
      values.push(u32(config.loadedAccountsDataSizeLimit));
    }
    if (config.heapSize !== null) {
      mask |= HEAP_SIZE_BIT;
      values.push(u32(config.heapSize));
    }
    const parts: Uint8Array[] = [
      Uint8Array.of(TRANSACTION_V1_VERSION_BYTE, header.numRequiredSignatures, header.numReadonlySignedAccounts, header.numReadonlyUnsignedAccounts),
      u32(mask),
      base58.decode(this.recentBlockhash),
      Uint8Array.of(this.compiledInstructions.length, this.staticAccountKeys.length),
      ...this.staticAccountKeys.map((key) => key.toBytes()),
      ...values,
    ];
    for (const instruction of this.compiledInstructions) {
      parts.push(Uint8Array.of(instruction.programIdIndex, instruction.accountKeyIndexes.length), u16(instruction.data.length));
    }
    for (const instruction of this.compiledInstructions) parts.push(Uint8Array.from(instruction.accountKeyIndexes), instruction.data);
    return concat(parts);
  }

  /**
   * Reads one message from the start of `bytes` and says where it ends. Strict: every rule of
   * SIMD-0385 that the bytes alone decide is checked, and an unknown config bit is refused.
   *
   * @throws LochError `INVALID_ARGUMENT` with what is wrong.
   */
  static deserialize(bytes: Uint8Array): { message: MessageV1; length: number } {
    const reader = new Reader(bytes);
    if (reader.u8() !== TRANSACTION_V1_VERSION_BYTE) throw invalid("not a version 1 transaction");
    const header: MessageHeader = { numRequiredSignatures: reader.u8(), numReadonlySignedAccounts: reader.u8(), numReadonlyUnsignedAccounts: reader.u8() };
    const mask = reader.u32();
    if ((mask & ~KNOWN_BITS) !== 0) throw invalid("the config mask has a bit SIMD-0385 does not define");
    if ((mask & FEE_BITS) !== 0 && (mask & FEE_BITS) !== FEE_BITS) throw invalid("the priority fee takes both of its config bits");
    const recentBlockhash = base58.encode(reader.bytes(32));
    const instructionCount = reader.u8();
    const addressCount = reader.u8();
    if (header.numRequiredSignatures < 1 || header.numRequiredSignatures > MAX_SIGNATURES) throw invalid("the signer count is out of range");
    if (header.numReadonlySignedAccounts >= header.numRequiredSignatures) throw invalid("the fee payer would be read-only");
    if (addressCount > MAX_ADDRESSES || instructionCount > MAX_INSTRUCTIONS) throw invalid("too many addresses or instructions");
    if (addressCount < header.numRequiredSignatures + header.numReadonlyUnsignedAccounts) throw invalid("the message header does not fit its account list");
    const staticAccountKeys = Array.from({ length: addressCount }, () => new PublicKey(reader.bytes(32)));
    const config: TransactionConfig = { ...NO_CONFIG };
    if (mask & FEE_BITS) {
      const fee = reader.u64();
      if (fee > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("the priority fee is larger than this reader handles");
      config.priorityFee = Number(fee);
    }
    if (mask & COMPUTE_UNIT_LIMIT_BIT) config.computeUnitLimit = reader.u32();
    if (mask & LOADED_ACCOUNTS_DATA_SIZE_BIT) config.loadedAccountsDataSizeLimit = reader.u32();
    if (mask & HEAP_SIZE_BIT) {
      const heap = reader.u32();
      if (heap % 1024 !== 0 || heap < 32 * 1024 || heap > 256 * 1024) throw invalid("the requested heap size is out of range");
      config.heapSize = heap;
    }
    const headers = Array.from({ length: instructionCount }, () => ({ programIdIndex: reader.u8(), accounts: reader.u8(), data: reader.u16() }));
    const compiledInstructions = headers.map((entry) => {
      if (entry.programIdIndex >= addressCount) throw invalid("an instruction names a program that is not in the account list");
      const accountKeyIndexes = Array.from(reader.bytes(entry.accounts));
      if (accountKeyIndexes.some((index) => index >= addressCount)) throw invalid("an instruction names an account that is not in the account list");
      return { programIdIndex: entry.programIdIndex, accountKeyIndexes, data: Uint8Array.from(reader.bytes(entry.data)) };
    });
    return { message: new MessageV1({ header, transactionConfig: config, recentBlockhash, staticAccountKeys, compiledInstructions }), length: reader.offset };
  }
}

/** A v1 transaction: a message and one signature slot per required signer. */
export class TransactionV1 {
  readonly message: MessageV1;
  signatures: Uint8Array[];

  constructor(message: MessageV1, signatures?: Uint8Array[]) {
    this.message = message;
    this.signatures = signatures ?? Array.from({ length: message.header.numRequiredSignatures }, () => new Uint8Array(64));
    if (this.signatures.length !== message.header.numRequiredSignatures || this.signatures.some((signature) => signature.length !== 64)) {
      throw invalid("one 64-byte signature per required signer");
    }
  }

  /** @throws LochError `TRANSACTION_TOO_LARGE` over 4,096 bytes. */
  serialize(): Uint8Array {
    const bytes = concat([this.message.serialize(), ...this.signatures]);
    if (bytes.length > MAX_TRANSACTION_V1_SIZE) {
      throw new LochError("TRANSACTION_TOO_LARGE", `the transaction is ${bytes.length} bytes; the limit is ${MAX_TRANSACTION_V1_SIZE}`);
    }
    return bytes;
  }

  /** Signs the message with each signer, into the slot of its key among the required signers. */
  sign(signers: Signer[]): void {
    const message = this.message.serialize();
    const required = this.message.staticAccountKeys.slice(0, this.message.header.numRequiredSignatures);
    for (const signer of signers) {
      const index = required.findIndex((key) => key.equals(signer.publicKey));
      if (index < 0) throw new LochError("INVALID_ARGUMENT", `${signer.publicKey.toBase58()} is not a required signer of this transaction`);
      this.signatures[index] = ed25519.sign(message, signer.secretKey.subarray(0, 32));
    }
  }

  /**
   * Reads exactly one v1 transaction: bytes after its signatures are refused.
   *
   * @throws LochError `INVALID_ARGUMENT` with what is wrong.
   */
  static deserialize(bytes: Uint8Array): TransactionV1 {
    if (bytes.length > MAX_TRANSACTION_V1_SIZE) throw invalid(`longer than ${MAX_TRANSACTION_V1_SIZE} bytes`);
    const { message, length } = MessageV1.deserialize(bytes);
    const count = message.header.numRequiredSignatures;
    if (bytes.length < length + 64 * count) throw invalid("the signatures are cut short");
    if (bytes.length > length + 64 * count) throw invalid("bytes follow the signatures");
    const signatures = Array.from({ length: count }, (_, index) => Uint8Array.from(bytes.subarray(length + 64 * index, length + 64 * (index + 1))));
    return new TransactionV1(message, signatures);
  }
}

/** A transaction in any format a deposit may take. A `VersionedTransaction` here is legacy or v0. */
export type AnyTransaction = VersionedTransaction | TransactionV1;

/**
 * Reads a transaction of any version: v1 by its first byte (here), the others with web3.js.
 *
 * @throws on bytes that are not a transaction.
 */
export function deserializeTransaction(bytes: Uint8Array): AnyTransaction {
  return bytes[0] === TRANSACTION_V1_VERSION_BYTE ? TransactionV1.deserialize(bytes) : VersionedTransaction.deserialize(bytes);
}

/** Parameters of {@link buildTransactionV1}. */
export interface BuildTransactionV1Params {
  instructions: TransactionInstruction[];
  /** Fee payer and first signer. */
  payer: PublicKey;
  recentBlockhash: string;
  /** Default {@link DEFAULT_COMPUTE_UNIT_LIMIT}. */
  computeUnitLimit?: number;
  /** Omitted: none is requested, which v1 reads as the smallest limit (SIMD-0385). */
  loadedAccountsDataSizeLimit?: number;
  /** Total priority fee in lamports. Omitted: none. */
  priorityFeeLamports?: number;
}

/**
 * Compiles instructions into an unsigned v1 transaction. The accounts are ordered as for any
 * other version (web3.js compiles them); the compute budget goes into the message's config, so
 * pass no ComputeBudget instructions (a v1 transaction runs them as no-ops).
 *
 * @throws LochError `TRANSACTION_TOO_LARGE` over 4,096 bytes, `INVALID_ARGUMENT` for a bad value.
 */
export function buildTransactionV1(params: BuildTransactionV1Params): TransactionV1 {
  const computeUnitLimit = params.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  if (!Number.isInteger(computeUnitLimit) || computeUnitLimit <= 0 || computeUnitLimit > 1_400_000) {
    throw new LochError("INVALID_ARGUMENT", "computeUnitLimit must be an integer from 1 to 1,400,000");
  }
  const loaded = params.loadedAccountsDataSizeLimit ?? null;
  if (loaded !== null && (!Number.isInteger(loaded) || loaded <= 0 || loaded > 0xffff_ffff)) {
    throw new LochError("INVALID_ARGUMENT", "loadedAccountsDataSizeLimit must be a positive 32-bit integer");
  }
  const fee = params.priorityFeeLamports ?? null;
  if (fee !== null && (!Number.isSafeInteger(fee) || fee < 0)) throw new LochError("INVALID_ARGUMENT", "priorityFeeLamports must be a non-negative safe integer");
  let blockhashBytes = 0;
  try {
    blockhashBytes = base58.decode(params.recentBlockhash).length;
  } catch {
    blockhashBytes = 0;
  }
  if (blockhashBytes !== 32) throw new LochError("INVALID_ARGUMENT", "recentBlockhash must be a base58 blockhash");
  let compiled;
  try {
    compiled = new TransactionMessage({ payerKey: params.payer, recentBlockhash: params.recentBlockhash, instructions: params.instructions }).compileToV0Message([]);
  } catch (cause) {
    throw new LochError("INVALID_ARGUMENT", "the transaction message could not be compiled", { cause });
  }
  if (compiled.staticAccountKeys.length > MAX_ADDRESSES || compiled.compiledInstructions.length > MAX_INSTRUCTIONS) {
    throw new LochError("INVALID_ARGUMENT", "too many accounts or instructions for one transaction");
  }
  const transaction = new TransactionV1(
    new MessageV1({
      header: compiled.header,
      transactionConfig: { computeUnitLimit, loadedAccountsDataSizeLimit: loaded, priorityFee: fee },
      recentBlockhash: params.recentBlockhash,
      staticAccountKeys: compiled.staticAccountKeys,
      compiledInstructions: compiled.compiledInstructions,
    }),
  );
  transaction.serialize(); // throws TRANSACTION_TOO_LARGE
  return transaction;
}

function invalid(why: string): LochError {
  return new LochError("INVALID_ARGUMENT", `not a well-formed version 1 transaction: ${why}`);
}

class Reader {
  offset = 0;
  constructor(private readonly data: Uint8Array) {}
  bytes(length: number): Uint8Array {
    if (this.offset + length > this.data.length) throw invalid("it ends too early");
    const out = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  u8(): number {
    return this.bytes(1)[0]!;
  }
  u16(): number {
    const b = this.bytes(2);
    return b[0]! | (b[1]! << 8);
  }
  u32(): number {
    const b = this.bytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }
  u64(): bigint {
    const b = this.bytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }
}

function u16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new LochError("INVALID_ARGUMENT", "a length does not fit in 16 bits");
  return Uint8Array.of(value & 0xff, value >> 8);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
