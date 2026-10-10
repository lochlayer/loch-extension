// Oblivious HTTP encapsulation (RFC 9458, section 4), both directions.
//
// HPKE (RFC 9180) comes from @hpke/core, with X25519, X-Wing and
// ChaCha20Poly1305 from its companion packages. The response encryption is
// specified by RFC 9458 itself (an exported secret, HKDF and one AEAD call)
// and is implemented here on Web Crypto.
//
// Two KEMs. X-Wing (draft-connolly-cfrg-xwing-kem) is ML-KEM-768 and X25519
// together: a request encrypted to an X-Wing key stays secret unless both are
// broken, so a recording of it is of no use to someone who builds a quantum
// computer later. X25519 alone is what RFC 9458 implementations commonly
// speak and what clients built before X-Wing was added here use.

import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { Aes128Gcm, Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import type { AeadInterface } from "@hpke/core";
import { DhkemX25519HkdfSha256, HkdfSha256 as X25519Hkdf, X25519 } from "@hpke/dhkem-x25519";
import { XWing } from "@hpke/hybridkem-x-wing";

import { type Bytes, asciiToBytes, concatBytes } from "./bytes.js";
import { OhttpError } from "./errors.js";
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
  type SymmetricAlgorithm,
  X25519_KEY_BYTES,
  encapsulatedKeyLength,
  isSelectableAlgorithm,
  isSupportedAlgorithm,
  publicKeyLength,
} from "./keyConfig.js";

const REQUEST_LABEL = asciiToBytes("message/bhttp request");
const RESPONSE_LABEL = asciiToBytes("message/bhttp response");
const KEY_LABEL = asciiToBytes("key");
const NONCE_LABEL = asciiToBytes("nonce");
const EMPTY = new Uint8Array(0);

/** Bytes of the header that starts every encapsulated request: key id, KEM, KDF, AEAD. */
const HEADER_BYTES = 7;
/** Authentication tag length of every supported AEAD. */
const TAG_BYTES = 16;
/** Length of a gateway's secret key, for either KEM: an X25519 secret key, or the seed an X-Wing key pair is expanded from. */
const SECRET_KEY_BYTES = 32;
/** Length of the fixed randomness an X-Wing encapsulation takes in a test vector: 32 bytes for ML-KEM-768, 32 for X25519. */
const X_WING_EPHEMERAL_BYTES = 64;
/**
 * Bytes an encapsulated request is longer than the message inside it with
 * X25519: the smallest overhead of any KEM here. See {@link requestOverheadBytes}.
 */
export const REQUEST_OVERHEAD_BYTES = HEADER_BYTES + X25519_KEY_BYTES + TAG_BYTES;

/**
 * Bytes an encapsulated request is longer than the message inside it, for a
 * KEM: 55 with X25519, 1,143 with X-Wing (its encapsulated key carries an
 * ML-KEM-768 ciphertext of 1,088 bytes).
 */
export function requestOverheadBytes(kemId: number): number {
  const encapsulated = encapsulatedKeyLength(kemId);
  if (encapsulated === undefined) throw new OhttpError("unsupported_suite", "the KEM is not supported");
  return HEADER_BYTES + encapsulated + TAG_BYTES;
}

const x25519Kem = new DhkemX25519HkdfSha256();
const x25519 = new X25519(new X25519Hkdf());
const xWing = new XWing();

function kemFor(kemId: number): DhkemX25519HkdfSha256 | XWing {
  switch (kemId) {
    case KEM_X25519_HKDF_SHA256:
      return x25519Kem;
    case KEM_X_WING:
      return xWing;
    default:
      throw new OhttpError("unsupported_suite", "the KEM is not supported");
  }
}

function newAead(aeadId: number): AeadInterface {
  switch (aeadId) {
    case AEAD_AES_128_GCM:
      return new Aes128Gcm();
    case AEAD_AES_256_GCM:
      return new Aes256Gcm();
    case AEAD_CHACHA20_POLY1305:
      return new Chacha20Poly1305();
    default:
      throw new OhttpError("unsupported_suite", "the AEAD is not supported");
  }
}

/** One suite per KEM and AEAD, keyed by both identifiers. */
const suites = new Map<number, { suite: CipherSuite; aead: AeadInterface }>();

function suiteFor(kemId: number, algorithm: SymmetricAlgorithm): { suite: CipherSuite; aead: AeadInterface } {
  if (!isSupportedAlgorithm(algorithm)) throw new OhttpError("unsupported_suite", "the KDF and AEAD combination is not supported");
  const kem = kemFor(kemId);
  let entry = suites.get(kemId * 0x10000 + algorithm.aeadId);
  if (!entry) {
    const aead = newAead(algorithm.aeadId);
    entry = { suite: new CipherSuite({ kem, kdf: new HkdfSha256(), aead }), aead };
    suites.set(kemId * 0x10000 + algorithm.aeadId, entry);
  }
  return entry;
}

/** Bytes an encapsulated response is longer than the message inside it, for an AEAD. The KEM makes no difference. */
export function responseOverheadBytes(aeadId: number): number {
  const { aead } = suiteFor(KEM_X25519_HKDF_SHA256, { kdfId: KDF_HKDF_SHA256, aeadId });
  return Math.max(aead.keySize, aead.nonceSize) + TAG_BYTES;
}

function header(keyId: number, kemId: number, algorithm: SymmetricAlgorithm): Bytes {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, keyId);
  view.setUint16(1, kemId);
  view.setUint16(3, algorithm.kdfId);
  view.setUint16(5, algorithm.aeadId);
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const imported = await crypto.subtle.importKey("raw", key as Bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data as Bytes));
}

/** HKDF-Expand (RFC 5869) for an output of at most one SHA-256 block, which is all a key or a nonce needs. */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  return (await hmacSha256(prk, concatBytes(info, Uint8Array.of(1)))).slice(0, length);
}

/** Key and nonce of the response AEAD (RFC 9458, section 4.4, steps 3 to 5). */
async function responseKeys(aead: AeadInterface, secret: Uint8Array, enc: Uint8Array, responseNonce: Uint8Array) {
  // HKDF-Extract(salt, ikm) is HMAC(salt, ikm).
  const prk = await hmacSha256(concatBytes(enc, responseNonce), secret);
  return { key: await hkdfExpand(prk, KEY_LABEL, aead.keySize), nonce: await hkdfExpand(prk, NONCE_LABEL, aead.nonceSize) };
}

// --- client side -----------------------------------------------------------

/** An encapsulated request and the means to read the answer to it. */
export interface EncapsulatedRequest {
  /** The encapsulated request (`message/ohttp-req`): header, encapsulated key, ciphertext. */
  message: Uint8Array;
  /** The KDF and AEAD the request was encrypted with. */
  algorithm: SymmetricAlgorithm;
  /**
   * Decrypts the encapsulated response (`message/ohttp-res`) to this request.
   * Rejects with `decrypt_failed` if it was modified or answers another request.
   */
  openResponse(encapsulatedResponse: Uint8Array): Promise<Uint8Array>;
}

/** Options that exist to reproduce published test vectors and to test against other implementations. Never set them otherwise. */
export interface TestVectorOptions {
  /**
   * Fixed ephemeral randomness instead of fresh: an X25519 secret key (32
   * bytes) for an X25519 key configuration, 64 bytes for an X-Wing one.
   * Reusing it breaks the encryption.
   */
  unsafeEphemeralSecretKey?: Uint8Array;
  /**
   * Encrypt with the first algorithm of an X25519 key configuration that this
   * implementation supports, AES-128-GCM included, the way a client chose
   * before {@link selectAlgorithm} stopped offering it. The test vector of RFC
   * 9458 and the independent implementation in the tests speak nothing else.
   */
  allowAes128Gcm?: boolean;
}

/**
 * The algorithm a client uses with a key configuration: the first one listed
 * that is HKDF-SHA256 with ChaCha20Poly1305 or AES-256-GCM. Undefined if there
 * is none, or if the KEM is not X-Wing or X25519. AES-128-GCM is never
 * selected, whatever the list says.
 */
export function selectAlgorithm(config: KeyConfig): SymmetricAlgorithm | undefined {
  if (publicKeyLength(config.kemId) === undefined) return undefined;
  return config.symmetric.find(isSelectableAlgorithm);
}

/**
 * Encapsulates a Binary HTTP request to the gateway's key (RFC 9458, section
 * 4.3). Every call uses a fresh ephemeral key, so two requests cannot be
 * linked by their ciphertext.
 */
export async function encapsulateRequest(config: KeyConfig, request: Uint8Array, testVector: TestVectorOptions = {}): Promise<EncapsulatedRequest> {
  const algorithm =
    testVector.allowAes128Gcm === true && config.kemId === KEM_X25519_HKDF_SHA256 ? config.symmetric.find(isSupportedAlgorithm) : selectAlgorithm(config);
  if (!algorithm) throw new OhttpError("unsupported_suite", "the key configuration offers no supported algorithm");
  if (config.publicKey.length !== publicKeyLength(config.kemId)) throw new OhttpError("malformed", "the public key has the wrong length");
  const kem = kemFor(config.kemId);
  const { suite, aead } = suiteFor(config.kemId, algorithm);
  const hdr = header(config.keyId, config.kemId, algorithm);

  let ekm: CryptoKeyPair | Uint8Array | undefined;
  if (testVector.unsafeEphemeralSecretKey) {
    if (config.kemId === KEM_X_WING) {
      if (testVector.unsafeEphemeralSecretKey.length !== X_WING_EPHEMERAL_BYTES) throw new OhttpError("malformed", "the ephemeral randomness has the wrong length");
      ekm = new Uint8Array(testVector.unsafeEphemeralSecretKey);
    } else {
      const privateKey = await x25519Kem.deserializePrivateKey(testVector.unsafeEphemeralSecretKey);
      ekm = { privateKey, publicKey: await x25519.derivePublicKey(privateKey) };
    }
  }
  let sender;
  let ciphertext: Uint8Array;
  try {
    sender = await suite.createSenderContext({
      recipientPublicKey: await kem.deserializePublicKey(config.publicKey),
      info: concatBytes(REQUEST_LABEL, Uint8Array.of(0), hdr),
      ekm,
    });
    ciphertext = new Uint8Array(await sender.seal(request));
  } catch {
    // Not the library's error: it could describe the key or the message.
    throw new OhttpError("malformed", "the request could not be encrypted to this key");
  }
  const enc = new Uint8Array(sender.enc);
  const context = sender;
  const secretLength = Math.max(aead.keySize, aead.nonceSize);

  return {
    message: concatBytes(hdr, enc, ciphertext),
    algorithm,
    async openResponse(encapsulatedResponse: Uint8Array): Promise<Uint8Array> {
      if (encapsulatedResponse.length < secretLength + TAG_BYTES) {
        throw new OhttpError("decrypt_failed", "the encapsulated response is too short");
      }
      try {
        const secret = new Uint8Array(await context.export(RESPONSE_LABEL, secretLength));
        const { key, nonce } = await responseKeys(aead, secret, enc, encapsulatedResponse.subarray(0, secretLength));
        return new Uint8Array(await aead.createEncryptionContext(key).open(nonce, encapsulatedResponse.subarray(secretLength), EMPTY));
      } catch {
        throw new OhttpError("decrypt_failed", "the encapsulated response does not decrypt");
      }
    },
  };
}

// --- gateway side ------------------------------------------------------------

/** A gateway key pair, ready to decapsulate. */
export interface GatewayKey {
  /** 0 to 255. */
  keyId: number;
  /** HPKE KEM identifier: X-Wing or X25519. */
  kemId: number;
  /** The public key: 32 bytes for X25519, 1216 for X-Wing. */
  publicKey: Uint8Array;
  /**
   * AEADs accepted with this key. The key configuration lists those of them
   * a client may select (see {@link gatewayKeyConfig}).
   */
  aeads: readonly number[];
  /** Opaque handle of the private key. Not extractable through this interface. */
  privateKey: CryptoKey;
}

function checkKeyId(keyId: number): void {
  if (!Number.isInteger(keyId) || keyId < 0 || keyId > 255) throw new OhttpError("malformed", "the key identifier is not a byte");
}

/**
 * Builds a gateway key from a stored 32-byte secret key: an X25519 secret key,
 * or the seed of an X-Wing key pair, as `kemId` says (default X25519).
 *
 * `aeads` are the AEADs the key accepts. By default an X25519 key accepts
 * every AEAD this implementation knows, AES-128-GCM included, because clients
 * built before {@link selectAlgorithm} stopped choosing it still send it. An
 * X-Wing key has no such clients and accepts ChaCha20Poly1305 and AES-256-GCM
 * only; AES-128-GCM is refused for it. Every key must accept at least one of
 * those two, or it would have nothing to advertise.
 */
export async function importGatewayKey(
  keyId: number,
  secretKey: Uint8Array,
  aeads?: readonly number[],
  kemId: number = KEM_X25519_HKDF_SHA256,
): Promise<GatewayKey> {
  checkKeyId(keyId);
  const kem = kemFor(kemId);
  if (secretKey.length !== SECRET_KEY_BYTES) throw new OhttpError("malformed", "the secret key has the wrong length");
  const acceptable = kemId === KEM_X25519_HKDF_SHA256 ? SUPPORTED_AEADS : PREFERRED_AEADS;
  const accepted = aeads ?? acceptable;
  if (accepted.length === 0 || !accepted.every((aeadId) => acceptable.includes(aeadId)) || !accepted.some((aeadId) => PREFERRED_AEADS.includes(aeadId))) {
    throw new OhttpError("unsupported_suite", "the AEAD list is empty, names an AEAD that is not supported with this KEM, or has none a client may select");
  }
  // A copy with a buffer of its own: both libraries read the whole underlying buffer of what they are given.
  const secret = new Uint8Array(secretKey);
  let privateKey: CryptoKey;
  let publicKey: Uint8Array;
  if (kem === xWing) {
    const pair = await xWing.generateKeyPairDerand(secret);
    privateKey = pair.privateKey;
    publicKey = new Uint8Array(await xWing.serializePublicKey(pair.publicKey));
  } else {
    privateKey = await x25519Kem.deserializePrivateKey(secret);
    publicKey = new Uint8Array(await x25519Kem.serializePublicKey(await x25519.derivePublicKey(privateKey)));
  }
  return { keyId, kemId, publicKey, aeads: [...accepted], privateKey };
}

/**
 * Generates a fresh secret key for a gateway, for either KEM: 32 random bytes
 * are an X25519 secret key and an X-Wing seed alike. The caller stores it; it
 * is never logged here.
 */
export function generateGatewaySecretKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SECRET_KEY_BYTES));
}

/**
 * The public key configuration of a gateway key. It lists the AEADs of the
 * key that a client may select: an AEAD the key merely still accepts
 * (AES-128-GCM) is not advertised.
 */
export function gatewayKeyConfig(key: GatewayKey): KeyConfig {
  return {
    keyId: key.keyId,
    kemId: key.kemId,
    publicKey: key.publicKey,
    symmetric: key.aeads.filter((aeadId) => PREFERRED_AEADS.includes(aeadId)).map((aeadId) => ({ kdfId: KDF_HKDF_SHA256, aeadId })),
  };
}

/** A decapsulated request and the means to answer it. */
export interface DecapsulatedRequest {
  /** Identifier of the key the request was encrypted to. */
  keyId: number;
  /** The Binary HTTP request. */
  request: Uint8Array;
  /** The KDF and AEAD the client chose. */
  algorithm: SymmetricAlgorithm;
  /** Encapsulates the Binary HTTP response to this request (RFC 9458, section 4.4). */
  sealResponse(response: Uint8Array, testVector?: { unsafeResponseNonce?: Uint8Array }): Promise<Uint8Array>;
}

/**
 * Decapsulates an encapsulated request (RFC 9458, section 4.3). `findKey`
 * returns the gateway key for a key identifier, or undefined.
 *
 * Rejects with an {@link OhttpError}: `malformed` (too short), `unknown_key`
 * (no such key identifier, or another KEM), `unsupported_suite` (a KDF or AEAD
 * the key does not accept) or `decrypt_failed`.
 */
export async function decapsulateRequest(
  findKey: (keyId: number) => GatewayKey | undefined,
  message: Uint8Array,
): Promise<DecapsulatedRequest> {
  // Shorter than the shortest request of any KEM.
  if (message.length < REQUEST_OVERHEAD_BYTES) throw new OhttpError("malformed", "the encapsulated request is too short");
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const keyId = view.getUint8(0);
  const kemId = view.getUint16(1);
  const algorithm: SymmetricAlgorithm = { kdfId: view.getUint16(3), aeadId: view.getUint16(5) };
  const key = findKey(keyId);
  if (!key || kemId !== key.kemId) throw new OhttpError("unknown_key", "the key identifier is unknown");
  if (algorithm.kdfId !== KDF_HKDF_SHA256 || !key.aeads.includes(algorithm.aeadId)) {
    throw new OhttpError("unsupported_suite", "the KDF and AEAD combination is not accepted with this key");
  }
  if (message.length < requestOverheadBytes(kemId)) throw new OhttpError("malformed", "the encapsulated request is too short");
  const { suite, aead } = suiteFor(kemId, algorithm);
  const encapsulatedBytes = requestOverheadBytes(kemId) - HEADER_BYTES - TAG_BYTES;
  const enc = new Uint8Array(message.subarray(HEADER_BYTES, HEADER_BYTES + encapsulatedBytes));

  let recipient;
  let request: Uint8Array;
  try {
    recipient = await suite.createRecipientContext({
      recipientKey: key.privateKey,
      enc,
      info: concatBytes(REQUEST_LABEL, Uint8Array.of(0), message.subarray(0, HEADER_BYTES)),
    });
    request = new Uint8Array(await recipient.open(message.subarray(HEADER_BYTES + encapsulatedBytes)));
  } catch {
    throw new OhttpError("decrypt_failed", "the encapsulated request does not decrypt");
  }
  const context = recipient;
  const secretLength = Math.max(aead.keySize, aead.nonceSize);

  return {
    keyId,
    request,
    algorithm,
    async sealResponse(response: Uint8Array, testVector = {}): Promise<Uint8Array> {
      const secret = new Uint8Array(await context.export(RESPONSE_LABEL, secretLength));
      const responseNonce = testVector.unsafeResponseNonce ?? crypto.getRandomValues(new Uint8Array(secretLength));
      if (responseNonce.length !== secretLength) throw new OhttpError("malformed", "the response nonce has the wrong length");
      const { key: aeadKey, nonce } = await responseKeys(aead, secret, enc, responseNonce);
      const ciphertext = new Uint8Array(await aead.createEncryptionContext(aeadKey).seal(nonce, response, EMPTY));
      return concatBytes(responseNonce, ciphertext);
    },
  };
}
