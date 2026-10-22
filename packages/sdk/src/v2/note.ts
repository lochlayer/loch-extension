// Notes v2 (docs/v2.md sections 3 and 4).
//
//   inner      = Poseidon(owner, blinding)
//   commitment = Poseidon(asset, amount, inner)
//   nullifier  = Poseidon(nk, commitment, leafIndex)
//
// Encrypted note v2, 103 bytes: epk (32) || ChaCha20-Poly1305(key, 0^12,
// d (16) || amount u64 LE (8) || blinding 31 bytes BE) (55 + 16). The key is
// HKDF-SHA256 over the ristretto255 exchange, with or without a pre-shared key,
// salt epk. The asset is not in the plaintext: the recipient tries the assets
// it knows against the commitment.

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { RistrettoPoint } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";

import { bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntBE, bytesToBigIntLE, concatBytes, copyBytes, randomBytes, utf8 } from "../bytes.js";
import { LochError } from "../errors.js";
import { type FieldLike, assertAmount, assertField, toField } from "../field.js";
import { randomBlinding } from "../note.js";
import type { AssetTable } from "./asset.js";
import { DIVERSIFIER_LENGTH, ENCRYPTED_NOTE_V2_LENGTH, KEYED_NOTE_KEY_INFO_V2, NOTE_KEY_INFO_V2, RISTRETTO_ORDER } from "./constants.js";
import { type IncomingViewingKey, type PaymentCodeV2, type ShieldedAddressV2, diversifiedBase, ownerOf } from "./keys.js";

/** A v2 note: `amount` base units of `asset` owned by `owner`, hidden by `blinding`. */
export interface NoteV2 {
  /** `assetId(mint)`. */
  asset: bigint;
  /** Base units, below 2^64. */
  amount: bigint;
  /** `Poseidon(ownerRoot, d)` of the receiving address. */
  owner: bigint;
  /** Below 2^248. Secret. */
  blinding: bigint;
}

/** Builds a note, checking every field. Without `blinding` a fresh one is drawn. */
export function createNoteV2(asset: bigint, amount: bigint, owner: bigint, blinding: bigint = randomBlinding()): NoteV2 {
  assertField(asset, "asset");
  assertAmount(amount);
  assertField(owner, "owner");
  if (typeof blinding !== "bigint" || blinding < 0n || blinding >> 248n !== 0n) {
    throw new LochError("INVALID_ARGUMENT", "blinding must be a bigint below 2^248");
  }
  return { asset, amount, owner, blinding };
}

/** `Poseidon(owner, blinding)`. */
export function noteInner(owner: bigint, blinding: bigint): bigint {
  return poseidon2([owner, blinding]);
}

/** `Poseidon(asset, amount, Poseidon(owner, blinding))`: the leaf. */
export function noteCommitmentV2(note: NoteV2): bigint {
  return poseidon3([note.asset, note.amount, noteInner(note.owner, note.blinding)]);
}

/** `Poseidon(asset, amount, inner)`: a commitment from its inner part, as the program finishes a swap's note. */
export function commitmentFromInner(asset: bigint, amount: bigint, inner: bigint): bigint {
  return poseidon3([asset, amount, inner]);
}

/** `Poseidon(nk, commitment, leafIndex)`. */
export function noteNullifierV2(nk: bigint, commitment: bigint, leafIndex: number | bigint): bigint {
  return poseidon3([nk, commitment, BigInt(leafIndex)]);
}

const BLINDING_BYTES = 31;
const PLAINTEXT_LENGTH = DIVERSIFIER_LENGTH + 8 + BLINDING_BYTES;
const ZERO_NONCE = new Uint8Array(12);

/** A ristretto255 scalar from 64 random bytes, never zero. */
function randomScalar(): bigint {
  for (;;) {
    const scalar = bytesToBigIntBE(randomBytes(64)) % RISTRETTO_ORDER;
    if (scalar !== 0n) return scalar;
  }
}

function noteKey(shared: Uint8Array, epk: Uint8Array, psk?: Uint8Array): Uint8Array {
  if (psk === undefined) return hkdf(sha256, shared, epk, utf8(NOTE_KEY_INFO_V2), 32);
  const ikm = concatBytes(shared, psk);
  const key = hkdf(sha256, ikm, epk, utf8(KEYED_NOTE_KEY_INFO_V2), 32);
  ikm.fill(0);
  return key;
}

/** A decoded ristretto255 point that is not the identity, or null. */
function decodePoint(bytes: Uint8Array): InstanceType<typeof RistrettoPoint> | null {
  try {
    const point = RistrettoPoint.fromBytes(bytes);
    return point.is0() ? null : point;
  } catch {
    return null;
  }
}

/** True when `pk` is a canonical ristretto255 encoding of a point other than the identity. */
export function isValidTransmissionKey(pk: unknown): pk is Uint8Array {
  return pk instanceof Uint8Array && pk.length === 32 && decodePoint(pk) !== null;
}

/**
 * Encrypts `amount` and `blinding` of a note to `to` (103 bytes). With `psk`
 * the note is a keyed note. The caller has made the note with
 * `owner = to.owner`; the owner is not in the ciphertext, the diversifier is.
 *
 * @throws LochError `INVALID_ARGUMENT` for a malformed address, amount, blinding or psk.
 */
export function encryptNoteV2(note: Pick<NoteV2, "amount" | "blinding">, to: Pick<ShieldedAddressV2, "d" | "pk">, psk?: Uint8Array): Uint8Array {
  assertAmount(note.amount);
  if (typeof note.blinding !== "bigint" || note.blinding < 0n || note.blinding >> 248n !== 0n) {
    throw new LochError("INVALID_ARGUMENT", "blinding must be a bigint below 2^248");
  }
  if (!(to.d instanceof Uint8Array) || to.d.length !== DIVERSIFIER_LENGTH) {
    throw new LochError("INVALID_ARGUMENT", "a diversifier is 16 bytes");
  }
  if (psk !== undefined && (!(psk instanceof Uint8Array) || psk.length !== 32)) {
    throw new LochError("INVALID_ARGUMENT", "the pre-shared key of a note must be 32 bytes");
  }
  const pk = decodePoint(to.pk);
  if (!pk) throw new LochError("INVALID_ARGUMENT", "the recipient key is not a valid ristretto255 point");
  const esk = randomScalar();
  const epk = diversifiedBase(to.d).multiply(esk).toBytes();
  const shared = pk.multiply(esk).toBytes();
  const key = noteKey(shared, epk, psk);
  const plaintext = concatBytes(to.d, bigIntToBytesLE(note.amount, 8), bigIntToBytesBE(note.blinding, BLINDING_BYTES));
  const sealed = chacha20poly1305(key, ZERO_NONCE).encrypt(plaintext);
  shared.fill(0);
  key.fill(0);
  plaintext.fill(0);
  return concatBytes(epk, sealed);
}

/** How a note reached the wallet. */
export type NoteSourceV2 = "address" | "self" | { code: number };

/** A payment code a wallet is looking for notes on. */
export interface PaymentCodeCandidateV2 {
  index: number;
  secret: Uint8Array;
}

/** What decryption found, before the commitment is checked. */
export interface DecryptedNoteV2 {
  d: Uint8Array;
  amount: bigint;
  blinding: bigint;
  source: NoteSourceV2;
}

/**
 * Decrypts one encrypted output with the incoming viewing key, without
 * checking it against a commitment. Tries the wallet's `selfNoteKey`, the
 * plain address key, then each code. Null if nothing opens it. Never throws.
 */
export function decryptNoteV2(
  encrypted: Uint8Array,
  key: Pick<IncomingViewingKey, "ivk" | "selfNoteKey">,
  codes: readonly PaymentCodeCandidateV2[] = [],
): DecryptedNoteV2 | null {
  try {
    if (!(encrypted instanceof Uint8Array) || encrypted.length !== ENCRYPTED_NOTE_V2_LENGTH) return null;
    const epk = encrypted.subarray(0, 32);
    const sealed = encrypted.subarray(32);
    const point = decodePoint(epk);
    if (!point) return null;
    const shared = point.multiply(key.ivk).toBytes();
    const attempt = (psk: Uint8Array | undefined): Uint8Array | null => {
      const noteKeyBytes = noteKey(shared, epk, psk);
      try {
        return chacha20poly1305(noteKeyBytes, ZERO_NONCE).decrypt(sealed);
      } catch {
        return null;
      } finally {
        noteKeyBytes.fill(0);
      }
    };
    try {
      const candidates: Array<[Uint8Array | undefined, NoteSourceV2]> = [[key.selfNoteKey, "self"], [undefined, "address"]];
      for (const code of codes) candidates.push([code.secret, { code: code.index }]);
      for (const [psk, source] of candidates) {
        const plaintext = attempt(psk);
        if (!plaintext || plaintext.length !== PLAINTEXT_LENGTH) continue;
        return {
          d: copyBytes(plaintext, 0, DIVERSIFIER_LENGTH),
          amount: bytesToBigIntLE(plaintext.subarray(DIVERSIFIER_LENGTH, DIVERSIFIER_LENGTH + 8)),
          blinding: bytesToBigIntBE(plaintext.subarray(DIVERSIFIER_LENGTH + 8)),
          source,
        };
      }
      return null;
    } finally {
      shared.fill(0);
    }
  } catch {
    return null;
  }
}

/** A note the wallet found: the note, its diversifier and how it arrived. */
export interface OpenedNoteV2 {
  note: NoteV2;
  d: Uint8Array;
  source: NoteSourceV2;
}

/**
 * Trial decryption of one output against its commitment. Returns the note only
 * if it decrypts under `key` AND `Poseidon(asset, amount, Poseidon(owner,
 * blinding))` equals `commitment` for one asset of `assets`, with `owner =
 * Poseidon(ownerRoot, d)`. With `amount` (a swap leaf, whose amount the event
 * gives) the plaintext's amount is replaced by it. Never throws.
 */
export function openNoteV2(
  encrypted: Uint8Array,
  key: Pick<IncomingViewingKey, "ivk" | "selfNoteKey" | "ownerRoot">,
  commitment: FieldLike,
  assets: AssetTable,
  codes: readonly PaymentCodeCandidateV2[] = [],
  amount?: bigint,
): OpenedNoteV2 | null {
  try {
    const decrypted = decryptNoteV2(encrypted, key, codes);
    if (!decrypted) return null;
    const expected = toField(commitment);
    const owner = ownerOf(key.ownerRoot, decrypted.d);
    const inner = noteInner(owner, decrypted.blinding);
    const value = amount ?? decrypted.amount;
    for (const asset of assets.assets) {
      const id = assets.idOf(asset.mint);
      if (poseidon3([id, value, inner]) === expected) {
        return { note: { asset: id, amount: value, owner, blinding: decrypted.blinding }, d: decrypted.d, source: decrypted.source };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The key a note to `to` is sealed with: the sender's own `selfNoteKey` for a
 * note to one of its own addresses, the code's secret for a payment code,
 * none for a plain address.
 */
export function sealingKeyOf(to: ShieldedAddressV2 | PaymentCodeV2, own?: { ownerRoot: bigint; selfNoteKey: Uint8Array }): Uint8Array | undefined {
  if (own && ownerOf(own.ownerRoot, to.d) === to.owner) return own.selfNoteKey;
  if ("secret" in to) {
    if (!(to.secret instanceof Uint8Array) || to.secret.length !== 32) {
      throw new LochError("INVALID_ARGUMENT", "a payment code secret must be 32 bytes");
    }
    return to.secret;
  }
  return undefined;
}
