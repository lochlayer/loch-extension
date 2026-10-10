// Byte helpers shared by every module. Uint8Array only: no Buffer, no Node APIs.

import { base64 } from "@scure/base";

const HEX = "0123456789abcdef";

/** Lowercase hex of `bytes`. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

/** Parses hex (either case, no prefix). Throws on odd length or a non-hex character. */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError("expected an even-length hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

/** Parses standard base64 with padding. Throws on anything else. */
export function base64ToBytes(text: string): Uint8Array {
  return base64.decode(text);
}

/** Concatenates byte arrays into a new plain Uint8Array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** True when both arrays hold the same bytes. Not constant time; use only on public data. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A copy of `bytes[start, end)` as a plain Uint8Array. Buffers handed over by
 * web3.js are Uint8Array subclasses whose `slice` aliases memory; this never does.
 */
export function copyBytes(bytes: Uint8Array, start = 0, end = bytes.length): Uint8Array {
  return new Uint8Array(bytes.subarray(start, end));
}

/** Big-endian bytes to a non-negative bigint. */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** Non-negative bigint to exactly `length` big-endian bytes. Throws if it does not fit. */
export function bigIntToBytesBE(value: bigint, length = 32): Uint8Array {
  if (typeof value !== "bigint" || value < 0n) throw new RangeError("expected a non-negative bigint");
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`value does not fit in ${length} bytes`);
  return out;
}

/** Non-negative bigint to exactly `length` little-endian bytes. Throws if it does not fit. */
export function bigIntToBytesLE(value: bigint, length: number): Uint8Array {
  return bigIntToBytesBE(value, length).reverse();
}

/** Little-endian bytes to a non-negative bigint. */
export function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

/** `length` bytes from the platform CSPRNG (`crypto.getRandomValues`). */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Sequential reader over a byte array; every read is bounds-checked. */
export class ByteReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  /** Bytes not read yet. */
  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  /** The next `length` bytes, copied. */
  take(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining) {
      throw new RangeError("unexpected end of data");
    }
    const out = copyBytes(this.bytes, this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u32(): number {
    return Number(bytesToBigIntLE(this.take(4)));
  }

  u64(): bigint {
    return bytesToBigIntLE(this.take(8));
  }

  i64(): bigint {
    return BigInt.asIntN(64, this.u64());
  }

  /** Borsh `Vec<u8>`: u32 little-endian length, then the bytes. */
  vec(maxLength: number): Uint8Array {
    const length = this.u32();
    if (length > maxLength) throw new RangeError("byte vector longer than allowed");
    return this.take(length);
  }
}
