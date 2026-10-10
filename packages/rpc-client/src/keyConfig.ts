// Oblivious HTTP key configurations (RFC 9458, section 3).

import { sha256 } from "@hpke/common";

import { type Bytes, bytesToHex, concatBytes } from "./bytes.js";
import { OhttpError } from "./errors.js";

/** HPKE KEM identifier of DHKEM(X25519, HKDF-SHA256). */
export const KEM_X25519_HKDF_SHA256 = 0x0020;
/**
 * HPKE KEM identifier of X-Wing (draft-connolly-cfrg-xwing-kem): ML-KEM-768
 * and X25519 combined, so that what is encrypted to it stays secret unless
 * both are broken. A recording of X25519 traffic can be decrypted by whoever
 * builds a large quantum computer later; a recording of X-Wing traffic cannot.
 */
export const KEM_X_WING = 0x647a;
/** The KEMs this implementation speaks, in the order a client prefers them: the post-quantum hybrid first. */
export const SUPPORTED_KEMS: readonly number[] = [KEM_X_WING, KEM_X25519_HKDF_SHA256];
/** HPKE KDF identifier of HKDF-SHA256, the one KDF this implementation speaks. */
export const KDF_HKDF_SHA256 = 0x0001;
/** HPKE AEAD identifier of AES-128-GCM. */
export const AEAD_AES_128_GCM = 0x0001;
/** HPKE AEAD identifier of AES-256-GCM. */
export const AEAD_AES_256_GCM = 0x0002;
/** HPKE AEAD identifier of ChaCha20Poly1305. */
export const AEAD_CHACHA20_POLY1305 = 0x0003;

/**
 * The AEADs a client selects from and a gateway advertises, in that order:
 * the two with a 256-bit key. AES-128-GCM is left out so that the symmetric
 * half is not the weaker half next to X-Wing.
 */
export const PREFERRED_AEADS: readonly number[] = [AEAD_CHACHA20_POLY1305, AEAD_AES_256_GCM];

/**
 * The AEADs this implementation can encrypt and decrypt with. AES-128-GCM is
 * here for one reason: a gateway's X25519 key still accepts it, so that
 * clients built before {@link PREFERRED_AEADS} existed keep working.
 */
export const SUPPORTED_AEADS: readonly number[] = [...PREFERRED_AEADS, AEAD_AES_128_GCM];

/** Length of an X25519 public key and of an X25519 encapsulated key. */
export const X25519_KEY_BYTES = 32;
/** Length of an X-Wing public key: an ML-KEM-768 encapsulation key (1184) and an X25519 public key (32). */
export const X_WING_PUBLIC_KEY_BYTES = 1216;
/** Length of an X-Wing encapsulated key: an ML-KEM-768 ciphertext (1088) and an X25519 public key (32). */
export const X_WING_ENCAPSULATED_KEY_BYTES = 1120;

/** A KDF and AEAD pair. */
export interface SymmetricAlgorithm {
  kdfId: number;
  aeadId: number;
}

/** One key configuration: a key identifier, the gateway's public key and the algorithms it accepts. */
export interface KeyConfig {
  /** 0 to 255. Carried in the clear in every encapsulated request. */
  keyId: number;
  /** HPKE KEM identifier. */
  kemId: number;
  /** The gateway's HPKE public key. 32 bytes for X25519, 1216 for X-Wing. */
  publicKey: Uint8Array;
  /** KDF and AEAD pairs the gateway accepts with this key. */
  symmetric: SymmetricAlgorithm[];
}

/** Media type of a list of key configurations. */
export const MEDIA_TYPE_KEYS = "application/ohttp-keys";
/** Media type of an encapsulated request. */
export const MEDIA_TYPE_REQUEST = "message/ohttp-req";
/** Media type of an encapsulated response. */
export const MEDIA_TYPE_RESPONSE = "message/ohttp-res";

const malformed = (what: string) => new OhttpError("malformed", `the key configuration is malformed: ${what}`);

/** Public key length of a KEM, or undefined for a KEM this implementation does not know. */
export function publicKeyLength(kemId: number): number | undefined {
  if (kemId === KEM_X25519_HKDF_SHA256) return X25519_KEY_BYTES;
  if (kemId === KEM_X_WING) return X_WING_PUBLIC_KEY_BYTES;
  return undefined;
}

/** Length of the encapsulated key a KEM puts in front of every request, or undefined for a KEM this implementation does not know. */
export function encapsulatedKeyLength(kemId: number): number | undefined {
  if (kemId === KEM_X25519_HKDF_SHA256) return X25519_KEY_BYTES;
  if (kemId === KEM_X_WING) return X_WING_ENCAPSULATED_KEY_BYTES;
  return undefined;
}

/** A KEM's name for people: "X-Wing", "X25519", or "unknown". */
export function kemName(kemId: number): string {
  if (kemId === KEM_X25519_HKDF_SHA256) return "X25519";
  if (kemId === KEM_X_WING) return "X-Wing";
  return "unknown";
}

/** True when this implementation can encrypt and decrypt with the pair. */
export function isSupportedAlgorithm(algorithm: SymmetricAlgorithm): boolean {
  return algorithm.kdfId === KDF_HKDF_SHA256 && SUPPORTED_AEADS.includes(algorithm.aeadId);
}

/** True when a client may select the pair: HKDF-SHA256 with one of the {@link PREFERRED_AEADS}. */
export function isSelectableAlgorithm(algorithm: SymmetricAlgorithm): boolean {
  return algorithm.kdfId === KDF_HKDF_SHA256 && PREFERRED_AEADS.includes(algorithm.aeadId);
}

/** What every fingerprint starts with. */
export const FINGERPRINT_PREFIX = "sha256:";

/**
 * The fingerprint of a gateway key: `sha256:` and the SHA-256, in lowercase
 * hex, of the KEM identifier (two bytes, big-endian) followed by the public
 * key. Short enough to compare by eye and to pin, whatever the size of the
 * key, and bound to the KEM: the same bytes under another KEM have another
 * fingerprint.
 */
export function keyFingerprint(key: Pick<KeyConfig, "kemId" | "publicKey">): string {
  return FINGERPRINT_PREFIX + bytesToHex(sha256(concatBytes(Uint8Array.of(key.kemId >> 8, key.kemId & 0xff), key.publicKey)));
}

/** Encodes one key configuration (RFC 9458, figure 2). */
export function encodeKeyConfig(config: KeyConfig): Uint8Array {
  if (!Number.isInteger(config.keyId) || config.keyId < 0 || config.keyId > 255) throw malformed("the key identifier is not a byte");
  if (config.publicKey.length !== publicKeyLength(config.kemId)) throw malformed("the public key has the wrong length");
  if (config.symmetric.length === 0 || config.symmetric.length > 16383) throw malformed("the algorithm list is empty or too long");
  const out = new Uint8Array(3 + config.publicKey.length + 2 + config.symmetric.length * 4);
  const view = new DataView(out.buffer);
  view.setUint8(0, config.keyId);
  view.setUint16(1, config.kemId);
  out.set(config.publicKey, 3);
  let offset = 3 + config.publicKey.length;
  view.setUint16(offset, config.symmetric.length * 4);
  offset += 2;
  for (const { kdfId, aeadId } of config.symmetric) {
    view.setUint16(offset, kdfId);
    view.setUint16(offset + 2, aeadId);
    offset += 4;
  }
  return out;
}

/**
 * Decodes one key configuration. A configuration for a KEM this
 * implementation does not know cannot be parsed (the public key length is
 * unknown) and is rejected with `unsupported_suite`.
 */
export function decodeKeyConfig(bytes: Uint8Array): KeyConfig {
  if (bytes.length < 3) throw malformed("it is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keyId = view.getUint8(0);
  const kemId = view.getUint16(1);
  const keyLength = publicKeyLength(kemId);
  if (keyLength === undefined) throw new OhttpError("unsupported_suite", "the key configuration uses a KEM that is not supported");
  if (bytes.length < 3 + keyLength + 2) throw malformed("it is too short");
  const publicKey = new Uint8Array(bytes.subarray(3, 3 + keyLength));
  let offset = 3 + keyLength;
  const algorithmsLength = view.getUint16(offset);
  offset += 2;
  if (algorithmsLength < 4 || algorithmsLength % 4 !== 0 || offset + algorithmsLength !== bytes.length) {
    throw malformed("the algorithm list has the wrong length");
  }
  const symmetric: SymmetricAlgorithm[] = [];
  for (; offset < bytes.length; offset += 4) {
    symmetric.push({ kdfId: view.getUint16(offset), aeadId: view.getUint16(offset + 2) });
  }
  return { keyId, kemId, publicKey, symmetric };
}

/** Encodes key configurations in the `application/ohttp-keys` format: each prefixed with its length as two bytes. */
export function encodeKeyConfigList(configs: readonly KeyConfig[]): Uint8Array {
  const parts: Bytes[] = [];
  for (const config of configs) {
    const encoded = encodeKeyConfig(config);
    parts.push(Uint8Array.of(encoded.length >> 8, encoded.length & 0xff), new Uint8Array(encoded));
  }
  return concatBytes(...parts);
}

/**
 * Decodes an `application/ohttp-keys` list. Configurations for an unknown KEM
 * are skipped (they are well-formed, just not usable here); any encoding
 * error rejects the whole list, as RFC 9458 section 3.2 requires. Throws if
 * the list is empty.
 */
export function decodeKeyConfigList(bytes: Uint8Array): KeyConfig[] {
  const configs: KeyConfig[] = [];
  let offset = 0;
  let entries = 0;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) throw malformed("the list ends inside a length");
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    offset += 2;
    if (length === 0 || offset + length > bytes.length) throw malformed("an entry is longer than the list");
    try {
      configs.push(decodeKeyConfig(bytes.subarray(offset, offset + length)));
    } catch (error) {
      if (!(error instanceof OhttpError) || error.code !== "unsupported_suite") throw error;
    }
    offset += length;
    entries++;
  }
  if (entries === 0) throw malformed("the list is empty");
  return configs;
}
