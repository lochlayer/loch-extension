// What the service worker does with a message, once it knows who sent it.
//
//   handleUi       requests from the extension's own pages (popup, expanded view)
//   handleContent  requests from the content script on a web page: untrusted, a short list
//
// Both take plain data and return plain data, so they run under test without a browser.

import { AddressError, LochError, PROGRAM_ID, decodeRecipient, fetchPoolConfig, ownedNotes, selectNotes } from "@loch/sdk";
import { type ShieldedAddressV2, addressIndexOf, decodeAnyRecipient, encodeAddressV2, fetchAssetConfig, fetchPoolConfigV2, ownerOf } from "@loch/sdk/v2";
import { PublicKey } from "@solana/web3.js";

import { fromLamportString } from "../shared/amounts.js";
import { isBase58Address, isDecimalString, isNonEmptyString, isRecord, isString } from "../shared/guards.js";
import { fixedConnectUrl } from "../shared/build.js";
import { type ContentConfig, type ContentMessage, type ReviewReply, type SenderLike, senderOrigin } from "../shared/messages.js";
import type {
  AddressCheck,
  ClaimCheck,
  ClaimCodeReply,
  DepthProofReply,
  PayLinkReply,
  PaymentCodeReply,
  PublicBalanceReply,
  Quote,
  ReceiptReply,
  Snapshot,
  SourceReportReply,
  SurfaceWarningView,
  UiReply,
  UiRequest,
  ViewingKeyReply,
} from "../shared/view.js";
import { acceptBridgeAnswer, closeBridgeTab, noteContentScript } from "./bridge.js";
import { checkClaim, startClaim } from "./claimFlow.js";
import type { Core } from "./core.js";
import { claimCodeFor, depthProofFor, receiptFor, sourceReportFor, viewingKeyFor } from "./disclose.js";
import { cancelFlow, chooseWallet, dismissFlow, flowBridgeAnswer, retryFlow, startDive, startSpend, startUnlock } from "./flows.js";
import { startMove } from "./move.js";
import { depositCosts } from "./rent.js";
import { startDiveV2, startSpendV2 } from "./flowsV2.js";
import { makePaymentCodeV2, payLinkForV2, viewingKeyV2For } from "./paymentCodeV2.js";
import { KNOWN_ASSETS, NATIVE_MINT, assetMeta } from "../shared/assets.js";
import { assertAllowedCluster, describeNetworkError, readCluster } from "./network.js";
import { makePaymentCode, payLinkFor, payeeOf } from "./paymentCode.js";
import { readPublicBalance } from "./publicBalance.js";
import { reviewTransactions } from "./review.js";
import { cancelScan, startScan } from "./scan.js";
import { type Settings, checkConnectUrl, checkEndpoint, saveSettings } from "./settings.js";
import { forgetSiteAccount, noteSiteAccounts } from "./sites.js";
import { withLocks } from "./pending.js";
import { surfaceWarnings } from "./surfaceWarnings.js";
import { stopSync, syncWalletNow } from "./sync.js";

// ------------------------------------------------------------------ requests

const UI_TYPES = [
  "state",
  "connect",
  "unlock",
  "choose-wallet",
  "lock",
  "forget",
  "select",
  "sync",
  "public-balance",
  "quote",
  "dive",
  "send",
  "send-claim",
  "claim-check",
  "claim",
  "claim-code",
  "receipt",
  "source-report",
  "viewing-key",
  "depth-proof",
  "surface",
  "move",
  "consolidate",
  "swap",
  "swap-quote",
  "surface-warnings",
  "check-address",
  "payment-code",
  "pay-link",
  "flow-retry",
  "flow-cancel",
  "flow-dismiss",
  "scan-start",
  "scan-cancel",
  "settings",
] as const;

/** Reads a request from an extension page. Null for anything that is not exactly one of them. */
export function parseUiRequest(value: unknown): UiRequest | null {
  if (!isRecord(value) || value.loch !== "ui" || !isString(value.type, 32)) return null;
  if (!(UI_TYPES as readonly string[]).includes(value.type)) return null;
  switch (value.type) {
    case "unlock":
    case "forget":
    case "select":
      return isBase58Address(value.address) ? { loch: "ui", type: value.type, address: value.address } : null;
    case "choose-wallet":
      return isNonEmptyString(value.wallet, 64) ? { loch: "ui", type: "choose-wallet", wallet: value.wallet } : null;
    case "quote":
      return value.want === "dive" || value.want === "spend" ? { loch: "ui", type: "quote", want: value.want } : null;
    case "dive":
      if (!isDecimalString(value.amount) || (value.mint !== undefined && !isBase58Address(value.mint))) return null;
      return { loch: "ui", type: "dive", amount: value.amount, ...(value.mint !== undefined ? { mint: value.mint } : {}) };
    case "send":
      if (!isString(value.to, 200) || !isDecimalString(value.amount) || !isDecimalString(value.fee)) return null;
      if ((value.mint !== undefined && !isBase58Address(value.mint)) || (value.pool !== undefined && value.pool !== 1 && value.pool !== 2)) return null;
      return { loch: "ui", type: "send", to: value.to, amount: value.amount, fee: value.fee, ...(value.mint !== undefined ? { mint: value.mint } : {}), ...(value.pool !== undefined ? { pool: value.pool as 1 | 2 } : {}) };
    case "swap":
      if (!isBase58Address(value.from) || !isBase58Address(value.to) || !isDecimalString(value.amount) || !isDecimalString(value.minOut) || !isDecimalString(value.fee)) return null;
      return { loch: "ui", type: "swap", from: value.from, to: value.to, amount: value.amount, minOut: value.minOut, fee: value.fee };
    case "swap-quote":
      if (!isBase58Address(value.from) || !isBase58Address(value.to) || !isDecimalString(value.amount)) return null;
      return { loch: "ui", type: "swap-quote", from: value.from, to: value.to, amount: value.amount };
    case "viewing-key":
      if (value.which !== undefined && value.which !== "v1" && value.which !== "full" && value.which !== "incoming") return null;
      return { loch: "ui", type: "viewing-key", ...(value.which !== undefined ? { which: value.which } : {}) };
    case "send-claim":
      if (!isDecimalString(value.amount) || !isDecimalString(value.fee)) return null;
      return { loch: "ui", type: "send-claim", amount: value.amount, fee: value.fee };
    case "claim-check":
      return isString(value.code, 400) ? { loch: "ui", type: "claim-check", code: value.code } : null;
    case "claim":
      if (!isString(value.code, 400) || !isDecimalString(value.fee)) return null;
      return { loch: "ui", type: "claim", code: value.code, fee: value.fee };
    case "depth-proof":
      // The SDK holds the challenge to 128 bytes of UTF-8 once trimmed; this only bounds the message.
      if (!isDecimalString(value.threshold) || !isString(value.challenge, 512)) return null;
      return { loch: "ui", type: "depth-proof", threshold: value.threshold, challenge: value.challenge };
    case "claim-code":
    case "receipt":
    case "source-report":
      return isNonEmptyString(value.id, 64) ? { loch: "ui", type: value.type, id: value.id } : null;
    case "surface":
    case "surface-warnings": {
      if (!isBase58Address(value.to) || !isDecimalString(value.amount) || !isDecimalString(value.fee)) return null;
      if ((value.mint !== undefined && !isBase58Address(value.mint)) || (value.pool !== undefined && value.pool !== 1 && value.pool !== 2)) return null;
      const extra = { ...(value.mint !== undefined ? { mint: value.mint } : {}), ...(value.pool !== undefined ? { pool: value.pool as 1 | 2 } : {}) };
      return value.type === "surface"
        ? { loch: "ui", type: "surface", to: value.to, amount: value.amount, fee: value.fee, ...extra }
        : { loch: "ui", type: "surface-warnings", to: value.to, amount: value.amount, fee: value.fee };
    }
    case "consolidate":
      if (!isDecimalString(value.fee) || (value.mint !== undefined && !isBase58Address(value.mint)) || (value.pool !== undefined && value.pool !== 1 && value.pool !== 2)) return null;
      return { loch: "ui", type: "consolidate", fee: value.fee, ...(value.mint !== undefined ? { mint: value.mint } : {}), ...(value.pool !== undefined ? { pool: value.pool as 1 | 2 } : {}) };
    case "check-address":
      if ((value.kind !== "shielded" && value.kind !== "public") || !isString(value.text, 400)) return null;
      return { loch: "ui", type: "check-address", kind: value.kind, text: value.text };
    case "move":
      return { loch: "ui", type: "move" };
    case "pay-link":
      return value.action === "show" || value.action === "make" || value.action === "new" ? { loch: "ui", type: "pay-link", action: value.action } : null;
    case "settings":
      return isRecord(value.patch) ? { loch: "ui", type: "settings", patch: value.patch } : null;
    case "flow-retry": {
      if (value.fee !== undefined && !isDecimalString(value.fee)) return null;
      if (value.minOut !== undefined && !isDecimalString(value.minOut)) return null;
      return {
        loch: "ui",
        type: "flow-retry",
        ...(value.fee === undefined ? {} : { fee: value.fee as string }),
        ...(value.minOut === undefined ? {} : { minOut: value.minOut as string }),
      };
    }
    default:
      return { loch: "ui", type: value.type } as UiRequest;
  }
}

const ok = <T>(value: T): UiReply<T> => ({ ok: true, value });
const no = (code: string, message: string): UiReply<never> => ({ ok: false, error: { code, message } });

function amountOf(text: string): bigint {
  const value = fromLamportString(text);
  if (value <= 0n || value >= 1n << 64n) throw new LochError("INVALID_ARGUMENT", "the amount is out of range");
  return value;
}

export async function handleUi(core: Core, message: unknown): Promise<UiReply> {
  const request = parseUiRequest(message);
  if (!request) return no("invalid", "the request was not understood");
  try {
    switch (request.type) {
      case "state":
        return ok<Snapshot>(await core.snapshot());
      case "connect":
        await startUnlock(core, null);
        return ok(null);
      case "unlock":
        await startUnlock(core, request.address);
        return ok(null);
      case "choose-wallet":
        await chooseWallet(core, request.wallet);
        return ok(null);
      case "lock":
        await core.store.lock();
        await core.clearFlow();
        return ok(null);
      case "forget": {
        // First the mark: from here nothing that is still running for this address can write
        // it back (store.ts). Then stop what can be stopped, so the endpoint is not asked on.
        const forgetting = core.store.forget(request.address);
        stopSync(core, request.address);
        if (core.scanAddress === request.address) core.scanAbort?.abort(new DOMException("the wallet was forgotten", "AbortError"));
        const flow = await core.flow();
        if (flow && flow.address === request.address) {
          const cleared = core.clearFlow(flow.id);
          await closeBridgeTab(core);
          await cleared;
        }
        await forgetSiteAccount(core, request.address);
        await forgetting;
        core.changed();
        return ok(null);
      }
      case "select":
        if (!(await core.store.wallet(request.address))) return no("unknown-wallet", "this device does not know that address");
        await core.store.setActive(request.address);
        core.changed();
        void syncWalletNow(core, request.address);
        return ok(null);
      case "sync": {
        const address = await core.store.active();
        if (address) void syncWalletNow(core, address);
        return ok(null);
      }
      case "public-balance":
        return ok<PublicBalanceReply>(await readPublicBalance(core));
      case "quote":
        return ok<Quote>(await quote(core, request.want));
      case "dive":
        // Into the v2 pool when the cluster has it; SOL unless an asset is named.
        if (request.mint !== undefined || (await hasV2(core))) {
          if (!(await hasV2(core))) return no("no-v2", "this cluster has no v2 pool");
          await startDiveV2(core, amountOf(request.amount), request.mint ?? NATIVE_MINT);
        } else {
          await startDive(core, amountOf(request.amount));
        }
        return ok(null);
      case "send": {
        // The pool follows the address: a v2 address or payment code is paid from v2, a v1 one from the earlier pool.
        const recipient = decodeAnyRecipient(request.to);
        if (recipient.version === 2) {
          await startSpendV2(core, "send", { to: request.to, amount: amountOf(request.amount), fee: fromLamportString(request.fee), mint: request.mint ?? NATIVE_MINT });
        } else {
          await startSpend(core, "send", { to: request.to, amount: amountOf(request.amount), fee: fromLamportString(request.fee) });
        }
        return ok(null);
      }
      case "swap":
        await startSpendV2(core, "swap", { amount: amountOf(request.amount), fee: fromLamportString(request.fee), mint: request.from, toMint: request.to, minOut: amountOf(request.minOut) });
        return ok(null);
      case "swap-quote":
        return ok<{ amountOut: string }>(await swapQuote(core, request.from, request.to, amountOf(request.amount)));
      case "send-claim":
        await startSpend(core, "send", { amount: amountOf(request.amount), fee: fromLamportString(request.fee), claim: true });
        return ok(null);
      case "claim-check":
        return ok<ClaimCheck>(await checkClaim(core, request.code));
      case "claim":
        await startClaim(core, request.code, fromLamportString(request.fee));
        return ok(null);
      case "claim-code":
        return ok<ClaimCodeReply>(await claimCodeFor(core, request.id));
      case "receipt":
        return ok<ReceiptReply>(await receiptFor(core, request.id));
      case "source-report":
        return ok<SourceReportReply>(await sourceReportFor(core, request.id));
      case "viewing-key":
        return ok<ViewingKeyReply>(request.which === "full" || request.which === "incoming" ? await viewingKeyV2For(core, request.which) : await viewingKeyFor(core));
      case "depth-proof":
        return ok<DepthProofReply>(await depthProofFor(core, amountOf(request.threshold), request.challenge));
      case "surface":
        if (request.pool !== 1 && (await hasV2(core))) {
          await startSpendV2(core, "surface", { to: new PublicKey(request.to).toBase58(), amount: amountOf(request.amount), fee: fromLamportString(request.fee), mint: request.mint ?? NATIVE_MINT });
        } else {
          await startSpend(core, "surface", { to: new PublicKey(request.to).toBase58(), amount: amountOf(request.amount), fee: fromLamportString(request.fee) });
        }
        return ok(null);
      case "move":
        await startMove(core);
        return ok(null);
      case "consolidate":
        if (request.pool !== 1 && (await hasV2(core))) {
          await startSpendV2(core, "consolidate", { amount: 0n, fee: fromLamportString(request.fee), mint: request.mint ?? NATIVE_MINT });
        } else {
          await startSpend(core, "consolidate", { amount: 0n, fee: fromLamportString(request.fee) });
        }
        return ok(null);
      case "check-address":
        return ok<AddressCheck>(await checkAddress(core, request.kind, request.text));
      case "payment-code": {
        const reply = (await hasV2(core)) ? await makePaymentCodeV2(core) : await makePaymentCode(core);
        core.changed();
        return ok<PaymentCodeReply>(reply);
      }
      case "pay-link": {
        const reply = (await hasV2(core)) ? await payLinkForV2(core, request.action) : await payLinkFor(core, request.action);
        if (request.action !== "show") core.changed();
        return ok<PayLinkReply | null>(reply);
      }
      case "surface-warnings":
        return ok<SurfaceWarningView[]>(await warningsForSurface(core, request.to, fromLamportString(request.amount), fromLamportString(request.fee)));
      case "flow-retry":
        await retryFlow(core, request.fee === undefined ? undefined : fromLamportString(request.fee), request.minOut === undefined ? undefined : amountOf(request.minOut));
        return ok(null);
      case "flow-cancel":
        await cancelFlow(core);
        return ok(null);
      case "flow-dismiss":
        await dismissFlow(core);
        return ok(null);
      case "scan-start":
        await startScan(core);
        return ok(null);
      case "scan-cancel":
        await cancelScan(core);
        return ok(null);
      case "settings":
        return ok(await changeSettings(core, request.patch));
    }
  } catch (error) {
    if (error instanceof AddressError) return no("address", error.reason);
    if (error instanceof LochError) return no(error.code, error.message);
    return no("failed", error instanceof Error ? error.name : "unknown error");
  }
}

// --------------------------------------------------------------------- quote

async function quote(core: Core, want: "dive" | "spend"): Promise<Quote> {
  const { settings, chain } = await core.chain();
  const cluster = await readCluster(chain.connection);
  assertAllowedCluster(cluster);
  const result: Quote = { cluster: cluster.cluster, pool: null, relayer: null, screener: null };
  if (want === "dive") {
    const costs = await depositCosts(chain, settings.rpcUrl);
    result.deposit = { overhead: costs.overhead.toString(), minimum: costs.minimum.toString() };
    try {
      const config = await fetchPoolConfig(chain.connection);
      result.pool = { maxDeposit: config.maxDeposit.toString(), paused: config.paused };
    } catch (error) {
      result.poolError = error instanceof LochError ? error.code : describeNetworkError(settings.rpcUrl, error);
    }
    try {
      const info = await core.env.screener(settings, chain).info();
      result.screener = { maxDeposit: info.maxDepositLamports, policy: info.policy.slice(0, 300) };
    } catch (error) {
      result.screenerError = describeNetworkError(settings.screenerUrl, error);
    }
  }
  if (await hasV2(core)) result.v2 = await quoteV2(core, cluster.cluster, cluster.genesisHash);
  if (want === "spend") {
    try {
      const info = await core.env.relayer(settings, chain).info();
      if (info.programId !== PROGRAM_ID.toBase58() || info.genesisHash !== cluster.genesisHash) result.relayerError = "mismatch";
      else result.relayer = { fee: info.feeLamports, minWithdrawal: info.minWithdrawalLamports ?? "0", address: info.relayer };
    } catch (error) {
      result.relayerError = describeNetworkError(settings.relayerUrl, error);
    }
  }
  return result;
}

/**
 * Whether `text` is a shielded address or a payment code (to send to) or a public address (to
 * surface to), with the reason when it is not.
 */
async function checkAddress(core: Core, kind: "shielded" | "public", raw: string): Promise<AddressCheck> {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  const active = await core.store.active();
  if (kind === "shielded") {
    let version: 1 | 2 = 1;
    try {
      version = decodeAnyRecipient(text).version;
    } catch (error) {
      if (!(error instanceof AddressError)) return { ok: false, reason: "not-an-address" };
      if (isBase58Address(text)) return { ok: false, reason: "public-address" };
      switch (error.reason) {
        case "public_key_range":
        case "encryption_key":
          return { ok: false, reason: "unusable" };
        default:
          return { ok: false, reason: error.reason };
      }
    }
    const runtime = active ? await core.store.runtime(active).catch(() => null) : null;
    const address = text.toLowerCase();
    if (version === 2) {
      // Any of the wallet's own v2 addresses: its diversifier decrypts under the wallet's key and gives its owner.
      const decoded = decodeAnyRecipient(address).recipient as ShieldedAddressV2 & { secret?: Uint8Array };
      const own = runtime !== null && addressIndexOf(runtime.v2.keys.dk, decoded.d) !== null && ownerOf(runtime.v2.keys.ownerRoot, decoded.d) === decoded.owner;
      if (!decoded.secret) return { ok: true, address, own, v2: true };
      return { ok: true, address, own, code: true, payee: encodeAddressV2({ d: decoded.d, owner: decoded.owner, pk: decoded.pk }), v2: true };
    }
    const payee = payeeOf(address);
    const own = runtime?.shieldedAddress === payee;
    return payee === address ? { ok: true, address, own } : { ok: true, address, own, code: true, payee };
  }
  if (/^loch(pay)?1/i.test(text)) return { ok: false, reason: "shielded-address" };
  try {
    const key = new PublicKey(text);
    if (key.toBase58() !== text) return { ok: false, reason: "not-an-address" };
    const own = (await core.store.wallets()).some((record) => record.address === text);
    return { ok: true, address: text, own };
  } catch {
    return { ok: false, reason: "not-an-address" };
  }
}

async function warningsForSurface(core: Core, destination: string, amount: bigint, fee: bigint): Promise<SurfaceWarningView[]> {
  const address = await core.store.active();
  const runtime = address ? await core.store.runtime(address) : null;
  if (!runtime) return [];
  const deposits = runtime.activity
    .filter((entry) => entry.kind === "dive" && entry.status !== "failed")
    .map((entry) => ({ amount: BigInt(entry.amount), at: entry.at, from: entry.counterparty ?? runtime.address }));
  const ownAddresses = (await core.store.wallets()).map((record) => record.address);
  // The notes the withdrawal would spend, chosen as the flow will choose them. When they cannot
  // be chosen the form says so itself, and there is no note to warn about.
  let spends: string[] = [];
  try {
    spends = selectNotes(ownedNotes(withLocks(runtime.state, runtime.pending)), amount + fee).map((note) => note.commitment.toString());
  } catch {
    spends = [];
  }
  return surfaceWarnings({ amount, fee, destination, now: core.env.now(), deposits, ownAddresses, spends, shown: runtime.shown }).map((warning) => ({
    id: warning.id,
    ...(warning.deposit ? { amount: warning.deposit.amount.toString(), at: warning.deposit.at, from: warning.deposit.from } : {}),
  }));
}

// ------------------------------------------------------------------ settings

async function changeSettings(core: Core, patch: Record<string, unknown>): Promise<Settings> {
  const current = await core.settings();
  const next: Settings = { ...current, ohttp: { ...current.ohttp } };
  for (const key of ["rpcUrl", "relayerUrl", "screenerUrl"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    const check = isString(value, 2048) ? checkEndpoint(value) : { ok: false as const, problem: "not-a-url" as const };
    if (!check.ok) throw new LochError("INVALID_ARGUMENT", `${key}:${check.problem}`);
    next[key] = check.url;
  }
  if (patch.connectUrl !== undefined) {
    // The connect page is where the wallet is asked for the signature that is the key to the
    // shielded balance. Changing it is not an ordinary setting: the request must say, in a
    // field of its own, the address it means to change it to, and a build with the address
    // compiled in does not take one at all.
    const check = isString(patch.connectUrl, 2048) ? checkConnectUrl(patch.connectUrl) : { ok: false as const, problem: "not-a-url" as const };
    if (!check.ok) throw new LochError("INVALID_ARGUMENT", `connectUrl:${check.problem}`);
    if (check.url !== current.connectUrl) {
      if (fixedConnectUrl() !== null) throw new LochError("INVALID_ARGUMENT", "connectUrl:fixed");
      const confirmed = isString(patch.confirmConnectUrl, 2048) ? checkConnectUrl(patch.confirmConnectUrl) : null;
      if (!confirmed || !confirmed.ok || confirmed.url !== check.url) throw new LochError("INVALID_ARGUMENT", "connectUrl:confirm");
      // A flow that is running keeps the address it started with (FlowRecord.connectUrl).
      next.connectUrl = check.url;
    }
  }
  if (patch.theme === "dusk" || patch.theme === "night") {
    next.theme = patch.theme;
    next.themeChosen = true;
  }
  if (typeof patch.wrapperEnabled === "boolean") next.wrapperEnabled = patch.wrapperEnabled;
  if (typeof patch.warnFirstRecipients === "boolean") next.warnFirstRecipients = patch.warnFirstRecipients;
  if (patch.maxFeeLamports !== undefined) {
    if (!isDecimalString(patch.maxFeeLamports) || BigInt(patch.maxFeeLamports) > 1_000_000_000n) throw new LochError("INVALID_ARGUMENT", "maxFeeLamports:range");
    next.maxFeeLamports = patch.maxFeeLamports;
  }
  if (isRecord(patch.ohttp)) {
    const o = patch.ohttp;
    if (isString(o.relayUrl, 2048)) {
      if (o.relayUrl.trim() !== "") {
        const check = checkEndpoint(o.relayUrl);
        if (!check.ok) throw new LochError("INVALID_ARGUMENT", `ohttp.relayUrl:${check.problem}`);
        next.ohttp.relayUrl = check.url;
      } else next.ohttp.relayUrl = "";
    }
    if (isString(o.keyConfig, 8192)) next.ohttp.keyConfig = o.keyConfig.trim();
    if (isString(o.pinnedKey, 128)) next.ohttp.pinnedKey = o.pinnedKey.trim();
    if (typeof o.enabled === "boolean") next.ohttp.enabled = o.enabled;
  }
  if (next.ohttp.enabled && (isRecord(patch.ohttp) || next.rpcUrl !== current.rpcUrl)) {
    // The RPC endpoint is part of it: it is the gateway's target, and must not be the relay.
    const check = core.env.checkOhttp(next.ohttp, next.rpcUrl);
    if (!check.ok) throw new LochError("INVALID_ARGUMENT", `ohttp.${OHTTP_FIELD[check.problem]}:${check.problem}`);
  }
  const endpointsChanged = next.rpcUrl !== current.rpcUrl || next.ohttp.enabled !== current.ohttp.enabled || next.ohttp.relayUrl !== current.ohttp.relayUrl;
  const saved = await saveSettings(core.env.local, next);
  core.setSettings(saved);
  if (endpointsChanged) {
    for (const key of await core.env.session.keys("view:")) await core.env.session.remove(key);
    const address = await core.store.active();
    if (address) void syncWalletNow(core, address);
  }
  core.changed();
  return saved;
}

const OHTTP_FIELD = {
  relay: "relayUrl",
  "same-origin": "relayUrl",
  "key-config": "keyConfig",
  "key-config-url": "keyConfig",
  unusable: "keyConfig",
  pin: "pinnedKey",
} as const;

// ------------------------------------------------------------ content script

export type ContentReply = ContentConfig | ReviewReply | { css: string; fonts: { normal: string; italic: string } } | { ok: boolean };

/**
 * Requests from a content script. The page it runs in is not trusted, so this is all a page
 * can ever reach: whether to register the Loch wallet, a verdict on transactions the page
 * itself supplied for an account the wallet gave it, the dialog's stylesheet, and the answer to
 * a request the bridge is waiting for.
 */
export async function handleContent(core: Core, sender: SenderLike, message: ContentMessage): Promise<ContentReply> {
  switch (message.type) {
    case "config": {
      const bridge = await noteContentScript(core, sender);
      const settings = await core.settings();
      // The connect page cannot follow the palette by itself: it has no script. The bridge page,
      // and no other page, is told when the palette chosen in Loch is night.
      const night = bridge && settings.theme === "night" ? ({ night: true } as const) : {};
      if (!settings.wrapperEnabled) return { enabled: false, wallet: null, bridge, ...night };
      const active = await core.store.active();
      const record = active ? await core.store.wallet(active) : null;
      return { enabled: true, wallet: record?.walletName ?? null, bridge, ...night };
    }
    case "bridge-answer": {
      const accepted = await acceptBridgeAnswer(core, sender, message.nonce, message.answer);
      if (accepted) await flowBridgeAnswer(core, accepted.pending.flowId, accepted.pending.request, accepted.answer);
      return { ok: accepted !== null };
    }
    case "accounts": {
      const origin = senderOrigin(sender);
      if (origin !== null && (await core.settings()).wrapperEnabled) await noteSiteAccounts(core, origin, message.accounts);
      return { ok: true };
    }
    case "review":
      return reviewTransactions(core, senderOrigin(sender), message.account, message.transactions);
    case "dialog-assets":
      return core.env.dialogAssets();
  }
}

// ------------------------------------------------------------------------ v2

/** Whether the active wallet's cluster has the v2 pool, as the last sync found. */
async function hasV2(core: Core): Promise<boolean> {
  const address = await core.store.active();
  return address !== null && (await core.view(address)).v2 === true;
}

/**
 * The v2 pool's assets and the relayer's terms in each. Mints the relayer takes are learnt by
 * the wallet, so a later sync looks for notes in them too.
 */
async function quoteV2(core: Core, cluster: Quote["cluster"], genesisHash: string): Promise<NonNullable<Quote["v2"]>> {
  const { settings, chain } = await core.chain();
  const config = await fetchPoolConfigV2(chain.connection);
  const result: NonNullable<Quote["v2"]> = { paused: config.paused, assets: [], relayer: null };
  let fees: Record<string, string> = {};
  try {
    const info = await core.env.relayerV2(settings, chain).info();
    if (info.programId !== PROGRAM_ID.toBase58() || info.genesisHash !== genesisHash) result.relayerError = "mismatch";
    else {
      fees = info.fees;
      result.relayer = { fees: info.fees, accountFees: info.accountFees ?? {}, minWithdrawal: info.minWithdrawalLamports, swaps: info.swaps, move: info.move ? { min: info.move.minLamports } : null };
    }
  } catch (error) {
    result.relayerError = describeNetworkError(settings.relayerUrl, error);
  }
  const address = await core.store.active();
  const runtime = address ? await core.store.runtime(address).catch(() => null) : null;
  const known = KNOWN_ASSETS[cluster].map((asset) => asset.mint);
  const mints = [...new Set([...known, ...Object.keys(fees), ...(runtime?.v2.mints ?? [])])];
  if (runtime) {
    const learnt = Object.keys(fees).filter((mint) => !known.includes(mint) && !runtime.v2.mints.includes(mint));
    if (learnt.length > 0) {
      runtime.v2.mints = [...runtime.v2.mints, ...learnt].slice(0, 32);
      await core.store.saveState(runtime);
    }
  }
  for (const mint of mints) {
    try {
      const asset = await fetchAssetConfig(chain.connection, new PublicKey(mint));
      const meta = assetMeta(cluster, mint, asset.decimals);
      result.assets.push({ mint, symbol: meta.symbol, decimals: asset.decimals, maxDeposit: asset.maxDeposit.toString(), depositsEnabled: asset.depositsEnabled });
    } catch {
      // Not registered in this pool: not offered.
    }
  }
  return result;
}

async function swapQuote(core: Core, from: string, to: string, amount: bigint): Promise<{ amountOut: string }> {
  const { settings, chain } = await core.chain();
  assertAllowedCluster(await readCluster(chain.connection));
  return core.env.relayerV2(settings, chain).quote({ inputMint: from, outputMint: to, amountIn: amount.toString() });
}
