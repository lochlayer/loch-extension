// The v2 accounts of loch_pool: addresses, decoders, readers, and the
// instructions (docs/v2.md section 7). Account order is the program's
// (programs/loch_pool/src/v2.rs); an absent optional account is passed as the
// program id, Anchor's encoding of `None`.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { AccountMeta, Commitment, Connection } from "@solana/web3.js";

import { ByteReader, bytesToBigIntBE, bigIntToBytesLE, concatBytes, equalBytes } from "../bytes.js";
import { DEFAULT_COMMITMENT, PROGRAM_ID } from "../constants.js";
import { LochError } from "../errors.js";
import { type FieldLike, fieldToBytes, toField } from "../field.js";
import { toWeb3Buffer } from "../instruction.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID } from "./constants.js";
import {
  ASSET_ACCOUNT_DISCRIMINATOR,
  CONFIG_V2_ACCOUNT_DISCRIMINATOR,
  INITIALIZE_V2_DISCRIMINATOR,
  REGISTER_ASSET_DISCRIMINATOR,
  TREE_V2_ACCOUNT_DISCRIMINATOR,
  type TransactArgsV2,
  UPDATE_ASSET_DISCRIMINATOR,
  UPDATE_CONFIG_V2_DISCRIMINATOR,
  encodeSwapV2Data,
  encodeTransactV2Data,
} from "./codec.js";

const pda = (seeds: Uint8Array[], programId: PublicKey) => PublicKey.findProgramAddressSync(seeds.map(toWeb3Buffer), programId)[0];
const text = (s: string) => new TextEncoder().encode(s);

export const configV2Pda = (programId: PublicKey = PROGRAM_ID) => pda([text("config_v2")], programId);
export const treeV2Pda = (programId: PublicKey = PROGRAM_ID) => pda([text("tree_v2")], programId);
export const assetPda = (mint: PublicKey, programId: PublicKey = PROGRAM_ID) => pda([text("asset"), mint.toBytes()], programId);
export const vaultV2Pda = (mint: PublicKey, programId: PublicKey = PROGRAM_ID) => pda([text("vault_v2"), mint.toBytes()], programId);
export const vaultAuthorityPda = (programId: PublicKey = PROGRAM_ID) => pda([text("vault_authority_v2")], programId);
export const swapAuthorityPda = (programId: PublicKey = PROGRAM_ID) => pda([text("swap_authority")], programId);
export const eventAuthorityPda = (programId: PublicKey = PROGRAM_ID) => pda([text("__event_authority")], programId);
/** A swap's escrow for `mint`: a token account the swap creates and closes within itself. */
export const swapEscrowPda = (mint: PublicKey, programId: PublicKey = PROGRAM_ID) => pda([text("swap_escrow"), mint.toBytes()], programId);
export const nullifierV2Pda = (nullifier: FieldLike, programId: PublicKey = PROGRAM_ID) => pda([text("nullifier_v2"), fieldToBytes(toField(nullifier))], programId);

/**
 * The addresses of the v2 pool's lookup table (docs/v2.md section 10): the accounts every
 * deposit of `mints` names whoever makes it, so a version-0 deposit fits 1,232 bytes. The
 * table is frozen once written; a mint registered later needs a new table.
 */
export function lookupTableAddressesV2(mints: readonly PublicKey[], programId: PublicKey = PROGRAM_ID): PublicKey[] {
  const addresses = [configV2Pda(programId), treeV2Pda(programId), eventAuthorityPda(programId), SystemProgram.programId];
  if (mints.some((mint) => !mint.equals(NATIVE_MINT))) addresses.push(TOKEN_PROGRAM_ID);
  for (const mint of mints) addresses.push(assetPda(mint, programId), vaultV2Pda(mint, programId));
  return addresses;
}

/** The associated token account of `owner` for `mint` (SPL Token). */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** `CreateIdempotent` of the associated token account program: creates `owner`'s ATA for `mint` if it is missing. */
export function createAssociatedTokenAccountIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: toWeb3Buffer(Uint8Array.of(1)),
  });
}

// ---- accounts ----

/** The `PoolConfigV2` account. */
export interface PoolConfigV2 {
  admin: PublicKey;
  screener: PublicKey;
  router: PublicKey;
  paused: boolean;
}

/** The `AssetConfig` account of one mint. */
export interface AssetConfig {
  mint: PublicKey;
  assetId: bigint;
  maxDeposit: bigint;
  depositsEnabled: boolean;
  decimals: number;
}

/** What a client reads of the v2 tree. */
export interface TreeV2Account {
  nextIndex: number;
  currentRootIndex: number;
  /** The root history; unused slots are 0n. */
  roots: bigint[];
  /** The newest root. */
  root: bigint;
}

function expectDiscriminator(data: Uint8Array, discriminator: Uint8Array, what: string): ByteReader {
  if (data.length < 8 || !equalBytes(data.subarray(0, 8), discriminator)) throw new LochError("DECODE_FAILED", `not a ${what} account`);
  return new ByteReader(data.subarray(8));
}

export function decodePoolConfigV2(data: Uint8Array): PoolConfigV2 {
  try {
    const r = expectDiscriminator(data, CONFIG_V2_ACCOUNT_DISCRIMINATOR, "PoolConfigV2");
    return { admin: new PublicKey(r.take(32)), screener: new PublicKey(r.take(32)), router: new PublicKey(r.take(32)), paused: r.u8() === 1 };
  } catch (cause) {
    if (cause instanceof LochError) throw cause;
    throw new LochError("DECODE_FAILED", "malformed PoolConfigV2 account", { cause });
  }
}

export function decodeAssetConfig(data: Uint8Array): AssetConfig {
  try {
    const r = expectDiscriminator(data, ASSET_ACCOUNT_DISCRIMINATOR, "AssetConfig");
    const mint = new PublicKey(r.take(32));
    const assetId = bytesToBigIntBE(r.take(32));
    const maxDeposit = r.u64();
    const depositsEnabled = r.u8() === 1;
    const decimals = r.u8();
    return { mint, assetId, maxDeposit, depositsEnabled, decimals };
  } catch (cause) {
    if (cause instanceof LochError) throw cause;
    throw new LochError("DECODE_FAILED", "malformed AssetConfig account", { cause });
  }
}

const TREE_LEVELS_V2 = 26;
const ROOT_HISTORY_V2 = 64;

export function decodeTreeV2Account(data: Uint8Array): TreeV2Account {
  try {
    const r = expectDiscriminator(data, TREE_V2_ACCOUNT_DISCRIMINATOR, "MerkleTreeV2");
    const nextIndex = Number(r.u64());
    const currentRootIndex = Number(r.u64());
    r.take(32 * TREE_LEVELS_V2 * 2);
    const roots = Array.from({ length: ROOT_HISTORY_V2 }, () => bytesToBigIntBE(r.take(32)));
    if (currentRootIndex >= ROOT_HISTORY_V2) throw new RangeError("root index out of range");
    return { nextIndex, currentRootIndex, roots, root: roots[currentRootIndex]! };
  } catch (cause) {
    if (cause instanceof LochError) throw cause;
    throw new LochError("DECODE_FAILED", "malformed MerkleTreeV2 account", { cause });
  }
}

/** True when `root` is one the program still accepts. */
export function isKnownRootV2(tree: TreeV2Account, root: bigint): boolean {
  return root !== 0n && tree.roots.includes(root);
}

async function fetchData(connection: Pick<Connection, "getAccountInfo">, address: PublicKey, commitment: Commitment, what: string): Promise<Uint8Array> {
  const info = await connection.getAccountInfo(address, commitment);
  if (!info) throw new LochError("ACCOUNT_NOT_FOUND", `${what} does not exist: is the v2 pool initialised on this cluster?`);
  return new Uint8Array(info.data);
}

export async function fetchPoolConfigV2(connection: Pick<Connection, "getAccountInfo">, programId: PublicKey = PROGRAM_ID, commitment: Commitment = DEFAULT_COMMITMENT): Promise<PoolConfigV2> {
  return decodePoolConfigV2(await fetchData(connection, configV2Pda(programId), commitment, "the v2 pool configuration"));
}

export async function fetchTreeV2Account(connection: Pick<Connection, "getAccountInfo">, programId: PublicKey = PROGRAM_ID, commitment: Commitment = DEFAULT_COMMITMENT): Promise<TreeV2Account> {
  return decodeTreeV2Account(await fetchData(connection, treeV2Pda(programId), commitment, "the v2 tree"));
}

export async function fetchAssetConfig(connection: Pick<Connection, "getAccountInfo">, mint: PublicKey, programId: PublicKey = PROGRAM_ID, commitment: Commitment = DEFAULT_COMMITMENT): Promise<AssetConfig> {
  return decodeAssetConfig(await fetchData(connection, assetPda(mint, programId), commitment, `the asset account of ${mint.toBase58()}`));
}

// ---- instructions ----

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });

/** Who signs and what moves in a `transact_v2`. */
export interface TransactV2Accounts {
  /** Pays the nullifier rent (and, for a deposit, the deposit). */
  signer: PublicKey;
  /** The screening authority; a deposit only. */
  screener?: PublicKey | null;
  /**
   * A deposit of a token: the signer's token account it comes from. A
   * withdrawal: the destination (`ext_data.recipient`). Unused otherwise.
   */
  counterparty?: PublicKey | null;
  programId?: PublicKey;
}

/** The `transact_v2` instruction for `args`. */
export function buildTransactV2Instruction(args: TransactArgsV2, accounts: TransactV2Accounts): TransactionInstruction {
  const programId = accounts.programId ?? PROGRAM_ID;
  const absent = meta(programId);
  const { extAmount, asset } = args.extData;
  const moves = extAmount !== 0n;
  const native = asset.equals(NATIVE_MINT);
  const counterparty = extAmount < 0n ? args.extData.recipient : (accounts.counterparty ?? null);
  if (extAmount > 0n && !accounts.screener) throw new LochError("INVALID_ARGUMENT", "a deposit needs the screening authority");
  if (extAmount > 0n && !native && !counterparty) throw new LochError("INVALID_ARGUMENT", "a token deposit needs the source token account");
  const keys: AccountMeta[] = [
    meta(configV2Pda(programId)),
    meta(treeV2Pda(programId), true),
    meta(nullifierV2Pda(bytesToBigIntBE(args.inputNullifiers[0]), programId), true),
    meta(nullifierV2Pda(bytesToBigIntBE(args.inputNullifiers[1]), programId), true),
    moves ? meta(assetPda(asset, programId)) : absent,
    moves ? meta(vaultV2Pda(asset, programId), true) : absent,
    counterparty && moves ? meta(counterparty, true) : absent,
    moves && extAmount < 0n && !native ? meta(vaultAuthorityPda(programId)) : absent,
    extAmount > 0n ? meta(accounts.screener!, false, true) : absent,
    meta(accounts.signer, true, true),
    moves && !native ? meta(TOKEN_PROGRAM_ID) : absent,
    meta(SystemProgram.programId),
    meta(eventAuthorityPda(programId)),
    meta(programId),
  ];
  return new TransactionInstruction({ programId, keys, data: toWeb3Buffer(encodeTransactV2Data(args)) });
}

/** The accounts of a `swap_v2` besides the route. */
export interface SwapV2Accounts {
  signer: PublicKey;
  /** The pool's router (`PoolConfigV2.router`). */
  router: PublicKey;
  /**
   * The router's accounts, in the order its instruction lists them. The swap
   * authority among them is signed for by the program; the escrows
   * (`swapEscrowPda`) are its source and destination token accounts.
   */
  routeAccounts: readonly AccountMeta[];
  programId?: PublicKey;
}

/** The `swap_v2` instruction for `args` and the router's instruction data `route`. */
export function buildSwapV2Instruction(args: TransactArgsV2, route: Uint8Array, accounts: SwapV2Accounts): TransactionInstruction {
  const programId = accounts.programId ?? PROGRAM_ID;
  const swap = args.extData.swap;
  if (!swap) throw new LochError("INVALID_ARGUMENT", "a swap needs the swap part of the ext data");
  const inputMint = args.extData.asset;
  const outputMint = swap.outputMint;
  const authority = swapAuthorityPda(programId);
  // The swap authority signs inside the program, never in the transaction.
  const routeKeys = accounts.routeAccounts.map((account) => (account.pubkey.equals(authority) ? { ...account, isSigner: false } : account));
  const keys: AccountMeta[] = [
    meta(configV2Pda(programId)),
    meta(treeV2Pda(programId), true),
    meta(nullifierV2Pda(bytesToBigIntBE(args.inputNullifiers[0]), programId), true),
    meta(nullifierV2Pda(bytesToBigIntBE(args.inputNullifiers[1]), programId), true),
    meta(assetPda(inputMint, programId)),
    meta(vaultV2Pda(inputMint, programId), true),
    meta(assetPda(outputMint, programId)),
    meta(vaultV2Pda(outputMint, programId), true),
    meta(vaultAuthorityPda(programId)),
    meta(authority),
    meta(swapEscrowPda(inputMint, programId), true),
    meta(swapEscrowPda(outputMint, programId), true),
    meta(inputMint),
    meta(outputMint),
    meta(accounts.router),
    meta(accounts.signer, true, true),
    meta(TOKEN_PROGRAM_ID),
    meta(SystemProgram.programId),
    meta(eventAuthorityPda(programId)),
    meta(programId),
    ...routeKeys,
  ];
  return new TransactionInstruction({ programId, keys, data: toWeb3Buffer(encodeSwapV2Data(args, route)) });
}

/** The upgradeable loader's ProgramData address of `programId`. */
export function programDataAddress(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
}

/** `initialize_v2(screener, router)`, by the program's upgrade authority. */
export function buildInitializeV2Instruction(admin: PublicKey, screener: PublicKey, router: PublicKey, programId: PublicKey = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configV2Pda(programId), true),
      meta(treeV2Pda(programId), true),
      meta(admin, true, true),
      meta(SystemProgram.programId),
      meta(programId),
      meta(programDataAddress(programId)),
    ],
    data: toWeb3Buffer(concatBytes(INITIALIZE_V2_DISCRIMINATOR, screener.toBytes(), router.toBytes())),
  });
}

/** `register_asset(max_deposit)`, by the v2 admin. */
export function buildRegisterAssetInstruction(admin: PublicKey, mint: PublicKey, maxDeposit: bigint, programId: PublicKey = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configV2Pda(programId)),
      meta(mint),
      meta(assetPda(mint, programId), true),
      meta(vaultV2Pda(mint, programId), true),
      meta(admin, true, true),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    data: toWeb3Buffer(concatBytes(REGISTER_ASSET_DISCRIMINATOR, bigIntToBytesLE(maxDeposit, 8))),
  });
}

/** `update_asset(max_deposit, deposits_enabled)`, by the v2 admin. */
export function buildUpdateAssetInstruction(admin: PublicKey, mint: PublicKey, maxDeposit: bigint, depositsEnabled: boolean, programId: PublicKey = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [meta(configV2Pda(programId)), meta(assetPda(mint, programId), true), meta(admin, false, true)],
    data: toWeb3Buffer(concatBytes(UPDATE_ASSET_DISCRIMINATOR, bigIntToBytesLE(maxDeposit, 8), Uint8Array.of(depositsEnabled ? 1 : 0))),
  });
}

/** `update_config_v2(screener, router, paused)`, by the v2 admin. */
export function buildUpdateConfigV2Instruction(admin: PublicKey, screener: PublicKey, router: PublicKey, paused: boolean, programId: PublicKey = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [meta(configV2Pda(programId), true), meta(admin, false, true)],
    data: toWeb3Buffer(concatBytes(UPDATE_CONFIG_V2_DISCRIMINATOR, screener.toBytes(), router.toBytes(), Uint8Array.of(paused ? 1 : 0))),
  });
}
