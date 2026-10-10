// Steps the flow tests share.

import { ed25519 } from "@noble/curves/ed25519";
import { applyScreenerSignature, buildTransactTransaction, deriveKeys, encodeShieldedAddress, fetchPoolConfig, fetchTreeAccount, keyDerivationMessage, prepareDeposit, toScreenRequest } from "@loch/sdk";
import { Keypair } from "@solana/web3.js";
import { expect } from "vitest";

import { chooseWallet, startDive, startUnlock } from "../src/background/flows.js";
import { type Harness, settle } from "./harness.js";

/** Connects the harness wallet for the first time and leaves it unlocked. */
export async function connect(h: Harness): Promise<void> {
  await startUnlock(h.core, null);
  const choosing = await settle(h);
  expect(choosing.step).toBe("choosing");
  await chooseWallet(h.core, h.wallet.name);
  const flow = await settle(h);
  expect(flow.failure).toBeUndefined();
  expect(flow.status).toBe("done");
  await h.core.clearFlow();
}

export function fund(h: Harness, lamports: bigint): void {
  h.chain.airdrop(h.wallet.address, lamports);
}

/** Dives in and waits for the deposit to be confirmed. */
export async function dive(h: Harness, lamports: bigint): Promise<void> {
  await startDive(h.core, lamports);
  const flow = await settle(h);
  expect(flow.failure).toBeUndefined();
  expect(flow.status).toBe("done");
  await h.core.clearFlow();
}

/** Someone else's shielded address. */
export function strangerAddress(): string {
  const keypair = Keypair.generate();
  const signature = ed25519.sign(keyDerivationMessage(), keypair.secretKey.slice(0, 32));
  return encodeShieldedAddress(deriveKeys(signature, keypair.publicKey.toBytes()));
}

export async function shielded(h: Harness) {
  const snapshot = await h.core.snapshot();
  if (!snapshot.shielded) throw new Error("the wallet is locked");
  return { ...snapshot.shielded, balance: BigInt(snapshot.shielded.balance), spendable: BigInt(snapshot.shielded.spendable) };
}

/**
 * Other people use the pool: `count` deposits from a wallet that is not the harness's. Each is
 * one pool transaction, so each pushes one root into the program's history of 64.
 */
export async function otherPoolTransactions(h: Harness, count: number): Promise<void> {
  const { chain } = await h.core.chain();
  const someone = Keypair.generate();
  h.chain.airdrop(someone.publicKey, BigInt(count + 1) * 10_000_000n);
  const keys = deriveKeys(ed25519.sign(keyDerivationMessage(), someone.secretKey.slice(0, 32)), someone.publicKey.toBytes());
  const config = await fetchPoolConfig(chain.connection);
  for (let i = 0; i < count; i++) {
    const tree = await fetchTreeAccount(chain.connection);
    const prepared = await prepareDeposit({ prover: h.env.prover, keys, root: tree.root, amount: 1_000_000n, depositor: someone.publicKey, config });
    const transaction = buildTransactTransaction({ instruction: prepared.instruction, payer: someone.publicKey, recentBlockhash: h.chain.newBlockhash().blockhash });
    const screened = await h.screener.handle("POST", "/v1/screen", toScreenRequest(transaction));
    applyScreenerSignature(transaction, screened.body as { signature: string; screener: string });
    transaction.sign([someone]);
    await h.chain.process(transaction.serialize());
  }
}
