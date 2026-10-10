// Interoperability of the X-Wing path with code written independently of it.
//
// The codec under test takes X-Wing from @hpke/hybridkem-x-wing (ML-KEM-768
// from the mlkem package) and the HPKE key schedule from @hpke/core. The other
// side here uses neither: X-Wing comes from @noble/post-quantum, a separate
// implementation of ML-KEM and of the X-Wing combiner, and HPKE (RFC 9180,
// base mode) and the Oblivious HTTP response encryption (RFC 9458, section
// 4.4) are written out below on node:crypto, straight from the two RFCs.
// @noble/post-quantum is a devDependency used only here.
//
// ohttp-js, the independent Oblivious HTTP implementation of interop.test.ts,
// does not speak X-Wing.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { describe, expect, it } from "vitest";

import { bytesToHex, concatBytes } from "../src/bytes.js";
import { AEAD_AES_256_GCM, AEAD_CHACHA20_POLY1305, KDF_HKDF_SHA256, KEM_X_WING } from "../src/keyConfig.js";
import { decapsulateRequest, encapsulateRequest, gatewayKeyConfig, generateGatewaySecretKey, importGatewayKey } from "../src/ohttp.js";

const ascii = (value: string) => new TextEncoder().encode(value);
const u16 = (value: number) => Uint8Array.of(value >> 8, value & 0xff);

const hmac = (key: Uint8Array, data: Uint8Array) => new Uint8Array(createHmac("sha256", key).update(data).digest());
const extract = (salt: Uint8Array, ikm: Uint8Array) => hmac(salt, ikm);
/** HKDF-Expand (RFC 5869) for at most one block of SHA-256. */
const expand = (prk: Uint8Array, info: Uint8Array, length: number) => hmac(prk, concatBytes(info, Uint8Array.of(1))).slice(0, length);

/** The two AEADs, which share their key, nonce and tag sizes. */
type Aead = typeof AEAD_AES_256_GCM | typeof AEAD_CHACHA20_POLY1305;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const TAG = { authTagLength: TAG_BYTES };

function seal(aeadId: Aead, key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const cipher = aeadId === AEAD_AES_256_GCM ? createCipheriv("aes-256-gcm", key, nonce, TAG) : createCipheriv("chacha20-poly1305", key, nonce, TAG);
  return concatBytes(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
}

function open(aeadId: Aead, key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Uint8Array {
  const decipher = aeadId === AEAD_AES_256_GCM ? createDecipheriv("aes-256-gcm", key, nonce, TAG) : createDecipheriv("chacha20-poly1305", key, nonce, TAG);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return concatBytes(decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final());
}

/**
 * The HPKE context of RFC 9180, sections 5.1 and 5.3, base mode, for a KEM
 * shared secret: the AEAD key and nonce of the first message, and the export
 * function.
 */
function hpkeContext(sharedSecret: Uint8Array, info: Uint8Array, aeadId: Aead) {
  const suite = concatBytes(ascii("HPKE"), u16(KEM_X_WING), u16(KDF_HKDF_SHA256), u16(aeadId));
  const labeledExtract = (salt: Uint8Array, label: string, ikm: Uint8Array) => extract(salt, concatBytes(ascii("HPKE-v1"), suite, ascii(label), ikm));
  const labeledExpand = (prk: Uint8Array, label: string, context: Uint8Array, length: number) =>
    expand(prk, concatBytes(u16(length), ascii("HPKE-v1"), suite, ascii(label), context), length);
  const none = new Uint8Array(0);
  const context = concatBytes(Uint8Array.of(0), labeledExtract(none, "psk_id_hash", none), labeledExtract(none, "info_hash", info));
  const secret = labeledExtract(sharedSecret, "secret", none);
  const exporter = labeledExpand(secret, "exp", context, 32);
  return {
    key: labeledExpand(secret, "key", context, KEY_BYTES),
    nonce: labeledExpand(secret, "base_nonce", context, NONCE_BYTES),
    export: (label: string, length: number) => labeledExpand(exporter, "sec", ascii(label), length),
  };
}

/** `info` of an Oblivious HTTP request (RFC 9458, section 4.3). */
const requestInfo = (header: Uint8Array) => concatBytes(ascii("message/bhttp request"), Uint8Array.of(0), header);

/** Key and nonce of an Oblivious HTTP response (RFC 9458, section 4.4). */
function responseKeys(exported: Uint8Array, enc: Uint8Array, responseNonce: Uint8Array) {
  const prk = extract(concatBytes(enc, responseNonce), exported);
  return { key: expand(prk, ascii("key"), KEY_BYTES), nonce: expand(prk, ascii("nonce"), NONCE_BYTES) };
}

const request = ascii('{"jsonrpc":"2.0","id":7,"method":"getLatestBlockhash"}'.padEnd(200, " "));
const response = ascii('{"jsonrpc":"2.0","id":7,"result":{"value":{"blockhash":"x"}}}');
const AEADS: [string, Aead][] = [
  ["ChaCha20Poly1305", AEAD_CHACHA20_POLY1305],
  ["AES-256-GCM", AEAD_AES_256_GCM],
];

describe("X-Wing against @noble/post-quantum", () => {
  it("the two implementations have the same sizes", () => {
    expect(ml_kem768_x25519.lengths).toMatchObject({ seed: 32, publicKey: 1216, secretKey: 32, cipherText: 1120 });
  });

  it("the same 32-byte secret key gives the same public key", async () => {
    for (const secret of [new Uint8Array(32), new Uint8Array(32).fill(0xff), Uint8Array.from({ length: 32 }, (_, i) => i), generateGatewaySecretKey()]) {
      const ours = await importGatewayKey(1, secret, undefined, KEM_X_WING);
      expect(bytesToHex(ours.publicKey)).toBe(bytesToHex(ml_kem768_x25519.keygen(secret).publicKey));
    }
  });

  it("the same randomness gives the same encapsulated key", async () => {
    const secret = generateGatewaySecretKey();
    const key = await importGatewayKey(1, secret, undefined, KEM_X_WING);
    const randomness = new Uint8Array(randomBytes(64));
    const ours = await encapsulateRequest(gatewayKeyConfig(key), request, { unsafeEphemeralSecretKey: randomness });
    const theirs = ml_kem768_x25519.encapsulate(key.publicKey, randomness);
    expect(bytesToHex(ours.message.subarray(7, 7 + 1120))).toBe(bytesToHex(theirs.cipherText));
  });

  it.each(AEADS)("this client against an independent gateway, %s", async (_, aeadId) => {
    // The gateway's key pair is made by the other implementation.
    const theirs = ml_kem768_x25519.keygen();
    const encapsulated = await encapsulateRequest(
      { keyId: 3, kemId: KEM_X_WING, publicKey: theirs.publicKey, symmetric: [{ kdfId: KDF_HKDF_SHA256, aeadId }] },
      request,
    );
    const header = encapsulated.message.subarray(0, 7);
    const enc = encapsulated.message.subarray(7, 7 + 1120);
    expect(bytesToHex(header)).toBe(`03647a0001000${aeadId}`);

    const context = hpkeContext(ml_kem768_x25519.decapsulate(enc, theirs.secretKey), requestInfo(header), aeadId);
    expect(open(aeadId, context.key, context.nonce, encapsulated.message.subarray(7 + 1120))).toEqual(request);

    const responseNonce = new Uint8Array(randomBytes(KEY_BYTES));
    const keys = responseKeys(context.export("message/bhttp response", KEY_BYTES), enc, responseNonce);
    const sealed = concatBytes(responseNonce, seal(aeadId, keys.key, keys.nonce, response));
    expect(await encapsulated.openResponse(sealed)).toEqual(response);
  });

  it.each(AEADS)("an independent client against this gateway, %s", async (_, aeadId) => {
    const key = await importGatewayKey(3, generateGatewaySecretKey(), undefined, KEM_X_WING);
    const header = concatBytes(Uint8Array.of(3), u16(KEM_X_WING), u16(KDF_HKDF_SHA256), u16(aeadId));
    const { cipherText: enc, sharedSecret } = ml_kem768_x25519.encapsulate(key.publicKey);
    const context = hpkeContext(sharedSecret, requestInfo(header), aeadId);
    const message = concatBytes(header, enc, seal(aeadId, context.key, context.nonce, request));

    const decapsulated = await decapsulateRequest((keyId) => (keyId === 3 ? key : undefined), message);
    expect(decapsulated.request).toEqual(request);
    expect(decapsulated.algorithm).toEqual({ kdfId: KDF_HKDF_SHA256, aeadId });

    const sealed = await decapsulated.sealResponse(response);
    const keys = responseKeys(context.export("message/bhttp response", KEY_BYTES), enc, sealed.subarray(0, KEY_BYTES));
    expect(open(aeadId, keys.key, keys.nonce, sealed.subarray(KEY_BYTES))).toEqual(response);
  });
});
