// The flows: unlock, dive in, send privately (and consolidate), surface. Collecting a claim
// link is a fifth, in claimFlow.ts; this file starts, drives and resumes it with the others.
//
// Each is a small state machine whose record lives in chrome.storage.session. A step is
// entered by writing the record, then doing the work, so that after a restart the worker knows
// which step was interrupted. `resumeFlow` holds the rules for that:
//
//   - nothing was sent yet (checking, proving, screening): do the step again; it is harmless
//   - waiting for the wallet: keep waiting; the answer arrives as a message and wakes the worker
//   - a request to the relayer was in flight: the outcome is unknown, so look at the chain
//     before saying anything
//   - a signed deposit was being sent or confirmed: send the same bytes again and keep polling
//
// Two rules hold for every spend (send privately, surface, consolidate), because a proof that
// was given to a relayer stays valid until its root leaves the program's root history, whatever
// the relayer answered:
//
//   1. One set of notes per flow. Once a flow has made a proof, every further proof it makes
//      spends exactly the same input notes. The proofs then share their nullifiers, so at most
//      one of them can ever land, whichever relayer sends it and whenever. The notes are let go
//      only when the chain shows that the earlier proofs are dead: one of the notes was spent by
//      something else, or every root they name has left the on-chain root history.
//   2. The chain decides, not the relayer. "Sent" is recorded only when a sync shows the flow's
//      output commitments in the tree and its notes spent. "Not sent" is never recorded on a
//      relayer's word: the notes stay reserved until rule 1 lets them go.
//
// The popup closes whenever the wallet opens its own window. None of this depends on it.

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import {
  ConsolidationRequiredError,
  FeeTooHighError,
  InsufficientBalanceError,
  KEY_DERIVATION_MESSAGE,
  LochError,
  PROGRAM_ID,
  WireError,
  applyScreenerSignature,
  buildTransactInstruction,
  buildTransactTransaction,
  claimKeys,
  createClaimSecret,
  decodeRecipient,
  decodeTransactArgs,
  encodeShieldedAddress,
  fetchPoolConfig,
  fetchTreeAccount,
  parseProgramError,
  prepareConsolidation,
  prepareDeposit,
  prepareTransfer,
  prepareWithdrawal,
  selectNotes,
  toRelayRequest,
  toScreenRequest,
  unspentNotes,
} from "@loch/sdk";
import type { OwnedNote } from "@loch/sdk";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

import { bytesEqual, fromBase64, randomToken, toBase64, utf8 } from "../shared/bytes.js";
import { DEPOSIT_OVERHEAD, SYSTEM_RENT_MINIMUM, chainOf } from "../shared/constants.js";
import type { BridgeAnswer, BridgeRequest, WalletInfo } from "../shared/messages.js";
import type { Failure, SyncView } from "../shared/view.js";
import { addActivity, setActivityStatus } from "./activity.js";
import { closeBridgeTab, ensureBridgeTab, pendingBridge, sendBridgeRequest } from "./bridge.js";
import { resumeClaim, stepClaim } from "./claimFlow.js";
import { BRIDGE_TTL_MS, type Core, type DiveRecord, FlowFailure, type FlowProof, type FlowRecord, type SpendRecord, type UnlockRecord, fail } from "./core.js";
import { type Chain, MainnetRefusedError, assertAllowedCluster, describeNetworkError, isNetworkFailure, readCluster } from "./network.js";
import { payeeOf } from "./paymentCode.js";
import { type PendingSpend, chainRootsOf, hasLanded, inputSpent, onlyNotes, proofExpired, spendableNotes, withLocks } from "./pending.js";
import { storePublicBalance } from "./publicBalance.js";
import { addRecord, recordOf } from "./records.js";
import type { WalletRuntime } from "./store.js";
import { syncWalletNow } from "./sync.js";
import { VaultError } from "./vault.js";

const CANCEL_KEY = "flow:cancel";
/** A wallet is usable when it can connect, sign the key-derivation message and sign a deposit. */
const REQUIRED_FEATURES = ["standard:connect", "solana:signMessage", "solana:signTransaction"];
const MAX_DISCOVERIES = 6;
const MAX_REPROVES = 2;
const CONFIRM_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_MS = 1_200;
/**
 * How long the chain gets to show a transfer the relayer says it sent. A relayer answers once
 * its own node has confirmed the transaction; the RPC endpoint this wallet reads may be a
 * moment behind that.
 */
const SPEND_CONFIRM_MS = 30_000;
const SPEND_POLL_MS = 1_500;

// ------------------------------------------------------------------ starting

export function base(core: Core, kind: FlowRecord["kind"], address: string | null, step: string) {
  const now = core.env.now();
  return { id: randomToken(), kind, address, status: "running" as const, step, stepStartedAt: now, createdAt: now, attempt: 1 };
}

export async function begin(core: Core, flow: FlowRecord): Promise<void> {
  const current = await core.flow();
  if (current && (current.status === "running" || current.status === "waiting")) {
    throw new LochError("INVALID_ARGUMENT", "another action is still in progress");
  }
  await core.env.session.remove(CANCEL_KEY);
  await core.saveFlow(flow);
  drive(core);
}

/** Connects a wallet (expected: null) or unlocks one this device already knows. */
export async function startUnlock(core: Core, expected: string | null): Promise<void> {
  const record = expected ? await core.store.wallet(expected) : null;
  if (expected && !record) throw new LochError("INVALID_ARGUMENT", "this device does not know that address");
  const flow: UnlockRecord = {
    ...base(core, "unlock", expected, "opening"),
    kind: "unlock",
    // Read once, here. The flow uses this address to the end, whatever the setting becomes.
    connectUrl: (await core.settings()).connectUrl,
    expected,
    walletName: record?.walletName ?? null,
    wallets: [],
    discoveries: 0,
    firstTime: record === null,
  };
  await begin(core, flow);
}

export async function unlocked(core: Core): Promise<WalletRuntime> {
  const address = await core.store.active();
  const runtime = address ? await core.store.runtime(address) : null;
  if (!runtime) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
  return runtime;
}

export async function startDive(core: Core, amount: bigint): Promise<void> {
  const runtime = await unlocked(core);
  const flow: DiveRecord = {
    ...base(core, "dive", runtime.address, "checking"),
    kind: "dive",
    address: runtime.address,
    walletName: runtime.walletName,
    connectUrl: (await core.settings()).connectUrl,
    amount: amount.toString(),
  };
  await begin(core, flow);
}

/**
 * `claim` (a send only): pay a new claim link instead of an address. The link's secret is made
 * here; the note is paid to the address of the keys that follow from it, and carries one relayer
 * fee on top of `amount`, so that whoever collects it ends up with `amount`.
 */
export async function startSpend(core: Core, kind: SpendRecord["kind"], input: { to?: string; amount: bigint; fee: bigint; claim?: boolean }): Promise<void> {
  const runtime = await unlocked(core);
  let claim: string | undefined;
  if (kind === "send" && input.claim) {
    const secret = createClaimSecret();
    claim = toBase64(secret);
    input = { ...input, to: encodeShieldedAddress(claimKeys(secret)), amount: input.amount + input.fee };
  }
  if (kind === "send") decodeRecipient(input.to ?? "");
  if (kind === "surface") new PublicKey(input.to ?? "");
  // The limit is the worker's to enforce, whatever the interface sent.
  const cap = BigInt((await core.settings()).maxFeeLamports);
  if (input.fee > cap) throw new LochError("INVALID_ARGUMENT", "fee:above-limit");
  const flow: SpendRecord = {
    ...base(core, kind, runtime.address, "checking"),
    kind,
    address: runtime.address,
    amount: kind === "consolidate" ? "0" : input.amount.toString(),
    fee: input.fee.toString(),
    reproved: 0,
    ...(kind === "consolidate" ? {} : { to: input.to }),
    // Paid to a payment code: the address in it, which is what the interface and the activity list are given.
    ...(kind === "send" && input.to && payeeOf(input.to) !== input.to ? { payee: payeeOf(input.to) } : {}),
    ...(claim ? { claim } : {}),
  };
  await begin(core, flow);
}

// ------------------------------------------------------------------- driving

/** Runs the current flow until it waits, fails or finishes. One runner at a time. */
export function drive(core: Core): Promise<void> {
  core.driving ??= run(core).finally(() => {
    core.driving = null;
  });
  return core.driving;
}

async function run(core: Core): Promise<void> {
  for (;;) {
    const flow = await core.flow();
    if (!flow || flow.status !== "running") return;
    try {
      await checkCancel(core, flow);
      if (flow.kind === "unlock") await stepUnlock(core, flow);
      else if (flow.kind === "dive") await stepDive(core, flow);
      else if (flow.kind === "claim") await stepClaim(core, flow);
      else await stepSpend(core, flow);
    } catch (error) {
      const failure = toFailure(error, flow, await core.settings());
      if (failure.code === "cancelled" && flow.kind === "dive") {
        // Nothing was sent.
        const runtime = await core.store.runtime(flow.address).catch(() => null);
        if (runtime) await releasePending(core, runtime, flow.id, "keep");
      }
      if (isSpend(flow)) {
        if (failure.code === "cancelled" && !flow.handed) {
          // Nothing ever left this device: the notes the proof would have spent are free again.
          const runtime = await core.store.runtime(flow.address).catch(() => null);
          if (runtime) await letGo(core, runtime, flow, "keep");
          else forgetProofs(flow);
        }
        open(flow, failure);
      }
      await core.failFlow(flow, failure);
    }
  }
}

function isSpend(flow: FlowRecord): flow is SpendRecord {
  return flow.kind === "send" || flow.kind === "surface" || flow.kind === "consolidate";
}

/**
 * While a request of the flow is with a relayer, no failure may say that nothing moved, and the
 * flow must stay retryable: trying again in the same flow is what keeps a second attempt on the
 * same notes.
 */
function open(flow: SpendRecord, failure: Failure): Failure {
  if (flow.handed) {
    failure.moved = "unknown";
    failure.retry = true;
  }
  return failure;
}

async function checkCancel(core: Core, flow: FlowRecord): Promise<void> {
  if ((await core.env.session.get<string>(CANCEL_KEY)) !== flow.id) return;
  await core.env.session.remove(CANCEL_KEY);
  throw fail("cancelled");
}

export function toFailure(error: unknown, flow: FlowRecord, settings: { rpcUrl: string; relayerUrl: string; screenerUrl: string }): Failure {
  if (error instanceof FlowFailure) return error.failure;
  if (error instanceof MainnetRefusedError) return { code: "mainnet", moved: "no", retry: false };
  if (error instanceof VaultError) return { code: error.reason === "wrong-key" ? "signature-changed" : "internal", moved: "no", retry: error.reason === "wrong-key" };
  if (error instanceof WireError) {
    const relayer = flow.kind !== "dive";
    const unreachable = error.code === "network_error" || error.code === "bad_response";
    return {
      code: relayer ? (unreachable ? "relayer-unreachable" : "relayer-refused") : unreachable ? "screener-unreachable" : "screener-refused",
      moved: "no",
      retry: unreachable,
      detail: wireDetail(relayer ? settings.relayerUrl : settings.screenerUrl, error),
      ...(error.reason ? { reason: error.reason } : {}),
    };
  }
  if (error instanceof FeeTooHighError) return { code: "fee-changed", moved: "no", retry: false, amount: error.fee.toString(), limit: error.maxFee.toString() };
  if (error instanceof LochError) {
    switch (error.code) {
      case "INSUFFICIENT_BALANCE":
        return { code: "insufficient-shielded", moved: "no", retry: false };
      case "CONSOLIDATION_REQUIRED":
        return { code: "consolidation-needed", moved: "no", retry: false };
      case "RECIPIENT_BELOW_RENT_EXEMPT":
        return { code: "below-minimum", moved: "no", retry: false, limit: SYSTEM_RENT_MINIMUM.toString() };
      case "DEPOSIT_TOO_LARGE":
        return { code: "above-max", moved: "no", retry: false };
      case "DEPOSITS_PAUSED":
        return { code: "deposits-paused", moved: "no", retry: false };
      case "ACCOUNT_NOT_FOUND":
        return { code: "pool-missing", moved: "no", retry: false };
      case "PROOF_FAILED":
        return { code: "proof-failed", moved: "no", retry: true, detail: error.message.slice(0, 160) };
      case "STALE_STATE":
        return { code: "stale-root", moved: "no", retry: true };
      default:
        return { code: "internal", moved: "no", retry: false, detail: `${error.code}: ${error.message.slice(0, 140)}` };
    }
  }
  if (isNetworkFailure(error)) return { code: "rpc-unreachable", moved: "no", retry: true, detail: describeNetworkError(settings.rpcUrl, error) };
  // An error this code does not know. Its message could hold anything, so only its name is kept.
  return { code: "internal", moved: "no", retry: false, detail: error instanceof Error ? error.name : "unknown error" };
}

// -------------------------------------------------------------------- unlock

function suitable(wallets: WalletInfo[]): WalletInfo[] {
  return wallets.filter((wallet) => REQUIRED_FEATURES.every((feature) => wallet.features.includes(feature)));
}

async function stepUnlock(core: Core, flow: UnlockRecord): Promise<void> {
  switch (flow.step) {
    case "opening":
      await ensureBridgeTab(core, flow);
      await core.enter(flow, "discovering");
      return;
    case "discovering":
      flow.discoveries++;
      await ask(core, flow, { kind: "wallets" });
      return;
    case "connecting":
      if (!flow.walletName) throw fail("internal");
      await ask(core, flow, { kind: "connect", wallet: flow.walletName, silent: false });
      return;
    case "signing":
    case "signing-again":
      if (!flow.walletName || !flow.address) throw fail("internal");
      await ask(core, flow, { kind: "signMessage", wallet: flow.walletName, address: flow.address, message: toBase64(utf8(KEY_DERIVATION_MESSAGE)) });
      return;
    case "syncing":
      if (flow.address) await syncWalletNow(core, flow.address);
      await core.enter(flow, "done", "done");
      return;
    default:
      throw fail("internal");
  }
}

/** Sends a request toward the wallet and leaves the flow waiting for the answer. */
async function ask(core: Core, flow: FlowRecord, request: BridgeRequest): Promise<void> {
  await sendBridgeRequest(core, flow, request);
  flow.status = "waiting";
  await core.saveFlow(flow);
}

function walletFailure(answer: Extract<BridgeAnswer, { ok: false }>): FlowFailure {
  const detail = answer.error.message || undefined;
  switch (answer.error.code) {
    case "rejected":
      return fail("wallet-rejected", { retry: true });
    case "no-wallet":
      return fail("wallet-missing", { retry: true });
    case "no-account":
      return fail("wrong-account", { retry: true });
    case "unsupported":
      return fail("wallet-unsupported", { detail });
    default:
      return fail("wallet-failed", { retry: true, detail });
  }
}

async function unlockAnswer(core: Core, flow: UnlockRecord, request: BridgeRequest, answer: BridgeAnswer): Promise<void> {
  if (request.kind === "wallets") {
    const wallets = answer.ok && answer.value.kind === "wallets" ? suitable(answer.value.wallets) : [];
    flow.wallets = wallets;
    if (wallets.length === 0) {
      if (flow.discoveries >= MAX_DISCOVERIES) throw fail("no-wallet", { retry: true });
      // Wallets register themselves a moment after the page loads. Look again.
      await core.env.sleep(600);
      await core.enter(flow, "discovering");
      return;
    }
    if (flow.walletName && wallets.some((wallet) => wallet.name === flow.walletName)) {
      await core.enter(flow, "connecting");
      return;
    }
    if (flow.expected && flow.walletName) throw fail("wallet-missing", { retry: true, detail: flow.walletName });
    flow.walletName = null;
    await core.enter(flow, "choosing", "waiting");
    return;
  }

  if (!answer.ok) throw walletFailure(answer);

  if (request.kind === "connect" && answer.value.kind === "connect") {
    const { accounts } = answer.value;
    const account = flow.expected ? accounts.find((item) => item.address === flow.expected) : accounts[0];
    if (!account) throw fail(flow.expected ? "wrong-account" : "wallet-failed", { retry: true });
    const publicKey = fromBase64(account.publicKey);
    if (publicKey.length !== 32 || base58.encode(publicKey) !== account.address) throw fail("wallet-failed", { retry: true, detail: "the wallet's address and public key disagree" });
    flow.address = account.address;
    flow.publicKey = account.publicKey;
    flow.firstTime = (await core.store.wallet(account.address)) === null;
    await core.enter(flow, "signing");
    return;
  }

  if (request.kind === "signMessage" && answer.value.kind === "signMessage") {
    if (!flow.address || !flow.publicKey || !flow.walletName) throw fail("internal");
    const signature = fromBase64(answer.value.signature);
    // The signature is checked here against the bytes Loch asked for, whatever the page says it signed.
    let valid = false;
    try {
      valid = signature.length === 64 && ed25519.verify(signature, utf8(KEY_DERIVATION_MESSAGE), fromBase64(flow.publicKey));
    } catch {
      valid = false;
    }
    if (!valid) throw fail("bad-signature");

    if (!flow.firstTime) {
      await core.store.unlock(flow.address, signature, flow.walletName);
    } else if (flow.step === "signing") {
      flow.first = answer.value.signature;
      await core.enter(flow, "signing-again");
      return;
    } else {
      // A wallet that signs the same message differently each time would derive other keys next
      // time, and the funds sent to these would look lost. Refuse to go on.
      if (flow.first === undefined || !bytesEqual(fromBase64(flow.first), signature)) throw fail("not-deterministic");
      await core.store.create(flow.address, flow.walletName, signature, core.env.now());
    }
    delete flow.first;
    await core.store.setActive(flow.address);
    await closeBridgeTab(core);
    await core.enter(flow, "syncing");
    return;
  }
  throw fail("wallet-failed", { retry: true });
}

/** The user picked one of the wallets found on the connect page. */
export async function chooseWallet(core: Core, name: string): Promise<void> {
  const flow = await core.flow();
  if (!flow || flow.kind !== "unlock" || flow.step !== "choosing" || flow.status !== "waiting") throw new LochError("INVALID_ARGUMENT", "no wallet is being chosen");
  if (!flow.wallets.some((wallet) => wallet.name === name)) throw new LochError("INVALID_ARGUMENT", "that wallet was not found on the connect page");
  flow.walletName = name;
  await core.enter(flow, "connecting");
  drive(core);
}

// ------------------------------------------------------------------- dive in

async function stepDive(core: Core, flow: DiveRecord): Promise<void> {
  const { settings, chain } = await core.chain();
  const runtime = await core.store.runtime(flow.address);
  if (!runtime) throw fail("locked");
  const amount = BigInt(flow.amount);
  const depositor = new PublicKey(flow.address);

  switch (flow.step) {
    case "checking": {
      const cluster = await readCluster(chain.connection);
      assertAllowedCluster(cluster);
      const config = await fetchPoolConfig(chain.connection);
      if (config.paused) throw fail("deposits-paused");
      if (amount > config.maxDeposit) throw fail("above-max", { limit: config.maxDeposit.toString() });
      // A deposit is public and comes from this address: reading its balance here tells the
      // endpoint nothing the deposit itself will not.
      const balance = BigInt(await chain.connection.getBalance(depositor, "confirmed"));
      await core.patchView(flow.address, { cluster: cluster.cluster });
      await storePublicBalance(core, flow.address, balance);
      const needed = amount + DEPOSIT_OVERHEAD + SYSTEM_RENT_MINIMUM;
      if (balance < needed) throw fail("insufficient-public", { amount: balance.toString(), limit: needed.toString() });
      const screener = core.env.screener(settings, chain);
      let info;
      try {
        info = await screener.info();
      } catch (error) {
        throw fail("screener-unreachable", { retry: true, detail: wireDetail(settings.screenerUrl, error), ...wireReason(error) });
      }
      if (info.screener !== config.screener.toBase58() || info.programId !== PROGRAM_ID.toBase58() || info.cluster !== cluster.cluster) {
        throw fail("screener-mismatch");
      }
      if (amount > BigInt(info.maxDepositLamports)) throw fail("above-max", { limit: info.maxDepositLamports });
      await core.enter(flow, flow.data ? "screening" : "proving");
      return;
    }
    case "proving": {
      const config = await fetchPoolConfig(chain.connection);
      const tree = await fetchTreeAccount(chain.connection);
      const prepared = await prepareDeposit({ prover: core.env.prover, keys: runtime.keys, root: tree.root, amount, depositor, config });
      flow.data = toBase64(prepared.data);
      flow.outputs = prepared.outputs.map((output) => output.commitment.toString());
      runtime.ownOutputs.push(...flow.outputs);
      await core.store.saveState(runtime);
      // A deposit has two inputs like every transaction: two dummies. Only this device can ever
      // show that they held nothing, which is what a report that ends at this deposit needs.
      runtime.records = addRecord(runtime.records, recordOf(flow.id, prepared, runtime.keys.publicKey, core.env.now()), runtime.state, core.env.now());
      await core.store.saveRecords(runtime);
      await core.enter(flow, "screening");
      return;
    }
    case "screening": {
      if (!flow.data) throw fail("internal");
      const config = await fetchPoolConfig(chain.connection);
      const instruction = buildTransactInstruction(decodeTransactArgs(fromBase64(flow.data)), { signer: depositor, screener: config.screener });
      const { blockhash, lastValidBlockHeight } = await chain.connection.getLatestBlockhash("confirmed");
      const transaction = buildTransactTransaction({ instruction, payer: depositor, recentBlockhash: blockhash });
      // The screener is asked first, so a refused deposit never reaches the wallet, but the wallet
      // is shown the transaction with no signature in it: Phantom warns about a transaction that
      // someone else signed before it ("have Phantom sign first"). A signature covers the message
      // only, so the screener's is kept here and put back next to the wallet's (diveAnswer).
      try {
        applyScreenerSignature(transaction, await core.env.screener(settings, chain).screen(toScreenRequest(transaction)));
      } catch (error) {
        throw screeningFailure(settings.screenerUrl, error);
      }
      flow.unsigned = toBase64(transaction.serialize());
      flow.lastValidBlockHeight = lastValidBlockHeight;
      delete flow.signed;
      const cluster = await readCluster(chain.connection);
      await core.enter(flow, "signing");
      const bare = toBase64(new VersionedTransaction(transaction.message).serialize());
      await ask(core, flow, { kind: "signTransaction", wallet: flow.walletName, address: flow.address, transaction: bare, chain: chainOf(cluster.cluster) });
      return;
    }
    case "signing":
      // Reached only after a restart between writing the step and asking the wallet: ask again, with a fresh blockhash.
      await core.enter(flow, "screening");
      return;
    case "sending": {
      if (!flow.signed || !flow.outputs) throw fail("internal");
      const now = core.env.now();
      if (!runtime.pending.some((entry) => entry.flowId === flow.id)) {
        runtime.pending.push({ flowId: flow.id, kind: "dive", inputs: [], outputs: flow.outputs, leaving: "0", arriving: flow.amount, createdAt: now, outcome: "unknown" });
        await core.store.saveState(runtime);
      }
      runtime.activity = addActivity(runtime.activity, { id: flow.id, kind: "dive", status: "submitted", at: now, amount: flow.amount, counterparty: flow.address });
      await core.store.saveActivity(runtime);
      try {
        flow.signature = await chain.connection.sendRawTransaction(fromBase64(flow.signed), { preflightCommitment: "confirmed", maxRetries: 3 });
      } catch (error) {
        if (flow.signature && /already (been )?processed/i.test(error instanceof Error ? error.message : "")) {
          // These same bytes were sent before the worker was restarted. Go on to confirming.
          await core.enter(flow, "confirming");
          return;
        }
        const failure = sendFailure(settings.rpcUrl, error);
        if (failure.failure.moved === "no") {
          await releasePending(core, runtime, flow.id, "failed");
          if (failure.failure.code === "stale-root") {
            delete flow.data;
            delete flow.outputs;
          }
        }
        throw failure;
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
          await releasePending(core, runtime, flow.id, "failed");
          const parsed = parseProgramError({ err: status.err, logs: [] });
          throw fail("transaction-failed", { detail: parsed ? parsed.kind : "the program rejected the deposit" });
        }
        if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) break;
        if (!status && flow.lastValidBlockHeight !== undefined && (await chain.connection.getBlockHeight("confirmed")) > flow.lastValidBlockHeight) {
          await releasePending(core, runtime, flow.id, "failed");
          throw fail("expired", { retry: true });
        }
        if (core.env.now() > deadline) throw fail("not-confirmed", { moved: "unknown", detail: flow.signature });
        // Writing the flow down each round also keeps the worker awake while it waits.
        await core.saveFlow(flow);
        await core.env.sleep(CONFIRM_POLL_MS);
      }
      runtime.activity = setActivityStatus(runtime.activity, flow.id, "confirmed", flow.signature);
      await core.store.saveActivity(runtime);
      await syncWalletNow(core, flow.address);
      // What the deposit left in the wallet. Still part of the deposit: the sync does not ask.
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

export function wireDetail(url: string, error: unknown): string {
  const host = new URL(url).host;
  // The code and, for a request that got no answer, the one word the SDK gives for why.
  if (error instanceof WireError) return `${host}: ${error.code}${error.reason ? ` (${error.reason})` : ""}`;
  return describeNetworkError(url, error);
}

export function wireReason(error: unknown): Pick<Failure, "reason"> {
  return error instanceof WireError && error.reason ? { reason: error.reason } : {};
}

function screeningFailure(url: string, error: unknown): FlowFailure {
  if (!(error instanceof WireError)) return fail("screener-unreachable", { retry: true, detail: describeNetworkError(url, error) });
  switch (error.code) {
    case "denied":
      // Plainly, and without detail: the service does not say why, and neither does Loch.
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

function sendFailure(rpcUrl: string, error: unknown): FlowFailure {
  const program = parseProgramError(error);
  if (program) {
    switch (program.kind) {
      case "DepositsPaused":
        return fail("deposits-paused");
      case "DepositTooLarge":
        return fail("above-max");
      case "UnknownRoot":
        return fail("stale-root", { retry: true });
      default:
        return fail("transaction-failed", { detail: program.kind });
    }
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/blockhash not found|block height exceeded|expired/i.test(text)) return fail("expired", { retry: true });
  if (/insufficient (funds|lamports)|debit an account/i.test(text)) return fail("insufficient-public");
  if (/simulation failed/i.test(text)) return fail("transaction-failed", { detail: text.replace(/\s+/g, " ").slice(0, 140) });
  // No answer from the endpoint: the transaction may or may not have been accepted.
  return fail("rpc-unreachable", { moved: "unknown", retry: true, detail: describeNetworkError(rpcUrl, error) });
}

async function diveAnswer(core: Core, flow: DiveRecord, answer: BridgeAnswer): Promise<void> {
  if (!answer.ok) throw walletFailure(answer);
  if (answer.value.kind !== "signTransaction" || !flow.unsigned) throw fail("wallet-failed", { retry: true });
  let ours: VersionedTransaction;
  let theirs: VersionedTransaction;
  try {
    ours = VersionedTransaction.deserialize(fromBase64(flow.unsigned));
    theirs = VersionedTransaction.deserialize(fromBase64(answer.value.signedTransaction));
  } catch {
    throw fail("wallet-changed-transaction", { retry: true });
  }
  // What comes back must be the transaction that went out, signed and otherwise untouched. A
  // wallet that adds or reorders instructions breaks the screener's signature.
  const message = ours.message.serialize();
  if (!bytesEqual(message, theirs.message.serialize())) throw fail("wallet-changed-transaction", { retry: true });
  const signers = ours.message.staticAccountKeys.slice(0, ours.message.header.numRequiredSignatures);
  // The wallet signed a copy without the screener's signature: only its own is taken from it.
  const depositor = new PublicKey(flow.address);
  const own = signers.findIndex((signer) => signer.equals(depositor));
  const wallets = theirs.signatures[own];
  if (own < 0 || !wallets) throw fail("wallet-changed-transaction", { retry: true });
  ours.signatures[own] = wallets;
  for (const [index, signer] of signers.entries()) {
    const signature = ours.signatures[index];
    let valid = false;
    try {
      valid = signature !== undefined && ed25519.verify(signature, message, signer.toBytes());
    } catch {
      valid = false;
    }
    if (!valid) throw fail("wallet-changed-transaction", { retry: true });
  }
  flow.signed = toBase64(ours.serialize());
  // A transaction's id is its first signature, so it is known before anything is sent.
  flow.signature = base58.encode(ours.signatures[0]!);
  await closeBridgeTab(core);
  await core.enter(flow, "sending");
}

// ------------------------------------------------- send privately and surface

async function releasePending(core: Core, runtime: WalletRuntime, flowId: string, activity: "failed" | "keep"): Promise<void> {
  const before = runtime.pending.length;
  runtime.pending = runtime.pending.filter((entry) => entry.flowId !== flowId);
  if (runtime.pending.length !== before) await core.store.saveState(runtime);
  if (activity === "failed" && runtime.activity.some((item) => item.id === flowId && item.status !== "confirmed")) {
    runtime.activity = setActivityStatus(runtime.activity, flowId, "failed");
    await core.store.saveActivity(runtime);
  }
}

/** The output commitments of every proof the flow made. Any one of them may be the one that lands. */
function everyOutput(flow: SpendRecord): string[] {
  return flow.proofs && flow.proofs.length > 0 ? flow.proofs.flatMap((proof) => proof.outputs) : (flow.outputs ?? []);
}

/** The chain (the synced state) shows one of the flow's proofs: its outputs are leaves and its notes are spent. */
function landed(runtime: WalletRuntime, flow: SpendRecord): boolean {
  if (!flow.inputs || flow.inputs.length === 0) return false;
  return hasLanded({ inputs: flow.inputs, outputs: everyOutput(flow) }, runtime.state);
}

/** The chain shows one of the flow's notes spent. With `landed` false: by something else, and no proof of the flow can land any more. */
function notesSpent(runtime: WalletRuntime, flow: SpendRecord): boolean {
  return flow.inputs !== undefined && inputSpent({ inputs: flow.inputs }, runtime.state);
}

/** The fee of the proof the chain shows, or of the current request while nothing has landed. */
function feePaid(runtime: WalletRuntime, flow: SpendRecord): string {
  const leaves = new Set(runtime.state.leaves);
  const proof = flow.proofs?.find((item) => item.outputs.some((commitment) => leaves.has(commitment)));
  return proof?.fee ?? flow.request?.extData.fee ?? flow.fee;
}

function spendActivity(runtime: WalletRuntime, flow: SpendRecord, status: "confirmed" | "unknown", at: number) {
  return {
    id: flow.id,
    kind: flow.kind,
    status,
    at,
    amount: flow.amount,
    fee: feePaid(runtime, flow),
    // For a payment code, the address in it: the secret has no business in the activity list.
    // For a claim link there is nobody to name: the address of its keys is nobody's.
    ...(flow.claim ? { claim: true as const } : flow.to ? { counterparty: flow.payee ?? flow.to } : {}),
    // A transaction id is the relayer's word. It is shown only with a transfer the chain confirmed.
    ...(status === "confirmed" && flow.signature ? { signature: flow.signature } : {}),
  } as const;
}

/** Forgets the flow's proofs. Only for proofs that cannot land: never sent, or dead on chain. */
function forgetProofs(flow: SpendRecord): void {
  delete flow.request;
  delete flow.inputs;
  delete flow.outputs;
  delete flow.proofs;
  delete flow.handed;
  delete flow.signature;
}

/** Lets the flow's notes go and forgets its proofs. See `forgetProofs` for when that is allowed. */
async function letGo(core: Core, runtime: WalletRuntime, flow: SpendRecord, activity: "failed" | "keep"): Promise<void> {
  await releasePending(core, runtime, flow.id, activity);
  forgetProofs(flow);
}

/** Writes (or rewrites) the flow's reservation: its notes, the outputs and roots of all its proofs. */
async function reserve(core: Core, runtime: WalletRuntime, flow: SpendRecord): Promise<void> {
  if (!flow.inputs) return;
  const fee = BigInt(flow.request?.extData.fee ?? flow.fee);
  const leaving = flow.kind === "consolidate" ? fee : BigInt(flow.amount) + fee;
  const existing = runtime.pending.find((entry) => entry.flowId === flow.id);
  const most = existing && BigInt(existing.leaving) > leaving ? BigInt(existing.leaving) : leaving;
  const entry: PendingSpend = {
    flowId: flow.id,
    kind: flow.kind,
    inputs: flow.inputs,
    outputs: everyOutput(flow),
    leaving: most.toString(),
    arriving: "0",
    createdAt: existing?.createdAt ?? core.env.now(),
    outcome: "unknown",
    proofs: (flow.proofs ?? []).map(({ root, leaves, fee: paid }) => ({ root, leaves, fee: paid })),
    entry: { amount: flow.amount, fee: fee.toString(), ...(flow.claim ? { claim: true as const } : flow.to ? { counterparty: flow.to } : {}) },
  };
  runtime.pending = [...runtime.pending.filter((item) => item.flowId !== flow.id), entry];
  await core.store.saveState(runtime);
}

/** The chain shows the transfer. Record it and finish. */
async function succeed(core: Core, runtime: WalletRuntime, flow: SpendRecord): Promise<void> {
  runtime.activity = addActivity(runtime.activity, spendActivity(runtime, flow, "confirmed", core.env.now()));
  await core.store.saveActivity(runtime);
  if (runtime.pending.some((entry) => entry.flowId === flow.id)) await releasePending(core, runtime, flow.id, "keep");
  await core.enter(flow, "done", "done");
}

/** A request is out and the chain does not show it: say so in the activity list. */
async function recordUnknown(core: Core, runtime: WalletRuntime, flow: SpendRecord): Promise<void> {
  runtime.activity = addActivity(runtime.activity, spendActivity(runtime, flow, "unknown", core.env.now()));
  await core.store.saveActivity(runtime);
}

export function synced(sync: SyncView): boolean {
  return sync.status === "synced" || sync.status === "behind";
}

function sameNotes(notes: readonly OwnedNote[], commitments: readonly string[]): boolean {
  return notes.length === commitments.length && notes.every((note) => commitments.includes(note.commitment.toString()));
}

/**
 * What became of the proofs this flow made earlier, by a state that was just synced:
 *
 *   none     it made none
 *   landed   one of them is on chain
 *   dead     none can land any more: a note they spend was spent by something else, or every
 *            root they name has left the on-chain root history
 *   bound    one may still land: the flow must go on spending exactly the same notes
 */
async function earlierProofs(chain: Chain, runtime: WalletRuntime, flow: SpendRecord): Promise<"none" | "landed" | "dead" | "bound"> {
  if (!flow.inputs || !flow.proofs || flow.proofs.length === 0) return "none";
  if (landed(runtime, flow)) return "landed";
  if (notesSpent(runtime, flow)) return "dead";
  // The tree account every client reads. If it cannot be read the flow stops here and can be
  // tried again: without it nothing is let go.
  const roots = chainRootsOf(await fetchTreeAccount(chain.connection));
  return flow.proofs.every((proof) => proofExpired(proof, roots)) ? "dead" : "bound";
}

async function stepSpend(core: Core, flow: SpendRecord): Promise<void> {
  const { settings, chain } = await core.chain();
  const runtime = await core.store.runtime(flow.address);
  if (!runtime) throw fail("locked");
  const amount = BigInt(flow.amount);
  const agreed = BigInt(flow.fee);
  // The user's own limit. Read here, in the worker, at every step: no page can raise it for a flow.
  const cap = BigInt(settings.maxFeeLamports);
  const relayer = core.env.relayer(settings, chain);

  switch (flow.step) {
    case "checking": {
      const cluster = await readCluster(chain.connection);
      assertAllowedCluster(cluster);

      // First the chain: what it shows of this wallet, and of the proofs this flow made before.
      const sync = await syncWalletNow(core, flow.address);
      if (!synced(sync)) throw fail(sync.status === "mainnet" ? "mainnet" : "sync-failed", { retry: true, detail: sync.detail });
      const earlier = await earlierProofs(chain, runtime, flow);
      if (earlier === "landed") {
        await succeed(core, runtime, flow);
        return;
      }
      // Dead proofs bind nothing: the flow starts over with whatever notes fit.
      if (earlier === "dead") await letGo(core, runtime, flow, "keep");

      let info;
      try {
        info = await relayer.info();
      } catch (error) {
        throw fail("relayer-unreachable", { retry: true, detail: wireDetail(settings.relayerUrl, error), ...wireReason(error) });
      }
      if (info.programId !== PROGRAM_ID.toBase58() || info.genesisHash !== cluster.genesisHash || info.cluster !== cluster.cluster) {
        throw fail("relayer-mismatch");
      }
      const fee = BigInt(info.feeLamports);
      if (fee > cap || agreed > cap) throw fail("fee-above-limit", { amount: (fee > cap ? fee : agreed).toString(), limit: cap.toString() });
      // The wallet never pays more than the fee the user saw. A higher quote goes back to the user.
      if (fee > agreed) throw fail("fee-changed", { amount: fee.toString(), limit: agreed.toString() });
      if (flow.kind === "surface") {
        const minimum = [SYSTEM_RENT_MINIMUM, BigInt(info.minWithdrawalLamports ?? "0")].reduce((a, b) => (a > b ? a : b));
        if (amount < minimum) throw fail("below-minimum", { limit: minimum.toString() });
      }

      if (flow.inputs && flow.request && flow.request.extData.relayer === info.relayer && BigInt(flow.request.extData.fee) >= fee && BigInt(flow.request.extData.fee) <= agreed) {
        // The kept request suits this relayer: send it again as it is.
        flow.relayer = info.relayer;
        await core.enter(flow, "sending");
        return;
      }
      // A new proof is needed (another relayer's key, another fee, a root that aged out). The
      // earlier proofs stay on record: they may still be with a relayer.
      delete flow.request;
      flow.relayer = info.relayer;

      // This flow's own reservation is lifted for the choice, and nobody else's.
      const others = runtime.pending.filter((entry) => entry.flowId !== flow.id);
      const free = spendableNotes(runtime.state, others);
      const bound = flow.inputs;
      const candidates = bound ? free.filter((note) => bound.includes(note.commitment.toString())) : free;
      const held = candidates.reduce((sum, note) => sum + note.amount, 0n);
      if (flow.kind !== "consolidate") {
        const needed = amount + fee;
        let picked: OwnedNote[];
        try {
          picked = selectNotes(candidates, needed);
        } catch (error) {
          // The notes of the earlier attempt do not cover the amount at this fee. Other notes
          // are not an answer: the earlier proof could land beside the new one.
          if (bound) throw fail("reserved-short", { amount: held.toString(), limit: needed.toString() });
          if (error instanceof ConsolidationRequiredError) throw fail("consolidation-needed", { amount: needed.toString(), count: candidates.length });
          if (error instanceof InsufficientBalanceError) {
            const everything = unspentNotes(runtime.state).reduce((sum, note) => sum + note.amount, 0n);
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
      if (info.relayer !== flow.relayer) {
        // The relayer changed its key since the check: check again.
        await core.enter(flow, "checking");
        return;
      }
      const fee = BigInt(info.feeLamports);
      const others = runtime.pending.filter((entry) => entry.flowId !== flow.id);
      // What the SDK may choose from: nothing another spend has a claim on, and, once this flow
      // has made a proof, nothing but the notes that proof spends.
      const locked = withLocks(runtime.state, others);
      const state = flow.inputs ? onlyNotes(locked, flow.inputs) : locked;
      const context = {
        prover: core.env.prover,
        keys: runtime.keys,
        state,
        tree: core.store.tree(runtime),
        relayer: new PublicKey(flow.relayer),
        fee,
        // Required by the SDK, and never taken from the relayer or from a page: the fee the user
        // agreed to, and never above the limit in settings.
        maxFee: agreed < cap ? agreed : cap,
      };
      const prepared =
        flow.kind === "send"
          ? await prepareTransfer({ ...context, to: flow.to ?? "", amount })
          : flow.kind === "surface"
            ? await prepareWithdrawal({ ...context, recipient: new PublicKey(flow.to ?? ""), amount })
            : await prepareConsolidation(context);
      await checkCancel(core, flow);
      const spent = prepared.spent.map((note) => note.commitment.toString());
      // The last check before a proof may leave this device: it spends the flow's notes, all of
      // them and no others. A proof that does not is dropped here and goes nowhere.
      if (spent.length === 0 || (flow.inputs && (spent.length !== flow.inputs.length || !spent.every((commitment) => flow.inputs!.includes(commitment))))) {
        throw fail("reserved-short");
      }
      const outputs = prepared.outputs.map((output) => output.commitment.toString());
      const proof: FlowProof = { outputs, root: prepared.publicInputs.root.toString(), leaves: runtime.state.leaves.length, fee: fee.toString() };
      flow.request = toRelayRequest(prepared.args);
      flow.inputs ??= spent;
      flow.outputs = outputs;
      flow.proofs = [...(flow.proofs ?? []), proof];
      runtime.ownOutputs.push(...outputs);
      // Written before the proof leaves the device. For a claim link this is also where its
      // secret reaches the disk: from here on the payment can be taken back whatever happens.
      const payee = flow.kind === "send" && flow.to ? { to: flow.payee ?? flow.to, ...(flow.claim ? { claim: flow.claim } : {}) } : undefined;
      runtime.records = addRecord(runtime.records, recordOf(flow.id, prepared, runtime.keys.publicKey, core.env.now(), payee), runtime.state, core.env.now());
      if (!(await core.store.saveRecords(runtime)) && flow.claim) throw fail("locked");
      await reserve(core, runtime, flow);
      await core.enter(flow, "sending");
      return;
    }
    case "sending": {
      if (!flow.request || !flow.inputs) throw fail("internal");
      if (!runtime.pending.some((entry) => entry.flowId === flow.id)) await reserve(core, runtime, flow);
      // Written down before the request leaves: from here on the relayer has it, whatever it says.
      if (!flow.handed) {
        flow.handed = true;
        await core.saveFlow(flow);
      }
      let response;
      try {
        response = await relayer.relay(flow.request);
      } catch (error) {
        await relayFailed(core, chain, runtime, flow, error);
        return;
      }
      // The relayer says it sent it, and gives a transaction id. That is a claim: "confirming"
      // looks for the transfer on chain before anything is recorded.
      flow.signature = response.signature;
      await core.enter(flow, "confirming");
      return;
    }
    case "confirming": {
      const deadline = flow.stepStartedAt + SPEND_CONFIRM_MS;
      for (;;) {
        const sync = await syncWalletNow(core, flow.address);
        if (landed(runtime, flow)) {
          await succeed(core, runtime, flow);
          return;
        }
        if (synced(sync) && notesSpent(runtime, flow)) {
          // The notes are gone and none of this flow's outputs is in the tree: something else spent them.
          await letGo(core, runtime, flow, "failed");
          throw fail("nullifier-spent", { retry: true });
        }
        if (core.env.now() >= deadline) {
          const claimed = flow.signature;
          delete flow.signature;
          await recordUnknown(core, runtime, flow);
          throw fail("relayer-unconfirmed", { moved: "unknown", retry: true, detail: `${new URL(settings.relayerUrl).host} answered with transaction ${claimed ? `${claimed.slice(0, 8)}…` : "(none)"}` });
        }
        // Writing the flow down each round also keeps the worker awake while it waits.
        await core.saveFlow(flow);
        await core.env.sleep(SPEND_POLL_MS);
      }
    }
    default:
      throw fail("internal");
  }
}

/**
 * The relayer answered with an error, or did not answer. Either way it has, or may have, the
 * request, and a request stays valid until its root leaves the root history. So nothing it says
 * lets the notes go: the chain is asked, and unless the chain shows the proofs dead the flow
 * keeps its notes and can only try again with the same ones.
 */
async function relayFailed(core: Core, chain: Chain, runtime: WalletRuntime, flow: SpendRecord, error: unknown): Promise<void> {
  const settings = await core.settings();
  const code = error instanceof WireError ? error.code : "network_error";
  const detail = wireDetail(settings.relayerUrl, error);

  const sync = await syncWalletNow(core, flow.address);
  if (landed(runtime, flow)) {
    await succeed(core, runtime, flow);
    return;
  }
  if (synced(sync) && notesSpent(runtime, flow)) {
    // Spent by something else (another device, perhaps). No proof of this flow can land now.
    await letGo(core, runtime, flow, "failed");
    throw fail("nullifier-spent", { retry: true });
  }

  if (code === "unknown_root") {
    // The relayer says the proof's root is too old (or close to it). Sync and prove again, with
    // the same notes: the two proofs share their nullifiers, so if the relayer was wrong about
    // the first, still only one of them can land.
    delete flow.request;
    if (flow.reproved < MAX_REPROVES) {
      flow.reproved++;
      await core.enter(flow, "checking");
      return;
    }
    await recordUnknown(core, runtime, flow);
    throw fail("stale-root", { retry: true, detail });
  }

  await recordUnknown(core, runtime, flow);
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
    case "fee_too_low": {
      // The fee it asks now needs a new proof, and the user's word. The notes stay the same.
      delete flow.request;
      const info = await core.env.relayer(settings, chain).info().catch(() => null);
      throw fail("fee-changed", { amount: info?.feeLamports, limit: flow.fee, detail });
    }
    case "withdrawal_too_small":
      delete flow.request;
      throw fail("below-minimum", { detail });
    case "invalid_proof":
      delete flow.request;
      throw fail("proof-failed", { retry: true, detail });
    case "wrong_relayer":
      delete flow.request;
      throw fail("relayer-mismatch", { retry: true, detail });
    default:
      // nullifier_spent the chain does not confirm, and everything else.
      throw fail("relayer-refused", { detail: error instanceof WireError ? `${detail}: ${error.message.slice(0, 120)}` : detail });
  }
}

// -------------------------------------------------------------------- events

/** An answer from the wallet arrived for the flow that is waiting on it. */
export async function flowBridgeAnswer(core: Core, flowId: string, request: BridgeRequest, answer: BridgeAnswer): Promise<void> {
  const flow = await core.flow();
  if (!flow || flow.id !== flowId || flow.status !== "waiting") return;
  try {
    flow.status = "running";
    if (flow.kind === "unlock") await unlockAnswer(core, flow, request, answer);
    else if (flow.kind === "dive") await diveAnswer(core, flow, answer);
    else throw fail("internal");
  } catch (error) {
    if (flow.kind === "unlock" || flow.kind === "dive") await closeBridgeTab(core);
    await core.failFlow(flow, toFailure(error, flow, await core.settings()));
    return;
  }
  drive(core);
}

export async function cancelFlow(core: Core): Promise<void> {
  const flow = await core.flow();
  if (!flow) return;
  if (flow.status === "waiting") {
    await closeBridgeTab(core);
    await core.failFlow(flow, { code: "cancelled", moved: "no", retry: false });
    return;
  }
  if (flow.status === "running" && core.flowView(flow).cancellable) {
    await core.env.session.set(CANCEL_KEY, flow.id);
    core.changed();
  }
}

/**
 * Tries a failed flow again. `fee` is given when the failure was that the relayer's fee had
 * changed and the user agreed to the new one: the flow goes on with it, in place, so that a
 * spend whose earlier attempt is still with a relayer keeps its notes.
 */
export async function retryFlow(core: Core, fee?: bigint): Promise<void> {
  const flow = await core.flow();
  if (!flow || flow.status !== "failed" || !flow.failure?.retry) {
    // A changed fee is the one failure that is not retried as it is, but may be with the new fee.
    if (!(flow && flow.status === "failed" && fee !== undefined && (isSpend(flow) || flow.kind === "claim") && flow.failure?.code === "fee-changed")) {
      throw new LochError("INVALID_ARGUMENT", "there is nothing to try again");
    }
  }
  if (fee !== undefined) {
    if (!isSpend(flow) && flow.kind !== "claim") throw new LochError("INVALID_ARGUMENT", "this action has no relayer fee");
    if (fee > BigInt((await core.settings()).maxFeeLamports)) throw new LochError("INVALID_ARGUMENT", "fee:above-limit");
    flow.fee = fee.toString();
  }
  delete flow.failure;
  flow.attempt++;
  await core.env.session.remove(CANCEL_KEY);
  if (flow.kind === "unlock") {
    flow.discoveries = 0;
    flow.wallets = [];
    if (!flow.expected) {
      flow.walletName = null;
      flow.address = null;
    }
    delete flow.first;
    await core.enter(flow, "opening");
  } else {
    await core.enter(flow, "checking");
  }
  drive(core);
}

export async function dismissFlow(core: Core): Promise<void> {
  const flow = await core.flow();
  if (!flow || flow.status === "running" || flow.status === "waiting") return;
  await core.clearFlow();
}

/** The connect tab was closed while the wallet was being asked. */
export async function bridgeTabClosed(core: Core): Promise<void> {
  const flow = await core.flow();
  if (!flow || (flow.status !== "waiting" && flow.status !== "running")) return;
  const usesBridge = flow.kind === "unlock" ? flow.step !== "syncing" : flow.kind === "dive" && flow.step === "signing";
  if (usesBridge) await core.failFlow(flow, { code: "connect-page", moved: "no", retry: true, detail: "the connect page was closed" });
}

/**
 * Called once when the service worker starts. A flow marked running was interrupted in the
 * middle of a step; a flow marked waiting may have waited too long.
 */
export async function resumeFlow(core: Core): Promise<void> {
  const flow = await core.flow();
  if (!flow) return;
  if (flow.status === "waiting") {
    const pending = await pendingBridge(core);
    const since = pending?.createdAt ?? flow.stepStartedAt;
    if (core.env.now() - since > BRIDGE_TTL_MS) {
      await closeBridgeTab(core);
      await core.failFlow(flow, { code: "wallet-timeout", moved: "no", retry: true });
    } else if (!pending && flow.step !== "choosing") {
      // The request never reached the page (the worker stopped between writing and sending).
      flow.status = "running";
      if (flow.kind === "dive") flow.step = "screening";
      await core.saveFlow(flow);
      drive(core);
    }
    return;
  }
  if (flow.status !== "running") return;

  if (flow.kind === "unlock") {
    if (flow.step !== "syncing") {
      flow.step = "opening";
      flow.discoveries = 0;
    }
  } else if (flow.kind === "dive") {
    if (flow.step === "checking" || flow.step === "proving" || flow.step === "screening" || flow.step === "signing") flow.step = "checking";
    // sending: the same signed bytes are sent again. confirming: polling goes on.
  } else if (flow.kind === "claim") {
    if (!(await resumeClaim(core, flow))) return;
  } else if (flow.step === "checking" || flow.step === "proving") {
    flow.step = "checking";
  } else if (flow.step === "sending") {
    // A request to the relayer was in flight, or about to be. Nobody is left to hear its answer.
    flow.handed = true;
    const runtime = await core.store.runtime(flow.address).catch(() => null);
    if (!runtime) {
      await core.failFlow(flow, { code: "locked", moved: "unknown", retry: true });
      return;
    }
    const sync = await syncWalletNow(core, flow.address);
    if (landed(runtime, flow)) {
      await succeed(core, runtime, flow);
    } else if (synced(sync) && notesSpent(runtime, flow)) {
      await letGo(core, runtime, flow, "failed");
      await core.failFlow(flow, { code: "nullifier-spent", moved: "no", retry: true });
    } else {
      await recordUnknown(core, runtime, flow);
      await core.failFlow(flow, { code: "interrupted", moved: "unknown", retry: true });
    }
    return;
  }
  // confirming (a spend): the chain is asked again, from the start of its allowance.
  flow.stepStartedAt = core.env.now();
  await core.saveFlow(flow);
  drive(core);
}
