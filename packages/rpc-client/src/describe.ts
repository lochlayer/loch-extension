// A readable view of a key configuration list, for settings screens and for
// checking a pin by eye.

import { bytesToHex, equalBytes, toBytes } from "./bytes.js";
import { RpcClientError } from "./errors.js";
import { type KeyConfig, decodeKeyConfigList, kemName, keyFingerprint } from "./keyConfig.js";
import { selectAlgorithm } from "./ohttp.js";
import { chosenKeyConfig } from "./ohttpFetch.js";

/** One entry of an `application/ohttp-keys` list. */
export interface KeyConfigDescription {
  /** Key identifier, 0 to 255. */
  keyId: number;
  /** HPKE KEM identifier: 0x647a for X-Wing, 0x0020 for X25519. */
  kemId: number;
  /** The KEM's name: "X-Wing" (ML-KEM-768 with X25519, the post-quantum hybrid) or "X25519". */
  kem: string;
  /** The gateway's public key, lowercase hex: 64 digits for X25519, 2432 for X-Wing. */
  publicKey: string;
  /**
   * The key's fingerprint: `sha256:` and 64 hex digits. This is the value to
   * pin and to compare by eye, for either KEM.
   */
  fingerprint: string;
  /** HPKE AEAD identifiers the gateway accepts with this key. */
  aeadIds: number[];
  /** Whether this client can encrypt to it. */
  usable: boolean;
  /**
   * Whether this is the entry `createOhttpFetch` encrypts to, given the same
   * pins. At most one entry is; none is if the pins match nothing usable.
   */
  chosen: boolean;
}

/**
 * Parses the content of `GET /ohttp-keys` (bytes, hex or base64) and lists
 * what is in it, in the order of the list. A client uses the first usable
 * X-Wing entry if there is one, whatever its position (and, with pins, only
 * a pinned one); `chosen` marks it, for the `pinnedPublicKeys` given here.
 * Throws an {@link RpcClientError}: `key_config_invalid` if the list is
 * malformed, `invalid_argument` if the pins are.
 */
export function describeKeyConfigs(keyConfig: Uint8Array | string, pinnedPublicKeys?: readonly (Uint8Array | string)[]): KeyConfigDescription[] {
  let list: Uint8Array;
  let configs: KeyConfig[];
  try {
    list = toBytes(keyConfig);
    configs = decodeKeyConfigList(list);
  } catch {
    throw new RpcClientError("key_config_invalid", "the key configuration is malformed");
  }
  let chosen: KeyConfig | undefined;
  try {
    chosen = chosenKeyConfig(list, pinnedPublicKeys);
  } catch (error) {
    // Malformed pins are the caller's mistake. A list with nothing usable or nothing pinned is a fact to describe.
    if (error instanceof RpcClientError && error.code === "invalid_argument") throw error;
    chosen = undefined;
  }
  const isChosen = (config: KeyConfig) => chosen !== undefined && config.keyId === chosen.keyId && config.kemId === chosen.kemId && equalBytes(config.publicKey, chosen.publicKey);
  let marked = false;
  return configs.map((config) => {
    // The first match only: a list may, wrongly, carry the same key twice.
    const mark = !marked && isChosen(config);
    marked ||= mark;
    return {
      keyId: config.keyId,
      kemId: config.kemId,
      kem: kemName(config.kemId),
      publicKey: bytesToHex(config.publicKey),
      fingerprint: keyFingerprint(config),
      aeadIds: config.symmetric.map((algorithm) => algorithm.aeadId),
      usable: selectAlgorithm(config) !== undefined,
      chosen: mark,
    };
  });
}
