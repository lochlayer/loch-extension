// End to end with the real devnet artifacts: deposit, private transfer to a
// second key set, withdrawal by that key set. Every proof is a real Groth16
// proof, verified by snarkjs against verification_key.json from nothing but
// the bytes that would go on chain. The pool and the RPC are in memory
// (helpers/fakePool.ts); no network.

import { inspect } from "node:util";

import { VersionedTransaction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Prover,
  type SyncResult,
  type VerificationKey,
  balance,
  buildTransactInstruction,
  buildTransactTransaction,
  createWalletState,
  decodeProof,
  decodeTransactArgs,
  encodeShieldedAddress,
  fetchPoolConfig,
  fetchRecipientRent,
  fetchTreeAccount,
  isKnownRoot,
  parseProgramError,
  prepareDeposit,
  prepareTransfer,
  prepareWithdrawal,
  syncWallet,
  terminateProver,
  transactPublicInputs,
  unspentNotes,
  vaultPda,
  verifyProof,
} from "../src/index.js";
import { createNodeProver, loadProverArtifacts, loadVerificationKey } from "../src/node.js";
import {
  applyScreenerSignature,
  fromRelayRequest,
  inspectDepositTransaction,
  parseScreenTransaction,
  toRelayRequest,
  toScreenRequest,
  validateRelayRequest,
  validateScreenRequest,
  validateScreenResponse,
} from "../src/wire.js";
import { FakePool, ProgramRejection } from "./helpers/fakePool.js";
import { SOL, VECTOR_PATH, address, lochKeys, readJson, wallet } from "./helpers/fixtures.js";

const BLOCKHASH = "11111111111111111111111111111111";
const FEE = 5_000n;

const aliceWallet = wallet("alice");
const alice = lochKeys("alice");
const bob = lochKeys("bob");
const screener = wallet("screener");
const relayer = wallet("relayer");
const destination = address("bob's public wallet");

let prover: Prover;
let verificationKey: VerificationKey;
let pool: FakePool;
let aliceSync: SyncResult;
let bobSync: SyncResult;

/** What the relayer does with a request body: validate, pre-check the proof, build, sign, send. */
async function relay(body: unknown): Promise<string> {
  const validated = validateRelayRequest(JSON.parse(JSON.stringify(body)));
  if (!validated.ok) throw validated.error;
  const args = fromRelayRequest(validated.value);
  expect(await verifyProof(verificationKey, decodeProof(args.proof), transactPublicInputs(args))).toBe(true);
  const transaction = buildTransactTransaction({
    instruction: buildTransactInstruction(args, { signer: relayer.publicKey }),
    payer: relayer.publicKey,
    recentBlockhash: BLOCKHASH,
  });
  transaction.sign([relayer]);
  return pool.process(transaction);
}

beforeAll(async () => {
  prover = await createNodeProver();
  verificationKey = await loadVerificationKey();
  pool = new FakePool({ screener: screener.publicKey, verificationKey, maxDeposit: 5n * SOL });
});

afterAll(terminateProver);

describe("deposit, private transfer, withdrawal with real proofs", () => {
  it("loads artifacts that match the manifest and the committed test vector", async () => {
    const artifacts = await loadProverArtifacts();
    expect(artifacts.zkeySha256).toBe(readJson(VECTOR_PATH).zkeySha256);
    expect(artifacts.wasm.length).toBeGreaterThan(1_000_000);
    expect(artifacts.verificationKey).toEqual(verificationKey);
    await expect(loadProverArtifacts("/nonexistent")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("deposit: Alice dives in with 1 SOL, co-signed by the screening authority", async () => {
    const config = await fetchPoolConfig(pool.connection);
    const { root } = await fetchTreeAccount(pool.connection);
    const prepared = await prepareDeposit({ prover, keys: alice, root, amount: SOL, depositor: aliceWallet.publicKey, config });

    // The proof verifies, and the signals are exactly what the program recomputes from the bytes.
    expect(await verifyProof(verificationKey, prepared.proof, prepared.publicSignals)).toBe(true);
    const onTheWire = decodeTransactArgs(prepared.data);
    expect(transactPublicInputs(onTheWire).map(String)).toEqual(prepared.publicSignals);
    expect(await verifyProof(verificationKey, decodeProof(onTheWire.proof), transactPublicInputs(onTheWire))).toBe(true);

    const transaction = buildTransactTransaction({ instruction: prepared.instruction, payer: aliceWallet.publicKey, recentBlockhash: BLOCKHASH });
    expect(transaction.serialize().length).toBeLessThanOrEqual(1232);

    // Screening service: validate, inspect, sign.
    const request = validateScreenRequest(JSON.parse(JSON.stringify(toScreenRequest(transaction))));
    if (!request.ok) throw request.error;
    const parsed = parseScreenTransaction(request.value);
    if (!parsed.ok) throw parsed.error;
    const inspection = inspectDepositTransaction(parsed.value, { screener: screener.publicKey });
    if (!inspection.ok) throw inspection.error;
    expect(inspection.value.amount).toBe(SOL);
    expect(inspection.value.depositor.equals(aliceWallet.publicKey)).toBe(true);
    parsed.value.sign([screener]);
    const response = validateScreenResponse({
      signature: Buffer.from(parsed.value.signatures[inspection.value.screenerSignatureIndex]!).toString("base64"),
      screener: screener.publicKey.toBase58(),
    });
    if (!response.ok) throw response.error;

    // Client: apply the screener's signature, then the wallet signs.
    applyScreenerSignature(transaction, response.value);
    transaction.sign([aliceWallet]);
    expect(transaction.signatures.every((signature) => signature.some((byte) => byte !== 0))).toBe(true);
    const reparsed = VersionedTransaction.deserialize(transaction.serialize());
    await pool.process(reparsed);

    expect(pool.balanceOf(vaultPda())).toBe(SOL);
    aliceSync = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(balance(aliceSync.state)).toBe(SOL);
    expect(aliceSync.received).toHaveLength(1);
    expect(aliceSync.tree.root).toBe(pool.tree.root);
  });

  it("private transfer: Alice pays Bob 0.3 SOL through the relayer; Bob finds the note by trial decryption", async () => {
    const prepared = await prepareTransfer({
      prover,
      keys: alice,
      state: aliceSync.state,
      tree: aliceSync.tree,
      to: encodeShieldedAddress(bob),
      amount: 300_000_000n,
      relayer: relayer.publicKey,
      fee: FEE,
      maxFee: FEE,
    });
    expect(await verifyProof(verificationKey, prepared.proof, prepared.publicSignals)).toBe(true);
    expect(transactPublicInputs(decodeTransactArgs(prepared.data)).map(String)).toEqual(prepared.publicSignals);
    expect(isKnownRoot(await fetchTreeAccount(pool.connection), prepared.publicInputs.root)).toBe(true);

    // The proof binds the ext data: a relayer that raises its own fee gets InvalidProof.
    const request = toRelayRequest(prepared.args);
    const greedy = { ...request, extData: { ...request.extData, fee: "6000" } };
    const validated = validateRelayRequest(greedy);
    if (!validated.ok) throw validated.error;
    const tampered = fromRelayRequest(validated.value);
    expect(await verifyProof(verificationKey, decodeProof(tampered.proof), transactPublicInputs(tampered))).toBe(false);
    const rejected = await pool
      .process(buildTransactTransaction({ instruction: buildTransactInstruction(tampered, { signer: relayer.publicKey }), payer: relayer.publicKey, recentBlockhash: BLOCKHASH }))
      .catch((error) => error);
    expect(rejected).toBeInstanceOf(ProgramRejection);
    expect(parseProgramError(rejected.logs)).toMatchObject({ kind: "InvalidProof", number: 6000 });

    await relay(request);
    expect(pool.balanceOf(relayer.publicKey)).toBe(FEE);
    expect(pool.balanceOf(vaultPda())).toBe(SOL - FEE);

    // Bob has never synced: he discovers his note from the events alone.
    bobSync = await syncWallet(pool.connection, createWalletState(bob), bob);
    expect(bobSync.received.map((note) => note.amount)).toEqual([300_000_000n]);
    expect(balance(bobSync.state)).toBe(300_000_000n);
    expect(bobSync.state.leaves).toHaveLength(4);

    aliceSync = await syncWallet(pool.connection, aliceSync.state, alice, { tree: aliceSync.tree });
    expect(aliceSync.spent.map((note) => note.amount)).toEqual([SOL]);
    expect(balance(aliceSync.state)).toBe(SOL - 300_000_000n - FEE);
    expect(aliceSync.tree.root).toBe(bobSync.tree.root);
  });

  it("withdrawal: Bob surfaces 0.2 SOL to a public account, fee paid from his shielded balance", async () => {
    const rent = await fetchRecipientRent(pool.connection, destination);
    expect(rent.lamports).toBe(0n);
    const prepared = await prepareWithdrawal({
      prover,
      keys: bob,
      state: bobSync.state,
      tree: bobSync.tree,
      recipient: destination,
      amount: 200_000_000n,
      relayer: relayer.publicKey,
      fee: FEE,
      maxFee: FEE,
      rent,
    });
    expect(await verifyProof(verificationKey, prepared.proof, prepared.publicSignals)).toBe(true);
    expect(transactPublicInputs(decodeTransactArgs(prepared.data)).map(String)).toEqual(prepared.publicSignals);

    const request = toRelayRequest(prepared.args);
    await relay(request);
    expect(pool.balanceOf(destination)).toBe(200_000_000n);
    expect(pool.balanceOf(relayer.publicKey)).toBe(2n * FEE);
    expect(pool.balanceOf(vaultPda())).toBe(SOL - 200_000_000n - 2n * FEE);

    bobSync = await syncWallet(pool.connection, bobSync.state, bob, { tree: bobSync.tree });
    expect(balance(bobSync.state)).toBe(100_000_000n - FEE);
    expect(unspentNotes(bobSync.state)).toHaveLength(1);

    // The same request again is a double spend: the nullifier accounts exist.
    const replay = await relay(request).catch((error) => error);
    expect(replay).toBeInstanceOf(ProgramRejection);
    expect(parseProgramError(replay.logs)).toMatchObject({ kind: "NullifierAlreadySpent" });

    // Everything adds up: what is shielded equals what the vault holds.
    aliceSync = await syncWallet(pool.connection, aliceSync.state, alice, { tree: aliceSync.tree });
    expect(balance(aliceSync.state) + balance(bobSync.state)).toBe(pool.balanceOf(vaultPda()));
    expect(aliceSync.state.leaves).toEqual(bobSync.state.leaves);
  });

  it("proves on a single thread too, as an extension must", async () => {
    const { wasm, zkey } = await loadProverArtifacts();
    const { createSnarkjsProver } = await import("../src/index.js");
    const singleThreaded = createSnarkjsProver({ wasm, zkey, singleThread: true });
    const { root } = await fetchTreeAccount(pool.connection);
    const prepared = await prepareDeposit({
      prover: singleThreaded,
      keys: alice,
      root,
      amount: 1_000_000n,
      fee: 1_000n,
      depositor: aliceWallet.publicKey,
      config: await fetchPoolConfig(pool.connection),
    });
    expect(await verifyProof(verificationKey, prepared.proof, prepared.publicSignals)).toBe(true);
  });

  it("reports a witness the circuit rejects as PROOF_FAILED, naming the constraint and no values", async () => {
    const { createSnarkjsProver } = await import("../src/index.js");
    const { wasm, zkey } = await loadProverArtifacts();
    const raw = createSnarkjsProver({ wasm, zkey });
    const zeros = new Array<bigint>(20).fill(0n);
    const secret = 123456789123456789n;
    const blinding = 987654321987654321n;
    // Value is not conserved: outputs worth 5 from nothing.
    // The SDK itself prints nothing. The circom runtime inside snarkjs does print one line
    // when a witness fails; capture everything written to the console to check what is in it.
    const printed: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    const capture = (...parts: unknown[]) => void printed.push(parts.map(String).join(" "));
    Object.assign(console, { log: capture, error: capture, warn: capture, info: capture, debug: capture });
    let failure: any;
    try {
      failure = await raw
        .prove({
          root: 1n,
          publicAmount: 0n,
          extDataHash: 0n,
          inputNullifier: [1n, 2n],
          outputCommitment: [3n, 4n],
          inAmount: [0n, 0n],
          inPrivateKey: [secret, 2n],
          inBlinding: [blinding, 2n],
          inPathIndices: [0n, 0n],
          inPathElements: [zeros, zeros],
          outAmount: [5n, 0n],
          outPubkey: [1n, 2n],
          outBlinding: [1n, 2n],
        })
        .catch((error) => error);
    } finally {
      Object.assign(console, original);
    }
    // What reaches the console is the circuit location only, as createSnarkjsProver documents.
    expect(printed.length).toBeLessThanOrEqual(1);
    for (const line of printed) {
      expect(line).toMatch(/^ERROR:\s+\d+ Error in template \w+ line: \d+/);
      expect(line).not.toContain(secret.toString());
      expect(line).not.toContain(blinding.toString());
    }
    expect(inspect(failure, { depth: 6 })).not.toContain(secret.toString());
    expect(inspect(failure, { depth: 6 })).not.toContain(blinding.toString());
    expect(failure).toMatchObject({ code: "PROOF_FAILED" });
    expect(failure.message).toMatch(/do not satisfy the circuit \(Transaction line \d+/);
    expect(failure.message).not.toContain(secret.toString());
  });
});
