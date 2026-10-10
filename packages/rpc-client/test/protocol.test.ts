import { describe, expect, it } from "vitest";

import { bytesToBase64, bytesToHex, concatBytes, hexToBytes } from "../src/bytes.js";
import { OhttpError, type OhttpErrorCode } from "../src/errors.js";
import {
  AEAD_AES_128_GCM,
  AEAD_AES_256_GCM,
  AEAD_CHACHA20_POLY1305,
  KDF_HKDF_SHA256,
  KEM_X25519_HKDF_SHA256,
  KEM_X_WING,
  type KeyConfig,
  PREFERRED_AEADS,
  SUPPORTED_AEADS,
  SUPPORTED_KEMS,
  decodeKeyConfig,
  decodeKeyConfigList,
  encapsulatedKeyLength,
  encodeKeyConfig,
  encodeKeyConfigList,
  kemName,
  keyFingerprint,
  publicKeyLength,
} from "../src/keyConfig.js";
import {
  REQUEST_OVERHEAD_BYTES,
  decapsulateRequest,
  encapsulateRequest,
  gatewayKeyConfig,
  generateGatewaySecretKey,
  importGatewayKey,
  requestOverheadBytes,
  responseOverheadBytes,
  selectAlgorithm,
} from "../src/ohttp.js";

const text = (value: string) => new TextEncoder().encode(value);

async function rejects(promise: Promise<unknown>, code: OhttpErrorCode): Promise<OhttpError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(OhttpError);
  expect((error as OhttpError).code).toBe(code);
  return error as OhttpError;
}

function throws(run: () => unknown, code: OhttpErrorCode): void {
  expect(run).toThrow(expect.objectContaining({ name: "OhttpError", code }));
}

describe("key configuration encoding", () => {
  const config: KeyConfig = {
    keyId: 255,
    kemId: KEM_X25519_HKDF_SHA256,
    publicKey: new Uint8Array(32).fill(7),
    symmetric: [
      { kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM },
      { kdfId: KDF_HKDF_SHA256, aeadId: AEAD_CHACHA20_POLY1305 },
    ],
  };

  it("round-trips one configuration and a list", () => {
    expect(decodeKeyConfig(encodeKeyConfig(config))).toEqual(config);
    const other = { ...config, keyId: 0, publicKey: new Uint8Array(32).fill(9) };
    const list = encodeKeyConfigList([config, other]);
    // Each entry is prefixed with its length: 3 + 32 + 2 + 8 = 45 = 0x002d.
    expect(bytesToHex(list.subarray(0, 2))).toBe("002d");
    expect(list.length).toBe(2 * 47);
    expect(decodeKeyConfigList(list)).toEqual([config, other]);
  });

  it("rejects a malformed configuration", () => {
    const good = encodeKeyConfig(config);
    throws(() => decodeKeyConfig(good.subarray(0, 2)), "malformed");
    throws(() => decodeKeyConfig(good.subarray(0, 36)), "malformed");
    throws(() => decodeKeyConfig(good.subarray(0, good.length - 1)), "malformed");
    throws(() => decodeKeyConfig(concatBytes(good, Uint8Array.of(0))), "malformed");
    const noAlgorithms = new Uint8Array(good.subarray(0, 37));
    noAlgorithms[35] = 0;
    noAlgorithms[36] = 0;
    throws(() => decodeKeyConfig(noAlgorithms), "malformed");
    throws(() => encodeKeyConfig({ ...config, keyId: 256 }), "malformed");
    throws(() => encodeKeyConfig({ ...config, publicKey: new Uint8Array(31) }), "malformed");
    throws(() => encodeKeyConfig({ ...config, symmetric: [] }), "malformed");
  });

  it("rejects a list with an encoding error as a whole, and skips entries of an unknown KEM", () => {
    const good = encodeKeyConfigList([config]);
    throws(() => decodeKeyConfigList(new Uint8Array(0)), "malformed");
    throws(() => decodeKeyConfigList(good.subarray(0, good.length - 1)), "malformed");
    throws(() => decodeKeyConfigList(concatBytes(good, Uint8Array.of(0))), "malformed");
    throws(() => decodeKeyConfigList(concatBytes(good, Uint8Array.of(0, 0))), "malformed");
    throws(() => decodeKeyConfigList(concatBytes(good, Uint8Array.of(0, 5, 1, 2))), "malformed");
    // A P-256 configuration (KEM 0x0010, 65-byte key): well-formed, not usable here.
    const p256 = concatBytes(Uint8Array.of(3, 0x00, 0x10), new Uint8Array(65), Uint8Array.of(0, 4, 0, 1, 0, 1));
    const mixed = concatBytes(Uint8Array.of(0, p256.length), p256, good);
    expect(decodeKeyConfigList(mixed)).toEqual([config]);
    throws(() => decodeKeyConfig(p256), "unsupported_suite");
  });

  it("selects the first algorithm it supports", () => {
    const exotic = { kdfId: 0x0003, aeadId: AEAD_AES_128_GCM };
    const exportOnly = { kdfId: KDF_HKDF_SHA256, aeadId: 0xffff };
    const chacha = { kdfId: KDF_HKDF_SHA256, aeadId: AEAD_CHACHA20_POLY1305 };
    expect(selectAlgorithm({ ...config, symmetric: [exotic, exportOnly, chacha, config.symmetric[0]!] })).toEqual(chacha);
    expect(selectAlgorithm({ ...config, symmetric: [exotic, exportOnly] })).toBeUndefined();
    expect(selectAlgorithm({ ...config, kemId: 0x0010 })).toBeUndefined();
  });

  it("never selects AES-128-GCM: not when it is listed first, and not when it is all there is", () => {
    const aes128 = { kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM };
    const aes256 = { kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_256_GCM };
    const xWing = { ...config, kemId: KEM_X_WING, publicKey: new Uint8Array(1216).fill(7) };
    for (const entry of [config, xWing]) {
      expect(selectAlgorithm({ ...entry, symmetric: [aes128, aes256] })).toEqual(aes256);
      expect(selectAlgorithm({ ...entry, symmetric: [aes128] })).toBeUndefined();
    }
    expect(PREFERRED_AEADS).toEqual([AEAD_CHACHA20_POLY1305, AEAD_AES_256_GCM]);
    expect([...SUPPORTED_AEADS].sort()).toEqual([AEAD_AES_128_GCM, AEAD_AES_256_GCM, AEAD_CHACHA20_POLY1305]);
  });

  it("knows two KEMs, their key sizes and their names, and prefers X-Wing", () => {
    expect(SUPPORTED_KEMS).toEqual([KEM_X_WING, KEM_X25519_HKDF_SHA256]);
    expect(KEM_X_WING).toBe(0x647a);
    expect([publicKeyLength(KEM_X25519_HKDF_SHA256), encapsulatedKeyLength(KEM_X25519_HKDF_SHA256), kemName(KEM_X25519_HKDF_SHA256)]).toEqual([32, 32, "X25519"]);
    expect([publicKeyLength(KEM_X_WING), encapsulatedKeyLength(KEM_X_WING), kemName(KEM_X_WING)]).toEqual([1216, 1120, "X-Wing"]);
    expect([publicKeyLength(0x0010), encapsulatedKeyLength(0x0010), kemName(0x0010)]).toEqual([undefined, undefined, "unknown"]);
  });

  it("round-trips an X-Wing configuration, alone and in a list with an X25519 one", () => {
    const xWing: KeyConfig = { keyId: 2, kemId: KEM_X_WING, publicKey: new Uint8Array(1216).fill(5), symmetric: [config.symmetric[1]!] };
    expect(decodeKeyConfig(encodeKeyConfig(xWing))).toEqual(xWing);
    const list = encodeKeyConfigList([xWing, config]);
    // 2 + 3 + 1216 + 2 + 4 for X-Wing with one algorithm, 2 + 3 + 32 + 2 + 8 for X25519 with two.
    expect(list.length).toBe(1227 + 47);
    expect(decodeKeyConfigList(list)).toEqual([xWing, config]);
    // The length of the key follows from the KEM: a key of the other KEM's length is malformed.
    throws(() => encodeKeyConfig({ ...xWing, publicKey: new Uint8Array(32) }), "malformed");
    throws(() => encodeKeyConfig({ ...config, publicKey: new Uint8Array(1216) }), "malformed");
    throws(() => decodeKeyConfig(encodeKeyConfig(xWing).subarray(0, 1000)), "malformed");
  });

  it("a fingerprint is sha256 over the KEM identifier and the public key, so it names one key of one KEM", async () => {
    const digest = async (bytes: Uint8Array) => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)));
    expect(keyFingerprint(config)).toBe(`sha256:${await digest(concatBytes(Uint8Array.of(0x00, 0x20), config.publicKey))}`);
    const xWing = { kemId: KEM_X_WING, publicKey: new Uint8Array(1216).fill(5) };
    expect(keyFingerprint(xWing)).toBe(`sha256:${await digest(concatBytes(Uint8Array.of(0x64, 0x7a), xWing.publicKey))}`);
    expect(keyFingerprint(config)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Neither the key identifier nor the algorithm list is part of it.
    expect(keyFingerprint({ ...config, keyId: 1, symmetric: [] } as KeyConfig)).toBe(keyFingerprint(config));
    // The same bytes under another KEM identifier are another key.
    expect(keyFingerprint({ kemId: 0x0010, publicKey: config.publicKey })).not.toBe(keyFingerprint(config));
  });
});

describe("encapsulation", () => {
  const request = text("request ".repeat(40));
  const response = text("response ".repeat(40));

  it.each([
    ["AES-128-GCM", AEAD_AES_128_GCM, 16],
    ["AES-256-GCM", AEAD_AES_256_GCM, 32],
    ["ChaCha20Poly1305", AEAD_CHACHA20_POLY1305, 32],
  ])("round-trips with %s and has the overhead the RFC implies", async (_, aeadId, nonceBytes) => {
    // AES-128-GCM is accepted by an X25519 key and not advertised, so the configuration that names it is written here.
    const legacy = aeadId === AEAD_AES_128_GCM;
    const key = await importGatewayKey(5, generateGatewaySecretKey(), legacy ? undefined : [aeadId]);
    const config = { ...gatewayKeyConfig(key), symmetric: [{ kdfId: KDF_HKDF_SHA256, aeadId }] };
    if (legacy) await rejects(encapsulateRequest(config, request), "unsupported_suite");
    const encapsulated = await encapsulateRequest(config, request, { allowAes128Gcm: legacy });
    expect(encapsulated.algorithm).toEqual({ kdfId: KDF_HKDF_SHA256, aeadId });
    expect(encapsulated.message.length).toBe(request.length + REQUEST_OVERHEAD_BYTES);
    expect(REQUEST_OVERHEAD_BYTES).toBe(55);

    const decapsulated = await decapsulateRequest(() => key, encapsulated.message);
    expect(decapsulated.request).toEqual(request);
    const sealed = await decapsulated.sealResponse(response);
    expect(sealed.length).toBe(response.length + nonceBytes + 16);
    expect(responseOverheadBytes(aeadId)).toBe(nonceBytes + 16);
    expect(await encapsulated.openResponse(sealed)).toEqual(response);
  });

  it("uses a fresh ephemeral key and a fresh response nonce every time", async () => {
    const key = await importGatewayKey(5, generateGatewaySecretKey());
    const config = gatewayKeyConfig(key);
    const first = await encapsulateRequest(config, request);
    const second = await encapsulateRequest(config, request);
    expect(bytesToHex(first.message.subarray(7, 39))).not.toBe(bytesToHex(second.message.subarray(7, 39)));
    expect(bytesToHex(first.message)).not.toBe(bytesToHex(second.message));
    const decapsulated = await decapsulateRequest(() => key, first.message);
    expect(bytesToHex(await decapsulated.sealResponse(response))).not.toBe(bytesToHex(await decapsulated.sealResponse(response)));
  });

  it("the gateway tells an unknown key, an unsupported suite, a malformed and a tampered request apart", async () => {
    const key = await importGatewayKey(5, generateGatewaySecretKey(), [AEAD_AES_256_GCM]);
    const find = (keyId: number) => (keyId === 5 ? key : undefined);
    const good = (await encapsulateRequest(gatewayKeyConfig(key), request)).message;
    const edit = (index: number, value: number) => {
      const copy = new Uint8Array(good);
      copy[index] = value;
      return copy;
    };

    await rejects(decapsulateRequest(find, edit(0, 6)), "unknown_key"); // another key id
    await rejects(decapsulateRequest(find, edit(2, 0x10)), "unknown_key"); // another KEM
    await rejects(decapsulateRequest(find, edit(4, 2)), "unsupported_suite"); // another KDF
    await rejects(decapsulateRequest(find, edit(6, AEAD_CHACHA20_POLY1305)), "unsupported_suite"); // an AEAD this key does not accept
    await rejects(decapsulateRequest(find, edit(6, 0xff)), "unsupported_suite"); // an unknown AEAD
    await rejects(decapsulateRequest(find, good.subarray(0, 54)), "malformed");
    await rejects(decapsulateRequest(find, new Uint8Array(0)), "malformed");
    await rejects(decapsulateRequest(find, edit(10, good[10]! ^ 1)), "decrypt_failed"); // the encapsulated key
    await rejects(decapsulateRequest(find, edit(60, good[60]! ^ 1)), "decrypt_failed"); // the ciphertext
    await rejects(decapsulateRequest(find, edit(good.length - 1, good[good.length - 1]! ^ 1)), "decrypt_failed"); // the tag
    await rejects(decapsulateRequest(find, good.subarray(0, good.length - 1)), "decrypt_failed");

    // The same bytes under another key with the same identifier do not decrypt.
    const other = await importGatewayKey(5, generateGatewaySecretKey(), [AEAD_AES_256_GCM]);
    await rejects(decapsulateRequest(() => other, good), "decrypt_failed");
    expect((await decapsulateRequest(find, good)).request).toEqual(request);
  });

  it("a response opens only for the request it answers, and only unmodified", async () => {
    const key = await importGatewayKey(5, generateGatewaySecretKey());
    const config = gatewayKeyConfig(key);
    const first = await encapsulateRequest(config, request);
    const second = await encapsulateRequest(config, request);
    const sealed = await (await decapsulateRequest(() => key, first.message)).sealResponse(response);
    await rejects(second.openResponse(sealed), "decrypt_failed");
    const flipped = new Uint8Array(sealed);
    flipped[3] = flipped[3]! ^ 1; // in the response nonce
    await rejects(first.openResponse(flipped), "decrypt_failed");
    await rejects(first.openResponse(sealed.subarray(0, 20)), "decrypt_failed");
    expect(await first.openResponse(sealed)).toEqual(response);
  });

  it("checks gateway keys and key configurations before using them", async () => {
    await rejects(importGatewayKey(256, generateGatewaySecretKey()), "malformed");
    await rejects(importGatewayKey(1, new Uint8Array(31)), "malformed");
    await rejects(importGatewayKey(1, generateGatewaySecretKey(), []), "unsupported_suite");
    await rejects(importGatewayKey(1, generateGatewaySecretKey(), [0x7777]), "unsupported_suite");
    // A key that accepts AES-128-GCM only would have nothing to advertise.
    await rejects(importGatewayKey(1, generateGatewaySecretKey(), [AEAD_AES_128_GCM]), "unsupported_suite");
    await rejects(importGatewayKey(1, generateGatewaySecretKey(), undefined, 0x0010), "unsupported_suite");
    const key = await importGatewayKey(1, generateGatewaySecretKey());
    await rejects(encapsulateRequest({ ...gatewayKeyConfig(key), symmetric: [{ kdfId: 2, aeadId: 1 }] }, request), "unsupported_suite");
    await rejects(encapsulateRequest({ ...gatewayKeyConfig(key), publicKey: new Uint8Array(31) }, request), "malformed");
  });

  it("derives the public key from the secret key (RFC 7748 section 6.1 key pair)", async () => {
    const key = await importGatewayKey(1, hexToBytes("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"));
    expect(bytesToHex(key.publicKey)).toBe("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  });

  it("error messages are fixed text", async () => {
    const key = await importGatewayKey(5, generateGatewaySecretKey());
    const secret = text("ADDRESS-Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
    const good = (await encapsulateRequest(gatewayKeyConfig(key), secret)).message;
    const error = await rejects(decapsulateRequest(() => undefined, good), "unknown_key");
    expect(`${error.message}${error.stack}${JSON.stringify(error)}`).not.toContain(bytesToHex(good.subarray(0, 16)));
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("X-Wing", () => {
  const request = text("request ".repeat(40));
  const response = text("response ".repeat(40));
  const xWingKey = (keyId: number, aeads?: number[]) => importGatewayKey(keyId, generateGatewaySecretKey(), aeads, KEM_X_WING);

  it.each([
    ["ChaCha20Poly1305", AEAD_CHACHA20_POLY1305],
    ["AES-256-GCM", AEAD_AES_256_GCM],
  ])("round-trips with %s; the request is 1,088 bytes longer than with X25519", async (_, aeadId) => {
    const key = await xWingKey(9, [aeadId]);
    expect(key.kemId).toBe(KEM_X_WING);
    expect(key.publicKey).toHaveLength(1216);
    const config = gatewayKeyConfig(key);
    expect(config).toEqual({ keyId: 9, kemId: KEM_X_WING, publicKey: key.publicKey, symmetric: [{ kdfId: KDF_HKDF_SHA256, aeadId }] });

    const encapsulated = await encapsulateRequest(config, request);
    expect(encapsulated.algorithm).toEqual({ kdfId: KDF_HKDF_SHA256, aeadId });
    expect(bytesToHex(encapsulated.message.subarray(0, 7))).toBe(`09647a0001000${aeadId}`);
    expect(requestOverheadBytes(KEM_X_WING)).toBe(7 + 1120 + 16);
    expect(requestOverheadBytes(KEM_X25519_HKDF_SHA256)).toBe(REQUEST_OVERHEAD_BYTES);
    expect(requestOverheadBytes(KEM_X_WING) - REQUEST_OVERHEAD_BYTES).toBe(1088);
    expect(encapsulated.message.length).toBe(request.length + requestOverheadBytes(KEM_X_WING));
    expect(() => requestOverheadBytes(0x0010)).toThrow(expect.objectContaining({ code: "unsupported_suite" }));

    const decapsulated = await decapsulateRequest((keyId) => (keyId === 9 ? key : undefined), encapsulated.message);
    expect(decapsulated.keyId).toBe(9);
    expect(decapsulated.request).toEqual(request);
    const sealed = await decapsulated.sealResponse(response);
    expect(sealed.length).toBe(response.length + responseOverheadBytes(aeadId));
    expect(await encapsulated.openResponse(sealed)).toEqual(response);
  });

  it("by default an X-Wing key accepts and advertises the two 256-bit AEADs, and AES-128-GCM cannot be added", async () => {
    const key = await xWingKey(1);
    expect(key.aeads).toEqual(PREFERRED_AEADS);
    expect(gatewayKeyConfig(key).symmetric.map((algorithm) => algorithm.aeadId)).toEqual(PREFERRED_AEADS);
    await rejects(xWingKey(1, [AEAD_AES_128_GCM, AEAD_AES_256_GCM]), "unsupported_suite");
    await rejects(xWingKey(1, [AEAD_AES_128_GCM]), "unsupported_suite");
    await rejects(xWingKey(1, []), "unsupported_suite");
    await rejects(importGatewayKey(1, new Uint8Array(31), undefined, KEM_X_WING), "malformed");
    // A request that names AES-128-GCM is refused before any decryption, and so is the test option that asks for it.
    const good = (await encapsulateRequest(gatewayKeyConfig(key), request)).message;
    const aes128 = new Uint8Array(good);
    aes128[6] = AEAD_AES_128_GCM;
    await rejects(decapsulateRequest(() => key, aes128), "unsupported_suite");
    const listed = { ...gatewayKeyConfig(key), symmetric: [{ kdfId: KDF_HKDF_SHA256, aeadId: AEAD_AES_128_GCM }] };
    await rejects(encapsulateRequest(listed, request, { allowAes128Gcm: true }), "unsupported_suite");
  });

  it("by default an X25519 key still accepts AES-128-GCM from a client that sends it, and no longer advertises it", async () => {
    const key = await importGatewayKey(1, generateGatewaySecretKey());
    expect(key.kemId).toBe(KEM_X25519_HKDF_SHA256);
    expect([...key.aeads].sort()).toEqual([AEAD_AES_128_GCM, AEAD_AES_256_GCM, AEAD_CHACHA20_POLY1305]);
    expect(gatewayKeyConfig(key).symmetric.map((algorithm) => algorithm.aeadId)).toEqual(PREFERRED_AEADS);
    expect((await encapsulateRequest(gatewayKeyConfig(key), request)).algorithm.aeadId).toBe(AEAD_CHACHA20_POLY1305);
    // What a client built before this rule sends: the old key configuration listed AES-128-GCM first.
    const old = { ...gatewayKeyConfig(key), symmetric: [AEAD_AES_128_GCM, AEAD_CHACHA20_POLY1305, AEAD_AES_256_GCM].map((aeadId) => ({ kdfId: KDF_HKDF_SHA256, aeadId })) };
    const fromOldClient = await encapsulateRequest(old, request, { allowAes128Gcm: true });
    expect(fromOldClient.algorithm.aeadId).toBe(AEAD_AES_128_GCM);
    const decapsulated = await decapsulateRequest(() => key, fromOldClient.message);
    expect(decapsulated.request).toEqual(request);
    expect(await fromOldClient.openResponse(await decapsulated.sealResponse(response))).toEqual(response);
  });

  it("the gateway tells keys of the two KEMs apart and does not decrypt a request under the wrong one", async () => {
    const classical = await importGatewayKey(1, generateGatewaySecretKey());
    const hybrid = await xWingKey(2);
    const find = (keyId: number) => [classical, hybrid].find((key) => key.keyId === keyId);
    const toHybrid = (await encapsulateRequest(gatewayKeyConfig(hybrid), request)).message;
    const toClassical = (await encapsulateRequest(gatewayKeyConfig(classical), request)).message;
    expect((await decapsulateRequest(find, toHybrid)).request).toEqual(request);
    expect((await decapsulateRequest(find, toClassical)).request).toEqual(request);

    const edit = (message: Uint8Array, index: number, value: number) => {
      const copy = new Uint8Array(message);
      copy[index] = value;
      return copy;
    };
    // The key identifier of the other key: the KEM in the header no longer matches the key.
    await rejects(decapsulateRequest(find, edit(toHybrid, 0, 1)), "unknown_key");
    await rejects(decapsulateRequest(find, edit(toClassical, 0, 2)), "unknown_key");
    // An X-Wing header in front of a request that is too short to hold an X-Wing encapsulated key.
    const short = concatBytes(toHybrid.subarray(0, 7), toClassical.subarray(7));
    await rejects(decapsulateRequest(find, short), "malformed");
    await rejects(decapsulateRequest(find, toHybrid.subarray(0, requestOverheadBytes(KEM_X_WING) - 1)), "malformed");
    // A flipped bit in either half of the encapsulated key, in the ciphertext or in the tag.
    for (const index of [7 + 100, 7 + 1088 + 5, 7 + 1120 + 3, toHybrid.length - 1]) {
      await rejects(decapsulateRequest(find, edit(toHybrid, index, toHybrid[index]! ^ 1)), "decrypt_failed");
    }
    const other = await xWingKey(2);
    await rejects(decapsulateRequest(() => other, toHybrid), "decrypt_failed");
  });

  it("derives the same key pair from the same secret key, a fresh encapsulation every time, and a fixed one from fixed randomness", async () => {
    const secret = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    const key = await importGatewayKey(7, secret, undefined, KEM_X_WING);
    const again = await importGatewayKey(7, new Uint8Array(secret), undefined, KEM_X_WING);
    expect(bytesToHex(again.publicKey)).toBe(bytesToHex(key.publicKey));
    // A view into a larger buffer (what a base64 decoder may hand out) is read as its 32 bytes only.
    const pooled = new Uint8Array(96);
    pooled.set(secret, 32);
    expect(bytesToHex((await importGatewayKey(7, pooled.subarray(32, 64), undefined, KEM_X_WING)).publicKey)).toBe(bytesToHex(key.publicKey));
    expect(bytesToHex((await importGatewayKey(7, generateGatewaySecretKey(), undefined, KEM_X_WING)).publicKey)).not.toBe(bytesToHex(key.publicKey));

    const config = gatewayKeyConfig(key);
    const first = await encapsulateRequest(config, request);
    const second = await encapsulateRequest(config, request);
    expect(bytesToHex(first.message.subarray(7, 7 + 1120))).not.toBe(bytesToHex(second.message.subarray(7, 7 + 1120)));

    const fixed = new Uint8Array(64).fill(0x5a);
    const one = await encapsulateRequest(config, request, { unsafeEphemeralSecretKey: fixed });
    const two = await encapsulateRequest(config, request, { unsafeEphemeralSecretKey: fixed });
    expect(bytesToHex(one.message)).toBe(bytesToHex(two.message));
    expect((await decapsulateRequest(() => key, one.message)).request).toEqual(request);
    await rejects(encapsulateRequest(config, request, { unsafeEphemeralSecretKey: new Uint8Array(32) }), "malformed");
  });

  it("a list with one key of each KEM is small enough to paste: 1,278 bytes", async () => {
    const list = encodeKeyConfigList([gatewayKeyConfig(await xWingKey(2)), gatewayKeyConfig(await importGatewayKey(1, generateGatewaySecretKey()))]);
    expect(list.length).toBe(1231 + 47);
    expect(bytesToHex(list).length).toBe(2556);
    expect(bytesToBase64(list).length).toBe(1704);
  });
});
