// The transaction builders, with a prover that checks the circuit's constraints
// in plain JS (fast). Real Groth16 proofs are exercised in e2e.test.ts.

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { bytesToBigIntBE } from "../src/bytes.js";
import {
  ConsolidationRequiredError,
  ENCRYPTED_NOTE_LENGTH,
  FIELD_MODULUS,
  FeeTooHighError,
  InsufficientBalanceError,
  type LochKeys,
  LochError,
  MerkleTree,
  type PreparedTransact,
  type SyncResult,
  UnknownRootError,
  balance,
  buildTransactInstruction,
  buildTransactTransaction,
  createNote,
  createWalletState,
  decodeTransactArgs,
  decodeTransactInstruction,
  encodeShieldedAddress,
  extDataHash,
  fetchPoolConfig,
  fetchRecipientRent,
  noteCommitment,
  noteNullifier,
  parseProgramError,
  prepareConsolidation,
  prepareDeposit,
  prepareTransact,
  prepareTransfer,
  prepareWithdrawal,
  publicAmountField,
  syncWallet,
  transactPublicInputs,
  treePda,
  tryDecryptNote,
  unspentNotes,
  vaultPda,
  configPda,
  SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM,
} from "../src/index.js";
import { validateRelayerInfo } from "../src/wire.js";
import { checkingProver } from "./helpers/checkingProver.js";
import { FakePool, ProgramRejection } from "./helpers/fakePool.js";
import { SOL, address, lochKeys, wallet } from "./helpers/fixtures.js";

const alice = lochKeys("alice");
const bob = lochKeys("bob");
const aliceWallet = wallet("alice");
const screener = wallet("screener");
const relayer = wallet("relayer");
const BLOCKHASH = "11111111111111111111111111111111";
const FEE = 5_000n;
const RENT = { lamports: 0n, rentExemptMinimum: 890_880n };

const newPool = () => new FakePool({ screener: screener.publicKey, maxDeposit: 10n * SOL });

async function submit(pool: FakePool, prepared: PreparedTransact, payer: Keypair): Promise<string> {
  const transaction = buildTransactTransaction({ instruction: prepared.instruction, payer: payer.publicKey, recentBlockhash: BLOCKHASH });
  return pool.process(transaction);
}

async function deposit(pool: FakePool, keys: LochKeys, amount: bigint): Promise<PreparedTransact> {
  const prepared = await prepareDeposit({
    prover: checkingProver(),
    keys,
    root: pool.tree.root,
    amount,
    depositor: aliceWallet.publicKey,
    config: await fetchPoolConfig(pool.connection),
  });
  await submit(pool, prepared, aliceWallet);
  return prepared;
}

/** A pool in which Alice holds one note per amount, and her synced wallet. */
async function funded(amounts: bigint[]): Promise<{ pool: FakePool; synced: SyncResult }> {
  const pool = newPool();
  for (const amount of amounts) await deposit(pool, alice, amount);
  return { pool, synced: await syncWallet(pool.connection, createWalletState(alice), alice) };
}

const spend = (synced: SyncResult) => ({
  prover: checkingProver(),
  keys: alice,
  state: synced.state,
  tree: synced.tree,
  relayer: relayer.publicKey,
  fee: FEE,
  maxFee: FEE,
});

describe("prepareDeposit", () => {
  it("builds a deposit: ext_amount positive, depositor in every role, screener as co-signer", async () => {
    const pool = newPool();
    const prover = checkingProver();
    const prepared = await prepareDeposit({
      prover,
      keys: alice,
      root: pool.tree.root,
      amount: SOL,
      depositor: aliceWallet.publicKey,
      config: await fetchPoolConfig(pool.connection),
    });
    const { extData } = prepared.args;
    expect(extData.extAmount).toBe(SOL);
    expect(extData.fee).toBe(0n);
    expect(extData.recipient.equals(aliceWallet.publicKey)).toBe(true);
    expect(extData.relayer.equals(aliceWallet.publicKey)).toBe(true);
    const { accounts } = decodeTransactInstruction(prepared.instruction);
    expect(accounts.signer.equals(aliceWallet.publicKey)).toBe(true);
    expect(accounts.screener?.equals(screener.publicKey)).toBe(true);
    expect(prepared.publicInputs.publicAmount).toBe(SOL);
    expect(prepared.publicInputs.root).toBe(pool.tree.root);

    // Both inputs are dummies: zero amount, all-zero path, leaf index 0.
    const input = prover.inputs[0]!;
    expect(input.inAmount).toEqual([0n, 0n]);
    expect(input.inPathIndices).toEqual([0n, 0n]);
    expect(input.inPathElements[0]).toEqual(new Array(20).fill(0n));
    expect(input.inPrivateKey[0]).not.toBe(input.inPrivateKey[1]);
  });

  it("creates one note for the amount and one zero-amount note, both to the depositor, both encrypted", async () => {
    const pool = newPool();
    const prepared = await deposit(pool, alice, SOL);
    expect(prepared.outputs.map((output) => output.note.amount).sort()).toEqual([0n, SOL]);
    for (const output of prepared.outputs) {
      expect(output.note.publicKey).toBe(alice.publicKey);
      expect(output.encryptedOutput).toHaveLength(ENCRYPTED_NOTE_LENGTH);
      expect(output.commitment).toBe(noteCommitment(output.note));
      expect(tryDecryptNote(output.encryptedOutput, alice, output.commitment)).toEqual(output.note);
      expect(tryDecryptNote(output.encryptedOutput, bob, output.commitment)).toBeNull();
    }
    expect(prepared.args.extData.encryptedOutput0).toEqual(prepared.outputs[0].encryptedOutput);
    expect(prepared.args.extData.encryptedOutput1).toEqual(prepared.outputs[1].encryptedOutput);
    expect(prepared.outputs.map((output) => output.position)).toEqual([0, 1]);
  });

  it("returns arguments, data and public values that agree with each other and with the program", async () => {
    const pool = newPool();
    const prepared = await deposit(pool, alice, 3n * SOL);
    const decoded = decodeTransactArgs(prepared.data);
    expect(decoded).toEqual(prepared.args);
    expect(new Uint8Array(prepared.instruction.data)).toEqual(prepared.data);
    expect(transactPublicInputs(decoded).map(String)).toEqual(prepared.publicSignals);
    const { publicInputs } = prepared;
    expect(prepared.publicSignals).toEqual(
      [publicInputs.root, publicInputs.publicAmount, publicInputs.extDataHash, ...publicInputs.inputNullifiers, ...publicInputs.outputCommitments].map(String),
    );
    expect(publicInputs.extDataHash).toBe(extDataHash(prepared.args.extData));
    expect(publicInputs.outputCommitments).toEqual([prepared.outputs[0].commitment, prepared.outputs[1].commitment]);
    expect(bytesToBigIntBE(prepared.args.inputNullifiers[0])).toBe(publicInputs.inputNullifiers[0]);
  });

  it("takes the fee out of the shielded amount, deposits included", async () => {
    const pool = newPool();
    const prepared = await prepareDeposit({
      prover: checkingProver(),
      keys: alice,
      root: pool.tree.root,
      amount: SOL,
      fee: 1_000n,
      depositor: aliceWallet.publicKey,
      config: await fetchPoolConfig(pool.connection),
    });
    expect(prepared.outputs.map((output) => output.note.amount).sort()).toEqual([0n, SOL - 1_000n]);
    expect(prepared.publicInputs.publicAmount).toBe(SOL - 1_000n);
  });

  it("uses fresh dummy inputs every time, so two deposits never collide on a nullifier", async () => {
    const pool = newPool();
    const first = await deposit(pool, alice, SOL);
    const second = await deposit(pool, alice, SOL);
    const all = [...first.publicInputs.inputNullifiers, ...second.publicInputs.inputNullifiers];
    expect(new Set(all).size).toBe(4);
    expect(pool.tree.nextIndex).toBe(4);
  });

  it("shuffles the two outputs", async () => {
    const pool = newPool();
    const positions = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const prepared = await prepareDeposit({
        prover: checkingProver(),
        keys: alice,
        root: pool.tree.root,
        amount: SOL,
        depositor: aliceWallet.publicKey,
        config: { screener: screener.publicKey, maxDeposit: 10n * SOL, paused: false },
      });
      positions.add(prepared.outputs.findIndex((output) => output.note.amount === SOL));
    }
    expect([...positions].sort()).toEqual([0, 1]);
  });

  it("checks the pool's limits before proving", async () => {
    const prover = checkingProver();
    const base = { prover, keys: alice, root: newPool().tree.root, depositor: aliceWallet.publicKey };
    const config = { screener: screener.publicKey, maxDeposit: 2n * SOL, paused: false };
    await expect(prepareDeposit({ ...base, amount: 2n * SOL + 1n, config })).rejects.toMatchObject({ code: "DEPOSIT_TOO_LARGE" });
    await expect(prepareDeposit({ ...base, amount: SOL, config: { ...config, paused: true } })).rejects.toMatchObject({ code: "DEPOSITS_PAUSED" });
    await expect(prepareDeposit({ ...base, amount: 0n, config })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(prepareDeposit({ ...base, amount: SOL, fee: SOL + 1n, config })).rejects.toThrow(/fee exceeds/);
    await expect(prepareDeposit({ ...base, amount: 1.5 as unknown as bigint, config })).rejects.toThrow(/amount/);
    expect(prover.inputs).toHaveLength(0);
    await expect(prepareDeposit({ ...base, amount: 2n * SOL, config })).resolves.toBeDefined();
  });

  it("is accepted by the program only with the screener's account", async () => {
    const pool = newPool();
    const prepared = await prepareDeposit({
      prover: checkingProver(),
      keys: alice,
      root: pool.tree.root,
      amount: SOL,
      depositor: aliceWallet.publicKey,
      config: await fetchPoolConfig(pool.connection),
    });
    const withoutScreener = buildTransactInstruction(prepared.args, { signer: aliceWallet.publicKey });
    const rejected = await pool
      .process(buildTransactTransaction({ instruction: withoutScreener, payer: aliceWallet.publicKey, recentBlockhash: BLOCKHASH }))
      .catch((error) => error);
    expect(rejected).toBeInstanceOf(ProgramRejection);
    expect(parseProgramError(rejected.logs)).toMatchObject({ kind: "MissingScreenerSignature" });
    await submit(pool, prepared, aliceWallet);
    expect(pool.balanceOf(decodeTransactInstruction(prepared.instruction).accounts.vault)).toBe(SOL);
  });
});

describe("prepareTransfer", () => {
  it("pays the recipient, returns change to the sender, and the relayer its fee", async () => {
    const { pool, synced } = await funded([SOL]);
    const prover = checkingProver();
    const prepared = await prepareTransfer({ ...spend(synced), prover, to: encodeShieldedAddress(bob), amount: 300_000_000n });

    const { extData } = prepared.args;
    expect(extData.extAmount).toBe(0n);
    expect(extData.fee).toBe(FEE);
    expect(extData.recipient.equals(relayer.publicKey)).toBe(true);
    expect(extData.relayer.equals(relayer.publicKey)).toBe(true);
    const { accounts } = decodeTransactInstruction(prepared.instruction);
    expect(accounts.signer.equals(relayer.publicKey)).toBe(true);
    expect(accounts.screener).toBeNull();
    expect(prepared.publicInputs.publicAmount).toBe(FIELD_MODULUS - FEE);
    expect(prepared.publicInputs.publicAmount).toBe(publicAmountField(0n, FEE));
    expect(prepared.publicInputs.root).toBe(synced.tree.root);

    const toBob = prepared.outputs.find((output) => output.note.publicKey === bob.publicKey)!;
    const change = prepared.outputs.find((output) => output.note.publicKey === alice.publicKey)!;
    expect(toBob.note.amount).toBe(300_000_000n);
    expect(change.note.amount).toBe(SOL - 300_000_000n - FEE);
    expect(tryDecryptNote(toBob.encryptedOutput, bob, toBob.commitment)).toEqual(toBob.note);
    expect(tryDecryptNote(toBob.encryptedOutput, alice, toBob.commitment)).toBeNull();
    expect(tryDecryptNote(change.encryptedOutput, alice, change.commitment)).toEqual(change.note);

    expect(prepared.spent.map((note) => note.amount)).toEqual([SOL]);
    const spentNullifier = noteNullifier(prepared.spent[0]!, prepared.spent[0]!.leafIndex, alice.privateKey);
    expect(prepared.publicInputs.inputNullifiers).toContain(spentNullifier);

    await submit(pool, prepared, relayer);
    expect(pool.balanceOf(relayer.publicKey)).toBe(FEE);
    const aliceAfter = await syncWallet(pool.connection, synced.state, alice, { tree: synced.tree });
    expect(balance(aliceAfter.state)).toBe(SOL - 300_000_000n - FEE);
    expect(aliceAfter.spent.map((note) => note.amount)).toEqual([SOL]);
    const bobAfter = await syncWallet(pool.connection, createWalletState(bob), bob);
    expect(balance(bobAfter.state)).toBe(300_000_000n);
    // The new notes sit at the positions the builder announced.
    expect(bobAfter.received[0]!.leafIndex).toBe(2 + toBob.position);
    expect(unspentNotes(aliceAfter.state)[0]!.leafIndex).toBe(2 + change.position);
  });

  it("spends two notes when one is not enough, and no change note when it comes out even", async () => {
    const { pool, synced } = await funded([400n, 700n + FEE]);
    const prepared = await prepareTransfer({ ...spend(synced), to: bob, amount: 1_100n });
    expect(prepared.spent).toHaveLength(2);
    expect(prepared.outputs.map((output) => output.note.amount).sort()).toEqual([0n, 1_100n]);
    // The padding note goes to the sender, still encrypted, indistinguishable from change.
    const padding = prepared.outputs.find((output) => output.note.amount === 0n)!;
    expect(padding.note.publicKey).toBe(alice.publicKey);
    expect(padding.encryptedOutput).toHaveLength(ENCRYPTED_NOTE_LENGTH);
    await submit(pool, prepared, relayer);
    const after = await syncWallet(pool.connection, synced.state, alice, { tree: synced.tree });
    expect(balance(after.state)).toBe(0n);
  });

  it("shuffles the inputs too", async () => {
    const { synced } = await funded([SOL]);
    const positions = new Set<number>();
    const real = unspentNotes(synced.state)[0]!.nullifier;
    for (let i = 0; i < 40; i++) {
      const prepared = await prepareTransfer({ ...spend(synced), to: bob, amount: 1n });
      positions.add(prepared.publicInputs.inputNullifiers.indexOf(real));
    }
    expect([...positions].sort()).toEqual([0, 1]);
  });

  it("can pay the sender's own address", async () => {
    const { pool, synced } = await funded([SOL]);
    const prepared = await prepareTransfer({ ...spend(synced), to: alice, amount: 1_000n });
    await submit(pool, prepared, relayer);
    const after = await syncWallet(pool.connection, synced.state, alice, { tree: synced.tree });
    expect(unspentNotes(after.state).map((note) => note.amount).sort()).toEqual([1_000n, SOL - 1_000n - FEE].sort());
  });

  it("reports insufficient balance and the need to consolidate as different errors", async () => {
    const { synced } = await funded([100_000n, 100_000n, 100_000n]);
    await expect(prepareTransfer({ ...spend(synced), to: bob, amount: 300_000n })).rejects.toBeInstanceOf(InsufficientBalanceError);
    const error = await prepareTransfer({ ...spend(synced), to: bob, amount: 250_000n }).catch((e) => e);
    expect(error).toBeInstanceOf(ConsolidationRequiredError);
    expect(error).toMatchObject({ required: 250_000n + FEE, available: 300_000n, largestPair: 200_000n });
  });

  it("rejects a bad address, a zero amount and a state that is not synced with the tree", async () => {
    const { synced } = await funded([SOL]);
    await expect(prepareTransfer({ ...spend(synced), to: "loch1qqqq", amount: 1n })).rejects.toMatchObject({ code: "INVALID_ADDRESS" });
    await expect(prepareTransfer({ ...spend(synced), to: bob, amount: 0n })).rejects.toThrow(/positive/);
    await expect(prepareTransfer({ ...spend(synced), tree: new MerkleTree(), to: bob, amount: 1n })).rejects.toMatchObject({ code: "STALE_STATE" });
    await expect(prepareTransfer({ ...spend(synced), keys: bob, to: bob, amount: 1n })).rejects.toThrow(/different key set/);
  });

  it("works without a cached tree by rebuilding it from the state", async () => {
    const { pool, synced } = await funded([SOL]);
    const prepared = await prepareTransfer({ ...spend(synced), tree: undefined, to: bob, amount: 5n });
    expect(prepared.publicInputs.root).toBe(pool.tree.root);
  });

  it("is rejected with UnknownRoot when the root is not one the program has", async () => {
    const { pool, synced } = await funded([SOL]);
    // A local tree that is ahead of (or forked from) the chain.
    const ahead = MerkleTree.fromLeaves(synced.tree.leaves);
    ahead.insert(123n);
    const state = { ...synced.state, leaves: [...synced.state.leaves, "123"] };
    const prepared = await prepareTransfer({ ...spend(synced), state, tree: ahead, to: bob, amount: 5n });
    const rejected = await submit(pool, prepared, relayer).catch((error) => error);
    expect(rejected).toBeInstanceOf(ProgramRejection);
    const parsed = parseProgramError({ err: pool.transactions.at(-1)!.err, logs: rejected.logs });
    expect(parsed).toBeInstanceOf(UnknownRootError);
    // The cure: sync and prepare again.
    const again = await prepareTransfer({ ...spend(synced), to: bob, amount: 5n });
    await expect(submit(pool, again, relayer)).resolves.toBeTypeOf("string");
  });

  it("is rejected as a double spend when a note is spent twice", async () => {
    const { pool, synced } = await funded([SOL]);
    const first = await prepareTransfer({ ...spend(synced), to: bob, amount: 5n });
    const second = await prepareTransfer({ ...spend(synced), to: bob, amount: 7n });
    await submit(pool, first, relayer);
    const rejected = await submit(pool, second, relayer).catch((error) => error);
    expect(parseProgramError(rejected.logs)).toMatchObject({ kind: "NullifierAlreadySpent" });
  });
});

describe("prepareWithdrawal", () => {
  const recipient = address("recipient");

  it("pays the recipient from the vault, the relayer its fee, and keeps the change shielded", async () => {
    const { pool, synced } = await funded([SOL]);
    const rent = await fetchRecipientRent(pool.connection, recipient);
    const prepared = await prepareWithdrawal({ ...spend(synced), recipient, amount: 200_000_000n, rent });
    const { extData } = prepared.args;
    expect(extData.extAmount).toBe(-200_000_000n);
    expect(extData.recipient.equals(recipient)).toBe(true);
    expect(extData.relayer.equals(relayer.publicKey)).toBe(true);
    expect(prepared.publicInputs.publicAmount).toBe(FIELD_MODULUS - 200_000_000n - FEE);
    expect(decodeTransactInstruction(prepared.instruction).accounts.signer.equals(relayer.publicKey)).toBe(true);
    expect(prepared.outputs.map((output) => output.note.amount).sort()).toEqual([0n, SOL - 200_000_000n - FEE].sort());
    expect(prepared.outputs.every((output) => output.note.publicKey === alice.publicKey)).toBe(true);

    await submit(pool, prepared, relayer);
    expect(pool.balanceOf(recipient)).toBe(200_000_000n);
    expect(pool.balanceOf(relayer.publicKey)).toBe(FEE);
    expect(pool.balanceOf(decodeTransactInstruction(prepared.instruction).accounts.vault)).toBe(SOL - 200_000_000n - FEE);
    const after = await syncWallet(pool.connection, synced.state, alice, { tree: synced.tree });
    expect(balance(after.state)).toBe(SOL - 200_000_000n - FEE);
  });

  it("can withdraw everything", async () => {
    const { pool, synced } = await funded([SOL]);
    const prepared = await prepareWithdrawal({ ...spend(synced), recipient, amount: SOL - FEE, rent: RENT });
    expect(prepared.outputs.map((output) => output.note.amount)).toEqual([0n, 0n]);
    await submit(pool, prepared, relayer);
    expect(balance((await syncWallet(pool.connection, synced.state, alice, { tree: synced.tree })).state)).toBe(0n);
  });

  it("refuses a withdrawal that would leave a new account below the rent-exempt minimum", async () => {
    const { synced } = await funded([SOL]);
    const prover = checkingProver();
    const error = await prepareWithdrawal({ ...spend(synced), prover, recipient, amount: 890_879n, rent: RENT }).catch((e) => e);
    expect(error).toBeInstanceOf(LochError);
    expect(error.code).toBe("RECIPIENT_BELOW_RENT_EXEMPT");
    expect(prover.inputs).toHaveLength(0);
    await expect(prepareWithdrawal({ ...spend(synced), recipient, amount: 890_880n, rent: RENT })).resolves.toBeDefined();
  });

  it("allows a small withdrawal to an account that is already funded", async () => {
    const { synced } = await funded([SOL]);
    const rent = { lamports: 2_000_000n, rentExemptMinimum: 890_880n };
    await expect(prepareWithdrawal({ ...spend(synced), recipient, amount: 1n, rent })).resolves.toBeDefined();
    const almost = { lamports: 890_000n, rentExemptMinimum: 890_880n };
    await expect(prepareWithdrawal({ ...spend(synced), recipient, amount: 879n, rent: almost })).rejects.toMatchObject({ code: "RECIPIENT_BELOW_RENT_EXEMPT" });
    await expect(prepareWithdrawal({ ...spend(synced), recipient, amount: 880n, rent: almost })).resolves.toBeDefined();
  });

  it("rejects a zero amount and too little balance", async () => {
    const { synced } = await funded([SOL]);
    await expect(prepareWithdrawal({ ...spend(synced), recipient, amount: 0n, rent: RENT })).rejects.toThrow(/between 1 and/);
    await expect(prepareWithdrawal({ ...spend(synced), recipient, amount: SOL, rent: RENT })).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it("needs no information about the recipient: without `rent` the amount must cover a new account's minimum", async () => {
    const { pool, synced } = await funded([SOL]);
    expect(SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM).toBe(890_880n);
    pool.calls.getAccountInfo = 0;
    const prover = checkingProver();
    const tooSmall = await prepareWithdrawal({ ...spend(synced), prover, recipient, amount: SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM - 1n }).catch((e) => e);
    expect(tooSmall).toMatchObject({ code: "RECIPIENT_BELOW_RENT_EXEMPT" });
    expect(tooSmall.message).toMatch(/does not exist yet/);
    expect(prover.inputs).toHaveLength(0);

    const prepared = await prepareWithdrawal({ ...spend(synced), recipient, amount: SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM });
    expect(prepared.args.extData.extAmount).toBe(-SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM);
    // The RPC was never asked about the destination (or anything else).
    expect(pool.calls.getAccountInfo).toBe(0);
    await submit(pool, prepared, relayer);
    expect(pool.balanceOf(recipient)).toBe(SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM);
  });

  it("refuses the pool's own accounts as recipient, before proving: the lamports could never be withdrawn again", async () => {
    const { synced } = await funded([SOL]);
    const prover = checkingProver();
    for (const account of [vaultPda(), treePda(), configPda()]) {
      const error = await prepareWithdrawal({ ...spend(synced), prover, recipient: account, amount: 100_000_000n }).catch((e) => e);
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(error.message).toMatch(/the recipient is one of the pool's own accounts/);
    }
    // The same for the account the fee is paid to.
    const fee = await prepareTransfer({ ...spend(synced), prover, relayer: vaultPda(), to: bob, amount: 5n }).catch((e) => e);
    expect(fee).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fee.message).toMatch(/the relayer is one of the pool's own accounts/);
    expect(prover.inputs).toHaveLength(0);
    // With a zero fee nothing is paid to the relayer account, so it is not restricted.
    await expect(prepareTransfer({ ...spend(synced), relayer: vaultPda(), fee: 0n, to: bob, amount: 5n })).resolves.toBeDefined();
  });
});

describe("the relayer's fee is capped by the caller", () => {
  it("a relayer that quotes most of the balance as its fee gets nothing: FeeTooHighError before proving", async () => {
    // The documented flow: the fee comes from the relayer's /v1/info, which any u64 passes.
    const { pool, synced } = await funded([10n * SOL]);
    const info = validateRelayerInfo({
      version: "0.1.0",
      cluster: "devnet",
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      programId: "Lochn2sJLT2hkqMrx85siFPXa9VUTAAx9EXmkPiJL2j",
      relayer: relayer.publicKey.toBase58(),
      feeLamports: "9990000000",
      computeUnitLimit: 300_000,
    });
    if (!info.ok) throw info.error;
    const quoted = BigInt(info.value.feeLamports);
    const prover = checkingProver();
    const context = { ...spend(synced), prover, fee: quoted, maxFee: 5_000_000n };

    for (const attempt of [
      prepareTransfer({ ...context, to: bob, amount: 10_000_000n }),
      prepareWithdrawal({ ...context, recipient: address("recipient"), amount: 10_000_000n }),
      prepareConsolidation(context),
    ]) {
      const error = await attempt.catch((e) => e);
      expect(error).toBeInstanceOf(FeeTooHighError);
      expect(error).toMatchObject({ code: "FEE_TOO_HIGH", fee: 9_990_000_000n, maxFee: 5_000_000n });
    }
    expect(prover.inputs).toHaveLength(0);
    expect(pool.balanceOf(relayer.publicKey)).toBe(0n);

    // At or below the cap the same call goes through and pays exactly the quoted fee.
    const fair = await prepareTransfer({ ...context, fee: 5_000_000n, to: bob, amount: 10_000_000n });
    expect(fair.args.extData.fee).toBe(5_000_000n);
    await submit(pool, fair, relayer);
    expect(pool.balanceOf(relayer.publicKey)).toBe(5_000_000n);
  });

  it("maxFee is not optional", async () => {
    const { synced } = await funded([SOL]);
    const { maxFee: _omitted, ...withoutCap } = spend(synced);
    const prover = checkingProver();
    const error = await prepareTransfer({ ...withoutCap, prover, to: bob, amount: 5n } as never).catch((e) => e);
    expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(error.message).toMatch(/maxFee is required/);
    await expect(prepareConsolidation({ ...withoutCap, prover, maxFee: -1n })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(prover.inputs).toHaveLength(0);
  });
});

describe("prepareConsolidation", () => {
  it("merges the two largest notes so that a payment needing three becomes possible", async () => {
    const { pool, synced } = await funded([100_000n, 300_000n, 200_000n]);
    const wanted = { to: bob, amount: 550_000n } as const;
    await expect(prepareTransfer({ ...spend(synced), ...wanted })).rejects.toBeInstanceOf(ConsolidationRequiredError);

    const consolidation = await prepareConsolidation(spend(synced));
    expect(consolidation.spent.map((note) => note.amount).sort()).toEqual([200_000n, 300_000n]);
    expect(consolidation.args.extData.extAmount).toBe(0n);
    expect(consolidation.outputs.map((output) => output.note.amount).sort()).toEqual([0n, 500_000n - FEE].sort());
    expect(consolidation.outputs.every((output) => output.note.publicKey === alice.publicKey)).toBe(true);
    await submit(pool, consolidation, relayer);

    const merged = await syncWallet(pool.connection, synced.state, alice, { tree: synced.tree });
    expect(unspentNotes(merged.state).map((note) => note.amount).sort()).toEqual([100_000n, 500_000n - FEE].sort());
    const payment = await prepareTransfer({ ...spend(merged), ...wanted });
    await submit(pool, payment, relayer);
    const done = await syncWallet(pool.connection, merged.state, alice, { tree: merged.tree });
    expect(balance(done.state)).toBe(600_000n - 550_000n - 2n * FEE);
    expect(balance((await syncWallet(pool.connection, createWalletState(bob), bob)).state)).toBe(550_000n);
  });

  it("needs two notes that cover the fee", async () => {
    await expect(prepareConsolidation(spend((await funded([SOL])).synced))).rejects.toThrow(/at least two/);
    await expect(prepareConsolidation(spend((await funded([1_000n, 2_000n])).synced))).rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});

describe("prepareTransact", () => {
  const common = {
    padding: alice,
    recipient: relayer.publicKey,
    relayer: relayer.publicKey,
    signer: relayer.publicKey,
  };

  async function oneNote() {
    const { pool, synced } = await funded([1_000_000n]);
    const [note] = unspentNotes(synced.state);
    const input = { note: note!, privateKey: alice.privateKey, leafIndex: note!.leafIndex, pathElements: synced.tree.path(note!.leafIndex).pathElements };
    return { pool, synced, input };
  }

  it("builds a custom transaction: one input split into two outputs for two recipients", async () => {
    const { pool, synced, input } = await oneNote();
    const prepared = await prepareTransact({
      ...common,
      prover: checkingProver(),
      root: synced.tree.root,
      inputs: [input],
      outputs: [{ amount: 600_000n, to: bob }, { amount: 400_000n - FEE, to: alice }],
      extAmount: 0n,
      fee: FEE,
    });
    await submit(pool, prepared, relayer);
    expect(balance((await syncWallet(pool.connection, createWalletState(bob), bob)).state)).toBe(600_000n);
  });

  it("accepts a zero-value transaction: two dummies in, two zero notes out", async () => {
    const pool = newPool();
    const prepared = await prepareTransact({ ...common, prover: checkingProver(), root: pool.tree.root, inputs: [], outputs: [], extAmount: 0n, fee: 0n });
    expect(prepared.publicInputs.publicAmount).toBe(0n);
    await expect(submit(pool, prepared, relayer)).resolves.toBeTypeOf("string");
  });

  it("refuses amounts that do not balance, before proving", async () => {
    const { synced, input } = await oneNote();
    const prover = checkingProver();
    const base = { ...common, prover, root: synced.tree.root, inputs: [input], extAmount: 0n, fee: FEE };
    await expect(prepareTransact({ ...base, outputs: [{ amount: 1_000_000n, to: bob }] })).rejects.toThrow(/do not balance/);
    await expect(prepareTransact({ ...base, outputs: [{ amount: 1_000_000n - FEE - 1n, to: bob }] })).rejects.toThrow(/do not balance/);
    await expect(prepareTransact({ ...base, outputs: [{ amount: -1n, to: bob }] })).rejects.toThrow(/output amount/);
    expect(prover.inputs).toHaveLength(0);
  });

  it("refuses an input the key does not own, or that is not under the root", async () => {
    const { synced, input } = await oneNote();
    const base = { ...common, prover: checkingProver(), outputs: [{ amount: 1_000_000n - FEE, to: bob }], extAmount: 0n, fee: FEE };
    await expect(prepareTransact({ ...base, root: synced.tree.root, inputs: [{ ...input, privateKey: bob.privateKey }] })).rejects.toThrow(/does not own/);
    await expect(prepareTransact({ ...base, root: 12345n, inputs: [input] })).rejects.toMatchObject({ code: "STALE_STATE" });
    await expect(prepareTransact({ ...base, root: synced.tree.root, inputs: [{ ...input, leafIndex: input.leafIndex ^ 1 }] })).rejects.toMatchObject({ code: "STALE_STATE" });
    await expect(prepareTransact({ ...base, root: synced.tree.root, inputs: [{ ...input, pathElements: input.pathElements.slice(1) }] })).rejects.toThrow(/20 elements/);
    await expect(prepareTransact({ ...base, root: FIELD_MODULUS, inputs: [input] })).rejects.toThrow(/root/);
  });

  it("refuses more than two inputs or outputs, and the same note twice", async () => {
    const { synced, input } = await oneNote();
    const base = { ...common, prover: checkingProver(), root: synced.tree.root, extAmount: 0n, fee: 0n };
    await expect(prepareTransact({ ...base, inputs: [input, input, input], outputs: [] })).rejects.toThrow(/at most two/);
    await expect(prepareTransact({ ...base, inputs: [], outputs: [{ amount: 0n, to: bob }, { amount: 0n, to: bob }, { amount: 0n, to: bob }] })).rejects.toThrow(/at most two/);
    await expect(prepareTransact({ ...base, inputs: [input, input], outputs: [{ amount: 2_000_000n, to: bob }] })).rejects.toThrow(/same note/);
  });

  it("requires the screener for a deposit", async () => {
    const pool = newPool();
    await expect(
      prepareTransact({ ...common, prover: checkingProver(), root: pool.tree.root, inputs: [], outputs: [{ amount: 5n, to: alice }], extAmount: 5n, fee: 0n }),
    ).rejects.toThrow(/screening authority/);
  });

  it("fails when the prover's public signals are not the transaction's (wrong artifacts)", async () => {
    const pool = newPool();
    const honest = checkingProver();
    const wrong = {
      async prove(input: Parameters<typeof honest.prove>[0]) {
        const result = await honest.prove(input);
        return { ...result, publicSignals: [...result.publicSignals.slice(0, 6), "1"] };
      },
    };
    await expect(
      prepareTransact({ ...common, prover: wrong, root: pool.tree.root, inputs: [], outputs: [], extAmount: 0n, fee: 0n }),
    ).rejects.toMatchObject({ code: "PROOF_FAILED" });
  });

  it("keeps secrets out of every error message", async () => {
    const { synced, input } = await oneNote();
    const secrets = [alice.privateKey.toString(), input.note.blinding.toString(), bob.privateKey.toString()];
    const attempts = [
      prepareTransact({ ...common, prover: checkingProver(), root: 5n, inputs: [input], outputs: [], extAmount: 0n, fee: 1_000_000n }),
      prepareTransact({ ...common, prover: checkingProver(), root: synced.tree.root, inputs: [{ ...input, privateKey: bob.privateKey }], outputs: [], extAmount: 0n, fee: 1_000_000n }),
      prepareTransact({ ...common, prover: checkingProver(), root: synced.tree.root, inputs: [input], outputs: [], extAmount: 0n, fee: 1n }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.catch((e) => e);
      expect(error).toBeInstanceOf(LochError);
      for (const secret of secrets) expect(String(error.message) + String(error.stack)).not.toContain(secret);
    }
  });
});

describe("createNote", () => {
  it("draws a fresh blinding for every note", () => {
    expect(createNote(1n, alice.publicKey).blinding).not.toBe(createNote(1n, alice.publicKey).blinding);
  });
});
