// Settings: the endpoints the extension may talk to, and a few choices. Nothing secret, so they
// are stored in the clear. Every network request the extension makes goes to one of the
// endpoints here, and they are all shown on the settings screen.

import { defaultServiceUrls, fixedConnectUrl, mainnetTestingEnabled } from "../shared/build.js";
import { DEFAULTS } from "../shared/constants.js";
import { isDecimalString, isRecord, isString } from "../shared/guards.js";
import type { KV } from "./kv.js";

export interface OhttpSettings {
  enabled: boolean;
  /** The Oblivious Relay: every RPC request is POSTed here, encrypted for the gateway. */
  relayUrl: string;
  /** The gateway's key configuration (`application/ohttp-keys`), base64 or hex. */
  keyConfig: string;
  /** Optional pin of the gateway key: its fingerprint (`sha256:` and 64 hex digits) or its X25519 public key, hex or base64. */
  pinnedKey: string;
}

/**
 * Why Oblivious HTTP settings were not accepted.
 *
 *   relay            no relay address
 *   same-origin      the relay and the RPC endpoint are the same origin: one party would see both
 *   key-config       not a key configuration
 *   key-config-url   an address was entered where the key configuration's content belongs
 *   unusable         a key configuration with no algorithm this client supports
 *   pin              the key configuration does not carry the pinned key
 */
export type OhttpProblem = "relay" | "same-origin" | "key-config" | "key-config-url" | "unusable" | "pin";

export interface Settings {
  rpcUrl: string;
  relayerUrl: string;
  screenerUrl: string;
  /**
   * The page the extension opens to reach the wallet. Only this exact URL, in a tab the
   * extension itself opened, may host the bridge. A build can fix it (shared/build.ts).
   */
  connectUrl: string;
  theme: "dusk" | "night";
  /** Register the Loch wallet on web pages (leak warnings, key-derivation guard). */
  wrapperEnabled: boolean;
  /** Let the in-page warning interrupt for a first-time recipient too (a low-severity finding). */
  warnFirstRecipients: boolean;
  /** The most one relayed transaction may cost, in lamports. The relayer cannot raise it. */
  maxFeeLamports: string;
  ohttp: OhttpSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  rpcUrl: defaultServiceUrls().rpcUrl ?? (mainnetTestingEnabled() ? "https://api.mainnet-beta.solana.com" : DEFAULTS.rpcUrl),
  relayerUrl: defaultServiceUrls().relayerUrl ?? DEFAULTS.relayerUrl,
  screenerUrl: defaultServiceUrls().screenerUrl ?? DEFAULTS.screenerUrl,
  connectUrl: DEFAULTS.connectUrl,
  theme: "dusk",
  wrapperEnabled: true,
  warnFirstRecipients: false,
  maxFeeLamports: DEFAULTS.maxFeeLamports,
  ohttp: { enabled: false, relayUrl: "", keyConfig: "", pinnedKey: "" },
};

const SETTINGS_KEY = "settings";

export type EndpointProblem = "empty" | "not-a-url" | "scheme" | "insecure" | "credentials" | "fragment" | "query";

export type EndpointCheck = { ok: true; url: string; origin: string } | { ok: false; problem: EndpointProblem };

/** `localhost`, 127.0.0.0/8 and [::1]: this machine. Names under .localhost are not trusted to be. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Checks an endpoint the user typed. https everywhere; plain http only for this machine, where
 * nobody is on the path. No credentials in the URL (they would be stored in the clear and sent
 * with every request) and no fragment.
 */
export function checkEndpoint(text: string): EndpointCheck {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, problem: "empty" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, problem: "not-a-url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, problem: "scheme" };
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return { ok: false, problem: "insecure" };
  if (url.username !== "" || url.password !== "") return { ok: false, problem: "credentials" };
  if (url.hash !== "") return { ok: false, problem: "fragment" };
  const normalised = url.pathname === "/" && url.search === "" ? url.origin : url.href;
  return { ok: true, url: normalised, origin: url.origin };
}

/**
 * Checks a connect page address. It is one exact URL, not an origin: https (plain http only for
 * this machine), no credentials, no query and no fragment. What is stored is the URL as the
 * browser writes it, so that it can be compared with a tab's address character for character.
 */
export function checkConnectUrl(text: string): EndpointCheck {
  const check = checkEndpoint(text);
  if (!check.ok) return check;
  const url = new URL(text.trim());
  if (url.search !== "") return { ok: false, problem: "query" };
  return { ok: true, url: url.href, origin: url.origin };
}

/**
 * Whether `candidate` (a tab's address, as the browser reports it) is the connect page
 * `connectUrl`: the same origin, the same path, and nothing after it. A query or a fragment
 * makes it a different address, and so does any other page of the same origin.
 */
export function isConnectPage(candidate: unknown, connectUrl: string): boolean {
  if (typeof candidate !== "string") return false;
  try {
    const page = new URL(candidate);
    const connect = new URL(connectUrl);
    if (page.protocol !== "https:" && page.protocol !== "http:") return false;
    return connect.search === "" && connect.hash === "" && page.href === connect.href;
  } catch {
    return false;
  }
}

export function endpointProblemText(problem: EndpointProblem): string {
  switch (problem) {
    case "empty":
      return "Enter an address.";
    case "not-a-url":
      return "That is not a web address. It should look like https://rpc.example.org";
    case "scheme":
      return "The address must start with https://";
    case "insecure":
      return "Plain http is only accepted for this machine (127.0.0.1 or localhost). Use https://";
    case "credentials":
      return "Remove the user name and password from the address. Loch stores settings unencrypted.";
    case "fragment":
      return "Remove the part after #.";
    case "query":
      return "Remove the part after ?. The connect page is one exact address.";
  }
}

function endpointOr(value: unknown, fallback: string): string {
  if (!isString(value, 2048)) return fallback;
  const check = checkEndpoint(value);
  return check.ok ? check.url : fallback;
}

function connectUrlOr(value: unknown, fallback: string): string {
  // A build with the connect page compiled in ignores whatever is stored.
  const fixed = fixedConnectUrl();
  if (fixed !== null) return fixed;
  if (!isString(value, 2048)) return fallback;
  const check = checkConnectUrl(value);
  return check.ok ? check.url : fallback;
}

/** Reads stored settings, replacing anything missing or invalid with its default. */
export function normaliseSettings(stored: unknown): Settings {
  const s = isRecord(stored) ? stored : {};
  const o = isRecord(s.ohttp) ? s.ohttp : {};
  const maxFee = isDecimalString(s.maxFeeLamports) && BigInt(s.maxFeeLamports) <= 1_000_000_000n ? s.maxFeeLamports : DEFAULT_SETTINGS.maxFeeLamports;
  const relayUrl = isString(o.relayUrl, 2048) && (o.relayUrl === "" || checkEndpoint(o.relayUrl).ok) ? o.relayUrl : "";
  const keyConfig = isString(o.keyConfig, 8192) ? o.keyConfig.trim() : "";
  return {
    rpcUrl: endpointOr(s.rpcUrl, DEFAULT_SETTINGS.rpcUrl),
    relayerUrl: endpointOr(s.relayerUrl, DEFAULT_SETTINGS.relayerUrl),
    screenerUrl: endpointOr(s.screenerUrl, DEFAULT_SETTINGS.screenerUrl),
    connectUrl: connectUrlOr(s.connectUrl, DEFAULT_SETTINGS.connectUrl),
    theme: s.theme === "night" ? "night" : "dusk",
    wrapperEnabled: typeof s.wrapperEnabled === "boolean" ? s.wrapperEnabled : true,
    warnFirstRecipients: s.warnFirstRecipients === true,
    maxFeeLamports: maxFee,
    ohttp: {
      enabled: o.enabled === true && relayUrl !== "" && keyConfig !== "",
      relayUrl,
      keyConfig,
      pinnedKey: isString(o.pinnedKey, 128) ? o.pinnedKey.trim() : "",
    },
  };
}

export async function loadSettings(local: KV): Promise<Settings> {
  return normaliseSettings(await local.get(SETTINGS_KEY));
}

export async function saveSettings(local: KV, settings: Settings): Promise<Settings> {
  const clean = normaliseSettings(settings);
  await local.set(SETTINGS_KEY, clean);
  return clean;
}

/** The origins the extension may send requests to under these settings. Nothing else is ever contacted. */
export function allowedOrigins(settings: Settings): string[] {
  const origins = new Set<string>();
  const oblivious = settings.ohttp.enabled && settings.ohttp.relayUrl !== "";
  // With Oblivious HTTP on, RPC requests go to the relay and the RPC endpoint itself is never
  // contacted. Leaving it off the list makes sure of that.
  if (oblivious) origins.add(new URL(settings.ohttp.relayUrl).origin);
  else origins.add(new URL(settings.rpcUrl).origin);
  for (const url of [settings.relayerUrl, settings.screenerUrl]) origins.add(new URL(url).origin);
  return [...origins];
}
