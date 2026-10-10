// Length padding.
//
// Oblivious HTTP hides what a message says, not how long it is: the relay and
// anyone watching the network see the size of every encapsulated request and
// response, and sizes tell queries apart (a balance lookup is a few hundred
// bytes, a transaction submission is about two kilobytes, a history page is
// hundreds of kilobytes). RFC 9458 leaves padding to the application.
//
// Here every Binary HTTP message is padded with zero bytes (RFC 9292, section
// 3.8) up to the smallest bucket that holds it, before it is encrypted. A
// message longer than the largest bucket is padded to the next multiple of
// that bucket. What still leaks is the bucket: see docs/rpc-proxy.md.

import { RpcClientError } from "./errors.js";

/**
 * Default buckets for requests, in bytes of the padded Binary HTTP message.
 * The smallest holds every read call and a full-size transaction submission
 * alike, so the two cannot be told apart by size.
 */
export const DEFAULT_REQUEST_PADDING_BUCKETS: readonly number[] = [4096, 16384, 65536, 262144];

/** Default buckets for responses, in bytes of the padded Binary HTTP message. */
export const DEFAULT_RESPONSE_PADDING_BUCKETS: readonly number[] = [4096, 16384, 65536, 262144, 1048576, 4194304];

/** Largest bucket accepted, so a typo cannot ask for gigabytes of zeros. */
const MAX_BUCKET = 64 * 1024 * 1024;

/**
 * Checks a bucket list and returns it sorted, without duplicates. An empty
 * list means no padding. Throws an {@link RpcClientError} (`invalid_argument`)
 * unless every bucket is an integer from 1 to 64 MiB.
 */
export function normaliseBuckets(buckets: readonly number[]): number[] {
  if (!Array.isArray(buckets) || !buckets.every((size) => Number.isInteger(size) && size >= 1 && size <= MAX_BUCKET)) {
    throw new RpcClientError("invalid_argument", "padding buckets must be integers from 1 to 67108864 bytes");
  }
  return [...new Set(buckets)].sort((a, b) => a - b);
}

/**
 * The length a message of `length` bytes is padded to: the smallest bucket
 * that holds it, or the next multiple of the largest bucket. `buckets` must be
 * sorted ascending (see {@link normaliseBuckets}); with no buckets the length
 * is returned unchanged.
 */
export function paddedLength(length: number, buckets: readonly number[]): number {
  const largest = buckets[buckets.length - 1];
  if (largest === undefined) return length;
  for (const size of buckets) if (length <= size) return size;
  return Math.ceil(length / largest) * largest;
}

/** `message` followed by zero bytes up to its padded length. */
export function padMessage(message: Uint8Array, buckets: readonly number[]): Uint8Array {
  const target = paddedLength(message.length, buckets);
  if (target === message.length) return message;
  const out = new Uint8Array(target);
  out.set(message);
  return out;
}
