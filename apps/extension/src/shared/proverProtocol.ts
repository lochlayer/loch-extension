import type { Groth16Proof } from "@loch/sdk";

/** Messages with this target are for the offscreen prover and for nothing else. They carry no secret. */
export const OFFSCREEN_TARGET = "loch-offscreen";

/**
 * The name of the port the offscreen document opens to the service worker. The witness, which
 * holds the spending key, travels over this port and over nothing else: a port has two ends,
 * where `runtime.sendMessage` reaches every open page of the extension.
 */
export const PROVER_PORT = "loch-prover";

export type ProveReply = { ok: true; proof: Groth16Proof; publicSignals: string[]; ms: number } | { ok: false; message: string };

/** The circuits the prover has: the pool's transaction, and the depth proof (shown to people, never to the program). */
export type ProverCircuit = "transaction" | "depth";

/** Service worker to prover, over the port. */
export interface ProveRequest {
  type: "prove";
  id: number;
  circuit: ProverCircuit;
  /** The circuit input, bigints as decimal strings. SECRET: it holds the spending key. */
  input: unknown;
}

/** Prover to service worker, over the port. */
export interface ProveAnswer {
  id: number;
  reply: ProveReply;
}
