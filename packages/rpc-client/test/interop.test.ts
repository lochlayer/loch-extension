// Interoperability with ohttp-js, an Oblivious HTTP implementation written
// independently of this one (by an author of RFC 9458, on an older HPKE
// library and its own framing code). It is a devDependency used only here.
// It speaks DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM, which a
// client of this package no longer chooses: as a client, this side is told to
// (`allowAes128Gcm`); as a gateway it needs nothing, because an X25519 key
// still accepts AES-128-GCM from clients that send it. X-Wing is checked
// against another independent implementation in xwing-interop.test.ts.

import { Client, PublicKeyConfig, KeyConfig as TheirKeyConfig, Server } from "ohttp-js";
import { describe, expect, it } from "vitest";

import { decodeRequest, decodeResponse, encodeRequest, encodeResponse } from "../src/bhttp.js";
import { OhttpError } from "../src/errors.js";
import { AEAD_AES_128_GCM, KDF_HKDF_SHA256, KEM_X25519_HKDF_SHA256, type KeyConfig, decodeKeyConfigList } from "../src/keyConfig.js";
import { decapsulateRequest, encapsulateRequest, gatewayKeyConfig, generateGatewaySecretKey, importGatewayKey } from "../src/ohttp.js";
import { padMessage } from "../src/padding.js";

const text = (value: string) => new TextEncoder().encode(value);

/** An ohttp-js client for one of our key configurations (its own parser for key configurations is not exported). */
async function theirClientFor(config: KeyConfig): Promise<Client> {
  const theirs = new PublicKeyConfig(config.keyId, KEM_X25519_HKDF_SHA256 as never, KDF_HKDF_SHA256 as never, AEAD_AES_128_GCM as never, undefined as never);
  theirs.publicKey = await (await theirs.suite.kemContext()).deserializePublicKey(new Uint8Array(config.publicKey).buffer);
  return new Client(theirs);
}

const requestBody = '{"jsonrpc":"2.0","id":7,"method":"getLatestBlockhash","params":[{"commitment":"confirmed"}]}';
const responseBody = '{"jsonrpc":"2.0","id":7,"result":{"context":{"slot":1},"value":{"blockhash":"x","lastValidBlockHeight":2}}}';
const bhttpRequest = encodeRequest({
  method: "POST",
  scheme: "https",
  authority: "rpc.example",
  path: "/",
  headers: [["content-type", "application/json"]],
  content: text(requestBody),
});
const bhttpResponse = encodeResponse({ status: 200, headers: [["content-type", "application/json"]], content: text(responseBody) });

describe("ohttp-js client against this gateway", () => {
  it("round-trips a request and its response", async () => {
    const key = await importGatewayKey(42, generateGatewaySecretKey());
    const client = await theirClientFor(gatewayKeyConfig(key));

    const theirContext = await client.encapsulate(bhttpRequest);
    const decapsulated = await decapsulateRequest((keyId) => (keyId === 42 ? key : undefined), theirContext.request.encode());
    expect(decapsulated.keyId).toBe(42);
    expect(decapsulated.algorithm).toEqual({ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM });
    expect(decapsulated.request).toEqual(bhttpRequest);
    expect(new TextDecoder().decode(decodeRequest(decapsulated.request).content)).toBe(requestBody);

    const sealed = await decapsulated.sealResponse(bhttpResponse);
    const opened = await theirContext.decodeAndDecapsulate(sealed);
    expect(new Uint8Array(opened)).toEqual(bhttpResponse);
  });

  it("their Request-level API reads a padded response written here", async () => {
    const key = await importGatewayKey(1, generateGatewaySecretKey());
    const client = await theirClientFor(gatewayKeyConfig(key));
    const theirContext = await client.encapsulateRequest(
      new Request("https://rpc.example/", { method: "POST", headers: { "content-type": "application/json" }, body: requestBody }),
    );
    const decapsulated = await decapsulateRequest(() => key, theirContext.request.encode());
    const request = decodeRequest(decapsulated.request);
    expect(request).toMatchObject({ method: "POST", scheme: "https", authority: "rpc.example", path: "/" });
    expect(new TextDecoder().decode(request.content)).toBe(requestBody);

    const sealed = await decapsulated.sealResponse(padMessage(bhttpResponse, [4096]));
    const theirResponse = await theirContext.decapsulateResponse(
      new Response(sealed as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": "message/ohttp-res" } }),
    );
    expect(theirResponse.status).toBe(200);
    expect(await theirResponse.text()).toBe(responseBody);
  });
});

describe("this client against an ohttp-js gateway", () => {
  it("round-trips a request and its response", async () => {
    const server = new Server(new TheirKeyConfig(9));
    const [config] = decodeKeyConfigList(await server.encodeKeyConfigAsList());
    expect(config?.keyId).toBe(9);

    const padded = padMessage(bhttpRequest, [4096]);
    await expect(encapsulateRequest(config!, padded)).rejects.toSatisfy((error) => error instanceof OhttpError && error.code === "unsupported_suite");
    const encapsulated = await encapsulateRequest(config!, padded, { allowAes128Gcm: true });
    expect(encapsulated.algorithm).toEqual({ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM });
    const theirContext = await server.decodeAndDecapsulate(encapsulated.message);
    expect(new Uint8Array(theirContext.encodedRequest)).toEqual(padded);
    // Their decoder accepts the padding and sees the same request.
    const theirRequest = theirContext.request();
    expect(theirRequest.method).toBe("POST");
    expect(theirRequest.url).toBe("https://rpc.example/");
    expect(await theirRequest.text()).toBe(requestBody);

    const theirResponse = await theirContext.encapsulate(bhttpResponse);
    const opened = await encapsulated.openResponse(theirResponse.encode());
    expect(opened).toEqual(bhttpResponse);
    expect(new TextDecoder().decode(decodeResponse(opened).content)).toBe(responseBody);
  });

  it("does not open a response that answers another request", async () => {
    const server = new Server(new TheirKeyConfig(9));
    const [config] = decodeKeyConfigList(await server.encodeKeyConfigAsList());
    const first = await encapsulateRequest(config!, bhttpRequest, { allowAes128Gcm: true });
    const second = await encapsulateRequest(config!, bhttpRequest, { allowAes128Gcm: true });
    const answerToFirst = (await (await server.decodeAndDecapsulate(first.message)).encapsulate(bhttpResponse)).encode();
    await expect(second.openResponse(answerToFirst)).rejects.toSatisfy((error) => error instanceof OhttpError && error.code === "decrypt_failed");
    await expect(first.openResponse(answerToFirst)).resolves.toEqual(bhttpResponse);
  });
});
