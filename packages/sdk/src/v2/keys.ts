// Keys v2 (docs/v2.md section 1): independent keys for spending, nullifiers
// and reading, all hashed from the same `seed` as keys v1, so a wallet that has
// v1 keys has v2 keys without a second signature.
//
//   ask  = wide("Loch spend key v2") mod r            spending key
//   nk   = wide("Loch nullifier key v2") mod r        nullifier key
//   ivk  = wide("Loch incoming viewing key v2") mod ℓ ristretto255 scalar
//   dk   = sha256("Loch diversifier key v2" || seed)  AES-256 key
//   ak   = Poseidon(ask), ownerRoot = Poseidon(ak, nk)
//
// Unlike keys v1, the spending key gives neither the nullifier key nor a key
// that reads notes.

import { ecb } from "@noble/ciphers/aes";
import { RistrettoPoint, ed25519 } from "@noble/curves/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";

import { bytesToBigIntBE, concatBytes, utf8 } from "../bytes.js";
import { FIELD_MODULUS } from "../constants.js";
import { LochError } from "../errors.js";
import { keyDerivationMessage } from "../keys.js";
import {
  DIVERSIFIED_BASE_LABEL,
  DIVERSIFIER_KEY_LABEL,
  DIVERSIFIER_LENGTH,
  INCOMING_VIEWING_KEY_LABEL,
  NULLIFIER_KEY_LABEL,
  PAYMENT_CODE_LABEL_V2,
  RISTRETTO_ORDER,
  SELF_NOTE_LABEL_V2,
  SPEND_KEY_LABEL,
} from "./constants.js";

/** What reads a wallet's incoming notes: the incoming viewing key. Every field but `ownerRoot` is secret. */
export interface IncomingViewingKey {
  /** `Poseidon(ak, nk)`: with a diversifier, the owner field of every note to this wallet. */
  ownerRoot: bigint;
  /** ristretto255 scalar that decrypts notes to every address of the wallet. */
  ivk: bigint;
  /** AES-256 key of the diversifiers (32 bytes). */
  dk: Uint8Array;
  /** Pre-shared key of the notes the wallet sends to itself (32 bytes). */
  selfNoteKey: Uint8Array;
  /** Root of the payment code secrets (32 bytes). */
  paymentCodeRoot: Uint8Array;
}

/** What reads a wallet's notes and sees which were spent: the full viewing key. */
export interface FullViewingKey extends IncomingViewingKey {
  /** `Poseidon(ask)`. */
  ak: bigint;
  /** Nullifier key: computes the nullifier of every note of the wallet. Secret. */
  nk: bigint;
}

/** A key set v2. Everything but the public parts of addresses derived from it is secret. */
export interface LochKeysV2 extends FullViewingKey {
  /** Spending key. Secret: with `nk` it spends every note of the wallet. */
  ask: bigint;
}

/** `sha512(label || seed)` as a 512-bit big-endian integer. */
function wide(label: string, seed: Uint8Array): bigint {
  return bytesToBigIntBE(sha512(concatBytes(utf8(label), seed)));
}

/**
 * The key set v2 of a 32-byte seed (the hash of the wallet's signature, as for
 * keys v1, or a claim link's seed).
 *
 * @throws LochError `INVALID_ARGUMENT` if the seed is not 32 bytes.
 */
export function keysV2FromSeed(seed: Uint8Array): LochKeysV2 {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "a key seed must be 32 bytes");
  }
  const ask = wide(SPEND_KEY_LABEL, seed) % FIELD_MODULUS;
  const nk = wide(NULLIFIER_KEY_LABEL, seed) % FIELD_MODULUS;
  const ivk = wide(INCOMING_VIEWING_KEY_LABEL, seed) % RISTRETTO_ORDER;
  const ak = poseidon1([ask]);
  return {
    ask,
    ak,
    nk,
    ownerRoot: poseidon2([ak, nk]),
    ivk,
    dk: sha256(concatBytes(utf8(DIVERSIFIER_KEY_LABEL), seed)),
    selfNoteKey: sha256(concatBytes(utf8(SELF_NOTE_LABEL_V2), seed)),
    paymentCodeRoot: sha256(concatBytes(utf8(PAYMENT_CODE_LABEL_V2), seed)),
  };
}

/**
 * The key set v2 that follows from the wallet's Ed25519 signature of the key
 * derivation message: the same signature, and the same seed, as keys v1.
 * With `walletPublicKey` the signature is verified first.
 *
 * @throws LochError `INVALID_ARGUMENT`, `INVALID_SIGNATURE`.
 */
export function deriveKeysV2(signature: Uint8Array, walletPublicKey?: Uint8Array): LochKeysV2 {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new LochError("INVALID_ARGUMENT", "expected the 64-byte Ed25519 signature of the key derivation message");
  }
  if (walletPublicKey !== undefined) {
    let valid = false;
    try {
      valid = walletPublicKey.length === 32 && ed25519.verify(signature, keyDerivationMessage(), walletPublicKey);
    } catch {
      valid = false;
    }
    if (!valid) throw new LochError("INVALID_SIGNATURE", "the wallet did not return a valid signature of the key derivation message");
  }
  return keysV2FromSeed(sha256(signature));
}

/** The full viewing key of a key set. */
export function fullViewingKeyOf(keys: FullViewingKey): FullViewingKey {
  const { ak, nk, ownerRoot, ivk, dk, selfNoteKey, paymentCodeRoot } = keys;
  return { ak, nk, ownerRoot, ivk, dk, selfNoteKey, paymentCodeRoot };
}

/** The incoming viewing key of a key set. */
export function incomingViewingKeyOf(keys: IncomingViewingKey): IncomingViewingKey {
  const { ownerRoot, ivk, dk, selfNoteKey, paymentCodeRoot } = keys;
  return { ownerRoot, ivk, dk, selfNoteKey, paymentCodeRoot };
}

/** Largest address index: indices are four bytes. */
export const MAX_ADDRESS_INDEX = 0xffff_ffff;

function indexBlock(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > MAX_ADDRESS_INDEX) {
    throw new LochError("INVALID_ARGUMENT", "an address index is an integer from 0 to 2^32 - 1");
  }
  const block = new Uint8Array(16);
  block[12] = index >>> 24;
  block[13] = (index >>> 16) & 0xff;
  block[14] = (index >>> 8) & 0xff;
  block[15] = index & 0xff;
  return block;
}

/** `d_j = AES-256-ECB(dk, 0^12 || u32_be(j))`. */
export function diversifierAt(dk: Uint8Array, index: number): Uint8Array {
  return ecb(dk, { disablePadding: true }).encrypt(indexBlock(index));
}

/**
 * The address index of a diversifier, or null if `d` is not one of the
 * wallet's (its AES decryption does not start with twelve zero bytes).
 */
export function addressIndexOf(dk: Uint8Array, d: Uint8Array): number | null {
  if (!(d instanceof Uint8Array) || d.length !== DIVERSIFIER_LENGTH) return null;
  const block = ecb(dk, { disablePadding: true }).decrypt(d);
  for (let i = 0; i < 12; i++) if (block[i] !== 0) return null;
  return ((block[12]! << 24) | (block[13]! << 16) | (block[14]! << 8) | block[15]!) >>> 0;
}

/** The diversifier as the field element the circuit takes: 16 bytes big-endian. */
export function diversifierField(d: Uint8Array): bigint {
  return bytesToBigIntBE(d);
}

/** `owner = Poseidon(ownerRoot, d)`. */
export function ownerOf(ownerRoot: bigint, d: Uint8Array): bigint {
  return poseidon2([ownerRoot, diversifierField(d)]);
}

/** `G_d = hash_to_group(sha512("Loch diversified base v2" || d))`. */
export function diversifiedBase(d: Uint8Array): InstanceType<typeof RistrettoPoint> {
  return RistrettoPoint.hashToCurve(sha512(concatBytes(utf8(DIVERSIFIED_BASE_LABEL), d)));
}

/** `pk_d = ivk · G_d`, encoded. */
export function transmissionKey(ivk: bigint, d: Uint8Array): Uint8Array {
  return diversifiedBase(d).multiply(ivk).toBytes();
}

/** A v2 address: everything a sender needs to pay one of a wallet's addresses. */
export interface ShieldedAddressV2 {
  /** Diversifier (16 bytes). */
  d: Uint8Array;
  /** `Poseidon(ownerRoot, d)`: the owner field of notes to this address. */
  owner: bigint;
  /** ristretto255 key notes are encrypted to (32 bytes). */
  pk: Uint8Array;
}

/** Address number `index` of a wallet (0 is the main address). */
export function addressAt(keys: Pick<IncomingViewingKey, "ownerRoot" | "ivk" | "dk">, index: number): ShieldedAddressV2 {
  const d = diversifierAt(keys.dk, index);
  return { d, owner: ownerOf(keys.ownerRoot, d), pk: transmissionKey(keys.ivk, d) };
}

/** The main address (index 0). */
export function mainAddress(keys: Pick<IncomingViewingKey, "ownerRoot" | "ivk" | "dk">): ShieldedAddressV2 {
  return addressAt(keys, 0);
}

/**
 * The secret of payment code number `index`: `sha256(paymentCodeRoot || u32_be(index))`.
 * The code's address is address `index + 1`.
 */
export function paymentCodeSecretV2(paymentCodeRoot: Uint8Array, index: number): Uint8Array {
  if (!(paymentCodeRoot instanceof Uint8Array) || paymentCodeRoot.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "the payment code root must be 32 bytes");
  }
  const block = indexBlock(index);
  return sha256(concatBytes(paymentCodeRoot, block.subarray(12)));
}

/** A v2 payment code: an address of its own plus the secret the recipient and one payer share. */
export interface PaymentCodeV2 extends ShieldedAddressV2 {
  secret: Uint8Array;
}

/** Payment code number `index` (address `index + 1`). */
export function paymentCodeAtV2(keys: Pick<IncomingViewingKey, "ownerRoot" | "ivk" | "dk" | "paymentCodeRoot">, index: number): PaymentCodeV2 {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ADDRESS_INDEX) {
    throw new LochError("INVALID_ARGUMENT", "a payment code index is an integer from 0 to 2^32 - 2");
  }
  return { ...addressAt(keys, index + 1), secret: paymentCodeSecretV2(keys.paymentCodeRoot, index) };
}
