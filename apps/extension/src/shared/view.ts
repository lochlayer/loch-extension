// What the interface is given to draw, and what it may ask for. The service worker builds a
// Snapshot from its state; the pages never read storage themselves. No secret is ever part of
// a snapshot: no signature, no key, no note blinding, no nullifier.

import type { Flow as ScanFlow, LeakReport } from "@loch/scanner-core";

import type { Cluster } from "./constants.js";
import type { WalletInfo } from "./messages.js";

// -------------------------------------------------------------------- flows

export type FlowKind = "unlock" | "dive" | "send" | "surface" | "consolidate" | "claim";
/** running: the worker is at it. waiting: on the user or their wallet. failed and done are final. */
export type FlowStatus = "running" | "waiting" | "failed" | "done";

export type UnlockStep = "opening" | "discovering" | "choosing" | "connecting" | "signing" | "signing-again" | "syncing" | "done";
export type DiveStep = "checking" | "proving" | "screening" | "signing" | "cosigning" | "sending" | "confirming" | "done";
export type SpendStep = "checking" | "proving" | "sending" | "confirming" | "done";
export type ClaimStep = SpendStep;

/**
 * Why a flow stopped. `code` selects the words (src/shared/copy.ts); the other fields are the
 * figures those words need. `detail` is a short technical line shown small and never interpreted.
 */
export interface Failure {
  code: FailureCode;
  /**
   * Whether funds moved. "no": nothing left the wallet and nothing can. "unknown": a request is
   * (or may be) with a relayer or the network and can still land; its notes stay reserved.
   */
  moved: "no" | "unknown";
  /** The same request can be tried again (the proof is kept where there is one). */
  retry: boolean;
  detail?: string;
  /** For a request that got no answer: what the transport reported (the SDK's WireError.reason). */
  reason?: "timeout" | "unreachable" | "aborted" | "other";
  /** Lamports, for codes that quote an amount. */
  amount?: string;
  /** A second amount (a limit, a balance). */
  limit?: string;
  count?: number;
}

export type FailureCode =
  // any flow
  | "mainnet"
  | "rpc-unreachable"
  | "cancelled"
  | "interrupted"
  | "locked"
  | "internal"
  // reaching the wallet
  | "connect-page"
  | "no-wallet"
  | "wallet-missing"
  | "wallet-rejected"
  | "wallet-failed"
  | "wallet-timeout"
  | "wallet-unsupported"
  | "wrong-account"
  | "bad-signature"
  | "not-deterministic"
  | "signature-changed"
  | "wallet-changed-transaction"
  // dive in
  | "pool-missing"
  | "deposits-paused"
  | "above-max"
  | "insufficient-public"
  | "screening-denied"
  | "screener-unreachable"
  | "screener-mismatch"
  | "screener-refused"
  | "expired"
  | "transaction-failed"
  | "not-confirmed"
  // send privately, surface
  | "relayer-unreachable"
  | "relayer-timeout"
  | "relayer-mismatch"
  | "relayer-unavailable"
  | "relayer-refused"
  /** The relayer answered with a transaction id and the chain shows neither the transfer nor its notes as spent. */
  | "relayer-unconfirmed"
  /** A retry must spend the notes of the earlier attempt, and they do not cover the amount at the fee now asked. */
  | "reserved-short"
  | "fee-above-limit"
  | "fee-changed"
  | "insufficient-shielded"
  | "notes-busy"
  | "consolidation-needed"
  | "below-minimum"
  | "nullifier-spent"
  | "stale-root"
  | "proof-failed"
  | "sync-failed"
  // collecting a claim link
  /** The pool this wallet reads does not hold the note the code is for (not yet, or another network). */
  | "claim-missing"
  /** The note was already collected: by the recipient, by the payer taking it back, or by anyone who saw the code. */
  | "claim-taken"
  /** The note does not cover the relayer fee of collecting it. */
  | "claim-too-small";

export interface StageView {
  label: string;
  state: "done" | "now" | "todo";
}

export interface FlowView {
  id: string;
  kind: FlowKind;
  status: FlowStatus;
  step: string;
  /** When the current step began, milliseconds. The interface counts up from it. */
  stepStartedAt: number;
  createdAt: number;
  /** Lamports. Absent for unlock and consolidation. */
  amount?: string;
  /** The relayer fee the user agreed to (send, surface, consolidate). */
  fee?: string;
  /** Shielded address (send) or public address (surface). */
  to?: string;
  /** Send: the payment goes to a claim link, not to an address. */
  claim?: true;
  /** The transaction id once there is one. Public. */
  signature?: string;
  failure?: Failure;
  /** The flow can still be stopped without anything having been sent. */
  cancellable: boolean;
  /** A proof is kept, so trying again skips the slow step. */
  proofKept: boolean;
  /**
   * Send, surface, consolidate: an earlier attempt of this flow is with a relayer and could still
   * land. Its notes stay reserved, and every further attempt of this flow spends exactly those
   * notes, so at most one of them can ever land.
   */
  bound: boolean;
  /** Unlock and dive in: the page the wallet is asked on (origin and path). Fixed when the flow starts. */
  connectUrl?: string;
  /** Unlock: wallets found on the connect page, to choose from. */
  wallets?: WalletInfo[];
  walletName?: string;
  /** Unlock: this is the first time for this address (the wallet signs twice). */
  firstTime?: boolean;
  /** How many attempts were made (retries count). */
  attempt: number;
}

// ----------------------------------------------------------------- activity

export type ActivityKind = "dive" | "send" | "receive" | "surface" | "consolidate" | "restored" | "claim";
/** submitted: sent, not seen on chain yet. unknown: it may or may not land. */
export type ActivityStatus = "submitted" | "confirmed" | "failed" | "unknown";

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  /** Milliseconds. */
  at: number;
  /** Lamports moved, always positive. The kind gives the direction. */
  amount: string;
  /** Relayer fee paid from the shielded balance. */
  fee?: string;
  /** dive: the public address it came from. surface: the destination. send: the shielded address. */
  counterparty?: string;
  /** Transaction id, when this device sent it. Public. */
  signature?: string;
  /** restored: how many notes. */
  count?: number;
  /** send: the payment was made to a claim link. */
  claim?: true;
  /**
   * Only in a snapshot, never stored: this device holds the record of the transaction, so a
   * receipt (send), a source-of-funds report (surface) or the claim code (a send to a claim
   * link) can be made for it.
   */
  record?: true;
}

// --------------------------------------------------------------------- scan

export type ScanStatus = "idle" | "running" | "done" | "failed" | "cancelled";

export interface ScanView {
  status: ScanStatus;
  /** While running. */
  progress?: { fetched: number; total: number; skipped: number };
  startedAt?: number;
  /** The cached result of the last finished scan, if any. */
  report?: LeakReport;
  flows?: ScanFlow[];
  skipped?: number;
  scannedAt?: number;
  error?: string;
}

// --------------------------------------------------------------------- sync

export type SyncStatus = "idle" | "syncing" | "synced" | "behind" | "unreachable" | "mainnet" | "failed";

export interface SyncView {
  status: SyncStatus;
  /** Milliseconds of the last successful sync. */
  at?: number;
  /** Pool transactions the wallet state is behind by. */
  behind?: number;
  progress?: { fetched: number; total: number };
  detail?: string;
}

// ----------------------------------------------------------------- snapshot

export interface WalletView {
  address: string;
  walletName: string;
  unlocked: boolean;
}

export interface SettingsView {
  rpcUrl: string;
  relayerUrl: string;
  screenerUrl: string;
  connectUrl: string;
  /** The connect page is a constant of this build: it is shown, and cannot be changed. */
  connectFixed: boolean;
  theme: "dusk" | "night";
  wrapperEnabled: boolean;
  /** The in-page warning also interrupts for a first-time recipient (a low-severity finding). */
  warnFirstRecipients: boolean;
  maxFeeLamports: string;
  /** `kem`: the key exchange in use while enabled, "X-Wing" (the post-quantum hybrid) or "X25519". */
  ohttp: { enabled: boolean; relayUrl: string; keyConfig: string; pinnedKey: string; available: boolean; kem?: string };
}

export interface ShieldedView {
  /** The shielded address, to receive with. */
  address: string;
  /** Lamports in the Loch after everything this device has sent is counted. */
  balance: string;
  /** Lamports in notes that can be spent right now. */
  spendable: string;
  /** The most one transaction can move (the two largest spendable notes). */
  largestPair: string;
  notes: number;
  /** Transactions sent from this device that the chain has not shown yet. */
  settling: number;
}

export interface Snapshot {
  /** Changes whenever anything below does. */
  revision: number;
  version: string;
  settings: SettingsView;
  wallets: WalletView[];
  /** The address the interface is showing, or null before any wallet is connected. */
  active: string | null;
  cluster: Cluster | null;
  /**
   * Lamports. Null until it has been read. It is read only when the user asks (the dive-in form,
   * the refresh control) and during a dive-in, never by a sync and never around a private spend:
   * the request names the public address to the RPC endpoint.
   */
  publicBalance: string | null;
  /** When `publicBalance` was read, milliseconds. */
  publicBalanceAt: number | null;
  shielded: ShieldedView | null;
  sync: SyncView;
  activity: ActivityEntry[];
  flow: FlowView | null;
  scan: ScanView;
  build: { artifacts: Record<string, { sha256: string; bytes: number }>; setup: string; circuit: string };
}

// ----------------------------------------------------------------- requests

/** What the pool and the services say right now, for a form to show before anything is proven. */
export interface Quote {
  cluster: Cluster;
  pool: { maxDeposit: string; paused: boolean } | null;
  relayer: { fee: string; minWithdrawal: string; address: string } | null;
  relayerError?: string;
  screener: { maxDeposit: string; policy: string } | null;
  screenerError?: string;
  poolError?: string;
}

export type UiRequest =
  | { loch: "ui"; type: "state" }
  | { loch: "ui"; type: "connect" }
  | { loch: "ui"; type: "unlock"; address: string }
  | { loch: "ui"; type: "choose-wallet"; wallet: string }
  | { loch: "ui"; type: "lock" }
  | { loch: "ui"; type: "forget"; address: string }
  | { loch: "ui"; type: "select"; address: string }
  | { loch: "ui"; type: "sync" }
  | { loch: "ui"; type: "public-balance" }
  | { loch: "ui"; type: "quote"; want: "dive" | "spend" }
  | { loch: "ui"; type: "dive"; amount: string }
  | { loch: "ui"; type: "send"; to: string; amount: string; fee: string }
  /** Pays `amount` to a new claim link. The note carries one relayer fee more, for collecting it. */
  | { loch: "ui"; type: "send-claim"; amount: string; fee: string }
  /** What a claim code is worth, before collecting it. */
  | { loch: "ui"; type: "claim-check"; code: string }
  /** Collects a claim code into the active wallet. */
  | { loch: "ui"; type: "claim"; code: string; fee: string }
  /** The claim code of a send this device made to a claim link (`id`: the activity entry). */
  | { loch: "ui"; type: "claim-code"; id: string }
  /** A payment receipt for a confirmed send (`id`: the activity entry). */
  | { loch: "ui"; type: "receipt"; id: string }
  /** A source-of-funds report for a confirmed surface (`id`: the activity entry). */
  | { loch: "ui"; type: "source-report"; id: string }
  /** The active wallet's viewing key. */
  | { loch: "ui"; type: "viewing-key" }
  /** A depth proof: the active wallet holds at least `threshold` lamports, answering the verifier's `challenge`. */
  | { loch: "ui"; type: "depth-proof"; threshold: string; challenge: string }
  | { loch: "ui"; type: "surface"; to: string; amount: string; fee: string }
  | { loch: "ui"; type: "consolidate"; fee: string }
  | { loch: "ui"; type: "surface-warnings"; to: string; amount: string; fee: string }
  | { loch: "ui"; type: "check-address"; kind: "shielded" | "public"; text: string }
  /** Makes the active wallet's next payment code. */
  | { loch: "ui"; type: "payment-code" }
  /** `fee`: the relayer fee the user now agrees to, when the failure was that the fee changed. */
  | { loch: "ui"; type: "flow-retry"; fee?: string }
  | { loch: "ui"; type: "flow-cancel" }
  | { loch: "ui"; type: "flow-dismiss" }
  | { loch: "ui"; type: "scan-start" }
  | { loch: "ui"; type: "scan-cancel" }
  | { loch: "ui"; type: "settings"; patch: Record<string, unknown> };

export type UiReply<T = unknown> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/**
 * The answer to "check-address": whether what was typed is an address of that kind, and if not,
 * why. For a payment code, `address` is the code as it is to be sent and `payee` the shielded
 * address inside it, which is what the activity list knows the recipient by.
 */
export type AddressCheck =
  | { ok: true; address: string; own: boolean; code?: true; payee?: string }
  | { ok: false; reason: "empty" | "encoding" | "prefix" | "checksum" | "length" | "unusable" | "public-address" | "shielded-address" | "not-an-address" };

/**
 * The answer to "payment-code". `made`: a new code, counted. `limit`: twenty codes in a row
 * have not been paid yet, so none was made and `code` is the newest of those, to use again.
 */
export interface PaymentCodeReply {
  status: "made" | "limit";
  code: string;
  /** How many codes this wallet has made on this device, this one included. */
  made: number;
}

/** The answer to "claim-check". `own`: this device made the link, so collecting it takes the payment back. */
export type ClaimCheck = { ok: true; amount: string; own: boolean } | { ok: false; reason: "empty" | "not-a-code" | "checksum" };

/** The answer to "claim-code". The code is the money: whoever has it can collect. */
export interface ClaimCodeReply {
  code: string;
  /** Lamports in the note. */
  amount: string;
}

/** The answer to "receipt". */
export interface ReceiptReply {
  /** The receipt as text (one line of JSON), to hand to whoever asks for proof of the payment. */
  receipt: string;
}

/** The answer to "source-report". */
export interface SourceReportReply {
  /** The report as text (JSON). */
  report: string;
  /** Transactions of this wallet the report opens, the withdrawal included. */
  transactions: number;
  /** Notes on the trail whose origin this device cannot show: received from someone else, or made before it kept records. */
  undisclosed: number;
}

/** The answer to "viewing-key". */
export interface ViewingKeyReply {
  key: string;
}

/** The answer to "depth-proof". Nothing in it is secret: it is meant to be handed over. */
export interface DepthProofReply {
  /** The proof as text (lochdepth1...). */
  code: string;
  /** The verification page with the code after "#". */
  link: string;
  /** Lamports the proof says the wallet holds at least. */
  threshold: string;
  /** How many notes it shows. */
  notes: number;
}

/** The answer to "public-balance". */
export type PublicBalanceReply =
  | { status: "read"; lamports: string; at: number }
  | { status: "unreachable"; detail: string };

export interface SurfaceWarningView {
  id: "same-address" | "same-amount" | "soon-after" | "shown";
  /** The deposit the warning points at: lamports, when, and the address it came from. */
  amount?: string;
  at?: number;
  from?: string;
}

/** The service worker tells open pages that the snapshot changed. They ask for it again. */
export const STATE_CHANGED = "loch:state-changed";
