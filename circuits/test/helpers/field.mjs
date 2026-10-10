// BN254 field constants and byte helpers for the reference implementation.

import { randomBytes } from 'node:crypto';

/** BN254 scalar field modulus r (the circuit's field; called p in circom). */
export const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** BN254 base field modulus q (coordinates of curve points). */
export const BASE_FIELD_SIZE =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export const mod = (x, m = FIELD_SIZE) => ((x % m) + m) % m;

/**
 * publicAmount exactly as programs/loch_pool/src/field.rs computes it:
 * ext_amount - fee, with negative values encoded as r - |x|.
 */
export function publicAmount(extAmount, fee) {
  return mod(BigInt(extAmount) - BigInt(fee));
}

/** 32-byte big-endian encoding. Throws if the value does not fit. */
export function toBytesBE(value, length = 32) {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError('negative value');
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`value does not fit in ${length} bytes`);
  return out;
}

export function fromBytesBE(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export const toHex = (bytes) => Buffer.from(bytes).toString('hex');
export const fromHex = (hex) => new Uint8Array(Buffer.from(hex, 'hex'));

/** Uniform 248-bit value: always below r, which is all a key or blinding needs here. */
export function randomFieldElement() {
  return fromBytesBE(randomBytes(31));
}
