// The v2 pool through the whole service worker: dive in SOL and a token, send, surface (a token
// one creates the recipient's token account), swap, move from the earlier pool, payment codes and
// viewing keys, against the mock cluster's v2 pool (e2e/mock/poolV2.ts).

import { ed25519 } from "@noble/curves/ed25519";
import { applyScreenerSignature, buildTransactionV1, keyDerivationMessage, toScreenRequest } from "@loch/sdk";
import {
  type FullViewingKey,
  NATIVE_MINT,
  assetTable,
  associatedTokenAddress,
  balancesV2,
  createWalletStateV2,
  decodeFullViewingKey,
  decodeIncomingViewingKey,
  decodePaymentCodeV2,
  deriveKeysV2,
  encodeAddressV2,
  fetchAssetConfig,
  fetchEventsV2,
  fetchPoolConfigV2,
  fetchTreeV2Account,
  mainAddress,
  preparePaymentDepositV2,
  syncWalletV2,
  vaultV2Pda,
  viewNotesV2,
} from "@loch/sdk/v2";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { handleUi } from "../src/background/router.js";
import { syncWalletNow } from "../src/background/sync.js";
import { GENESIS } from "../src/shared/constants.js";
import type { Quote, Snapshot } from "../src/shared/view.js";
import { MOVE_REFUND } from "../e2e/mock/services.js";
import { type Harness, createHarness, settle } from "./harness.js";
import { connect, dive, fund } from "./steps.js";

const SOL = 1_000_000_000n;
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NATIVE = NATIVE_MINT.toBase58();
const FEE = 2_500_000n;
const USDC_FEE = 100_000n;

function harness(): Harness {
  const h = createHarness({
    v2: { assets: [{ mint: USDC, decimals: 6, maxDeposit: 1_000_000_000n, depositsEnabled: true }] },
    feesV2: new Map([
      [NATIVE, FEE],
      [USDC, USDC_FEE],
    ]),
  });
  // Devnet, where the extension knows USDC.
  h.chain.genesisHash = GENESIS.devnet;
  h.chain.poolV2!.swapRates.set(`${NATIVE}:${USDC}`, [150n, 1_000n]); // 1 SOL = 150 USDC
  h.chain.poolV2!.swapRates.set(`${USDC}:${NATIVE}`, [1_000n, 150n]);
  return h;
}

async function ui(h: Harness, request: Record<string, unknown>): Promise<unknown> {
  const reply = await handleUi(h.core, { loch: "ui", ...request } as Parameters<typeof handleUi>[1]);
  if (!reply.ok) throw new Error(`${String(request.type)}: ${JSON.stringify(reply.error)}`);
  return reply.value;
}

async function snapshot(h: Harness): Promise<Snapshot> {
  return (await ui(h, { type: "state" })) as Snapshot;
}

async function run(h: Harness, request: Record<string, unknown>) {
  await ui(h, request);
  const flow = await settle(h);
  return flow;
}

async function done(h: Harness, request: Record<string, unknown>) {
  const flow = await run(h, request);
  expect(flow.failure).toBeUndefined();
  expect(flow.status).toBe("done");
  await h.core.clearFlow();
  return flow;
}

/** The active wallet's v2 balance of `mint`, as the interface shows it. */
async function balanceOf(h: Harness, mint: string): Promise<bigint> {
  await syncWalletNow(h.core, h.wallet.address);
  const view = await snapshot(h);
  return BigInt(view.loch2?.assets.find((asset) => asset.mint === mint)?.balance ?? "0");
}

/** Someone else's v2 address, and their keys to look for what they were sent. */
function stranger() {
  const keypair = Keypair.generate();
  const keys = deriveKeysV2(ed25519.sign(keyDerivationMessage(), keypair.secretKey.slice(0, 32)), keypair.publicKey.toBytes());
  return { keypair, keys, address: encodeAddressV2(mainAddress(keys)) };
}

async function ready(h: Harness): Promise<void> {
  await connect(h);
  fund(h, 20n * SOL);
}

/** What a set of keys holds in the v2 pool, by mint, as a fresh sync from nothing finds it. */
async function holdings(h: Harness, keys: FullViewingKey): Promise<Map<string, bigint>> {
  const { chain } = await h.core.chain();
  const assets = assetTable([NATIVE_MINT, new PublicKey(USDC)].map((mint) => ({ mint, symbol: "", decimals: 0 })));
  const result = await syncWalletV2(chain.connection, createWalletStateV2(keys), keys, assets);
  return balancesV2(result.state);
}

const usdcAccount = (owner: PublicKey | string) => associatedTokenAddress(new PublicKey(owner), new PublicKey(USDC));

describe("v2 pool", () => {
  it("a wallet on a cluster with the v2 pool gets a v2 address and SOL first", async () => {
    const h = harness();
    await ready(h);
    const view = await snapshot(h);
    expect(view.loch2?.address).toMatch(/^loch1/);
    expect(view.loch2?.assets[0]).toMatchObject({ mint: NATIVE, symbol: "SOL", balance: "0" });
    const quote = (await ui(h, { type: "quote", want: "spend" })) as Quote;
    expect(quote.v2?.relayer?.fees).toEqual({ [NATIVE]: FEE.toString(), [USDC]: USDC_FEE.toString() });
  });

  it("dives in SOL: a version 1 transaction, co-signed by the screening service", async () => {
    const h = harness();
    await ready(h);
    const before = h.chain.balance(h.wallet.address);
    await done(h, { type: "dive", amount: (2n * SOL).toString() });
    expect(h.chain.balance(vaultV2Pda(NATIVE_MINT))).toBeGreaterThanOrEqual(2n * SOL);
    expect(before - h.chain.balance(h.wallet.address)).toBeGreaterThan(2n * SOL);
    expect(h.screener.screened).toHaveLength(1);
    expect(h.screener.screened[0]!.message.version).toBe(1);
    expect(await balanceOf(h, NATIVE)).toBe(2n * SOL);
  });

  it("dives in a token from the wallet's token account", async () => {
    const h = harness();
    await ready(h);
    h.chain.poolV2!.mintTokens(new PublicKey(h.wallet.address), new PublicKey(USDC), 500_000_000n);
    await done(h, { type: "dive", amount: "200000000", mint: USDC });
    expect(h.chain.poolV2!.tokenBalance(usdcAccount(h.wallet.address))).toBe(300_000_000n);
    expect(h.chain.poolV2!.tokenBalance(vaultV2Pda(new PublicKey(USDC)))).toBe(200_000_000n);
    expect(await balanceOf(h, USDC)).toBe(200_000_000n);
    expect(await balanceOf(h, NATIVE)).toBe(0n);
  });

  it("a token dive asks for no more than the wallet's token account holds", async () => {
    const h = harness();
    await ready(h);
    h.chain.poolV2!.mintTokens(new PublicKey(h.wallet.address), new PublicKey(USDC), 1_000_000n);
    const flow = await run(h, { type: "dive", amount: "2000000", mint: USDC });
    expect(flow.failure?.code).toBe("insufficient-public");
    expect(h.wallet.prompts.filter((prompt) => prompt.kind === "signTransaction")).toHaveLength(0);
  });

  it("sends SOL privately: the recipient finds it, the relayer is paid with a note to its own address", async () => {
    const h = harness();
    await ready(h);
    await done(h, { type: "dive", amount: (2n * SOL).toString() });
    const someone = stranger();
    await done(h, { type: "send", to: someone.address, amount: SOL.toString(), fee: FEE.toString() });
    expect(await balanceOf(h, NATIVE)).toBe(SOL - FEE);
    expect((await holdings(h, someone.keys)).get(NATIVE)).toBe(SOL);
    expect((await holdings(h, h.relayer.keysV2)).get(NATIVE)).toBe(FEE);
    // Nothing public moved: the vault holds what was dived in.
    expect(h.chain.balance(vaultV2Pda(NATIVE_MINT))).toBeGreaterThanOrEqual(2n * SOL);
  });

  it("surfaces SOL to a public address", async () => {
    const h = harness();
    await ready(h);
    await done(h, { type: "dive", amount: (2n * SOL).toString() });
    const to = Keypair.generate().publicKey;
    await done(h, { type: "surface", to: to.toBase58(), amount: SOL.toString(), fee: FEE.toString() });
    expect(h.chain.balance(to)).toBe(SOL);
    expect(await balanceOf(h, NATIVE)).toBe(SOL - FEE);
  });

  it("surfaces a token to a wallet without a token account: the relayer creates it", async () => {
    const h = harness();
    await ready(h);
    h.chain.poolV2!.mintTokens(new PublicKey(h.wallet.address), new PublicKey(USDC), 500_000_000n);
    await done(h, { type: "dive", amount: "500000000", mint: USDC });
    const to = Keypair.generate().publicKey;
    await done(h, { type: "surface", to: to.toBase58(), amount: "100000000", fee: USDC_FEE.toString(), mint: USDC });
    expect(h.chain.poolV2!.tokenBalance(usdcAccount(to))).toBe(100_000_000n);
    expect(await balanceOf(h, USDC)).toBe(400_000_000n - USDC_FEE);
    expect((await holdings(h, h.relayer.keysV2)).get(USDC)).toBe(USDC_FEE);
  });

  it("swaps SOL for USDC inside the pool at the quoted price", async () => {
    const h = harness();
    await ready(h);
    await done(h, { type: "dive", amount: (2n * SOL).toString() });
    const quote = (await ui(h, { type: "swap-quote", from: NATIVE, to: USDC, amount: SOL.toString() })) as { amountOut: string };
    expect(quote.amountOut).toBe("150000000");
    const minOut = (BigInt(quote.amountOut) * 99n) / 100n;
    await done(h, { type: "swap", from: NATIVE, to: USDC, amount: SOL.toString(), minOut: minOut.toString(), fee: FEE.toString() });
    expect(await balanceOf(h, USDC)).toBe(150_000_000n);
    expect(await balanceOf(h, NATIVE)).toBe(SOL - FEE);
    // The swapped value left the SOL vault and arrived in the USDC vault.
    expect(h.chain.poolV2!.tokenBalance(vaultV2Pda(new PublicKey(USDC)))).toBe(150_000_000n);
    const view = await snapshot(h);
    expect(view.activity.some((entry) => entry.kind === "swap")).toBe(true);
  });

  it("a swap whose price moved below its minimum is not sent and costs nothing", async () => {
    const h = harness();
    await ready(h);
    await done(h, { type: "dive", amount: (2n * SOL).toString() });
    h.chain.poolV2!.swapRates.set(`${NATIVE}:${USDC}`, [100n, 1_000n]);
    const flow = await run(h, { type: "swap", from: NATIVE, to: USDC, amount: SOL.toString(), minOut: "148500000", fee: FEE.toString() });
    expect(flow.failure?.code).toBe("price-moved");
    expect(h.relayer.sent).toHaveLength(0);
    expect(h.chain.poolV2!.tokenBalance(vaultV2Pda(new PublicKey(USDC)))).toBe(0n);
    // The same flow goes on at the new price, with the same notes.
    const quote = (await ui(h, { type: "swap-quote", from: NATIVE, to: USDC, amount: SOL.toString() })) as { amountOut: string };
    expect(quote.amountOut).toBe("100000000");
    await ui(h, { type: "flow-retry", minOut: "99000000" });
    const again = await settle(h);
    expect(again.failure).toBeUndefined();
    expect(again.status).toBe("done");
    await h.core.clearFlow();
    expect(await balanceOf(h, USDC)).toBe(100_000_000n);
    expect(await balanceOf(h, NATIVE)).toBe(SOL - FEE);
  });

  it("a new minimum is only taken for a swap whose price moved", async () => {
    const h = harness();
    await ready(h);
    await done(h, { type: "dive", amount: (2n * SOL).toString() });
    h.relayer.feesV2.set(NATIVE, 3_000_000n);
    const flow = await run(h, { type: "send", to: stranger().address, amount: SOL.toString(), fee: FEE.toString() });
    expect(flow.failure?.code).toBe("fee-changed");
    const reply = await handleUi(h.core, { loch: "ui", type: "flow-retry", minOut: "1" });
    expect(reply.ok).toBe(false);
  });

  it("a relayer that does not take the asset is named before anything is proven", async () => {
    const h = harness();
    await ready(h);
    h.chain.poolV2!.mintTokens(new PublicKey(h.wallet.address), new PublicKey(USDC), 500_000_000n);
    await done(h, { type: "dive", amount: "500000000", mint: USDC });
    h.relayer.feesV2.delete(USDC);
    const proofs = h.prover.calls;
    const flow = await run(h, { type: "surface", to: Keypair.generate().publicKey.toBase58(), amount: "100000000", fee: USDC_FEE.toString(), mint: USDC });
    expect(flow.failure?.code).toBe("asset-not-taken");
    expect(h.prover.calls).toBe(proofs);
  });

  it("a payment code: a stranger's deposit to it is found, and the code says nothing of the main address", async () => {
    const h = harness();
    await ready(h);
    const made = (await ui(h, { type: "payment-code" })) as { status: string; code: string };
    expect(made.status).toBe("made");
    const view = await snapshot(h);
    expect(made.code.startsWith("lochpay1")).toBe(true);
    expect(made.code).not.toContain(view.loch2!.address.slice(5, 40));

    const { chain } = await h.core.chain();
    const payer = Keypair.generate();
    h.chain.airdrop(payer.publicKey, 2n * SOL);
    const [config, asset, tree] = await Promise.all([fetchPoolConfigV2(chain.connection), fetchAssetConfig(chain.connection, NATIVE_MINT), fetchTreeV2Account(chain.connection)]);
    const prepared = await preparePaymentDepositV2({ prover: h.env.proverV2, to: decodePaymentCodeV2(made.code), mint: NATIVE_MINT, amount: SOL / 2n, depositor: payer.publicKey, root: tree.root, config, asset });
    const transaction = buildTransactionV1({ instructions: [prepared.instruction], payer: payer.publicKey, recentBlockhash: h.chain.newBlockhash().blockhash, loadedAccountsDataSizeLimit: 128 * 1024 });
    const screened = await h.screener.handle("POST", "/v1/screen", toScreenRequest(transaction));
    expect(screened.status).toBe(200);
    applyScreenerSignature(transaction, screened.body as { signature: string; screener: string });
    transaction.sign([payer]);
    await h.chain.process(transaction.serialize());

    expect(await balanceOf(h, NATIVE)).toBe(SOL / 2n);
  });

  it("viewing keys: the full key sees what the wallet holds, the incoming key what it received", async () => {
    const h = harness();
    await ready(h);
    await done(h, { type: "dive", amount: (2n * SOL).toString() });
    const full = (await ui(h, { type: "viewing-key", which: "full" })) as { key: string };
    const incoming = (await ui(h, { type: "viewing-key", which: "incoming" })) as { key: string };
    const fvk = decodeFullViewingKey(full.key);
    expect((await holdings(h, fvk)).get(NATIVE)).toBe(2n * SOL);
    const ivk = decodeIncomingViewingKey(incoming.key);
    expect(ivk.ownerRoot).toBe(fvk.ownerRoot);
    expect(full.key).not.toBe(incoming.key);
    // Neither can spend: the spending key is not in either.
    expect(JSON.stringify(fvk, (_, value) => (typeof value === "bigint" ? value.toString() : value))).not.toContain("ask");

    // Read from the pool's events alone, as the verify page does: after a surface, the full key
    // sees the deposit spent and the change unspent; the incoming key sees both, and no spends.
    await done(h, { type: "surface", to: Keypair.generate().publicKey.toBase58(), amount: SOL.toString(), fee: FEE.toString() });
    const { chain } = await h.core.chain();
    const { events } = await fetchEventsV2(chain.connection);
    const assets = assetTable([{ mint: NATIVE_MINT, symbol: "SOL", decimals: 9 }]);
    const viewedFull = viewNotesV2(events, fvk, assets);
    expect(viewedFull.map((note) => [note.amount, note.spent])).toEqual([
      [2n * SOL, true],
      [SOL - FEE, false],
    ]);
    const viewedIncoming = viewNotesV2(events, ivk, assets);
    expect(viewedIncoming.map((note) => note.amount)).toEqual([2n * SOL, SOL - FEE]);
    expect(viewedIncoming.every((note) => note.spent === undefined)).toBe(true);
  });

  it("deposits paused on the v2 pool stop a dive before the wallet is asked", async () => {
    const h = harness();
    await ready(h);
    h.chain.poolV2!.paused = true;
    const flow = await run(h, { type: "dive", amount: SOL.toString() });
    expect(flow.failure?.code).toBe("deposits-paused");
    expect(h.wallet.prompts.filter((prompt) => prompt.kind === "signTransaction")).toHaveLength(0);
  });

  it("a wallet that signs version 0 only dives in with the v2 pool's lookup table", async () => {
    const h = harness();
    await ready(h);
    h.wallet.legacyOnly = true;
    h.wallet.lighthouse = true;
    await done(h, { type: "dive", amount: SOL.toString() });
    const screened = h.screener.screened.at(-1)!;
    expect(screened.message.version).toBe(0);
    expect(screened.message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58())).toEqual([h.screener.lookupTableV2!.toBase58()]);
    expect(screened.serialize().length).toBeLessThanOrEqual(1232);
    expect(await balanceOf(h, NATIVE)).toBe(SOL);
  });

  it("without the v2 table, a wallet that signs version 0 only cannot dive into the v2 pool", async () => {
    const h = harness();
    await ready(h);
    h.wallet.legacyOnly = true;
    h.screener.lookupTableV2 = null;
    const flow = await run(h, { type: "dive", amount: SOL.toString() });
    expect(flow.failure?.code).toBe("wallet-unsupported");
    expect(h.chain.balance(vaultV2Pda(NATIVE_MINT))).toBeLessThan(SOL);
  });
});

describe("moving from the earlier pool", () => {
  async function earlier(amount: bigint): Promise<Harness> {
    const h = createHarness();
    await ready(h);
    await dive(h, amount);
    h.chain.initializeV2({});
    await balanceOf(h, NATIVE);
    return h;
  }

  it("moves the earlier balance in one transaction the relayer pays for: the wallet ends where it started", async () => {
    const h = await earlier(2n * SOL);
    const wallet = h.chain.balance(h.wallet.address);
    const relayer = h.chain.balance(h.relayer.options.keypair.publicKey);
    const asked = h.wallet.prompts.length;
    const flow = await done(h, { type: "move" });
    expect(flow).toMatchObject({ move: true, amount: (2n * SOL).toString() });
    expect(h.chain.balance(h.wallet.address)).toBe(wallet);
    expect(await balanceOf(h, NATIVE)).toBe(2n * SOL);
    const view = await snapshot(h);
    expect(BigInt(view.shielded!.balance)).toBe(0n);
    // One transaction, approved once in the wallet as version 1, and the screener co-signed it.
    expect(h.relayer.sent).toHaveLength(1);
    const signed = h.wallet.prompts.slice(asked).filter((prompt) => prompt.kind === "signTransaction");
    expect(signed).toHaveLength(1);
    expect(h.screener.screened.at(-1)!.message.staticAccountKeys.slice(0, 3).map(String)).toEqual([h.relayer.options.keypair.publicKey.toBase58(), h.wallet.address, h.screener.options.keypair.publicKey.toBase58()]);
    // The relayer paid the network fee and the four nullifier records.
    expect(relayer - h.chain.balance(h.relayer.options.keypair.publicKey)).toBe(2n * MOVE_REFUND + 15_000n);
    expect(view.activity[0]).toMatchObject({ kind: "surface", move: true, amount: (2n * SOL).toString(), status: "confirmed" });
  });

  it("a move Phantom adds its assertion to, on the relayer as fee payer, goes through", async () => {
    const h = await earlier(SOL);
    h.wallet.lighthouse = true;
    const wallet = h.chain.balance(h.wallet.address);
    await done(h, { type: "move" });
    expect(h.chain.balance(h.wallet.address)).toBe(wallet);
    expect(await balanceOf(h, NATIVE)).toBe(SOL);
    const sent = h.screener.screened.at(-1)!;
    expect(sent.message.compiledInstructions.length).toBe(4);
  });

  it("a declined move gives the notes back, and a second try moves them", async () => {
    const h = await earlier(SOL);
    h.wallet.decisions.push("reject");
    const flow = await run(h, { type: "move" });
    expect(flow.failure?.code).toBe("wallet-rejected");
    let view = await snapshot(h);
    expect(view.shielded!.spendable).toBe(SOL.toString());
    await h.core.clearFlow();
    await done(h, { type: "move" });
    view = await snapshot(h);
    expect(BigInt(view.shielded!.balance)).toBe(0n);
    expect(await balanceOf(h, NATIVE)).toBe(SOL);
  });

  it("a wallet that signs version 0 only is told it cannot move, and keeps its notes", async () => {
    const h = await earlier(SOL);
    h.wallet.legacyOnly = true;
    const flow = await run(h, { type: "move" });
    expect(flow.failure?.code).toBe("move-wallet");
    expect((await snapshot(h)).shielded!.spendable).toBe(SOL.toString());
    expect(h.relayer.sent).toHaveLength(0);
  });

  it("a relayer that does not pay for moves is named before anything is proven", async () => {
    const h = await earlier(SOL);
    h.relayer.moves = false;
    const asked = h.wallet.prompts.length;
    const flow = await run(h, { type: "move" });
    expect(flow.failure?.code).toBe("move-unavailable");
    expect(h.wallet.prompts.length).toBe(asked);
  });

  it("surfaces the v1 balance to the wallet, then dives it into v2", async () => {
    const h = createHarness();
    await ready(h);
    await dive(h, 2n * SOL);
    h.chain.initializeV2({});
    await balanceOf(h, NATIVE);
    const view = await snapshot(h);
    expect(view.loch2).not.toBeNull();
    expect(BigInt(view.shielded!.balance)).toBe(2n * SOL);

    const wallet = h.chain.balance(h.wallet.address);
    await done(h, { type: "surface", pool: 1, to: h.wallet.address, amount: (SOL + SOL / 2n).toString(), fee: FEE.toString() });
    expect(h.chain.balance(h.wallet.address) - wallet).toBe(SOL + SOL / 2n);
    await done(h, { type: "dive", amount: (SOL + SOL / 2n).toString() });
    expect(await balanceOf(h, NATIVE)).toBe(SOL + SOL / 2n);
    expect(BigInt((await snapshot(h)).shielded!.balance)).toBe(2n * SOL - SOL - SOL / 2n - FEE);
  });
});
