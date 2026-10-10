// What the two fetch wrappers share: URL rules, the request they hand to the
// platform, deadlines and bounded reads.

import type { Bytes } from "./bytes.js";
import { RpcClientError } from "./errors.js";

/** The platform `fetch`, or anything with its signature. */
export type FetchLike = typeof fetch;

/** Request headers that are passed on. Everything else a caller sets is dropped. */
export const DEFAULT_FORWARD_HEADERS: readonly string[] = ["content-type", "accept"];

/** Fields that keep the platform from attaching or revealing anything about the page that made the request. */
export const PRIVATE_REQUEST_INIT = {
  credentials: "omit",
  referrerPolicy: "no-referrer",
  cache: "no-store",
  redirect: "error",
  mode: "cors",
} as const satisfies RequestInit;

/** True for hosts that are this machine: plain HTTP to them never leaves it. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Parses a service URL given as an option. `https://` only; `http://` is
 * accepted for this machine, or anywhere with `allowInsecureHttp`.
 */
export function serviceUrl(value: unknown, what: string, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new RpcClientError("invalid_argument", `${what} must be an absolute https:// URL`);
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && (allowInsecureHttp || isLoopbackHost(url.hostname)));
  if (!secure || url.username !== "" || url.password !== "") {
    throw new RpcClientError(
      "invalid_argument",
      `${what} must be an https:// URL without credentials: plain http:// is accepted only for localhost, or with the allowInsecureHttp option`,
    );
  }
  return url;
}

/** Lowercase names from a header allowlist option. */
export function headerAllowlist(names: readonly string[] | undefined): Set<string> {
  const list = names ?? DEFAULT_FORWARD_HEADERS;
  if (!Array.isArray(list) || !list.every((name) => typeof name === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))) {
    throw new RpcClientError("invalid_argument", "forwardHeaders must be a list of header names");
  }
  return new Set(list.map((name) => name.toLowerCase()));
}

/** A non-negative finite number of milliseconds or bytes, or the default. */
export function limit(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RpcClientError("invalid_argument", `${what} must be a non-negative number`);
  }
  return value;
}

/** A request as the wrappers see it, with the body already in memory. */
export interface PlainRequest {
  url: URL;
  method: string;
  /** Allowlisted headers only, lowercase names. */
  headers: [string, string][];
  body: Bytes;
  signal: AbortSignal | undefined;
}

const isRequest = (input: unknown): input is Request =>
  typeof input === "object" && input !== null && typeof (input as Request).url === "string" && typeof (input as Request).arrayBuffer === "function";

const unsupported = (message: string) => new RpcClientError("unsupported_request", message);

/**
 * Normalises the arguments of a `fetch` call. Only allowlisted headers
 * survive; the body is read into memory (a stream or a form cannot be carried
 * and is refused).
 */
export async function readRequest(input: RequestInfo | URL, init: RequestInit | undefined, allowed: Set<string>): Promise<PlainRequest> {
  const source = isRequest(input) ? input : undefined;
  let url: URL;
  try {
    url = new URL(source ? source.url : String(input));
  } catch {
    throw unsupported("the request URL must be absolute");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
    throw unsupported("the request URL must be an http(s) URL without credentials");
  }
  const method = String(init?.method ?? source?.method ?? "GET").toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw unsupported("the request method is not valid");

  let merged: Headers;
  try {
    merged = new Headers(source?.headers);
    if (init?.headers) new Headers(init.headers).forEach((value, name) => merged.set(name, value));
  } catch {
    throw unsupported("the request headers are not valid");
  }

  let body: Bytes = new Uint8Array(0);
  let impliedType: string | undefined;
  const raw: unknown = init?.body ?? undefined;
  if (typeof raw === "string") {
    body = new TextEncoder().encode(raw);
    impliedType = "text/plain;charset=UTF-8";
  } else if (raw instanceof ArrayBuffer) {
    body = new Uint8Array(raw.slice(0));
  } else if (ArrayBuffer.isView(raw)) {
    body = new Uint8Array(raw.byteLength);
    body.set(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  } else if (raw instanceof URLSearchParams) {
    body = new TextEncoder().encode(raw.toString());
    impliedType = "application/x-www-form-urlencoded;charset=UTF-8";
  } else if (typeof Blob !== "undefined" && raw instanceof Blob) {
    body = new Uint8Array(await raw.arrayBuffer());
    impliedType = raw.type || undefined;
  } else if (raw !== undefined) {
    throw unsupported("the request body must be text or bytes: streams and forms cannot be carried");
  } else if (source && source.body !== null) {
    if (source.bodyUsed) throw unsupported("the request body was already read");
    body = new Uint8Array(await source.arrayBuffer());
  }
  if (body.length > 0 && (method === "GET" || method === "HEAD")) throw unsupported("a GET or HEAD request cannot have a body");
  if (impliedType && !merged.has("content-type")) merged.set("content-type", impliedType);

  const headers: [string, string][] = [];
  merged.forEach((value, name) => {
    if (allowed.has(name.toLowerCase())) headers.push([name.toLowerCase(), value]);
  });
  return { url, method, headers, body, signal: init?.signal ?? source?.signal ?? undefined };
}

/**
 * Runs `task` under one deadline and the caller's abort signal.
 *
 * - The caller aborts: rejects with the caller's own abort reason, as `fetch` does.
 * - The deadline passes: rejects with `timeout`.
 * - `task` fails with anything that is not an {@link RpcClientError}: rejects
 *   with `network_error`. The original error is dropped on purpose; it may
 *   describe the request.
 */
export async function withDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  // The transport is asked to stop through the signal; this rejects in any
  // case, so a transport that ignores the signal cannot hold the call forever.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new RpcClientError("timeout", "no answer in time")), { once: true });
  });
  aborted.catch(() => undefined);
  try {
    const pending = task(controller.signal);
    pending.catch(() => undefined);
    return await Promise.race([pending, aborted]);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timedOut) throw new RpcClientError("timeout", `no answer within ${Math.round(timeoutMs / 1000)} seconds`);
    if (error instanceof RpcClientError) throw error;
    throw new RpcClientError("network_error", "the service could not be reached");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

/** The media type of a response, lowercase, without parameters. */
export function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

/** Discards a response body without reading it. */
export async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to do: the body is gone either way.
  }
}

/**
 * Reads a response body without ever holding more than `maxBytes`: by
 * `content-length` when there is one, then by counting the bytes of the
 * stream. Rejects with `response_too_large` past the cap.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Bytes> {
  const tooLarge = () => new RpcClientError("response_too_large", "the answer is larger than the configured limit", response.status);
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    throw tooLarge();
  }
  const stream = response.body;
  if (!stream) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.length > maxBytes) throw tooLarge();
    return whole;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The platform `fetch`, looked up at call time so that a later replacement of the global is honoured. */
export const platformFetch: FetchLike = (input, init) => fetch(input, init);
