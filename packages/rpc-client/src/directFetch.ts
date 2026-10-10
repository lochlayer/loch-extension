// The non-oblivious path: a fetch that talks to the service directly, with
// the same request hygiene as the oblivious one. The service sees the
// client's IP address together with every request; use it only where that is
// acceptable (a node you run yourself, local development, a fallback the user
// chose).

import { RpcClientError } from "./errors.js";
import { type FetchLike, PRIVATE_REQUEST_INIT, headerAllowlist, isLoopbackHost, limit, platformFetch, readRequest, withDeadline } from "./http.js";

/** Options of {@link createDirectFetch}. */
export interface DirectFetchOptions {
  /** Transport. Default: the global `fetch`. */
  fetch?: FetchLike;
  /**
   * Request headers that are passed on. Default `content-type` and `accept`.
   * Everything else a caller sets is dropped, so all clients look alike.
   */
  forwardHeaders?: readonly string[];
  /** Milliseconds to wait for the response headers. Default 30,000. 0 disables the deadline. */
  timeoutMs?: number;
  /**
   * Send to `http://` URLs of hosts other than this machine. Default false:
   * plain HTTP lets anyone on the path read the queries and rewrite the
   * answers.
   */
  allowInsecureHttp?: boolean;
}

/**
 * Returns a function with the signature of `fetch` that sends each request
 * straight to its URL: no cookies, no referrer, no cache, no redirects, and
 * only allowlisted headers.
 *
 * Privacy: the service sees the client's IP address with every request.
 * {@link createOhttpFetch} hides it.
 *
 * The URL must be `https://`; `http://` is accepted for localhost only,
 * unless `allowInsecureHttp` is set.
 *
 * Rejects with an {@link RpcClientError} (`network_error`, `timeout`,
 * `unsupported_request`); an abort rejects with the caller's abort reason.
 */
export function createDirectFetch(options: DirectFetchOptions = {}): FetchLike {
  if (typeof options !== "object" || options === null) throw new RpcClientError("invalid_argument", "options must be an object");
  const transport = options.fetch ?? platformFetch;
  const allowed = headerAllowlist(options.forwardHeaders);
  const timeoutMs = limit(options.timeoutMs, 30_000, "timeoutMs");
  const allowInsecureHttp = options.allowInsecureHttp === true;

  return async function directFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = await readRequest(input, init, allowed);
    if (request.url.protocol === "http:" && !allowInsecureHttp && !isLoopbackHost(request.url.hostname)) {
      throw new RpcClientError("unsupported_request", "plain http:// is accepted only for localhost, or with the allowInsecureHttp option");
    }
    return withDeadline(request.signal, timeoutMs, (deadline) =>
      transport(request.url.href, {
        ...PRIVATE_REQUEST_INIT,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body.length > 0 ? request.body : undefined,
        // Both signals where the platform can combine them: the deadline ends
        // with the response headers, but a caller may still abort while
        // reading the body.
        signal: request.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([request.signal, deadline]) : deadline,
      }),
    );
  };
}
