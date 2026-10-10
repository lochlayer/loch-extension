// A fetch that sends every request as Oblivious HTTP (RFC 9458).
//
// Who learns what:
//
//   relay    sees the client's IP address and the size and timing of each
//            message. It cannot read requests or responses.
//   gateway  sees the request and the response. It sees the relay's IP
//            address, not the client's.
//
// That split only helps if the two are run by parties that do not share what
// they see, and if the key the client encrypts to really is the gateway's.
// See docs/rpc-proxy.md.

import { type BinaryRequest, decodeResponse, encodeRequest } from "./bhttp.js";
import { equalBytes, toBytes } from "./bytes.js";
import { RpcClientError, type RpcClientErrorCode } from "./errors.js";
import {
  type FetchLike,
  PRIVATE_REQUEST_INIT,
  discard,
  headerAllowlist,
  limit,
  mediaType,
  platformFetch,
  readCapped,
  readRequest,
  serviceUrl,
  withDeadline,
} from "./http.js";
import {
  FINGERPRINT_PREFIX,
  KEM_X25519_HKDF_SHA256,
  KEM_X_WING,
  type KeyConfig,
  MEDIA_TYPE_KEYS,
  MEDIA_TYPE_REQUEST,
  MEDIA_TYPE_RESPONSE,
  SUPPORTED_KEMS,
  X25519_KEY_BYTES,
  X_WING_PUBLIC_KEY_BYTES,
  decodeKeyConfigList,
  keyFingerprint,
} from "./keyConfig.js";
import { REQUEST_OVERHEAD_BYTES, encapsulateRequest, requestOverheadBytes, selectAlgorithm } from "./ohttp.js";
import { DEFAULT_REQUEST_PADDING_BUCKETS, normaliseBuckets, padMessage } from "./padding.js";

/** Padding of requests. */
export interface PaddingOptions {
  /**
   * Bucket sizes in bytes. Each request (as a Binary HTTP message, before
   * encryption) is padded with zeros to the smallest bucket that holds it, or
   * to a multiple of the largest. Default {@link DEFAULT_REQUEST_PADDING_BUCKETS}.
   */
  buckets?: readonly number[];
}

/** Options of {@link createOhttpFetch}. */
export interface OhttpFetchOptions {
  /**
   * The Oblivious Relay Resource: every request is POSTed here, encrypted.
   * The relay must be operated by someone other than the gateway operator.
   */
  relayUrl: string;
  /**
   * The gateway's key configuration, obtained out of band: the content of
   * `GET /ohttp-keys` (`application/ohttp-keys`) as bytes, hex or base64.
   * Shipping it with the application is the strongest choice: nobody on the
   * network can replace it.
   */
  keyConfig?: Uint8Array | string;
  /**
   * Where to fetch the key configuration from. Used when there is no
   * `keyConfig`, and to refresh once when the gateway rejects the key. At
   * least one of `keyConfig` and `keyConfigUrl` is required.
   *
   * - It must not be on the relay's origin: a relay that serves the key
   *   configuration can hand out a key of its own and read every request.
   *   Such a URL is refused (`invalid_argument`). It should not be the
   *   gateway at request time either; see docs/rpc-proxy.md.
   * - It requires `pinnedPublicKeys`. Without pins, whoever serves this URL,
   *   or can answer in its place, chooses the key. `allowUnpinnedKeyConfigUrl`
   *   is the way to accept that.
   * - A fetch that fails (the host is down, or serves a key that is not
   *   pinned) is not repeated for a minute: calls made in that minute fail
   *   with the same error without contacting the host, so a failing host does
   *   not learn of every call the application attempts.
   */
  keyConfigUrl?: string;
  /**
   * Pinned keys of the gateway. When set, a key configuration is used only if
   * its key is one of these, whether it was given or fetched, so neither the
   * relay nor the host of `keyConfigUrl` can substitute a key of its own.
   * Required with `keyConfigUrl`. Each pin is one of:
   *
   * - a fingerprint, the string `sha256:` and 64 hex digits, as
   *   `describeKeyConfigs` and the gateway's `show-keys` print it. It names
   *   one key of one KEM. The practical form for an X-Wing key.
   * - an X25519 public key: 32 bytes, as bytes, hex or base64. It matches an
   *   X25519 key configuration only.
   * - an X-Wing public key: 1216 bytes, as bytes, hex or base64. It matches
   *   an X-Wing key configuration only.
   *
   * Pinning only the gateway's X-Wing key is what keeps a client on X-Wing:
   * with the X25519 key pinned as well, whoever serves the key configuration
   * can leave the X-Wing entry out, and the client falls back to X25519.
   */
  pinnedPublicKeys?: readonly (Uint8Array | string)[];
  /**
   * Use `keyConfigUrl` without `pinnedPublicKeys`. Default false.
   *
   * With this, the key every request is encrypted to is whatever that URL
   * answers with: its host, and anyone who can answer for it, can substitute
   * a key and read every request and response. Nothing in the protocol will
   * notice. Only for development, or when the URL is trusted as much as the
   * application itself.
   *
   * Even with this, a `keyConfig` that was given is never replaced by a
   * fetched one: without pins nothing vouches for the replacement, and the
   * answers that would trigger it come from the relay unauthenticated. So
   * with `keyConfig` and no pins the URL is not used at all.
   */
  allowUnpinnedKeyConfigUrl?: boolean;
  /** Transport to the relay. Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Transport for `keyConfigUrl`. Default: the same as `fetch`. */
  keyConfigFetch?: FetchLike;
  /** Request padding. Default: on, with the default buckets. `false` turns it off. */
  padding?: PaddingOptions | false;
  /**
   * Request headers that are passed on inside the encrypted request. Default
   * `content-type` and `accept`. Everything else a caller sets is dropped, so
   * all clients look alike to the gateway.
   */
  forwardHeaders?: readonly string[];
  /** Milliseconds for the whole exchange. Default 30,000. 0 disables the deadline. */
  timeoutMs?: number;
  /** Largest request, padded and encrypted, in bytes. Default 1 MiB. */
  maxRequestBytes?: number;
  /** Largest encrypted response accepted, in bytes. Default 32 MiB. */
  maxResponseBytes?: number;
  /** Accept `http://` URLs for hosts other than this machine. Default false. */
  allowInsecureHttp?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_KEY_CONFIG_BYTES = 65_536;
const MAX_PROBLEM_BYTES = 4096;
/**
 * The key configuration is fetched at most this often, whether the fetch
 * before it worked or not.
 *
 * - The answers that trigger a refresh are not authenticated, so without this
 *   a relay could make a client contact the key configuration host on every
 *   request.
 * - A first fetch that fails would otherwise be repeated by every call, and a
 *   host that is down, or that serves a key the pins refuse, would see the
 *   client's address and the timing of everything the wallet tried to do.
 */
const KEY_REFRESH_INTERVAL_MS = 60_000;
/** Problem type a gateway uses to say that the key is outdated or unknown (RFC 9458, section 5.3). */
const PROBLEM_KEY = "https://iana.org/assignments/http-problem-types#ohttp-key";

/**
 * A pin, with what it may be compared to. The kinds never mix: a public key
 * is compared with public keys of its own KEM, a fingerprint with
 * fingerprints. Comparing 32 pinned bytes with both would let a value that
 * was pinned as a fingerprint pass as an X25519 public key.
 */
type Pin = { kind: "key"; kemId: number; publicKey: Uint8Array } | { kind: "fingerprint"; fingerprint: string };

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

/** Reads one pin, or returns undefined if it is none of the accepted forms. */
function parsePin(pin: Uint8Array | string): Pin | undefined {
  if (typeof pin === "string" && pin.trim().toLowerCase().startsWith(FINGERPRINT_PREFIX)) {
    const fingerprint = pin.trim().toLowerCase();
    return FINGERPRINT.test(fingerprint) ? { kind: "fingerprint", fingerprint } : undefined;
  }
  let publicKey: Uint8Array;
  try {
    publicKey = toBytes(pin);
  } catch {
    return undefined;
  }
  if (publicKey.length === X25519_KEY_BYTES) return { kind: "key", kemId: KEM_X25519_HKDF_SHA256, publicKey };
  if (publicKey.length === X_WING_PUBLIC_KEY_BYTES) return { kind: "key", kemId: KEM_X_WING, publicKey };
  return undefined;
}

/** Reads `pinnedPublicKeys`. Throws (`invalid_argument`) unless it is a non-empty list of pins in an accepted form. */
function parsePins(pinned: readonly (Uint8Array | string)[]): Pin[] {
  const parsed = Array.isArray(pinned) ? pinned.map((pin: Uint8Array | string) => parsePin(pin)) : [];
  if (parsed.length === 0 || parsed.includes(undefined)) {
    throw new RpcClientError(
      "invalid_argument",
      "pinnedPublicKeys must be a non-empty list of key fingerprints (sha256: and 64 hex digits), 32-byte X25519 public keys or 1216-byte X-Wing public keys",
    );
  }
  return parsed as Pin[];
}

function pinMatches(pin: Pin, config: KeyConfig): boolean {
  if (pin.kind === "fingerprint") return pin.fingerprint === keyFingerprint(config);
  return pin.kemId === config.kemId && equalBytes(pin.publicKey, config.publicKey);
}

/**
 * Chooses the key configuration to use from a list. Of those that are usable
 * and, if there are pins, pinned, it takes the one with the KEM this client
 * prefers (X-Wing before X25519), and the first listed among several of that
 * KEM. The order of the list does not decide between KEMs: whoever can reorder
 * it must not be able to move a client from X-Wing to X25519.
 */
function chooseKeyConfig(list: Uint8Array, pins: Pin[] | undefined): KeyConfig {
  let configs: KeyConfig[];
  try {
    configs = decodeKeyConfigList(list);
  } catch {
    throw new RpcClientError("key_config_invalid", "the key configuration is malformed");
  }
  const usable = configs.filter((config) => selectAlgorithm(config) !== undefined);
  if (usable.length === 0) throw new RpcClientError("key_config_invalid", "the key configuration offers no supported algorithm");
  const candidates = pins ? usable.filter((config) => pins.some((pin) => pinMatches(pin, config))) : usable;
  if (candidates.length === 0) throw new RpcClientError("key_config_pin_mismatch", "the key configuration does not contain a pinned public key");
  for (const kemId of SUPPORTED_KEMS) {
    const preferred = candidates.find((config) => config.kemId === kemId);
    if (preferred) return preferred;
  }
  return candidates[0]!;
}

/**
 * The entry of a key configuration list that {@link createOhttpFetch} encrypts
 * to when given the same list and the same pins. For `describeKeyConfigs`,
 * which is how a settings screen says which key exchange is in use. Throws as
 * `createOhttpFetch` does for a list or pins it would refuse.
 */
export function chosenKeyConfig(list: Uint8Array, pinnedPublicKeys?: readonly (Uint8Array | string)[]): KeyConfig {
  return chooseKeyConfig(list, pinnedPublicKeys === undefined ? undefined : parsePins(pinnedPublicKeys));
}

/** Holds the key configuration in use and refreshes it from `keyConfigUrl`. */
class KeyConfigSource {
  private current: KeyConfig | undefined;
  private fetchedAt = 0;
  private inflight: Promise<KeyConfig> | undefined;
  /** How the last fetch failed, if it did. Fixed values only, as every error of this package. */
  private failure: { code: RpcClientErrorCode; message: string; status: number | null } | undefined;
  /**
   * Whether a key configuration in use may be replaced by a fetched one. Not
   * when it was given and there are no pins: nothing would vouch for the
   * replacement, and what asks for it is an unauthenticated answer.
   */
  private readonly replaceable: boolean;

  constructor(
    initial: KeyConfig | undefined,
    private readonly url: URL | undefined,
    private readonly pins: Pin[] | undefined,
    private readonly transport: FetchLike,
    private readonly timeoutMs: number,
  ) {
    this.current = initial;
    this.replaceable = initial === undefined || pins !== undefined;
  }

  /**
   * The key configuration to encrypt to, fetched on first use if none was
   * given. A fetch that failed is not made again within the refresh interval:
   * until then this rejects with the same error and contacts nobody.
   */
  get(): Promise<KeyConfig> {
    if (this.current) return Promise.resolve(this.current);
    if (this.failure && Date.now() - this.fetchedAt < KEY_REFRESH_INTERVAL_MS) {
      return Promise.reject(new RpcClientError(this.failure.code, this.failure.message, this.failure.status));
    }
    return this.load();
  }

  /**
   * Fetches the key configuration again because `used` did not work. Returns
   * the new one, or undefined if there is nowhere to fetch from, if the one
   * in use may not be replaced, if it was fetched too recently, or if it did
   * not change.
   */
  async refresh(used: KeyConfig): Promise<KeyConfig | undefined> {
    if (!this.url || !this.replaceable) return undefined;
    // Another request already replaced it.
    if (this.current && this.current !== used) return this.current;
    if (Date.now() - this.fetchedAt < KEY_REFRESH_INTERVAL_MS) return undefined;
    const fresh = await this.load();
    const changed = fresh.keyId !== used.keyId || !equalBytes(fresh.publicKey, used.publicKey);
    return changed ? fresh : undefined;
  }

  private load(): Promise<KeyConfig> {
    // One fetch at a time, shared by every request that is waiting for it. It runs under a deadline
    // of its own and under no caller's signal: one caller giving up must not fail the others.
    this.inflight ??= this.fetchOnce().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<KeyConfig> {
    if (!this.url) throw new RpcClientError("key_config_unavailable", "there is no key configuration and no URL to fetch one from");
    // Counts as an attempt whatever comes of it, so that a failing host is not asked again at once.
    this.fetchedAt = Date.now();
    try {
      const config = await this.fetchAndChoose(this.url.href);
      this.failure = undefined;
      this.current = config;
      return config;
    } catch (error) {
      this.failure =
        error instanceof RpcClientError
          ? { code: error.code, message: error.message, status: error.status }
          : { code: "key_config_unavailable", message: "the key configuration could not be fetched", status: null };
      throw error;
    }
  }

  private async fetchAndChoose(url: string): Promise<KeyConfig> {
    let status: number | null = null;
    let bytes: Uint8Array;
    try {
      bytes = await withDeadline(undefined, this.timeoutMs, async (signal) => {
        // The one request that may be answered from the HTTP cache: the key configuration is public, the
        // same for everyone and served to be cached, and a cached copy means the host is not contacted at all.
        const response = await this.transport(url, { ...PRIVATE_REQUEST_INIT, cache: "default", method: "GET", headers: { accept: MEDIA_TYPE_KEYS }, signal });
        status = response.status;
        if (response.status !== 200) {
          await discard(response);
          throw new RpcClientError("key_config_unavailable", "the key configuration could not be fetched", response.status);
        }
        return readCapped(response, MAX_KEY_CONFIG_BYTES);
      });
    } catch (error) {
      if (error instanceof RpcClientError && error.code === "key_config_unavailable") throw error;
      throw new RpcClientError("key_config_unavailable", "the key configuration could not be fetched", status);
    }
    return chooseKeyConfig(bytes, this.pins);
  }
}

type Outcome = { kind: "response"; bytes: Uint8Array } | { kind: "key_rejected"; status: number } | { kind: "error"; status: number };

/**
 * Returns a function with the signature of `fetch` that sends each request
 * through an Oblivious HTTP relay to a gateway and resolves with an ordinary
 * `Response`.
 *
 * ```ts
 * const ohttpFetch = createOhttpFetch({ relayUrl, keyConfig, pinnedPublicKeys });
 * const connection = new Connection(rpcUrl, { fetch: ohttpFetch });
 * ```
 *
 * The request URL names the target the gateway serves (for the Loch RPC
 * proxy, the JSON-RPC endpoint); the network connection goes to the relay
 * only. The request is carried whole: method, URL, allowlisted headers and
 * body. Bodies must be text or bytes.
 *
 * A resolved `Response` always comes out of the encrypted envelope, so it is
 * the gateway's answer. Anything else rejects with an {@link RpcClientError}:
 * in particular an error status from the relay is never turned into a
 * `Response`, because nothing authenticates it. An abort rejects with the
 * caller's abort reason.
 *
 * The function keeps no record of requests. It holds the key configuration
 * in memory and nothing else.
 *
 * Throws an {@link RpcClientError} (`invalid_argument`, `key_config_invalid`
 * or `key_config_pin_mismatch`) at once if the options are unusable. That
 * includes a `keyConfigUrl` on the relay's origin, and a `keyConfigUrl`
 * without `pinnedPublicKeys` unless `allowUnpinnedKeyConfigUrl` is set.
 */
export function createOhttpFetch(options: OhttpFetchOptions): FetchLike {
  if (typeof options !== "object" || options === null) throw new RpcClientError("invalid_argument", "options are required");
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const relay = serviceUrl(options.relayUrl, "relayUrl", allowInsecureHttp);
  const relayUrl = relay.href;
  const keyConfigUrl = options.keyConfigUrl === undefined ? undefined : serviceUrl(options.keyConfigUrl, "keyConfigUrl", allowInsecureHttp);
  if (options.keyConfig === undefined && keyConfigUrl === undefined) {
    throw new RpcClientError("invalid_argument", "one of keyConfig and keyConfigUrl is required");
  }
  // The relay is the one party that must not choose the key: it would decrypt every request, read it,
  // and pass it on re-encrypted to the gateway.
  if (keyConfigUrl !== undefined && keyConfigUrl.origin === relay.origin) {
    throw new RpcClientError("invalid_argument", "keyConfigUrl must not be on the relay's origin: a relay that serves the key configuration can read every request");
  }
  if (keyConfigUrl !== undefined && options.pinnedPublicKeys === undefined && options.allowUnpinnedKeyConfigUrl !== true) {
    throw new RpcClientError(
      "invalid_argument",
      "keyConfigUrl requires pinnedPublicKeys: without pins, whoever serves the key configuration can read every request (allowUnpinnedKeyConfigUrl accepts that)",
    );
  }

  const pins = options.pinnedPublicKeys === undefined ? undefined : parsePins(options.pinnedPublicKeys);

  let initial: KeyConfig | undefined;
  if (options.keyConfig !== undefined) {
    let bytes: Uint8Array;
    try {
      bytes = toBytes(options.keyConfig);
    } catch {
      throw new RpcClientError("key_config_invalid", "the key configuration is malformed");
    }
    initial = chooseKeyConfig(bytes, pins);
  }

  const transport = options.fetch ?? platformFetch;
  const timeoutMs = limit(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const keys = new KeyConfigSource(initial, keyConfigUrl, pins, options.keyConfigFetch ?? transport, timeoutMs);
  const buckets = options.padding === false ? [] : normaliseBuckets(options.padding?.buckets ?? DEFAULT_REQUEST_PADDING_BUCKETS);
  const allowed = headerAllowlist(options.forwardHeaders);
  const maxRequestBytes = limit(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes");
  const maxResponseBytes = limit(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");

  /** One POST to the relay. */
  async function exchange(message: Uint8Array, signal: AbortSignal): Promise<Outcome> {
    const response = await transport(relayUrl, {
      ...PRIVATE_REQUEST_INIT,
      method: "POST",
      headers: { "content-type": MEDIA_TYPE_REQUEST },
      body: message as Uint8Array<ArrayBuffer>,
      signal,
    });
    const type = mediaType(response);
    if (response.status === 200 && type === MEDIA_TYPE_RESPONSE) {
      return { kind: "response", bytes: await readCapped(response, maxResponseBytes) };
    }
    // Not encapsulated, so not authenticated: read only enough to see whether
    // the gateway says the key is outdated.
    let keyRejected = false;
    if (response.status >= 400 && response.status < 500 && type === "application/problem+json") {
      try {
        const problem: unknown = JSON.parse(new TextDecoder().decode(await readCapped(response, MAX_PROBLEM_BYTES)));
        keyRejected = typeof problem === "object" && problem !== null && (problem as { type?: unknown }).type === PROBLEM_KEY;
      } catch {
        keyRejected = false;
      }
    } else {
      await discard(response);
    }
    return keyRejected ? { kind: "key_rejected", status: response.status } : { kind: "error", status: response.status };
  }

  return async function ohttpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = await readRequest(input, init, allowed);
    const inner: BinaryRequest = {
      method: request.method,
      scheme: request.url.protocol.slice(0, -1),
      authority: request.url.host,
      path: request.url.pathname + request.url.search,
      headers: request.headers,
      content: request.body,
    };
    let padded: Uint8Array;
    try {
      padded = padMessage(encodeRequest(inner), buckets);
    } catch {
      throw new RpcClientError("unsupported_request", "the request cannot be encoded as Binary HTTP");
    }
    const tooLarge = (overhead: number) => padded.length + overhead > maxRequestBytes;
    // Too large with any key, so there is no need to fetch one to find out.
    if (tooLarge(REQUEST_OVERHEAD_BYTES)) {
      throw new RpcClientError("request_too_large", "the request is larger than the configured limit");
    }

    return withDeadline(request.signal, timeoutMs, async (signal) => {
      let config = await keys.get();
      for (let attempt = 0; ; attempt++) {
        // The encapsulated key of X-Wing is 1,088 bytes longer than that of X25519.
        if (tooLarge(requestOverheadBytes(config.kemId))) {
          throw new RpcClientError("request_too_large", "the request is larger than the configured limit");
        }
        let encapsulated;
        try {
          encapsulated = await encapsulateRequest(config, padded);
        } catch {
          throw new RpcClientError("key_config_invalid", "the request could not be encrypted to the key configuration");
        }
        const outcome = await exchange(encapsulated.message, signal);
        if (outcome.kind === "response") {
          let plain: Uint8Array;
          try {
            plain = await encapsulated.openResponse(outcome.bytes);
          } catch {
            throw new RpcClientError("decapsulation_failed", "the encapsulated response does not decrypt", 200);
          }
          return toResponse(plain);
        }
        // The gateway never saw the request (it could not decrypt it), so sending it again is safe.
        // Neither answer is authenticated: the relay can send both. So what follows may replace the
        // key in use only by one the pins vouch for, or when the key in use was fetched to begin with.
        const explicit = outcome.kind === "key_rejected";
        const mayBeStale = explicit || (outcome.status >= 400 && outcome.status < 500);
        const fresh = attempt === 0 && mayBeStale ? await keys.refresh(config) : undefined;
        if (fresh) {
          config = fresh;
          continue;
        }
        if (explicit) {
          throw new RpcClientError("key_rejected", "the gateway does not accept the key the request was encrypted to", outcome.status);
        }
        throw new RpcClientError("relay_error", "the relay answered with an error instead of an encapsulated response", outcome.status);
      }
    });
  };
}

/** Turns a decrypted Binary HTTP response into a `Response`. */
function toResponse(message: Uint8Array): Response {
  try {
    const decoded = decodeResponse(message);
    const headers = new Headers();
    for (const [name, value] of decoded.headers) headers.append(name, value);
    const withoutBody = decoded.status === 204 || decoded.status === 205 || decoded.status === 304;
    // A copy: `message` is the decryption buffer and the content is a view into it.
    return new Response(withoutBody ? null : new Uint8Array(decoded.content), { status: decoded.status, headers });
  } catch {
    // Whatever went wrong, the original error could quote the response.
    throw new RpcClientError("bad_response", "the decrypted response is not a valid HTTP message", 200);
  }
}
