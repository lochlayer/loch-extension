// Depth proofs: real Groth16 proofs with the depth circuit's dev setup, checked
// against the in-memory pool (helpers/fakePool.ts).

import { afterAll, describe, expect, it } from "vitest";

import {
  DEPTH_NOTES,
  type Groth16Verify,
  type LochKeys,
  LochError,
  type OwnedNote,
  type PreparedTransact,
  buildTransactTransaction,
  createWalletState,
  decodeDepthProof,
  depthChallengeHash,
  encodeDepthProof,
  fetchPoolConfig,
  isDepthProof,
  normalizeChallenge,
  ownedNotes,
  prepareDeposit,
  prepareWithdrawal,
  proveDepth,
  selectDepthNotes,
  syncWallet,
  terminateProver,
  verifyDepthProof,
  verifyProof,
} from "../src/index.js";
import { createNodeDepthProver } from "../src/node.js";
import { checkingProver } from "./helpers/checkingProver.js";
import { FakePool } from "./helpers/fakePool.js";
import { SOL, lochKeys, wallet } from "./helpers/fixtures.js";

const alice = lochKeys("alice");
const aliceWallet = wallet("alice");
const screener = wallet("screener");
const relayer = wallet("relayer");
const BLOCKHASH = "11111111111111111111111111111111";
const CHALLENGE = "OTC desk, 2026-10-20, ticket 7f3a";

const proverPromise = createNodeDepthProver();
const groth16: Groth16Verify = (key, signals, proof) => verifyProof(key, proof, signals);
afterAll(terminateProver);

async function submit(pool: FakePool, prepared: PreparedTransact, payer = aliceWallet) {
  return pool.process(buildTransactTransaction({ instruction: prepared.instruction, payer: payer.publicKey, recentBlockhash: BLOCKHASH }));
}

async function deposit(pool: FakePool, keys: LochKeys, amount: bigint) {
  const prepared = await prepareDeposit({ prover: checkingProver(), keys, root: pool.tree.root, amount, depositor: aliceWallet.publicKey, config: await fetchPoolConfig(pool.connection) });
  await submit(pool, prepared);
}

async function poolWith(...amounts: bigint[]) {
  const pool = new FakePool({ screener: screener.publicKey, maxDeposit: 10n * SOL });
  for (const amount of amounts) await deposit(pool, alice, amount);
  const synced = await syncWallet(pool.connection, createWalletState(alice), alice);
  return { pool, synced };
}

async function prove(synced: Awaited<ReturnType<typeof poolWith>>["synced"], threshold: bigint, challenge = CHALLENGE) {
  return proveDepth({ prover: await proverPromise, keys: alice, notes: ownedNotes(synced.state), tree: synced.tree, threshold, challenge, cluster: "localnet" });
}

describe("depth proofs", () => {
  it("proves at least X, travels as text, and checks out against the chain", async () => {
    const { pool, synced } = await poolWith(2n * SOL, 3n * SOL);
    const { depth, shown } = await prove(synced, 4n * SOL);
    // 4 SOL needs both notes; the proof does not say how much more there is.
    expect(shown.map((note) => note.amount).sort()).toEqual([2n * SOL, 3n * SOL]);
    expect(depth.nullifiers).toHaveLength(DEPTH_NOTES);

    const text = encodeDepthProof(depth);
    expect(text.startsWith("lochdepth1")).toBe(true);
    expect(isDepthProof(text)).toBe(true);
    const decoded = decodeDepthProof(text);
    expect(decoded).toEqual(depth);
    expect(decodeDepthProof(text.toUpperCase())).toEqual(depth);

    const verified = await verifyDepthProof(pool.connection, decoded, groth16, { challenge: CHALLENGE });
    expect(verified).toMatchObject({ ok: true, threshold: 4n * SOL, challenge: CHALLENGE, cluster: "localnet", rootAge: 0 });
  });

  it("is refused for another challenge, a changed threshold, a changed cluster, or a spent note", async () => {
    const { pool, synced } = await poolWith(2n * SOL);
    const { depth } = await prove(synced, SOL);

    expect(await verifyDepthProof(pool.connection, depth, groth16, { challenge: "something else" })).toMatchObject({ ok: false, problem: expect.stringMatching(/different challenge/) });
    for (const forged of [{ ...depth, threshold: 2n * SOL }, { ...depth, challenge: "something else" }, { ...depth, cluster: "mainnet" as const }]) {
      expect(await verifyDepthProof(pool.connection, forged, groth16)).toMatchObject({ ok: false, problem: expect.stringMatching(/does not verify/) });
    }
    expect(await verifyDepthProof(pool.connection, { ...depth, nullifiers: [depth.nullifiers[0]!, depth.nullifiers[0]!, ...depth.nullifiers.slice(2)] }, groth16)).toMatchObject({ ok: false, problem: expect.stringMatching(/twice/) });

    // Surface from the shown note: the verifier now sees it spent.
    const withdrawal = await prepareWithdrawal({ prover: checkingProver(), keys: alice, state: synced.state, tree: synced.tree, relayer: relayer.publicKey, fee: 5_000n, maxFee: 5_000n, recipient: aliceWallet.publicKey, amount: SOL / 2n });
    await pool.process(buildTransactTransaction({ instruction: withdrawal.instruction, payer: relayer.publicKey, recentBlockhash: BLOCKHASH }));
    expect(await verifyDepthProof(pool.connection, depth, groth16)).toMatchObject({ ok: false, problem: expect.stringMatching(/spent/) });
  });

  it("ages with the root history and expires after 64 transactions", async () => {
    const { pool, synced } = await poolWith(SOL);
    const { depth } = await prove(synced, SOL);
    for (let i = 0; i < 63; i++) pool.tree.insertPair(BigInt(2 * i + 11), BigInt(2 * i + 12));
    expect(await verifyDepthProof(pool.connection, depth, groth16)).toMatchObject({ ok: true, rootAge: 63 });
    pool.tree.insertPair(7n, 8n);
    expect(await verifyDepthProof(pool.connection, depth, groth16)).toMatchObject({ ok: false, problem: expect.stringMatching(/too old/) });
  });

  it("refuses to make a proof the notes cannot carry", async () => {
    const { synced } = await poolWith(SOL);
    await expect(prove(synced, SOL + 1n)).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    await expect(prove(synced, 0n)).rejects.toBeInstanceOf(LochError);
    await expect(prove(synced, SOL, "   ")).rejects.toBeInstanceOf(LochError);
    await expect(prove(synced, SOL, "x".repeat(129))).rejects.toBeInstanceOf(LochError);
  });
});

describe("choosing notes", () => {
  const note = (amount: bigint, leafIndex: number, spent = false): OwnedNote => ({ amount, leafIndex, spent, publicKey: alice.publicKey, blinding: 1n, commitment: BigInt(leafIndex), nullifier: BigInt(leafIndex) });

  it("shows the fewest notes, and the smallest single one that is enough", () => {
    const notes = [note(5n, 0), note(9n, 1), note(1n, 2), note(7n, 3), note(100n, 4, true)];
    expect(selectDepthNotes(notes, 6n).map((n) => n.amount)).toEqual([7n]);
    expect(selectDepthNotes(notes, 15n).map((n) => n.amount)).toEqual([9n, 7n]);
    expect(selectDepthNotes(notes, 22n).map((n) => n.amount)).toEqual([9n, 7n, 5n, 1n]);
    expect(() => selectDepthNotes(notes, 23n)).toThrow(expect.objectContaining({ code: "INSUFFICIENT_BALANCE" }));
  });

  it("asks for a merge when four notes are not enough", () => {
    const notes = [1n, 1n, 1n, 1n, 1n].map((amount, i) => note(amount, i));
    expect(() => selectDepthNotes(notes, 5n)).toThrow(expect.objectContaining({ code: "CONSOLIDATION_REQUIRED" }));
  });
});

describe("challenges and the code", () => {
  it("compares challenges in one normal form, and binds the cluster", () => {
    expect(normalizeChallenge("  café ")).toBe("café");
    expect(depthChallengeHash("café", "mainnet")).toBe(depthChallengeHash(" café", "mainnet"));
    expect(depthChallengeHash("café", "mainnet")).not.toBe(depthChallengeHash("café", "devnet"));
    expect(depthChallengeHash("x", "mainnet") >> 248n).toBe(0n);
  });

  it("rejects what is not a depth proof", async () => {
    const { synced } = await poolWith(SOL);
    const text = encodeDepthProof((await prove(synced, SOL)).depth);
    const flipped = `${text.slice(0, -1)}${text.endsWith("q") ? "p" : "q"}`;
    for (const bad of [flipped, "lochdepth1qqqqqq", "hello", `${text}q`]) {
      expect(isDepthProof(bad)).toBe(false);
      expect(() => decodeDepthProof(bad)).toThrow(LochError);
    }
  });
});
