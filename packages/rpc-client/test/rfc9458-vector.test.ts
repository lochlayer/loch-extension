// The published test vector of RFC 9458, Appendix A ("Complete Example of a
// Request and Response"): DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM.
// Every hex string below is copied from the RFC. The vector fixes the two
// random inputs (the client's ephemeral key and the gateway's response nonce),
// so both directions can be reproduced byte for byte.
//
// A client of this package no longer chooses AES-128-GCM, so the client side
// of the vector is reproduced with `allowAes128Gcm`, which exists for this.
// The gateway side needs nothing: an X25519 key still accepts AES-128-GCM.

import { describe, expect, it } from "vitest";

import { decodeRequest, decodeResponse, encodeResponse } from "../src/bhttp.js";
import { bytesToHex, hexToBytes } from "../src/bytes.js";
import { AEAD_AES_128_GCM, AEAD_CHACHA20_POLY1305, KDF_HKDF_SHA256, KEM_X25519_HKDF_SHA256, decodeKeyConfig, encodeKeyConfig } from "../src/keyConfig.js";
import { decapsulateRequest, encapsulateRequest, gatewayKeyConfig, importGatewayKey } from "../src/ohttp.js";

const RFC = {
  gatewaySecretKey: "3c168975674b2fa8e465970b79c8dcf09f1c741626480bd4c6162fc5b6a98e1a",
  keyConfig: "01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e" + "79815500080001000100010003",
  request: "00034745540568747470730b6578616d706c652e636f6d012f",
  ephemeralSecretKey: "bc51d5e930bda26589890ac7032f70ad12e4ecb37abb1b65b1256c9c48999c73",
  ephemeralPublicKey: "4b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad19dec96c208b472",
  encapsulatedRequest:
    "010020000100014b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad1" +
    "9dec96c208b4726374e469135906992e1268c594d2a10c695d858c40a026e796" +
    "5e7d86b83dd440b2c0185204b4d63525",
  response: "0140c8",
  responseNonce: "c789e7151fcba46158ca84b04464910d",
  encapsulatedResponse: "c789e7151fcba46158ca84b04464910d86f9013e404feea014e7be4a441f234f" + "857fbd",
};

describe("RFC 9458 Appendix A", () => {
  it("parses the key configuration and writes it back identically", () => {
    const config = decodeKeyConfig(hexToBytes(RFC.keyConfig));
    expect(config.keyId).toBe(1);
    expect(config.kemId).toBe(KEM_X25519_HKDF_SHA256);
    expect(bytesToHex(config.publicKey)).toBe("31e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e798155");
    expect(config.symmetric).toEqual([
      { kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM },
      { kdfId: KDF_HKDF_SHA256, aeadId: AEAD_CHACHA20_POLY1305 },
    ]);
    expect(bytesToHex(encodeKeyConfig(config))).toBe(RFC.keyConfig);
  });

  it("derives the gateway's public key and key configuration from its secret key", async () => {
    const key = await importGatewayKey(1, hexToBytes(RFC.gatewaySecretKey), [AEAD_AES_128_GCM, AEAD_CHACHA20_POLY1305]);
    expect(key.aeads).toEqual([AEAD_AES_128_GCM, AEAD_CHACHA20_POLY1305]);
    // The key accepts both AEADs of the RFC's configuration and advertises the one a client may still select.
    const config = gatewayKeyConfig(key);
    expect(config.symmetric).toEqual([{ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_CHACHA20_POLY1305 }]);
    const asInTheRfc = { ...config, symmetric: key.aeads.map((aeadId) => ({ kdfId: KDF_HKDF_SHA256, aeadId })) };
    expect(bytesToHex(encodeKeyConfig(asInTheRfc))).toBe(RFC.keyConfig);
  });

  it("client: given the RFC's key configuration, chooses its second algorithm, never AES-128-GCM", async () => {
    const config = decodeKeyConfig(hexToBytes(RFC.keyConfig));
    const encapsulated = await encapsulateRequest(config, hexToBytes(RFC.request));
    expect(encapsulated.algorithm).toEqual({ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_CHACHA20_POLY1305 });
    const key = await importGatewayKey(1, hexToBytes(RFC.gatewaySecretKey));
    expect(bytesToHex((await decapsulateRequest(() => key, encapsulated.message)).request)).toBe(RFC.request);
  });

  it("client: produces the RFC's encapsulated request from the RFC's ephemeral key", async () => {
    const config = decodeKeyConfig(hexToBytes(RFC.keyConfig));
    const encapsulated = await encapsulateRequest(config, hexToBytes(RFC.request), {
      unsafeEphemeralSecretKey: hexToBytes(RFC.ephemeralSecretKey),
      allowAes128Gcm: true,
    });
    expect(bytesToHex(encapsulated.message)).toBe(RFC.encapsulatedRequest);
    expect(bytesToHex(encapsulated.message.subarray(7, 39))).toBe(RFC.ephemeralPublicKey);
    expect(encapsulated.algorithm).toEqual({ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM });
  });

  it("gateway: decapsulates the RFC's encapsulated request to the RFC's Binary HTTP request", async () => {
    const key = await importGatewayKey(1, hexToBytes(RFC.gatewaySecretKey));
    const decapsulated = await decapsulateRequest((keyId) => (keyId === 1 ? key : undefined), hexToBytes(RFC.encapsulatedRequest));
    expect(decapsulated.keyId).toBe(1);
    expect(bytesToHex(decapsulated.request)).toBe(RFC.request);
    expect(decodeRequest(decapsulated.request)).toMatchObject({
      method: "GET",
      scheme: "https",
      authority: "example.com",
      path: "/",
      headers: [],
      content: new Uint8Array(0),
    });
  });

  it("gateway: produces the RFC's encapsulated response from the RFC's response nonce", async () => {
    const key = await importGatewayKey(1, hexToBytes(RFC.gatewaySecretKey));
    const decapsulated = await decapsulateRequest(() => key, hexToBytes(RFC.encapsulatedRequest));
    const sealed = await decapsulated.sealResponse(hexToBytes(RFC.response), { unsafeResponseNonce: hexToBytes(RFC.responseNonce) });
    expect(bytesToHex(sealed)).toBe(RFC.encapsulatedResponse);
  });

  it("client: decrypts the RFC's encapsulated response to the RFC's Binary HTTP response", async () => {
    const config = decodeKeyConfig(hexToBytes(RFC.keyConfig));
    const encapsulated = await encapsulateRequest(config, hexToBytes(RFC.request), {
      unsafeEphemeralSecretKey: hexToBytes(RFC.ephemeralSecretKey),
      allowAes128Gcm: true,
    });
    const response = await encapsulated.openResponse(hexToBytes(RFC.encapsulatedResponse));
    expect(bytesToHex(response)).toBe(RFC.response);
    expect(decodeResponse(response)).toMatchObject({ status: 200, headers: [], content: new Uint8Array(0) });
  });

  it("the RFC's messages use truncation; this codec writes the same messages untruncated", () => {
    // 0140c8 is "response, status 200" with the three empty sections left out.
    expect(bytesToHex(encodeResponse({ status: 200, headers: [], content: new Uint8Array(0) }))).toBe("0140c8000000");
    expect(decodeResponse(hexToBytes("0140c8000000"))).toEqual(decodeResponse(hexToBytes(RFC.response)));
  });
});
