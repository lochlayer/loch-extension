// Byte-exact encodings of the v2 instructions and event (docs/v2.md sections 7
// and 8), shared with programs/loch_pool/src/v2.rs.

import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";

import { ByteReader, bigIntToBytesLE, bytesToBigIntBE, concatBytes, equalBytes, utf8 } from "../bytes.js";
import type { ProofBytes } from "../codec.js";
import { FIELD_MODULUS, MAX_AMOUNT } from "../constants.js";
import { LochError } from "../errors.js";
import { mod } from "../field.js";
import { ENCRYPTED_NOTE_V2_LENGTH, EVENT_IX_TAG } from "./constants.js";

/** Anchor's 8-byte discriminator: `sha256("<namespace>:<name>")[0..8]`. */
export function anchorDiscriminator(namespace: "global" | "event" | "account", name: string): Uint8Array {
  return sha256(utf8(`${namespace}:${name}`)).subarray(0, 8);
}

export const TRANSACT_V2_DISCRIMINATOR = anchorDiscriminator("global", "transact_v2");
export const SWAP_V2_DISCRIMINATOR = anchorDiscriminator("global", "swap_v2");
export const INITIALIZE_V2_DISCRIMINATOR = anchorDiscriminator("global", "initialize_v2");
export const REGISTER_ASSET_DISCRIMINATOR = anchorDiscriminator("global", "register_asset");
export const UPDATE_ASSET_DISCRIMINATOR = anchorDiscriminator("global", "update_asset");
export const UPDATE_CONFIG_V2_DISCRIMINATOR = anchorDiscriminator("global", "update_config_v2");
export const TRANSACT_V2_EVENT_DISCRIMINATOR = anchorDiscriminator("event", "TransactV2");
export const CONFIG_V2_ACCOUNT_DISCRIMINATOR = anchorDiscriminator("account", "PoolConfigV2");
export const ASSET_ACCOUNT_DISCRIMINATOR = anchorDiscriminator("account", "AssetConfig");
export const TREE_V2_ACCOUNT_DISCRIMINATOR = anchorDiscriminator("account", "MerkleTreeV2");

/** The swap part of the ext data. */
export interface SwapExt {
  outputMint: PublicKey;
  /** u64, base units of the output asset. Bound by the proof. */
  minAmountOut: bigint;
  /** `Poseidon(owner, blinding)` of the output note, a canonical field element. */
  inner: bigint;
  /** Empty or 103 bytes. */
  encryptedOutput: Uint8Array;
}

/** The program's `ExtDataV2`. */
export interface ExtDataV2 {
  /** Withdrawal destination; all zero (the default public key) otherwise. */
  recipient: PublicKey;
  /** i64: positive deposit, negative withdrawal or swap input, zero private transfer. */
  extAmount: bigint;
  /** The mint moved; the default public key exactly when `extAmount` is 0. */
  asset: PublicKey;
  /** Three encrypted outputs, each empty or 103 bytes. */
  encryptedOutputs: [Uint8Array, Uint8Array, Uint8Array];
  swap: SwapExt | null;
}

/** The program's `TransactArgsV2`. */
export interface TransactArgsV2 {
  proof: ProofBytes;
  root: Uint8Array;
  inputNullifiers: [Uint8Array, Uint8Array];
  outputCommitments: [Uint8Array, Uint8Array, Uint8Array];
  extData: ExtDataV2;
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function checkOutput(output: Uint8Array, what: string): void {
  if (!(output instanceof Uint8Array) || (output.length !== 0 && output.length !== ENCRYPTED_NOTE_V2_LENGTH)) {
    throw new LochError("INVALID_ARGUMENT", `${what} must be empty or ${ENCRYPTED_NOTE_V2_LENGTH} bytes`);
  }
}

function checkExtData(ext: ExtDataV2): void {
  if (typeof ext.extAmount !== "bigint" || ext.extAmount < I64_MIN || ext.extAmount > I64_MAX) {
    throw new LochError("INVALID_ARGUMENT", "extAmount must fit in a signed 64-bit integer");
  }
  if (ext.encryptedOutputs.length !== 3) throw new LochError("INVALID_ARGUMENT", "a v2 transaction has three encrypted outputs");
  ext.encryptedOutputs.forEach((output, i) => checkOutput(output, `encrypted output ${i}`));
  if (ext.swap) {
    const { minAmountOut, inner, encryptedOutput } = ext.swap;
    if (typeof minAmountOut !== "bigint" || minAmountOut < 0n || minAmountOut > MAX_AMOUNT) {
      throw new LochError("INVALID_ARGUMENT", "minAmountOut must fit in an unsigned 64-bit integer");
    }
    if (typeof inner !== "bigint" || inner < 0n || inner >= FIELD_MODULUS) throw new LochError("INVALID_ARGUMENT", "inner is not a field element");
    checkOutput(encryptedOutput, "the swap's encrypted output");
  }
}

const vec = (bytes: Uint8Array) => concatBytes(bigIntToBytesLE(BigInt(bytes.length), 4), bytes);

/**
 * Borsh of `ExtDataV2`: recipient (32), ext_amount (i64 LE), asset (32), three
 * encrypted outputs (u32 LE length, bytes), swap (u8 0 | 1, then output_mint
 * (32), min_amount_out (u64 LE), inner (32 BE), encrypted_output (u32 LE, bytes)).
 */
export function encodeExtDataV2(ext: ExtDataV2): Uint8Array {
  checkExtData(ext);
  const parts = [ext.recipient.toBytes(), bigIntToBytesLE(BigInt.asUintN(64, ext.extAmount), 8), ext.asset.toBytes(), ...ext.encryptedOutputs.map(vec)];
  if (ext.swap) {
    const { outputMint, minAmountOut, inner, encryptedOutput } = ext.swap;
    parts.push(Uint8Array.of(1), outputMint.toBytes(), bigIntToBytesLE(minAmountOut, 8), fieldBytes(inner), vec(encryptedOutput));
  } else {
    parts.push(Uint8Array.of(0));
  }
  return concatBytes(...parts);
}

function fieldBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** `sha256(borsh(ExtDataV2))` with byte 0 cleared, read big-endian. */
export function extDataHashV2(ext: ExtDataV2): bigint {
  const digest = sha256(encodeExtDataV2(ext));
  digest[0] = 0;
  return bytesToBigIntBE(digest);
}

function word32(bytes: Uint8Array, name: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new LochError("INVALID_ARGUMENT", `${name} must be 32 bytes`);
  return bytes;
}

/** Borsh of `TransactArgsV2` without a discriminator: what a client sends a relayer (`/v2/relay`). */
export function encodeTransactArgsV2(args: TransactArgsV2): Uint8Array {
  const { proof } = args;
  if (proof.a.length !== 64 || proof.b.length !== 128 || proof.c.length !== 64) {
    throw new LochError("INVALID_ARGUMENT", "proof parts must be 64, 128 and 64 bytes");
  }
  if (args.inputNullifiers.length !== 2 || args.outputCommitments.length !== 3) {
    throw new LochError("INVALID_ARGUMENT", "expected two nullifiers and three commitments");
  }
  return concatBytes(
    proof.a,
    proof.b,
    proof.c,
    word32(args.root, "root"),
    ...args.inputNullifiers.map((n, i) => word32(n, `inputNullifiers[${i}]`)),
    ...args.outputCommitments.map((c, i) => word32(c, `outputCommitments[${i}]`)),
    encodeExtDataV2(args.extData),
  );
}

/** Instruction data of `transact_v2`. */
export function encodeTransactV2Data(args: TransactArgsV2): Uint8Array {
  if (args.extData.swap) throw new LochError("INVALID_ARGUMENT", "transact_v2 carries no swap; use swap_v2");
  return concatBytes(TRANSACT_V2_DISCRIMINATOR, encodeTransactArgsV2(args));
}

/** Instruction data of `swap_v2`: the arguments, then the router's instruction data as a Borsh `Vec<u8>`. */
export function encodeSwapV2Data(args: TransactArgsV2, route: Uint8Array): Uint8Array {
  if (!args.extData.swap) throw new LochError("INVALID_ARGUMENT", "swap_v2 needs the swap part of the ext data");
  return concatBytes(SWAP_V2_DISCRIMINATOR, encodeTransactArgsV2(args), vec(route));
}

function readArgs(reader: ByteReader): TransactArgsV2 {
  const proof = { a: reader.take(64), b: reader.take(128), c: reader.take(64) };
  const root = reader.take(32);
  const inputNullifiers: [Uint8Array, Uint8Array] = [reader.take(32), reader.take(32)];
  const outputCommitments: [Uint8Array, Uint8Array, Uint8Array] = [reader.take(32), reader.take(32), reader.take(32)];
  const recipient = new PublicKey(reader.take(32));
  const extAmount = reader.i64();
  const asset = new PublicKey(reader.take(32));
  const encryptedOutputs: [Uint8Array, Uint8Array, Uint8Array] = [
    reader.vec(ENCRYPTED_NOTE_V2_LENGTH),
    reader.vec(ENCRYPTED_NOTE_V2_LENGTH),
    reader.vec(ENCRYPTED_NOTE_V2_LENGTH),
  ];
  const tag = reader.u8();
  let swap: SwapExt | null = null;
  if (tag === 1) {
    swap = {
      outputMint: new PublicKey(reader.take(32)),
      minAmountOut: reader.u64(),
      inner: bytesToBigIntBE(reader.take(32)),
      encryptedOutput: reader.vec(ENCRYPTED_NOTE_V2_LENGTH),
    };
  } else if (tag !== 0) {
    throw new RangeError("invalid Option tag");
  }
  return { proof, root, inputNullifiers, outputCommitments, extData: { recipient, extAmount, asset, encryptedOutputs, swap } };
}

/**
 * Inverse of {@link encodeTransactArgsV2}, strict: no trailing bytes.
 *
 * @throws LochError `DECODE_FAILED`.
 */
export function decodeTransactArgsV2(bytes: Uint8Array): TransactArgsV2 {
  try {
    const reader = new ByteReader(bytes);
    const args = readArgs(reader);
    if (reader.remaining !== 0) throw new RangeError("unexpected bytes after the arguments");
    return args;
  } catch (cause) {
    throw new LochError("DECODE_FAILED", "malformed TransactArgsV2", { cause });
  }
}

/** A decoded v2 instruction: which one, its arguments and (for a swap) the route. */
export type DecodedV2Instruction = { kind: "transact"; args: TransactArgsV2 } | { kind: "swap"; args: TransactArgsV2; route: Uint8Array };

/** True when `data` starts with the discriminator of `transact_v2` or `swap_v2`. */
export function isV2Data(data: Uint8Array): boolean {
  return data.length >= 8 && (equalBytes(data.subarray(0, 8), TRANSACT_V2_DISCRIMINATOR) || equalBytes(data.subarray(0, 8), SWAP_V2_DISCRIMINATOR));
}

/**
 * Decodes the data of a `transact_v2` or `swap_v2` instruction. Strict by
 * default (no trailing bytes); `allowTrailingBytes` for data that already ran.
 *
 * @throws LochError `DECODE_FAILED`.
 */
export function decodeV2Data(data: Uint8Array, options: { allowTrailingBytes?: boolean } = {}): DecodedV2Instruction {
  if (!isV2Data(data)) throw new LochError("DECODE_FAILED", "not a loch_pool v2 instruction");
  try {
    const reader = new ByteReader(data.subarray(8));
    const args = readArgs(reader);
    const isSwap = equalBytes(data.subarray(0, 8), SWAP_V2_DISCRIMINATOR);
    const route = isSwap ? reader.vec(4096) : null;
    if (reader.remaining !== 0 && !options.allowTrailingBytes) throw new RangeError("unexpected bytes after the arguments");
    if (isSwap !== (args.extData.swap !== null)) throw new RangeError("the swap part does not match the instruction");
    return isSwap ? { kind: "swap", args, route: route! } : { kind: "transact", args };
  } catch (cause) {
    throw new LochError("DECODE_FAILED", "malformed loch_pool v2 instruction data", { cause });
  }
}

/** `publicAmount = ext_amount mod r`. */
export function publicAmountV2(extAmount: bigint): bigint {
  return mod(extAmount);
}

/**
 * The nine public inputs the program rebuilds, in circuit order. `publicAsset`
 * is `assetId(asset)` for a deposit, withdrawal or swap and 0 for a transfer;
 * it is passed in because computing it needs the asset id function.
 */
export function transactPublicInputsV2(args: TransactArgsV2, publicAsset: bigint): bigint[] {
  return [
    bytesToBigIntBE(word32(args.root, "root")),
    publicAmountV2(args.extData.extAmount),
    publicAsset,
    extDataHashV2(args.extData),
    ...args.inputNullifiers.map((n) => bytesToBigIntBE(n)),
    ...args.outputCommitments.map((c) => bytesToBigIntBE(c)),
  ];
}

/** What a swap did, as the event tells it. */
export interface SwapOutcome {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: bigint;
  amountOut: bigint;
  encryptedOutput: Uint8Array;
}

/** The `TransactV2` event. */
export interface TransactV2Event {
  /** Leaf index of output 0; the transaction's leaves are `firstIndex` to `firstIndex + 3`. */
  firstIndex: number;
  /** Outputs 0 to 2, then the swap leaf or zero. */
  commitments: [bigint, bigint, bigint, bigint];
  encryptedOutputs: [Uint8Array, Uint8Array, Uint8Array];
  nullifiers: [bigint, bigint];
  swap: SwapOutcome | null;
}

/**
 * Decodes the data of an event-CPI instruction carrying `TransactV2`
 * (`EVENT_IX_TAG || discriminator || borsh(event)`), or null when the data is
 * anything else. Throws only on a `TransactV2` that is malformed.
 */
export function decodeTransactV2Event(data: Uint8Array): TransactV2Event | null {
  if (data.length < 16 || !equalBytes(data.subarray(0, 8), EVENT_IX_TAG) || !equalBytes(data.subarray(8, 16), TRANSACT_V2_EVENT_DISCRIMINATOR)) {
    return null;
  }
  try {
    const reader = new ByteReader(data.subarray(16));
    const firstIndex = reader.u64();
    if (firstIndex > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("leaf index out of range");
    const commitments = [0, 1, 2, 3].map(() => bytesToBigIntBE(reader.take(32))) as TransactV2Event["commitments"];
    const encryptedOutputs = [0, 1, 2].map(() => reader.vec(ENCRYPTED_NOTE_V2_LENGTH)) as TransactV2Event["encryptedOutputs"];
    const nullifiers = [bytesToBigIntBE(reader.take(32)), bytesToBigIntBE(reader.take(32))] as [bigint, bigint];
    const tag = reader.u8();
    let swap: SwapOutcome | null = null;
    if (tag === 1) {
      swap = {
        inputMint: new PublicKey(reader.take(32)),
        outputMint: new PublicKey(reader.take(32)),
        amountIn: reader.u64(),
        amountOut: reader.u64(),
        encryptedOutput: reader.vec(ENCRYPTED_NOTE_V2_LENGTH),
      };
    } else if (tag !== 0) {
      throw new RangeError("invalid Option tag");
    }
    if (reader.remaining !== 0) throw new RangeError("unexpected bytes after the event");
    return { firstIndex: Number(firstIndex), commitments, encryptedOutputs, nullifiers, swap };
  } catch (cause) {
    throw new LochError("DECODE_FAILED", "malformed TransactV2 event", { cause });
  }
}
