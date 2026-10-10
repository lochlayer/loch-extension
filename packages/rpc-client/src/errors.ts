// Typed errors. Every message is a fixed sentence chosen by this library: no
// error carries a request, a response, a URL, a key, or the error of an
// underlying library (there is deliberately no `cause`), so an error can be
// logged or reported without revealing what was asked. The only variable
// parts are an HTTP status code and a machine-readable code.

/** Stable machine-readable codes of {@link RpcClientError}. */
export type RpcClientErrorCode =
  /** An option or an argument is malformed. Nothing was sent. */
  | "invalid_argument"
  /** The request cannot be carried: a streaming body, or a target that is not an http(s) URL. Nothing was sent. */
  | "unsupported_request"
  /** The request is larger than `maxRequestBytes`. Nothing was sent. */
  | "request_too_large"
  /** The key configuration could not be fetched. */
  | "key_config_unavailable"
  /** The key configuration is malformed, or offers no algorithm this client supports. */
  | "key_config_invalid"
  /** No key in the configuration matches a pinned public key. Nothing was sent. */
  | "key_config_pin_mismatch"
  /** The gateway does not accept the key the request was encrypted to, also after one refresh. */
  | "key_rejected"
  /** The relay could not be reached. */
  | "network_error"
  /** No answer within `timeoutMs`. */
  | "timeout"
  /** The relay or the gateway answered with something that is not an encapsulated response. */
  | "relay_error"
  /** The answer is larger than `maxResponseBytes`. */
  | "response_too_large"
  /** The encapsulated response does not decrypt: it was modified, or it answers another request. */
  | "decapsulation_failed"
  /** The decrypted response is not a valid Binary HTTP message. */
  | "bad_response";

/**
 * The one error class this package throws on purpose. `message` is a fixed
 * sentence; `status` is the HTTP status of the relay's answer when there was
 * one. Safe to log.
 *
 * Two exceptions. An aborted request rejects with the reason of the caller's
 * own `AbortSignal`, exactly as `fetch` does. And `confirmTransaction` of a
 * connection from `@loch/rpc-client/web3` rejects with web3.js's own expiry
 * errors, which name the transaction signature, as web3.js callers expect.
 */
export class RpcClientError extends Error {
  /** Stable machine-readable code. */
  readonly code: RpcClientErrorCode;
  /** HTTP status of the unencapsulated answer, or null if there was none. */
  readonly status: number | null;

  constructor(code: RpcClientErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
    this.status = status;
  }
}

/** Why a protocol message was rejected. */
export type OhttpErrorCode =
  /** The bytes are not a well-formed key configuration, encapsulated message or Binary HTTP message. */
  | "malformed"
  /** No key with this key identifier (or the key is of another KEM). */
  | "unknown_key"
  /** A KEM, KDF or AEAD this implementation does not support. */
  | "unsupported_suite"
  /** The ciphertext does not authenticate. */
  | "decrypt_failed"
  /** The message is larger than the caller's limit. */
  | "too_large";

/** An error of the protocol layer (`@loch/rpc-client/protocol`). Fixed messages, no message contents. */
export class OhttpError extends Error {
  readonly code: OhttpErrorCode;

  constructor(code: OhttpErrorCode, message: string) {
    super(message);
    this.name = "OhttpError";
    this.code = code;
  }
}
