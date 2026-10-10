// Byte helpers. Uint8Array only: no Buffer, no Node APIs.

/** A Uint8Array that owns a plain ArrayBuffer, which is what Web Crypto and fetch accept. */
export type Bytes = Uint8Array<ArrayBuffer>;

const HEX = "0123456789abcdef";
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Lowercase hex of `bytes`. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

/** Parses hex (either case, no prefix). Throws on odd length or a non-hex character. */
export function hexToBytes(hex: string): Bytes {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError("expected an even-length hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Standard base64 with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64[a >> 2]!;
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : BASE64[c & 63]!;
  }
  return out;
}

/** Parses base64 or base64url, with or without padding. Throws on anything else. */
export function base64ToBytes(text: string): Bytes {
  if (typeof text !== "string") throw new TypeError("expected a base64 string");
  const clean = text.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new TypeError("expected a base64 string");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (buffer >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, otherwise two different strings would decode to the same bytes.
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new TypeError("expected a base64 string");
  return out;
}

/** Bytes given as a Uint8Array, as hex, or as base64 / base64url. A string of hex digits only is read as hex. */
export function toBytes(value: Uint8Array | string): Bytes {
  if (typeof value === "string") {
    return /^[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0 ? hexToBytes(value) : base64ToBytes(value);
  }
  return new Uint8Array(value);
}

/** Concatenates byte arrays into a new plain Uint8Array. */
export function concatBytes(...parts: Uint8Array[]): Bytes {
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

/** ASCII bytes of `text`. Throws on a character outside 0x00..0x7f. */
export function asciiToBytes(text: string): Bytes {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new TypeError("expected ASCII text");
    out[i] = code;
  }
  return out;
}

/** One byte per character (ISO 8859-1), the encoding HTTP field values use. Throws on a character above 0xff. */
export function latin1ToBytes(text: string): Bytes {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new TypeError("expected ISO 8859-1 text");
    out[i] = code;
  }
  return out;
}

/** The reverse of {@link latin1ToBytes}. */
export function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}
