// Viewing key: the secrets that read a wallet's incoming notes, without the
// one that spends them.
//
// What its holder sees: every note the wallet receives, from now on and back
// to the first one, with its amount: payments from others, payments to the
// wallet's payment codes, and the wallet's own deposits and change. What it
// does not see: which of those notes were spent, and so neither the balance
// nor what was paid out (a nullifier takes the spending key). It cannot be
// taken back: the keys in it are the wallet's for good.

import { bech32m } from "@scure/base";
import { x25519 } from "@noble/curves/ed25519";

import { type Form, decodePayload } from "./address.js";
import { bigIntToBytesBE, bytesToBigIntBE, concatBytes, copyBytes } from "./bytes.js";
import { FIELD_MODULUS, PAYMENT_CODE_GAP, VIEWING_KEY_PREFIX } from "./constants.js";
import { AddressError, LochError } from "./errors.js";
import { type NewCommitmentEvent, type TransactionTime, transactionTime } from "./events.js";
import { type LochKeys, MAX_PAYMENT_CODE_INDEX, isValidEncryptionPublicKey, paymentCodeSecret } from "./keys.js";
import { type NoteSource, type PaymentCodeCandidate, openNote } from "./note.js";

/** The reading half of a key set. Every field but `publicKey` is secret. */
export type ViewingKey = Pick<LochKeys, "publicKey" | "encryptionSecret" | "selfNoteKey" | "paymentCodeRoot">;

const PAYLOAD_LENGTH = 128;
/** prefix + "1" + ceil(128 * 8 / 5) data characters + 6 checksum characters. */
const VIEWING_KEY_LENGTH = VIEWING_KEY_PREFIX.length + 1 + 205 + 6;
const VIEWING_KEY_FORM: Form = { prefix: VIEWING_KEY_PREFIX, payloadLength: PAYLOAD_LENGTH, what: "viewing key" };

/** The viewing key of a key set. */
export function viewingKeyOf(keys: ViewingKey): ViewingKey {
  return { publicKey: keys.publicKey, encryptionSecret: keys.encryptionSecret, selfNoteKey: keys.selfNoteKey, paymentCodeRoot: keys.paymentCodeRoot };
}

/**
 * Encodes a viewing key: bech32m, prefix "lochview", payload
 * `publicKey (32, big-endian) || encryptionSecret (32) || selfNoteKey (32) || paymentCodeRoot (32)`.
 * Always 220 characters.
 *
 * @throws LochError `INVALID_ARGUMENT` for a malformed key.
 */
export function encodeViewingKey(key: ViewingKey): string {
  const { publicKey, encryptionSecret, selfNoteKey, paymentCodeRoot } = key;
  if (typeof publicKey !== "bigint" || publicKey < 0n || publicKey >= FIELD_MODULUS) {
    throw new LochError("INVALID_ARGUMENT", "publicKey is not a field element");
  }
  for (const part of [encryptionSecret, selfNoteKey, paymentCodeRoot]) {
    if (!(part instanceof Uint8Array) || part.length !== 32) throw new LochError("INVALID_ARGUMENT", "every secret of a viewing key is 32 bytes");
  }
  const payload = concatBytes(bigIntToBytesBE(publicKey, 32), encryptionSecret, selfNoteKey, paymentCodeRoot);
  const text = bech32m.encode(VIEWING_KEY_PREFIX, bech32m.toWords(payload), VIEWING_KEY_LENGTH);
  payload.fill(0);
  return text;
}

/**
 * Decodes a viewing key.
 *
 * @throws AddressError with `reason` `encoding`, `prefix`, `checksum`,
 *   `length`, `public_key_range`, or `encryption_key` (the decryption key in
 *   it does not give a usable X25519 public key).
 */
export function decodeViewingKey(text: string): ViewingKey {
  const payload = decodePayload(text, VIEWING_KEY_FORM);
  const publicKey = bytesToBigIntBE(payload.subarray(0, 32));
  if (publicKey >= FIELD_MODULUS) throw new AddressError("public_key_range", "viewing key holds a public key outside the field");
  const encryptionSecret = copyBytes(payload, 32, 64);
  if (!isValidEncryptionPublicKey(x25519.getPublicKey(encryptionSecret))) {
    throw new AddressError("encryption_key", "viewing key holds a decryption key that is not usable");
  }
  return { publicKey, encryptionSecret, selfNoteKey: copyBytes(payload, 64, 96), paymentCodeRoot: copyBytes(payload, 96, 128) };
}

/** True when `text` decodes as a viewing key. Never throws. */
export function isViewingKey(text: string): boolean {
  try {
    decodeViewingKey(text);
    return true;
  } catch {
    return false;
  }
}

/** A note a viewing key read, with when its transaction happened as far as the events say. */
export interface ViewedNote extends TransactionTime {
  leafIndex: number;
  /** Lamports. */
  amount: bigint;
  commitment: bigint;
  /** To the address, from the wallet to itself (a deposit, change), or to a payment code. */
  source: NoteSource;
}

/**
 * Reads the notes of the key's wallet out of the pool's events (`fetchEvents`),
 * in leaf order. The same search a wallet's own sync makes: the address, the
 * wallet's notes to itself, and every payment code up to
 * {@link PAYMENT_CODE_GAP} past the last one found in use, so `events` should
 * start at the pool's first leaf. Zero-amount notes are left out.
 *
 * Nothing here says whether a note was spent since.
 */
export function viewNotes(events: readonly NewCommitmentEvent[], key: ViewingKey): ViewedNote[] {
  const keys = { ...viewingKeyOf(key), encryptionPublic: x25519.getPublicKey(key.encryptionSecret) };
  const codes: PaymentCodeCandidate[] = [];
  let used = 0;
  const lookAhead = () => {
    const end = Math.min(used + PAYMENT_CODE_GAP, MAX_PAYMENT_CODE_INDEX + 1);
    for (let index = codes.length; index < end; index++) codes.push({ index, secret: paymentCodeSecret(key.paymentCodeRoot, index) });
  };
  lookAhead();
  const found: ViewedNote[] = [];
  for (const event of [...events].sort((a, b) => a.index - b.index)) {
    const opened = openNote(event.encryptedOutput, keys, event.commitment, codes);
    if (!opened) continue;
    const { note, source } = opened;
    if (typeof source === "object" && source.code >= used) {
      used = source.code + 1;
      lookAhead();
    }
    if (note.amount === 0n) continue;
    found.push({ leafIndex: event.index, amount: note.amount, commitment: event.commitment, source, ...transactionTime(event) });
  }
  return found;
}
