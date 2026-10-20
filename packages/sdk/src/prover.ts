// Groth16 proving and verification through snarkjs.

// Keep this order: the stand-in has to exist while snarkjs loads (service workers).
import { removeCreateObjectUrlStandIn } from "./snarkjsShim.js";
import * as snarkjs from "snarkjs";

import type { Groth16Proof } from "./codec.js";
import { LochError } from "./errors.js";

removeCreateObjectUrlStandIn();

/** The witness input of `circuits/transaction.circom`. Private signals are secrets. */
export interface CircuitInput {
  root: bigint;
  publicAmount: bigint;
  extDataHash: bigint;
  inputNullifier: [bigint, bigint];
  outputCommitment: [bigint, bigint];
  inAmount: [bigint, bigint];
  inPrivateKey: [bigint, bigint];
  inBlinding: [bigint, bigint];
  /** Leaf index of each input; its bits select left/right along the path. */
  inPathIndices: [bigint, bigint];
  /** Sibling path of each input, bottom-up, 20 elements each. */
  inPathElements: [bigint[], bigint[]];
  outAmount: [bigint, bigint];
  outPubkey: [bigint, bigint];
  outBlinding: [bigint, bigint];
}

/** A proof and its public signals in snarkjs form. */
export interface ProofResult {
  proof: Groth16Proof;
  /**
   * Decimal strings in circuit order: root, publicAmount, extDataHash,
   * inputNullifier[0..1], outputCommitment[0..1].
   */
  publicSignals: string[];
}

/**
 * Anything that can prove the transaction circuit. Lets callers move proving
 * to a worker or an offscreen document.
 *
 * A prover is given the witness, which contains the spending key
 * (`inPrivateKey`) and every note secret of the transaction. In keys v1 the
 * spending key also determines the note decryption key, so whoever runs the
 * prover can spend AND read everything the wallet has or will receive. A
 * prover on another machine is a custodian of the wallet; keep proving on the
 * user's own device.
 */
export interface Prover<Input = CircuitInput> {
  prove(input: Input): Promise<ProofResult>;
}

/** A snarkjs verification key (`verification_key.json`, parsed). */
export type VerificationKey = Record<string, unknown>;

/** Options of {@link createSnarkjsProver}. */
export interface SnarkjsProverOptions {
  /**
   * The witness generator (`transaction.wasm`): its bytes, or a string. In a
   * browser a string is fetched as a URL; in Node it is a file path.
   */
  wasm: Uint8Array | string;
  /** The proving key (`transaction_final.zkey`): bytes, URL (browser) or path (Node). */
  zkey: Uint8Array | string;
  /**
   * Prove on the calling thread without spawning workers. Required wherever
   * workers cannot be created from blob URLs, which includes every Manifest V3
   * extension context. Slower. Default false.
   */
  singleThread?: boolean;
}

/**
 * A {@link Prover} backed by snarkjs. The artifacts must be the ones the
 * deployed program's verifying key was generated from, or every proof fails
 * on chain with `InvalidProof`.
 *
 * The SDK logs nothing while proving, and its errors carry the circuit
 * location of a failed constraint, never signal values. One line does reach
 * the console that the SDK cannot prevent: when the inputs do not satisfy the
 * circuit, the circom runtime inside snarkjs prints `ERROR: <code> Error in
 * template <name> line: <n>` with `console.error`. It holds the template name
 * and the line, no signal values. `prepareTransact` checks ownership,
 * membership and balance before proving, so this only happens with the wrong
 * circuit artifacts.
 */
export function createSnarkjsProver<Input = CircuitInput>(options: SnarkjsProverOptions): Prover<Input> {
  const { wasm, zkey, singleThread = false } = options;
  return {
    async prove(input: Input): Promise<ProofResult> {
      try {
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input,
          wasm,
          zkey,
          undefined,
          undefined,
          singleThread ? { singleThread: true } : undefined,
        );
        return { proof: proof as Groth16Proof, publicSignals };
      } catch (cause) {
        // Only the circuit location is copied into the message: it holds no signal values.
        const where = [...String(cause instanceof Error ? cause.message : "").matchAll(/Error in template (\w+?)(?:_\d+)? line: (\d+)/g)]
          .map((m) => `${m[1]} line ${m[2]}`)
          .join(" <- ");
        throw new LochError(
          "PROOF_FAILED",
          where ? `the inputs do not satisfy the circuit (${where})` : "witness generation or proving failed",
          { cause },
        );
      }
    },
  };
}

/**
 * Verifies a proof off chain with snarkjs. Returns false for an invalid proof
 * and for public signals that are not below the field modulus.
 *
 * Meant for tests and for a relayer's pre-check in Node. It uses snarkjs'
 * worker threads; call {@link terminateProver} before the process should exit.
 */
export async function verifyProof(
  verificationKey: VerificationKey,
  proof: Groth16Proof,
  publicSignals: readonly (string | bigint)[],
): Promise<boolean> {
  try {
    return await snarkjs.groth16.verify(verificationKey, publicSignals.map(String), proof);
  } catch {
    return false;
  }
}

/**
 * Stops the worker threads snarkjs keeps alive after a multi-threaded proof
 * or verification. Without it a Node process does not exit. Safe to call when
 * nothing is running; the next proof starts new workers.
 */
export async function terminateProver(): Promise<void> {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128;
  await curve?.terminate();
}
