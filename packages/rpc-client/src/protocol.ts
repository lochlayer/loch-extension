/**
 * @loch/rpc-client/protocol: Oblivious HTTP (RFC 9458) and Binary HTTP (RFC
 * 9292, known-length form) without any transport. The Loch RPC proxy builds
 * its gateway on this; the client in the main entry point uses the same code,
 * so both ends agree by construction and are checked against the RFC's test
 * vector and against independent implementations in the tests.
 *
 * Browser-safe like the rest of the package.
 */

export { decodeRequest, decodeResponse, encodeRequest, encodeResponse } from "./bhttp.js";
export type { BinaryRequest, BinaryResponse, FieldLine } from "./bhttp.js";
export { base64ToBytes, bytesToBase64, bytesToHex, concatBytes, equalBytes, hexToBytes } from "./bytes.js";
export { OhttpError } from "./errors.js";
export type { OhttpErrorCode } from "./errors.js";
export {
  AEAD_AES_128_GCM,
  AEAD_AES_256_GCM,
  AEAD_CHACHA20_POLY1305,
  FINGERPRINT_PREFIX,
  KDF_HKDF_SHA256,
  KEM_X25519_HKDF_SHA256,
  KEM_X_WING,
  MEDIA_TYPE_KEYS,
  MEDIA_TYPE_REQUEST,
  MEDIA_TYPE_RESPONSE,
  PREFERRED_AEADS,
  SUPPORTED_AEADS,
  SUPPORTED_KEMS,
  X25519_KEY_BYTES,
  X_WING_ENCAPSULATED_KEY_BYTES,
  X_WING_PUBLIC_KEY_BYTES,
  decodeKeyConfig,
  decodeKeyConfigList,
  encapsulatedKeyLength,
  encodeKeyConfig,
  encodeKeyConfigList,
  isSelectableAlgorithm,
  isSupportedAlgorithm,
  kemName,
  keyFingerprint,
  publicKeyLength,
} from "./keyConfig.js";
export type { KeyConfig, SymmetricAlgorithm } from "./keyConfig.js";
export {
  REQUEST_OVERHEAD_BYTES,
  decapsulateRequest,
  encapsulateRequest,
  gatewayKeyConfig,
  generateGatewaySecretKey,
  importGatewayKey,
  requestOverheadBytes,
  responseOverheadBytes,
  selectAlgorithm,
} from "./ohttp.js";
export type { DecapsulatedRequest, EncapsulatedRequest, GatewayKey, TestVectorOptions } from "./ohttp.js";
export { DEFAULT_REQUEST_PADDING_BUCKETS, DEFAULT_RESPONSE_PADDING_BUCKETS, normaliseBuckets, padMessage, paddedLength } from "./padding.js";
