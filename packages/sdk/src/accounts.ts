// On-chain accounts of loch_pool: decoding and fetching.
//
// Every fetch here reads at `confirmed` unless told otherwise (DEFAULT_COMMITMENT),
// the same level sync uses. A `Connection` created without a commitment reads at
// `finalized`, about 13 seconds behind, and one created with `processed` can
// return state that is later dropped; neither is what a caller of these helpers
// expects, so they do not inherit the connection's setting.

import { PublicKey } from "@solana/web3.js";
import type { Commitment, Connection } from "@solana/web3.js";

import { ByteReader, bytesToBigIntBE, equalBytes } from "./bytes.js";
import { DEFAULT_COMMITMENT, MERKLE_TREE_DISCRIMINATOR, POOL_CONFIG_DISCRIMINATOR, PROGRAM_ID, TREE_DEPTH } from "./constants.js";
import { LochError } from "./errors.js";
import { type FieldLike, toField } from "./field.js";
import { configPda, nullifierPda, treePda } from "./pda.js";

/** The pool's `PoolConfig` account. */
export interface PoolConfig {
  /** May change screener, cap and pause. */
  admin: PublicKey;
  /** The screening authority that must co-sign every deposit. */
  screener: PublicKey;
  /** Largest deposit per transaction, in lamports. */
  maxDeposit: bigint;
  /** True while deposits are paused. Transfers and withdrawals are never paused. */
  paused: boolean;
  bump: number;
  vaultBump: number;
}

/** The pool's `MerkleTree` account. */
export interface TreeAccount {
  /** Number of leaves inserted so far; the index the next leaf gets. */
  nextIndex: number;
  /** Position of the newest root in `roots`. */
  currentRootIndex: number;
  /** The newest root: `roots[currentRootIndex]`. */
  root: bigint;
  filledSubtrees: bigint[];
  zeros: bigint[];
  /** The ring buffer of recent roots, one per transaction (unused slots are 0). A proof is accepted against any non-zero entry. */
  roots: bigint[];
}

/**
 * Decodes `PoolConfig`: 8-byte discriminator, admin (32), screener (32),
 * max_deposit (u64 LE), paused (1), bump (1), vault_bump (1).
 *
 * @throws LochError `DECODE_FAILED` on a wrong discriminator or short data.
 */
export function decodePoolConfig(data: Uint8Array): PoolConfig {
  if (data.length < 8 || !equalBytes(data.subarray(0, 8), POOL_CONFIG_DISCRIMINATOR)) {
    throw new LochError("DECODE_FAILED", "not a PoolConfig account");
  }
  try {
    const reader = new ByteReader(data.subarray(8));
    return {
      admin: new PublicKey(reader.take(32)),
      screener: new PublicKey(reader.take(32)),
      maxDeposit: reader.u64(),
      paused: reader.u8() !== 0,
      bump: reader.u8(),
      vaultBump: reader.u8(),
    };
  } catch (cause) {
    throw new LochError("DECODE_FAILED", "PoolConfig account data is too short", { cause });
  }
}

/**
 * Decodes the zero-copy `MerkleTree`: 8-byte discriminator, next_index (u64
 * LE), current_root_index (u64 LE), filled_subtrees (20 x 32), zeros
 * (20 x 32), then the root ring buffer (32 bytes per slot, 64 slots today; the
 * slot count is taken from the account size).
 *
 * @throws LochError `DECODE_FAILED` on a wrong discriminator or layout.
 */
export function decodeTreeAccount(data: Uint8Array): TreeAccount {
  if (data.length < 8 || !equalBytes(data.subarray(0, 8), MERKLE_TREE_DISCRIMINATOR)) {
    throw new LochError("DECODE_FAILED", "not a MerkleTree account");
  }
  try {
    const reader = new ByteReader(data.subarray(8));
    const nextIndex = reader.u64();
    const currentRootIndex = reader.u64();
    const words = (count: number) => Array.from({ length: count }, () => bytesToBigIntBE(reader.take(32)));
    const filledSubtrees = words(TREE_DEPTH);
    const zeros = words(TREE_DEPTH);
    if (reader.remaining === 0 || reader.remaining % 32 !== 0) throw new RangeError("root history has an unexpected size");
    const roots = words(reader.remaining / 32);
    const root = roots[Number(currentRootIndex)];
    if (root === undefined || nextIndex > BigInt(2 ** TREE_DEPTH)) throw new RangeError("index out of range");
    return { nextIndex: Number(nextIndex), currentRootIndex: Number(currentRootIndex), root, filledSubtrees, zeros, roots };
  } catch (cause) {
    throw new LochError("DECODE_FAILED", "MerkleTree account data has an unexpected layout", { cause });
  }
}

/** True when the program would accept a proof against `root` right now (`is_known_root`). */
export function isKnownRoot(tree: TreeAccount, root: bigint): boolean {
  return root !== 0n && tree.roots.includes(root);
}

async function fetchOwned(
  connection: Pick<Connection, "getAccountInfo">,
  address: PublicKey,
  programId: PublicKey,
  name: string,
  commitment: Commitment,
): Promise<Uint8Array> {
  const info = await connection.getAccountInfo(address, commitment);
  if (!info) throw new LochError("ACCOUNT_NOT_FOUND", `the pool's ${name} account does not exist: is the pool initialised on this cluster?`);
  if (!info.owner.equals(programId)) throw new LochError("ACCOUNT_NOT_FOUND", `the pool's ${name} account is not owned by the program`);
  return info.data;
}

/** Reads and decodes the pool configuration. Commitment defaults to `confirmed`. */
export async function fetchPoolConfig(
  connection: Pick<Connection, "getAccountInfo">,
  programId: PublicKey = PROGRAM_ID,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Promise<PoolConfig> {
  return decodePoolConfig(await fetchOwned(connection, configPda(programId), programId, "config", commitment));
}

/** Reads and decodes the on-chain Merkle tree (current root, next index, recent roots). Commitment defaults to `confirmed`. */
export async function fetchTreeAccount(
  connection: Pick<Connection, "getAccountInfo">,
  programId: PublicKey = PROGRAM_ID,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Promise<TreeAccount> {
  return decodeTreeAccount(await fetchOwned(connection, treePda(programId), programId, "tree", commitment));
}

const ACCOUNTS_PER_REQUEST = 100;

/**
 * For each nullifier, whether it has been spent: whether its PDA exists and is
 * owned by the program. Ownership matters, because anyone can send lamports to
 * a PDA address that was never created. One RPC call per 100 nullifiers.
 * Commitment defaults to `confirmed`.
 *
 * Privacy: this names the nullifier accounts to the RPC. A nullifier is secret
 * until its note is spent, so asking about the nullifiers of UNSPENT notes
 * tells the RPC which future spends belong to this client, and that they
 * belong together. `syncWallet` therefore does not use this: it finds spent
 * notes in the pool history it downloads anyway. Use this for nullifiers that
 * are public already, which is what a relayer does before it sends a
 * transaction. A wallet that wants to know whether its own transaction landed
 * should sync instead.
 */
export async function areNullifiersSpent(
  connection: Pick<Connection, "getMultipleAccountsInfo">,
  nullifiers: readonly FieldLike[],
  programId: PublicKey = PROGRAM_ID,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Promise<boolean[]> {
  const addresses = nullifiers.map((n) => nullifierPda(toField(n), programId));
  const spent: boolean[] = [];
  for (let i = 0; i < addresses.length; i += ACCOUNTS_PER_REQUEST) {
    const infos = await connection.getMultipleAccountsInfo(addresses.slice(i, i + ACCOUNTS_PER_REQUEST), commitment);
    for (const info of infos) spent.push(info !== null && info.owner.equals(programId));
  }
  return spent;
}

/** Whether one nullifier has been spent. See {@link areNullifiersSpent}, including its privacy note. */
export async function isNullifierSpent(
  connection: Pick<Connection, "getMultipleAccountsInfo">,
  nullifier: FieldLike,
  programId: PublicKey = PROGRAM_ID,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Promise<boolean> {
  return (await areNullifiersSpent(connection, [nullifier], programId, commitment))[0] === true;
}

/** What {@link fetchRecipientRent} returns and `prepareWithdrawal` can check. */
export interface RecipientRent {
  /** The recipient's current balance in lamports (0 if the account does not exist). */
  lamports: bigint;
  /** Rent-exempt minimum for the recipient's data size (a zero-data system account if it does not exist). */
  rentExemptMinimum: bigint;
}

/**
 * Reads what is needed to check exactly that a withdrawal will not fail for
 * rent: the recipient's balance and the rent-exempt minimum for its data size.
 * Two RPC calls. Commitment defaults to `confirmed`.
 *
 * Privacy: the RPC learns that this client is interested in `recipient`
 * before the withdrawal is public, which ties the client to the destination.
 * `prepareWithdrawal` does not need this: without `rent` it requires the
 * amount to cover the rent-exempt minimum of a new account, which names
 * nobody. Call this only when that is acceptable (a relayer checking a
 * request does), or when the recipient's balance is known from elsewhere,
 * for instance from the user's own wallet.
 */
export async function fetchRecipientRent(
  connection: Pick<Connection, "getAccountInfo" | "getMinimumBalanceForRentExemption">,
  recipient: PublicKey,
  commitment: Commitment = DEFAULT_COMMITMENT,
): Promise<RecipientRent> {
  const info = await connection.getAccountInfo(recipient, commitment);
  const minimum = await connection.getMinimumBalanceForRentExemption(info?.data.length ?? 0, commitment);
  return { lamports: BigInt(info?.lamports ?? 0), rentExemptMinimum: BigInt(minimum) };
}
