// Runtime validators for everything that crosses the wire. No schema library:
// each validator returns the cleaned value or the WireError to answer with.

import { base58, base64 } from "@scure/base";

import {
  type RelayRequest,
  type RelayResponse,
  type RelayerInfo,
  type ScreenRequest,
  type ScreenResponse,
  type ScreenerInfo,
  type WireCluster,
  WireError,
  type WireErrorBody,
  type WireErrorCode,
  type WireResult,
} from "./types.js";

// Kept as literals so this module needs nothing but @scure/base.
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE_FIELD_MODULUS = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const MAX_ENCRYPTED_OUTPUT = 256;
const MAX_TRANSACTION_BYTES = 1232;
/** A version 1 transaction (SIMD-0385), which starts with this byte, may be 4,096 bytes. */
const MAX_TRANSACTION_V1_BYTES = 4096;
const TRANSACTION_V1_VERSION_BYTE = 129;
const MAX_COMPUTE_UNITS = 1_400_000;
const CLUSTERS: readonly WireCluster[] = ["mainnet-beta", "devnet", "testnet", "localnet"];

/** Thrown inside a validator; carries the path of the offending field. */
class Invalid extends Error {}

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Invalid(`${path} must be an object`);
  return value as Json;
}

function text(value: unknown, path: string, maxLength = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Invalid(`${path} must be a non-empty string`);
  }
  return value;
}

function publicKey(value: unknown, path: string): string {
  const s = text(value, path, 44);
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(s);
  } catch {
    throw new Invalid(`${path} must be a base58 public key`);
  }
  if (bytes.length !== 32) throw new Invalid(`${path} must be a base58 public key (32 bytes)`);
  return s;
}

function hex(value: unknown, bytes: number, path: string): string {
  if (typeof value !== "string" || value.length !== bytes * 2 || !/^[0-9a-f]*$/.test(value)) {
    throw new Invalid(`${path} must be ${bytes} bytes of lowercase hex`);
  }
  return value;
}

function field(value: unknown, path: string): string {
  const s = hex(value, 32, path);
  if (BigInt(`0x${s}`) >= FIELD_MODULUS) throw new Invalid(`${path} must be below the field modulus`);
  return s;
}

/**
 * One part of a proof: `bytes` bytes of hex made of 32-byte coordinates, each
 * below the base field modulus q, and not all zero. The program's verifier
 * refuses anything else (a coordinate of q or more at the alt_bn128 syscall,
 * an all-zero part as `ZeroProofElement`), while an off-chain verifier that
 * reduces mod q would accept `x + q` for `x`: such a request would pass a
 * relayer's proof check and then fail on chain at the relayer's expense.
 */
function proofPart(value: unknown, bytes: number, path: string): string {
  const s = hex(value, bytes, path);
  if (/^0*$/.test(s)) throw new Invalid(`${path} must not be all zero`);
  for (let offset = 0; offset < s.length; offset += 64) {
    if (BigInt(`0x${s.slice(offset, offset + 64)}`) >= BASE_FIELD_MODULUS) {
      throw new Invalid(`${path} has a coordinate that is not below the base field modulus`);
    }
  }
  return s;
}

function blob(value: unknown, path: string, limits: { min?: number; max: number }): string {
  // 4 base64 characters per 3 bytes; reject oversized input before decoding it.
  if (typeof value !== "string" || value.length > Math.ceil(limits.max / 3) * 4) {
    throw new Invalid(`${path} must be base64 of at most ${limits.max} bytes`);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(value);
  } catch {
    throw new Invalid(`${path} must be standard base64 with padding`);
  }
  if (bytes.length > limits.max || bytes.length < (limits.min ?? 0)) {
    throw new Invalid(
      limits.min === limits.max ? `${path} must be exactly ${limits.max} bytes` : `${path} must be at most ${limits.max} bytes`,
    );
  }
  return value;
}

function lamports(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64_MAX) {
    throw new Invalid(`${path} must be a decimal string of lamports (unsigned 64-bit)`);
  }
  return value;
}

function signedLamports(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(0|-?[1-9][0-9]{0,18})$/.test(value)) {
    throw new Invalid(`${path} must be a decimal string (signed 64-bit)`);
  }
  const v = BigInt(value);
  if (v < I64_MIN || v > I64_MAX) throw new Invalid(`${path} must fit in a signed 64-bit integer`);
  return value;
}

function pair<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): [T, T] {
  if (!Array.isArray(value) || value.length !== 2) throw new Invalid(`${path} must be an array of two values`);
  return [item(value[0], `${path}[0]`), item(value[1], `${path}[1]`)];
}

function cluster(value: unknown, path: string): WireCluster {
  if (typeof value !== "string" || !CLUSTERS.includes(value as WireCluster)) {
    throw new Invalid(`${path} must be one of ${CLUSTERS.join(", ")}`);
  }
  return value as WireCluster;
}

function run<T>(code: WireErrorCode, build: () => T): WireResult<T> {
  try {
    return { ok: true, value: build() };
  } catch (error) {
    if (error instanceof WireError) return { ok: false, error };
    if (error instanceof Invalid) return { ok: false, error: new WireError(code, error.message, code === "bad_response" ? null : 400) };
    throw error;
  }
}

/**
 * Validates the body of `POST /v1/relay`. Fails with `invalid_request` for a
 * malformed body and with `deposit_not_relayed` when `extAmount > 0`. Unknown
 * properties are dropped.
 *
 * Every encoding the program itself would refuse is refused here: field
 * values of r or more, equal nullifiers, proof coordinates of q or more, an
 * all-zero proof part, an encrypted output over 256 bytes.
 */
export function validateRelayRequest(body: unknown): WireResult<RelayRequest> {
  return run("invalid_request", () => {
    const o = object(body, "body");
    const proof = object(o.proof, "proof");
    const ext = object(o.extData, "extData");
    const request: RelayRequest = {
      proof: { a: proofPart(proof.a, 64, "proof.a"), b: proofPart(proof.b, 128, "proof.b"), c: proofPart(proof.c, 64, "proof.c") },
      root: field(o.root, "root"),
      inputNullifiers: pair(o.inputNullifiers, "inputNullifiers", field),
      outputCommitments: pair(o.outputCommitments, "outputCommitments", field),
      extData: {
        recipient: publicKey(ext.recipient, "extData.recipient"),
        relayer: publicKey(ext.relayer, "extData.relayer"),
        extAmount: signedLamports(ext.extAmount, "extData.extAmount"),
        fee: lamports(ext.fee, "extData.fee"),
        encryptedOutput0: blob(ext.encryptedOutput0, "extData.encryptedOutput0", { max: MAX_ENCRYPTED_OUTPUT }),
        encryptedOutput1: blob(ext.encryptedOutput1, "extData.encryptedOutput1", { max: MAX_ENCRYPTED_OUTPUT }),
      },
    };
    if (request.inputNullifiers[0] === request.inputNullifiers[1]) throw new Invalid("inputNullifiers must be distinct");
    if (BigInt(request.extData.extAmount) > 0n) {
      throw new WireError("deposit_not_relayed", "deposits are signed by the depositor and are not relayed", 400);
    }
    return request;
  });
}

/** Validates the answer of `POST /v1/relay`. Fails with `bad_response`. */
export function validateRelayResponse(body: unknown): WireResult<RelayResponse> {
  return run("bad_response", () => {
    const o = object(body, "body");
    const signature = text(o.signature, "signature", 88);
    let bytes: Uint8Array;
    try {
      bytes = base58.decode(signature);
    } catch {
      throw new Invalid("signature must be a base58 transaction id");
    }
    if (bytes.length !== 64) throw new Invalid("signature must be a base58 transaction id (64 bytes)");
    return { signature };
  });
}

/** Validates a relayer's `GET /v1/info` answer. Fails with `bad_response`. */
export function validateRelayerInfo(body: unknown): WireResult<RelayerInfo> {
  return run("bad_response", () => {
    const o = object(body, "body");
    const limit = o.computeUnitLimit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > MAX_COMPUTE_UNITS) {
      throw new Invalid(`computeUnitLimit must be an integer from 1 to ${MAX_COMPUTE_UNITS}`);
    }
    const info: RelayerInfo = {
      version: text(o.version, "version", 64),
      cluster: cluster(o.cluster, "cluster"),
      genesisHash: publicKey(o.genesisHash, "genesisHash"),
      programId: publicKey(o.programId, "programId"),
      relayer: publicKey(o.relayer, "relayer"),
      feeLamports: lamports(o.feeLamports, "feeLamports"),
      computeUnitLimit: limit,
    };
    if (o.minWithdrawalLamports !== undefined) info.minWithdrawalLamports = lamports(o.minWithdrawalLamports, "minWithdrawalLamports");
    if (o.lookupTable !== undefined) info.lookupTable = publicKey(o.lookupTable, "lookupTable");
    return info;
  });
}

/** Validates the body of `POST /v1/screen`. Fails with `invalid_request`. */
export function validateScreenRequest(body: unknown): WireResult<ScreenRequest> {
  return run("invalid_request", () => {
    const o = object(body, "body");
    const transaction = blob(o.transaction, "transaction", { min: 1, max: MAX_TRANSACTION_V1_BYTES });
    if (base64.decode(transaction)[0] !== TRANSACTION_V1_VERSION_BYTE) blob(transaction, "transaction", { min: 1, max: MAX_TRANSACTION_BYTES });
    return { transaction };
  });
}

/** Validates the answer of `POST /v1/screen`. Fails with `bad_response`. */
export function validateScreenResponse(body: unknown): WireResult<ScreenResponse> {
  return run("bad_response", () => {
    const o = object(body, "body");
    return {
      signature: blob(o.signature, "signature", { min: 64, max: 64 }),
      screener: publicKey(o.screener, "screener"),
    };
  });
}

/** Validates a screener's `GET /v1/info` answer. Fails with `bad_response`. */
export function validateScreenerInfo(body: unknown): WireResult<ScreenerInfo> {
  return run("bad_response", () => {
    const o = object(body, "body");
    const info: ScreenerInfo = {
      version: text(o.version, "version", 64),
      cluster: cluster(o.cluster, "cluster"),
      programId: publicKey(o.programId, "programId"),
      screener: publicKey(o.screener, "screener"),
      maxDepositLamports: lamports(o.maxDepositLamports, "maxDepositLamports"),
      policy: text(o.policy, "policy", 2048),
    };
    if (o.lookupTable !== undefined) info.lookupTable = publicKey(o.lookupTable, "lookupTable");
    return info;
  });
}

/** Validates an error body `{ error: { code, message } }`. Fails with `bad_response`. */
export function validateErrorBody(body: unknown): WireResult<WireErrorBody> {
  return run("bad_response", () => {
    const error = object(object(body, "body").error, "error");
    return { error: { code: text(error.code, "error.code", 64), message: text(error.message, "error.message", 2048) } };
  });
}
