// The v2 pool of the mock cluster (docs/v2.md), for the extension's tests. It runs `transact_v2`
// and `swap_v2` the way programs/loch_pool/src/v2.rs does, minus the proof (every proof is
// accepted, as the v1 mock does without a verification key): the asset rule, the root history
// of a depth-26 tree with four leaves per transaction, the nullifier records, deposits under the
// screening authority's signature and the asset's cap, withdrawals, token accounts, and the
// event as an inner instruction (event CPI). A swap returns what `swapRates` says.
//
// Test code only.

import { FIELD_MODULUS, MerkleTree, PROGRAM_ID } from "@loch/sdk";
import {
  ASSET_ACCOUNT_DISCRIMINATOR,
  CONFIG_V2_ACCOUNT_DISCRIMINATOR,
  EVENT_IX_TAG,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TRANSACT_V2_EVENT_DISCRIMINATOR,
  TREE_V2_ACCOUNT_DISCRIMINATOR,
  type TransactArgsV2,
  assetId,
  assetPda,
  associatedTokenAddress,
  commitmentFromInner,
  configV2Pda,
  decodeV2Data,
  eventAuthorityPda,
  nullifierV2Pda,
  treeV2Pda,
  vaultAuthorityPda,
  vaultV2Pda,
} from "@loch/sdk/v2";
import { PublicKey } from "@solana/web3.js";

const ROOT_HISTORY = 64;
/** The far side of every swap: where a swap's input goes and its output comes from. */
export const MARKET = new PublicKey(new Uint8Array(32).fill(8));
export const TOKEN_ACCOUNT_RENT = 2_039_280n;
const NULLIFIER_RENT = 953_520n;

export interface MockAssetV2 {
  mint: string;
  decimals: number;
  maxDeposit: bigint;
  depositsEnabled: boolean;
}

export interface TokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
}

/** What the chain needs from the v2 pool's run of one instruction. */
export interface V2Context {
  keys: PublicKey[];
  signers: PublicKey[];
  accounts: readonly number[];
  data: Uint8Array;
  /** Moves lamports, or throws the failure the runtime would. */
  move(from: PublicKey, to: PublicKey, lamports: bigint): void;
  /** The failure of an Anchor error, with its log lines. */
  anchor(name: string, number: number): Error;
  /** "already in use", as the system program says it of a nullifier record. */
  spent(address: string): Error;
  logs: string[];
}

const u64le = (value: bigint) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};
const be32 = (value: bigint) => Buffer.from(value.toString(16).padStart(64, "0"), "hex");
const field = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
const vec = (bytes: Uint8Array) => Buffer.concat([Buffer.from(Uint32Array.of(bytes.length).buffer), Buffer.from(bytes)]);

export class MockPoolV2 {
  paused = false;
  readonly assets = new Map<string, MockAssetV2>();
  readonly tokens = new Map<string, TokenAccount>();
  readonly nullifiers = new Set<string>();
  /** Output units per input unit, as "in:out" -> [numerator, denominator]. */
  readonly swapRates = new Map<string, [bigint, bigint]>();
  private tree = new MerkleTree(26);
  private roots: bigint[] = new Array<bigint>(ROOT_HISTORY).fill(0n);
  private currentRootIndex = 0;

  constructor(
    public screener: PublicKey,
    public router: PublicKey,
  ) {
    this.roots[0] = this.tree.root;
    this.register({ mint: NATIVE_MINT.toBase58(), decimals: 9, maxDeposit: 10_000_000_000n, depositsEnabled: true });
  }

  register(asset: MockAssetV2): void {
    this.assets.set(asset.mint, asset);
    if (asset.mint !== NATIVE_MINT.toBase58()) this.tokens.set(vaultV2Pda(new PublicKey(asset.mint)).toBase58(), { mint: asset.mint, owner: vaultAuthorityPda().toBase58(), amount: 0n });
  }

  /** Gives `owner` an associated token account of `mint` holding `amount`. */
  mintTokens(owner: PublicKey, mint: PublicKey, amount: bigint): PublicKey {
    const ata = associatedTokenAddress(owner, mint);
    const existing = this.tokens.get(ata.toBase58());
    this.tokens.set(ata.toBase58(), { mint: mint.toBase58(), owner: owner.toBase58(), amount: (existing?.amount ?? 0n) + amount });
    return ata;
  }

  tokenBalance(account: PublicKey | string): bigint {
    return this.tokens.get(typeof account === "string" ? account : account.toBase58())?.amount ?? 0n;
  }

  get leafCount(): number {
    return this.tree.size;
  }

  /** Everything the pool holds, to put back after a failure or a simulation. */
  snapshot(): () => void {
    const tokens = new Map([...this.tokens].map(([key, value]) => [key, { ...value }]));
    const nullifiers = new Set(this.nullifiers);
    const size = this.tree.size;
    const roots = [...this.roots];
    const current = this.currentRootIndex;
    return () => {
      this.tokens.clear();
      for (const [key, value] of tokens) this.tokens.set(key, value);
      this.nullifiers.clear();
      for (const value of nullifiers) this.nullifiers.add(value);
      this.tree.truncate(size);
      this.roots = roots;
      this.currentRootIndex = current;
    };
  }

  /** `CreateIdempotent` of the associated token account program. */
  createAta(context: V2Context): void {
    const [payer, ata, owner, mint] = context.accounts.map((index) => context.keys[index]!);
    if (this.tokens.has(ata!.toBase58())) return;
    if (!associatedTokenAddress(owner!, mint!).equals(ata!)) throw context.anchor("InvalidSeeds", 0);
    context.move(payer!, ata!, TOKEN_ACCOUNT_RENT);
    this.tokens.set(ata!.toBase58(), { mint: mint!.toBase58(), owner: owner!.toBase58(), amount: 0n });
  }

  private moveTokens(context: V2Context, from: string, to: string, amount: bigint, mint: string): void {
    const source = this.tokens.get(from);
    const destination = this.tokens.get(to);
    if (!source || !destination || source.mint !== mint || destination.mint !== mint || source.amount < amount) throw context.anchor("TokenTransferFailed", 1);
    source.amount -= amount;
    destination.amount += amount;
  }

  /** Runs `transact_v2` or `swap_v2`. Returns the event-CPI instruction data. */
  run(context: V2Context): Uint8Array {
    const { keys, signers, accounts } = context;
    const at = (slot: number) => keys[accounts[slot]!]!;
    const decoded = decodeV2Data(context.data, { allowTrailingBytes: true });
    const args = decoded.args;
    const ext = args.extData;
    context.logs.push(`Program log: Instruction: ${decoded.kind === "swap" ? "SwapV2" : "TransactV2"}`);
    if ([args.root, ...args.inputNullifiers, ...args.outputCommitments].some((value) => field(value) >= FIELD_MODULUS)) throw context.anchor("NonCanonicalFieldElement", 6011);
    for (const nullifier of args.inputNullifiers) {
      const address = nullifierV2Pda(field(nullifier)).toBase58();
      if (this.nullifiers.has(address)) throw context.spent(address);
    }
    if (ext.encryptedOutputs.some((output) => output.length !== 0 && output.length !== 103)) throw context.anchor("InvalidEncryptedOutputLength", 6017);
    if ((ext.extAmount === 0n) !== ext.asset.equals(PublicKey.default)) throw context.anchor("AssetMismatch", 6018);
    if (!at(0).equals(configV2Pda()) || !at(1).equals(treeV2Pda())) throw context.anchor("ConstraintSeeds", 2006);
    const root = field(args.root);
    if (root === 0n || !this.roots.includes(root)) throw context.anchor("UnknownRoot", 6001);
    const signerSlot = decoded.kind === "swap" ? 15 : 9;
    const signer = at(signerSlot);
    if (!signers.some((key) => key.equals(signer))) throw context.anchor("MissingRequiredSignature", 0);
    for (const nullifier of args.inputNullifiers) {
      const record = nullifierV2Pda(field(nullifier));
      context.move(signer, record, NULLIFIER_RENT);
      this.nullifiers.add(record.toBase58());
    }

    let swapLeaf = 0n;
    let swapOutcome: Buffer | null = null;
    if (decoded.kind === "transact") {
      if (ext.swap) throw context.anchor("InvalidSwap", 6029);
      if (ext.extAmount === 0n) {
        if (!at(4).equals(PROGRAM_ID)) throw context.anchor("AssetMismatch", 6018);
      } else {
        const mint = ext.asset.toBase58();
        const asset = this.assets.get(mint);
        if (!asset || !at(4).equals(assetPda(ext.asset))) throw context.anchor("MissingAsset", 6019);
        const vault = vaultV2Pda(ext.asset);
        if (!at(5).equals(vault)) throw context.anchor("InvalidVault", 6021);
        const native = mint === NATIVE_MINT.toBase58();
        if (ext.extAmount > 0n) {
          if (this.paused) throw context.anchor("DepositsPaused", 6007);
          if (!asset.depositsEnabled) throw context.anchor("AssetDepositsDisabled", 6020);
          if (!at(8).equals(this.screener) || !signers.some((key) => key.equals(this.screener))) throw context.anchor("MissingScreenerSignature", 6005);
          if (ext.extAmount > asset.maxDeposit) throw context.anchor("DepositTooLarge", 6006);
          if (native) context.move(signer, vault, ext.extAmount);
          else {
            const source = this.tokens.get(at(6).toBase58());
            if (!source || source.owner !== signer.toBase58()) throw context.anchor("TokenTransferFailed", 1);
            this.moveTokens(context, at(6).toBase58(), vault.toBase58(), ext.extAmount, mint);
          }
        } else {
          if (!at(6).equals(ext.recipient)) throw context.anchor("RecipientMismatch", 6003);
          if (native) context.move(vault, at(6), -ext.extAmount);
          else this.moveTokens(context, vault.toBase58(), at(6).toBase58(), -ext.extAmount, mint);
        }
      }
    } else {
      const swap = ext.swap!;
      if (this.paused) throw context.anchor("DepositsPaused", 6007);
      if (ext.extAmount >= 0n) throw context.anchor("InvalidSwap", 6029);
      if (!at(14).equals(this.router)) throw context.anchor("InvalidRouter", 6025);
      const mintIn = ext.asset.toBase58();
      const mintOut = swap.outputMint.toBase58();
      const out = this.assets.get(mintOut);
      if (!this.assets.has(mintIn) || !out || mintIn === mintOut) throw context.anchor("AssetMismatch", 6018);
      if (!out.depositsEnabled) throw context.anchor("AssetDepositsDisabled", 6020);
      const amountIn = -ext.extAmount;
      const rate = this.swapRates.get(`${mintIn}:${mintOut}`);
      if (!rate) throw context.anchor("RouterFailed", 1);
      const amountOut = (amountIn * rate[0]) / rate[1];
      if (amountOut === 0n || amountOut < swap.minAmountOut) throw context.anchor("SwapOutputTooSmall", 6028);
      // The vaults: the input leaves, the output arrives.
      const vaultIn = vaultV2Pda(ext.asset);
      const vaultOut = vaultV2Pda(swap.outputMint);
      if (mintIn === NATIVE_MINT.toBase58()) context.move(vaultIn, MARKET, amountIn);
      else this.tokens.get(vaultIn.toBase58())!.amount -= amountIn;
      if (mintOut === NATIVE_MINT.toBase58()) context.move(MARKET, vaultOut, amountOut);
      else this.tokens.get(vaultOut.toBase58())!.amount += amountOut;
      swapLeaf = commitmentFromInner(assetId(swap.outputMint), amountOut, swap.inner);
      swapOutcome = Buffer.concat([Buffer.of(1), ext.asset.toBuffer(), swap.outputMint.toBuffer(), u64le(amountIn), u64le(amountOut), vec(swap.encryptedOutput)]);
    }

    const leaves = [...args.outputCommitments.map((commitment) => field(commitment)), swapLeaf];
    const first = this.tree.size;
    this.tree.append(leaves);
    this.currentRootIndex = (this.currentRootIndex + 1) % ROOT_HISTORY;
    this.roots[this.currentRootIndex] = this.tree.root;
    return Buffer.concat([
      Buffer.from(EVENT_IX_TAG),
      Buffer.from(TRANSACT_V2_EVENT_DISCRIMINATOR),
      u64le(BigInt(first)),
      ...leaves.map(be32),
      ...ext.encryptedOutputs.map(vec),
      ...args.inputNullifiers.map((nullifier) => Buffer.from(nullifier)),
      swapOutcome ?? Buffer.of(0),
    ]);
  }

  /** Account data the pool's accounts read as, or null. */
  accountData(address: string): { data: Buffer; owner: PublicKey; lamports: bigint } | null {
    if (address === configV2Pda().toBase58()) {
      const data = Buffer.alloc(8 + 32 * 3 + 4);
      Buffer.from(CONFIG_V2_ACCOUNT_DISCRIMINATOR).copy(data, 0);
      this.screener.toBuffer().copy(data, 40);
      this.router.toBuffer().copy(data, 72);
      data[104] = this.paused ? 1 : 0;
      return { data, owner: PROGRAM_ID, lamports: 2_000_000n };
    }
    if (address === treeV2Pda().toBase58()) {
      const zeros = Buffer.alloc(26 * 32);
      const data = Buffer.concat([Buffer.from(TREE_V2_ACCOUNT_DISCRIMINATOR), u64le(BigInt(this.tree.size)), u64le(BigInt(this.currentRootIndex)), zeros, zeros, ...this.roots.map(be32)]);
      return { data, owner: PROGRAM_ID, lamports: 30_000_000n };
    }
    for (const asset of this.assets.values()) {
      if (address !== assetPda(new PublicKey(asset.mint)).toBase58()) continue;
      const data = Buffer.alloc(8 + 32 + 32 + 8 + 4);
      Buffer.from(ASSET_ACCOUNT_DISCRIMINATOR).copy(data, 0);
      new PublicKey(asset.mint).toBuffer().copy(data, 8);
      Buffer.from(be32(assetId(new PublicKey(asset.mint)))).copy(data, 40);
      data.writeBigUInt64LE(asset.maxDeposit, 72);
      data[80] = asset.depositsEnabled ? 1 : 0;
      data[81] = asset.decimals;
      return { data, owner: PROGRAM_ID, lamports: 1_500_000n };
    }
    const token = this.tokens.get(address);
    if (token) {
      const data = Buffer.alloc(165);
      new PublicKey(token.mint).toBuffer().copy(data, 0);
      new PublicKey(token.owner).toBuffer().copy(data, 32);
      data.writeBigUInt64LE(token.amount, 64);
      data[108] = 1;
      return { data, owner: TOKEN_PROGRAM_ID, lamports: TOKEN_ACCOUNT_RENT };
    }
    return null;
  }

  /** The event authority, which the event-CPI instruction names. */
  static eventAuthority(): PublicKey {
    return eventAuthorityPda();
  }
}

export type { TransactArgsV2 };
