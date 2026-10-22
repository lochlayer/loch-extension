// The relayer's v2 HTTP protocol (docs/v2.md section 9, docs/services.md): types,
// validators, conversions and a client. Beside `/v1/*`, never instead of it.
//
//   GET  /v2/info    the relayer's v2 address, its fee per asset, whether it swaps
//   POST /v2/relay   a v2 transfer, withdrawal or swap, with the opening of the fee note
//   POST /v2/quote   what a swap would return now (the relayer asks its router)
//   POST /v2/move    a wallet's move from the earlier pool, signed by the wallet and the
//                    screening authority; the relayer pays for it (move.ts)

import { base58, base64 } from "@scure/base";
import { PublicKey } from "@solana/web3.js";

import { WireClient } from "../wire/client.js";
import { type RelayResponse, type WireCluster, WireError, type WireResult } from "../wire/types.js";
import { validateRelayResponse } from "../wire/validate.js";
import { encodeTransactArgsV2 } from "./codec.js";
import type { MoveTerms } from "./move.js";
import type { PreparedTransactV2 } from "./transact.js";

/** `GET /v2/info`. */
export interface RelayerInfoV2 {
  version: string;
  cluster: WireCluster;
  genesisHash: string;
  programId: string;
  /** The key that signs and pays (base58). */
  relayer: string;
  /** The relayer's v2 address (`loch1...`, 139 characters): fee notes are paid to it. */
  address: string;
  /** Smallest fee per asset, by mint (base58), in base units of the asset. An asset not listed is not taken. */
  fees: Record<string, string>;
  /** Smallest SOL withdrawal, in lamports. */
  minWithdrawalLamports: string;
  /** True when the relayer swaps (`/v2/quote` answers and swap requests are relayed). */
  swaps: boolean;
  /** Compute-unit limit of a transfer or withdrawal (a swap's is higher). */
  computeUnitLimit: number;
  /** Present when the relayer pays for moves from the earlier pool (move.ts). */
  move?: WireMoveTerms;
  /**
   * What a token withdrawal to a wallet costs on top of `fees` when the relayer has to create
   * the wallet's associated token account (its rent), by mint, in base units of the token.
   * Absent for a mint: no surcharge.
   */
  accountFees?: Record<string, string>;
}

/** A relayer's terms for a move, as `GET /v2/info` gives them. */
export interface WireMoveTerms {
  /** Lamports sent to the wallet for the deposit's nullifier records. */
  refundLamports: string;
  /** The smallest move, in lamports. */
  minLamports: string;
  computeUnitLimit: number;
  /** Total priority fee in lamports (the relayer pays it). */
  priorityFeeLamports: string;
}

/** `POST /v2/move`. */
export interface MoveRequestV2 {
  /** base64 of the move transaction, signed by the wallet and the screening authority. */
  transaction: string;
}

/** The opening of the note that pays the relayer. */
export interface WireFeeNote {
  /** Output position 0 to 2. */
  position: number;
  /** The transaction's asset (base58 mint): a transfer does not name it on chain. */
  mint: string;
  /** Base units, decimal. */
  amount: string;
  /** Decimal, below 2^248. */
  blinding: string;
}

/** `POST /v2/relay`. */
export interface RelayRequestV2 {
  /** base64 of borsh(TransactArgsV2) (`encodeTransactArgsV2`). */
  args: string;
  feeNote: WireFeeNote;
  /**
   * A token withdrawal to a wallet's associated token account: the wallet (base58). The relayer
   * checks that the destination is that account and creates it in the same transaction when it
   * is missing (the relayer pays its rent; the fee note then pays `accountFees` on top).
   */
  recipientOwner?: string;
}

/** `POST /v2/quote`. */
export interface QuoteRequestV2 {
  inputMint: string;
  outputMint: string;
  /** Base units of the input asset, decimal. */
  amountIn: string;
}

export interface QuoteResponseV2 {
  /** What the swap would return now, base units of the output asset, decimal. */
  amountOut: string;
}

const MAX_ARGS_BYTES = 3_000;
const U64_MAX = (1n << 64n) - 1n;
const CLUSTERS: readonly WireCluster[] = ["mainnet-beta", "devnet", "testnet", "localnet"];

class Invalid extends Error {}
type Json = Record<string, unknown>;

const object = (value: unknown, path: string): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Invalid(`${path} must be an object`);
  return value as Json;
};
const text = (value: unknown, path: string, max = 512): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Invalid(`${path} must be a non-empty string`);
  return value;
};
const mint = (value: unknown, path: string): string => {
  const s = text(value, path, 44);
  try {
    if (base58.decode(s).length !== 32) throw new Error();
  } catch {
    throw new Invalid(`${path} must be a base58 public key`);
  }
  return s;
};
const decimal = (value: unknown, path: string, limit: bigint): string => {
  const s = text(value, path, 80);
  if (!/^(0|[1-9][0-9]*)$/.test(s) || BigInt(s) > limit) throw new Invalid(`${path} must be a decimal integer in range`);
  return s;
};

function run<T>(code: "invalid_request" | "bad_response", build: () => T): WireResult<T> {
  try {
    return { ok: true, value: build() };
  } catch (error) {
    if (error instanceof WireError) return { ok: false, error };
    if (error instanceof Invalid) return { ok: false, error: new WireError(code, error.message, code === "bad_response" ? null : 400) };
    throw error;
  }
}

/** Validates the body of `POST /v2/relay`. Unknown properties are dropped. */
export function validateRelayRequestV2(body: unknown): WireResult<RelayRequestV2> {
  return run("invalid_request", () => {
    const o = object(body, "body");
    const args = text(o.args, "args", Math.ceil((MAX_ARGS_BYTES * 4) / 3) + 4);
    let bytes: Uint8Array;
    try {
      bytes = base64.decode(args);
    } catch {
      throw new Invalid("args must be base64");
    }
    if (bytes.length > MAX_ARGS_BYTES) throw new Invalid("args is too long");
    const fee = object(o.feeNote, "feeNote");
    const position = fee.position;
    if (position !== 0 && position !== 1 && position !== 2) throw new Invalid("feeNote.position must be 0, 1 or 2");
    return {
      args,
      feeNote: { position, mint: mint(fee.mint, "feeNote.mint"), amount: decimal(fee.amount, "feeNote.amount", U64_MAX), blinding: decimal(fee.blinding, "feeNote.blinding", (1n << 248n) - 1n) },
      ...(o.recipientOwner === undefined ? {} : { recipientOwner: mint(o.recipientOwner, "recipientOwner") }),
    };
  });
}

/** The largest move transaction accepted, in bytes (a version-1 transaction holds 4,096). */
const MAX_MOVE_BYTES = 4_096;

/** Validates the body of `POST /v2/move`. Unknown properties are dropped. */
export function validateMoveRequestV2(body: unknown): WireResult<MoveRequestV2> {
  return run("invalid_request", () => {
    const o = object(body, "body");
    const transaction = text(o.transaction, "transaction", Math.ceil((MAX_MOVE_BYTES * 4) / 3) + 4);
    let bytes: Uint8Array;
    try {
      bytes = base64.decode(transaction);
    } catch {
      throw new Invalid("transaction must be base64");
    }
    if (bytes.length > MAX_MOVE_BYTES) throw new Invalid("transaction is too long");
    return { transaction };
  });
}

/** A relayer's move terms, decoded. */
export function moveTermsOf(terms: WireMoveTerms): MoveTerms {
  return {
    refundLamports: BigInt(terms.refundLamports),
    minLamports: BigInt(terms.minLamports),
    computeUnitLimit: terms.computeUnitLimit,
    priorityFeeLamports: BigInt(terms.priorityFeeLamports),
  };
}

/** Validates the body of `POST /v2/quote`. */
export function validateQuoteRequestV2(body: unknown): WireResult<QuoteRequestV2> {
  return run("invalid_request", () => {
    const o = object(body, "body");
    const amountIn = decimal(o.amountIn, "amountIn", (1n << 63n) - 1n);
    if (amountIn === "0") throw new Invalid("amountIn must be positive");
    const inputMint = mint(o.inputMint, "inputMint");
    const outputMint = mint(o.outputMint, "outputMint");
    if (inputMint === outputMint) throw new Invalid("the two mints must differ");
    return { inputMint, outputMint, amountIn };
  });
}

export function validateQuoteResponseV2(body: unknown): WireResult<QuoteResponseV2> {
  return run("bad_response", () => ({ amountOut: decimal(object(body, "body").amountOut, "amountOut", U64_MAX) }));
}

export function validateRelayerInfoV2(body: unknown): WireResult<RelayerInfoV2> {
  return run("bad_response", () => {
    const o = object(body, "body");
    const cluster = o.cluster;
    if (!CLUSTERS.includes(cluster as WireCluster)) throw new Invalid("cluster is not a known cluster");
    const feesIn = object(o.fees, "fees");
    const fees: Record<string, string> = {};
    for (const [key, value] of Object.entries(feesIn).slice(0, 64)) fees[mint(key, "fees key")] = decimal(value, `fees.${key}`, U64_MAX);
    if (typeof o.swaps !== "boolean") throw new Invalid("swaps must be a boolean");
    const limit = o.computeUnitLimit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > 1_400_000) throw new Invalid("computeUnitLimit is out of range");
    let accountFees: Record<string, string> | undefined;
    if (o.accountFees !== undefined) {
      accountFees = {};
      for (const [key, value] of Object.entries(object(o.accountFees, "accountFees")).slice(0, 64)) accountFees[mint(key, "accountFees key")] = decimal(value, `accountFees.${key}`, U64_MAX);
    }
    let move: WireMoveTerms | undefined;
    if (o.move !== undefined) {
      const m = object(o.move, "move");
      const moveLimit = m.computeUnitLimit;
      if (typeof moveLimit !== "number" || !Number.isInteger(moveLimit) || moveLimit <= 0 || moveLimit > 1_400_000) throw new Invalid("move.computeUnitLimit is out of range");
      move = {
        refundLamports: decimal(m.refundLamports, "move.refundLamports", U64_MAX),
        minLamports: decimal(m.minLamports, "move.minLamports", U64_MAX),
        computeUnitLimit: moveLimit,
        priorityFeeLamports: decimal(m.priorityFeeLamports, "move.priorityFeeLamports", U64_MAX),
      };
    }
    return {
      version: text(o.version, "version", 64),
      cluster: cluster as WireCluster,
      genesisHash: mint(o.genesisHash, "genesisHash"),
      programId: mint(o.programId, "programId"),
      relayer: mint(o.relayer, "relayer"),
      address: text(o.address, "address", 200),
      fees,
      minWithdrawalLamports: decimal(o.minWithdrawalLamports, "minWithdrawalLamports", U64_MAX),
      swaps: o.swaps,
      computeUnitLimit: limit,
      ...(move ? { move } : {}),
      ...(accountFees ? { accountFees } : {}),
    };
  });
}

/**
 * The body of `POST /v2/relay` for a prepared transfer, withdrawal or swap.
 *
 * @throws WireError `invalid_request` when the transaction has no fee note (it pays no relayer).
 */
export function toRelayRequestV2(prepared: Pick<PreparedTransactV2, "args" | "feeNote">): RelayRequestV2 {
  const fee = prepared.feeNote;
  if (!fee) throw new WireError("invalid_request", "the transaction pays no relayer: prepare it with relayer terms");
  return {
    args: base64.encode(encodeTransactArgsV2(prepared.args)),
    feeNote: { position: fee.position, mint: fee.mint.toBase58(), amount: fee.amount.toString(), blinding: fee.blinding.toString() },
  };
}

/** The fee note of a request, decoded. */
export function feeNoteOf(request: RelayRequestV2): { position: 0 | 1 | 2; mint: PublicKey; amount: bigint; blinding: bigint } {
  return {
    position: request.feeNote.position as 0 | 1 | 2,
    mint: new PublicKey(request.feeNote.mint),
    amount: BigInt(request.feeNote.amount),
    blinding: BigInt(request.feeNote.blinding),
  };
}

/**
 * Client of a relayer's v2 routes. Same transport, rules and errors as v1's
 * `RelayerClient`. What `info()` says is the relayer's claim: compare its fee
 * with a maximum of your own (`maxFee`) before proving.
 */
export class RelayerClientV2 extends WireClient {
  info(signal?: AbortSignal): Promise<RelayerInfoV2> {
    return this.call("GET", "/v2/info", undefined, validateRelayerInfoV2, signal, this.timeoutMs);
  }

  /** Resolves with the transaction id once confirmed. On `unknown_root`, sync and prepare again. */
  relay(request: RelayRequestV2, signal?: AbortSignal): Promise<RelayResponse> {
    return this.call("POST", "/v2/relay", request, validateRelayResponse, signal, this.relayTimeoutMs);
  }

  /** Sends a move the wallet and the screening authority signed. Resolves with the transaction id once confirmed. */
  move(request: MoveRequestV2, signal?: AbortSignal): Promise<RelayResponse> {
    return this.call("POST", "/v2/move", request, validateRelayResponse, signal, this.relayTimeoutMs);
  }

  /** What a swap would return now. The answer is the relayer's (its router's) estimate. */
  quote(request: QuoteRequestV2, signal?: AbortSignal): Promise<QuoteResponseV2> {
    return this.call("POST", "/v2/quote", request, validateQuoteResponseV2, signal, this.timeoutMs);
  }
}
