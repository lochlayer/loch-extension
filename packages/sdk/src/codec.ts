// Byte-exact encodings shared with programs/loch_pool: Groth16 proof points,
// ExtData (Borsh), its hash, and the `transact` instruction data.

import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";

import { ByteReader, bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntBE, concatBytes, equalBytes } from "./bytes.js";
import { BASE_FIELD_MODULUS, MAX_AMOUNT, MAX_ENCRYPTED_OUTPUT_LENGTH, TRANSACT_DISCRIMINATOR } from "./constants.js";
import { LochError } from "./errors.js";
import { mod, publicAmountField } from "./field.js";

/** A Groth16 proof as snarkjs produces it (decimal strings, projective with z = 1). */
export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

/** The program's `Proof` struct: field elements are 32 bytes big-endian. */
export interface ProofBytes {
  /** 64 bytes: `x || (q - y)`. A is negated. */
  a: Uint8Array;
  /** 128 bytes: `x.c1 || x.c0 || y.c1 || y.c0`. */
  b: Uint8Array;
  /** 64 bytes: `x || y`. */
  c: Uint8Array;
}

/** The program's `ExtData`: everything outside the proof that the proof is bound to. */
export interface ExtData {
  /** Receives lamports on a withdrawal. Must equal the `recipient` account. */
  recipient: PublicKey;
  /** Receives the fee. Must equal the `relayer` account. */
  relayer: PublicKey;
  /** i64: positive deposit, negative withdrawal, zero private transfer. */
  extAmount: bigint;
  /** u64 lamports paid from the vault to the relayer. */
  fee: bigint;
  /** Encrypted note for output 0, at most 256 bytes. */
  encryptedOutput0: Uint8Array;
  /** Encrypted note for output 1, at most 256 bytes. */
  encryptedOutput1: Uint8Array;
}

/** The program's `TransactArgs`. Field elements are 32 bytes big-endian. */
export interface TransactArgs {
  proof: ProofBytes;
  /** Merkle root the inputs were proven against. */
  root: Uint8Array;
  inputNullifiers: [Uint8Array, Uint8Array];
  outputCommitments: [Uint8Array, Uint8Array];
  extData: ExtData;
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function coordinate(decimal: string | undefined): bigint {
  if (typeof decimal !== "string" || !/^(0|[1-9][0-9]*)$/.test(decimal)) {
    throw new LochError("INVALID_ARGUMENT", "a proof coordinate must be a decimal string");
  }
  const v = BigInt(decimal);
  if (v >= BASE_FIELD_MODULUS) throw new LochError("INVALID_ARGUMENT", "a proof coordinate is not below the base field modulus");
  return v;
}

/**
 * snarkjs proof to the bytes `loch_pool::transact` expects:
 *
 *   a = BE32(pi_a[0]) || BE32(q - pi_a[1])                      (A negated, modulus q)
 *   b = BE32(pi_b[0][1]) || BE32(pi_b[0][0]) || BE32(pi_b[1][1]) || BE32(pi_b[1][0])
 *   c = BE32(pi_c[0]) || BE32(pi_c[1])
 *
 * @throws LochError `INVALID_ARGUMENT` if this is not a Groth16 proof on bn128.
 */
export function encodeProof(proof: Groth16Proof): ProofBytes {
  if (proof?.protocol !== "groth16" || proof.curve !== "bn128") {
    throw new LochError("INVALID_ARGUMENT", "expected a groth16 proof on bn128");
  }
  const be = (v: bigint) => bigIntToBytesBE(v, 32);
  const [ax, ay] = proof.pi_a;
  const [bx, by] = proof.pi_b;
  const [cx, cy] = proof.pi_c;
  return {
    a: concatBytes(be(coordinate(ax)), be(mod(-coordinate(ay), BASE_FIELD_MODULUS))),
    b: concatBytes(be(coordinate(bx?.[1])), be(coordinate(bx?.[0])), be(coordinate(by?.[1])), be(coordinate(by?.[0]))),
    c: concatBytes(be(coordinate(cx)), be(coordinate(cy))),
  };
}

/**
 * What is wrong with the encoding of a proof, or null when the program's
 * verifier would get as far as the pairing check with it: the three parts
 * have the right lengths, none is all zero bytes (`ZeroProofElement`), and
 * each of the eight coordinates is below the base field modulus q.
 *
 * The last rule matters off chain. The alt_bn128 syscalls refuse a coordinate
 * of q or more, while snarkjs reduces it mod q, so `x + q` in place of `x`
 * turns a valid proof into one that verifies off chain and fails on chain.
 */
export function proofEncodingProblem(bytes: ProofBytes): string | null {
  const parts: [string, Uint8Array, number][] = [
    ["proof.a", bytes?.a, 64],
    ["proof.b", bytes?.b, 128],
    ["proof.c", bytes?.c, 64],
  ];
  for (const [name, part, length] of parts) {
    if (!(part instanceof Uint8Array) || part.length !== length) return `${name} must be ${length} bytes`;
    if (part.every((byte) => byte === 0)) return `${name} is all zero bytes`;
    for (let offset = 0; offset < length; offset += 32) {
      if (bytesToBigIntBE(part.subarray(offset, offset + 32)) >= BASE_FIELD_MODULUS) {
        return `${name} has a coordinate that is not below the base field modulus`;
      }
    }
  }
  return null;
}

/**
 * Inverse of {@link encodeProof}: program bytes to a snarkjs proof (A negated
 * back). Strict in the same way the program is: see {@link proofEncodingProblem}.
 *
 * @throws LochError `INVALID_ARGUMENT` if a part has the wrong length, is all
 *   zero, or has a coordinate that is not below q.
 */
export function decodeProof(bytes: ProofBytes): Groth16Proof {
  const problem = proofEncodingProblem(bytes);
  if (problem) throw new LochError("INVALID_ARGUMENT", problem);
  const word = (part: Uint8Array, i: number) => bytesToBigIntBE(part.subarray(i * 32, i * 32 + 32));
  const s = (v: bigint) => v.toString();
  return {
    pi_a: [s(word(bytes.a, 0)), s(mod(-word(bytes.a, 1), BASE_FIELD_MODULUS)), "1"],
    pi_b: [
      [s(word(bytes.b, 1)), s(word(bytes.b, 0))],
      [s(word(bytes.b, 3)), s(word(bytes.b, 2))],
      ["1", "0"],
    ],
    pi_c: [s(word(bytes.c, 0)), s(word(bytes.c, 1)), "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

function checkExtData(ext: ExtData): void {
  if (typeof ext.extAmount !== "bigint" || ext.extAmount < I64_MIN || ext.extAmount > I64_MAX) {
    throw new LochError("INVALID_ARGUMENT", "extAmount must be a bigint that fits in a signed 64-bit integer");
  }
  if (typeof ext.fee !== "bigint" || ext.fee < 0n || ext.fee > MAX_AMOUNT) {
    throw new LochError("INVALID_ARGUMENT", "fee must be a bigint that fits in an unsigned 64-bit integer");
  }
  for (const output of [ext.encryptedOutput0, ext.encryptedOutput1]) {
    if (!(output instanceof Uint8Array) || output.length > MAX_ENCRYPTED_OUTPUT_LENGTH) {
      throw new LochError("INVALID_ARGUMENT", `an encrypted output is at most ${MAX_ENCRYPTED_OUTPUT_LENGTH} bytes`);
    }
  }
}

/**
 * Borsh encoding of `ExtData`, in field order: recipient (32), relayer (32),
 * ext_amount (i64 LE), fee (u64 LE), then each encrypted output as a u32 LE
 * length followed by the bytes.
 */
export function encodeExtData(ext: ExtData): Uint8Array {
  checkExtData(ext);
  return concatBytes(
    ext.recipient.toBytes(),
    ext.relayer.toBytes(),
    bigIntToBytesLE(BigInt.asUintN(64, ext.extAmount), 8),
    bigIntToBytesLE(ext.fee, 8),
    bigIntToBytesLE(BigInt(ext.encryptedOutput0.length), 4),
    ext.encryptedOutput0,
    bigIntToBytesLE(BigInt(ext.encryptedOutput1.length), 4),
    ext.encryptedOutput1,
  );
}

/**
 * The circuit's `extDataHash`: `sha256(borsh(ExtData))` with byte 0 set to
 * zero, read big-endian. The program recomputes it from the instruction, so
 * the ext data sent must be byte for byte what was hashed here.
 */
export function extDataHash(ext: ExtData): bigint {
  const digest = sha256(encodeExtData(ext));
  digest[0] = 0;
  return bytesToBigIntBE(digest);
}

function word32(bytes: Uint8Array, name: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", `${name} must be 32 bytes`);
  }
  return bytes;
}

/**
 * Instruction data of `transact`: the 8-byte Anchor discriminator followed by
 * `borsh(TransactArgs)` (proof a, b, c; root; two nullifiers; two commitments;
 * ext data).
 */
export function encodeTransactArgs(args: TransactArgs): Uint8Array {
  const { proof } = args;
  if (proof.a.length !== 64 || proof.b.length !== 128 || proof.c.length !== 64) {
    throw new LochError("INVALID_ARGUMENT", "proof parts must be 64, 128 and 64 bytes");
  }
  if (args.inputNullifiers.length !== 2 || args.outputCommitments.length !== 2) {
    throw new LochError("INVALID_ARGUMENT", "expected exactly two nullifiers and two commitments");
  }
  return concatBytes(
    TRANSACT_DISCRIMINATOR,
    proof.a,
    proof.b,
    proof.c,
    word32(args.root, "root"),
    word32(args.inputNullifiers[0], "inputNullifiers[0]"),
    word32(args.inputNullifiers[1], "inputNullifiers[1]"),
    word32(args.outputCommitments[0], "outputCommitments[0]"),
    word32(args.outputCommitments[1], "outputCommitments[1]"),
    encodeExtData(args.extData),
  );
}

/** True when `data` starts with the `transact` discriminator. */
export function isTransactData(data: Uint8Array): boolean {
  return data.length >= 8 && equalBytes(data.subarray(0, 8), TRANSACT_DISCRIMINATOR);
}

/**
 * Inverse of {@link encodeTransactArgs}. Strict by default: bytes after the
 * arguments are an error, so that what was decoded is all there is. The
 * program itself ignores trailing bytes; pass `allowTrailingBytes` when
 * decoding data that already executed on chain.
 *
 * @throws LochError `DECODE_FAILED` on a wrong discriminator, truncated data,
 *   an encrypted output over 256 bytes, or (when strict) trailing bytes.
 */
export function decodeTransactArgs(data: Uint8Array, options: { allowTrailingBytes?: boolean } = {}): TransactArgs {
  if (!isTransactData(data)) throw new LochError("DECODE_FAILED", "not a loch_pool transact instruction");
  try {
    const reader = new ByteReader(data.subarray(8));
    const proof = { a: reader.take(64), b: reader.take(128), c: reader.take(64) };
    const root = reader.take(32);
    const inputNullifiers: [Uint8Array, Uint8Array] = [reader.take(32), reader.take(32)];
    const outputCommitments: [Uint8Array, Uint8Array] = [reader.take(32), reader.take(32)];
    const extData: ExtData = {
      recipient: new PublicKey(reader.take(32)),
      relayer: new PublicKey(reader.take(32)),
      extAmount: reader.i64(),
      fee: reader.u64(),
      encryptedOutput0: reader.vec(MAX_ENCRYPTED_OUTPUT_LENGTH),
      encryptedOutput1: reader.vec(MAX_ENCRYPTED_OUTPUT_LENGTH),
    };
    if (reader.remaining !== 0 && !options.allowTrailingBytes) {
      throw new RangeError("unexpected bytes after the arguments");
    }
    return { proof, root, inputNullifiers, outputCommitments, extData };
  } catch (cause) {
    throw new LochError("DECODE_FAILED", "malformed transact instruction data", { cause });
  }
}

/**
 * The seven public inputs the program rebuilds from `args`, in circuit order:
 * root, publicAmount, extDataHash, nullifier 0, nullifier 1, commitment 0,
 * commitment 1.
 */
export function transactPublicInputs(args: TransactArgs): bigint[] {
  return [
    bytesToBigIntBE(word32(args.root, "root")),
    publicAmountField(args.extData.extAmount, args.extData.fee),
    extDataHash(args.extData),
    bytesToBigIntBE(word32(args.inputNullifiers[0], "inputNullifiers[0]")),
    bytesToBigIntBE(word32(args.inputNullifiers[1], "inputNullifiers[1]")),
    bytesToBigIntBE(word32(args.outputCommitments[0], "outputCommitments[0]")),
    bytesToBigIntBE(word32(args.outputCommitments[1], "outputCommitments[1]")),
  ];
}
