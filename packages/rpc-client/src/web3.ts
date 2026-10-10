/**
 * @loch/rpc-client/web3: a `@solana/web3.js` `Connection` that talks to the
 * Loch RPC proxy through one of this package's fetch functions and through
 * nothing else.
 *
 * A plain `new Connection(rpcUrl, { fetch })` sends its HTTP calls through
 * `fetch`, but its subscription methods, and `confirmTransaction` with them,
 * open a WebSocket straight from the client to the RPC host. On the oblivious
 * path that would hand the gateway the client's IP address together with the
 * signature it is waiting for: exactly the link Oblivious HTTP exists to
 * break. The connection built here cannot do that.
 */

import { Connection, TransactionExpiredBlockheightExceededError, TransactionExpiredTimeoutError } from "@solana/web3.js";
import type {
  Commitment,
  ConnectionConfig,
  RpcResponseAndContext,
  SignatureResult,
  TransactionConfirmationStrategy,
  TransactionSignature,
} from "@solana/web3.js";

import { RpcClientError } from "./errors.js";
import type { FetchLike } from "./http.js";

/** Options of {@link createConnection}. */
export interface LochConnectionOptions {
  /**
   * URL of the JSON-RPC endpoint. On the oblivious path this is the target
   * the gateway serves (the proxy's own public URL); no connection is opened
   * to it.
   */
  rpcUrl: string;
  /** From `createOhttpFetch` (oblivious) or `createDirectFetch` (direct). */
  fetch: FetchLike;
  /** Default commitment of the connection. Default `confirmed`. */
  commitment?: Commitment;
  /** Milliseconds between two status polls of `confirmTransaction`. Default 1,500. */
  confirmPollIntervalMs?: number;
  /** Milliseconds `confirmTransaction` waits when it has no block height to go by. Default 60,000. */
  confirmTimeoutMs?: number;
  /** Passed on to web3.js. */
  disableRetryOnRateLimit?: ConnectionConfig["disableRetryOnRateLimit"];
}

/** Subscription methods of `Connection`. Each one needs a WebSocket. */
const SUBSCRIPTION_METHODS = [
  "onAccountChange",
  "onProgramAccountChange",
  "onLogs",
  "onSlotChange",
  "onSlotUpdate",
  "onSignature",
  "onSignatureWithOptions",
  "onRootChange",
] as const;

/**
 * Where the unused WebSocket client of the connection points: the discard
 * port of this machine. Nothing here ever connects it; if a future web3.js
 * did, the attempt would stay on the machine instead of reaching the RPC
 * host.
 */
const UNUSED_WS_ENDPOINT = "ws://127.0.0.1:9/";

const RANK: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };

/** The confirmation level a commitment asks for, with the old names mapped to the current ones. */
function requiredRank(commitment: Commitment | undefined): number {
  switch (commitment) {
    case "processed":
    case "recent":
      return 0;
    case "confirmed":
    case "single":
    case "singleGossip":
      return 1;
    default:
      return 2;
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Builds a `Connection` whose every request goes through `options.fetch`.
 *
 * - HTTP calls (`getBalance`, `getLatestBlockhash`, `sendRawTransaction`,
 *   batches, ...) work as usual.
 * - `confirmTransaction` polls `getSignatureStatuses` (and `getBlockHeight`
 *   for expiry) instead of subscribing, so `sendAndConfirmTransaction` works
 *   too. It keeps polling through failed polls and gives up only when they
 *   have failed for `confirmTimeoutMs`. It rejects the way web3.js does, with
 *   web3.js's own `TransactionExpiredBlockheightExceededError` or
 *   `TransactionExpiredTimeoutError`: unlike the errors of this package, those
 *   name the signature. A durable-nonce strategy is confirmed by timeout
 *   (`confirmTimeoutMs`), without looking at the nonce account.
 * - The subscription methods (`onAccountChange`, `onLogs`, `onSignature`, ...)
 *   throw an {@link RpcClientError} (`unsupported_request`): the Loch RPC
 *   proxy has no WebSocket endpoint in v0.1. Poll instead.
 */
export function createConnection(options: LochConnectionOptions): Connection {
  if (typeof options !== "object" || options === null || typeof options.fetch !== "function" || typeof options.rpcUrl !== "string") {
    throw new RpcClientError("invalid_argument", "rpcUrl and fetch are required");
  }
  const pollIntervalMs = options.confirmPollIntervalMs ?? 1500;
  const timeoutMs = options.confirmTimeoutMs ?? 60_000;
  if (!(pollIntervalMs > 0) || !(timeoutMs > 0)) {
    throw new RpcClientError("invalid_argument", "confirmPollIntervalMs and confirmTimeoutMs must be positive numbers");
  }

  const connection = new Connection(options.rpcUrl, {
    commitment: options.commitment ?? "confirmed",
    fetch: options.fetch,
    wsEndpoint: UNUSED_WS_ENDPOINT,
    // No keep-alive agent in Node: the fetch functions of this package do not take one.
    httpAgent: false,
    disableRetryOnRateLimit: options.disableRetryOnRateLimit,
  });

  const overrides = connection as unknown as Record<string, unknown>;
  for (const method of SUBSCRIPTION_METHODS) {
    overrides[method] = () => {
      throw new RpcClientError(
        "unsupported_request",
        "subscriptions need a WebSocket, which the Loch RPC proxy does not offer: poll over HTTP instead",
      );
    };
  }

  overrides["confirmTransaction"] = async (
    strategy: TransactionConfirmationStrategy | TransactionSignature,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> => {
    const signature = typeof strategy === "string" ? strategy : strategy.signature;
    const abortSignal = typeof strategy === "string" ? undefined : strategy.abortSignal;
    const lastValidBlockHeight =
      typeof strategy !== "string" && "lastValidBlockHeight" in strategy ? strategy.lastValidBlockHeight : undefined;
    const wanted = commitment ?? connection.commitment;
    const started = Date.now();
    let failingSince: number | undefined;
    let expired = false;
    for (;;) {
      abortSignal?.throwIfAborted();
      try {
        const { context, value } = await connection.getSignatureStatuses([signature]);
        const status = value[0];
        if (status?.err) return { context, value: { err: status.err } };
        if (status && (RANK[status.confirmationStatus ?? "processed"] ?? 0) >= requiredRank(wanted)) return { context, value: { err: null } };
        // Expired only if the transaction is still unknown when asked once more after its last
        // valid block: it can land in that very block.
        if (expired && !status) throw new TransactionExpiredBlockheightExceededError(signature);
        failingSince = undefined;
        if (lastValidBlockHeight !== undefined && !status && (await connection.getBlockHeight(wanted)) > lastValidBlockHeight) {
          expired = true;
          continue;
        }
      } catch (error) {
        if (error instanceof TransactionExpiredBlockheightExceededError) throw error;
        // A poll that fails says nothing about a transaction that was already sent, and giving up
        // would invite the caller to send another one. Keep asking; give up only when polling has
        // failed for the whole timeout.
        failingSince ??= Date.now();
        if (Date.now() - failingSince >= timeoutMs) throw error;
      }
      if (lastValidBlockHeight === undefined && Date.now() - started >= timeoutMs) {
        throw new TransactionExpiredTimeoutError(signature, timeoutMs / 1000);
      }
      await sleep(pollIntervalMs, abortSignal);
    }
  };

  return connection;
}
