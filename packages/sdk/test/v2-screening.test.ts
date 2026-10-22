// What a screening service accepts as a v2 deposit (src/v2/screening.ts): a real deposit
// built by the SDK passes; every other shape is refused before anything is signed.

import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, buildTransactionV1, terminateProver } from "../src/index.js";
import { createNodeProverV2 } from "../src/node.js";
import { type TransactionV1, deserializeTransaction } from "../src/transactionV1.js";
import { NATIVE_MINT, inspectDepositTransactionV2, keysV2FromSeed, prepareDepositV2 } from "../src/v2/index.js";

const screener = Keypair.generate().publicKey;
const depositor = Keypair.generate().publicKey;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const keys = keysV2FromSeed(new Uint8Array(32).fill(5));
const BLOCKHASH = "11111111111111111111111111111111";

let prover: Awaited<ReturnType<typeof createNodeProverV2>>;
let solDeposit: TransactionInstruction;
let tokenDeposit: TransactionInstruction;
const source = Keypair.generate().publicKey;

beforeAll(async () => {
  prover = await createNodeProverV2();
  const common = { prover, keys, depositor, root: 0n, config: { screener, paused: false } };
  solDeposit = (await prepareDepositV2({ ...common, mint: NATIVE_MINT, amount: 1_000_000_000n, asset: { mint: NATIVE_MINT, maxDeposit: 10n ** 12n, depositsEnabled: true } })).instruction;
  tokenDeposit = (await prepareDepositV2({ ...common, mint: USDC, amount: 5_000_000n, source, asset: { mint: USDC, maxDeposit: 10n ** 12n, depositsEnabled: true } })).instruction;
});
afterAll(terminateProver);

function v1(instructions: TransactionInstruction[], payer = depositor): TransactionV1 {
  const tx = buildTransactionV1({ instructions, payer, recentBlockhash: BLOCKHASH, loadedAccountsDataSizeLimit: DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT });
  return deserializeTransaction(tx.serialize()) as TransactionV1;
}

const inspect = (tx: TransactionV1) => inspectDepositTransactionV2(tx, { screener });
const why = (tx: TransactionV1) => {
  const result = inspect(tx);
  return result.ok ? "accepted" : result.error.message;
};

describe("v2 deposit inspection", () => {
  it("accepts a SOL deposit and a token deposit as the SDK builds them", () => {
    const sol = inspect(v1([solDeposit]));
    expect(sol.ok && sol.value.mint.equals(NATIVE_MINT) && sol.value.amount).toBe(1_000_000_000n);
    expect(sol.ok && sol.value.source).toBeNull();
    const token = inspect(v1([tokenDeposit]));
    expect(token.ok && token.value.source?.equals(source)).toBe(true);
    expect(token.ok && token.value.amount).toBe(5_000_000n);
  });

  it("refuses another instruction, another screener, a screener in another slot, a wrong vault", () => {
    expect(why(v1([solDeposit, SystemProgram.transfer({ fromPubkey: depositor, toPubkey: screener, lamports: 1 })]))).not.toBe("accepted");
    const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("x") });
    expect(why(v1([solDeposit, memo]))).toMatch(/another program/);
    expect(inspectDepositTransactionV2(v1([solDeposit]), { screener: Keypair.generate().publicKey }).ok).toBe(false);
    const swapped = new TransactionInstruction({ ...solDeposit, keys: solDeposit.keys.map((k, i) => (i === 6 ? { pubkey: screener, isSigner: false, isWritable: true } : k)) });
    expect(why(v1([swapped]))).not.toBe("accepted");
    const wrongVault = new TransactionInstruction({ ...tokenDeposit, keys: tokenDeposit.keys.map((k, i) => (i === 5 ? { ...k, pubkey: Keypair.generate().publicKey } : k)) });
    expect(why(v1([wrongVault]))).toMatch(/account 5/);
  });

  it("refuses a deposit whose source is the depositor itself, and a deposit signed by someone else", () => {
    const self = new TransactionInstruction({ ...tokenDeposit, keys: tokenDeposit.keys.map((k, i) => (i === 6 ? { ...k, pubkey: depositor } : k)) });
    expect(why(v1([self]))).not.toBe("accepted");
    expect(why(v1([solDeposit], Keypair.generate().publicKey))).not.toBe("accepted");
  });
});
