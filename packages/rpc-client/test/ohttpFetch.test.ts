// The SDK's own sources, by path: this package does not depend on @loch/sdk, it only has to fit it.
import { RelayerClient, type WireFetch } from "../../sdk/src/wire.js";
import { describe, expect, it, vi } from "vitest";

import { encodeRequest } from "../src/bhttp.js";
import { bytesToBase64, bytesToHex, hexToBytes } from "../src/bytes.js";
import { RpcClientError, type RpcClientErrorCode } from "../src/errors.js";
import { createOhttpFetch, describeKeyConfigs } from "../src/index.js";
import {
  AEAD_AES_128_GCM,
  AEAD_AES_256_GCM,
  AEAD_CHACHA20_POLY1305,
  KDF_HKDF_SHA256,
  KEM_X25519_HKDF_SHA256,
  KEM_X_WING,
  type KeyConfig,
  decodeKeyConfigList,
  encodeKeyConfigList,
  keyFingerprint,
} from "../src/keyConfig.js";
import { REQUEST_OVERHEAD_BYTES, generateGatewaySecretKey, importGatewayKey, requestOverheadBytes } from "../src/ohttp.js";
import { KEYS_URL, RELAY_URL, jsonResponse, makeGateway } from "./helpers/fakeGateway.js";

const RPC_URL = "https://rpc.loch.example/";
const ADDRESS = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const body = (method = "getBalance") => JSON.stringify({ jsonrpc: "2.0", id: "1", method, params: [ADDRESS] });
const post = (extraHeaders: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...extraHeaders },
  body: body(),
});

async function failure(promise: Promise<unknown>, code: RpcClientErrorCode): Promise<RpcClientError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RpcClientError);
  expect((error as RpcClientError).code).toBe(code);
  return error as RpcClientError;
}

/** Everything an error could be made to print. */
const printed = (error: Error) => [error.name, error.message, error.stack ?? "", JSON.stringify(error), String((error as { cause?: unknown }).cause)].join("\n");

describe("createOhttpFetch", () => {
  it("carries a request to the gateway and the answer back, through the relay only", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });

    const response = await ohttpFetch(RPC_URL, post());
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      method: "POST",
      scheme: "https",
      authority: "rpc.loch.example",
      path: "/",
      headers: [["content-type", "application/json"]],
      body: body(),
    });

    // One connection, to the relay, with nothing but the encrypted message.
    expect(gateway.outer).toHaveLength(1);
    const { url, init } = gateway.outer[0]!;
    expect(url).toBe(RELAY_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "message/ohttp-req" });
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    expect(gateway.keyFetches).toHaveLength(0);
  });

  it("passes on only allowlisted headers: what identifies the client library or the user stays behind", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    await ohttpFetch(RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "solana-client": "js/1.0.0-maintenance",
        Authorization: "Bearer secret",
        Cookie: "session=1",
        "User-Agent": "wallet/1.2.3",
        "X-Forwarded-For": "203.0.113.7",
      },
      body: body(),
      // web3.js passes its keep-alive agent here in Node; it must be ignored.
      ...({ agent: {} } as object),
    });
    expect(gateway.inner[0]!.headers).toEqual([
      ["accept", "application/json"],
      ["content-type", "application/json"],
    ]);

    const custom = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch, forwardHeaders: ["content-type", "x-app"] });
    await custom(RPC_URL, post({ "x-app": "1", accept: "*/*" }));
    expect(gateway.inner[1]!.headers).toEqual([
      ["content-type", "application/json"],
      ["x-app", "1"],
    ]);
  });

  it("accepts a URL object, a Request, and text or byte bodies", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    const bytes = new TextEncoder().encode(body());

    await ohttpFetch(new URL("https://rpc.loch.example:8443/v1?x=1#frag"), { method: "post", body: bytes });
    await ohttpFetch(new Request(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: body() }));
    await ohttpFetch(RPC_URL, { method: "POST", body: bytes.buffer });
    await ohttpFetch(RPC_URL, { method: "POST", body: new URLSearchParams({ a: "1" }) });
    await ohttpFetch(RPC_URL, { method: "POST", body: new Blob([bytes], { type: "application/json" }) });
    await ohttpFetch("https://rpc.loch.example/health");

    expect(gateway.inner[0]).toMatchObject({ method: "POST", authority: "rpc.loch.example:8443", path: "/v1?x=1", headers: [] });
    expect(new TextDecoder().decode(gateway.inner[0]!.content)).toBe(body());
    expect(gateway.inner[1]).toMatchObject({ method: "POST", path: "/", headers: [["content-type", "application/json"]] });
    expect(new TextDecoder().decode(gateway.inner[1]!.content)).toBe(body());
    expect(new TextDecoder().decode(gateway.inner[2]!.content)).toBe(body());
    expect(gateway.inner[3]!.headers).toEqual([["content-type", "application/x-www-form-urlencoded;charset=UTF-8"]]);
    expect(new TextDecoder().decode(gateway.inner[3]!.content)).toBe("a=1");
    expect(gateway.inner[4]!.headers).toEqual([["content-type", "application/json"]]);
    expect(gateway.inner[5]).toMatchObject({ method: "GET", path: "/health", content: new Uint8Array(0) });
  });

  it("refuses what it cannot carry, before anything is sent", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    const stream = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    await failure(ohttpFetch(RPC_URL, { method: "POST", body: stream }), "unsupported_request");
    await failure(ohttpFetch(RPC_URL, { method: "POST", body: new FormData() }), "unsupported_request");
    await failure(ohttpFetch("ftp://rpc.loch.example/"), "unsupported_request");
    await failure(ohttpFetch("/relative"), "unsupported_request");
    await failure(ohttpFetch("https://user:pass@rpc.loch.example/"), "unsupported_request");
    await failure(ohttpFetch(RPC_URL, { method: "GET", body: "x" }), "unsupported_request");
    expect(gateway.outer).toHaveLength(0);
  });

  it("turns the gateway's status codes into ordinary responses", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    gateway.handler = () => jsonResponse(429, { jsonrpc: "2.0", id: null, error: { code: -32096, message: "slow down" } });
    const limited = await ohttpFetch(RPC_URL, post());
    expect(limited.status).toBe(429);
    expect(limited.ok).toBe(false);
    expect((await limited.json()).error.code).toBe(-32096);

    gateway.handler = () => ({ status: 204, headers: [], content: new Uint8Array(0) });
    const empty = await ohttpFetch(RPC_URL, post());
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });

  it.each([
    ["ChaCha20Poly1305", AEAD_CHACHA20_POLY1305],
    ["AES-256-GCM", AEAD_AES_256_GCM],
  ])("works when the gateway offers only %s", async (_, aeadId) => {
    const gateway = await makeGateway(200, [aeadId]);
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    const response = await ohttpFetch(RPC_URL, post());
    expect((await response.json()).body).toBe(body());
  });

  it("does not use AES-128-GCM: a gateway that offers nothing else is refused, and one that lists it first gets the next algorithm", async () => {
    const gateway = await makeGateway(200);
    const [config] = decodeKeyConfigList(gateway.keyConfigList());
    const listing = (...aeadIds: number[]) => encodeKeyConfigList([{ ...config!, symmetric: aeadIds.map((aeadId) => ({ kdfId: KDF_HKDF_SHA256, aeadId })) }]);
    expect(() => createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: listing(AEAD_AES_128_GCM), fetch: gateway.fetch })).toThrow(
      expect.objectContaining({ name: "RpcClientError", code: "key_config_invalid" }),
    );
    // The key configuration a gateway served before this rule: AES-128-GCM first.
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: listing(AEAD_AES_128_GCM, AEAD_CHACHA20_POLY1305, AEAD_AES_256_GCM), fetch: gateway.fetch });
    expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    // The AEAD is the last two bytes of the seven-byte header of what went to the relay.
    const sent = new Uint8Array(gateway.outer[0]!.init.body as Uint8Array);
    expect((sent[5]! << 8) | sent[6]!).toBe(AEAD_CHACHA20_POLY1305);
  });

  it("takes the key configuration as bytes, hex or base64", async () => {
    const gateway = await makeGateway();
    const list = gateway.keyConfigList();
    for (const keyConfig of [list, bytesToHex(list), bytesToBase64(list)]) {
      const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig, fetch: gateway.fetch });
      expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    }
    expect(describeKeyConfigs(bytesToBase64(list))).toEqual([
      {
        keyId: 1,
        kemId: KEM_X25519_HKDF_SHA256,
        kem: "X25519",
        publicKey: gateway.publicKeyHex(),
        fingerprint: keyFingerprint({ kemId: KEM_X25519_HKDF_SHA256, publicKey: hexToBytes(gateway.publicKeyHex()) }),
        aeadIds: [AEAD_CHACHA20_POLY1305, AEAD_AES_256_GCM],
        usable: true,
        chosen: true,
      },
    ]);
  });
});

describe("padding", () => {
  const inner = () =>
    encodeRequest({
      method: "POST",
      scheme: "https",
      authority: "rpc.loch.example",
      path: "/",
      headers: [["content-type", "application/json"]],
      content: new TextEncoder().encode(body()),
    }).length;

  it("pads every request to a bucket by default, so a read and a transaction submission have the same size", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    await ohttpFetch(RPC_URL, post());
    const transaction = "A".repeat(1644); // a full 1232-byte transaction in base64
    await ohttpFetch(RPC_URL, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [transaction, { encoding: "base64" }] }) });
    await ohttpFetch(RPC_URL, { method: "POST", body: "x".repeat(5000) });
    await ohttpFetch(RPC_URL, { method: "POST", body: "x".repeat(300_000) });

    expect(gateway.innerLengths).toEqual([4096, 4096, 16384, 524288]);
    expect(gateway.outer.map((request) => request.bodyLength)).toEqual([4096, 4096, 16384, 524288].map((size) => size + REQUEST_OVERHEAD_BYTES));
    // The gateway reads the padded request as the same request.
    expect(new TextDecoder().decode(gateway.inner[0]!.content)).toBe(body());
  });

  it("uses the configured buckets, or none", async () => {
    const gateway = await makeGateway();
    const coarse = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch, padding: { buckets: [1000, 300] } });
    const off = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch, padding: false });
    await coarse(RPC_URL, post());
    await coarse(RPC_URL, { method: "POST", body: "x".repeat(2500) });
    await off(RPC_URL, post());
    expect(gateway.innerLengths).toEqual([300, 3000, inner()]);
    expect(() => createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), padding: { buckets: [0] } })).toThrow(RpcClientError);
  });
});

describe("key configuration", () => {
  it("fetches it once from keyConfigUrl and shares the fetch between concurrent requests", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: gateway.fetch });
    const responses = await Promise.all([ohttpFetch(RPC_URL, post()), ohttpFetch(RPC_URL, post()), ohttpFetch(RPC_URL, post())]);
    await ohttpFetch(RPC_URL, post());
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(gateway.keyFetches).toHaveLength(1);
    expect(gateway.keyFetches[0]!.init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
    expect(gateway.outer).toHaveLength(4);
  });

  it("lets the platform's HTTP cache answer for the key configuration, and nothing else", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: gateway.fetch });
    await ohttpFetch(RPC_URL, post());
    // The key configuration is public, the same for everyone and served to be cached: a cached copy means the host is not contacted.
    expect(gateway.keyFetches[0]!.init).toMatchObject({ method: "GET", cache: "default", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", mode: "cors" });
    expect(gateway.keyFetches[0]!.init.headers).toEqual({ accept: "application/ohttp-keys" });
    // A request to the relay is never stored and never answered from a cache.
    expect(gateway.outer[0]!.init).toMatchObject({ method: "POST", cache: "no-store" });
  });

  it("uses a separate transport for the key configuration when given one", async () => {
    const gateway = await makeGateway();
    const relayOnly: typeof fetch = (input, init) => {
      if (String(input) !== RELAY_URL) throw new Error("the relay transport must not fetch keys");
      return gateway.fetch(input, init);
    };
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: relayOnly, keyConfigFetch: gateway.fetch });
    expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    expect(gateway.keyFetches).toHaveLength(1);
  });

  it("refetches once when the gateway rejects the key, then succeeds with the new key, which is pinned too", async () => {
    const gateway = await makeGateway();
    // A release that ships the key in use and pins it together with the one the gateway will rotate to.
    const pins = [gateway.publicKeyHex(), await gateway.prepareRotation()];
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), keyConfigUrl: KEYS_URL, pinnedPublicKeys: pins, fetch: gateway.fetch });
    expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    expect(gateway.keyFetches).toHaveLength(0);

    await gateway.rotate();
    const response = await ohttpFetch(RPC_URL, post());
    expect(response.status).toBe(200);
    expect(gateway.keyFetches).toHaveLength(1);
    // First attempt rejected, second accepted; the handler saw the request exactly once.
    expect(gateway.outer).toHaveLength(3);
    expect(gateway.inner).toHaveLength(2);

    // The new key is kept.
    expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    expect(gateway.keyFetches).toHaveLength(1);
  });

  it("gives up with key_rejected after one refetch, or at once when there is nowhere to fetch from", async () => {
    const gateway = await makeGateway();
    const stale = gateway.keyConfigList();
    const stalePin = gateway.publicKeyHex();
    await gateway.rotate();
    const pinnedOnly = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: stale, fetch: gateway.fetch });
    const error = await failure(pinnedOnly(RPC_URL, post()), "key_rejected");
    expect(error.status).toBe(400);
    expect(gateway.outer).toHaveLength(1);

    // A key source that keeps serving the stale key: one refetch, one error, no loop.
    const staleSource: typeof fetch = async (input, init) =>
      String(input) === KEYS_URL ? new Response(stale as Uint8Array<ArrayBuffer>, { status: 200 }) : gateway.fetch(input, init);
    const stuck = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: stale, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [stalePin], fetch: staleSource });
    await failure(stuck(RPC_URL, post()), "key_rejected");
    expect(gateway.outer).toHaveLength(2);
    expect(gateway.inner).toHaveLength(0);
  });

  it("refreshes on an unexplained 4xx too (a relay may hide the gateway's reason), at most once a minute", async () => {
    const gateway = await makeGateway();
    const stale = gateway.keyConfigList();
    const pins = [gateway.publicKeyHex(), await gateway.prepareRotation()];
    await gateway.rotate();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: stale, keyConfigUrl: KEYS_URL, pinnedPublicKeys: pins, fetch: gateway.fetch });
    gateway.nextRelayAnswer = () => new Response("bad request", { status: 400 });
    expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    expect(gateway.keyFetches).toHaveLength(1);

    // Same again right away: the key did not change and was fetched seconds ago, so this is a plain relay error.
    gateway.nextRelayAnswer = () => new Response("bad request", { status: 400 });
    await failure(ohttpFetch(RPC_URL, post()), "relay_error");
    expect(gateway.keyFetches).toHaveLength(1);
  });

  it("a relay that keeps claiming the key is unknown cannot make the client fetch the key configuration on every request", async () => {
    const gateway = await makeGateway();
    // Unauthenticated, so anyone on the path can send it.
    const lying: typeof fetch = async (input, init) =>
      String(input) === RELAY_URL
        ? new Response('{"type":"https://iana.org/assignments/http-problem-types#ohttp-key"}', { status: 400, headers: { "content-type": "application/problem+json" } })
        : gateway.fetch(input, init);
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: lying });
    for (let i = 0; i < 5; i++) await failure(ohttpFetch(RPC_URL, post()), "key_rejected");
    expect(gateway.keyFetches).toHaveLength(1);
  });

  it("one caller giving up does not fail the others that wait for the same key configuration", async () => {
    const gateway = await makeGateway();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowKeys: typeof fetch = async (input, init) => {
      if (String(input) === KEYS_URL) await gate;
      return gateway.fetch(input, init);
    };
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: slowKeys });
    const controller = new AbortController();
    const first = ohttpFetch(RPC_URL, { ...post(), signal: controller.signal });
    const second = ohttpFetch(RPC_URL, post());
    const firstOutcome = first.catch((reason: unknown) => reason);
    controller.abort();
    expect(await firstOutcome).toBe(controller.signal.reason);
    release();
    expect((await second).status).toBe(200);
    expect(gateway.keyFetches).toHaveLength(1);
  });

  it("a key configuration host that never answers costs one deadline, not a hung client", async () => {
    const gateway = await makeGateway();
    let attempts = 0;
    const hangingKeys: typeof fetch = (input, init) => {
      if (String(input) !== KEYS_URL) return gateway.fetch(input, init);
      attempts += 1;
      return new Promise(() => undefined);
    };
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: hangingKeys, timeoutMs: 40 });
    await failure(ohttpFetch(RPC_URL, post()), "timeout");
    // The shared fetch gave up as well, so the next request is not left waiting on it forever. It is
    // not made again straight away either: for a minute the host is left alone and the answer is the failure.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    await failure(ohttpFetch(RPC_URL, post()), "key_config_unavailable");
    expect(Date.now() - started).toBeLessThan(30);
    expect(attempts).toBe(1);

    // After the minute it is tried again.
    const clock = vi.spyOn(Date, "now").mockReturnValue(started + 61_000);
    try {
      await failure(ohttpFetch(RPC_URL, post()), "timeout");
      expect(attempts).toBe(2);
    } finally {
      clock.mockRestore();
    }
    expect(gateway.outer).toHaveLength(0);
  });

  it("asks a key configuration host that is down once a minute, not once a call", async () => {
    const gateway = await makeGateway();
    let up = false;
    let keyFetches = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (String(input) !== KEYS_URL) return gateway.fetch(input, init);
      keyFetches += 1;
      return up ? gateway.fetch(input, init) : new Response("no", { status: 503 });
    };
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: flaky });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      // Five attempted calls: one request to the host. It learns of one, not of five, nor when the others were made.
      const errors: RpcClientError[] = [];
      for (let i = 0; i < 5; i++) errors.push(await failure(ohttpFetch(RPC_URL, post()), "key_config_unavailable"));
      expect(keyFetches).toBe(1);
      expect(errors.map((error) => error.status)).toEqual([503, 503, 503, 503, 503]);
      // Each caller gets an error of its own, with the fixed message and nothing of the request.
      expect(new Set(errors).size).toBe(5);
      for (const error of errors) expect(printed(error)).not.toContain(ADDRESS);
      expect(gateway.outer).toHaveLength(0);

      // Still within the minute, also when calls come at once.
      clock.mockReturnValue(now + 59_000);
      await Promise.all([failure(ohttpFetch(RPC_URL, post()), "key_config_unavailable"), failure(ohttpFetch(RPC_URL, post()), "key_config_unavailable")]);
      expect(keyFetches).toBe(1);

      // The minute is over and the host is still down: one more request, and another minute.
      clock.mockReturnValue(now + 60_000);
      await failure(ohttpFetch(RPC_URL, post()), "key_config_unavailable");
      await failure(ohttpFetch(RPC_URL, post()), "key_config_unavailable");
      expect(keyFetches).toBe(2);

      // The host comes back. The next attempt after the minute succeeds, and from then on nothing is fetched.
      up = true;
      clock.mockReturnValue(now + 119_000);
      await failure(ohttpFetch(RPC_URL, post()), "key_config_unavailable");
      clock.mockReturnValue(now + 120_000);
      expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
      expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
      expect(keyFetches).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("asks a host that serves a key the pins refuse once a minute too, and sends nothing to the relay", async () => {
    const gateway = await makeGateway();
    const attacker = await makeGateway(1);
    let keyFetches = 0;
    const substituting: typeof fetch = async (input, init) => {
      if (String(input) !== KEYS_URL) return attacker.fetch(input, init);
      keyFetches += 1;
      return new Response(attacker.keyConfigList() as Uint8Array<ArrayBuffer>, { status: 200 });
    };
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: substituting });
    for (let i = 0; i < 5; i++) await failure(ohttpFetch(RPC_URL, post()), "key_config_pin_mismatch");
    expect(keyFetches).toBe(1);
    expect(attacker.outer).toHaveLength(0);

    // The same for a host that serves something that is not a key configuration.
    let garbageFetches = 0;
    const garbage: typeof fetch = async () => {
      garbageFetches += 1;
      return new Response("<html>", { status: 200 });
    };
    const confused = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [gateway.publicKeyHex()], fetch: garbage });
    for (let i = 0; i < 5; i++) await failure(confused(RPC_URL, post()), "key_config_invalid");
    expect(garbageFetches).toBe(1);
  });

  it("uses only a pinned key: a substituted key configuration is refused and nothing is sent", async () => {
    const gateway = await makeGateway();
    const attacker = await makeGateway(1);
    const pin = gateway.publicKeyHex();

    // Given directly.
    expect(() => createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: attacker.keyConfigList(), pinnedPublicKeys: [pin], fetch: gateway.fetch })).toThrow(
      expect.objectContaining({ code: "key_config_pin_mismatch" }),
    );

    // Fetched: whoever serves the key configuration substitutes its own key.
    const substituting: typeof fetch = async (input, init) =>
      String(input) === KEYS_URL ? new Response(attacker.keyConfigList() as Uint8Array<ArrayBuffer>, { status: 200 }) : attacker.fetch(input, init);
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [pin], fetch: substituting });
    await failure(ohttpFetch(RPC_URL, post()), "key_config_pin_mismatch");
    expect(attacker.outer).toHaveLength(0);

    // The genuine one passes, as hex or as bytes.
    const good = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [new Uint8Array(32), pin], fetch: gateway.fetch });
    expect((await good(RPC_URL, post())).status).toBe(200);
  });

  it("refuses a key configuration URL without pins, unless told in so many words to do without them", async () => {
    const gateway = await makeGateway();
    const unpinned = { relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, fetch: gateway.fetch };
    expect(() => createOhttpFetch(unpinned)).toThrow(expect.objectContaining({ name: "RpcClientError", code: "invalid_argument" }));
    expect(() => createOhttpFetch(unpinned)).toThrow(/keyConfigUrl requires pinnedPublicKeys/);
    // With a key configuration given as well, it is the same: the URL would be where a replacement comes from.
    expect(() => createOhttpFetch({ ...unpinned, keyConfig: gateway.keyConfigList() })).toThrow(/keyConfigUrl requires pinnedPublicKeys/);
    // Anything but `true` is not the opt-out.
    for (const value of [false, undefined, 1, "true", "yes"]) {
      expect(() => createOhttpFetch({ ...unpinned, allowUnpinnedKeyConfigUrl: value as never }), String(value)).toThrow(/keyConfigUrl requires pinnedPublicKeys/);
    }
    expect(gateway.keyFetches).toHaveLength(0);

    const accepted = createOhttpFetch({ ...unpinned, allowUnpinnedKeyConfigUrl: true });
    expect((await accepted(RPC_URL, post())).status).toBe(200);
    // Without a key configuration URL there is nothing to opt out of, and nothing changes.
    createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList() });
  });

  it("without a pin, a substituted key lets the substitute read the request: this is why the opt-out is not the default", async () => {
    const attacker = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, allowUnpinnedKeyConfigUrl: true, fetch: attacker.fetch });
    await ohttpFetch(RPC_URL, post());
    expect(new TextDecoder().decode(attacker.inner[0]!.content)).toContain(ADDRESS);
  });

  it("refuses a key configuration URL on the relay's own origin, pinned or not", async () => {
    const gateway = await makeGateway();
    const pin = gateway.publicKeyHex();
    const refused = (relayUrl: string, keyConfigUrl: string, extra: object = {}) => {
      const create = () => createOhttpFetch({ relayUrl, keyConfigUrl, pinnedPublicKeys: [pin], fetch: gateway.fetch, ...extra });
      expect(create, `${relayUrl} ${keyConfigUrl}`).toThrow(expect.objectContaining({ name: "RpcClientError", code: "invalid_argument" }));
      expect(create, `${relayUrl} ${keyConfigUrl}`).toThrow(/must not be on the relay's origin/);
    };
    refused("https://relay.example/ohttp", "https://relay.example/ohttp-keys");
    refused("https://relay.example/ohttp", "https://relay.example/ohttp");
    refused("https://relay.example/ohttp", "https://RELAY.example:443/keys?x=1");
    refused("https://relay.example:8443/ohttp", "https://relay.example:8443/keys");
    refused("http://127.0.0.1:8788/", "http://127.0.0.1:8788/ohttp-keys");
    // Not with a bundled key, and not with the opt-out for pins either.
    refused("https://relay.example/ohttp", "https://relay.example/keys", { keyConfig: gateway.keyConfigList() });
    refused("https://relay.example/ohttp", "https://relay.example/keys", { pinnedPublicKeys: undefined, allowUnpinnedKeyConfigUrl: true });

    // Another origin is accepted: another host, or on this machine another port.
    createOhttpFetch({ relayUrl: "https://relay.example/ohttp", keyConfigUrl: "https://keys.example/ohttp-keys", pinnedPublicKeys: [pin] });
    createOhttpFetch({ relayUrl: "http://127.0.0.1:8788/", keyConfigUrl: "http://127.0.0.1:8787/ohttp-keys", pinnedPublicKeys: [pin] });
    expect(gateway.keyFetches).toHaveLength(0);
  });

  it("never replaces a key configuration that was given by a fetched one nothing vouches for, whatever the relay answers", async () => {
    const gateway = await makeGateway();
    const attacker = await makeGateway(1);
    let keyFetches = 0;
    // The relay answers what an attacker would: first that the key is unknown, then an unexplained 400.
    // The key host serves the attacker's key.
    const answers = [
      () => new Response('{"type":"https://iana.org/assignments/http-problem-types#ohttp-key"}', { status: 400, headers: { "content-type": "application/problem+json" } }),
      () => new Response("nope", { status: 400 }),
    ];
    const hostile: typeof fetch = async (input, init) => {
      if (String(input) === KEYS_URL) {
        keyFetches += 1;
        return new Response(attacker.keyConfigList() as Uint8Array<ArrayBuffer>, { status: 200 });
      }
      const answer = answers.shift();
      if (answer) return answer();
      // After that the relay behaves. Whichever key the request was encrypted to gets to read it.
      const sealedToAttacker = await attacker.fetch(input, { ...init });
      return sealedToAttacker.status === 200 ? sealedToAttacker : gateway.fetch(input, init);
    };
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), keyConfigUrl: KEYS_URL, allowUnpinnedKeyConfigUrl: true, fetch: hostile });
    await failure(ohttpFetch(RPC_URL, post()), "key_rejected");
    await failure(ohttpFetch(RPC_URL, post()), "relay_error");
    // The key host was never asked, so there was nothing to replace the key with.
    expect(keyFetches).toBe(0);
    // And the next request still goes to the key that came with the application: the attacker cannot read it.
    expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    expect(attacker.inner).toHaveLength(0);
    expect(gateway.inner).toHaveLength(1);
    expect(keyFetches).toBe(0);
  });

  it("rejects unusable options at once", async () => {
    const gateway = await makeGateway();
    const keyConfig = gateway.keyConfigList();
    const invalid = (options: object, code: RpcClientErrorCode = "invalid_argument") =>
      expect(() => createOhttpFetch(options as never)).toThrow(expect.objectContaining({ name: "RpcClientError", code }));
    invalid({ relayUrl: RELAY_URL });
    invalid({ relayUrl: "relay.example", keyConfig });
    invalid({ relayUrl: "http://relay.example/", keyConfig });
    invalid({ relayUrl: "https://user:pw@relay.example/", keyConfig });
    invalid({ relayUrl: RELAY_URL, keyConfigUrl: "http://keys.example/", keyConfig });
    invalid({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL });
    invalid({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, keyConfig });
    invalid({ relayUrl: RELAY_URL, keyConfigUrl: RELAY_URL, pinnedPublicKeys: [gateway.publicKeyHex()] });
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: [] });
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: ["abcd"] });
    // A pin is 32 bytes, 1216 bytes or a fingerprint. Nothing in between, and one bad pin spoils the list.
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: [new Uint8Array(33)] });
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: [new Uint8Array(1215)] });
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: ["sha256:abcd"] });
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: [`sha256:${"g".repeat(64)}`] });
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: [`sha256:${"0".repeat(66)}`] });
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: [gateway.publicKeyHex(), "abcd"] });
    invalid({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: gateway.publicKeyHex() });
    invalid({ relayUrl: RELAY_URL, keyConfig, timeoutMs: -1 });
    invalid({ relayUrl: RELAY_URL, keyConfig, forwardHeaders: ["bad header"] });
    invalid({ relayUrl: RELAY_URL, keyConfig: "zz not base64 !!" }, "key_config_invalid");
    invalid({ relayUrl: RELAY_URL, keyConfig: keyConfig.subarray(0, 20) }, "key_config_invalid");
    invalid({ relayUrl: RELAY_URL, keyConfig: new Uint8Array(0) }, "key_config_invalid");
    // Plain HTTP is fine for this machine and with the explicit option.
    createOhttpFetch({ relayUrl: "http://127.0.0.1:8788/", keyConfig });
    createOhttpFetch({ relayUrl: "http://localhost:8788/", keyConfig });
    createOhttpFetch({ relayUrl: "http://relay.internal/", keyConfig, allowInsecureHttp: true });
  });

  it("reports a key configuration that cannot be fetched or parsed", async () => {
    const down: typeof fetch = async () => new Response("no", { status: 503 });
    const pinnedPublicKeys = [new Uint8Array(32)];
    const error = await failure(createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys, fetch: down })(RPC_URL, post()), "key_config_unavailable");
    expect(error.status).toBe(503);
    const unreachable: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await failure(createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys, fetch: unreachable })(RPC_URL, post()), "key_config_unavailable");
    const garbage: typeof fetch = async () => new Response("<html>", { status: 200 });
    await failure(createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys, fetch: garbage })(RPC_URL, post()), "key_config_invalid");
  });
});

describe("X-Wing", () => {
  /** A gateway with an X25519 key (identifier 1, listed first) and an X-Wing key (identifier 2). */
  async function hybridGateway() {
    const gateway = await makeGateway(1);
    const xWing = await importGatewayKey(2, generateGatewaySecretKey(), undefined, KEM_X_WING);
    gateway.moreKeys.push(xWing);
    const [classicalConfig, xWingConfig] = decodeKeyConfigList(gateway.keyConfigList()) as [KeyConfig, KeyConfig];
    return { gateway, xWing, classicalConfig, xWingConfig, classicalPin: gateway.publicKeyHex(), xWingPin: keyFingerprint(xWingConfig) };
  }

  it("uses the X-Wing key of a list whatever its position, and the request is 1,088 bytes longer for it", async () => {
    const { gateway, classicalConfig, xWingConfig } = await hybridGateway();
    expect(decodeKeyConfigList(gateway.keyConfigList()).map((config) => config.kemId)).toEqual([KEM_X25519_HKDF_SHA256, KEM_X_WING]);
    for (const list of [gateway.keyConfigList(), encodeKeyConfigList([xWingConfig, classicalConfig])]) {
      const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: list, fetch: gateway.fetch });
      const response = await ohttpFetch(RPC_URL, post());
      expect((await response.json()).body).toBe(body());
    }
    expect(gateway.kems).toEqual([KEM_X_WING, KEM_X_WING]);
    expect(gateway.outer.map((request) => request.bodyLength)).toEqual([4096 + requestOverheadBytes(KEM_X_WING), 4096 + requestOverheadBytes(KEM_X_WING)]);
    expect(requestOverheadBytes(KEM_X_WING) - REQUEST_OVERHEAD_BYTES).toBe(1088);
    expect(gateway.innerLengths).toEqual([4096, 4096]);
  });

  it("falls back to X25519 when the list has no X-Wing key, and when the X-Wing key offers no algorithm it uses", async () => {
    const { gateway, classicalConfig, xWingConfig } = await hybridGateway();
    const onlyClassical = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: encodeKeyConfigList([classicalConfig]), fetch: gateway.fetch });
    expect((await onlyClassical(RPC_URL, post())).status).toBe(200);
    const unusable = { ...xWingConfig, symmetric: [{ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM }] };
    const mixed = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: encodeKeyConfigList([unusable, classicalConfig]), fetch: gateway.fetch });
    expect((await mixed(RPC_URL, post())).status).toBe(200);
    expect(gateway.kems).toEqual([KEM_X25519_HKDF_SHA256, KEM_X25519_HKDF_SHA256]);
  });

  it("describes both keys: KEM, fingerprint, and the public key in full", async () => {
    const { gateway, xWing, classicalPin, xWingPin } = await hybridGateway();
    const described = describeKeyConfigs(gateway.keyConfigList());
    expect(described.map(({ keyId, kemId, kem, usable, aeadIds }) => ({ keyId, kemId, kem, usable, aeadIds }))).toEqual([
      { keyId: 1, kemId: KEM_X25519_HKDF_SHA256, kem: "X25519", usable: true, aeadIds: [AEAD_CHACHA20_POLY1305, AEAD_AES_256_GCM] },
      { keyId: 2, kemId: KEM_X_WING, kem: "X-Wing", usable: true, aeadIds: [AEAD_CHACHA20_POLY1305, AEAD_AES_256_GCM] },
    ]);
    expect(described[0]!.publicKey).toBe(classicalPin);
    expect(described[1]!.publicKey).toBe(bytesToHex(xWing.publicKey));
    expect(described[1]!.publicKey).toHaveLength(2432);
    expect(described[1]!.fingerprint).toBe(xWingPin);
    expect(described[0]!.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(described[0]!.fingerprint).not.toBe(described[1]!.fingerprint);
  });

  it("says which key a client would encrypt to, for the pins it is given", async () => {
    const { gateway, classicalConfig, xWingConfig, classicalPin, xWingPin } = await hybridGateway();
    const list = gateway.keyConfigList();
    const chosen = (pins?: (Uint8Array | string)[]) => describeKeyConfigs(list, pins).map((entry) => entry.chosen);
    // X-Wing wherever it stands, unless the pins leave only the X25519 key.
    expect(chosen()).toEqual([false, true]);
    expect(describeKeyConfigs(encodeKeyConfigList([xWingConfig, classicalConfig])).map((entry) => entry.chosen)).toEqual([true, false]);
    expect(chosen([xWingPin])).toEqual([false, true]);
    expect(chosen([classicalPin])).toEqual([true, false]);
    expect(chosen([classicalPin, xWingPin])).toEqual([false, true]);
    // It is the key the fetch then uses.
    const pinned = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: list, pinnedPublicKeys: [classicalPin], fetch: gateway.fetch });
    expect((await pinned(RPC_URL, post())).status).toBe(200);
    expect(gateway.kems).toEqual([KEM_X25519_HKDF_SHA256]);
    // Pins that match nothing, and a list with nothing usable: no entry is chosen, and nothing throws.
    expect(chosen([`sha256:${"0".repeat(64)}`])).toEqual([false, false]);
    const unusable = { ...xWingConfig, symmetric: [{ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM }] };
    expect(describeKeyConfigs(encodeKeyConfigList([unusable])).map((entry) => [entry.usable, entry.chosen])).toEqual([[false, false]]);
    // The same key listed twice is marked once.
    expect(describeKeyConfigs(encodeKeyConfigList([xWingConfig, xWingConfig])).map((entry) => entry.chosen)).toEqual([true, false]);
    // Malformed pins are an error here as they are for the fetch.
    expect(() => describeKeyConfigs(list, [])).toThrow(expect.objectContaining({ code: "invalid_argument" }));
    expect(() => describeKeyConfigs(list, ["not a pin"])).toThrow(expect.objectContaining({ code: "invalid_argument" }));
  });

  it("accepts an X-Wing pin as a fingerprint or as the whole public key, in any spelling", async () => {
    const { gateway, xWing, xWingPin } = await hybridGateway();
    const pins: (Uint8Array | string)[] = [xWingPin, xWingPin.toUpperCase().replace("SHA256:", "sha256:"), ` ${xWingPin} `, xWing.publicKey, bytesToHex(xWing.publicKey), bytesToBase64(xWing.publicKey)];
    for (const pin of pins) {
      const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [pin], fetch: gateway.fetch });
      expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    }
    expect(gateway.kems).toEqual(pins.map(() => KEM_X_WING));
  });

  it("accepts an X25519 pin as 32 bytes or as a fingerprint, and then uses that key although the list has an X-Wing key", async () => {
    const { gateway, classicalConfig, classicalPin } = await hybridGateway();
    for (const pin of [classicalPin, hexToBytes(classicalPin), keyFingerprint(classicalConfig)]) {
      const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), pinnedPublicKeys: [pin], fetch: gateway.fetch });
      expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    }
    expect(gateway.kems).toEqual([KEM_X25519_HKDF_SHA256, KEM_X25519_HKDF_SHA256, KEM_X25519_HKDF_SHA256]);
  });

  it("with both keys pinned prefers X-Wing in any order; pinning X-Wing alone is what refuses a list the X-Wing key was taken out of", async () => {
    const { gateway, classicalConfig, xWingConfig, classicalPin, xWingPin } = await hybridGateway();
    const stripped = encodeKeyConfigList([classicalConfig]);
    const serving = (list: Uint8Array): typeof fetch => async (input, init) =>
      String(input) === KEYS_URL ? new Response(list as Uint8Array<ArrayBuffer>, { status: 200 }) : gateway.fetch(input, init);

    for (const pinnedPublicKeys of [[classicalPin, xWingPin], [xWingPin, classicalPin]]) {
      for (const list of [encodeKeyConfigList([classicalConfig, xWingConfig]), encodeKeyConfigList([xWingConfig, classicalConfig])]) {
        const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys, fetch: serving(list) });
        expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
      }
    }
    expect(gateway.kems).toEqual([KEM_X_WING, KEM_X_WING, KEM_X_WING, KEM_X_WING]);

    // Whoever serves the key configuration leaves the X-Wing entry out. With the X25519 key pinned too, that works: the client is on X25519.
    const downgraded = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [classicalPin, xWingPin], fetch: serving(stripped) });
    expect((await downgraded(RPC_URL, post())).status).toBe(200);
    expect(gateway.kems.at(-1)).toBe(KEM_X25519_HKDF_SHA256);

    // With only the X-Wing key pinned it does not, and nothing is sent.
    const sent = gateway.outer.length;
    const strict = createOhttpFetch({ relayUrl: RELAY_URL, keyConfigUrl: KEYS_URL, pinnedPublicKeys: [xWingPin], fetch: serving(stripped) });
    await failure(strict(RPC_URL, post()), "key_config_pin_mismatch");
    expect(() => createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: stripped, pinnedPublicKeys: [xWingPin], fetch: gateway.fetch })).toThrow(
      expect.objectContaining({ code: "key_config_pin_mismatch" }),
    );
    expect(gateway.outer).toHaveLength(sent);
  });

  it("never confuses the kinds of pin: a fingerprint is not a public key, and a public key is not a fingerprint", async () => {
    const { gateway, classicalConfig, xWingConfig, classicalPin, xWingPin } = await hybridGateway();
    const refused = (keyConfig: Uint8Array, pin: Uint8Array | string) =>
      expect(() => createOhttpFetch({ relayUrl: RELAY_URL, keyConfig, pinnedPublicKeys: [pin], fetch: gateway.fetch })).toThrow(
        expect.objectContaining({ name: "RpcClientError", code: "key_config_pin_mismatch" }),
      );
    const both = gateway.keyConfigList();
    const digest = (fingerprint: string) => fingerprint.slice("sha256:".length);

    // An attacker's X25519 key configuration whose public key is, byte for byte, the fingerprint that
    // was pinned for the X-Wing key. If 32 pinned bytes were compared with public keys and with hashes
    // alike, this would pass, and the pin on the X-Wing key would have let an X25519 key in.
    const forged: KeyConfig = { ...classicalConfig, keyId: 9, publicKey: hexToBytes(digest(xWingPin)) };
    refused(encodeKeyConfigList([forged]), xWingPin);
    refused(encodeKeyConfigList([forged, classicalConfig]), xWingPin);
    // The other way round: the digest of a fingerprint given as 32 raw bytes is an X25519 public key and names no X-Wing key.
    refused(encodeKeyConfigList([xWingConfig]), digest(xWingPin));
    refused(encodeKeyConfigList([xWingConfig]), hexToBytes(digest(xWingPin)));
    // An X25519 public key written as a fingerprint is the fingerprint of nothing.
    refused(both, `sha256:${classicalPin}`);
    // A raw key matches its own KEM only: 32 bytes never match an X-Wing entry, and the first 32 bytes of an X-Wing key are no pin for it.
    refused(encodeKeyConfigList([xWingConfig]), classicalPin);
    refused(encodeKeyConfigList([xWingConfig]), xWingConfig.publicKey.subarray(0, 32));
    refused(encodeKeyConfigList([classicalConfig]), xWingConfig.publicKey);
    // A fingerprint names one key of one KEM: the X25519 key's fingerprint does not pin the X-Wing key, and the reverse.
    refused(encodeKeyConfigList([xWingConfig]), keyFingerprint(classicalConfig));
    refused(encodeKeyConfigList([classicalConfig]), xWingPin);
    // The same bytes claimed under the other KEM identifier have another fingerprint.
    refused(encodeKeyConfigList([classicalConfig]), keyFingerprint({ kemId: KEM_X_WING, publicKey: classicalConfig.publicKey }));

    // And each pin does match its own key.
    createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: both, pinnedPublicKeys: [xWingPin], fetch: gateway.fetch });
    createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: both, pinnedPublicKeys: [classicalPin], fetch: gateway.fetch });
    expect(gateway.outer).toHaveLength(0);
  });

  it("checks the size limit against the key actually used", async () => {
    const { gateway, classicalConfig, xWingConfig } = await hybridGateway();
    // Room for one 4,096-byte bucket with X25519, not with X-Wing.
    const maxRequestBytes = 4096 + REQUEST_OVERHEAD_BYTES;
    const classical = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: encodeKeyConfigList([classicalConfig]), fetch: gateway.fetch, maxRequestBytes });
    expect((await classical(RPC_URL, post())).status).toBe(200);
    const hybrid = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: encodeKeyConfigList([xWingConfig]), fetch: gateway.fetch, maxRequestBytes });
    await failure(hybrid(RPC_URL, post()), "request_too_large");
    expect(gateway.outer).toHaveLength(1);
    const roomy = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: encodeKeyConfigList([xWingConfig]), fetch: gateway.fetch, maxRequestBytes: 4096 + requestOverheadBytes(KEM_X_WING) });
    expect((await roomy(RPC_URL, post())).status).toBe(200);
    expect(gateway.kems).toEqual([KEM_X25519_HKDF_SHA256, KEM_X_WING]);
  });

  it("follows a rotation from one X-Wing key to the next when both are pinned", async () => {
    const gateway = await makeGateway(1);
    const first = await importGatewayKey(2, generateGatewaySecretKey(), undefined, KEM_X_WING);
    const second = await importGatewayKey(3, generateGatewaySecretKey(), undefined, KEM_X_WING);
    gateway.moreKeys.push(first);
    const pins = [first, second].map((key) => keyFingerprint(key));
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), keyConfigUrl: KEYS_URL, pinnedPublicKeys: pins, fetch: gateway.fetch });
    expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    gateway.moreKeys.splice(0, 1, second);
    expect((await ohttpFetch(RPC_URL, post())).status).toBe(200);
    expect(gateway.keyFetches).toHaveLength(1);
    expect(gateway.kems).toEqual([KEM_X_WING, KEM_X_WING]);
  });
});

describe("failures", () => {
  it("never turns an unauthenticated answer of the relay into a Response", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });

    gateway.nextRelayAnswer = () => new Response("Bad Gateway", { status: 502 });
    expect((await failure(ohttpFetch(RPC_URL, post()), "relay_error")).status).toBe(502);

    // A relay that answers 200 with its own JSON is not believed either.
    gateway.nextRelayAnswer = () => new Response('{"jsonrpc":"2.0","id":"1","result":{"value":0}}', { status: 200, headers: { "content-type": "application/json" } });
    expect((await failure(ohttpFetch(RPC_URL, post()), "relay_error")).status).toBe(200);
  });

  it("rejects a response that was modified, truncated or cut short", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    gateway.tamper = (sealed) => {
      const copy = new Uint8Array(sealed);
      copy[copy.length - 1] = copy[copy.length - 1]! ^ 1;
      return copy;
    };
    await failure(ohttpFetch(RPC_URL, post()), "decapsulation_failed");
    gateway.tamper = (sealed) => sealed.subarray(0, sealed.length - 1);
    await failure(ohttpFetch(RPC_URL, post()), "decapsulation_failed");
    gateway.tamper = () => new Uint8Array(10);
    await failure(ohttpFetch(RPC_URL, post()), "decapsulation_failed");
  });

  it("rejects a decrypted response that is not Binary HTTP", async () => {
    const gateway = await makeGateway();
    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    gateway.rawResponse = new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n");
    await failure(ohttpFetch(RPC_URL, post()), "bad_response");
  });

  it("enforces the size limits on both directions", async () => {
    const gateway = await makeGateway();
    const small = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch, maxRequestBytes: 4096, maxResponseBytes: 1000 });
    await failure(small(RPC_URL, post()), "request_too_large");
    expect(gateway.outer).toHaveLength(0);

    const smallResponse = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch, maxResponseBytes: 1000 });
    gateway.handler = () => jsonResponse(200, { data: "x".repeat(2000) });
    await failure(smallResponse(RPC_URL, post()), "response_too_large");
  });

  it("reports an unreachable relay, a timeout and an abort", async () => {
    const gateway = await makeGateway();
    const keyConfig = gateway.keyConfigList();
    const unreachable: typeof fetch = async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED while sending ${body()}`);
    };
    await failure(createOhttpFetch({ relayUrl: RELAY_URL, keyConfig, fetch: unreachable })(RPC_URL, post()), "network_error");

    const hanging: typeof fetch = () => new Promise(() => undefined);
    const started = Date.now();
    await failure(createOhttpFetch({ relayUrl: RELAY_URL, keyConfig, fetch: hanging, timeoutMs: 50 })(RPC_URL, post()), "timeout");
    expect(Date.now() - started).toBeLessThan(2000);

    const controller = new AbortController();
    const pending = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig, fetch: hanging })(RPC_URL, { ...post(), signal: controller.signal });
    const reason = new Error("the user closed the popup");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    const already = AbortSignal.abort();
    await expect(createOhttpFetch({ relayUrl: RELAY_URL, keyConfig, fetch: gateway.fetch })(RPC_URL, { ...post(), signal: already })).rejects.toBe(already.reason);
    expect(gateway.outer).toHaveLength(0);
  });

  it("no error says what was asked: not in the message, the stack, the properties or a cause", async () => {
    const gateway = await makeGateway();
    const keyConfig = gateway.keyConfigList();
    const leaky: typeof fetch = async (_, init) => {
      throw new TypeError(`fetch failed for body of ${(init?.body as Uint8Array).length} bytes about ${ADDRESS}`);
    };
    const errors: RpcClientError[] = [];
    errors.push(await failure(createOhttpFetch({ relayUrl: RELAY_URL, keyConfig, fetch: leaky })(RPC_URL, post()), "network_error"));

    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig, fetch: gateway.fetch });
    gateway.nextRelayAnswer = () => new Response(`error while relaying a request about ${ADDRESS}`, { status: 500 });
    errors.push(await failure(ohttpFetch(RPC_URL, post()), "relay_error"));
    gateway.tamper = () => new TextEncoder().encode(`${ADDRESS}${ADDRESS}${ADDRESS}`);
    errors.push(await failure(ohttpFetch(RPC_URL, post()), "decapsulation_failed"));
    gateway.tamper = undefined;
    gateway.rawResponse = new TextEncoder().encode(`not bhttp ${ADDRESS}`);
    errors.push(await failure(ohttpFetch(RPC_URL, post()), "bad_response"));
    gateway.rawResponse = undefined;
    errors.push(await failure(ohttpFetch(`https://rpc.loch.example/${ADDRESS}`, { method: "POST", body: new FormData() }), "unsupported_request"));
    // A header value the platform refuses: its TypeError quotes the value.
    errors.push(await failure(ohttpFetch(RPC_URL, { method: "POST", headers: { accept: `€${ADDRESS}` }, body: body() }), "unsupported_request"));

    expect(errors).toHaveLength(6);
    for (const error of errors) {
      const output = printed(error);
      expect(output).not.toContain(ADDRESS);
      expect(output).not.toContain("getBalance");
      expect(output).not.toContain("rpc.loch.example");
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      expect(Object.keys(error).sort()).toEqual(["code", "name", "status"]);
    }
  });
});

describe("as the transport of the Loch SDK's service clients", () => {
  it("fits the WireFetch type and carries a RelayerClient call", async () => {
    const gateway = await makeGateway();
    const info = {
      version: "0.1.0",
      cluster: "devnet",
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      programId: ADDRESS,
      relayer: "11111111111111111111111111111111",
      feeLamports: "5000",
      computeUnitLimit: 1_400_000,
    };
    gateway.handler = (request) => (request.method === "GET" && request.path === "/v1/info" ? jsonResponse(200, info) : jsonResponse(404, { error: { code: "not_found", message: "no" } }));

    const ohttpFetch = createOhttpFetch({ relayUrl: RELAY_URL, keyConfig: gateway.keyConfigList(), fetch: gateway.fetch });
    const transport: WireFetch = ohttpFetch;
    const client = new RelayerClient("https://relayer.loch.example", { fetch: transport });
    expect(await client.info()).toEqual(info);
    expect(gateway.inner[0]).toMatchObject({ method: "GET", scheme: "https", authority: "relayer.loch.example", path: "/v1/info", headers: [["accept", "application/json"]] });
    expect(gateway.outer[0]!.url).toBe(RELAY_URL);
  });
});
