// JSON shapes of the relayer and screener HTTP APIs (wire protocol v1).
//
// Encoding rules, everywhere:
//   public keys and transaction ids   base58
//   32-byte field values, proof parts lowercase hex, no prefix
//   byte blobs                        standard base64 with padding
//   lamport amounts                   decimal strings (no sign, no leading zeros;
//                                     extAmount may carry a leading "-")

/** The wire protocol version these types describe; it is the `/v1` in every path. */
export const WIRE_VERSION = 1;

/** Stable error codes a service puts in `{ error: { code, message } }`. */
export const WIRE_ERROR_CODES = [
  // ---- both services ----
  /** The body is not JSON, does not match the request shape, or holds an encoding or a destination the program refuses. */
  "invalid_request",
  /** Unknown path. */
  "not_found",
  /** Too many requests; retry later. */
  "rate_limited",
  /** Temporarily unable to serve (RPC down, relayer out of funds, screener offline); retry later. */
  "unavailable",
  /** A bug or an unexpected failure in the service. */
  "internal",
  // ---- relayer ----
  /** `extAmount > 0`: deposits are signed by the depositor, never relayed. */
  "deposit_not_relayed",
  /** `extData.relayer` is not this relayer, or a transfer's `extData.recipient` is not the relayer. */
  "wrong_relayer",
  /** `extData.fee` is below the relayer's `feeLamports`. */
  "fee_too_low",
  /** The withdrawal is below `minWithdrawalLamports`, or would leave the recipient below rent exemption. */
  "withdrawal_too_small",
  /** The proof does not verify for these arguments. */
  "invalid_proof",
  /** The root is not in the program's recent history: sync, prove again, resubmit. */
  "unknown_root",
  /** An input nullifier is already spent. */
  "nullifier_spent",
  /** The pool's tree is full. */
  "tree_full",
  /** The program rejected the transaction for another reason; `message` names it. */
  "transaction_failed",
  /** Sent but not confirmed in time. It may still land: sync and see whether the spent notes are spent before retrying. */
  "not_confirmed",
  // ---- screener ----
  /** The transaction is not exactly one canonical loch_pool deposit. */
  "invalid_transaction",
  /** The screening policy refuses this deposit. */
  "denied",
  /** The pool's deposits are paused. */
  "deposits_paused",
  /** The deposit exceeds `maxDepositLamports`. */
  "too_large",
  // ---- produced by the clients, never sent by a service ----
  /** The request never got an HTTP response, or none within the client's timeout. `WireError.reason` says which. */
  "network_error",
  /** The service answered with something that is not valid for this protocol. */
  "bad_response",
] as const;

/** A wire error code. */
export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

/** HTTP status a service should send with each of its error codes. */
export const WIRE_ERROR_STATUS: Readonly<Record<Exclude<WireErrorCode, "network_error" | "bad_response">, number>> = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
  deposit_not_relayed: 400,
  wrong_relayer: 400,
  fee_too_low: 400,
  withdrawal_too_small: 400,
  invalid_proof: 400,
  unknown_root: 409,
  nullifier_spent: 409,
  tree_full: 409,
  transaction_failed: 422,
  not_confirmed: 504,
  invalid_transaction: 400,
  denied: 403,
  deposits_paused: 409,
  too_large: 400,
});

/** Body of every non-2xx response. */
export interface WireErrorBody {
  error: {
    /** A {@link WireErrorCode}. Clients must tolerate codes they do not know. */
    code: string;
    /** Human-readable, English, safe to show. Never contains secrets. */
    message: string;
  };
}

/**
 * Why a client's request got no HTTP response (`WireError.reason` of a
 * `network_error`):
 *
 * - `timeout`: no complete answer within the client's timeout, or the
 *   transport itself gave up waiting.
 * - `unreachable`: the transport could not get a response at all: the
 *   connection was refused, the name did not resolve, TLS failed, or (in a
 *   browser, which does not say which) the request was blocked or the
 *   connection was lost.
 * - `aborted`: the transport abandoned the request for a reason that is
 *   neither the caller's own abort signal nor this client's timeout.
 * - `other`: anything else, including a connection that broke while the
 *   answer was being read.
 *
 * It is a description of what the transport reported and no more. None of
 * the four proves that the service did not receive the request: after a
 * `network_error` on `POST /v1/relay` the transaction may still land,
 * whatever the reason.
 */
export type WireNetworkErrorReason = "timeout" | "unreachable" | "aborted" | "other";

/** An error of the wire protocol: thrown by the clients, returned by the validators. */
export class WireError extends Error {
  /** A {@link WireErrorCode}, or a code this SDK version does not know yet. */
  readonly code: WireErrorCode | (string & {});
  /** HTTP status of the response, or null if there was none. */
  readonly status: number | null;
  /**
   * Set on the `network_error` a client throws, and on nothing else: what
   * kind of failure it was. One of four fixed words; it never holds anything
   * of the request or of the transport's own error text.
   */
  declare readonly reason?: WireNetworkErrorReason;

  constructor(
    code: WireErrorCode | (string & {}),
    message: string,
    status: number | null = null,
    options?: { cause?: unknown; reason?: WireNetworkErrorReason },
  ) {
    super(message, options);
    this.name = "WireError";
    this.code = code;
    this.status = status;
    if (options?.reason !== undefined) this.reason = options.reason;
  }

  /** The `{ error: { code, message } }` body a service sends for this error. */
  toBody(): WireErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

/** Result of a validator: the checked value, or the error to answer with. */
export type WireResult<T> = { ok: true; value: T } | { ok: false; error: WireError };

/** Solana cluster names used in `info` responses. */
export type WireCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

/** `Proof` on the wire: lowercase hex. */
export interface WireProof {
  /** 64 bytes, 128 hex characters. Already negated. Each 32-byte coordinate is below q; not all zero. */
  a: string;
  /** 128 bytes, 256 hex characters. Each 32-byte coordinate is below q; not all zero. */
  b: string;
  /** 64 bytes, 128 hex characters. Each 32-byte coordinate is below q; not all zero. */
  c: string;
}

/** `ExtData` on the wire. */
export interface WireExtData {
  /** base58. */
  recipient: string;
  /** base58. Must be the relayer's public key. */
  relayer: string;
  /** Decimal i64: "0" for a transfer, negative for a withdrawal. */
  extAmount: string;
  /** Decimal u64. */
  fee: string;
  /** base64, at most 256 bytes decoded. */
  encryptedOutput0: string;
  /** base64, at most 256 bytes decoded. */
  encryptedOutput1: string;
}

/** `GET /v1/info` of a relayer. */
export interface RelayerInfo {
  /** Version of the relayer software. */
  version: string;
  cluster: WireCluster;
  /** Genesis hash of the cluster (base58), so a client can tell clusters apart for certain. */
  genesisHash: string;
  /** The loch_pool program the relayer serves (base58). */
  programId: string;
  /** The relayer's public key (base58): use it as `extData.relayer`, and as `extData.recipient` for transfers. */
  relayer: string;
  /**
   * Smallest `extData.fee` the relayer accepts, in lamports. This is what the
   * relayer asks for, and any u64 is a valid answer: a client compares it with
   * its own maximum (`SpendContext.maxFee`) before it proves anything.
   */
  feeLamports: string;
  /** Smallest withdrawal amount the relayer accepts, if it has such a limit. */
  minWithdrawalLamports?: string;
  /** Address lookup table the relayer compiles transactions with (base58), if any. */
  lookupTable?: string;
  /** Compute-unit limit the relayer sets on transactions. */
  computeUnitLimit: number;
}

/** Body of `POST /v1/relay`: `TransactArgs` in wire encoding. */
export interface RelayRequest {
  proof: WireProof;
  /** 32 bytes hex. */
  root: string;
  /** Two 32-byte hex values. */
  inputNullifiers: [string, string];
  /** Two 32-byte hex values. */
  outputCommitments: [string, string];
  extData: WireExtData;
}

/** Answer of `POST /v1/relay` once the transaction is confirmed. */
export interface RelayResponse {
  /** The transaction id (base58), as every Solana RPC method takes it. */
  signature: string;
}

/** `GET /v1/info` of a screening service. */
export interface ScreenerInfo {
  /** Version of the screener software. */
  version: string;
  cluster: WireCluster;
  /** The loch_pool program the screener signs for (base58). */
  programId: string;
  /** The screening authority's public key (base58). Must equal `PoolConfig.screener`. */
  screener: string;
  /** Largest deposit the screener signs, in lamports. */
  maxDepositLamports: string;
  /** What is screened, in a sentence or an https URL, to show to the user. */
  policy: string;
  /**
   * The pool's address lookup table (base58), if the service signs deposits
   * that load accounts from it. A client compiles its deposit with it then, and
   * not otherwise.
   */
  lookupTable?: string;
}
// A screening service may send more than these fields (the one in this
// repository adds `policyVersion`, docs/protocol.md section 14.2). The
// validator accepts such an answer and returns these.

/** Body of `POST /v1/screen`. */
export interface ScreenRequest {
  /**
   * base64 of a serialised v0 `VersionedTransaction` whose fee payer is the
   * depositor. Signatures may be all zero, or hold the wallet's. Exactly that transaction: nothing
   * may follow it.
   */
  transaction: string;
}

/** Answer of `POST /v1/screen`. */
export interface ScreenResponse {
  /** base64 of the screening authority's 64-byte Ed25519 signature over the transaction message. */
  signature: string;
  /** The key that signed (base58). */
  screener: string;
}
