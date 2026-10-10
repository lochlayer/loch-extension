// Between the SDK's byte-level types and their JSON form on the wire.

import { base64 } from "@scure/base";
import { PublicKey } from "@solana/web3.js";
import type { VersionedTransaction } from "@solana/web3.js";

import { bytesToHex, hexToBytes } from "../bytes.js";
import type { TransactArgs } from "../codec.js";
import { type RelayRequest, type ScreenRequest, WireError } from "./types.js";

/** `TransactArgs` (for example `PreparedTransact.args`) to the body of `POST /v1/relay`. */
export function toRelayRequest(args: TransactArgs): RelayRequest {
  const { extData } = args;
  return {
    proof: { a: bytesToHex(args.proof.a), b: bytesToHex(args.proof.b), c: bytesToHex(args.proof.c) },
    root: bytesToHex(args.root),
    inputNullifiers: [bytesToHex(args.inputNullifiers[0]), bytesToHex(args.inputNullifiers[1])],
    outputCommitments: [bytesToHex(args.outputCommitments[0]), bytesToHex(args.outputCommitments[1])],
    extData: {
      recipient: extData.recipient.toBase58(),
      relayer: extData.relayer.toBase58(),
      extAmount: extData.extAmount.toString(),
      fee: extData.fee.toString(),
      encryptedOutput0: base64.encode(extData.encryptedOutput0),
      encryptedOutput1: base64.encode(extData.encryptedOutput1),
    },
  };
}

/**
 * A validated `RelayRequest` back to `TransactArgs`, for the relayer. Run
 * `validateRelayRequest` first; this throws `invalid_request` only as a
 * safety net.
 */
export function fromRelayRequest(request: RelayRequest): TransactArgs {
  try {
    const { extData } = request;
    return {
      proof: { a: hexToBytes(request.proof.a), b: hexToBytes(request.proof.b), c: hexToBytes(request.proof.c) },
      root: hexToBytes(request.root),
      inputNullifiers: [hexToBytes(request.inputNullifiers[0]), hexToBytes(request.inputNullifiers[1])],
      outputCommitments: [hexToBytes(request.outputCommitments[0]), hexToBytes(request.outputCommitments[1])],
      extData: {
        recipient: new PublicKey(extData.recipient),
        relayer: new PublicKey(extData.relayer),
        extAmount: BigInt(extData.extAmount),
        fee: BigInt(extData.fee),
        encryptedOutput0: base64.decode(extData.encryptedOutput0),
        encryptedOutput1: base64.decode(extData.encryptedOutput1),
      },
    };
  } catch (cause) {
    throw new WireError("invalid_request", "the relay request is malformed", 400, { cause });
  }
}

/** A deposit transaction (signed or not) to the body of `POST /v1/screen`. */
export function toScreenRequest(transaction: VersionedTransaction): ScreenRequest {
  return { transaction: base64.encode(transaction.serialize()) };
}
