// The `transact` instruction: building it and reading one somebody else built.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { bytesToBigIntBE, copyBytes } from "./bytes.js";
import { type TransactArgs, decodeTransactArgs, encodeTransactArgs } from "./codec.js";
import { FIELD_MODULUS, PROGRAM_ID } from "./constants.js";
import { LochError } from "./errors.js";
import { configPda, nullifierPda, treePda, vaultPda } from "./pda.js";

/** The accounts of `transact`, by name, in the order the program declares them. */
export interface TransactAccounts {
  /** `["config"]` PDA, read-only. */
  config: PublicKey;
  /** `["tree"]` PDA, writable. */
  tree: PublicKey;
  /** `["vault"]` PDA, writable. */
  vault: PublicKey;
  /** `["nullifier", inputNullifiers[0]]` PDA, writable, created by the instruction. */
  nullifier0: PublicKey;
  /** `["nullifier", inputNullifiers[1]]` PDA, writable, created by the instruction. */
  nullifier1: PublicKey;
  /** Writable; must equal `extData.recipient`. */
  recipient: PublicKey;
  /** Writable; must equal `extData.relayer`. */
  relayer: PublicKey;
  /** The screening authority (a signer), or null when the slot holds the program id (no screener). */
  screener: PublicKey | null;
  /** Writable signer that pays the nullifier rent and, on a deposit, the deposit itself. */
  signer: PublicKey;
  /** The system program. */
  systemProgram: PublicKey;
}

/** A decoded `transact` instruction. */
export interface DecodedTransact {
  /** Program the instruction is addressed to. */
  programId: PublicKey;
  args: TransactArgs;
  accounts: TransactAccounts;
}

/** An instruction inside a compiled message (`MessageV0.compiledInstructions[i]`). */
export interface CompiledInstructionLike {
  programIdIndex: number;
  accountKeyIndexes: readonly number[];
  data: Uint8Array;
}

/** Accounts {@link buildTransactInstruction} cannot derive from the arguments. */
export interface TransactSigners {
  /** Pays nullifier rent (and the deposit). The depositor for deposits, the relayer otherwise. */
  signer: PublicKey;
  /** The screening authority; required for deposits, omitted otherwise. */
  screener?: PublicKey | null;
  /** Defaults to {@link PROGRAM_ID}. */
  programId?: PublicKey;
}

type Web3Buffer = ReturnType<PublicKey["toBuffer"]>;

/**
 * web3.js types instruction data as `Buffer`. This borrows the Buffer class
 * web3.js itself uses (Node's own in Node, the `buffer` package in a browser
 * bundle), so the SDK never touches a `Buffer` global and callers still get a
 * real Buffer.
 */
function toWeb3Buffer(bytes: Uint8Array): Web3Buffer {
  const ctor = PublicKey.default.toBuffer().constructor as unknown as { from(source: Uint8Array): Web3Buffer };
  return ctor.from(bytes);
}

/**
 * Builds the `transact` instruction. Recipient and relayer are taken from
 * `args.extData` (the program requires them to match), the PDAs are derived,
 * and a missing screener is passed as the program id, which is how Anchor
 * encodes an absent optional account.
 */
export function buildTransactInstruction(args: TransactArgs, signers: TransactSigners): TransactionInstruction {
  const programId = signers.programId ?? PROGRAM_ID;
  const screener = signers.screener ?? null;
  const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return new TransactionInstruction({
    programId,
    keys: [
      meta(configPda(programId), false),
      meta(treePda(programId), true),
      meta(vaultPda(programId), true),
      meta(nullifierPda(args.inputNullifiers[0], programId), true),
      meta(nullifierPda(args.inputNullifiers[1], programId), true),
      meta(args.extData.recipient, true),
      meta(args.extData.relayer, true),
      screener ? meta(screener, false, true) : meta(programId, false),
      meta(signers.signer, true, true),
      meta(SystemProgram.programId, false),
    ],
    data: toWeb3Buffer(encodeTransactArgs(args)),
  });
}

/**
 * Decodes a `transact` instruction someone else built: the arguments and the
 * accounts by name. Accepts a `TransactionInstruction`, or a compiled
 * instruction together with the message's account keys (static keys followed
 * by any keys loaded from lookup tables).
 *
 * Decoding is structural only. Call {@link transactAccountsProblem} to check
 * that the accounts are the ones the program will accept.
 *
 * @throws LochError `DECODE_FAILED` if the data is not a `transact` call, has
 *   trailing bytes, or the instruction does not list exactly ten accounts.
 */
export function decodeTransactInstruction(instruction: TransactionInstruction): DecodedTransact;
export function decodeTransactInstruction(instruction: CompiledInstructionLike, accountKeys: readonly PublicKey[]): DecodedTransact;
export function decodeTransactInstruction(
  instruction: TransactionInstruction | CompiledInstructionLike,
  accountKeys?: readonly PublicKey[],
): DecodedTransact {
  let programId: PublicKey;
  let keys: PublicKey[];
  if ("programIdIndex" in instruction) {
    if (!accountKeys) throw new LochError("INVALID_ARGUMENT", "a compiled instruction needs the message's account keys");
    const at = (index: number): PublicKey => {
      const key = accountKeys[index];
      if (!key) throw new LochError("DECODE_FAILED", "the instruction refers to an account the message does not have");
      return key;
    };
    programId = at(instruction.programIdIndex);
    keys = instruction.accountKeyIndexes.map(at);
  } else {
    programId = instruction.programId;
    keys = instruction.keys.map((k) => k.pubkey);
  }
  const args = decodeTransactArgs(copyBytes(instruction.data));
  if (keys.length !== 10) throw new LochError("DECODE_FAILED", "a transact instruction lists exactly ten accounts");
  const [config, tree, vault, nullifier0, nullifier1, recipient, relayer, screener, signer, systemProgram] = keys as [
    PublicKey,
    PublicKey,
    PublicKey,
    PublicKey,
    PublicKey,
    PublicKey,
    PublicKey,
    PublicKey,
    PublicKey,
    PublicKey,
  ];
  return {
    programId,
    args,
    accounts: {
      config,
      tree,
      vault,
      nullifier0,
      nullifier1,
      recipient,
      relayer,
      screener: screener.equals(programId) ? null : screener,
      signer,
      systemProgram,
    },
  };
}

/**
 * Checks a decoded instruction against what the program enforces about its
 * addresses: it is addressed to `expectedProgramId`, the three PDAs and the
 * two nullifier PDAs are the ones that program derives, recipient and relayer
 * equal the ext data, the last account is the system program, and the public
 * inputs are below r. Returns a short description of the first problem, or
 * null when the instruction is well formed.
 *
 * Not checked: signer and writable flags (they belong to the message, not to
 * the instruction; `inspectDepositTransaction` checks them for deposits), and
 * anything the program decides from state (the root, the proof, the pause).
 *
 * `expectedProgramId` defaults to {@link PROGRAM_ID}. Without this check an
 * instruction for any other program would pass, because every address would
 * be derived from the program the instruction itself names.
 */
export function transactAccountsProblem(decoded: DecodedTransact, expectedProgramId: PublicKey = PROGRAM_ID): string | null {
  const { programId, args, accounts } = decoded;
  if (!programId.equals(expectedProgramId)) return "the instruction is not addressed to the expected loch_pool program";
  for (const [name, bytes] of [
    ["root", args.root],
    ["inputNullifiers[0]", args.inputNullifiers[0]],
    ["inputNullifiers[1]", args.inputNullifiers[1]],
    ["outputCommitments[0]", args.outputCommitments[0]],
    ["outputCommitments[1]", args.outputCommitments[1]],
  ] as const) {
    if (bytesToBigIntBE(bytes) >= FIELD_MODULUS) return `${name} is not below the field modulus`;
  }
  if (!accounts.config.equals(configPda(programId))) return "config is not the config PDA";
  if (!accounts.tree.equals(treePda(programId))) return "tree is not the tree PDA";
  if (!accounts.vault.equals(vaultPda(programId))) return "vault is not the vault PDA";
  if (!accounts.nullifier0.equals(nullifierPda(args.inputNullifiers[0], programId))) return "nullifier0 is not the PDA of inputNullifiers[0]";
  if (!accounts.nullifier1.equals(nullifierPda(args.inputNullifiers[1], programId))) return "nullifier1 is not the PDA of inputNullifiers[1]";
  if (!accounts.recipient.equals(args.extData.recipient)) return "recipient account differs from extData.recipient";
  if (!accounts.relayer.equals(args.extData.relayer)) return "relayer account differs from extData.relayer";
  if (!accounts.systemProgram.equals(SystemProgram.programId)) return "the last account is not the system program";
  return null;
}
