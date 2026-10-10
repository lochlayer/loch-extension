// Tiny fetch-based clients for the relayer and the screening service.

import {
  type RelayRequest,
  type RelayResponse,
  type RelayerInfo,
  type ScreenRequest,
  type ScreenResponse,
  type ScreenerInfo,
  WireError,
  type WireNetworkErrorReason,
  type WireResult,
} from "./types.js";
import {
  validateErrorBody,
  validateRelayResponse,
  validateRelayerInfo,
  validateScreenResponse,
  validateScreenerInfo,
} from "./validate.js";

/** What the clients pass to `fetch`. */
export interface WireRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** Aborts when the caller's signal does or when the client's timeout expires. */
  signal?: AbortSignal;
  /** Always "omit": no cookies. */
  credentials: "omit";
  /** Always "no-referrer". */
  referrerPolicy: "no-referrer";
  /** Always "no-store". */
  cache: "no-store";
  /** Always "error": a redirect could send the request to another host. */
  redirect: "error";
}

/** The part of a `Response` the clients read. A platform `Response` fits. */
export interface WireResponse {
  status: number;
  /** The whole body as text. Used only when there is no `body` stream. */
  text(): Promise<string>;
  /** Response headers, if the transport has them: an oversized `content-length` is refused before reading. */
  headers?: { get(name: string): string | null };
  /** The body as a byte stream, if the transport has one: read with a running count and cancelled past the cap. */
  body?: ReadableStream<Uint8Array> | null;
}

/**
 * The transport. The platform `fetch` fits, and so does any function of this
 * shape, for example one that tunnels the request through Oblivious HTTP so
 * the service never sees the client's IP address.
 */
export type WireFetch = (url: string, init: WireRequestInit) => Promise<WireResponse>;

/** Options of {@link RelayerClient} and {@link ScreenerClient}. */
export interface WireClientOptions {
  /** Transport. Default: the global `fetch`. */
  fetch?: WireFetch;
  /** Extra headers for every request. Do not put identifying values here. */
  headers?: Record<string, string>;
  /**
   * Accept an `http://` URL for a host that is not this machine. Default
   * false: plain HTTP lets anyone on the path read the requests and rewrite
   * the answers, including the relayer's key and fee. Meant for transports
   * that protect the request themselves (a Tor onion service, a private test
   * network).
   */
  allowInsecureHttp?: boolean;
  /** Milliseconds to wait for an answer before failing with `network_error` (`reason: "timeout"`). Default 30,000. 0 disables the timeout. */
  timeoutMs?: number;
  /**
   * The same for `RelayerClient.relay`, which answers only once the
   * transaction is confirmed. Default 120,000. 0 disables the timeout.
   */
  relayTimeoutMs?: number;
}

/** Largest response body the clients accept, in bytes. */
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RELAY_TIMEOUT_MS = 120_000;

const oversized = (status: number) => new WireError("bad_response", "the service sent an oversized response", status);

/**
 * True for hosts that are this machine: plain HTTP to them never leaves it.
 * `localhost`, 127.0.0.0/8 and `[::1]`, as docs/protocol.md section 14 lists
 * them. Names under `.localhost` are NOT included: browsers pin them to the
 * loopback interface, but Node resolves them through the system resolver, and
 * where that asks DNS the answer is whatever the network says.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Reads a response body as text without ever holding more than the cap: by
 * `content-length` when the transport reports one, then by counting the bytes
 * of the stream. A transport without a stream is read with `text()` and
 * checked afterwards, which bounds what is parsed but not what was buffered.
 */
async function readBody(response: WireResponse): Promise<string> {
  const declared = Number(response.headers?.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw oversized(response.status);
  }
  const stream = response.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw oversized(response.status);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) throw oversized(response.status);
  return raw;
}

/** The `name` and the system error `code` of whatever a transport threw, if it has them. Nothing else of it is looked at. */
function errorTag(value: unknown): { name: string; code: string } {
  if (typeof value !== "object" || value === null) return { name: "", code: "" };
  const { name, code } = value as { name?: unknown; code?: unknown };
  return { name: typeof name === "string" ? name : "", code: typeof code === "string" ? code : "" };
}

/**
 * Classifies a transport failure by what kind of error the transport threw:
 * its `name`, and the system error code where the platform gives one (Node
 * wraps the socket's error as the `cause` of "fetch failed"). The error's
 * text is not read, and nothing of it ends up in the result.
 *
 * `responded` is true when the failure came after the response had started:
 * the service was reached then, whatever broke afterwards.
 */
function networkErrorReason(cause: unknown, responded: boolean): WireNetworkErrorReason {
  const outer = errorTag(cause);
  const inner = errorTag(typeof cause === "object" && cause !== null ? (cause as { cause?: unknown }).cause : undefined);
  // `AbortSignal.timeout` in a transport of the caller's, and the timeouts of Node's own fetch.
  if (outer.name === "TimeoutError" || [outer.code, inner.code].some((code) => /TIMEDOUT|TIMEOUT/.test(code))) return "timeout";
  if (outer.name === "AbortError") return "aborted";
  // What `fetch` rejects with when it gets no response: a TypeError, in every platform.
  if (!responded && (cause instanceof TypeError || outer.name === "TypeError")) return "unreachable";
  return "other";
}

function timeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new WireError("invalid_request", "a timeout must be a non-negative number of milliseconds");
  }
  return value;
}

class WireClient {
  private readonly base: string;
  private readonly fetch: WireFetch;
  private readonly headers: Record<string, string>;
  protected readonly timeoutMs: number;
  protected readonly relayTimeoutMs: number;

  constructor(baseUrl: string, options: WireClientOptions = {}) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new WireError("invalid_request", "the service URL must be an absolute https:// URL");
    }
    if (url.protocol === "http:") {
      if (!options.allowInsecureHttp && !isLoopbackHost(url.hostname)) {
        throw new WireError(
          "invalid_request",
          "the service URL must use https://: plain http:// is accepted only for localhost, 127.0.0.0/8 and [::1], or with the allowInsecureHttp option",
        );
      }
    } else if (url.protocol !== "https:") {
      throw new WireError("invalid_request", "the service URL must be an absolute https:// URL");
    }
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? ((target, init) => fetch(target, init));
    this.headers = { ...options.headers };
    this.timeoutMs = timeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.relayTimeoutMs = timeout(options.relayTimeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  }

  protected async call<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    validate: (value: unknown) => WireResult<T>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.headers, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";

    // One signal for the transport: the caller's, or the timeout, whichever comes first.
    signal?.throwIfAborted();
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forward, { once: true });
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort(new WireError("network_error", "the service did not answer in time", null, { reason: "timeout" }));
          }, timeoutMs)
        : undefined;

    // The transport is asked to stop through the signal; this rejects in any
    // case, so a transport that ignores the signal cannot hold the call forever.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    aborted.catch(() => undefined);

    let status: number;
    let raw: string;
    // True once the transport has delivered the start of a response.
    let responded = false;
    try {
      const exchange = async () => {
        const response = await this.fetch(this.base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
        });
        responded = true;
        return { status: response.status, raw: await readBody(response) };
      };
      const pending = exchange();
      // If the abort wins the race, whatever the transport does afterwards is of no interest.
      pending.catch(() => undefined);
      ({ status, raw } = await Promise.race([pending, aborted]));
    } catch (cause) {
      if (signal?.aborted) throw cause;
      if (timedOut) {
        throw new WireError("network_error", `the service did not answer within ${Math.round(timeoutMs / 1000)} seconds`, null, { cause, reason: "timeout" });
      }
      if (cause instanceof WireError) throw cause;
      // The message stays what it was; `reason` is where the kinds of failure are told apart.
      throw new WireError("network_error", "the service could not be reached", null, { cause, reason: networkErrorReason(cause, responded) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new WireError("bad_response", `the service sent a response that is not JSON (HTTP ${status})`, status);
    }
    if (status < 200 || status >= 300) {
      const failure = validateErrorBody(json);
      if (!failure.ok) throw new WireError("bad_response", `the service sent a malformed error (HTTP ${status})`, status);
      throw new WireError(failure.value.error.code, failure.value.error.message, status);
    }
    const result = validate(json);
    if (!result.ok) throw new WireError("bad_response", result.error.message, status);
    return result.value;
  }
}

/**
 * Client of a Loch relayer. Every method rejects with a {@link WireError}
 * whose `code` is the service's error code, `network_error` (no answer, or
 * none within the timeout) or `bad_response`. Responses are validated before
 * they are returned, and at most 64 KiB of a response is read.
 *
 * A `network_error` carries a `reason`: `timeout`, `unreachable`, `aborted`
 * or `other` ({@link WireNetworkErrorReason}). An abort through the caller's
 * own `signal` is not turned into a `WireError`: the call rejects with the
 * signal's reason, as before.
 *
 * The URL must be `https://`; `http://` is accepted for this machine only
 * (`localhost`, `127.0.0.0/8`, `[::1]`), unless `allowInsecureHttp` is set.
 *
 * What the relayer answers is the relayer's claim. In particular
 * `info().feeLamports` is the fee it asks for, not a fee the user agreed to:
 * pass it to the `prepare*` functions together with a `maxFee` of your own.
 *
 * Privacy: the relayer sees the client's IP address unless `fetch` hides it.
 */
export class RelayerClient extends WireClient {
  /** `GET /v1/info`: the relayer's key, fee and limits. */
  info(signal?: AbortSignal): Promise<RelayerInfo> {
    return this.call("GET", "/v1/info", undefined, validateRelayerInfo, signal, this.timeoutMs);
  }

  /**
   * `POST /v1/relay`: submits a transfer or withdrawal (`toRelayRequest(prepared.args)`).
   * Resolves with the transaction id once the transaction is confirmed.
   * On `unknown_root`, sync and prepare again. On `not_confirmed` or
   * `network_error` the transaction may still land: sync, and look at whether
   * the notes it spends are spent, before retrying.
   */
  relay(request: RelayRequest, signal?: AbortSignal): Promise<RelayResponse> {
    return this.call("POST", "/v1/relay", request, validateRelayResponse, signal, this.relayTimeoutMs);
  }
}

/**
 * Client of a Loch screening service. Rejects with a {@link WireError} like
 * {@link RelayerClient}, and has the same rules for the URL, the timeout and
 * the response size.
 *
 * Privacy: a deposit is public anyway, but the screener also sees the
 * client's IP address unless `fetch` hides it.
 */
export class ScreenerClient extends WireClient {
  /** `GET /v1/info`: the screening authority's key, cap and policy. */
  info(signal?: AbortSignal): Promise<ScreenerInfo> {
    return this.call("GET", "/v1/info", undefined, validateScreenerInfo, signal, this.timeoutMs);
  }

  /**
   * `POST /v1/screen`: asks the screening authority to co-sign a deposit
   * (`toScreenRequest(transaction)`). Apply the answer with
   * `applyScreenerSignature`, then let the wallet sign.
   */
  screen(request: ScreenRequest, signal?: AbortSignal): Promise<ScreenResponse> {
    return this.call("POST", "/v1/screen", request, validateScreenResponse, signal, this.timeoutMs);
  }
}
