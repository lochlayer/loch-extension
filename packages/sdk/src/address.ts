// Shielded address: bech32m, prefix "loch", payload = publicKey (32 bytes
// big-endian) || encryptionPublic (32 bytes). Always 114 characters.
//
// Payment code: bech32m, prefix "lochpay", payload = the address payload ||
// secret (32 bytes). Always 168 characters. An address with a secret that the
// recipient and one payer share: see docs/protocol.md section 4.

import { bech32m } from "@scure/base";

import { bigIntToBytesBE, bytesToBigIntBE, concatBytes, copyBytes } from "./bytes.js";
import { ADDRESS_PREFIX, FIELD_MODULUS, PAYMENT_CODE_PREFIX } from "./constants.js";
import { AddressError, LochError } from "./errors.js";
import { type LochKeys, isValidEncryptionPublicKey, paymentCodeSecret } from "./keys.js";

/** The public half of a key set: what a sender needs to pay someone privately. */
export interface ShieldedAddress {
  /** Poseidon public key that will own the note. */
  publicKey: bigint;
  /** X25519 public key the note is encrypted to (32 bytes). */
  encryptionPublic: Uint8Array;
}

const PAYLOAD_LENGTH = 64;
/** prefix + "1" + ceil(64 * 8 / 5) data characters + 6 checksum characters. */
const ADDRESS_LENGTH = ADDRESS_PREFIX.length + 1 + 103 + 6;
const BECH32_CHARSET = /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/;

/**
 * Encodes a shielded address. Accepts a full key set as well, since
 * `LochKeys` has both fields.
 *
 * @throws LochError `INVALID_ARGUMENT` if the public key is not a field
 *   element or the encryption key is not a canonical X25519 public key
 *   (32 bytes, below 2^255 - 19, not of low order).
 */
export function encodeShieldedAddress(address: ShieldedAddress): string {
  return bech32m.encode(ADDRESS_PREFIX, bech32m.toWords(addressPayload(address)), ADDRESS_LENGTH);
}

/** `BE32(publicKey) || encryptionPublic`, after checking both. */
function addressPayload(address: ShieldedAddress): Uint8Array {
  const { publicKey, encryptionPublic } = address;
  if (typeof publicKey !== "bigint" || publicKey < 0n || publicKey >= FIELD_MODULUS) {
    throw new LochError("INVALID_ARGUMENT", "publicKey is not a field element");
  }
  if (!(encryptionPublic instanceof Uint8Array) || encryptionPublic.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "encryptionPublic must be 32 bytes");
  }
  if (!isValidEncryptionPublicKey(encryptionPublic)) {
    throw new LochError("INVALID_ARGUMENT", "encryptionPublic is not a canonical X25519 public key");
  }
  return concatBytes(bigIntToBytesBE(publicKey, 32), encryptionPublic);
}

/**
 * Decodes a shielded address. Upper-case input is accepted (bech32 allows it);
 * mixed case is not.
 *
 * @throws AddressError with `reason`: `encoding` (not bech32 at all), `prefix`
 *   (not a "loch" address), `checksum` (mistyped or not bech32m), `length`
 *   (payload is not 64 bytes), `public_key_range` (public key not below r),
 *   `encryption_key` (the encryption key is not a canonical X25519 public
 *   key: its value is 2^255 - 19 or more, or it is a point of low order).
 */
export function decodeShieldedAddress(text: string): ShieldedAddress {
  return addressOf(decodePayload(text, ADDRESS_FORM), ADDRESS_FORM.what);
}

/** What tells the protocol's bech32m strings apart: prefix, payload length, and the name used in messages. */
export interface Form {
  prefix: string;
  payloadLength: number;
  what: string;
}

const ADDRESS_FORM: Form = { prefix: ADDRESS_PREFIX, payloadLength: PAYLOAD_LENGTH, what: "shielded address" };

/** The prefix of a bech32 string in lower case, or null if it has no separator. */
function prefixOf(text: string): string | null {
  const separator = text.lastIndexOf("1");
  return separator < 1 ? null : text.slice(0, separator).toLowerCase();
}

/**
 * Checks case, prefix, characters, checksum and length, and returns the
 * payload. Internal: shared with the other bech32m strings of the protocol
 * (claim codes, viewing keys), which report failures the same way.
 */
export function decodePayload(text: string, form: Form): Uint8Array {
  const { what } = form;
  if (typeof text !== "string") throw new AddressError("encoding", `a ${what} is a string`);
  const lower = text.toLowerCase();
  if (text !== lower && text !== text.toUpperCase()) {
    throw new AddressError("encoding", `a ${what} is all lower case or all upper case`);
  }
  const separator = lower.lastIndexOf("1");
  if (separator < 1) throw new AddressError("encoding", "not a bech32m string: no separator");
  const prefix = lower.slice(0, separator);
  const data = lower.slice(separator + 1);
  if (prefix !== form.prefix) {
    throw new AddressError("prefix", `not a Loch ${what}: expected the prefix "${form.prefix}"`);
  }
  if (data.length < 6 || !BECH32_CHARSET.test(data)) {
    throw new AddressError("encoding", "not a bech32m string: invalid characters");
  }
  let words: number[];
  try {
    // The limit is generous on purpose so that a wrong length is reported as such below.
    words = bech32m.decode(lower as `${string}1${string}`, 1023).words;
  } catch {
    throw new AddressError("checksum", `${what} checksum does not match: check for typos`);
  }
  let payload: Uint8Array;
  try {
    payload = bech32m.fromWords(words);
  } catch {
    throw new AddressError("length", `${what} has the wrong length`);
  }
  if (payload.length !== form.payloadLength) {
    throw new AddressError("length", `${what} has the wrong length`);
  }
  return payload;
}

/** The two keys at the start of a payload, checked. */
function addressOf(payload: Uint8Array, what: string): ShieldedAddress {
  const publicKey = bytesToBigIntBE(payload.subarray(0, 32));
  if (publicKey >= FIELD_MODULUS) {
    throw new AddressError("public_key_range", `${what} holds a public key outside the field`);
  }
  const encryptionPublic = copyBytes(payload, 32, 64);
  // Every key has exactly one accepted encoding, so every recipient has exactly
  // one address, and a note sent to an address that decodes can be decrypted
  // by whoever owns it (see isValidEncryptionPublicKey).
  if (!isValidEncryptionPublicKey(encryptionPublic)) {
    throw new AddressError("encryption_key", `${what} holds an encryption key that is not a valid X25519 public key`);
  }
  return { publicKey, encryptionPublic };
}

/** True when `text` decodes as a shielded address. Never throws. */
export function isShieldedAddress(text: string): boolean {
  try {
    decodeShieldedAddress(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A payment code: a shielded address together with a secret that the
 * recipient and one payer share. A note paid to it is encrypted under the
 * X25519 exchange and the secret together, so reading it takes both: breaking
 * X25519, which a quantum computer could do, is not enough.
 *
 * The secret is why a code is handed to one payer, privately, and not
 * published. Whoever holds a code and can also break X25519 reads the amount
 * of every note paid to it. Nobody can spend with it.
 */
export interface PaymentCode extends ShieldedAddress {
  /** The pre-shared key of notes paid to this code (32 bytes). Secret between the recipient and the payer. */
  secret: Uint8Array;
}

const PAYMENT_CODE_PAYLOAD_LENGTH = PAYLOAD_LENGTH + 32;
/** prefix + "1" + ceil(96 * 8 / 5) data characters + 6 checksum characters. */
const PAYMENT_CODE_LENGTH = PAYMENT_CODE_PREFIX.length + 1 + 154 + 6;
const PAYMENT_CODE_FORM: Form = { prefix: PAYMENT_CODE_PREFIX, payloadLength: PAYMENT_CODE_PAYLOAD_LENGTH, what: "payment code" };

/**
 * The wallet's payment code number `index`. Its secret follows from the
 * wallet's keys and the index alone ({@link paymentCodeSecret}), so nothing
 * has to be stored to recognise a note paid to it later. Hand out codes with
 * `issuePaymentCode`, which keeps count and stays within the range a restored
 * wallet looks at; this function has no such guard.
 *
 * @throws LochError `INVALID_ARGUMENT` for an index outside 0 to 2^32 - 1.
 */
export function paymentCodeAt(keys: Pick<LochKeys, "publicKey" | "encryptionPublic" | "paymentCodeRoot">, index: number): PaymentCode {
  return { publicKey: keys.publicKey, encryptionPublic: keys.encryptionPublic, secret: paymentCodeSecret(keys.paymentCodeRoot, index) };
}

/**
 * Encodes a payment code. The result contains the secret: treat it like the
 * message it travels in.
 *
 * @throws LochError `INVALID_ARGUMENT` if either key would not make a valid
 *   address or the secret is not 32 bytes.
 */
export function encodePaymentCode(code: PaymentCode): string {
  if (!(code.secret instanceof Uint8Array) || code.secret.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "a payment code secret must be 32 bytes");
  }
  return bech32m.encode(PAYMENT_CODE_PREFIX, bech32m.toWords(concatBytes(addressPayload(code), code.secret)), PAYMENT_CODE_LENGTH);
}

/**
 * Decodes a payment code. The same rules as for an address: one case, the
 * prefix "lochpay", a bech32m checksum, a 96-byte payload, and two keys that
 * would make a valid address.
 *
 * @throws AddressError with the `reason` values of {@link decodeShieldedAddress}.
 */
export function decodePaymentCode(text: string): PaymentCode {
  const payload = decodePayload(text, PAYMENT_CODE_FORM);
  return { ...addressOf(payload, PAYMENT_CODE_FORM.what), secret: copyBytes(payload, 64, 96) };
}

/** True when `text` decodes as a payment code. Never throws. */
export function isPaymentCode(text: string): boolean {
  try {
    decodePaymentCode(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decodes what a payer was given: a payment code if the text has the prefix
 * "lochpay", a shielded address otherwise. A payment code is recognised by its
 * `secret`.
 *
 * @throws AddressError as {@link decodeShieldedAddress} and {@link decodePaymentCode} do.
 */
export function decodeRecipient(text: string): ShieldedAddress | PaymentCode {
  return typeof text === "string" && prefixOf(text) === PAYMENT_CODE_PREFIX ? decodePaymentCode(text) : decodeShieldedAddress(text);
}
