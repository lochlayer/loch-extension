// Shared test fixtures: deterministic wallets and paths to repository files.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { Keypair, PublicKey } from "@solana/web3.js";

import { type LochKeys, deriveKeys, keyDerivationMessage } from "../../src/index.js";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const VECTOR_PATH = `${REPO_ROOT}circuits/artifacts/devnet/test_vector.json`;
export const IDL_PATH = `${REPO_ROOT}target/idl/loch_pool.json`;

export const readJson = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
export const fileExists = (path: string) => existsSync(path);

/** A Solana wallet with a fixed key, derived from a label. */
export function wallet(label: string): Keypair {
  return Keypair.fromSeed(sha256(new TextEncoder().encode(`loch test wallet: ${label}`)));
}

/** What `wallet.signMessage(keyDerivationMessage())` returns for a test wallet. */
export function signDerivationMessage(keypair: Keypair): Uint8Array {
  return ed25519.sign(keyDerivationMessage(), keypair.secretKey.subarray(0, 32));
}

/** The Loch keys of a test wallet. */
export function lochKeys(label: string): LochKeys {
  const keypair = wallet(label);
  return deriveKeys(signDerivationMessage(keypair), keypair.publicKey.toBytes());
}

export const SOL = 1_000_000_000n;

/** A public key that is just a label, for accounts nobody signs with. */
export function address(label: string): PublicKey {
  return wallet(label).publicKey;
}
