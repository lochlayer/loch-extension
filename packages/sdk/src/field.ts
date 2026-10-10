// BN254 scalar-field helpers and the public amount, exactly as
// programs/loch_pool/src/field.rs computes it.

import { bigIntToBytesBE, bytesToBigIntBE } from "./bytes.js";
import { FIELD_MODULUS, MAX_AMOUNT } from "./constants.js";
import { LochError } from "./errors.js";

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** A 32-byte big-endian field element or the same value as a bigint. */
export type FieldLike = bigint | Uint8Array;

/** `x mod m`, always in `[0, m)`. Default modulus: the scalar field r. */
export function mod(x: bigint, m: bigint = FIELD_MODULUS): bigint {
  const v = x % m;
  return v < 0n ? v + m : v;
}

/** Throws unless `0 <= value < r`. Returns the value. */
export function assertField(value: bigint, name = "value"): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= FIELD_MODULUS) {
    throw new LochError("INVALID_ARGUMENT", `${name} is not a field element (0 <= x < r)`);
  }
  return value;
}

/** Throws unless `0 <= value < 2^64`. Returns the value. */
export function assertAmount(value: bigint, name = "amount"): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_AMOUNT) {
    throw new LochError("INVALID_ARGUMENT", `${name} must be a bigint with 0 <= x < 2^64 (lamports)`);
  }
  return value;
}

/** Field element to its 32-byte big-endian form, the encoding the program uses everywhere. */
export function fieldToBytes(value: bigint): Uint8Array {
  return bigIntToBytesBE(assertField(value, "field element"), 32);
}

/** 32 big-endian bytes to a field element. Throws on a wrong length or a value >= r. */
export function bytesToField(bytes: Uint8Array): bigint {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "expected 32 bytes");
  }
  return assertField(bytesToBigIntBE(bytes), "field element");
}

/** Accepts a field element as bigint or as 32 big-endian bytes. */
export function toField(value: FieldLike): bigint {
  return typeof value === "bigint" ? assertField(value, "field element") : bytesToField(value);
}

/**
 * The circuit's `publicAmount`: `(extAmount - fee) mod r`, negative values as
 * `r - |x|`. `extAmount` is an i64 (positive deposit, negative withdrawal, zero
 * transfer) and `fee` a u64, as in the program's `ExtData`.
 */
export function publicAmountField(extAmount: bigint, fee: bigint): bigint {
  if (typeof extAmount !== "bigint" || extAmount < I64_MIN || extAmount > I64_MAX) {
    throw new LochError("INVALID_ARGUMENT", "extAmount must be a bigint that fits in a signed 64-bit integer");
  }
  assertAmount(fee, "fee");
  return mod(extAmount - fee);
}
