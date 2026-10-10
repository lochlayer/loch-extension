/**
 * @loch/rpc-client: how a Loch client reaches the Loch RPC proxy.
 *
 * - {@link createOhttpFetch}: a `fetch` that sends every request as Oblivious
 *   HTTP (RFC 9458) through a relay, so the proxy sees requests without client
 *   IP addresses and the relay sees client IP addresses without requests.
 * - {@link createDirectFetch}: the same request hygiene without the relay.
 * - `@loch/rpc-client/web3`: a `@solana/web3.js` `Connection` over either.
 * - `@loch/rpc-client/protocol`: the Oblivious HTTP and Binary HTTP codecs,
 *   for a gateway or a relay.
 *
 * Runs in a page, in an extension service worker and in Node 22: Web Crypto
 * and `fetch` only. No telemetry, no logging, no storage; the only network
 * requests are the ones a caller makes through the returned functions, plus
 * the key configuration fetch if `keyConfigUrl` is set.
 *
 * Devnet only, unaudited.
 */

export { createOhttpFetch } from "./ohttpFetch.js";
export type { OhttpFetchOptions, PaddingOptions } from "./ohttpFetch.js";
export { createDirectFetch } from "./directFetch.js";
export type { DirectFetchOptions } from "./directFetch.js";
export { RpcClientError } from "./errors.js";
export type { RpcClientErrorCode } from "./errors.js";
export { DEFAULT_FORWARD_HEADERS } from "./http.js";
export type { FetchLike } from "./http.js";
export { DEFAULT_REQUEST_PADDING_BUCKETS } from "./padding.js";
export { describeKeyConfigs } from "./describe.js";
export type { KeyConfigDescription } from "./describe.js";
