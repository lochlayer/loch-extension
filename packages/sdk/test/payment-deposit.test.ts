// A deposit that pays someone else (a pay link, a Blink): the payer needs no
// Loch keys, the note lands with the owner of the payment code, and the
// screening service sees an ordinary deposit.

import { describe, expect, it } from "vitest";

import {
  LochError,
  balance,
  buildTransactTransaction,
  createWalletState,
  encodePaymentCode,
  decodePaymentCode,
  fetchPoolConfig,
  issuePaymentCode,
  preparePaymentDeposit,
  syncWallet,
} from "../src/index.js";
import { inspectDepositTransaction } from "../src/wire.js";
import { checkingProver } from "./helpers/checkingProver.js";
import { FakePool } from "./helpers/fakePool.js";
import { SOL, lochKeys, wallet } from "./helpers/fixtures.js";

const bob = lochKeys("bob");
const alice = lochKeys("alice");
const payer = wallet("payer");
const screener = wallet("screener");
const BLOCKHASH = "11111111111111111111111111111111";

const newPool = () => new FakePool({ screener: screener.publicKey, maxDeposit: 10n * SOL });

describe("paying into the pool for someone", () => {
  it("lands with the owner of the payment code, keyed, and nowhere else", async () => {
    const pool = newPool();
    const issued = issuePaymentCode(createWalletState(bob), bob);
    // The code travels as text, as it would in a link.
    const code = decodePaymentCode(encodePaymentCode(issued.code));

    const prepared = await preparePaymentDeposit({
      prover: checkingProver(),
      to: code,
      amount: SOL / 10n,
      depositor: payer.publicKey,
      root: pool.tree.root,
      config: await fetchPoolConfig(pool.connection),
    });
    expect(prepared.args.extData.extAmount).toBe(SOL / 10n);
    expect(prepared.args.extData.fee).toBe(0n);
    for (const key of [prepared.args.extData.recipient, prepared.args.extData.relayer]) expect(key.equals(payer.publicKey)).toBe(true);
    // Both outputs belong to bob: the paid note and the zero-amount padding.
    expect(prepared.outputs.map((output) => output.note.publicKey)).toEqual([bob.publicKey, bob.publicKey]);

    const transaction = buildTransactTransaction({ instruction: prepared.instruction, payer: payer.publicKey, recentBlockhash: BLOCKHASH });
    // To the screening service this is an ordinary deposit by the payer.
    expect(inspectDepositTransaction(transaction, { screener: screener.publicKey }).ok).toBe(true);
    await pool.process(transaction);

    const received = await syncWallet(pool.connection, issued.state, bob);
    expect(balance(received.state)).toBe(SOL / 10n);
    expect(received.received.map((note) => note.source)).toContainEqual({ code: 0 });
    expect(received.state.paymentCodes).toEqual({ issued: 1, used: 1 });

    // Somebody else's wallet sees nothing of it.
    const other = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(balance(other.state)).toBe(0n);
  });

  it("pays a plain address too", async () => {
    const pool = newPool();
    const prepared = await preparePaymentDeposit({ prover: checkingProver(), to: bob, amount: 7n, depositor: payer.publicKey, root: pool.tree.root, config: await fetchPoolConfig(pool.connection) });
    await pool.process(buildTransactTransaction({ instruction: prepared.instruction, payer: payer.publicKey, recentBlockhash: BLOCKHASH }));
    expect(balance((await syncWallet(pool.connection, createWalletState(bob), bob)).state)).toBe(7n);
  });

  it("refuses what a deposit refuses", async () => {
    const pool = newPool();
    const config = await fetchPoolConfig(pool.connection);
    const base = { prover: checkingProver(), to: bob, depositor: payer.publicKey, root: pool.tree.root };
    await expect(preparePaymentDeposit({ ...base, amount: 0n, config })).rejects.toBeInstanceOf(LochError);
    await expect(preparePaymentDeposit({ ...base, amount: 11n * SOL, config })).rejects.toMatchObject({ code: "DEPOSIT_TOO_LARGE" });
    await expect(preparePaymentDeposit({ ...base, amount: SOL, config: { ...config, paused: true } })).rejects.toMatchObject({ code: "DEPOSITS_PAUSED" });
  });
});
