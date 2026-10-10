// Building a `transact` call: choose notes, create outputs, bind the ext data,
// prove, and encode everything the way the program expects.

import { PublicKey } from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";

import type { PoolConfig, RecipientRent } from "./accounts.js";
import { type PaymentCode, type ShieldedAddress, decodeRecipient } from "./address.js";
import { randomBytes } from "./bytes.js";
import { type ExtData, type Groth16Proof, type TransactArgs, encodeProof, encodeTransactArgs, extDataHash } from "./codec.js";
import { PROGRAM_ID, SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM, TREE_DEPTH } from "./constants.js";
import { FeeTooHighError, InsufficientBalanceError, LochError } from "./errors.js";
import { assertAmount, assertField, fieldToBytes, publicAmountField } from "./field.js";
import { buildTransactInstruction } from "./instruction.js";
import { type LochKeys, publicKeyOf } from "./keys.js";
import { type MerkleTree, merkleRootFromPath } from "./merkle.js";
import { configPda, treePda, vaultPda } from "./pda.js";
import { type Note, createNote, encryptNote, noteCommitment, noteNullifier, randomBlinding } from "./note.js";
import type { CircuitInput, Prover } from "./prover.js";
import {
  type OwnedNote,
  type WalletState,
  assertStateMatches,
  consolidationCandidates,
  selectNotes,
  treeFromState,
  unspentNotes,
} from "./wallet.js";

const I64_MAX = (1n << 63n) - 1n;

/** A note to spend, with its key and its Merkle path under the root being proven against. */
export interface SpendInput {
  note: Note;
  /** Spending key of the note. Secret. */
  privateKey: bigint;
  /** Position of the note's commitment in the tree. */
  leafIndex: number;
  /** Sibling path, bottom-up, 20 elements (`tree.path(leafIndex).pathElements`). */
  pathElements: readonly bigint[];
}

/** A note to create. */
export interface OutputRequest {
  /** Lamports. */
  amount: bigint;
  /**
   * Who receives it. For a payment code (an address with a `secret`) the note
   * is a keyed note under that secret.
   */
  to: ShieldedAddress | PaymentCode;
}

/** Parameters of {@link prepareTransact}. */
export interface PrepareTransactParams {
  prover: Prover;
  /** A root the program still accepts. Every real input must be a member under it. */
  root: bigint;
  /** Zero, one or two notes to spend. Missing inputs are padded with dummies. */
  inputs: readonly SpendInput[];
  /** Zero, one or two notes to create. Missing outputs are padded with zero-amount notes to `padding`. */
  outputs: readonly OutputRequest[];
  /** Address the zero-amount padding outputs are encrypted to: the sender's own. */
  padding: ShieldedAddress;
  /**
   * The sender's own keys. With them, every output owned by the sender's
   * `publicKey` (change, a deposit, padding) is a keyed note under
   * `selfNoteKey`, encrypted to the sender's own `encryptionPublic` whatever
   * the output's address says. Without them such outputs are plain address
   * notes, which anyone who can break X25519 and knows the address can read.
   */
  own?: Pick<LochKeys, "publicKey" | "encryptionPublic" | "selfNoteKey">;
  /** Positive: deposit. Negative: withdrawal. Zero: private transfer. */
  extAmount: bigint;
  /** Lamports the vault pays to `relayer`. Taken from the shielded value in every transaction type. */
  fee: bigint;
  /** `ExtData.recipient`: receives a withdrawal. */
  recipient: PublicKey;
  /** `ExtData.relayer`: receives the fee. */
  relayer: PublicKey;
  /** Transaction signer that pays the nullifier rent (and the deposit). */
  signer: PublicKey;
  /** The screening authority; required when `extAmount > 0`. */
  screener?: PublicKey | null;
  /** Defaults to {@link PROGRAM_ID}. */
  programId?: PublicKey;
}

/** A note a prepared transaction creates. Its leaf index is known only once the transaction lands. */
export interface PreparedOutput {
  note: Note;
  commitment: bigint;
  /** The 87-byte encrypted note published with the commitment. */
  encryptedOutput: Uint8Array;
  /** Position in the transaction. The leaf index will be the tree's `nextIndex` at execution plus this. */
  position: 0 | 1;
}

/** The public inputs of a prepared transaction. */
export interface TransactPublicInputs {
  root: bigint;
  /** `(extAmount - fee) mod r`. */
  publicAmount: bigint;
  extDataHash: bigint;
  inputNullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint];
}

/** Everything needed to submit a prepared transaction and to track what it does. */
export interface PreparedTransact {
  /** The program's `TransactArgs`. Hand this to a relayer (`toRelayRequest`). */
  args: TransactArgs;
  /** Instruction data: discriminator plus Borsh-encoded `args`. */
  data: Uint8Array;
  /** The ready `transact` instruction for `signer`. */
  instruction: TransactionInstruction;
  /** The two notes created, in transaction order (shuffled). Includes change and padding. */
  outputs: [PreparedOutput, PreparedOutput];
  publicInputs: TransactPublicInputs;
  /** The proof in snarkjs form. */
  proof: Groth16Proof;
  /** The public signals in snarkjs form (decimal strings, circuit order). */
  publicSignals: string[];
}

/** A prepared transfer, withdrawal or consolidation. */
export interface PreparedSpend extends PreparedTransact {
  /** The wallet's notes this transaction spends. Treat them as unavailable until the next sync. */
  spent: OwnedNote[];
}

/**
 * The key a note to `to` is encrypted to, and the pre-shared key that goes
 * with it: the sender's own for a note it will own, the code's secret for a
 * payment code, none for a plain address.
 */
function sealingOf(to: ShieldedAddress | PaymentCode, own: PrepareTransactParams["own"]): { recipient: Uint8Array; psk?: Uint8Array } {
  // The sender's own encryption key, not the one in `to`: a note the sender owns must be one the sender can find,
  // and an address that pairs its public key with somebody else's encryption key would hide the change from it.
  if (own && to.publicKey === own.publicKey) return { recipient: own.encryptionPublic, psk: own.selfNoteKey };
  if (!("secret" in to)) return { recipient: to.encryptionPublic };
  // A payment code never falls back to a plain address note: that would give up what the code is for, silently.
  if (!(to.secret instanceof Uint8Array) || to.secret.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "a payment code secret must be 32 bytes");
  }
  return { recipient: to.encryptionPublic, psk: to.secret };
}

/** One uniformly random bit. */
function coinFlip(): boolean {
  return (randomBytes(1)[0]! & 1) === 1;
}

interface WitnessInput {
  note: Note;
  privateKey: bigint;
  leafIndex: bigint;
  pathElements: bigint[];
}

/**
 * A zero-amount input. The circuit skips its membership check, but its
 * nullifier still becomes an account on chain, so key and blinding are fresh
 * randomness every time: a repeated dummy would fail as a double spend.
 */
function dummyInput(): WitnessInput {
  const privateKey = randomBlinding();
  return {
    note: { amount: 0n, publicKey: publicKeyOf(privateKey), blinding: randomBlinding() },
    privateKey,
    leafIndex: 0n,
    pathElements: new Array<bigint>(TREE_DEPTH).fill(0n),
  };
}

function checkInput(input: SpendInput, root: bigint): WitnessInput {
  const note = createNote(input.note.amount, input.note.publicKey, input.note.blinding);
  assertField(input.privateKey, "privateKey");
  if (!Number.isInteger(input.leafIndex) || input.leafIndex < 0 || input.leafIndex >= 2 ** TREE_DEPTH) {
    throw new LochError("INVALID_ARGUMENT", "leafIndex is outside the tree");
  }
  if (publicKeyOf(input.privateKey) !== note.publicKey) {
    throw new LochError("INVALID_ARGUMENT", "the private key does not own an input note");
  }
  if (input.pathElements.length !== TREE_DEPTH) {
    throw new LochError("INVALID_ARGUMENT", `a Merkle path has ${TREE_DEPTH} elements`);
  }
  if (note.amount !== 0n && merkleRootFromPath(noteCommitment(note), input.leafIndex, input.pathElements) !== root) {
    throw new LochError("STALE_STATE", "an input note is not in the tree under this root; sync and try again");
  }
  return { note, privateKey: input.privateKey, leafIndex: BigInt(input.leafIndex), pathElements: [...input.pathElements] };
}

/**
 * The low-level builder behind `prepareDeposit`, `prepareTransfer` and
 * `prepareWithdrawal`, for custom cases.
 *
 * Always two inputs and two outputs: missing inputs become dummies with fresh
 * random keys, missing outputs become zero-amount notes encrypted to
 * `padding`, and the order of both pairs is shuffled so position reveals
 * nothing. With `own`, the outputs the sender will own are keyed notes under
 * its `selfNoteKey`. The amounts must satisfy
 * `sum(inputs) + extAmount - fee = sum(outputs)`.
 *
 * Checks everything it can before proving (ownership, membership, balance),
 * then proves, and finally requires the prover's public signals to equal the
 * values the program will recompute from the encoded arguments.
 *
 * Not checked here, because this is the builder for custom cases: `fee` is
 * taken as given (the `prepare*` functions cap it with `maxFee`), and
 * `recipient` and `relayer` may be any key. The program refuses a withdrawal
 * or a fee paid to the vault or to an account the pool owns
 * (`InvalidDestination`).
 *
 * @throws LochError `INVALID_ARGUMENT` for inconsistent parameters,
 *   `STALE_STATE` if an input is not under `root`, `PROOF_FAILED` if the
 *   prover fails or returns unexpected public signals.
 */
export async function prepareTransact(params: PrepareTransactParams): Promise<PreparedTransact> {
  const { prover, extAmount, fee, recipient, relayer } = params;
  const root = assertField(params.root, "root");
  if (params.inputs.length > 2 || params.outputs.length > 2) {
    throw new LochError("INVALID_ARGUMENT", "a transaction has at most two inputs and two outputs");
  }
  const publicAmount = publicAmountField(extAmount, fee);
  if (extAmount > 0n && !params.screener) {
    throw new LochError("INVALID_ARGUMENT", "a deposit needs the screening authority's public key");
  }

  const inputs = params.inputs.map((input) => checkInput(input, root));
  for (const request of params.outputs) assertAmount(request.amount, "output amount");
  const sumIn = inputs.reduce((sum, input) => sum + input.note.amount, 0n);
  const sumOut = params.outputs.reduce((sum, request) => sum + request.amount, 0n);
  if (sumIn + extAmount - fee !== sumOut) {
    throw new LochError("INVALID_ARGUMENT", "amounts do not balance: inputs + extAmount - fee must equal outputs");
  }

  while (inputs.length < 2) inputs.push(dummyInput());
  if (coinFlip()) inputs.reverse();
  const nullifiers = inputs.map((input) => noteNullifier(input.note, input.leafIndex, input.privateKey)) as [bigint, bigint];
  if (nullifiers[0] === nullifiers[1]) {
    throw new LochError("INVALID_ARGUMENT", "the same note was given as both inputs");
  }

  const requests = [...params.outputs];
  while (requests.length < 2) requests.push({ amount: 0n, to: params.padding });
  if (coinFlip()) requests.reverse();
  const outputs = requests.map((request, position) => {
    const note = createNote(request.amount, request.to.publicKey);
    const { recipient: encryptionPublic, psk } = sealingOf(request.to, params.own);
    return {
      note,
      commitment: noteCommitment(note),
      encryptedOutput: encryptNote(note, encryptionPublic, psk),
      position: position as 0 | 1,
    };
  }) as [PreparedOutput, PreparedOutput];

  const extData: ExtData = {
    recipient,
    relayer,
    extAmount,
    fee,
    encryptedOutput0: outputs[0].encryptedOutput,
    encryptedOutput1: outputs[1].encryptedOutput,
  };
  const publicInputs: TransactPublicInputs = {
    root,
    publicAmount,
    extDataHash: extDataHash(extData),
    inputNullifiers: nullifiers,
    outputCommitments: [outputs[0].commitment, outputs[1].commitment],
  };
  const pair = <T>(pick: (input: WitnessInput) => T) => [pick(inputs[0]!), pick(inputs[1]!)] as [T, T];
  const circuitInput: CircuitInput = {
    root,
    publicAmount,
    extDataHash: publicInputs.extDataHash,
    inputNullifier: nullifiers,
    outputCommitment: publicInputs.outputCommitments,
    inAmount: pair((input) => input.note.amount),
    inPrivateKey: pair((input) => input.privateKey),
    inBlinding: pair((input) => input.note.blinding),
    inPathIndices: pair((input) => input.leafIndex),
    inPathElements: pair((input) => input.pathElements),
    outAmount: [outputs[0].note.amount, outputs[1].note.amount],
    outPubkey: [outputs[0].note.publicKey, outputs[1].note.publicKey],
    outBlinding: [outputs[0].note.blinding, outputs[1].note.blinding],
  };

  const { proof, publicSignals } = await prover.prove(circuitInput);
  const expected = [root, publicAmount, publicInputs.extDataHash, ...nullifiers, ...publicInputs.outputCommitments].map(String);
  if (publicSignals.length !== expected.length || publicSignals.some((signal, i) => String(signal) !== expected[i])) {
    throw new LochError("PROOF_FAILED", "the prover returned public signals that differ from the transaction: wrong circuit artifacts?");
  }

  const args: TransactArgs = {
    proof: encodeProof(proof),
    root: fieldToBytes(root),
    inputNullifiers: [fieldToBytes(nullifiers[0]), fieldToBytes(nullifiers[1])],
    outputCommitments: [fieldToBytes(outputs[0].commitment), fieldToBytes(outputs[1].commitment)],
    extData,
  };
  return {
    args,
    data: encodeTransactArgs(args),
    instruction: buildTransactInstruction(args, {
      signer: params.signer,
      screener: extAmount > 0n ? params.screener : null,
      programId: params.programId ?? PROGRAM_ID,
    }),
    outputs,
    publicInputs,
    proof,
    publicSignals: publicSignals.map(String),
  };
}

/** Parameters of {@link prepareDeposit}. */
export interface PrepareDepositParams {
  prover: Prover;
  /** The depositor's Loch keys: the new note belongs to them. */
  keys: LochKeys;
  /**
   * Any root the program still accepts: `tree.root` after a sync, or
   * `(await fetchTreeAccount(connection)).root`. A deposit spends nothing, so
   * the full tree is not needed.
   */
  root: bigint;
  /** Lamports to move from the depositor's wallet into the pool. */
  amount: bigint;
  /** The wallet that signs and pays: deposit, nullifier rent and transaction fee. */
  depositor: PublicKey;
  /** The pool configuration (`fetchPoolConfig`): supplies the screener and the limits checked here. */
  config: Pick<PoolConfig, "screener" | "maxDeposit" | "paused">;
  /** Fee taken from the deposit and paid back to the depositor's own account. Default 0. */
  fee?: bigint;
  /** Defaults to {@link PROGRAM_ID}. */
  programId?: PublicKey;
}

/**
 * Prepares a deposit ("dive in"): `ext_amount = +amount`, recipient, relayer
 * and signer are all the depositor, and the screening authority must co-sign.
 * The shielded note is worth `amount - fee`.
 *
 * The deposit is public: the depositor's wallet and the amount are visible on
 * chain. Next: build the transaction with the depositor as payer, have the
 * screener sign it (`ScreenerClient.screen`, `applyScreenerSignature`), then
 * the wallet.
 *
 * @throws LochError `DEPOSITS_PAUSED`, `DEPOSIT_TOO_LARGE`, `INVALID_ARGUMENT`.
 */
export async function prepareDeposit(params: PrepareDepositParams): Promise<PreparedTransact> {
  const { keys, config, depositor } = params;
  const amount = assertAmount(params.amount);
  const fee = assertAmount(params.fee ?? 0n, "fee");
  if (amount === 0n || amount > I64_MAX) throw new LochError("INVALID_ARGUMENT", "a deposit amount must be between 1 and 2^63 - 1 lamports");
  if (fee > amount) throw new LochError("INVALID_ARGUMENT", "the fee exceeds the deposit");
  if (config.paused) throw new LochError("DEPOSITS_PAUSED", "deposits are paused; withdrawals and transfers still work");
  if (amount > config.maxDeposit) throw new LochError("DEPOSIT_TOO_LARGE", "the deposit exceeds the pool's per-transaction cap");
  return prepareTransact({
    prover: params.prover,
    root: params.root,
    inputs: [],
    outputs: [{ amount: amount - fee, to: keys }],
    padding: keys,
    own: keys,
    extAmount: amount,
    fee,
    recipient: depositor,
    relayer: depositor,
    signer: depositor,
    screener: config.screener,
    programId: params.programId,
  });
}

/** What every spending transaction needs. */
export interface SpendContext {
  prover: Prover;
  /** The spender's keys. */
  keys: LochKeys;
  /** The wallet state from the latest sync. */
  state: WalletState;
  /** The tree from the latest sync (`SyncResult.tree`). Rebuilt from the state when omitted. */
  tree?: MerkleTree;
  /** The relayer's public key (`RelayerInfo.relayer`): it signs, pays, and receives `fee`. */
  relayer: PublicKey;
  /**
   * The relayer's fee in lamports, paid from the shielded balance. Usually
   * `BigInt(RelayerInfo.feeLamports)`, that is, a number the relayer chose.
   */
  fee: bigint;
  /**
   * The most the caller agrees to pay as `fee`, in lamports. Required, and it
   * must come from the application or the user, never from the relayer: the
   * proof binds whatever fee it is given and the program pays it out, so
   * without a cap a relayer (or anyone who can alter its `/v1/info` answer)
   * could ask for the whole balance and get it. The `prepare*` functions throw
   * {@link FeeTooHighError} when `fee > maxFee`, before anything is proven.
   */
  maxFee: bigint;
}

/** Checks `fee` against `maxFee` and returns it. */
function agreedFee(context: SpendContext): bigint {
  const fee = assertAmount(context.fee, "fee");
  if (typeof context.maxFee !== "bigint") {
    throw new LochError("INVALID_ARGUMENT", "maxFee is required: the largest relayer fee, in lamports, this transaction may pay");
  }
  const maxFee = assertAmount(context.maxFee, "maxFee");
  if (fee > maxFee) throw new FeeTooHighError(fee, maxFee);
  return fee;
}

/**
 * Lamports paid out of the vault must leave the pool. The program refuses the
 * vault and every account it owns as a destination (`InvalidDestination`);
 * the three that can be named without asking anyone are refused here, before
 * a proof is made.
 */
function assertOutsidePool(destination: PublicKey, programId: PublicKey, what: string): void {
  if ([vaultPda(programId), treePda(programId), configPda(programId)].some((account) => account.equals(destination))) {
    throw new LochError("INVALID_ARGUMENT", `${what} is one of the pool's own accounts: lamports paid to it could never be withdrawn`);
  }
}

function spendInputs(context: SpendContext, notes: readonly OwnedNote[], programId: PublicKey) {
  assertStateMatches(context.state, context.keys, programId);
  const tree = context.tree ?? treeFromState(context.state);
  if (tree.size !== context.state.leaves.length) {
    throw new LochError("STALE_STATE", "the tree does not belong to this wallet state; sync again");
  }
  const inputs: SpendInput[] = notes.map((note) => ({
    note,
    privateKey: context.keys.privateKey,
    leafIndex: note.leafIndex,
    pathElements: tree.path(note.leafIndex).pathElements,
  }));
  return { root: tree.root, inputs };
}

function programOfState(state: WalletState): PublicKey {
  try {
    return new PublicKey(state.programId);
  } catch {
    throw new LochError("INVALID_ARGUMENT", "wallet state has an invalid programId");
  }
}

async function prepareSpend(
  context: SpendContext,
  notes: OwnedNote[],
  outputs: OutputRequest[],
  extAmount: bigint,
  recipient: PublicKey,
): Promise<PreparedSpend> {
  const programId = programOfState(context.state);
  if (extAmount < 0n) assertOutsidePool(recipient, programId, "the recipient");
  if (context.fee > 0n) assertOutsidePool(context.relayer, programId, "the relayer");
  const { root, inputs } = spendInputs(context, notes, programId);
  const prepared = await prepareTransact({
    prover: context.prover,
    root,
    inputs,
    outputs: outputs.filter((output) => output.amount > 0n),
    padding: context.keys,
    own: context.keys,
    extAmount,
    fee: context.fee,
    recipient,
    relayer: context.relayer,
    signer: context.relayer,
    programId,
  });
  return { ...prepared, spent: notes };
}

/** Parameters of {@link prepareTransfer}. */
export interface PrepareTransferParams extends SpendContext {
  /**
   * The recipient: a shielded address (`loch1...`) or a payment code
   * (`lochpay1...`), as a string or decoded. A payment code makes the
   * recipient's note unreadable to someone who breaks X25519 later.
   */
  to: string | ShieldedAddress | PaymentCode;
  /** Lamports the recipient gets. */
  amount: bigint;
}

/**
 * Prepares a private transfer: `ext_amount = 0`, recipient and relayer
 * accounts are both the relayer, who signs and is paid `fee` from the
 * sender's shielded balance. Change comes back as a new note.
 *
 * Nothing about sender, recipient or amount appears on chain. The change is
 * a keyed note under the sender's own key; the recipient's note is one too if
 * `to` is a payment code. Send
 * `toRelayRequest(result.args)` to the relayer. If the relayer answers
 * `unknown_root`, sync and prepare again.
 *
 * @throws FeeTooHighError, InsufficientBalanceError,
 *   ConsolidationRequiredError, AddressError, LochError `INVALID_ARGUMENT` /
 *   `STALE_STATE` / `PROOF_FAILED`.
 */
export async function prepareTransfer(params: PrepareTransferParams): Promise<PreparedSpend> {
  const to = typeof params.to === "string" ? decodeRecipient(params.to) : params.to;
  const amount = assertAmount(params.amount);
  const fee = agreedFee(params);
  if (amount === 0n) throw new LochError("INVALID_ARGUMENT", "a transfer amount must be positive");
  const notes = selectNotes(unspentNotes(params.state), amount + fee);
  const change = notes.reduce((sum, note) => sum + note.amount, 0n) - amount - fee;
  return prepareSpend(
    params,
    notes,
    [
      { amount, to },
      { amount: change, to: params.keys },
    ],
    0n,
    params.relayer,
  );
}

/** Parameters of {@link prepareWithdrawal}. */
export interface PrepareWithdrawalParams extends SpendContext {
  /** The Solana account that receives the lamports. Public. */
  recipient: PublicKey;
  /** Lamports the recipient gets. */
  amount: bigint;
  /**
   * The recipient's balance and rent-exempt minimum, for an exact rent check.
   * Optional. Without it the recipient is assumed not to exist yet, so the
   * amount must be at least {@link SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM}
   * (890,880 lamports): a check that asks nobody about the recipient.
   * `fetchRecipientRent` gets the exact values, at the price of naming the
   * destination to the RPC before the withdrawal is public.
   */
  rent?: RecipientRent;
}

/**
 * Prepares a withdrawal ("surface"): `ext_amount = -amount`, the vault pays
 * `amount` to `recipient` and `fee` to the relayer, who signs. Change stays
 * shielded.
 *
 * The recipient and the amount are public. A withdrawal that would leave the
 * recipient below the rent-exempt minimum (for example a small amount to an
 * account that does not exist yet) is refused here, because the runtime would
 * reject the transaction. With `rent` the check is exact; without it the
 * amount itself must cover the minimum of a new account. Either way the
 * relayer checks again (`withdrawal_too_small`).
 *
 * @throws LochError `RECIPIENT_BELOW_RENT_EXEMPT`, FeeTooHighError,
 *   InsufficientBalanceError, ConsolidationRequiredError, LochError
 *   `INVALID_ARGUMENT` / `STALE_STATE` / `PROOF_FAILED`.
 */
export async function prepareWithdrawal(params: PrepareWithdrawalParams): Promise<PreparedSpend> {
  const amount = assertAmount(params.amount);
  const fee = agreedFee(params);
  if (amount === 0n || amount > I64_MAX) throw new LochError("INVALID_ARGUMENT", "a withdrawal amount must be between 1 and 2^63 - 1 lamports");
  const { lamports, rentExemptMinimum } = params.rent ?? { lamports: 0n, rentExemptMinimum: SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM };
  if (assertAmount(lamports, "rent.lamports") + amount < assertAmount(rentExemptMinimum, "rent.rentExemptMinimum")) {
    throw new LochError(
      "RECIPIENT_BELOW_RENT_EXEMPT",
      params.rent
        ? `the recipient would hold less than the rent-exempt minimum (${rentExemptMinimum} lamports) and the transfer would fail`
        : `a withdrawal of less than ${rentExemptMinimum} lamports fails if the recipient account does not exist yet; withdraw more, or pass the recipient's rent status`,
    );
  }
  const notes = selectNotes(unspentNotes(params.state), amount + fee);
  const change = notes.reduce((sum, note) => sum + note.amount, 0n) - amount - fee;
  return prepareSpend(params, notes, [{ amount: change, to: params.keys }], -amount, params.recipient);
}

/**
 * Prepares a consolidation: a private transfer to self that merges the two
 * largest unspent notes into one (minus the relayer fee). Use it when
 * `prepareTransfer` or `prepareWithdrawal` throws
 * {@link ConsolidationRequiredError}; after it confirms, sync and retry.
 * Several rounds may be needed, and each costs one fee.
 *
 * @throws LochError `INVALID_ARGUMENT` if there are fewer than two unspent
 *   notes, FeeTooHighError, InsufficientBalanceError if they do not cover
 *   the fee.
 */
export async function prepareConsolidation(params: SpendContext): Promise<PreparedSpend> {
  const fee = agreedFee(params);
  const notes = consolidationCandidates(unspentNotes(params.state));
  if (notes.length < 2) throw new LochError("INVALID_ARGUMENT", "consolidation needs at least two unspent notes");
  const total = notes.reduce((sum, note) => sum + note.amount, 0n);
  if (total < fee) throw new InsufficientBalanceError(fee, total);
  return prepareSpend(params, notes, [{ amount: total - fee, to: params.keys }], 0n, params.relayer);
}
