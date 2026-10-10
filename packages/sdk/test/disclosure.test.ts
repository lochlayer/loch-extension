// Claim codes, viewing keys, payment receipts and source-of-funds reports,
// against the in-memory pool (helpers/fakePool.ts) with the prover that checks
// the circuit's constraints in plain JS.

import { type Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  AddressError,
  type LochKeys,
  LochError,
  type PreparedSpend,
  type PreparedTransact,
  type SyncResult,
  type TransactRecord,
  balance,
  buildSourceReport,
  buildTransactInstruction,
  buildTransactTransaction,
  claimKeys,
  claimNote,
  claimState,
  createClaimSecret,
  createWalletState,
  decodeClaim,
  decodeReceipt,
  decodeSourceReport,
  decodeViewingKey,
  encodeClaim,
  encodeReceipt,
  encodeShieldedAddress,
  encodeSourceReport,
  encodeViewingKey,
  fetchEvents,
  fetchPoolConfig,
  isClaim,
  isViewingKey,
  locateTransact,
  noteCommitment,
  nullifierOfOpening,
  prepareDeposit,
  prepareTransfer,
  prepareWithdrawal,
  syncWallet,
  verifyReceipt,
  verifySourceReport,
  viewNotes,
  viewingKeyOf,
} from "../src/index.js";
import { checkingProver } from "./helpers/checkingProver.js";
import { FakePool } from "./helpers/fakePool.js";
import { SOL, address, lochKeys, wallet } from "./helpers/fixtures.js";

const alice = lochKeys("alice");
const bob = lochKeys("bob");
const aliceWallet = wallet("alice");
const screener = wallet("screener");
const relayer = wallet("relayer");
const BLOCKHASH = "11111111111111111111111111111111";
const FEE = 5_000n;

const newPool = () => new FakePool({ screener: screener.publicKey, maxDeposit: 10n * SOL });

async function submit(pool: FakePool, prepared: PreparedTransact, payer: Keypair): Promise<string> {
  // A relayed call is signed by the relayer; the instruction is built for whoever pays.
  const instruction = payer === relayer ? buildTransactInstruction(prepared.args, { signer: relayer.publicKey }) : prepared.instruction;
  return pool.process(buildTransactTransaction({ instruction, payer: payer.publicKey, recentBlockhash: BLOCKHASH }));
}

const recordOf = (prepared: PreparedTransact, signature?: string): TransactRecord => ({
  ...(signature ? { signature } : {}),
  inputs: prepared.inputs,
  outputs: [prepared.outputs[0].commitment, prepared.outputs[1].commitment],
});

async function deposit(pool: FakePool, keys: LochKeys, amount: bigint): Promise<TransactRecord> {
  const prepared = await prepareDeposit({
    prover: checkingProver(),
    keys,
    root: pool.tree.root,
    amount,
    depositor: aliceWallet.publicKey,
    config: await fetchPoolConfig(pool.connection),
  });
  return recordOf(prepared, await submit(pool, prepared, aliceWallet));
}

const sync = (pool: FakePool, keys: LochKeys) => syncWallet(pool.connection, createWalletState(keys), keys);

const spend = (keys: LochKeys, synced: SyncResult) => ({
  prover: checkingProver(),
  keys,
  state: synced.state,
  tree: synced.tree,
  relayer: relayer.publicKey,
  fee: FEE,
  maxFee: FEE,
});

describe("claim codes", () => {
  it("round-trips, is 136 characters, and rejects what is not one", () => {
    const claim = { secret: createClaimSecret(), amount: 123_456_789n, blinding: (1n << 247n) + 5n, leafIndex: 1_048_575 };
    const text = encodeClaim(claim);
    expect(text).toHaveLength(136);
    expect(text.startsWith("lochclaim1")).toBe(true);
    expect(decodeClaim(text)).toEqual(claim);
    expect(decodeClaim(text.toUpperCase())).toEqual(claim);
    expect(isClaim(text)).toBe(true);
    expect(isClaim(encodeShieldedAddress(alice))).toBe(false);
    expect(() => decodeClaim(`${text.slice(0, -1)}${text.endsWith("q") ? "p" : "q"}`)).toThrow(AddressError);
    expect(() => encodeClaim({ ...claim, amount: 0n })).toThrow(LochError);
    expect(() => encodeClaim({ ...claim, secret: new Uint8Array(31) })).toThrow(LochError);
  });

  it("pays a claim, and the holder of the code collects it into a wallet of their own", async () => {
    const pool = newPool();
    await deposit(pool, alice, SOL);
    const secret = createClaimSecret();
    const keys = claimKeys(secret);
    // The payer puts the collection fee on top, so the recipient ends up with the round amount.
    const paid = await prepareTransfer({ ...spend(alice, await sync(pool, alice)), to: keys, amount: SOL / 4n + FEE });
    await submit(pool, paid, relayer);

    // The payer learns the leaf index from its own sync and writes the code.
    const payer = await sync(pool, alice);
    const sent = paid.outputs.find((output) => output.note.publicKey === keys.publicKey)!;
    const leafIndex = payer.state.leaves.indexOf(sent.commitment.toString());
    const code = encodeClaim({ secret, amount: sent.note.amount, blinding: sent.note.blinding, leafIndex });

    // The recipient has the code and the pool's leaves, nothing else.
    const claim = decodeClaim(code);
    const recipient = await sync(pool, bob);
    const state = claimState(claim, recipient.state.leaves);
    expect(balance(state)).toBe(SOL / 4n + FEE);
    const collected = await prepareTransfer({
      prover: checkingProver(),
      keys: claimKeys(claim.secret),
      state,
      relayer: relayer.publicKey,
      fee: FEE,
      maxFee: FEE,
      to: bob,
      amount: claim.amount - FEE,
    });
    await submit(pool, collected, relayer);
    expect(balance((await sync(pool, bob)).state)).toBe(SOL / 4n);

    // The code is spent: a second collection is a double spend.
    await expect(submit(pool, await prepareWithdrawal({ prover: checkingProver(), keys: claimKeys(claim.secret), state, relayer: relayer.publicKey, fee: FEE, maxFee: FEE, recipient: address("anyone"), amount: claim.amount - FEE }), relayer)).rejects.toThrow();
  });

  it("a claim key set finds its note by scanning, without the rest of the code", async () => {
    const pool = newPool();
    await deposit(pool, alice, SOL);
    const keys = claimKeys(createClaimSecret());
    await submit(pool, await prepareTransfer({ ...spend(alice, await sync(pool, alice)), to: keys, amount: 1_000_000n }), relayer);
    expect(balance((await sync(pool, keys)).state)).toBe(1_000_000n);
  });

  it("refuses leaves that do not hold the claim's note", async () => {
    const pool = newPool();
    await deposit(pool, alice, SOL);
    const { state } = await sync(pool, alice);
    const claim = { secret: createClaimSecret(), amount: 5n, blinding: 7n, leafIndex: 0 };
    expect(claimNote(claim).commitment).not.toBe(BigInt(state.leaves[0]!));
    expect(() => claimState(claim, state.leaves)).toThrow(/not in the tree/);
  });
});

describe("viewing key", () => {
  it("round-trips, is 220 characters, and holds no spending key", () => {
    const text = encodeViewingKey(viewingKeyOf(alice));
    expect(text).toHaveLength(220);
    expect(isViewingKey(text)).toBe(true);
    const decoded = decodeViewingKey(text);
    expect(decoded).toEqual(viewingKeyOf(alice));
    expect(Object.keys(decoded).sort()).toEqual(["encryptionSecret", "paymentCodeRoot", "publicKey", "selfNoteKey"]);
    expect(isViewingKey(encodeShieldedAddress(alice))).toBe(false);
  });

  it("reads deposits, change and payments from others, and nobody else's notes", async () => {
    const pool = newPool();
    await deposit(pool, alice, SOL);
    await deposit(pool, bob, 2n * SOL);
    await submit(pool, await prepareTransfer({ ...spend(bob, await sync(pool, bob)), to: alice, amount: SOL / 2n }), relayer);
    await submit(pool, await prepareWithdrawal({ ...spend(alice, await sync(pool, alice)), recipient: address("out"), amount: SOL / 10n }), relayer);

    const { events } = await fetchEvents(pool.connection);
    const seen = viewNotes(events, decodeViewingKey(encodeViewingKey(viewingKeyOf(alice))));
    expect(seen.map((note) => [note.amount, note.source])).toEqual([
      [SOL, "self"],
      [SOL / 2n, "address"],
      // The change of the withdrawal: the smaller note covered it.
      [SOL / 2n - SOL / 10n - FEE, "self"],
    ]);
    expect(seen.every((note) => typeof note.slot === "number")).toBe(true);
  });
});

describe("payment receipt", () => {
  async function paid() {
    const pool = newPool();
    await deposit(pool, alice, SOL);
    const prepared = await prepareTransfer({ ...spend(alice, await sync(pool, alice)), to: bob, amount: SOL / 4n });
    const signature = await submit(pool, prepared, relayer);
    const output = prepared.outputs.find((item) => item.note.publicKey === bob.publicKey)!;
    const receipt = { programId: pool.programId, nullifier: prepared.publicInputs.inputNullifiers[0], signature, recipient: bob, note: output.note };
    return { pool, prepared, signature, receipt, output };
  }

  it("checks out against the chain, with or without the transaction id", async () => {
    const { pool, receipt, signature, output } = await paid();
    const decoded = decodeReceipt(encodeReceipt(receipt));
    const result = await verifyReceipt(pool.connection, decoded);
    expect(result).toMatchObject({ ok: true, signature, amount: SOL / 4n, recipient: encodeShieldedAddress(bob), commitment: output.commitment });
    expect(result.ok && result.leafIndex).toBe((await sync(pool, bob)).state.notes[0]!.leafIndex);

    const { signature: _dropped, ...bare } = receipt;
    expect(await verifyReceipt(pool.connection, bare)).toMatchObject({ ok: true, signature });
    // A wrong id is only a hint that did not help.
    expect(await verifyReceipt(pool.connection, { ...receipt, signature: "5".repeat(88) })).toMatchObject({ ok: true, signature });
  });

  it("is rejected for another amount, another recipient or a transaction that did not pay it", async () => {
    const { pool, receipt } = await paid();
    expect(await verifyReceipt(pool.connection, { ...receipt, note: { ...receipt.note, amount: SOL } })).toMatchObject({ ok: false });
    expect(await verifyReceipt(pool.connection, { ...receipt, recipient: alice, note: { ...receipt.note, publicKey: alice.publicKey } })).toMatchObject({ ok: false });
    expect(await verifyReceipt(pool.connection, { ...receipt, nullifier: 12345n, signature: undefined })).toMatchObject({ ok: false });
    expect(() => encodeReceipt({ ...receipt, recipient: alice })).toThrow(/does not belong/);
  });

  it("does not decode anything else", () => {
    for (const text of ["", "{}", "[]", '{"loch":"receipt","version":2}', '{"loch":"source-report","version":1}']) {
      expect(() => decodeReceipt(text)).toThrow(LochError);
    }
  });
});

describe("source-of-funds report", () => {
  /** Alice deposits twice, pays Bob (which merges her notes), and withdraws from the change. */
  async function history() {
    const pool = newPool();
    const records: TransactRecord[] = [await deposit(pool, alice, SOL), await deposit(pool, alice, 2n * SOL)];
    const transfer = await prepareTransfer({ ...spend(alice, await sync(pool, alice)), to: bob, amount: 5n * (SOL / 2n) });
    records.push(recordOf(transfer, await submit(pool, transfer, relayer)));
    const withdrawal = await prepareWithdrawal({ ...spend(alice, await sync(pool, alice)), recipient: address("exchange"), amount: SOL / 4n });
    const signature = await submit(pool, withdrawal, relayer);
    return { pool, records, withdrawal: recordOf(withdrawal, signature), signature };
  }

  it("traces a withdrawal back to the deposits behind it", async () => {
    const { pool, records, withdrawal, signature } = await history();
    const report = decodeSourceReport(encodeSourceReport(buildSourceReport(withdrawal, records, pool.programId)));
    expect(report.history).toHaveLength(3);
    const result = await verifySourceReport(pool.connection, report);
    expect(result).toMatchObject({ ok: true, complete: true, transactions: 4, withdrawal: { signature, recipient: address("exchange").toBase58(), amount: SOL / 4n, fee: FEE } });
    if (!result.ok) throw new Error(result.problem);
    expect(result.origins.map((origin) => [origin.kind, origin.amount]).sort()).toEqual([
      ["deposit", SOL],
      ["deposit", 2n * SOL],
    ]);
    expect(result.origins.every((origin) => origin.kind === "deposit" && origin.depositor === aliceWallet.publicKey.toBase58())).toBe(true);
  });

  it("works without transaction ids: the nullifier records lead to the transactions", async () => {
    const { pool, records, withdrawal } = await history();
    const bare = ({ signature: _dropped, ...rest }: TransactRecord) => rest;
    const result = await verifySourceReport(pool.connection, buildSourceReport(bare(withdrawal), records.map(bare), pool.programId));
    expect(result).toMatchObject({ ok: true, complete: true });
  });

  it("names what it cannot trace: a note from someone else, a transaction left out", async () => {
    const { pool, records, withdrawal } = await history();
    // Without the first deposit, its note is an origin nobody accounts for.
    const partial = await verifySourceReport(pool.connection, buildSourceReport(withdrawal, records.slice(1), pool.programId));
    expect(partial).toMatchObject({ ok: true, complete: false });
    expect(partial.ok && partial.origins.map((origin) => [origin.kind, origin.amount]).sort()).toEqual([
      ["deposit", 2n * SOL],
      ["undisclosed", SOL],
    ]);

    // Bob withdraws what Alice paid him: his report ends at her note.
    const bobs = await prepareWithdrawal({ ...spend(bob, await sync(pool, bob)), recipient: address("bob-out"), amount: SOL });
    const signature = await submit(pool, bobs, relayer);
    const result = await verifySourceReport(pool.connection, buildSourceReport(recordOf(bobs, signature), [], pool.programId));
    expect(result).toMatchObject({ ok: true, complete: false, origins: [{ kind: "undisclosed", amount: 5n * (SOL / 2n) }] });
  });

  it("is rejected when an opening is not what the chain spent", async () => {
    const { pool, records, withdrawal } = await history();
    const report = buildSourceReport(withdrawal, records, pool.programId);
    const [first, second] = report.withdrawal.inputs;
    // Another amount gives another commitment, and so a nullifier the transaction does not have.
    const lied = { ...report, withdrawal: { ...report.withdrawal, inputs: [{ ...first, note: { ...first.note, amount: first.note.amount + 1n } }, second] as typeof report.withdrawal.inputs } };
    expect(await verifySourceReport(pool.connection, lied)).toMatchObject({ ok: false });
    // One input opened twice hides the other.
    expect(await verifySourceReport(pool.connection, { ...report, withdrawal: { ...report.withdrawal, inputs: [first, first] } })).toMatchObject({ ok: false });
    // A deposit is not a withdrawal.
    expect(await verifySourceReport(pool.connection, { ...report, withdrawal: records[0]! })).toMatchObject({ ok: false, problem: expect.stringContaining("not a withdrawal") });
  });

  it("an opened input hashes to its nullifier on chain, a dummy included", async () => {
    const { pool, withdrawal } = await history();
    for (const input of withdrawal.inputs) {
      const located = await locateTransact(pool.connection, nullifierOfOpening(input), { programId: pool.programId });
      expect(located?.signature).toBe(withdrawal.signature);
      expect(located?.signer?.equals(relayer.publicKey)).toBe(true);
    }
    expect(withdrawal.inputs.filter((input) => input.note.amount === 0n)).toHaveLength(1);
    expect(new PublicKey(pool.programId).equals(pool.programId)).toBe(true);
  });

  it("the prepared spend carries what the record needs", async () => {
    const pool = newPool();
    await deposit(pool, alice, SOL);
    const prepared: PreparedSpend = await prepareTransfer({ ...spend(alice, await sync(pool, alice)), to: bob, amount: 1_000n });
    expect(prepared.inputs.map(nullifierOfOpening)).toEqual(prepared.publicInputs.inputNullifiers);
    expect(prepared.outputs.map((output) => noteCommitment(output.note))).toEqual(prepared.publicInputs.outputCommitments);
  });
});
