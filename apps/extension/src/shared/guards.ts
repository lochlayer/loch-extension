// Small runtime type guards. Everything that crosses a context boundary is `unknown` until one
// of these has looked at it.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

export function isNonEmptyString(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** True when `value` has exactly the keys in `allowed` or a subset of them, and no others. */
export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) return false;
  return true;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** A base58 string of the length a 32-byte public key encodes to. Not a curve check. */
export function isBase58Address(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 44 && BASE58.test(value);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isBase64(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && BASE64.test(value);
}

const DECIMAL = /^(0|[1-9][0-9]{0,29})$/;

/** A non-negative integer as a decimal string, as lamports travel between contexts. */
export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}
