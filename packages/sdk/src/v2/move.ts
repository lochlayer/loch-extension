// The move (docs/v2.md section 11): a wallet's notes in the earlier pool into the new pool, in
// one transaction that the relayer pays for. Three instructions, in this order:
//
//   1. `transact` (v1): a withdrawal of the notes to the wallet itself, with no fee. The
//      relayer signs it and pays the rent of its two nullifier records.
//   2. a System transfer from the relayer to the wallet: exactly the rent of the two
//      nullifier records the deposit creates.
//   3. `transact_v2`: a SOL deposit from the wallet of exactly what step 1 withdrew, to a note
//      of the wallet's own, co-signed by the screening authority.
//
// The wallet ends where it started and the relayer pays the network fee and all four records.
// Nothing passes through the relayer's hands: the withdrawal goes to the wallet, and the
// wallet's signature covers the deposit. Signers: the relayer (fee payer), the wallet, the
// screening authority (read-only), in that order. Wallet assertions (Lighthouse) may be added:
// Phantom asserts on the fee payer too. An assertion only makes a transaction fail.
//
// The message is a version-1 transaction: two proofs do not fit in 1,232 bytes.

import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

import { equalBytes } from "../bytes.js";
import { DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, LIGHTHOUSE_PROGRAM_ID, PROGRAM_ID } from "../constants.js";
import { LochError } from "../errors.js";
import { type TransactArgs, decodeTransactArgs } from "../codec.js";
import { buildTransactInstruction } from "../instruction.js";
import { type AnyTransaction, TransactionV1, buildTransactionV1 } from "../transactionV1.js";
import { WireError, type WireResult } from "../wire/types.js";
import { type TransactArgsV2, decodeV2Data } from "./codec.js";
import { NATIVE_MINT } from "./constants.js";
import { buildTransactV2Instruction } from "./program.js";

/**
 * Wallet assertions a move may carry: as many as a transaction holds beside its three
 * instructions. Phantom asserts on every account a move changes, which is more than a deposit's
 * eight; an assertion can only make the transaction fail, and costs the relayer nothing (a
 * version-1 transaction's priority fee is a total, and the base fee is per signature).
 */
export const MAX_MOVE_LIGHTHOUSE_INSTRUCTIONS = 61;

/** Compute units of a move: a `transact` and a `transact_v2`, headroom included. */
export const MOVE_COMPUTE_UNIT_LIMIT = 700_000;

/** What a relayer that moves for free asks of a move (`GET /v2/info`, `move`). */
export interface MoveTerms {
  /** Lamports the relayer sends the wallet for the deposit's two nullifier records. */
  refundLamports: bigint;
  /** The smallest amount moved, in lamports. */
  minLamports: bigint;
  computeUnitLimit: number;
  /** Total priority fee in lamports the relayer pays (0: none). */
  priorityFeeLamports: bigint;
}

export interface BuildMoveParams {
  /** A v1 withdrawal: recipient the wallet, relayer the relayer. */
  withdrawal: TransactArgs;
  /** A v2 SOL deposit of exactly what the withdrawal takes out. */
  deposit: TransactArgsV2;
  relayer: PublicKey;
  wallet: PublicKey;
  /** The v2 pool's screening authority. */
  screener: PublicKey;
  terms: MoveTerms;
  recentBlockhash: string;
  programId?: PublicKey;
}

/** The three instructions of a move, in order. */
export function moveInstructions(params: Omit<BuildMoveParams, "terms" | "recentBlockhash"> & { refundLamports: bigint }): TransactionInstruction[] {
  const programId = params.programId ?? PROGRAM_ID;
  return [
    buildTransactInstruction(params.withdrawal, { signer: params.relayer, programId }),
    SystemProgram.transfer({ fromPubkey: params.relayer, toPubkey: params.wallet, lamports: params.refundLamports }),
    buildTransactV2Instruction(params.deposit, { signer: params.wallet, screener: params.screener, programId }),
  ];
}

/**
 * The unsigned move transaction (version 1).
 *
 * @throws LochError `INVALID_ARGUMENT` when the two halves do not make a move, `TRANSACTION_TOO_LARGE` over 4,096 bytes.
 */
export function buildMoveTransaction(params: BuildMoveParams): TransactionV1 {
  const problem = pairProblem(params.withdrawal, params.deposit, params.relayer, params.wallet);
  if (problem) throw new LochError("INVALID_ARGUMENT", `not a move: ${problem}`);
  return buildTransactionV1({
    instructions: moveInstructions({ ...params, refundLamports: params.terms.refundLamports }),
    payer: params.relayer,
    recentBlockhash: params.recentBlockhash,
    computeUnitLimit: params.terms.computeUnitLimit,
    loadedAccountsDataSizeLimit: DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    ...(params.terms.priorityFeeLamports > 0n ? { priorityFeeLamports: Number(params.terms.priorityFeeLamports) } : {}),
  });
}

/** What the two halves must say of each other. */
function pairProblem(withdrawal: TransactArgs, deposit: TransactArgsV2, relayer: PublicKey, wallet: PublicKey): string | null {
  const out = withdrawal.extData;
  if (out.extAmount >= 0n) return "the earlier pool's half is not a withdrawal";
  if (!out.recipient.equals(wallet)) return "the withdrawal does not go to the wallet";
  if (!out.relayer.equals(relayer)) return "the withdrawal does not name the relayer";
  const into = deposit.extData;
  if (into.extAmount <= 0n || into.swap) return "the new pool's half is not a deposit";
  if (!into.asset.equals(NATIVE_MINT)) return "a move deposits SOL";
  if (!into.recipient.equals(PublicKey.default)) return "a deposit names no recipient";
  if (into.extAmount !== -out.extAmount) return "the deposit is not exactly what the withdrawal takes out";
  return null;
}

/** A move, as {@link inspectMoveTransaction} established it. */
export interface MoveInspection {
  relayer: PublicKey;
  wallet: PublicKey;
  screener: PublicKey;
  withdrawal: TransactArgs;
  deposit: TransactArgsV2;
  /** Lamports moved. */
  amount: bigint;
  /** The withdrawal's relayer fee (the program pays it to the relayer). */
  fee: bigint;
  refundLamports: bigint;
  computeUnitLimit: number | null;
  priorityFeeLamports: bigint | null;
  lighthouseInstructions: number;
  /** Index of each signer's signature. */
  relayerSignatureIndex: 0;
  walletSignatureIndex: 1;
  screenerSignatureIndex: 2;
}

export interface InspectMoveOptions {
  /** The v2 pool's screening authority. */
  screener: PublicKey;
  /** When given, the fee payer must be this key. */
  relayer?: PublicKey;
  programId?: PublicKey;
}

/**
 * Checks that a transaction is exactly one move and nothing else: the three instructions as
 * {@link moveInstructions} builds them from their own arguments, wallet assertions, and every
 * account with the flags those instructions give it. Fails with `invalid_transaction`. Not
 * checked here: proofs, caps, pause, blockhash, the screening policy, a relayer's terms.
 */
export function inspectMoveTransaction(transaction: AnyTransaction, options: InspectMoveOptions): WireResult<MoveInspection> {
  const programId = options.programId ?? PROGRAM_ID;
  const fail = (why: string): WireResult<MoveInspection> => ({ ok: false, error: new WireError("invalid_transaction", `not a Loch move: ${why}`, 400) });
  if (!(transaction instanceof TransactionV1)) return fail("a move is a version 1 transaction");
  const { message } = transaction;
  const keys = message.staticAccountKeys;
  const { header } = message;
  if (header.numRequiredSignatures !== 3 || header.numReadonlySignedAccounts !== 1) return fail("expected exactly three signers: the relayer, the wallet and the read-only screener");
  if (transaction.signatures.length !== 3) return fail("expected exactly three signature slots");
  if (header.numReadonlyUnsignedAccounts > keys.length - 3) return fail("the message header does not fit its account list");
  if (new Set(keys.map((key) => key.toBase58())).size !== keys.length) return fail("an account is listed twice");
  const [relayer, wallet, screener] = keys as [PublicKey, PublicKey, PublicKey];
  if (!screener.equals(options.screener)) return fail("the third signer is not the screening authority");
  if (options.relayer && !relayer.equals(options.relayer)) return fail("the fee payer is not this relayer");

  const core: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[] = [];
  let lighthouse = 0;
  const lighthouseOnly = new Set<number>();
  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program || instruction.accountKeyIndexes.some((index) => index >= keys.length)) return fail("an instruction refers to a missing account");
    if (program.equals(LIGHTHOUSE_PROGRAM_ID)) {
      if (++lighthouse > MAX_MOVE_LIGHTHOUSE_INSTRUCTIONS) return fail(`more than ${MAX_MOVE_LIGHTHOUSE_INSTRUCTIONS} Lighthouse instructions`);
      // A wallet's assertions may name the fee payer (Phantom checks it) but never the screening key, as in a deposit.
      if (instruction.accountKeyIndexes.some((index) => index === 2)) return fail("a Lighthouse instruction names the screener");
      for (const index of instruction.accountKeyIndexes) lighthouseOnly.add(index);
      lighthouseOnly.add(instruction.programIdIndex);
    } else {
      core.push({ programIdIndex: instruction.programIdIndex, accountKeyIndexes: [...instruction.accountKeyIndexes], data: instruction.data });
    }
  }
  if (core.length !== 3) return fail("expected exactly a withdrawal, a transfer and a deposit");

  let withdrawal: TransactArgs;
  let deposit: TransactArgsV2;
  try {
    withdrawal = decodeTransactArgs(core[0]!.data);
    const decoded = decodeV2Data(core[2]!.data);
    if (decoded.kind !== "transact") return fail("a swap is not a deposit");
    deposit = decoded.args;
  } catch {
    return fail("the loch_pool instructions are not a well-formed transact and transact_v2");
  }
  const pair = pairProblem(withdrawal, deposit, relayer, wallet);
  if (pair) return fail(pair);
  const transfer = core[1]!.data;
  if (transfer.length !== 12 || transfer[0] !== 2 || transfer[1] !== 0 || transfer[2] !== 0 || transfer[3] !== 0) return fail("the second instruction is not a System transfer");
  const refundLamports = new DataView(transfer.buffer, transfer.byteOffset).getBigUint64(4, true);

  // The three instructions are exactly the ones their own arguments make.
  const expected = moveInstructions({ withdrawal, deposit, relayer, wallet, screener, refundLamports, programId });
  const flags = new Map<string, { signer: boolean; writable: boolean }>();
  for (let i = 0; i < 3; i++) {
    const want = expected[i]!;
    const got = core[i]!;
    if (!keys[got.programIdIndex]!.equals(want.programId)) return fail(`instruction ${i + 1} is for the wrong program`);
    if (!equalBytes(got.data, want.data)) return fail(`instruction ${i + 1} does not carry its own arguments`);
    if (got.accountKeyIndexes.length !== want.keys.length) return fail(`instruction ${i + 1} does not have its accounts`);
    for (let slot = 0; slot < want.keys.length; slot++) {
      const meta = want.keys[slot]!;
      if (!keys[got.accountKeyIndexes[slot]!]!.equals(meta.pubkey)) return fail(`instruction ${i + 1} has the wrong account in slot ${slot}`);
      const key = meta.pubkey.toBase58();
      const seen = flags.get(key) ?? { signer: false, writable: false };
      flags.set(key, { signer: seen.signer || meta.isSigner, writable: seen.writable || meta.isWritable });
    }
    const program = want.programId.toBase58();
    if (!flags.has(program)) flags.set(program, { signer: false, writable: false });
  }
  flags.set(relayer.toBase58(), { signer: true, writable: true });
  // Every account has the flags the three instructions give it, and an account only a wallet
  // assertion names is read-only.
  for (let index = 0; index < keys.length; index++) {
    const want = flags.get(keys[index]!.toBase58());
    if (!want && !lighthouseOnly.has(index)) return fail("the account list holds an account no instruction uses");
    const signer = want?.signer ?? false;
    const writable = want?.writable ?? false;
    if (message.isAccountSigner(index) !== signer || message.isAccountWritable(index) !== writable) return fail("an account does not have the flags the move gives it");
  }

  const config = message.transactionConfig;
  return {
    ok: true,
    value: {
      relayer,
      wallet,
      screener,
      withdrawal,
      deposit,
      amount: deposit.extData.extAmount,
      fee: withdrawal.extData.fee,
      refundLamports,
      computeUnitLimit: config.computeUnitLimit,
      priorityFeeLamports: config.priorityFee === null ? null : BigInt(config.priorityFee),
      lighthouseInstructions: lighthouse,
      relayerSignatureIndex: 0,
      walletSignatureIndex: 1,
      screenerSignatureIndex: 2,
    },
  };
}

/** True when a transaction holds two loch_pool instructions: a move, not a deposit. */
export function isMoveTransaction(transaction: AnyTransaction, programId: PublicKey = PROGRAM_ID): boolean {
  const keys = transaction.message.staticAccountKeys;
  return transaction.message.compiledInstructions.filter((instruction) => keys[instruction.programIdIndex]?.equals(programId)).length === 2;
}
