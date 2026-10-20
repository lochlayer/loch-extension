/**
 * @loch/sdk/node: the only part of the SDK that touches the filesystem. Loads
 * the devnet prover artifacts from `circuits/artifacts/devnet` and checks them
 * against the manifest that ships next to them.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DepthCircuitInput } from "./depth.js";
import { LochError } from "./errors.js";
import { type Prover, type VerificationKey, createSnarkjsProver } from "./prover.js";

/** `circuits/artifacts/devnet` in this repository, resolved from the package's own location. */
export const DEVNET_ARTIFACTS_DIR: string = fileURLToPath(new URL("../../../circuits/artifacts/devnet", import.meta.url));

/** Paths of the prover artifacts inside an artifacts directory. */
export interface ArtifactPaths {
  wasm: string;
  zkey: string;
  verificationKey: string;
  manifest: string;
}

/** The prover artifacts in memory. */
export interface ProverArtifacts {
  /** Witness generator (`transaction.wasm`). */
  wasm: Uint8Array;
  /** Proving key (`transaction_final.zkey`). */
  zkey: Uint8Array;
  /** `verification_key.json`, parsed. */
  verificationKey: VerificationKey;
  /** sha256 of the zkey (hex): identifies the setup the on-chain verifying key must come from. */
  zkeySha256: string;
}

/** Where the artifacts live under `dir` (default {@link DEVNET_ARTIFACTS_DIR}). */
export function artifactPaths(dir: string = DEVNET_ARTIFACTS_DIR): ArtifactPaths {
  return {
    wasm: join(dir, "transaction.wasm"),
    zkey: join(dir, "transaction_final.zkey"),
    verificationKey: join(dir, "verification_key.json"),
    manifest: join(dir, "manifest.json"),
  };
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Reads wasm, zkey and verification key from disk and checks their sha256
 * against `manifest.json`. A prover whose zkey does not belong to the deployed
 * program produces proofs that fail with `InvalidProof` and no better hint, so
 * a mismatch is an error here.
 *
 * @throws LochError `INVALID_ARGUMENT` if a file is missing or does not match the manifest.
 */
export async function loadProverArtifacts(dir: string = DEVNET_ARTIFACTS_DIR): Promise<ProverArtifacts> {
  const paths = artifactPaths(dir);
  let wasm: Uint8Array;
  let zkey: Uint8Array;
  let verificationKeyBytes: Uint8Array;
  let manifest: { files?: Record<string, { sha256?: string }> };
  try {
    [wasm, zkey, verificationKeyBytes] = await Promise.all(
      [paths.wasm, paths.zkey, paths.verificationKey].map(async (path) => new Uint8Array(await readFile(path))),
    ) as [Uint8Array, Uint8Array, Uint8Array];
    manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  } catch (cause) {
    throw new LochError("INVALID_ARGUMENT", `prover artifacts could not be read from ${dir}`, { cause });
  }
  const zkeySha256 = sha256Hex(zkey);
  const checks: [string, string][] = [
    ["transaction.wasm", sha256Hex(wasm)],
    ["transaction_final.zkey", zkeySha256],
    ["verification_key.json", sha256Hex(verificationKeyBytes)],
  ];
  for (const [name, actual] of checks) {
    if (manifest.files?.[name]?.sha256 !== actual) {
      throw new LochError("INVALID_ARGUMENT", `${name} does not match manifest.json in ${dir}`);
    }
  }
  const verificationKey = JSON.parse(new TextDecoder().decode(verificationKeyBytes)) as VerificationKey;
  return { wasm, zkey, verificationKey, zkeySha256 };
}

/** Reads and parses `verification_key.json` for `verifyProof`. */
export async function loadVerificationKey(dir: string = DEVNET_ARTIFACTS_DIR): Promise<VerificationKey> {
  return JSON.parse(await readFile(artifactPaths(dir).verificationKey, "utf8")) as VerificationKey;
}

/**
 * A prover for depth proofs (`circuits/artifacts/devnet/depth`), its two files
 * checked against the manifest next to them.
 */
export async function createNodeDepthProver(options: { dir?: string; singleThread?: boolean } = {}): Promise<Prover<DepthCircuitInput>> {
  const dir = options.dir ?? join(DEVNET_ARTIFACTS_DIR, "depth");
  let wasm: Uint8Array;
  let zkey: Uint8Array;
  let manifest: { files?: Record<string, { sha256?: string }> };
  try {
    [wasm, zkey] = (await Promise.all(["depth.wasm", "depth_final.zkey"].map(async (name) => new Uint8Array(await readFile(join(dir, name)))))) as [Uint8Array, Uint8Array];
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  } catch (cause) {
    throw new LochError("INVALID_ARGUMENT", `depth prover artifacts could not be read from ${dir}`, { cause });
  }
  for (const [name, bytes] of [["depth.wasm", wasm], ["depth_final.zkey", zkey]] as const) {
    if (manifest.files?.[name]?.sha256 !== sha256Hex(bytes)) throw new LochError("INVALID_ARGUMENT", `${name} does not match manifest.json in ${dir}`);
  }
  return createSnarkjsProver<DepthCircuitInput>({ wasm, zkey, singleThread: options.singleThread });
}

/**
 * A snarkjs prover with the artifacts from disk, integrity-checked and held in
 * memory. Call `terminateProver()` from `@loch/sdk` before the process should exit.
 */
export async function createNodeProver(options: { dir?: string; singleThread?: boolean } = {}): Promise<Prover> {
  const { wasm, zkey } = await loadProverArtifacts(options.dir);
  return createSnarkjsProver({ wasm, zkey, singleThread: options.singleThread });
}
