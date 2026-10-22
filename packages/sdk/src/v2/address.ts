// Encodings of v2 addresses, payment codes and viewing keys (docs/v2.md
// section 5). bech32m, as v1. Addresses and payment codes keep v1's prefixes and
// differ in length (80 and 112 bytes against 64 and 96), so a v1 client refuses
// a v2 string as "wrong length" and a v2 client tells the two apart.
//
//   address        loch     d (16) || owner (32 BE) || pk (32)               139 characters
//   payment code   lochpay  address payload || secret (32)                  194 characters
//   full view key  lochfvk  ak || nk || ivk (32 LE) || dk || selfNoteKey
//                           || paymentCodeRoot                               322 characters
//   incoming key   lochivk  ownerRoot || ivk (32 LE) || dk || selfNoteKey
//                           || paymentCodeRoot                               270 characters

import { bech32m } from "@scure/base";
import { poseidon2 } from "poseidon-lite/poseidon2";

import { type Form, type PaymentCode, type ShieldedAddress, decodePayload, decodePaymentCode, decodeShieldedAddress } from "../address.js";
import { bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntBE, bytesToBigIntLE, concatBytes, copyBytes } from "../bytes.js";
import { ADDRESS_PREFIX, FIELD_MODULUS, PAYMENT_CODE_PREFIX } from "../constants.js";
import { AddressError, LochError } from "../errors.js";
import { DIVERSIFIER_LENGTH, FULL_VIEWING_KEY_PREFIX, INCOMING_VIEWING_KEY_PREFIX, RISTRETTO_ORDER } from "./constants.js";
import type { FullViewingKey, IncomingViewingKey, PaymentCodeV2, ShieldedAddressV2 } from "./keys.js";
import { isValidTransmissionKey } from "./note.js";

const ADDRESS_PAYLOAD = 80;
const CODE_PAYLOAD = 112;
const FVK_PAYLOAD = 192;
const IVK_PAYLOAD = 160;

const lengthOf = (prefix: string, payload: number) => prefix.length + 1 + Math.ceil((payload * 8) / 5) + 6;

const ADDRESS_FORM: Form = { prefix: ADDRESS_PREFIX, payloadLength: ADDRESS_PAYLOAD, what: "shielded address" };
const CODE_FORM: Form = { prefix: PAYMENT_CODE_PREFIX, payloadLength: CODE_PAYLOAD, what: "payment code" };
const FVK_FORM: Form = { prefix: FULL_VIEWING_KEY_PREFIX, payloadLength: FVK_PAYLOAD, what: "full viewing key" };
const IVK_FORM: Form = { prefix: INCOMING_VIEWING_KEY_PREFIX, payloadLength: IVK_PAYLOAD, what: "incoming viewing key" };

function encode(form: Form, payload: Uint8Array): string {
  return bech32m.encode(form.prefix, bech32m.toWords(payload), lengthOf(form.prefix, form.payloadLength));
}

function addressPayload(address: ShieldedAddressV2): Uint8Array {
  const { d, owner, pk } = address;
  if (!(d instanceof Uint8Array) || d.length !== DIVERSIFIER_LENGTH) throw new LochError("INVALID_ARGUMENT", "a diversifier is 16 bytes");
  if (typeof owner !== "bigint" || owner < 0n || owner >= FIELD_MODULUS) throw new LochError("INVALID_ARGUMENT", "owner is not a field element");
  if (!isValidTransmissionKey(pk)) throw new LochError("INVALID_ARGUMENT", "pk is not a valid ristretto255 key");
  return concatBytes(d, bigIntToBytesBE(owner, 32), pk);
}

function addressOf(payload: Uint8Array, what: string): ShieldedAddressV2 {
  const owner = bytesToBigIntBE(payload.subarray(16, 48));
  if (owner >= FIELD_MODULUS) throw new AddressError("public_key_range", `${what} holds an owner outside the field`);
  const pk = copyBytes(payload, 48, 80);
  if (!isValidTransmissionKey(pk)) throw new AddressError("encryption_key", `${what} holds an encryption key that is not a valid ristretto255 key`);
  return { d: copyBytes(payload, 0, 16), owner, pk };
}

/** Encodes a v2 address (`loch1...`, 139 characters). */
export function encodeAddressV2(address: ShieldedAddressV2): string {
  return encode(ADDRESS_FORM, addressPayload(address));
}

/** Decodes a v2 address. @throws AddressError as v1's `decodeShieldedAddress`. */
export function decodeAddressV2(text: string): ShieldedAddressV2 {
  return addressOf(decodePayload(text, ADDRESS_FORM), ADDRESS_FORM.what);
}

/** Encodes a v2 payment code (`lochpay1...`, 194 characters). It contains the code's secret. */
export function encodePaymentCodeV2(code: PaymentCodeV2): string {
  if (!(code.secret instanceof Uint8Array) || code.secret.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "a payment code secret must be 32 bytes");
  }
  return encode(CODE_FORM, concatBytes(addressPayload(code), code.secret));
}

/** Decodes a v2 payment code. */
export function decodePaymentCodeV2(text: string): PaymentCodeV2 {
  const payload = decodePayload(text, CODE_FORM);
  return { ...addressOf(payload, CODE_FORM.what), secret: copyBytes(payload, 80, 112) };
}

/** A recipient of either version, as a payer was given it. */
export type AnyRecipient =
  | { version: 1; recipient: ShieldedAddress | PaymentCode }
  | { version: 2; recipient: ShieldedAddressV2 | PaymentCodeV2 };

/** The bech32m payload length of `text`, or null. */
function payloadLength(text: string): number | null {
  try {
    const lower = text.toLowerCase() as `${string}1${string}`;
    return bech32m.fromWords(bech32m.decode(lower, 1023).words).length;
  } catch {
    return null;
  }
}

/**
 * Decodes an address or payment code of either version: `loch1...` /
 * `lochpay1...`, told apart by length.
 *
 * @throws AddressError as the decoders of each version.
 */
export function decodeAnyRecipient(text: string): AnyRecipient {
  const length = typeof text === "string" ? payloadLength(text) : null;
  const isCode = typeof text === "string" && text.toLowerCase().startsWith(`${PAYMENT_CODE_PREFIX}1`);
  if (length === (isCode ? CODE_PAYLOAD : ADDRESS_PAYLOAD)) {
    return { version: 2, recipient: isCode ? decodePaymentCodeV2(text) : decodeAddressV2(text) };
  }
  return { version: 1, recipient: isCode ? decodePaymentCode(text) : decodeShieldedAddress(text) };
}

/** True when `text` is a v2 address or payment code. Never throws. */
export function isRecipientV2(text: string): boolean {
  try {
    return decodeAnyRecipient(text).version === 2;
  } catch {
    return false;
  }
}

function secret32(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new LochError("INVALID_ARGUMENT", `${name} is 32 bytes`);
  return value;
}

function scalarBytes(ivk: bigint): Uint8Array {
  if (typeof ivk !== "bigint" || ivk <= 0n || ivk >= RISTRETTO_ORDER) throw new LochError("INVALID_ARGUMENT", "ivk is not a ristretto255 scalar");
  return bigIntToBytesLE(ivk, 32);
}

function fieldBytes(value: bigint, name: string): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value >= FIELD_MODULUS) throw new LochError("INVALID_ARGUMENT", `${name} is not a field element`);
  return bigIntToBytesBE(value, 32);
}

/** Encodes a full viewing key (`lochfvk1...`). Secret: it shows every note and every spend. */
export function encodeFullViewingKey(key: FullViewingKey): string {
  const payload = concatBytes(
    fieldBytes(key.ak, "ak"),
    fieldBytes(key.nk, "nk"),
    scalarBytes(key.ivk),
    secret32(key.dk, "dk"),
    secret32(key.selfNoteKey, "selfNoteKey"),
    secret32(key.paymentCodeRoot, "paymentCodeRoot"),
  );
  const text = encode(FVK_FORM, payload);
  payload.fill(0);
  return text;
}

function readScalar(bytes: Uint8Array, what: string): bigint {
  const ivk = bytesToBigIntLE(bytes);
  if (ivk === 0n || ivk >= RISTRETTO_ORDER) throw new AddressError("encryption_key", `${what} holds a decryption key outside the scalar range`);
  return ivk;
}

function readField(bytes: Uint8Array, what: string): bigint {
  const value = bytesToBigIntBE(bytes);
  if (value >= FIELD_MODULUS) throw new AddressError("public_key_range", `${what} holds a value outside the field`);
  return value;
}

/** Decodes a full viewing key. */
export function decodeFullViewingKey(text: string): FullViewingKey {
  const payload = decodePayload(text, FVK_FORM);
  const ak = readField(payload.subarray(0, 32), FVK_FORM.what);
  const nk = readField(payload.subarray(32, 64), FVK_FORM.what);
  // ownerRoot is not in the key: it follows from ak and nk.
  return {
    ak,
    nk,
    ownerRoot: poseidon2([ak, nk]),
    ivk: readScalar(payload.subarray(64, 96), FVK_FORM.what),
    dk: copyBytes(payload, 96, 128),
    selfNoteKey: copyBytes(payload, 128, 160),
    paymentCodeRoot: copyBytes(payload, 160, 192),
  };
}

/** Encodes an incoming viewing key (`lochivk1...`). Secret: it shows every note the wallet receives. */
export function encodeIncomingViewingKey(key: IncomingViewingKey): string {
  const payload = concatBytes(
    fieldBytes(key.ownerRoot, "ownerRoot"),
    scalarBytes(key.ivk),
    secret32(key.dk, "dk"),
    secret32(key.selfNoteKey, "selfNoteKey"),
    secret32(key.paymentCodeRoot, "paymentCodeRoot"),
  );
  const text = encode(IVK_FORM, payload);
  payload.fill(0);
  return text;
}

/** Decodes an incoming viewing key. */
export function decodeIncomingViewingKey(text: string): IncomingViewingKey {
  const payload = decodePayload(text, IVK_FORM);
  return {
    ownerRoot: readField(payload.subarray(0, 32), IVK_FORM.what),
    ivk: readScalar(payload.subarray(32, 64), IVK_FORM.what),
    dk: copyBytes(payload, 64, 96),
    selfNoteKey: copyBytes(payload, 96, 128),
    paymentCodeRoot: copyBytes(payload, 128, 160),
  };
}

