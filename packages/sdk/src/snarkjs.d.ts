// Minimal typings for the parts of snarkjs the SDK calls. snarkjs ships none.
declare module "snarkjs" {
  type Artifact = string | Uint8Array;
  interface ProverOptions {
    singleThread?: boolean;
  }
  export const groth16: {
    fullProve(
      input: unknown,
      wasm: Artifact,
      zkey: Artifact,
      logger?: unknown,
      witnessOptions?: unknown,
      proverOptions?: ProverOptions,
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(verificationKey: unknown, publicSignals: readonly string[], proof: unknown, logger?: unknown): Promise<boolean>;
  };
}
