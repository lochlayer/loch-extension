// The flows of the v2 pool (docs/v2.md): dive in (SOL or a token), send privately, surface,
// combine notes, and swap. The same state machines as flows.ts, with the same two rules for
// every spend, which this file keeps for v2 notes:
//
//   1. One set of notes per flow. Once a flow has made a proof, every further proof spends
//      exactly the same notes; at most one of them can land. The notes are let go only when the
//      chain shows the earlier proofs dead.
//   2. The chain decides, not the relayer. "Sent" is recorded when a sync shows the flow's
//      outputs in the v2 tree and its notes spent.
//
// What differs from v1: a transaction is in one asset (`mint`) and pays the relayer with a note
// in that asset, so the relayer's terms are per asset; a deposit is always a version-1
// transaction (every v2 output carries a 103-byte note, and the pool's lookup table names v1
// accounts only), with the padding outputs left empty; a swap is a spend whose output the
// program finishes on chain, at least `minOut` of `toMint`.

import { base58 } from "@scure/base";
import {
  ConsolidationRequiredError,
  DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  FeeTooHighError,
  InsufficientBalanceError,
  LochError,
  PROGRAM_ID,
  type AnyTransaction,
  TransactionV1,
  WireError,
  applyScreenerSignature,
  buildTransactTransaction,
  buildTransactionV1,
  deserializeTransaction,
  parseProgramError,
  toScreenRequest,
} from "@loch/sdk";
import {
  NATIVE_MINT as NATIVE_MINT_KEY,
  type OwnedNoteV2,
  type PreparedSpendV2,
  associatedTokenAddress,
  buildTransactV2Instruction,
  decodeAddressV2,
  decodeAnyRecipient,
  decodeTransactArgsV2,
  encodeAddressV2 as encodeAddress,
  encodeTransactArgsV2,
  fetchAssetConfig,
  fetchPoolConfigV2,
  fetchTreeV2Account,
  inspectDepositTransactionV2,
  prepareConsolidationV2,
  prepareDepositV2,
  prepareSwapV2,
  prepareTransferV2,
  prepareWithdrawalV2,
  selectNotesV2,
  toRelayRequestV2,
  unspentNotesV2,
} from "@loch/sdk/v2";
import { type AddressLookupTableAccount, PublicKey, type VersionedTransaction } from "@solana/web3.js";

import { NATIVE_MINT, assetMeta, isNative } from "../shared/assets.js";
import { bytesEqual, fromBase64, toBase64 } from "../shared/bytes.js";
import { SYSTEM_RENT_MINIMUM, chainOf } from "../shared/constants.js";
import { depositCosts } from "./rent.js";
import { addActivity, setActivityStatus } from "./activity.js";
import { type Core, type DiveRecord, type FlowProof, type SpendRecord, fail } from "./core.js";
import { ask, base, begin, poolTable, synced, unlocked, unsignedCopy, wireDetail, wireReason } from "./flows.js";
import { type Chain, assertAllowedCluster, readCluster } from "./network.js";
import { chainRootsOf, proofExpired } from "./pending.js";
import { type PendingSpendV2, hasLandedV2, inputSpentV2, onlyNotesV2, spendableNotesV2, withLocksV2 } from "./pendingV2.js";
import { storePublicBalance } from "./publicBalance.js";
import type { WalletRuntime } from "./store.js";
import { syncWalletNow } from "./sync.js";

const CONFIRM_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_MS = 1_200;
const SPEND_CONFIRM_MS = 30_000;
const SPEND_POLL_MS = 1_500;
const MAX_REPROVES = 2;
/** SPL Token account layout: amount at 64, mint at 0, owner at 32. */
const TOKEN_ACCOUNT_LEN = 165;

// ------------------------------------------------------------------ starting

export async function startDiveV2(core: Core, amount: bigint, mint: string): Promise<void> {
  const runtime = await unlocked(core);
  new PublicKey(mint);
  const flow: DiveRecord = {
    ...base(core, "dive", runtime.address, "checking"),
    kind: "dive",
    address: runtime.address,
    walletName: runtime.walletName,
    connectUrl: (await core.settings()).connectUrl,
    amount: amount.toString(),
    pool: 2,
    mint,
  };
  await begin(core, flow);
}

export interface SpendInputV2 {
  to?: string;
  amount: bigint;
  fee: bigint;
  mint: string;
  /** A swap. */
  toMint?: string;
  minOut?: bigint;
}

/** The most this wallet pays a relayer in `mint`: the settings' limit for SOL, the asset table's for a token. */
export async function feeCap(core: Core, mint: string): Promise<bigint> {
  if (isNative(mint)) return BigInt((await core.settings()).maxFeeLamports);
  const cluster = (await core.view((await core.store.active()) ?? "")).cluster;
  return BigInt(assetMeta(cluster, mint).maxFee);
}

export async function startSpendV2(core: Core, kind: SpendRecord["kind"], input: SpendInputV2): Promise<void> {
  const runtime = await unlocked(core);
  new PublicKey(input.mint);
  if (kind === "send" && decodeAnyRecipient(input.to ?? "").version !== 2) throw new LochError("INVALID_ARGUMENT", "address:v1");
  if (kind === "surface") new PublicKey(input.to ?? "");
  if (kind === "swap") {
    if (!input.toMint || input.toMint === input.mint || input.minOut === undefined || input.minOut <= 0n) throw new LochError("INVALID_ARGUMENT", "swap");
    new PublicKey(input.toMint);
  }
  if (input.fee > (await feeCap(core, input.mint))) throw new LochError("INVALID_ARGUMENT", "fee:above-limit");
  const flow: SpendRecord = {
    ...base(core, kind, runtime.address, "checking"),
    kind,
    address: runtime.address,
    pool: 2,
    mint: input.mint,
    amount: kind === "consolidate" ? "0" : input.amount.toString(),
    fee: input.fee.toString(),
    reproved: 0,
    ...(kind === "send" || kind === "surface" ? { to: input.to } : {}),
    ...(kind === "send" && input.to ? payeeOfV2(input.to) : {}),
    ...(kind === "swap" ? { toMint: input.toMint, minOut: input.minOut!.toString() } : {}),
  };
  await begin(core, flow);
}

/** For a payment code: the address inside it, which is what is shown and remembered. */
function payeeOfV2(to: string): { payee?: string } {
  try {
    const decoded = decodeAnyRecipient(to);
    if (decoded.version !== 2 || !("secret" in decoded.recipient)) return {};
    const { d, owner, pk } = decoded.recipient;
    return { payee: encodeAddress({ d, owner, pk }) };
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------- dive in

/** A token account's amount, mint and owner, or null when it is none. */
async function tokenAccount(chain: Chain, address: PublicKey): Promise<{ amount: bigint; mint: string; owner: string } | null> {
  const info = await chain.connection.getAccountInfo(address, "confirmed");
  if (!info || info.data.length !== TOKEN_ACCOUNT_LEN || info.owner.toBase58() !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") return null;
  const data = new Uint8Array(info.data);
  const view = new DataView(data.buffer, data.byteOffset);
  return { mint: base58.encode(data.subarray(0, 32)), owner: base58.encode(data.subarray(32, 64)), amount: view.getBigUint64(64, true) };
}

export async function stepDiveV2(core: Core, flow: DiveRecord): Promise<void> {
  const { settings, chain } = await core.chain();
  const runtime = await core.store.runtime(flow.address);
  if (!runtime) throw fail("locked");
  const amount = BigInt(flow.amount);
  const mint = new PublicKey(flow.mint ?? NATIVE_MINT);
  const native = mint.equals(NATIVE_MINT_KEY);
  const depositor = new PublicKey(flow.address);

  switch (flow.step) {
    case "checking": {
      const cluster = await readCluster(chain.connection);
      assertAllowedCluster(cluster);
      const [config, asset] = await Promise.all([fetchPoolConfigV2(chain.connection), fetchAssetConfig(chain.connection, mint)]);
      if (config.paused || !asset.depositsEnabled) throw fail("deposits-paused");
      if (amount > asset.maxDeposit) throw fail("above-max", { limit: asset.maxDeposit.toString() });
      const balance = BigInt(await chain.connection.getBalance(depositor, "confirmed"));
      await core.patchView(flow.address, { cluster: cluster.cluster });
      await storePublicBalance(core, flow.address, balance);
      const costs = await depositCosts(chain, settings.rpcUrl);
      flow.overhead = costs.overhead.toString();
      const lamportsNeeded = (native ? amount : 0n) + costs.overhead + costs.minimum;
      if (balance < lamportsNeeded) throw fail("insufficient-public", { amount: balance.toString(), limit: lamportsNeeded.toString() });
      if (!native) {
        // The tokens come from the depositor's associated token account; reading it says nothing the deposit will not.
        const source = associatedTokenAddress(depositor, mint);
        const held = await tokenAccount(chain, source);
        if (!held || held.mint !== mint.toBase58() || held.owner !== depositor.toBase58() || held.amount < amount) {
          throw fail("insufficient-public", { amount: (held?.amount ?? 0n).toString(), limit: amount.toString() });
        }
        flow.source = source.toBase58();
      }
      let info;
      try {
        info = await core.env.screener(settings, chain).info();
      } catch (error) {
        throw fail("screener-unreachable", { retry: true, detail: wireDetail(settings.screenerUrl, error), ...wireReason(error) });
      }
      if (info.screener !== config.screener.toBase58() || info.programId !== PROGRAM_ID.toBase58() || info.cluster !== cluster.cluster) throw fail("screener-mismatch");
      // The v2 pool's own table, for a wallet that signs version 0 only.
      if (info.lookupTableV2) flow.lookupTable = info.lookupTableV2;
      else delete flow.lookupTable;
      await core.enter(flow, flow.data ? "screening" : "proving");
      return;
    }
    case "proving": {
      const [config, asset, tree] = await Promise.all([fetchPoolConfigV2(chain.connection), fetchAssetConfig(chain.connection, mint), fetchTreeV2Account(chain.connection)]);
      const prepared = await prepareDepositV2({
        prover: core.env.proverV2,
        keys: runtime.v2.keys,
        mint,
        amount,
        depositor,
        source: flow.source ? new PublicKey(flow.source) : undefined,
        root: tree.root,
        config,
        asset,
        // The zero-amount padding notes nobody looks for: their bytes are left out.
        emptyPadding: true,
      });
      flow.data = toBase64(encodeTransactArgsV2(prepared.args));
      flow.outputs = prepared.outputs.map((output) => output.commitment.toString());
      runtime.ownOutputs.push(...flow.outputs);
      await core.store.saveState(runtime);
      await core.enter(flow, "screening");
      return;
    }
    case "screening": {
      if (!flow.data) throw fail("internal");
      // Version 1 when the wallet signs it; version 0 with the v2 pool's table otherwise (without
      // the table a v2 deposit is a few bytes over what version 0 holds).
      if (flow.legacyTransaction && !flow.lookupTable) throw fail("wallet-unsupported", { detail: "the screening service has no lookup table for version 0 deposits into the new pool" });
      const config = await fetchPoolConfigV2(chain.connection);
      const args = decodeTransactArgsV2(fromBase64(flow.data));
      const instruction = buildTransactV2Instruction(args, { signer: depositor, screener: config.screener, counterparty: flow.source ? new PublicKey(flow.source) : null });
      const { blockhash, lastValidBlockHeight } = await chain.connection.getLatestBlockhash("confirmed");
      const table = flow.legacyTransaction ? await poolTable(chain, flow.lookupTable) : null;
      const transaction: AnyTransaction = table
        ? buildTransactTransaction({ instruction, payer: depositor, recentBlockhash: blockhash, lookupTable: table, loadedAccountsDataSizeLimit: DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT })
        : buildTransactionV1({ instructions: [instruction], payer: depositor, recentBlockhash: blockhash, loadedAccountsDataSizeLimit: DEPOSIT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT });
      delete flow.walletSigned;
      await simulateDepositV2(chain, transaction, flow);
      try {
        applyScreenerSignature(transaction, await core.env.screener(settings, chain).screen(toScreenRequest(transaction)));
      } catch (error) {
        throw screeningFailureV2(settings.screenerUrl, error);
      }
      flow.unsigned = toBase64(transaction.serialize());
      flow.lastValidBlockHeight = lastValidBlockHeight;
      delete flow.signed;
      const cluster = await readCluster(chain.connection);
      await core.enter(flow, "signing");
      // The wallet is shown the deposit with every signature slot empty (Phantom warns about one signed before it).
      const bare = toBase64(unsignedCopy(transaction).serialize());
      await ask(core, flow, { kind: "signTransaction", wallet: flow.walletName, address: flow.address, transaction: bare, chain: chainOf(cluster.cluster) });
      return;
    }
    case "signing":
      await core.enter(flow, "screening");
      return;
    case "cosigning": {
      if (!flow.unsigned || !flow.walletSigned) throw fail("internal");
      const config = await fetchPoolConfigV2(chain.connection);
      const ours = deserializeTransaction(fromBase64(flow.unsigned));
      const theirs = deserializeTransaction(fromBase64(flow.walletSigned));
      const table = flow.legacyTransaction ? await poolTable(chain, flow.lookupTable) : null;
      const problem = walletAdditionsProblemV2(ours, theirs, config.screener, table);
      if (problem) throw fail("wallet-changed-transaction", { retry: true, detail: problem });
      try {
        applyScreenerSignature(theirs, await core.env.screener(settings, chain).screen(toScreenRequest(theirs)));
      } catch (error) {
        throw screeningFailureV2(settings.screenerUrl, error);
      }
      flow.signed = toBase64(theirs.serialize());
      flow.signature = base58.encode(theirs.signatures[0]!);
      delete flow.walletSigned;
      await core.enter(flow, "sending");
      return;
    }
    case "sending": {
      if (!flow.signed || !flow.outputs) throw fail("internal");
      const now = core.env.now();
      if (!runtime.v2.pending.some((entry) => entry.flowId === flow.id)) {
        runtime.v2.pending.push({ flowId: flow.id, kind: "dive", mint: mint.toBase58(), inputs: [], outputs: flow.outputs, leaving: "0", arriving: flow.amount, createdAt: now, outcome: "unknown" });
        await core.store.saveState(runtime);
      }
      runtime.activity = addActivity(runtime.activity, { id: flow.id, kind: "dive", status: "submitted", at: now, amount: flow.amount, counterparty: flow.address, pool: 2, ...(native ? {} : { mint: mint.toBase58() }) });
      await core.store.saveActivity(runtime);
      try {
        flow.signature = await chain.connection.sendRawTransaction(fromBase64(flow.signed), { preflightCommitment: "confirmed", maxRetries: 3 });
      } catch (error) {
        if (flow.signature && /already (been )?processed/i.test(error instanceof Error ? error.message : "")) {
          await core.enter(flow, "confirming");
          return;
        }
        const program = parseProgramError(error);
        await releasePendingV2(core, runtime, flow.id, "failed");
        if (program?.kind === "UnknownRoot") {
          delete flow.data;
          delete flow.outputs;
          throw fail("stale-root", { retry: true });
        }
        if (program) throw fail("transaction-failed", { detail: program.kind });
        throw fail("rpc-unreachable", { moved: "unknown", retry: true });
      }
      runtime.activity = setActivityStatus(runtime.activity, flow.id, "submitted", flow.signature);
      await core.store.saveActivity(runtime);
      await core.enter(flow, "confirming");
      return;
    }
    case "confirming": {
      if (!flow.signature) throw fail("internal");
      const deadline = core.env.now() + CONFIRM_TIMEOUT_MS;
      for (;;) {
        const { value } = await chain.connection.getSignatureStatuses([flow.signature]);
        const status = value[0];
        if (status && status.err) {
          await releasePendingV2(core, runtime, flow.id, "failed");
          const parsed = parseProgramError({ err: status.err, logs: [] });
          throw fail("transaction-failed", { detail: parsed ? parsed.kind : "the program rejected the deposit" });
        }
        if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) break;
        if (!status && flow.lastValidBlockHeight !== undefined && (await chain.connection.getBlockHeight("confirmed")) > flow.lastValidBlockHeight) {
          await releasePendingV2(core, runtime, flow.id, "failed");
          throw fail("expired", { retry: true });
        }
        if (core.env.now() > deadline) throw fail("not-confirmed", { moved: "unknown", detail: flow.signature });
        await core.saveFlow(flow);
        await core.env.sleep(CONFIRM_POLL_MS);
      }
      runtime.activity = setActivityStatus(runtime.activity, flow.id, "confirmed", flow.signature);
      await core.store.saveActivity(runtime);
      await syncWalletNow(core, flow.address);
      try {
        await storePublicBalance(core, flow.address, BigInt(await chain.connection.getBalance(depositor, "confirmed")));
      } catch {
        // The balance shown keeps the time it was read at.
      }
      await core.enter(flow, "done", "done");
      return;
    }
    default:
      throw fail("internal");
  }
}

async function simulateDepositV2(chain: Chain, transaction: AnyTransaction, flow: DiveRecord): Promise<void> {
  let result;
  try {
    result = await chain.connection.simulateTransaction(transaction as VersionedTransaction, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
  } catch {
    return;
  }
  const { err, logs } = result.value;
  if (!err) return;
  const program = parseProgramError({ err, logs: logs ?? [] });
  if (program?.kind === "UnknownRoot") {
    delete flow.data;
    delete flow.outputs;
    throw fail("stale-root", { retry: true });
  }
  if (program?.kind === "DepositsPaused" || program?.kind === "AssetDepositsDisabled") throw fail("deposits-paused");
  if (program?.kind === "DepositTooLarge") throw fail("above-max");
  if (program) throw fail("transaction-failed", { detail: program.kind });
  if (err === "BlockhashNotFound") throw fail("expired", { retry: true });
  if (err === "AccountNotFound" || err === "InsufficientFundsForFee") throw fail("insufficient-public");
  throw fail("transaction-failed", { detail: JSON.stringify(err).slice(0, 140) });
}

function screeningFailureV2(url: string, error: unknown) {
  if (!(error instanceof WireError)) return fail("screener-unreachable", { retry: true });
  switch (error.code) {
    case "denied":
      return fail("screening-denied");
    case "deposits_paused":
      return fail("deposits-paused");
    case "too_large":
      return fail("above-max");
    case "network_error":
    case "unavailable":
    case "rate_limited":
      return fail("screener-unreachable", { retry: true, detail: wireDetail(url, error), ...wireReason(error) });
    default:
      return fail("screener-refused", { retry: error.code === "internal" || error.code === "bad_response", detail: wireDetail(url, error) });
  }
}

/** The wallet may add assertions and change the compute budget; the deposit itself, byte for byte, it may not change. */
function walletAdditionsProblemV2(ours: AnyTransaction, theirs: AnyTransaction, screener: PublicKey, table: AddressLookupTableAccount | null): string | null {
  if (theirs.message.version !== ours.message.version) return "the wallet changed the transaction's version";
  if (theirs.message.recentBlockhash !== ours.message.recentBlockhash) return "the wallet changed the blockhash";
  const before = inspectDepositTransactionV2(ours, { screener, lookupTable: table });
  const after = inspectDepositTransactionV2(theirs, { screener, lookupTable: table });
  if (!before.ok) return before.error.message;
  if (!after.ok) return after.error.message;
  if (!after.value.depositor.equals(before.value.depositor)) return "the wallet changed the fee payer";
  if (!bytesEqual(encodeTransactArgsV2(after.value.args), encodeTransactArgsV2(before.value.args))) return "the wallet changed the deposit";
  if (!after.value.mint.equals(before.value.mint) || (after.value.source?.toBase58() ?? null) !== (before.value.source?.toBase58() ?? null)) return "the wallet changed an account of the deposit";
  return null;
}

// --------------------------------------------- send, surface, combine, swap

export async function releasePendingV2(core: Core, runtime: WalletRuntime, flowId: string, activity: "failed" | "keep"): Promise<void> {
  const before = runtime.v2.pending.length;
  runtime.v2.pending = runtime.v2.pending.filter((entry) => entry.flowId !== flowId);
  if (runtime.v2.pending.length !== before) await core.store.saveState(runtime);
  if (activity === "failed" && runtime.activity.some((item) => item.id === flowId && item.status !== "confirmed")) {
    runtime.activity = setActivityStatus(runtime.activity, flowId, "failed");
    await core.store.saveActivity(runtime);
  }
}

function everyOutput(flow: SpendRecord): string[] {
  return flow.proofs && flow.proofs.length > 0 ? flow.proofs.flatMap((proof) => proof.outputs) : (flow.outputs ?? []);
}

export function landedV2(runtime: WalletRuntime, flow: SpendRecord): boolean {
  if (!flow.inputs || flow.inputs.length === 0) return false;
  return hasLandedV2({ inputs: flow.inputs, outputs: everyOutput(flow) }, runtime.v2.state);
}

export function notesSpentV2(runtime: WalletRuntime, flow: SpendRecord): boolean {
  return flow.inputs !== undefined && inputSpentV2({ inputs: flow.inputs }, runtime.v2.state);
}

function feePaid(runtime: WalletRuntime, flow: SpendRecord): string {
  const leaves = new Set(runtime.v2.state.leaves);
  const proof = flow.proofs?.find((item) => item.outputs.some((commitment) => leaves.has(commitment)));
  return proof?.fee ?? flow.fee;
}

function spendActivity(runtime: WalletRuntime, flow: SpendRecord, status: "confirmed" | "unknown", at: number) {
  const mint = flow.mint ?? NATIVE_MINT;
  return {
    id: flow.id,
    kind: flow.kind,
    status,
    at,
    amount: flow.amount,
    fee: feePaid(runtime, flow),
    pool: 2 as const,
    ...(isNative(mint) ? {} : { mint }),
    ...(flow.toMint ? { toMint: flow.toMint } : {}),
    ...(flow.to ? { counterparty: flow.payee ?? flow.to } : {}),
    ...(status === "confirmed" && flow.signature ? { signature: flow.signature } : {}),
  } as const;
}

function forgetProofs(flow: SpendRecord): void {
  delete flow.requestV2;
  delete flow.inputs;
  delete flow.outputs;
  delete flow.proofs;
  delete flow.handed;
  delete flow.signature;
}

export async function letGoV2(core: Core, runtime: WalletRuntime, flow: SpendRecord, activity: "failed" | "keep"): Promise<void> {
  await releasePendingV2(core, runtime, flow.id, activity);
  forgetProofs(flow);
}

async function reserve(core: Core, runtime: WalletRuntime, flow: SpendRecord): Promise<void> {
  if (!flow.inputs) return;
  const fee = BigInt(flow.fee);
  const leaving = flow.kind === "consolidate" ? fee : BigInt(flow.amount) + fee;
  const existing = runtime.v2.pending.find((entry) => entry.flowId === flow.id);
  const most = existing && BigInt(existing.leaving) > leaving ? BigInt(existing.leaving) : leaving;
  const entry: PendingSpendV2 = {
    flowId: flow.id,
    kind: flow.kind,
    mint: flow.mint ?? NATIVE_MINT,
    inputs: flow.inputs,
    outputs: everyOutput(flow),
    leaving: most.toString(),
    arriving: "0",
    createdAt: existing?.createdAt ?? core.env.now(),
    outcome: "unknown",
    proofs: (flow.proofs ?? []).map(({ root, leaves, fee: paid }) => ({ root, leaves, fee: paid })),
    entry: { amount: flow.amount, fee: fee.toString(), ...(flow.to ? { counterparty: flow.payee ?? flow.to } : {}), ...(flow.mint && !isNative(flow.mint) ? { mint: flow.mint } : {}) },
  };
  runtime.v2.pending = [...runtime.v2.pending.filter((item) => item.flowId !== flow.id), entry];
  await core.store.saveState(runtime);
}

export async function succeedV2(core: Core, runtime: WalletRuntime, flow: SpendRecord): Promise<void> {
  runtime.activity = addActivity(runtime.activity, spendActivity(runtime, flow, "confirmed", core.env.now()));
  await core.store.saveActivity(runtime);
  if (runtime.v2.pending.some((entry) => entry.flowId === flow.id)) await releasePendingV2(core, runtime, flow.id, "keep");
  await core.enter(flow, "done", "done");
}

export async function recordUnknownV2(core: Core, runtime: WalletRuntime, flow: SpendRecord): Promise<void> {
  runtime.activity = addActivity(runtime.activity, spendActivity(runtime, flow, "unknown", core.env.now()));
  await core.store.saveActivity(runtime);
}

function sameNotes(notes: readonly OwnedNoteV2[], commitments: readonly string[]): boolean {
  return notes.length === commitments.length && notes.every((note) => commitments.includes(note.commitment.toString()));
}

async function earlierProofs(chain: Chain, runtime: WalletRuntime, flow: SpendRecord): Promise<"none" | "landed" | "dead" | "bound"> {
  if (!flow.inputs || !flow.proofs || flow.proofs.length === 0) return "none";
  if (landedV2(runtime, flow)) return "landed";
  if (notesSpentV2(runtime, flow)) return "dead";
  const roots = chainRootsOf(await fetchTreeV2Account(chain.connection));
  return flow.proofs.every((proof) => proofExpired(proof, roots)) ? "dead" : "bound";
}

export async function stepSpendV2(core: Core, flow: SpendRecord): Promise<void> {
  const { settings, chain } = await core.chain();
  const runtime = await core.store.runtime(flow.address);
  if (!runtime) throw fail("locked");
  const amount = BigInt(flow.amount);
  const agreed = BigInt(flow.fee);
  const mint = flow.mint ?? NATIVE_MINT;
  const cap = await feeCap(core, mint);
  const relayer = core.env.relayerV2(settings, chain);

  switch (flow.step) {
    case "checking": {
      const cluster = await readCluster(chain.connection);
      assertAllowedCluster(cluster);
      const sync = await syncWalletNow(core, flow.address);
      if (!synced(sync)) throw fail(sync.status === "mainnet" ? "mainnet" : "sync-failed", { retry: true, detail: sync.detail });
      const earlier = await earlierProofs(chain, runtime, flow);
      if (earlier === "landed") {
        await succeedV2(core, runtime, flow);
        return;
      }
      if (earlier === "dead") await letGoV2(core, runtime, flow, "keep");

      let info;
      try {
        info = await relayer.info();
      } catch (error) {
        throw fail("relayer-unreachable", { retry: true, detail: wireDetail(settings.relayerUrl, error), ...wireReason(error) });
      }
      if (info.programId !== PROGRAM_ID.toBase58() || info.genesisHash !== cluster.genesisHash || info.cluster !== cluster.cluster) throw fail("relayer-mismatch");
      const asked = info.fees[mint];
      if (asked === undefined) throw fail("asset-not-taken");
      let fee = BigInt(asked);
      // A token surfaced to a wallet with no account for it: the relayer creates the account, and
      // asks for its rent on top. The destination is public on chain once surfaced.
      const surcharge = flow.kind === "surface" && !isNative(mint) ? info.accountFees?.[mint] : undefined;
      if (surcharge !== undefined) {
        const account = associatedTokenAddress(new PublicKey(flow.to ?? ""), new PublicKey(mint));
        if ((await chain.connection.getAccountInfo(account, "confirmed")) === null) fee += BigInt(surcharge);
      }
      if (fee > cap || agreed > cap) throw fail("fee-above-limit", { amount: (fee > cap ? fee : agreed).toString(), limit: cap.toString() });
      if (fee > agreed) throw fail("fee-changed", { amount: fee.toString(), limit: agreed.toString() });
      if (flow.kind === "swap" && !info.swaps) throw fail("swap-unavailable");
      if (flow.kind === "surface" && isNative(mint)) {
        const minimum = [SYSTEM_RENT_MINIMUM, BigInt(info.minWithdrawalLamports)].reduce((a, b) => (a > b ? a : b));
        if (amount < minimum) throw fail("below-minimum", { limit: minimum.toString() });
      }
      if (flow.inputs && flow.requestV2 && flow.relayer === info.relayer && BigInt(flow.requestV2.feeNote.amount) >= fee && BigInt(flow.requestV2.feeNote.amount) <= agreed) {
        await core.enter(flow, "sending");
        return;
      }
      delete flow.requestV2;
      flow.relayer = info.relayer;

      const others = runtime.v2.pending.filter((entry) => entry.flowId !== flow.id);
      const free = spendableNotesV2(runtime.v2.state, others, mint);
      const bound = flow.inputs;
      const candidates = bound ? free.filter((note) => bound.includes(note.commitment.toString())) : free;
      const held = candidates.reduce((sum, note) => sum + note.amount, 0n);
      if (flow.kind !== "consolidate") {
        const needed = amount + fee;
        let picked: OwnedNoteV2[];
        try {
          picked = selectNotesV2(candidates, new PublicKey(mint), needed);
        } catch (error) {
          if (bound) throw fail("reserved-short", { amount: held.toString(), limit: needed.toString() });
          if (error instanceof ConsolidationRequiredError) throw fail("consolidation-needed", { amount: needed.toString(), count: candidates.length });
          if (error instanceof InsufficientBalanceError) {
            const everything = unspentNotesV2(runtime.v2.state, new PublicKey(mint)).reduce((sum, note) => sum + note.amount, 0n);
            throw fail(everything >= needed ? "notes-busy" : "insufficient-shielded", { amount: error.available.toString(), limit: needed.toString() });
          }
          throw error;
        }
        if (bound && !sameNotes(picked, bound)) throw fail("reserved-short", { amount: held.toString(), limit: needed.toString() });
      } else if (bound ? candidates.length !== bound.length : candidates.length < 2) {
        throw fail(bound ? "reserved-short" : "insufficient-shielded");
      }
      await core.enter(flow, "proving");
      return;
    }
    case "proving": {
      if (!flow.relayer) throw fail("internal");
      const info = await relayer.info().catch((error: unknown) => {
        throw fail("relayer-unreachable", { retry: true, detail: wireDetail(settings.relayerUrl, error), ...wireReason(error) });
      });
      if (info.relayer !== flow.relayer || info.fees[mint] === undefined) {
        await core.enter(flow, "checking");
        return;
      }
      const fee = BigInt(info.fees[mint]!);
      const others = runtime.v2.pending.filter((entry) => entry.flowId !== flow.id);
      const locked = withLocksV2(runtime.v2.state, others);
      const state = flow.inputs ? onlyNotesV2(locked, flow.inputs) : locked;
      const context = {
        prover: core.env.proverV2,
        keys: runtime.v2.keys,
        state,
        tree: core.store.treeV2(runtime),
        relayer: { address: decodeAddressV2(info.address), fee },
        maxFee: agreed < cap ? agreed : cap,
      };
      const key = new PublicKey(mint);
      let prepared: PreparedSpendV2;
      try {
        prepared =
          flow.kind === "send"
            ? await prepareTransferV2({ ...context, mint: key, to: decodeAnyRecipient(flow.to ?? "").recipient as never, amount })
            : flow.kind === "surface"
              ? await prepareWithdrawalV2({ ...context, mint: key, recipient: isNative(mint) ? new PublicKey(flow.to ?? "") : associatedTokenAddress(new PublicKey(flow.to ?? ""), key), amount })
              : flow.kind === "swap"
                ? await prepareSwapV2({ ...context, inputMint: key, amountIn: amount, outputMint: new PublicKey(flow.toMint ?? ""), minAmountOut: BigInt(flow.minOut ?? "0") })
                : await prepareConsolidationV2({ ...context, mint: key });
      } catch (error) {
        if (error instanceof FeeTooHighError) throw fail("fee-changed", { amount: error.fee.toString(), limit: error.maxFee.toString() });
        throw error;
      }
      const spent = prepared.spent.map((note) => note.commitment.toString());
      if (spent.length === 0 || (flow.inputs && (spent.length !== flow.inputs.length || !spent.every((commitment) => flow.inputs!.includes(commitment))))) throw fail("reserved-short");
      const outputs = prepared.outputs.map((output) => output.commitment.toString());
      const proof: FlowProof = { outputs, root: prepared.publicInputs[0]!.toString(), leaves: runtime.v2.state.leaves.length, fee: fee.toString() };
      flow.requestV2 = {
        ...toRelayRequestV2(prepared),
        // A token surfaced to a wallet goes to its associated token account; the relayer creates it if it is missing.
        ...(flow.kind === "surface" && !isNative(mint) ? { recipientOwner: new PublicKey(flow.to ?? "").toBase58() } : {}),
      };
      flow.inputs ??= spent;
      flow.outputs = outputs;
      flow.proofs = [...(flow.proofs ?? []), proof];
      runtime.ownOutputs.push(...outputs);
      if (prepared.swapOutput) runtime.ownOutputs.push(`swap:${flow.id}:${prepared.swapOutput.inner}`);
      await reserve(core, runtime, flow);
      await core.enter(flow, "sending");
      return;
    }
    case "sending": {
      if (!flow.requestV2 || !flow.inputs) throw fail("internal");
      if (!runtime.v2.pending.some((entry) => entry.flowId === flow.id)) await reserve(core, runtime, flow);
      if (!flow.handed) {
        flow.handed = true;
        await core.saveFlow(flow);
      }
      let response;
      try {
        response = await relayer.relay(flow.requestV2);
      } catch (error) {
        await relayFailedV2(core, chain, runtime, flow, error);
        return;
      }
      flow.signature = response.signature;
      await core.enter(flow, "confirming");
      return;
    }
    case "confirming": {
      const deadline = flow.stepStartedAt + SPEND_CONFIRM_MS;
      for (;;) {
        const sync = await syncWalletNow(core, flow.address);
        if (landedV2(runtime, flow)) {
          await succeedV2(core, runtime, flow);
          return;
        }
        if (synced(sync) && notesSpentV2(runtime, flow)) {
          await letGoV2(core, runtime, flow, "failed");
          throw fail("nullifier-spent", { retry: true });
        }
        if (core.env.now() >= deadline) {
          const claimed = flow.signature;
          delete flow.signature;
          await recordUnknownV2(core, runtime, flow);
          throw fail("relayer-unconfirmed", { moved: "unknown", retry: true, detail: `${new URL(settings.relayerUrl).host} answered with transaction ${claimed ? `${claimed.slice(0, 8)}…` : "(none)"}` });
        }
        await core.saveFlow(flow);
        await core.env.sleep(SPEND_POLL_MS);
      }
    }
    default:
      throw fail("internal");
  }
}

/** The relayer answered with an error, or did not answer. The chain decides, as in v1 (flows.ts, relayFailed). */
async function relayFailedV2(core: Core, chain: Chain, runtime: WalletRuntime, flow: SpendRecord, error: unknown): Promise<void> {
  const settings = await core.settings();
  const code = error instanceof WireError ? error.code : "network_error";
  const detail = wireDetail(settings.relayerUrl, error);
  const sync = await syncWalletNow(core, flow.address);
  if (landedV2(runtime, flow)) {
    await succeedV2(core, runtime, flow);
    return;
  }
  if (synced(sync) && notesSpentV2(runtime, flow)) {
    await letGoV2(core, runtime, flow, "failed");
    throw fail("nullifier-spent", { retry: true });
  }
  if (code === "unknown_root") {
    delete flow.requestV2;
    if (flow.reproved < MAX_REPROVES) {
      flow.reproved++;
      await core.enter(flow, "checking");
      return;
    }
    await recordUnknownV2(core, runtime, flow);
    throw fail("stale-root", { retry: true, detail });
  }
  await recordUnknownV2(core, runtime, flow);
  switch (code) {
    case "network_error":
      throw fail("relayer-unreachable", { retry: true, detail, ...wireReason(error) });
    case "not_confirmed":
      throw fail("not-confirmed", { retry: true, detail });
    case "bad_response":
    case "internal":
    case "unavailable":
    case "rate_limited":
      throw fail("relayer-unavailable", { retry: true, detail });
    case "fee_note_invalid": {
      delete flow.requestV2;
      const info = await core.env.relayerV2(settings, chain).info().catch(() => null);
      const asked = info?.fees[flow.mint ?? NATIVE_MINT];
      if (asked === undefined) throw fail("asset-not-taken", { detail });
      throw fail("fee-changed", { amount: asked, limit: flow.fee, detail });
    }
    case "swap_unavailable":
      // The route or the price: a new quote and a new minimum are the user's to agree to.
      delete flow.requestV2;
      throw fail(/market moved/i.test(error instanceof WireError ? error.message : "") ? "price-moved" : "swap-unavailable", { detail });
    case "withdrawal_too_small":
      delete flow.requestV2;
      throw fail("below-minimum", { detail });
    case "invalid_proof":
      delete flow.requestV2;
      throw fail("proof-failed", { retry: true, detail });
    default:
      throw fail("relayer-refused", { detail: error instanceof WireError ? `${detail}: ${error.message.slice(0, 120)}` : detail });
  }
}

/** A v2 spend interrupted while its request was with the relayer: look at the chain. */
export async function resumeSendingV2(core: Core, runtime: WalletRuntime, flow: SpendRecord): Promise<void> {
  const sync = await syncWalletNow(core, flow.address);
  if (landedV2(runtime, flow)) {
    await succeedV2(core, runtime, flow);
  } else if (synced(sync) && notesSpentV2(runtime, flow)) {
    await letGoV2(core, runtime, flow, "failed");
    await core.failFlow(flow, { code: "nullifier-spent", moved: "no", retry: true });
  } else {
    await recordUnknownV2(core, runtime, flow);
    await core.failFlow(flow, { code: "interrupted", moved: "unknown", retry: true });
  }
}

export { fetchTreeV2Account };
