// Oblivious HTTP for the RPC endpoint (RFC 9458), through @loch/rpc-client.
//
// With a relay and the gateway's key configuration set in settings, every RPC request is
// encrypted for the gateway and POSTed to the relay: the relay sees who is asking and not
// what, the gateway sees what and not who. No connection is ever opened to the RPC endpoint
// itself, and none can be: its origin is taken off the list the guarded fetch allows.
//
// The key configuration is given in settings as its content (hex or base64), never as an
// address to fetch it from, and this file never passes `keyConfigUrl` to the client. That is on
// purpose. A configuration fetched over the network is only as good as the host it comes from:
// fetched from the relay, the relay could hand out a key of its own and read every request. The
// client library refuses a key-configuration address on the relay's origin and requires pinned
// keys whenever an address is used; the extension never uses one, so a pin stays optional
// here: with one, a pasted configuration carrying any other key is refused before anything is
// sent.
//
// A gateway may offer two keys: X-Wing (ML-KEM-768 with X25519) and X25519 alone. The client
// library takes X-Wing when it is offered and the pin allows it, so that a recording of the
// relay's traffic does not open once X25519 can be broken. A pin is exclusive: an X25519 key
// pinned as 64 hex digits keeps the client on X25519. The fingerprint form pins either key.
//
// Only RPC requests travel this way. The relayer and the screening service are contacted
// directly (they would need a gateway of their own).

import { RpcClientError, createOhttpFetch, describeKeyConfigs } from "@loch/rpc-client";
import { createConnection } from "@loch/rpc-client/web3";

import { OHTTP_AVAILABLE } from "./core.js";
import type { FetchLike, RpcTransportFactory } from "./network.js";
import type { OhttpProblem, OhttpSettings } from "./settings.js";

OHTTP_AVAILABLE.value = true;

export const rpcTransport: RpcTransportFactory = (settings, guarded) => {
  const { ohttp } = settings;
  if (!ohttp.enabled) return null;
  const fetch = createOhttpFetch({
    relayUrl: ohttp.relayUrl,
    keyConfig: ohttp.keyConfig,
    ...(ohttp.pinnedKey ? { pinnedPublicKeys: [ohttp.pinnedKey] } : {}),
    fetch: guarded as typeof globalThis.fetch,
  }) as FetchLike;
  // Not a bare web3.js Connection: that would open a WebSocket straight to the RPC host for
  // confirmations. This one polls, and its subscription methods throw.
  return { fetch, connect: (rpcUrl) => createConnection({ rpcUrl, fetch: fetch as typeof globalThis.fetch }) };
};

export type { OhttpProblem };

/**
 * Checks Oblivious HTTP settings before they are switched on. Returns the gateway's public
 * keys (hex) on success, and the key exchange requests would use: "X-Wing" or "X25519".
 * `rpcUrl` is the endpoint the gateway is asked for.
 */
export function checkOhttp(ohttp: OhttpSettings, rpcUrl: string): { ok: true; publicKeys: string[]; kem: string } | { ok: false; problem: OhttpProblem } {
  if (ohttp.relayUrl.trim() === "") return { ok: false, problem: "relay" };
  try {
    // The relay sees who asks, the gateway sees what is asked. On one origin that is one party.
    if (new URL(ohttp.relayUrl).origin === new URL(rpcUrl).origin) return { ok: false, problem: "same-origin" };
  } catch {
    return { ok: false, problem: "relay" };
  }
  // The field takes the configuration's content. An address is not fetched, here or anywhere.
  if (/^\s*[a-z][a-z0-9+.-]*:\/\//i.test(ohttp.keyConfig)) return { ok: false, problem: "key-config-url" };
  let keys;
  try {
    keys = describeKeyConfigs(ohttp.keyConfig);
  } catch (error) {
    if (error instanceof RpcClientError) return { ok: false, problem: "key-config" };
    throw error;
  }
  const usable = keys.filter((key) => key.usable);
  if (usable.length === 0) return { ok: false, problem: "unusable" };
  try {
    // Building the fetch runs the library's own checks, the pin among them.
    createOhttpFetch({ relayUrl: ohttp.relayUrl, keyConfig: ohttp.keyConfig, ...(ohttp.pinnedKey ? { pinnedPublicKeys: [ohttp.pinnedKey] } : {}) });
  } catch (error) {
    if (error instanceof RpcClientError) return { ok: false, problem: error.code === "key_config_pin_mismatch" ? "pin" : error.code === "invalid_argument" ? "relay" : "key-config" };
    throw error;
  }
  // The same list and the same pin the fetch above accepted, so one entry is the chosen one.
  const chosen = describeKeyConfigs(ohttp.keyConfig, ohttp.pinnedKey ? [ohttp.pinnedKey] : undefined).find((key) => key.chosen);
  return { ok: true, publicKeys: usable.map((key) => key.publicKey), kem: chosen?.kem ?? "X25519" };
}
