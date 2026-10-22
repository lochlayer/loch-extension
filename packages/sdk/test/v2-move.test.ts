// The move (src/v2/move.ts): the transaction the SDK builds fits and passes its own
// inspection; every other shape is refused before a screening service or a relayer signs.

import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, type TransactArgs, buildTransactionV1, terminateProver } from "../src/index.js";
import { createNodeProverV2 } from "../src/node.js";
import { type TransactionV1, deserializeTransaction } from "../src/transactionV1.js";
import {
  type MoveTerms,
  type TransactArgsV2,
  NATIVE_MINT,
  buildMoveTransaction,
  inspectMoveTransaction,
  isMoveTransaction,
  keysV2FromSeed,
  moveInstructions,
  prepareDepositV2,
  validateMoveRequestV2,
} from "../src/v2/index.js";

const relayer = Keypair.generate();
const wallet = Keypair.generate();
const screener = Keypair.generate();
const keys = keysV2FromSeed(new Uint8Array(32).fill(7));
const BLOCKHASH = "11111111111111111111111111111111";
const AMOUNT = 1_500_000_000n;
const terms: MoveTerms = { refundLamports: 1_907_040n, minLamports: 10_000_000n, computeUnitLimit: 700_000, priorityFeeLamports: 700n };

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);
function withdrawal(overrides: Partial<TransactArgs["extData"]> = {}): TransactArgs {
  return {
    proof: { a: bytes(64, 1), b: bytes(128, 2), c: bytes(64, 3) },
    root: bytes(32, 4),
    inputNullifiers: [bytes(32, 5), bytes(32, 6)],
    outputCommitments: [bytes(32, 7), bytes(32, 8)],
    extData: { recipient: wallet.publicKey, relayer: relayer.publicKey, extAmount: -AMOUNT, fee: 0n, encryptedOutput0: bytes(87, 9), encryptedOutput1: bytes(87, 10), ...overrides },
  };
}

let deposit: TransactArgsV2;
beforeAll(async () => {
  const prover = await createNodeProverV2();
  deposit = (
    await prepareDepositV2({
      prover,
      keys,
      mint: NATIVE_MINT,
      amount: AMOUNT,
      depositor: wallet.publicKey,
      root: 0n,
      config: { screener: screener.publicKey, paused: false },
      asset: { mint: NATIVE_MINT, maxDeposit: 10n ** 12n, depositsEnabled: true },
      emptyPadding: true,
    })
  ).args;
});
afterAll(terminateProver);

const build = (out = withdrawal(), into = deposit) =>
  buildMoveTransaction({ withdrawal: out, deposit: into, relayer: relayer.publicKey, wallet: wallet.publicKey, screener: screener.publicKey, terms, recentBlockhash: BLOCKHASH });
const roundTrip = (tx: TransactionV1) => deserializeTransaction(tx.serialize()) as TransactionV1;
const why = (tx: TransactionV1) => {
  const result = inspectMoveTransaction(roundTrip(tx), { screener: screener.publicKey, relayer: relayer.publicKey });
  return result.ok ? "accepted" : result.error.message;
};
/** The same move with its instructions replaced: compiled again, so only what changed differs. */
function rebuilt(instructions: TransactionInstruction[]): TransactionV1 {
  return buildTransactionV1({ instructions, payer: relayer.publicKey, recentBlockhash: BLOCKHASH, computeUnitLimit: terms.computeUnitLimit, loadedAccountsDataSizeLimit: DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT });
}

describe("a move", () => {
  it("fits one version-1 transaction, signed by the relayer, the wallet and the screener in that order", () => {
    const tx = build();
    const size = tx.serialize().length;
    expect(size).toBeLessThan(4_096);
    expect(size).toBeGreaterThan(1_232);
    const signers = tx.message.staticAccountKeys.slice(0, 3).map((key) => key.toBase58());
    expect(signers).toEqual([relayer.publicKey.toBase58(), wallet.publicKey.toBase58(), screener.publicKey.toBase58()]);
    expect(isMoveTransaction(tx)).toBe(true);
    const result = inspectMoveTransaction(roundTrip(tx), { screener: screener.publicKey, relayer: relayer.publicKey });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.amount).toBe(AMOUNT);
    expect(result.value.refundLamports).toBe(terms.refundLamports);
    expect(result.value.fee).toBe(0n);
    expect(result.value.wallet.equals(wallet.publicKey)).toBe(true);
    expect(result.value.priorityFeeLamports).toBe(700n);
  });

  it("is refused by the builder when its halves do not match", () => {
    expect(() => build(withdrawal({ recipient: Keypair.generate().publicKey }))).toThrow(/wallet/);
    expect(() => build(withdrawal({ relayer: Keypair.generate().publicKey }))).toThrow(/relayer/);
    expect(() => build(withdrawal({ extAmount: -AMOUNT + 1n }))).toThrow(/exactly/);
    expect(() => build(withdrawal({ extAmount: AMOUNT }))).toThrow(/withdrawal/);
  });

  it("is refused for another fee payer or another screener", () => {
    const tx = roundTrip(build());
    expect(inspectMoveTransaction(tx, { screener: Keypair.generate().publicKey }).ok).toBe(false);
    expect(inspectMoveTransaction(tx, { screener: screener.publicKey, relayer: Keypair.generate().publicKey }).ok).toBe(false);
  });

  it("refuses an extra instruction, a transfer elsewhere, and instructions out of order", () => {
    const [out, refund, into] = moveInstructions({ withdrawal: withdrawal(), deposit, relayer: relayer.publicKey, wallet: wallet.publicKey, screener: screener.publicKey, refundLamports: terms.refundLamports });
    expect(why(rebuilt([out!, refund!, into!]))).toBe("accepted");
    const thief = Keypair.generate().publicKey;
    expect(why(rebuilt([out!, refund!, into!, SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: thief, lamports: 1_000_000 })]))).not.toBe("accepted");
    expect(why(rebuilt([out!, SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: thief, lamports: 1_907_040 }), into!]))).not.toBe("accepted");
    expect(why(rebuilt([into!, refund!, out!]))).not.toBe("accepted");
    const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("x") });
    expect(why(rebuilt([out!, refund!, into!, memo]))).not.toBe("accepted");
  });

  it("refuses an account swapped in a slot and a wallet assertion naming the screener; takes one naming the relayer", () => {
    const [out, refund, into] = moveInstructions({ withdrawal: withdrawal(), deposit, relayer: relayer.publicKey, wallet: wallet.publicKey, screener: screener.publicKey, refundLamports: terms.refundLamports });
    const swapped = new TransactionInstruction({ ...into!, keys: into!.keys.map((k, i) => (i === 5 ? { ...k, pubkey: Keypair.generate().publicKey } : k)) });
    expect(why(rebuilt([out!, refund!, swapped]))).toMatch(/slot 5/);
    const lighthouse = (pubkey: PublicKey) => new TransactionInstruction({ programId: new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"), keys: [{ pubkey, isSigner: false, isWritable: false }], data: Buffer.from([0]) });
    expect(why(rebuilt([out!, refund!, into!, lighthouse(screener.publicKey)]))).toMatch(/Lighthouse/);
    // Phantom asserts on the fee payer as well (the relayer), and on every account a move changes: more than a deposit's eight.
    expect(why(rebuilt([out!, refund!, into!, lighthouse(relayer.publicKey)]))).toBe("accepted");
    const many = [relayer.publicKey, wallet.publicKey, ...into!.keys.filter((key) => key.isWritable).map((key) => key.pubkey), ...out!.keys.filter((key) => key.isWritable).map((key) => key.pubkey)];
    expect(many.length).toBeGreaterThan(8);
    expect(why(rebuilt([out!, refund!, into!, ...many.map(lighthouse)]))).toBe("accepted");
    const own = new TransactionInstruction({ programId: new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"), keys: [{ pubkey: wallet.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([0]) });
    expect(why(rebuilt([out!, refund!, into!, own]))).toBe("accepted");
  });

  it("is sent as base64 of at most 4,096 bytes", () => {
    const transaction = Buffer.from(build().serialize()).toString("base64");
    expect(validateMoveRequestV2({ transaction, extra: 1 })).toEqual({ ok: true, value: { transaction } });
    expect(validateMoveRequestV2({ transaction: Buffer.alloc(5_000).toString("base64") }).ok).toBe(false);
    expect(validateMoveRequestV2({}).ok).toBe(false);
  });
});
