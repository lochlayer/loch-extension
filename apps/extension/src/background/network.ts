// The one place the extension makes network requests from.
//
// - `guardedFetch` refuses any URL whose origin is not one of the configured endpoints, so a
//   request to anywhere else cannot leave even by mistake. It sends no cookies, no referrer and
//   no identifying headers, never follows a redirect, and gives up after a timeout.
// - `createChain` builds the web3.js connection on top of it. A custom transport (Oblivious
//   HTTP) plugs in through `rpcTransport`.
// - `readCluster` and `assertAllowedCluster` enforce the network chosen by the build.
//   Mainnet is refused unless this is the explicit mainnet testing package.

import { Connection } from "@solana/web3.js";

import { mainnetTestingEnabled } from "../shared/build.js";
import { type Cluster, GENESIS, clusterOf } from "../shared/constants.js";
import { type Settings, allowedOrigins } from "./settings.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 30_000;
/** Headers a request may carry. Anything else a library adds (a client version, for one) is dropped. */
const FORWARDED_HEADERS = ["content-type", "accept"];

export class BlockedRequestError extends Error {
  constructor(readonly origin: string) {
    super(`request to ${origin} refused: it is not one of the configured endpoints`);
    this.name = "BlockedRequestError";
  }
}

/**
 * A `fetch` that only talks to `origins`. Everything the service worker sends goes through one
 * of these.
 */
export function guardedFetch(origins: readonly string[], transport: FetchLike = (input, init) => fetch(input, init), timeoutMs = REQUEST_TIMEOUT_MS): FetchLike {
  const allowed = new Set(origins);
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!allowed.has(url.origin)) throw new BlockedRequestError(url.origin);
    const headers = new Headers();
    const given = new Headers(init.headers);
    for (const name of FORWARDED_HEADERS) {
      const value = given.get(name);
      if (value !== null) headers.set(name, value);
    }
    const signals: AbortSignal[] = [];
    if (init.signal) signals.push(init.signal);
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    return transport(url.href, {
      method: init.method ?? "GET",
      body: init.body,
      headers,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
    });
  };
}

/**
 * Builds the transport RPC requests travel over, and optionally the connection on top of it.
 * Returns null to use the guarded fetch directly. This is where Oblivious HTTP plugs in.
 */
export type RpcTransportFactory = (settings: Settings, guarded: FetchLike) => { fetch: FetchLike; connect?: (rpcUrl: string) => Connection } | null;

export interface ChainOptions {
  /** The base transport, for tests. Default: the global fetch. */
  transport?: FetchLike;
  /** Plug point for Oblivious HTTP: wraps RPC requests only. */
  rpcTransport?: RpcTransportFactory;
}

export interface Chain {
  /** For the SDK and the scanner. Every request it makes goes through the guarded fetch. */
  connection: Connection;
  /** For the relayer and screener clients. */
  fetch: FetchLike;
  rpcUrl: string;
}

export function createChain(settings: Settings, options: ChainOptions = {}): Chain {
  const guarded = guardedFetch(allowedOrigins(settings), options.transport);
  const plugged = options.rpcTransport?.(settings, guarded) ?? null;
  const connection =
    plugged?.connect?.(settings.rpcUrl) ??
    new Connection(settings.rpcUrl, {
      commitment: "confirmed",
      fetch: (plugged?.fetch ?? guarded) as typeof fetch,
      // No WebSocket is ever opened: nothing here subscribes, and confirmation is polled.
      disableRetryOnRateLimit: false,
    });
  return { connection, fetch: guarded, rpcUrl: settings.rpcUrl };
}

export class MainnetRefusedError extends Error {
  constructor() {
    super("this RPC endpoint is Solana mainnet; this build has mainnet testing disabled");
    this.name = "MainnetRefusedError";
  }
}

export interface ClusterInfo {
  genesisHash: string;
  cluster: Cluster;
}

/** Asks the endpoint which chain it serves. */
export async function readCluster(connection: Pick<Connection, "getGenesisHash">): Promise<ClusterInfo> {
  const genesisHash = await connection.getGenesisHash();
  return { genesisHash, cluster: clusterOf(genesisHash) };
}

/** Call before anything that could move funds. The testing package requires mainnet. */
export function assertAllowedCluster(info: ClusterInfo): void {
  if (mainnetTestingEnabled()) {
    if (info.genesisHash !== GENESIS["mainnet-beta"] || info.cluster !== "mainnet-beta") {
      throw new Error("This mainnet testing build requires a mainnet RPC endpoint.");
    }
  } else if (info.cluster === "mainnet-beta" || info.genesisHash === GENESIS["mainnet-beta"]) {
    throw new MainnetRefusedError();
  }
}

/** Whether a failure is the network's (no answer, a timeout) rather than a refusal. */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof BlockedRequestError) return false;
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  if (error instanceof TypeError) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /failed to fetch|fetch failed|network|timed? ?out|ECONNREFUSED|ENOTFOUND|socket|429|50[234]/i.test(text);
}

/** A short technical line for the small print of a failure. Never contains a secret: only an origin and the error's own words. */
export function describeNetworkError(url: string, error: unknown): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the text */
  }
  if (error instanceof DOMException && error.name === "TimeoutError") return `${host} did not answer in time`;
  const text = error instanceof Error ? error.message : String(error);
  return `${host}: ${text.replace(/\s+/g, " ").slice(0, 120)}`;
}
