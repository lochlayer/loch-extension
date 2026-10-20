// Depth proofs: "this wallet holds at least X lamports in the pool", shown
// without showing which notes, the balance, or any address. docs/protocol.md
// section 16.
//
// A zero-knowledge proof over up to four of the wallet's notes, made with the
// depth circuit (circuits/depth.circom), never sent to the program. It proves
// that the notes are in the tree under a recent root, belong to one key, add
// up to at least `threshold`, and have these nullifiers. The verifier then
// asks the chain two things: is the root one of the pool's recent roots, and
// does any of the nullifiers have a record (is a note spent)?
//
// The proof answers a challenge: text the verifier chose, hashed into the
// proof, so a proof made for one person or one moment cannot be replayed to
// another.
//
// What it costs the prover: the nullifiers are public from now on. Whoever
// holds the proof can see when each of those notes is spent, and so which
// transaction spent it, though not who received what. A wallet should move
// the shown notes to fresh ones (a transfer to itself) before it surfaces from
// them; the extension does that.

import { bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";
import type { Commitment, Connection } from "@solana/web3.js";

import { decodeTreeAccount, isKnownRoot } from "./accounts.js";
import { bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntBE, bytesToBigIntLE, concatBytes, randomBytes, utf8 } from "./bytes.js";
import { type Groth16Proof, decodeProof, encodeProof } from "./codec.js";
import { DEFAULT_COMMITMENT, DEPTH_DOMAIN, DEPTH_PREFIX, FIELD_MODULUS, PROGRAM_ID, TREE_DEPTH } from "./constants.js";
import { DEPTH_VERIFICATION_KEY } from "./depthKey.generated.js";
import type { Rejected } from "./disclosure.js";
import { InsufficientBalanceError, LochError } from "./errors.js";
import { assertAmount } from "./field.js";
import type { LochKeys } from "./keys.js";
import type { MerkleTree } from "./merkle.js";
import { createNote, noteNullifier } from "./note.js";
import { nullifierPda, treePda } from "./pda.js";
import type { ProofResult, Prover, VerificationKey } from "./prover.js";
import type { OwnedNote } from "./wallet.js";

/** Notes one depth proof can hold. A wallet whose balance is spread wider merges notes first. */
export const DEPTH_NOTES = 4;

/** Longest challenge, in UTF-8 bytes. */
export const MAX_CHALLENGE_BYTES = 128;

/** The cluster a proof is about. The program has one id on every cluster, so the proof names it. */
export type Cluster = "mainnet" | "devnet" | "testnet" | "localnet";

const CLUSTERS: readonly Cluster[] = ["mainnet", "devnet", "testnet", "localnet"];
const VERSION = 1;

/** The witness input of `circuits/depth.circom`. `privateKey` and every note secret are SECRET. */
export interface DepthCircuitInput {
  root: bigint;
  threshold: bigint;
  challenge: bigint;
  nullifier: bigint[];
  privateKey: bigint;
  amount: bigint[];
  blinding: bigint[];
  pathIndices: bigint[];
  pathElements: bigint[][];
}

/** A depth proof as it travels. Everything in it is public. */
export interface DepthProof {
  cluster: Cluster;
  programId: PublicKey;
  /** Lamports the prover holds at least. */
  threshold: bigint;
  /** The verifier's challenge, as text. */
  challenge: string;
  /** The tree root the notes were proven against. */
  root: bigint;
  /** One per note slot, dummies included; none of them may have a record on chain. */
  nullifiers: bigint[];
  proof: Groth16Proof;
}

/**
 * A challenge as both sides compare it: Unicode NFC, outer white space
 * removed, 1 to {@link MAX_CHALLENGE_BYTES} bytes of UTF-8.
 *
 * @throws LochError `INVALID_ARGUMENT` for an empty or overlong challenge.
 */
export function normalizeChallenge(challenge: string): string {
  if (typeof challenge !== "string") throw new LochError("INVALID_ARGUMENT", "a challenge is text");
  const text = challenge.normalize("NFC").trim();
  const length = utf8(text).length;
  if (length === 0) throw new LochError("INVALID_ARGUMENT", "the challenge is empty");
  if (length > MAX_CHALLENGE_BYTES) throw new LochError("INVALID_ARGUMENT", `a challenge is at most ${MAX_CHALLENGE_BYTES} bytes`);
  return text;
}

/**
 * The circuit's `challenge`: `sha256(utf8("Loch depth proof v1") || cluster
 * index (1 byte) || programId (32) || utf8(challenge))`, first byte zeroed so
 * it is below the field modulus.
 */
export function depthChallengeHash(challenge: string, cluster: Cluster, programId: PublicKey = PROGRAM_ID): bigint {
  const index = CLUSTERS.indexOf(cluster);
  if (index < 0) throw new LochError("INVALID_ARGUMENT", "unknown cluster");
  const digest = sha256(concatBytes(utf8(DEPTH_DOMAIN), Uint8Array.of(index), programId.toBytes(), utf8(normalizeChallenge(challenge))));
  digest[0] = 0;
  return bytesToBigIntBE(digest);
}

/**
 * The fewest unspent notes that reach `threshold`, largest first: each note
 * shown is a note the verifier can watch, so fewer is better.
 *
 * @throws InsufficientBalanceError if all notes together are short of it.
 * @throws LochError `CONSOLIDATION_REQUIRED` if more than {@link DEPTH_NOTES} notes would be needed.
 */
export function selectDepthNotes(notes: readonly OwnedNote[], threshold: bigint): OwnedNote[] {
  assertAmount(threshold, "threshold");
  if (threshold === 0n) throw new LochError("INVALID_ARGUMENT", "a depth proof needs a threshold above zero");
  const usable = notes.filter((note) => !note.spent && note.amount > 0n);
  const sorted = [...usable].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.leafIndex - b.leafIndex));
  const chosen: OwnedNote[] = [];
  let sum = 0n;
  for (const note of sorted) {
    if (sum >= threshold) break;
    chosen.push(note);
    sum += note.amount;
  }
  if (sum < threshold) throw new InsufficientBalanceError(threshold, sum);
  if (chosen.length > DEPTH_NOTES) {
    throw new LochError("CONSOLIDATION_REQUIRED", `this needs more than ${DEPTH_NOTES} notes; merge notes with a transfer to self first`);
  }
  // A smaller single note may do where the largest was picked first.
  if (chosen.length === 1) return [sorted.filter((note) => note.amount >= threshold).at(-1)!];
  return chosen;
}

/** Everything {@link prepareDepthInput} and {@link proveDepth} need. */
export interface DepthParams {
  keys: Pick<LochKeys, "privateKey" | "publicKey">;
  /** The wallet's notes; the proof picks from the unspent ones. */
  notes: readonly OwnedNote[];
  /** The wallet's synced copy of the pool tree. Its root must still be one of the pool's recent roots. */
  tree: MerkleTree;
  threshold: bigint;
  challenge: string;
  cluster: Cluster;
  programId?: PublicKey;
}

/** The witness and the public part of a depth proof, before proving. */
export interface PreparedDepth {
  input: DepthCircuitInput;
  /** The notes the proof shows. Their nullifiers become public with the proof. */
  notes: OwnedNote[];
}

const randomBlinding = () => bytesToBigIntBE(randomBytes(31));

/**
 * Builds the circuit input: the chosen notes, then zero-amount dummies of the
 * same key with fresh blindings (their nullifiers look like any other and are
 * in no tree, so they never get a record).
 *
 * @throws LochError `STALE_STATE` if a chosen note is not where the tree says.
 */
export function prepareDepthInput(params: DepthParams): PreparedDepth {
  const { keys, tree, cluster } = params;
  const programId = params.programId ?? PROGRAM_ID;
  const notes = selectDepthNotes(params.notes, params.threshold);
  const challenge = depthChallengeHash(params.challenge, cluster, programId);
  const slots = notes.map((note) => {
    if (note.publicKey !== keys.publicKey) throw new LochError("INVALID_ARGUMENT", "a note does not belong to these keys");
    if (tree.leaves[note.leafIndex] !== note.commitment) throw new LochError("STALE_STATE", "the local tree does not hold this note; sync first");
    const { pathElements } = tree.path(note.leafIndex);
    return { note: createNote(note.amount, note.publicKey, note.blinding), leafIndex: note.leafIndex, pathElements };
  });
  while (slots.length < DEPTH_NOTES) {
    slots.push({ note: createNote(0n, keys.publicKey, randomBlinding()), leafIndex: 0, pathElements: Array<bigint>(TREE_DEPTH).fill(0n) });
  }
  return {
    notes,
    input: {
      root: tree.root,
      threshold: params.threshold,
      challenge,
      nullifier: slots.map(({ note, leafIndex }) => noteNullifier(note, leafIndex, keys.privateKey)),
      privateKey: keys.privateKey,
      amount: slots.map(({ note }) => note.amount),
      blinding: slots.map(({ note }) => note.blinding),
      pathIndices: slots.map(({ leafIndex }) => BigInt(leafIndex)),
      pathElements: slots.map(({ pathElements }) => pathElements),
    },
  };
}

/** A made proof and the notes it shows. */
export interface MadeDepthProof {
  depth: DepthProof;
  /** The notes whose nullifiers the proof makes public. */
  shown: OwnedNote[];
}

/**
 * Makes a depth proof. The prover receives the spending key; keep it on the
 * user's device (see {@link Prover}).
 */
export async function proveDepth(params: DepthParams & { prover: Prover<DepthCircuitInput> }): Promise<MadeDepthProof> {
  const { input, notes } = prepareDepthInput(params);
  const { proof, publicSignals }: ProofResult = await params.prover.prove(input);
  const expected = [input.root, input.threshold, input.challenge, ...input.nullifier].map(String);
  if (publicSignals.length !== expected.length || publicSignals.some((signal, i) => signal !== expected[i])) {
    throw new LochError("PROOF_FAILED", "the prover returned other public signals than it was given: wrong circuit artifacts?");
  }
  return {
    shown: notes,
    depth: {
      cluster: params.cluster,
      programId: params.programId ?? PROGRAM_ID,
      threshold: input.threshold,
      challenge: normalizeChallenge(params.challenge),
      root: input.root,
      nullifiers: input.nullifier,
      proof,
    },
  };
}

// ---------------------------------------------------------------- as text

const FIXED = 1 + 1 + 32 + 8 + 32 + 32 * DEPTH_NOTES + 256 + 1;
/** Longer than any depth code: prefix, separator, payload words, checksum. */
const MAX_LENGTH = DEPTH_PREFIX.length + 1 + Math.ceil(((FIXED + MAX_CHALLENGE_BYTES) * 8) / 5) + 6;

function malformed(what: string): never {
  throw new LochError("DECODE_FAILED", `not a valid depth proof: ${what}`);
}

/**
 * A depth proof as text: bech32m, prefix "lochdepth", payload
 * `version (1) || cluster (1) || programId (32) || threshold u64 LE (8) ||
 * root (32) || nullifier x4 (128) || proof a, b, c as the program encodes them
 * (256) || challenge length (1) || challenge UTF-8`. About 750 to 950
 * characters. Not secret: it is meant to be handed over.
 */
export function encodeDepthProof(depth: DepthProof): string {
  const challenge = utf8(normalizeChallenge(depth.challenge));
  const cluster = CLUSTERS.indexOf(depth.cluster);
  if (cluster < 0) throw new LochError("INVALID_ARGUMENT", "unknown cluster");
  if (depth.nullifiers.length !== DEPTH_NOTES) throw new LochError("INVALID_ARGUMENT", `a depth proof has ${DEPTH_NOTES} nullifiers`);
  const { a, b, c } = encodeProof(depth.proof);
  const payload = concatBytes(
    Uint8Array.of(VERSION, cluster),
    depth.programId.toBytes(),
    bigIntToBytesLE(assertAmount(depth.threshold, "threshold"), 8),
    bigIntToBytesBE(depth.root, 32),
    ...depth.nullifiers.map((nullifier) => bigIntToBytesBE(nullifier, 32)),
    a,
    b,
    c,
    Uint8Array.of(challenge.length),
    challenge,
  );
  return bech32m.encode(DEPTH_PREFIX, bech32m.toWords(payload), MAX_LENGTH);
}

/**
 * Decodes a depth proof. A link to the verification page may carry it after
 * `#`; pass the code alone.
 *
 * @throws LochError `DECODE_FAILED` for anything that is not a depth proof of version 1.
 */
export function decodeDepthProof(text: string): DepthProof {
  if (typeof text !== "string" || text.length > MAX_LENGTH) return malformed("too long");
  let payload: Uint8Array;
  try {
    const decoded = bech32m.decode(text.trim().toLowerCase() as `${string}1${string}`, MAX_LENGTH);
    if (decoded.prefix !== DEPTH_PREFIX) return malformed("wrong prefix");
    payload = bech32m.fromWords(decoded.words);
  } catch (error) {
    if (error instanceof LochError) throw error;
    return malformed("bad encoding or checksum");
  }
  if (payload.length < FIXED + 1 || payload[0] !== VERSION) return malformed("unknown version or too short");
  const cluster = CLUSTERS[payload[1]!];
  if (!cluster) return malformed("unknown cluster");
  let at = 2;
  const take = (length: number) => payload.subarray(at, (at += length));
  const programId = new PublicKey(take(32));
  const threshold = bytesToBigIntLE(take(8));
  const field = (bytes: Uint8Array) => {
    const value = bytesToBigIntBE(bytes);
    return value < FIELD_MODULUS ? value : malformed("a public value is not below the field modulus");
  };
  const root = field(take(32));
  const nullifiers = Array.from({ length: DEPTH_NOTES }, () => field(take(32)));
  let proof: Groth16Proof;
  try {
    proof = decodeProof({ a: take(64), b: take(128), c: take(64) });
  } catch {
    return malformed("the proof points are malformed");
  }
  const length = payload[at++]!;
  if (payload.length !== at + length) return malformed("the challenge has the wrong length");
  let challenge: string;
  try {
    challenge = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(at));
  } catch {
    return malformed("the challenge is not UTF-8");
  }
  if (threshold === 0n) return malformed("the threshold is zero");
  try {
    if (normalizeChallenge(challenge) !== challenge) return malformed("the challenge is not in normal form");
  } catch {
    return malformed("the challenge is empty or too long");
  }
  return { cluster, programId, threshold, challenge, root, nullifiers, proof };
}

/** True when `text` decodes as a depth proof. Never throws. */
export function isDepthProof(text: string): boolean {
  try {
    decodeDepthProof(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- checking

/** The RPC method a check uses: one `getMultipleAccounts`. A web3.js `Connection` satisfies it. */
export type DepthConnection = Pick<Connection, "getMultipleAccountsInfoAndContext">;

/** Options of {@link verifyDepthProof}. */
export interface VerifyDepthOptions {
  /**
   * The challenge the verifier gave. When set, a proof answering any other
   * challenge is rejected. Without it the caller must show `challenge` and
   * have a person compare it.
   */
  challenge?: string;
  /** The depth circuit's verification key. Default: the one this SDK ships. */
  verificationKey?: VerificationKey;
  /** Default `confirmed`. */
  commitment?: Commitment;
}

/**
 * A Groth16 check: `snarkjs.groth16.verify` fits. Passed in so that this module,
 * and the verify entry point, load no proving code; a page loads snarkjs when
 * it checks.
 */
export type Groth16Verify = (key: VerificationKey, publicSignals: string[], proof: Groth16Proof) => Promise<boolean>;

/** What a depth proof that checks out says. */
export interface VerifiedDepth {
  ok: true;
  cluster: Cluster;
  /** Lamports the prover holds at least, in unspent notes. */
  threshold: bigint;
  /** The challenge the proof answers. */
  challenge: string;
  /** The slot the chain was read at: the notes were unspent then. */
  slot: number;
  /** How many transactions ago the proof's root was the newest (0: it still is). */
  rootAge: number;
}

/**
 * Checks a depth proof: the Groth16 proof against the public values, then,
 * in one RPC call at one slot, that the root is one of the pool's recent
 * roots and that none of the nullifiers has a record.
 *
 * A proof stops checking out when its root leaves the pool's root history
 * (after 64 more transactions) or when a shown note is spent; the prover
 * then makes a new one.
 *
 * The connection must be to the proof's `cluster`; the caller picks it.
 *
 * Privacy: the RPC learns which nullifiers are being asked about.
 */
export async function verifyDepthProof(
  connection: DepthConnection,
  depth: DepthProof,
  groth16Verify: Groth16Verify,
  options: VerifyDepthOptions = {},
): Promise<VerifiedDepth | Rejected> {
  if (options.challenge !== undefined && normalizeChallenge(options.challenge) !== depth.challenge) {
    return { ok: false, problem: "the proof answers a different challenge than yours" };
  }
  if (new Set(depth.nullifiers.map(String)).size !== depth.nullifiers.length) return { ok: false, problem: "the proof counts a note twice" };
  const signals = [depth.root, depth.threshold, depthChallengeHash(depth.challenge, depth.cluster, depth.programId), ...depth.nullifiers].map(String);
  let verified = false;
  try {
    verified = await groth16Verify(options.verificationKey ?? DEPTH_VERIFICATION_KEY, signals, depth.proof);
  } catch {
    // A malformed point: not a proof.
  }
  if (!verified) {
    return { ok: false, problem: "the proof does not verify: it was not made from notes that hold this much" };
  }

  const addresses = [treePda(depth.programId), ...depth.nullifiers.map((nullifier) => nullifierPda(nullifier, depth.programId))];
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(addresses, options.commitment ?? DEFAULT_COMMITMENT);
  const [treeInfo, ...records] = value;
  if (!treeInfo || !treeInfo.owner.equals(depth.programId)) return { ok: false, problem: `the pool does not exist on ${depth.cluster} at this RPC` };
  const tree = decodeTreeAccount(treeInfo.data);
  if (!isKnownRoot(tree, depth.root)) {
    return { ok: false, problem: "the proof is too old: the pool has moved on more than 64 transactions since. Ask for a new one." };
  }
  if (records.some((record) => record !== null && record.owner.equals(depth.programId))) {
    return { ok: false, problem: "a note in the proof has been spent since it was made" };
  }
  const slots = tree.roots.length;
  const position = tree.roots.indexOf(depth.root);
  return {
    ok: true,
    cluster: depth.cluster,
    threshold: depth.threshold,
    challenge: depth.challenge,
    slot: context.slot,
    rootAge: (tree.currentRootIndex - position + slots) % slots,
  };
}
