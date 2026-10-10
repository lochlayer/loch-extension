// Notes, commitments, nullifiers and note encryption v1.
//
// An encrypted note has one layout and two key schedules. An address note is
// keyed by the X25519 exchange alone. A keyed note is keyed by the exchange
// and a 32-byte pre-shared key together: the wallet's own `selfNoteKey` for
// the notes it sends to itself, a payment code's secret for a note paid to
// that code. The two look the same on chain.

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { poseidon3 } from "poseidon-lite/poseidon3";

import { bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntBE, bytesToBigIntLE, concatBytes, randomBytes, utf8 } from "./bytes.js";
import { ENCRYPTED_NOTE_LENGTH, KEYED_NOTE_KEY_INFO, NOTE_KEY_INFO } from "./constants.js";
import { LochError } from "./errors.js";
import { type FieldLike, assertAmount, assertField, toField } from "./field.js";
import { type LochKeys, isValidEncryptionPublicKey } from "./keys.js";

/** A note: `amount` lamports owned by `publicKey`, hidden by `blinding`. */
export interface Note {
  /** Lamports, `0 <= amount < 2^64`. */
  amount: bigint;
  /** Poseidon public key of the owner. */
  publicKey: bigint;
  /** Random value below 2^248 that hides the note. Secret: with it, anyone can test guesses of amount and owner. */
  blinding: bigint;
}

const BLINDING_BYTES = 31;
const PLAINTEXT_LENGTH = 8 + BLINDING_BYTES;
const ZERO_NONCE = new Uint8Array(12);

/** A fresh blinding: 31 uniformly random bytes, so below 2^248 and below r. */
export function randomBlinding(): bigint {
  return bytesToBigIntBE(randomBytes(BLINDING_BYTES));
}

/**
 * Builds a note. Without `blinding` a fresh random one is drawn.
 *
 * @throws LochError `INVALID_ARGUMENT` if the amount is outside `[0, 2^64)`,
 *   the public key is not a field element or the blinding is 2^248 or more.
 */
export function createNote(amount: bigint, publicKey: bigint, blinding: bigint = randomBlinding()): Note {
  assertAmount(amount);
  assertField(publicKey, "publicKey");
  if (typeof blinding !== "bigint" || blinding < 0n || blinding >> 248n !== 0n) {
    throw new LochError("INVALID_ARGUMENT", "blinding must be a bigint below 2^248");
  }
  return { amount, publicKey, blinding };
}

/** `Poseidon(amount, publicKey, blinding)`: the leaf that goes into the tree. */
export function noteCommitment(note: Note): bigint {
  return poseidon3([note.amount, note.publicKey, note.blinding]);
}

/**
 * `Poseidon(commitment, leafIndex, Poseidon(privateKey, commitment, leafIndex))`.
 * Only the owner can compute it; it becomes public when the note is spent.
 */
export function noteNullifier(note: Note, leafIndex: number | bigint, privateKey: bigint): bigint {
  const commitment = noteCommitment(note);
  const index = BigInt(leafIndex);
  return poseidon3([commitment, index, poseidon3([privateKey, commitment, index])]);
}

const PSK_BYTES = 32;

/**
 * The per-note key. Without `psk`, the key of an address note; with it, the
 * key of a keyed note, which nobody derives from the exchange alone. The two
 * have different `info` strings, so one exchange never yields the same key
 * both ways.
 */
function noteKey(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array, psk?: Uint8Array): Uint8Array {
  const salt = concatBytes(ephemeralPublic, recipientPublic);
  if (psk === undefined) return hkdf(sha256, shared, salt, utf8(NOTE_KEY_INFO), 32);
  const ikm = concatBytes(shared, psk);
  const key = hkdf(sha256, ikm, salt, utf8(KEYED_NOTE_KEY_INFO), 32);
  ikm.fill(0);
  return key;
}

/**
 * Encrypts a note to the recipient's X25519 key. The result is exactly
 * {@link ENCRYPTED_NOTE_LENGTH} (87) bytes:
 *
 *   ephemeralPublic (32) || ChaCha20-Poly1305(key, nonce = 0^12, plaintext) (39 + 16)
 *   key       = HKDF-SHA256(ikm = X25519(ephemeralSecret, recipient),
 *                           salt = ephemeralPublic || recipient,
 *                           info = "loch-note-v1", 32 bytes)
 *   plaintext = amount as u64 little-endian (8) || blinding as 31 bytes big-endian
 *
 * With `psk` the note is a keyed note: `ikm` is the exchange followed by the
 * 32 bytes of `psk`, and `info` is "loch-note-psk-v1". Reading it takes the
 * recipient's X25519 key and `psk`, both. Everything else is the same, the
 * ephemeral key included, so the two kinds cannot be told apart on chain.
 * `psk` is the sender's own `selfNoteKey` for a note to itself (the recipient
 * key is then its own), or the secret of the payment code being paid.
 *
 * A fresh ephemeral key is drawn for every call, so each key encrypts exactly
 * one message and the all-zero nonce is never reused.
 *
 * The recipient key must be canonical (below 2^255 - 19) and not of low
 * order. Its raw bytes go into the salt, so a second encoding of the same key
 * would produce a note its owner cannot decrypt.
 *
 * @throws LochError `INVALID_ARGUMENT` for an invalid note, recipient key or `psk`.
 */
export function encryptNote(note: Note, recipientEncryptionPublic: Uint8Array, psk?: Uint8Array): Uint8Array {
  const checked = createNote(note.amount, note.publicKey, note.blinding);
  if (psk !== undefined && (!(psk instanceof Uint8Array) || psk.length !== PSK_BYTES)) {
    throw new LochError("INVALID_ARGUMENT", "the pre-shared key of a note must be 32 bytes");
  }
  if (!(recipientEncryptionPublic instanceof Uint8Array) || recipientEncryptionPublic.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "the recipient encryption key must be 32 bytes");
  }
  if (!isValidEncryptionPublicKey(recipientEncryptionPublic)) {
    // Low order: the shared secret would be all zeros and anyone could decrypt.
    // Non-canonical: the recipient would derive a different note key and never see the note.
    throw new LochError("INVALID_ARGUMENT", "the recipient encryption key is not a valid X25519 public key");
  }
  const ephemeralSecret = randomBytes(32);
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(ephemeralSecret, recipientEncryptionPublic);
  } catch {
    throw new LochError("INVALID_ARGUMENT", "the recipient encryption key is not a valid X25519 public key");
  }
  const key = noteKey(shared, ephemeralPublic, recipientEncryptionPublic, psk);
  const plaintext = concatBytes(bigIntToBytesLE(checked.amount, 8), bigIntToBytesBE(checked.blinding, BLINDING_BYTES));
  const sealed = chacha20poly1305(key, ZERO_NONCE).encrypt(plaintext);
  ephemeralSecret.fill(0);
  shared.fill(0);
  key.fill(0);
  return concatBytes(ephemeralPublic, sealed);
}

/** A payment code a wallet is looking for notes on: its index and its secret. */
export interface PaymentCodeCandidate {
  index: number;
  secret: Uint8Array;
}

/**
 * How a note reached the wallet: `"address"` (anyone who has the address can
 * send one), `"self"` (the wallet sent it to itself), or the index of the
 * payment code it was paid to.
 */
export type NoteSource = "address" | "self" | { code: number };

/** A note that trial decryption opened, and under which key. */
export interface OpenedNote {
  note: Note;
  source: NoteSource;
}

/** The keys trial decryption uses. Without `selfNoteKey`, notes the wallet sent to itself are not found. */
export type NoteOpeningKeys = Pick<LochKeys, "publicKey" | "encryptionSecret" | "encryptionPublic"> & Partial<Pick<LochKeys, "selfNoteKey">>;

/**
 * Trial decryption of one `NewCommitment` event. Returns the note, and how
 * it was addressed, only if the ciphertext is exactly 87 bytes, decrypts
 * under `keys`, AND `Poseidon(amount, keys.publicKey, blinding)` equals
 * `commitment`. The last check matters: the AEAD tag proves who can read the
 * note, not that the commitment on chain is spendable by this key.
 *
 * One X25519 operation, then one cheap attempt per key schedule: the wallet's
 * own `selfNoteKey`, the plain address key, and the secret of each of `codes`.
 *
 * Returns null in every other case. Never throws on untrusted input.
 */
export function openNote(
  encrypted: Uint8Array,
  keys: NoteOpeningKeys,
  commitment: FieldLike,
  codes: readonly PaymentCodeCandidate[] = [],
): OpenedNote | null {
  try {
    if (!(encrypted instanceof Uint8Array) || encrypted.length !== ENCRYPTED_NOTE_LENGTH) return null;
    const expected = toField(commitment);
    const ephemeralPublic = encrypted.subarray(0, 32);
    const sealed = encrypted.subarray(32);
    const shared = x25519.getSharedSecret(keys.encryptionSecret, ephemeralPublic);
    const attempt = (psk: Uint8Array | undefined): Note | null => {
      const key = noteKey(shared, ephemeralPublic, keys.encryptionPublic, psk);
      let plaintext: Uint8Array;
      try {
        plaintext = chacha20poly1305(key, ZERO_NONCE).decrypt(sealed);
      } catch {
        return null;
      } finally {
        key.fill(0);
      }
      if (plaintext.length !== PLAINTEXT_LENGTH) return null;
      const note: Note = {
        amount: bytesToBigIntLE(plaintext.subarray(0, 8)),
        publicKey: keys.publicKey,
        blinding: bytesToBigIntBE(plaintext.subarray(8)),
      };
      return noteCommitment(note) === expected ? note : null;
    };
    try {
      if (keys.selfNoteKey !== undefined) {
        const note = attempt(keys.selfNoteKey);
        if (note) return { note, source: "self" };
      }
      const note = attempt(undefined);
      if (note) return { note, source: "address" };
      for (const code of codes) {
        const paid = attempt(code.secret);
        if (paid) return { note: paid, source: { code: code.index } };
      }
      return null;
    } finally {
      shared.fill(0);
    }
  } catch {
    return null;
  }
}

/**
 * {@link openNote} without payment codes and without saying how the note was
 * addressed: the note if it is an address note or a self note of `keys`, null
 * otherwise. Never throws on untrusted input.
 */
export function tryDecryptNote(encrypted: Uint8Array, keys: NoteOpeningKeys, commitment: FieldLike): Note | null {
  return openNote(encrypted, keys, commitment)?.note ?? null;
}
