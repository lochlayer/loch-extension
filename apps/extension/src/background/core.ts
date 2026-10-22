// The service worker's state and the rules for changing it. One Core exists per worker; it is
// given everything that touches the outside world (storage, tabs, the network, the prover, the
// clock), so the same code runs under test with stand-ins.
//
// The worker can be stopped by the browser at any moment and started again by the next event.
// Nothing that matters is held only in memory: a flow is written to chrome.storage.session
// before each step and after it, and `resume` decides what an interrupted step means.

import type { DepthCircuitInput, Prover, RelayRequest, RelayResponse, RelayerInfo, ScreenRequest, ScreenResponse, ScreenerInfo } from "@loch/sdk";
import type { CircuitInputV2, MoveRequestV2, QuoteRequestV2, QuoteResponseV2, RelayRequestV2, RelayerInfoV2 } from "@loch/sdk/v2";
import type { ScanOptions, ScanResult } from "@loch/scanner-core";

import { BUILD, fixedConnectUrl } from "../shared/build.js";
import type { Cluster } from "../shared/constants.js";
import type { BridgeRequest, WalletInfo } from "../shared/messages.js";
import { KNOWN_ASSETS, NATIVE_MINT, assetMeta } from "../shared/assets.js";
import type { AssetView, Failure, FailureCode, FlowKind, FlowStatus, FlowView, Loch2View, ScanView, Snapshot, SyncView } from "../shared/view.js";
import type { KV } from "./kv.js";
import type { Chain } from "./network.js";
import { type ProofRoot, shieldedTotals } from "./pending.js";
import { assetTotals } from "./pendingV2.js";
import { type OhttpProblem, type Settings, loadSettings } from "./settings.js";
import { Store } from "./store.js";

// --------------------------------------------------------------- environment

export interface TabsApi {
  /** Opens a tab without taking focus, so an open popup stays open. */
  create(options: { url: string; active: boolean }): Promise<{ id: number }>;
  remove(tabId: number): Promise<void>;
  /** Resolves with the content script's reply; rejects when the tab has none. */
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

/** One proof a spend flow made: what it creates and what it was made against. */
export interface FlowProof extends ProofRoot {
  /** The Merkle root it names, decimal. */
  root: string;
  /** Commitments (decimal) of its output notes: two (v1) or three (v2). */
  outputs: string[];
  /** The relayer fee it pays, lamports. */
  fee: string;
}

export interface RelayerApi {
  info(): Promise<RelayerInfo>;
  relay(request: RelayRequest): Promise<RelayResponse>;
}

export interface RelayerApiV2 {
  info(): Promise<RelayerInfoV2>;
  relay(request: RelayRequestV2): Promise<RelayResponse>;
  quote(request: QuoteRequestV2): Promise<QuoteResponseV2>;
  move(request: MoveRequestV2): Promise<RelayResponse>;
}

export interface ScreenerApi {
  info(): Promise<ScreenerInfo>;
  screen(request: ScreenRequest): Promise<ScreenResponse>;
}

export interface Env {
  local: KV;
  session: KV;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The RPC connection and the guarded fetch for the given settings. */
  chain(settings: Settings): Chain;
  relayer(settings: Settings, chain: Chain): RelayerApi;
  /** The same relayer's v2 routes (docs/v2.md section 9). */
  relayerV2(settings: Settings, chain: Chain): RelayerApiV2;
  screener(settings: Settings, chain: Chain): ScreenerApi;
  /** Proves in the offscreen document. */
  prover: Prover;
  /** Proves v2 transactions, in the same document. */
  proverV2: Prover<CircuitInputV2>;
  /** Proves depth proofs, in the same document. */
  depthProver: Prover<DepthCircuitInput>;
  tabs: TabsApi;
  /** Tells open extension pages that the snapshot changed. */
  notify(): void;
  scan(connection: Chain["connection"], address: string, options: ScanOptions): Promise<ScanResult>;
  /** Whether Oblivious HTTP settings are usable with `rpcUrl` as the gateway's target. */
  checkOhttp(ohttp: Settings["ohttp"], rpcUrl: string): { ok: true; publicKeys: string[]; kem: string } | { ok: false; problem: OhttpProblem };
  /** The stylesheet and fonts of the in-page dialog, read from the extension package. */
  dialogAssets(): Promise<{ css: string; fonts: { normal: string; italic: string } }>;
}

// -------------------------------------------------------------- flow records

interface FlowBase {
  id: string;
  kind: FlowKind;
  /** The public address the flow is about. Null while connecting a wallet that is not known yet. */
  address: string | null;
  status: FlowStatus;
  step: string;
  stepStartedAt: number;
  createdAt: number;
  attempt: number;
  failure?: Failure;
  cancelRequested?: boolean;
  /** Transaction id. Public. */
  signature?: string;
}

export interface UnlockRecord extends FlowBase {
  kind: "unlock";
  /** The connect page this flow uses, fixed when it starts: a later change of the setting does not move it. */
  connectUrl: string;
  /** The address to unlock, or null to connect whatever account the wallet offers. */
  expected: string | null;
  walletName: string | null;
  wallets: WalletInfo[];
  discoveries: number;
  /** The account's public key, base64, once the wallet has connected. */
  publicKey?: string;
  firstTime: boolean;
  /**
   * SECRET. The first of the two signatures a new wallet is asked for, base64, kept until the
   * second one has been compared with it. Session storage only; never part of a FlowView.
   */
  first?: string;
}

export interface DiveRecord extends FlowBase {
  kind: "dive";
  address: string;
  walletName: string;
  /** The connect page this flow uses, fixed when it starts. */
  connectUrl: string;
  /** Base units of `mint` (lamports for SOL). */
  amount: string;
  /** 2: a deposit into the v2 pool. Absent: the earlier pool. */
  pool?: 2;
  /** v2: the asset deposited (base58 mint). */
  mint?: string;
  /** v2, a token: the depositor's token account the tokens come from. */
  source?: string;
  /** The proven `transact` instruction data, base64. Public once sent. Kept so a retry need not prove again. */
  data?: string;
  /** Commitments of the two notes the deposit creates. */
  outputs?: string[];
  /**
   * The wallet does not sign version 1 transactions (it said so through the bridge): the
   * deposit is built as version 0, with the lookup table below. Otherwise it is version 1.
   */
  legacyTransaction?: boolean;
  /** What the deposit costs beyond its amount, at the cluster's rent (lamports). Set when checked. */
  overhead?: string;
  /** The pool's lookup table the screening service named in its info (base58): a version 0 deposit is compiled with it. */
  lookupTable?: string;
  /** The transaction with the screener's signature, waiting for the wallet's. base64. */
  unsigned?: string;
  /** What the wallet signed when it added to the deposit (Lighthouse assertions), waiting for the screener's co-signature. base64. */
  walletSigned?: string;
  lastValidBlockHeight?: number;
  /** Fully signed, base64. */
  signed?: string;
}

export interface SpendRecord extends FlowBase {
  kind: "send" | "surface" | "consolidate" | "swap";
  address: string;
  /** 2: a spend in the v2 pool. Absent: the earlier pool. */
  pool?: 2;
  /** v2: the asset spent (base58 mint); the fee is paid in it too. */
  mint?: string;
  /** v2 swap: the asset it returns, and the least of it the user agreed to (base units). */
  toMint?: string;
  minOut?: string;
  /** v2 surface of a token: the destination wallet; the destination is its associated token account. */
  owner?: string;
  /** v2: the proven request, with the opening of the fee note. Public once relayed. */
  requestV2?: RelayRequestV2;
  /** Lamports to send or surface. "0" for a consolidation. */
  amount: string;
  /** Shielded address or payment code (send), or public address (surface). */
  to?: string;
  /** Set when `to` is a payment code: the shielded address inside it. Shown and remembered in its place. */
  payee?: string;
  /** The relayer fee the user saw and agreed to. The proof is never made for more. */
  fee: string;
  relayer?: string;
  /** The proven request. Public once relayed. Kept so a retry need not prove again. */
  request?: RelayRequest;
  /**
   * Commitments (decimal) of the notes this flow spends. Set by its first proof. While any proof
   * of the flow may still land, every further proof must spend exactly these notes: the proofs
   * then share their nullifiers and at most one can ever land. They are dropped only when the
   * chain shows that none of the earlier proofs can land any more (flows.ts, `earlierProofs`).
   */
  inputs?: string[];
  /** Output commitments of the current request. */
  outputs?: string[];
  /** Every proof the flow made, oldest first. Any of them may be with a relayer. */
  proofs?: FlowProof[];
  /**
   * A request of this flow was given to a relayer, or was about to be. From then on nothing a
   * relayer says releases the notes: only the chain does.
   */
  handed?: boolean;
  /** Times the proof was made again because its root had aged out. */
  reproved: number;
  /**
   * SECRET. Send to a claim link: the link's secret, base64. `to` is then the address of the
   * claim's keys. Session storage and the vault only; never part of a FlowView.
   */
  claim?: string;
  /**
   * A move (docs/v2.md section 11): a surface of the earlier pool's notes to this wallet, with
   * no fee, in one transaction with a deposit of the same amount into the new pool. The wallet
   * signs it, the screening service co-signs it, and the relayer pays for it.
   */
  move?: true;
  /** A move: the wallet asked, and the connect page used. Fixed when the flow starts. */
  walletName?: string;
  connectUrl?: string;
  /** A move: the deposit into the new pool, base64 of borsh(TransactArgsV2), and its output commitments. */
  moveDeposit?: string;
  moveOutputs?: string[];
  /** A move: the transaction shown to the wallet (no signatures), what the wallet returned, and the same with the screener's signature. Base64. */
  moveUnsigned?: string;
  moveWalletSigned?: string;
  moveSigned?: string;
}

/** Collecting a claim link: the note the code holds is moved to this wallet's own address. */
export interface ClaimRecord extends FlowBase {
  kind: "claim";
  address: string;
  /** SECRET. The claim code. Session storage only; never part of a FlowView. */
  code: string;
  /** Lamports in the note. */
  amount: string;
  /** The relayer fee the user saw and agreed to. It comes out of the note. */
  fee: string;
  relayer?: string;
  /** The proven request. Kept so a retry need not prove again. */
  request?: RelayRequest;
  /** Commitments (decimal) of the notes every proof of the flow creates. All proofs spend the one note, so at most one lands. */
  outputs?: string[];
  /** A request of this flow was given to a relayer, or was about to be. */
  handed?: boolean;
  /** Times the proof was made again because its root had aged out. */
  reproved: number;
}

export type FlowRecord = UnlockRecord | DiveRecord | SpendRecord | ClaimRecord;

/** A failure on its way up the stack. */
export class FlowFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code);
    this.name = "FlowFailure";
  }
}

export function fail(code: FailureCode, options: Partial<Omit<Failure, "code">> = {}): FlowFailure {
  return new FlowFailure({ code, moved: options.moved ?? "no", retry: options.retry ?? false, ...options });
}

// -------------------------------------------------------------------- bridge

/** The connect tab. Always one the extension opened itself, for one flow; it closes it again. */
export interface BridgeTab {
  tabId: number;
  /** The exact address it was opened at. Its content script counts only while it is there. */
  url: string;
  /** The flow it was opened for. */
  flowId: string;
  ready: boolean;
}

export interface PendingBridge {
  nonce: string;
  flowId: string;
  tabId: number;
  /** The exact address the request was sent to. */
  url: string;
  request: BridgeRequest;
  createdAt: number;
}

/** How long a wallet prompt may stay unanswered before the flow gives up. */
export const BRIDGE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- view cache

interface ViewCache {
  /** Whether this cluster has the v2 pool, as the last sync found; absent before it looked. */
  v2?: boolean;
  publicBalance: string | null;
  /** When it was read, milliseconds. */
  publicBalanceAt: number | null;
  cluster: Cluster | null;
  sync: SyncView;
}

const EMPTY_VIEW: ViewCache = { publicBalance: null, publicBalanceAt: null, cluster: null, sync: { status: "idle" } };

interface ScanRun {
  status: ScanView["status"];
  progress?: ScanView["progress"];
  startedAt?: number;
  error?: string;
}

// ---------------------------------------------------------------------- core

export class Core {
  readonly store: Store;
  private settingsCache: Settings | null = null;
  private revision = 0;
  /** Single flight: one runner per flow, one sync per address. */
  driving: Promise<void> | null = null;
  readonly syncing = new Map<string, Promise<SyncView>>();
  /** Stops the sync of an address between two requests (forgetting a wallet does). */
  readonly syncAborts = new Map<string, AbortController>();
  /** Flows cleared by this worker. A runner still at work on one may not save it again. */
  private readonly cleared = new Set<string>();
  scanAbort: AbortController | null = null;
  /** The address the running scan reads. */
  scanAddress: string | null = null;

  constructor(readonly env: Env) {
    this.store = new Store(env.local, env.session);
  }

  // ------------------------------------------------------------------ settings

  async settings(): Promise<Settings> {
    this.settingsCache ??= await loadSettings(this.env.local);
    return this.settingsCache;
  }

  setSettings(settings: Settings): void {
    this.settingsCache = settings;
  }

  async chain(): Promise<{ settings: Settings; chain: Chain }> {
    const settings = await this.settings();
    return { settings, chain: this.env.chain(settings) };
  }

  // ---------------------------------------------------------------------- flow

  async flow(): Promise<FlowRecord | null> {
    return (await this.env.session.get<FlowRecord>("flow")) ?? null;
  }

  async saveFlow(flow: FlowRecord): Promise<void> {
    // A flow that was cleared (dismissed, locked away, its wallet forgotten) stays cleared: a
    // runner that is still at work on it must not write it, and the address in it, back.
    if (this.cleared.has(flow.id)) return;
    await this.env.session.set("flow", flow);
    this.changed();
  }

  /**
   * Removes the flow record. `id` is the flow the caller is looking at; naming it marks that
   * flow as cleared at once, before anything is awaited.
   */
  async clearFlow(id?: string): Promise<void> {
    if (id !== undefined) this.cleared.add(id);
    else {
      const current = await this.flow();
      if (current) this.cleared.add(current.id);
    }
    await this.env.session.remove("flow");
    this.changed();
  }

  /** Moves a flow to a new step and writes it down before anything is done in that step. */
  async enter<T extends FlowRecord>(flow: T, step: T["step"], status: FlowStatus = "running"): Promise<void> {
    flow.step = step;
    flow.status = status;
    flow.stepStartedAt = this.env.now();
    await this.saveFlow(flow);
  }

  async failFlow(flow: FlowRecord, failure: Failure): Promise<void> {
    flow.status = "failed";
    flow.failure = failure;
    if (flow.kind === "unlock") delete flow.first;
    await this.saveFlow(flow);
  }

  // ---------------------------------------------------------------------- view

  async view(address: string): Promise<ViewCache> {
    return (await this.env.session.get<ViewCache>(`view:${address}`)) ?? { ...EMPTY_VIEW };
  }

  /** Updates what is cached about an address. Refused for an address this device does not hold. */
  async patchView(address: string, patch: Partial<ViewCache>): Promise<void> {
    const next = { ...(await this.view(address)), ...patch };
    if (!(await this.store.holds(address))) return;
    await this.env.session.set(`view:${address}`, next);
    this.changed();
  }

  async scanRun(address: string): Promise<ScanRun> {
    return (await this.env.session.get<ScanRun>(`scan:${address}`)) ?? { status: "idle" };
  }

  async setScanRun(address: string, run: ScanRun): Promise<void> {
    if (!(await this.store.holds(address))) return;
    await this.env.session.set(`scan:${address}`, run);
    this.changed();
  }

  changed(): void {
    this.revision++;
    this.env.notify();
  }

  /** The key exchange of the Oblivious HTTP settings in use, for the settings view. Nothing when they are off. */
  private ohttpKem(settings: Settings): { kem?: string } {
    if (!settings.ohttp.enabled) return {};
    const check = this.env.checkOhttp(settings.ohttp, settings.rpcUrl);
    return check.ok ? { kem: check.kem } : {};
  }

  flowView(flow: FlowRecord): FlowView {
    // Built field by field: a record may hold a secret (UnlockRecord.first), a view never does.
    const view: FlowView = {
      id: flow.id,
      kind: flow.kind,
      status: flow.status,
      step: flow.step,
      stepStartedAt: flow.stepStartedAt,
      createdAt: flow.createdAt,
      attempt: flow.attempt,
      cancellable: false,
      proofKept: false,
      bound: false,
    };
    if (flow.failure) view.failure = flow.failure;
    if (flow.signature) view.signature = flow.signature;
    if (flow.kind === "unlock") {
      view.wallets = flow.wallets;
      if (flow.walletName) view.walletName = flow.walletName;
      view.firstTime = flow.firstTime;
      view.connectUrl = flow.connectUrl;
      view.cancellable = flow.status === "running" || flow.status === "waiting";
    } else if (flow.kind === "dive") {
      view.amount = flow.amount;
      if (flow.pool === 2) {
        view.pool = 2;
        view.mint = flow.mint ?? NATIVE_MINT;
      }
      view.walletName = flow.walletName;
      view.connectUrl = flow.connectUrl;
      if (flow.overhead) view.overhead = flow.overhead;
      view.proofKept = flow.data !== undefined;
      view.cancellable = (flow.status === "running" || flow.status === "waiting") && ["checking", "proving", "screening", "signing", "cosigning"].includes(flow.step);
    } else if (flow.kind === "claim") {
      // Never the code: it is the money.
      view.amount = flow.amount;
      view.fee = flow.fee;
      view.proofKept = flow.request !== undefined;
      view.bound = flow.handed === true;
      view.cancellable = flow.status === "running" && ["checking", "proving"].includes(flow.step);
    } else {
      view.amount = flow.amount;
      view.fee = flow.fee;
      if (flow.pool === 2) {
        view.pool = 2;
        view.mint = flow.mint ?? NATIVE_MINT;
        if (flow.toMint) view.toMint = flow.toMint;
        if (flow.minOut) view.minOut = flow.minOut;
      }
      // The interface is shown who is paid, never a payment code: its secret stays in the worker.
      // A claim link has no payee to show: the address of its keys means nothing to anyone.
      if (flow.claim) view.claim = true;
      else if (flow.to) view.to = flow.payee ?? flow.to;
      view.proofKept = flow.request !== undefined || flow.requestV2 !== undefined;
      view.bound = flow.handed === true;
      view.cancellable = flow.status === "running" && ["checking", "proving"].includes(flow.step);
      if (flow.move) {
        view.move = true;
        if (flow.walletName) view.walletName = flow.walletName;
        if (flow.connectUrl) view.connectUrl = flow.connectUrl;
        // Until the relayer has it, a move can be stopped: nothing has left this device but to the wallet and the screener.
        view.cancellable = !flow.handed && (flow.status === "running" || flow.status === "waiting") && ["checking", "proving", "signing", "cosigning"].includes(flow.step);
      }
    }
    return view;
  }

  async snapshot(): Promise<Snapshot> {
    const settings = await this.settings();
    const records = await this.store.wallets();
    const active = await this.store.active();
    const wallets = await Promise.all(
      records.map(async (record) => ({ address: record.address, walletName: record.walletName, unlocked: await this.store.isUnlocked(record.address) })),
    );
    const flow = await this.flow();
    const snapshot: Snapshot = {
      revision: this.revision,
      version: BUILD.version,
      settings: { ...settings, connectFixed: fixedConnectUrl() !== null, ohttp: { ...settings.ohttp, available: OHTTP_AVAILABLE.value, ...this.ohttpKem(settings) } },
      wallets,
      active,
      cluster: null,
      publicBalance: null,
      publicBalanceAt: null,
      shielded: null,
      loch2: null,
      sync: { status: "idle" },
      activity: [],
      flow: flow ? this.flowView(flow) : null,
      scan: { status: "idle" },
      build: { artifacts: BUILD.artifacts, setup: BUILD.setup, circuit: BUILD.circuit },
    };
    if (active === null) return snapshot;
    const view = await this.view(active);
    snapshot.cluster = view.cluster;
    snapshot.publicBalance = view.publicBalance;
    snapshot.publicBalanceAt = view.publicBalanceAt ?? null;
    snapshot.sync = view.sync;
    let runtime = null;
    try {
      runtime = await this.store.runtime(active);
    } catch {
      runtime = null;
    }
    if (runtime) {
      const totals = shieldedTotals(runtime.state, runtime.pending);
      snapshot.shielded = {
        address: runtime.shieldedAddress,
        balance: totals.expected.toString(),
        spendable: totals.spendable.toString(),
        largestPair: totals.largestPair.toString(),
        notes: totals.notes,
        settling: totals.settling,
      };
      if (view.v2) snapshot.loch2 = loch2View(runtime.v2, view.cluster);
      // Which entries this device can make a receipt, a report or a claim code for.
      const recorded = new Set(runtime.records.map((record) => record.flowId));
      snapshot.activity = runtime.activity.map((entry) => (entry.status === "confirmed" && recorded.has(entry.id) ? { ...entry, record: true as const } : entry));
      const run = await this.scanRun(active);
      snapshot.scan = { ...run, ...(runtime.scan ?? {}) };
    }
    return snapshot;
  }
}

/** Set by the build of the worker when the Oblivious HTTP client is wired in. */
export const OHTTP_AVAILABLE = { value: false };

/** The v2 pool of an unlocked wallet, per asset: SOL first, then the cluster's known assets, then others it holds. */
export function loch2View(v2: import("./store.js").PoolV2Runtime, cluster: import("../shared/constants.js").Cluster | null): Loch2View {
  const totals = assetTotals(v2.state, v2.pending);
  const known = cluster ? KNOWN_ASSETS[cluster] : KNOWN_ASSETS.devnet.slice(0, 1);
  const order = [...known.map((asset) => asset.mint), ...v2.mints, ...totals.assets.map((asset) => asset.mint)].filter((mint, index, list) => list.indexOf(mint) === index);
  const assets: AssetView[] = order.map((mint) => {
    const meta = assetMeta(cluster, mint);
    const total = totals.assets.find((asset) => asset.mint === mint);
    return {
      mint,
      symbol: meta.symbol,
      decimals: meta.decimals,
      balance: (total?.expected ?? 0n).toString(),
      spendable: (total?.spendable ?? 0n).toString(),
      largestPair: (total?.largestPair ?? 0n).toString(),
      notes: total?.notes ?? 0,
    };
  });
  return { address: v2.address, assets, settling: totals.settling, neverSynced: v2.neverSynced };
}
