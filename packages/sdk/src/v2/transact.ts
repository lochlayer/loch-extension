// Building v2 transactions (docs/v2.md sections 6, 7, 9): choose notes, make
// three outputs, bind the ext data, prove, and encode what the program expects.
//
// Every v2 transaction has two inputs and three outputs of ONE asset. Missing
// inputs are dummies, missing outputs zero-amount notes to the sender, and both
// are shuffled so position says nothing. A relayer is paid with one of the
// outputs (a fee note to its v2 address), so a private transfer has no public
// amount and no public asset.

import { PublicKey } from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";

import { randomBytes } from "../bytes.js";
import { type Groth16Proof, encodeProof } from "../codec.js";
import { SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM } from "../constants.js";
import { FeeTooHighError, LochError } from "../errors.js";
import { assertAmount, assertField, fieldToBytes } from "../field.js";
import type { MerkleTree } from "../merkle.js";
import { merkleRootFromPath } from "../merkle.js";
import { randomBlinding } from "../note.js";
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import type { Prover } from "../prover.js";
import { assetId, isNativeMint } from "./asset.js";
import { type ExtDataV2, type SwapExt, type TransactArgsV2, extDataHashV2, publicAmountV2 } from "./codec.js";
import { DIVERSIFIER_LENGTH, INPUTS_V2, OUTPUTS_V2, TREE_DEPTH_V2 } from "./constants.js";
import { type LochKeysV2, type PaymentCodeV2, type ShieldedAddressV2, diversifierField, mainAddress, ownerOf } from "./keys.js";
import { type NoteV2, createNoteV2, encryptNoteV2, noteCommitmentV2, noteInner, noteNullifierV2, sealingKeyOf } from "./note.js";
import { type AssetConfig, type PoolConfigV2, buildTransactV2Instruction } from "./program.js";
import { type OwnedNoteV2, type WalletStateV2, assertStateV2Matches, consolidationCandidatesV2, selectNotesV2, treeFromStateV2, unspentNotesV2 } from "./wallet.js";

const I64_MAX = (1n << 63n) - 1n;

/** The witness of `circuits/transaction2.circom`. Private signals are secrets. */
export interface CircuitInputV2 {
  root: bigint;
  publicAmount: bigint;
  publicAsset: bigint;
  extDataHash: bigint;
  inputNullifier: bigint[];
  outputCommitment: bigint[];
  asset: bigint;
  spendKey: bigint;
  nullifierKey: bigint;
  inAmount: bigint[];
  inBlinding: bigint[];
  inDiversifier: bigint[];
  inPathIndices: bigint[];
  inPathElements: bigint[][];
  outAmount: bigint[];
  outOwner: bigint[];
  outBlinding: bigint[];
}

/** A note to spend, with its diversifier and its Merkle path under the root proven against. */
export interface SpendInputV2 {
  note: NoteV2;
  d: Uint8Array;
  leafIndex: number;
  pathElements: readonly bigint[];
}

/** A note to create. */
export interface OutputRequestV2 {
  amount: bigint;
  to: ShieldedAddressV2 | PaymentCodeV2;
}

/** A created output. Its leaf index is known once the transaction lands. */
export interface PreparedOutputV2 {
  note: NoteV2;
  /** Diversifier of the receiving address. */
  d: Uint8Array;
  commitment: bigint;
  encryptedOutput: Uint8Array;
  /** Position 0 to 2: leaf `firstIndex + position`. */
  position: 0 | 1 | 2;
}

/** The swap's output note, finished on chain with the amount the swap returns. */
export interface PreparedSwapOutputV2 {
  owner: bigint;
  d: Uint8Array;
  blinding: bigint;
  inner: bigint;
  encryptedOutput: Uint8Array;
}

/** What a relayer is told about the note that pays it (docs/v2.md section 9). */
export interface FeeNoteOpening {
  position: 0 | 1 | 2;
  mint: PublicKey;
  amount: bigint;
  blinding: bigint;
}

export interface PreparedTransactV2 {
  args: TransactArgsV2;
  outputs: [PreparedOutputV2, PreparedOutputV2, PreparedOutputV2];
  swapOutput: PreparedSwapOutputV2 | null;
  /** The fee note, when one of the outputs pays a relayer. */
  feeNote: FeeNoteOpening | null;
  /** Public inputs in circuit order. */
  publicInputs: bigint[];
  proof: Groth16Proof;
  publicSignals: string[];
}

export interface PrepareTransactV2Params {
  prover: Prover<CircuitInputV2>;
  root: bigint;
  /** The transaction's one asset. */
  mint: PublicKey;
  /** `ask` and `nk` of the inputs' owner. Without real inputs it may be omitted: dummies then use a throwaway key set. */
  spendKeys?: Pick<LochKeysV2, "ask" | "nk">;
  inputs: readonly SpendInputV2[];
  /** At most three. */
  outputs: readonly OutputRequestV2[];
  /** Where zero-amount padding outputs go: the sender's own main address, or a payee's. */
  padding: ShieldedAddressV2;
  /** The sender's own reading keys: its outputs to itself become keyed notes under `selfNoteKey`. */
  own?: { ownerRoot: bigint; selfNoteKey: Uint8Array };
  /** Leave the ciphertexts of zero-amount padding outputs empty (deposits only, to fit a version-0 transaction). */
  emptyPadding?: boolean;
  /** Positive deposit, negative withdrawal or swap input, zero transfer. */
  extAmount: bigint;
  /** Withdrawal destination: a system account for SOL, a token account of `mint` otherwise. */
  recipient?: PublicKey;
  /** A swap: its output mint, minimum, and the address (the sender's own) that receives the output note. */
  swap?: { outputMint: PublicKey; minAmountOut: bigint; to: ShieldedAddressV2 };
  /** Position in `outputs` of the relayer's fee note, to report its opening. */
  feeOutput?: number;
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface WitnessInput {
  note: NoteV2;
  d: Uint8Array;
  leafIndex: bigint;
  pathElements: bigint[];
}

/** A random key set for transactions without real inputs. Never reused. */
function throwawayKeys(): Pick<LochKeysV2, "ask" | "nk"> {
  return { ask: randomBlinding(), nk: randomBlinding() };
}

/**
 * The low-level builder behind every `prepare*V2`. Checks ownership,
 * membership and balance before proving, then requires the prover's public
 * signals to be what the program will rebuild.
 *
 * @throws LochError `INVALID_ARGUMENT`, `STALE_STATE`, `PROOF_FAILED`.
 */
export async function prepareTransactV2(params: PrepareTransactV2Params): Promise<PreparedTransactV2> {
  const { prover, mint, extAmount } = params;
  const root = assertField(params.root, "root");
  if (params.inputs.length > INPUTS_V2 || params.outputs.length > OUTPUTS_V2) {
    throw new LochError("INVALID_ARGUMENT", "a v2 transaction has at most two inputs and three outputs");
  }
  if (typeof extAmount !== "bigint" || extAmount < -I64_MAX || extAmount > I64_MAX) throw new LochError("INVALID_ARGUMENT", "extAmount must fit in an i64");
  if (params.inputs.length > 0 && !params.spendKeys) throw new LochError("INVALID_ARGUMENT", "spending needs the spend keys");
  if (params.swap && extAmount >= 0n) throw new LochError("INVALID_ARGUMENT", "a swap spends: its extAmount is negative");
  if (extAmount < 0n && !params.swap && !params.recipient) throw new LochError("INVALID_ARGUMENT", "a withdrawal needs a recipient");
  const keys = params.spendKeys ?? throwawayKeys();
  const ownerRoot = ownerRootOf(keys);
  const asset = assetId(mint);

  const inputs: WitnessInput[] = params.inputs.map((input) => {
    const note = createNoteV2(input.note.asset, input.note.amount, input.note.owner, input.note.blinding);
    if (note.asset !== asset) throw new LochError("INVALID_ARGUMENT", "an input note is of another asset");
    if (!(input.d instanceof Uint8Array) || input.d.length !== DIVERSIFIER_LENGTH) throw new LochError("INVALID_ARGUMENT", "an input's diversifier is 16 bytes");
    if (ownerOf(ownerRoot, input.d) !== note.owner) throw new LochError("INVALID_ARGUMENT", "the spend keys do not own an input note");
    if (!Number.isInteger(input.leafIndex) || input.leafIndex < 0 || input.leafIndex >= 2 ** TREE_DEPTH_V2) throw new LochError("INVALID_ARGUMENT", "leafIndex is outside the tree");
    if (input.pathElements.length !== TREE_DEPTH_V2) throw new LochError("INVALID_ARGUMENT", `a Merkle path has ${TREE_DEPTH_V2} elements`);
    if (note.amount !== 0n && merkleRootFromPath(noteCommitmentV2(note), input.leafIndex, input.pathElements) !== root) {
      throw new LochError("STALE_STATE", "an input note is not in the tree under this root; sync and try again");
    }
    return { note, d: input.d, leafIndex: BigInt(input.leafIndex), pathElements: [...input.pathElements] };
  });
  for (const request of params.outputs) assertAmount(request.amount, "output amount");
  const sumIn = inputs.reduce((sum, input) => sum + input.note.amount, 0n);
  const sumOut = params.outputs.reduce((sum, request) => sum + request.amount, 0n);
  if (sumIn + extAmount !== sumOut) throw new LochError("INVALID_ARGUMENT", "amounts do not balance: inputs + extAmount must equal outputs");

  while (inputs.length < INPUTS_V2) {
    const d = randomBytes(DIVERSIFIER_LENGTH);
    inputs.push({ note: { asset, amount: 0n, owner: ownerOf(ownerRoot, d), blinding: randomBlinding() }, d, leafIndex: 0n, pathElements: new Array<bigint>(TREE_DEPTH_V2).fill(0n) });
  }
  if ((randomBytes(1)[0]! & 1) === 1) inputs.reverse();
  const nullifiers = inputs.map((input) => noteNullifierV2(keys.nk, noteCommitmentV2(input.note), input.leafIndex));
  if (nullifiers[0] === nullifiers[1]) throw new LochError("INVALID_ARGUMENT", "the same note was given as both inputs");

  // Requests in their final, shuffled order; remember where the fee note went.
  const tagged = params.outputs.map((request, index) => ({ request, fee: index === params.feeOutput, padding: false }));
  while (tagged.length < OUTPUTS_V2) tagged.push({ request: { amount: 0n, to: params.padding }, fee: false, padding: true });
  const order = shuffled(tagged);
  let feeNote: FeeNoteOpening | null = null;
  const outputs = order.map(({ request, fee, padding }, position) => {
    const note = createNoteV2(asset, request.amount, request.to.owner);
    const empty = padding && params.emptyPadding === true && extAmount > 0n;
    const encryptedOutput = empty ? new Uint8Array(0) : encryptNoteV2(note, request.to, sealingKeyOf(request.to, params.own));
    if (fee) feeNote = { position: position as 0 | 1 | 2, mint, amount: note.amount, blinding: note.blinding };
    return { note, d: request.to.d, commitment: noteCommitmentV2(note), encryptedOutput, position: position as 0 | 1 | 2 };
  }) as PreparedTransactV2["outputs"];

  let swapOutput: PreparedSwapOutputV2 | null = null;
  let swapExt: SwapExt | null = null;
  if (params.swap) {
    const { outputMint, minAmountOut, to } = params.swap;
    assertAmount(minAmountOut, "minAmountOut");
    if (outputMint.equals(mint)) throw new LochError("INVALID_ARGUMENT", "a swap's output asset differs from its input");
    const blinding = randomBlinding();
    const inner = noteInner(to.owner, blinding);
    const encryptedOutput = encryptNoteV2({ amount: minAmountOut, blinding }, to, sealingKeyOf(to, params.own));
    swapOutput = { owner: to.owner, d: to.d, blinding, inner, encryptedOutput };
    swapExt = { outputMint, minAmountOut, inner, encryptedOutput };
  }

  const extData: ExtDataV2 = {
    recipient: extAmount < 0n && !params.swap ? params.recipient! : PublicKey.default,
    extAmount,
    asset: extAmount === 0n ? PublicKey.default : mint,
    encryptedOutputs: [outputs[0].encryptedOutput, outputs[1].encryptedOutput, outputs[2].encryptedOutput],
    swap: swapExt,
  };
  const publicAmount = publicAmountV2(extAmount);
  const publicAsset = extAmount === 0n ? 0n : asset;
  const hash = extDataHashV2(extData);
  const commitments = outputs.map((output) => output.commitment);
  const publicInputs = [root, publicAmount, publicAsset, hash, ...nullifiers, ...commitments];
  const circuitInput: CircuitInputV2 = {
    root,
    publicAmount,
    publicAsset,
    extDataHash: hash,
    inputNullifier: nullifiers,
    outputCommitment: commitments,
    asset,
    spendKey: keys.ask,
    nullifierKey: keys.nk,
    inAmount: inputs.map((i) => i.note.amount),
    inBlinding: inputs.map((i) => i.note.blinding),
    inDiversifier: inputs.map((i) => diversifierField(i.d)),
    inPathIndices: inputs.map((i) => i.leafIndex),
    inPathElements: inputs.map((i) => i.pathElements),
    outAmount: outputs.map((o) => o.note.amount),
    outOwner: outputs.map((o) => o.note.owner),
    outBlinding: outputs.map((o) => o.note.blinding),
  };
  const { proof, publicSignals } = await prover.prove(circuitInput);
  if (publicSignals.length !== publicInputs.length || publicSignals.some((signal, i) => String(signal) !== publicInputs[i]!.toString())) {
    throw new LochError("PROOF_FAILED", "the prover returned public signals that differ from the transaction: wrong circuit artifacts?");
  }
  const args: TransactArgsV2 = {
    proof: encodeProof(proof),
    root: fieldToBytes(root),
    inputNullifiers: [fieldToBytes(nullifiers[0]!), fieldToBytes(nullifiers[1]!)],
    outputCommitments: [fieldToBytes(commitments[0]!), fieldToBytes(commitments[1]!), fieldToBytes(commitments[2]!)],
    extData,
  };
  return { args, outputs, swapOutput, feeNote, publicInputs, proof, publicSignals: publicSignals.map(String) };
}

/** `Poseidon(Poseidon(ask), nk)`. */
function ownerRootOf(keys: Pick<LochKeysV2, "ask" | "nk">): bigint {
  return poseidon2([poseidon1([keys.ask]), keys.nk]);
}

// ---- deposits ----

export interface PrepareDepositV2Params {
  prover: Prover<CircuitInputV2>;
  /** The depositor's reading keys: the note goes to its main address, keyed with its `selfNoteKey`. */
  keys: Pick<LochKeysV2, "ownerRoot" | "ivk" | "dk" | "selfNoteKey">;
  mint: PublicKey;
  /** Base units moved from the depositor's wallet into the pool. */
  amount: bigint;
  /** Wallet that signs and pays. */
  depositor: PublicKey;
  /** For a token: the depositor's token account the tokens come from. */
  source?: PublicKey;
  root: bigint;
  config: Pick<PoolConfigV2, "screener" | "paused">;
  asset: Pick<AssetConfig, "maxDeposit" | "depositsEnabled" | "mint">;
  /** Leave the padding ciphertexts empty (a version-0 transaction needs the bytes). */
  emptyPadding?: boolean;
  programId?: PublicKey;
}

export interface PreparedDepositV2 extends PreparedTransactV2 {
  instruction: TransactionInstruction;
}

function checkDeposit(amount: bigint, config: PrepareDepositV2Params["config"], asset: PrepareDepositV2Params["asset"], mint: PublicKey): void {
  if (amount <= 0n || amount > I64_MAX) throw new LochError("INVALID_ARGUMENT", "a deposit amount must be between 1 and 2^63 - 1");
  if (!asset.mint.equals(mint)) throw new LochError("INVALID_ARGUMENT", "the asset account is for another mint");
  if (config.paused) throw new LochError("DEPOSITS_PAUSED", "deposits are paused; withdrawals and transfers still work");
  if (!asset.depositsEnabled) throw new LochError("DEPOSITS_PAUSED", "deposits of this asset are disabled; withdrawals and transfers still work");
  if (amount > asset.maxDeposit) throw new LochError("DEPOSIT_TOO_LARGE", "the deposit exceeds the asset's per-transaction cap");
}

/**
 * A deposit ("dive in") of `amount` of `mint` to the depositor's own main
 * address. Public: the depositor, the asset and the amount.
 */
export async function prepareDepositV2(params: PrepareDepositV2Params): Promise<PreparedDepositV2> {
  const amount = assertAmount(params.amount);
  checkDeposit(amount, params.config, params.asset, params.mint);
  if (!isNativeMint(params.mint) && !params.source) throw new LochError("INVALID_ARGUMENT", "a token deposit needs the source token account");
  const self = mainAddress(params.keys);
  const prepared = await prepareTransactV2({
    prover: params.prover,
    root: params.root,
    mint: params.mint,
    inputs: [],
    outputs: [{ amount, to: self }],
    padding: self,
    own: params.keys,
    emptyPadding: params.emptyPadding,
    extAmount: amount,
  });
  return {
    ...prepared,
    instruction: buildTransactV2Instruction(prepared.args, { signer: params.depositor, screener: params.config.screener, counterparty: params.source ?? null, programId: params.programId }),
  };
}

/**
 * A deposit whose note belongs to someone else: a payment into the pool from a
 * public wallet with no Loch keys (a pay link). The padding goes to the payee's
 * address too, so the payer keeps nothing.
 */
export async function preparePaymentDepositV2(
  params: Omit<PrepareDepositV2Params, "keys"> & { to: ShieldedAddressV2 | PaymentCodeV2 },
): Promise<PreparedDepositV2> {
  const amount = assertAmount(params.amount);
  checkDeposit(amount, params.config, params.asset, params.mint);
  if (!isNativeMint(params.mint) && !params.source) throw new LochError("INVALID_ARGUMENT", "a token deposit needs the source token account");
  const padding: ShieldedAddressV2 = { d: params.to.d, owner: params.to.owner, pk: params.to.pk };
  const prepared = await prepareTransactV2({
    prover: params.prover,
    root: params.root,
    mint: params.mint,
    inputs: [],
    outputs: [{ amount, to: params.to }],
    padding,
    emptyPadding: params.emptyPadding,
    extAmount: amount,
  });
  return {
    ...prepared,
    instruction: buildTransactV2Instruction(prepared.args, { signer: params.depositor, screener: params.config.screener, counterparty: params.source ?? null, programId: params.programId }),
  };
}

// ---- spends ----

/** A relayer's terms for one transaction: its v2 address and its fee in the transaction's asset. */
export interface RelayerTermsV2 {
  address: ShieldedAddressV2;
  /** Base units of the transaction's asset, paid as a note. */
  fee: bigint;
}

export interface SpendContextV2 {
  prover: Prover<CircuitInputV2>;
  keys: LochKeysV2;
  state: WalletStateV2;
  tree?: MerkleTree;
  /** The relayer and its fee. Omit for a transaction the wallet submits itself (no fee note). */
  relayer?: RelayerTermsV2;
  /** The most the caller agrees to pay, from the user or the application, never from the relayer. Required with `relayer`. */
  maxFee?: bigint;
}

export interface PreparedSpendV2 extends PreparedTransactV2 {
  /** The wallet's notes this spends. Treat them as unavailable until the next sync. */
  spent: OwnedNoteV2[];
}

function agreedFee(context: SpendContextV2): bigint {
  if (!context.relayer) return 0n;
  const fee = assertAmount(context.relayer.fee, "fee");
  if (typeof context.maxFee !== "bigint") throw new LochError("INVALID_ARGUMENT", "maxFee is required with a relayer");
  if (fee > assertAmount(context.maxFee, "maxFee")) throw new FeeTooHighError(fee, context.maxFee);
  return fee;
}

async function prepareSpendV2(
  context: SpendContextV2,
  mint: PublicKey,
  notes: OwnedNoteV2[],
  outputs: OutputRequestV2[],
  extAmount: bigint,
  extra: Pick<PrepareTransactV2Params, "recipient" | "swap">,
): Promise<PreparedSpendV2> {
  const programId = new PublicKey(context.state.programId);
  assertStateV2Matches(context.state, context.keys, programId);
  const tree = context.tree ?? treeFromStateV2(context.state);
  if (tree.size !== context.state.leaves.length) throw new LochError("STALE_STATE", "the tree does not belong to this wallet state; sync again");
  const fee = agreedFee(context);
  const all = outputs.filter((output) => output.amount > 0n);
  let feeOutput: number | undefined;
  if (fee > 0n) {
    feeOutput = all.length;
    all.push({ amount: fee, to: context.relayer!.address });
  }
  const prepared = await prepareTransactV2({
    prover: context.prover,
    root: tree.root,
    mint,
    spendKeys: context.keys,
    inputs: notes.map((note) => ({ note, d: note.d, leafIndex: note.leafIndex, pathElements: tree.path(note.leafIndex).pathElements })),
    outputs: all,
    padding: mainAddress(context.keys),
    own: context.keys,
    extAmount,
    feeOutput,
    ...extra,
  });
  return { ...prepared, spent: notes };
}

/**
 * A private transfer of `amount` of `mint` to a v2 address or payment code.
 * Nothing about sender, recipient, amount or asset appears on chain.
 */
export async function prepareTransferV2(params: SpendContextV2 & { mint: PublicKey; to: ShieldedAddressV2 | PaymentCodeV2; amount: bigint }): Promise<PreparedSpendV2> {
  const amount = assertAmount(params.amount);
  if (amount === 0n) throw new LochError("INVALID_ARGUMENT", "a transfer amount must be positive");
  const fee = agreedFee(params);
  const notes = selectNotesV2(unspentNotesV2(params.state), params.mint, amount + fee);
  const change = notes.reduce((s, n) => s + n.amount, 0n) - amount - fee;
  return prepareSpendV2(params, params.mint, notes, [{ amount, to: params.to }, { amount: change, to: mainAddress(params.keys) }], 0n, {});
}

/**
 * A withdrawal ("surface") of `amount` of `mint` to `recipient`: a system
 * account for SOL, a token account of the mint otherwise. The recipient, the
 * asset and the amount are public.
 */
export async function prepareWithdrawalV2(
  params: SpendContextV2 & { mint: PublicKey; recipient: PublicKey; amount: bigint; rent?: { lamports: bigint; rentExemptMinimum: bigint } },
): Promise<PreparedSpendV2> {
  const amount = assertAmount(params.amount);
  if (amount === 0n || amount > I64_MAX) throw new LochError("INVALID_ARGUMENT", "a withdrawal amount must be between 1 and 2^63 - 1");
  if (isNativeMint(params.mint)) {
    const { lamports, rentExemptMinimum } = params.rent ?? { lamports: 0n, rentExemptMinimum: SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM };
    if (lamports + amount < rentExemptMinimum) throw new LochError("RECIPIENT_BELOW_RENT_EXEMPT", `the recipient would hold less than the rent-exempt minimum (${rentExemptMinimum} lamports)`);
  }
  const fee = agreedFee(params);
  const notes = selectNotesV2(unspentNotesV2(params.state), params.mint, amount + fee);
  const change = notes.reduce((s, n) => s + n.amount, 0n) - amount - fee;
  return prepareSpendV2(params, params.mint, notes, [{ amount: change, to: mainAddress(params.keys) }], -amount, { recipient: params.recipient });
}

/**
 * A swap inside the pool: spends `amountIn` of `inputMint` (plus the relayer's
 * fee, in the input asset), and the program finishes a note of `outputMint`
 * worth what the router returns, at least `minAmountOut`, to the wallet's main
 * address. Public: the pair and both amounts. Not public: whose notes.
 */
export async function prepareSwapV2(
  params: SpendContextV2 & { inputMint: PublicKey; amountIn: bigint; outputMint: PublicKey; minAmountOut: bigint },
): Promise<PreparedSpendV2> {
  const amountIn = assertAmount(params.amountIn);
  if (amountIn === 0n || amountIn > I64_MAX) throw new LochError("INVALID_ARGUMENT", "a swap amount must be between 1 and 2^63 - 1");
  const fee = agreedFee(params);
  const notes = selectNotesV2(unspentNotesV2(params.state), params.inputMint, amountIn + fee);
  const change = notes.reduce((s, n) => s + n.amount, 0n) - amountIn - fee;
  return prepareSpendV2(params, params.inputMint, notes, [{ amount: change, to: mainAddress(params.keys) }], -amountIn, {
    swap: { outputMint: params.outputMint, minAmountOut: params.minAmountOut, to: mainAddress(params.keys) },
  });
}

/** Merges the two largest notes of `mint` into one (minus the relayer's fee). */
export async function prepareConsolidationV2(params: SpendContextV2 & { mint: PublicKey }): Promise<PreparedSpendV2> {
  const fee = agreedFee(params);
  const notes = consolidationCandidatesV2(unspentNotesV2(params.state), params.mint);
  if (notes.length < 2) throw new LochError("INVALID_ARGUMENT", "consolidation needs at least two unspent notes of the asset");
  const total = notes.reduce((s, n) => s + n.amount, 0n);
  if (total < fee) throw new LochError("INVALID_ARGUMENT", "the notes do not cover the fee");
  return prepareSpendV2(params, params.mint, notes, [{ amount: total - fee, to: mainAddress(params.keys) }], 0n, {});
}
