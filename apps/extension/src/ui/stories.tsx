// The interface with fixture data and no extension behind it: every screen and state, for
// screenshots and design review. Built only by `node scripts/build.mjs --stories`, into
// dist-stories, and never part of the extension package.
//
//   stories.html?story=home&theme=night&view=popup

import "@loch/design/all.css";
import "./app.css";

import { SPRITE } from "@loch/design/icons";
import { render } from "preact";

import type { Flow as ScanFlow, LeakReport } from "@loch/scanner-core";

import type { ActivityEntry, AddressCheck, Failure, FlowView, PayLinkReply, PaymentCodeReply, PublicBalanceReply, Quote, ScanView, Snapshot, SurfaceWarningView, UiReply, UiRequest } from "../shared/view.js";
import { mainnetTestingEnabled } from "../shared/build.js";
import { PAY_PAGE } from "../shared/constants.js";
import type { Api, Draft } from "./api.js";
import { App } from "./App.js";

const NOW = new Date(2026, 9, 3, 14, 5, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WALLET = "Fh3qJ5iBgbd2x9vVqk1mF7yq8a3xgWzJYQeUcTz8K";
const OTHER_WALLET = "8sKpN4zQw7HdLmTc2VbXy9RuJf5GaE3tW6oMiP1Dn4Y";
const DEST = "9fRkQ7mHsT2dXw8yLcVbN5pJ3aZu6KeG4oWiR12mVd";
const SHIELDED = "loch1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4kqw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4kqw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const RECIPIENT = "loch17yk2n6v0h8s4x3q9zr5c7d2f8g6j4m0p3w9t5e7a2u6l8y4k0v3n9s5x7q2z8r4c6d0f2g8j6mh3p9w5t7e3a0u2l4y6k8v0n2s4x6q8z0rmq4d";
/** The payment code of the test vectors in docs/protocol.md. */
const PAYMENT_CODE = "lochpay1q87ep4a7lwncng5nw8hhst92u0nu49c3u6d5evle76kee3wzph57mljdndnkyt92jgjudplsxjf80nszkrh3ng58cdcrm64pmxzgvcfd323ddheptfsehytkcj36ce325yep3gvlm84p03r88jm6rafud5ws8y5m";
// Built with LOCH_MAINNET_TESTING=1, the fixtures are those of the mainnet package and its services.
const MAINNET = mainnetTestingEnabled();
const CLUSTER = MAINNET ? "mainnet-beta" : "devnet";
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

const activity: ActivityEntry[] = [
  { id: "a1", kind: "dive", status: "confirmed", at: NOW - 3 * 60_000, amount: "5000000000", counterparty: WALLET, signature: SIG },
  { id: "a2", kind: "send", status: "confirmed", at: NOW - DAY + 5 * HOUR + 35 * 60_000, amount: "1250000000", fee: "2500000", counterparty: RECIPIENT, signature: SIG },
  { id: "a3", kind: "receive", status: "confirmed", at: NOW - 5 * DAY, amount: "730000000" },
  { id: "a4", kind: "surface", status: "confirmed", at: NOW - 7 * DAY, amount: "2000000000", fee: "2500000", counterparty: DEST, signature: SIG },
  { id: "a5", kind: "consolidate", status: "confirmed", at: NOW - 8 * DAY, amount: "0", fee: "2500000", signature: SIG },
  { id: "a6", kind: "dive", status: "confirmed", at: NOW - 9 * DAY, amount: "10000000000", counterparty: WALLET, signature: SIG },
  { id: "a7", kind: "restored", status: "confirmed", at: NOW - 12 * DAY, amount: "1257500000", count: 2 },
];

const report: LeakReport = {
  address: WALLET,
  scannedTransactions: 300,
  transfers: 412,
  score: 29,
  findings: [
    { id: "funding-source", severity: "high", title: "Funding source is public", detail: "First funds came from 5tzF…uAi9 (Exchange withdrawal). Anyone can follow this link back.", penalty: 20 },
    { id: "identified-services", severity: "high", title: "Linked to identified services", detail: "This wallet has 4 transfers with Exchange withdrawal. These services can tie it to your identity.", penalty: 10 },
    {
      id: "recurring-counterparties",
      severity: "medium",
      title: "Recurring counterparties",
      detail: "4 addresses interact with you 3 or more times (top: 9fRk…2mVd ×14, Bq7T…e1Lw ×9, H2xD…pK4s ×6). Regular payments reveal employers, clients or friends.",
      penalty: 16,
    },
    { id: "time-zone", severity: "medium", title: "Your time zone is guessable", detail: "Almost no activity between 22:00 and 04:00 UTC. That is likely your sleep window.", penalty: 10 },
    { id: "pass-through", severity: "medium", title: "Exact amounts passed straight through", detail: "2 outgoing transfers matched an incoming amount within 10 minutes. This links the sender to the final recipient.", penalty: 10 },
    { id: "balance-visible", severity: "low", title: "Balance is visible to everyone", detail: "41.207 SOL and 6 token accounts are public. Anyone you pay can look.", penalty: 5 },
  ],
};

function scanFlows(): ScanFlow[] {
  const parties: [string, number][] = [
    [DEST, 14],
    ["Bq7TwKm4nXs2Hd9Lc6VbYp3RuJf8GaZe1Lw", 9],
    ["H2xDn5Qw8Tz3Km7Lc1VbXy4RuJf6GaEpK4s", 6],
    ["5tzFh9Kw2Nd6Qm3Lc8VbXy1RuJf4GaEuAi9", 4],
  ];
  const flows: ScanFlow[] = [];
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hourOf = () => {
    for (;;) {
      const hour = Math.floor(random() * 24);
      if (hour >= 22 || hour < 4) {
        if (random() < 0.04) return hour;
      } else return hour;
    }
  };
  const base = Math.floor(NOW / 1000) - 40 * 86_400;
  const push = (counterparty: string, index: number) =>
    flows.push({ sig: `s${flows.length}`, time: base + index * 8000 - ((base + index * 8000) % 86_400) + hourOf() * 3600, dir: random() < 0.4 ? "in" : "out", counterparty, amount: Math.round(random() * 300) / 100, asset: "SOL" });
  for (const [address, count] of parties) for (let i = 0; i < count; i++) push(address, flows.length);
  for (let i = 0; i < 290; i++) push(`other${i}`.padEnd(32, "x"), flows.length);
  return flows;
}

const doneScan: ScanView = { status: "done", report, flows: scanFlows(), skipped: 0, scannedAt: NOW - 2 * HOUR };

const base: Snapshot = {
  revision: 1,
  version: "0.1.0",
  settings: {
    rpcUrl: MAINNET ? "https://rpc.lochlayer.com" : "https://api.devnet.solana.com",
    relayerUrl: MAINNET ? "https://relayer-mainnet.lochlayer.com" : "https://relayer.devnet.loch.example",
    screenerUrl: MAINNET ? "https://screener-mainnet.lochlayer.com" : "https://screener.devnet.loch.example",
    connectUrl: MAINNET ? "https://connect.lochlayer.com/connect.html" : "https://connect.loch.example/",
    connectFixed: MAINNET,
    theme: "night",
    wrapperEnabled: true,
    warnFirstRecipients: false,
    maxFeeLamports: "5000000",
    ohttp: { enabled: false, relayUrl: "", keyConfig: "", pinnedKey: "", available: true },
  },
  wallets: [{ address: WALLET, walletName: "Phantom", unlocked: true }],
  active: WALLET,
  cluster: CLUSTER,
  publicBalance: "41207400000",
  publicBalanceAt: NOW - 3 * 60_000,
  shielded: { address: SHIELDED, balance: "12480739112", spendable: "12480739112", largestPair: "12480739112", notes: 2, settling: 0 },
  loch2: null,
  sync: { status: "synced", at: NOW - 3 * 60_000 },
  activity: activity.slice(0, 4),
  flow: null,
  scan: doneScan,
  build: {
    artifacts: {
      "transaction.wasm": { sha256: "c18d5874492e570ce9d51fa13927eb118ddb7204393403b3a9154c22f4d51ca7", bytes: 2510600 },
      "transaction_final.zkey": { sha256: "7116cd68120ddc9e8b025754c82166e1404c2bce67c34df16989650b58596632", bytes: 7454974 },
    },
    setup: "single-contributor development setup",
    circuit: "Transaction(20, 2, 2)",
  },
};

const CONNECT_URL = MAINNET ? "https://connect.lochlayer.com/connect.html" : "https://connect.loch.example/";

const flow = (over: Partial<FlowView> & Pick<FlowView, "kind" | "step" | "status">): FlowView => ({
  id: "f1",
  ...(over.kind === "unlock" || over.kind === "dive" ? { connectUrl: CONNECT_URL } : {}),
  stepStartedAt: NOW - 5000,
  createdAt: NOW - 9000,
  attempt: 1,
  cancellable: true,
  proofKept: false,
  bound: false,
  ...over,
});
const failed = (kind: FlowView["kind"], step: string, failure: Failure, over: Partial<FlowView> = {}): FlowView =>
  flow({ kind, step, status: "failed", failure, cancellable: false, amount: "1250000000", fee: "2500000", to: RECIPIENT, ...over });

const sendFlow = { amount: "1250000000", fee: "2500000", to: RECIPIENT };
const quoteSpend: Quote = { cluster: CLUSTER, pool: null, relayer: { fee: "2500000", minWithdrawal: "1000000", address: DEST }, screener: null };
const quoteDive: Quote = { cluster: CLUSTER, pool: { maxDeposit: "10000000000", paused: false }, relayer: null, screener: { maxDeposit: "10000000000", policy: "Deposits from sanctioned addresses are refused." } };

interface Story {
  snapshot: Snapshot;
  draft?: Draft;
  quote?: Quote;
  /** What the worker answers when the public balance is asked for. Default: read, as in the snapshot. */
  balance?: PublicBalanceReply;
  address?: AddressCheck;
  code?: PaymentCodeReply;
  /** The pay link the wallet already has, if any. */
  payLink?: PayLinkReply;
  warnings?: SurfaceWarningView[];
  /** Runs after the first paint: opens a view, clicks a row, scrolls. */
  after?: (root: ParentNode) => void;
}

const click = (selector: string, text?: string) => (root: ParentNode) => {
  const found = Array.from(root.querySelectorAll<HTMLElement>(selector)).find((node) => !text || node.textContent?.trim() === text);
  found?.click();
};
const chain =
  (...steps: ((root: ParentNode) => void)[]) =>
  (root: ParentNode) => {
    steps.forEach((step, index) => setTimeout(() => step(root), index * 60));
  };
const scrollTo = (selector: string, top: number) => (root: ParentNode) => {
  const node = root.querySelector<HTMLElement>(selector);
  if (node) node.scrollTop = top;
};

/** Typing into a field of the settings form, as a person would. */
const type = (selector: string, value: string) => (root: ParentNode) => {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const reveal = (selector: string, block: ScrollLogicalPosition = "center") => (root: ParentNode) => {
  setTimeout(() => root.querySelector(selector)?.scrollIntoView({ block }), 80);
};
const SETTINGS = [click(".popup__gear")] as const;
/** A row of a pick list, by its name. */
const row = (name: string) => (root: ParentNode) => {
  const found = Array.from(root.querySelectorAll<HTMLElement>(".picklist__name")).find((node) => node.textContent?.trim() === name);
  found?.closest<HTMLElement>("button")?.click();
};
const ADVANCED = [...SETTINGS, row("Advanced")] as const;
const openDetails = (selector: string) => (root: ParentNode) => {
  const node = root.querySelector<HTMLDetailsElement>(selector);
  if (node) node.open = true;
};
const RECEIVE = click(".popup__actions button", "Receive");
/** An earlier withdrawal whose request is with a relayer: the list says its outcome is not known. */
const openSurface: ActivityEntry = { id: "p2", kind: "surface", status: "unknown", at: NOW - 12 * 60_000, amount: "2000000000", fee: "2500000", counterparty: DEST };
/** A spend that failed after its request had been handed to a relayer. */
const handed = { proofKept: true, bound: true } as const;
const reserved: Snapshot["shielded"] = { ...base.shielded!, balance: "11228239112", spendable: "6480739112", largestPair: "6480739112", settling: 1 };

const empty: Snapshot = { ...base, publicBalance: "2000000000", publicBalanceAt: NOW - 60_000, shielded: { ...base.shielded!, balance: "0", spendable: "0", largestPair: "0", notes: 0 }, activity: [], scan: { status: "idle" } };
const noWallet: Snapshot = { ...base, wallets: [], active: null, publicBalance: null, publicBalanceAt: null, shielded: null, activity: [], scan: { status: "idle" }, sync: { status: "idle" }, cluster: null };

const STORIES: Record<string, Story> = {
  welcome: { snapshot: noWallet },
  "connect-opening": { snapshot: { ...noWallet, flow: flow({ kind: "unlock", step: "discovering", status: "running", firstTime: true, wallets: [] }) } },
  "connect-choose": {
    snapshot: {
      ...noWallet,
      flow: flow({
        kind: "unlock",
        step: "choosing",
        status: "waiting",
        firstTime: true,
        wallets: [
          { name: "Phantom", features: [], chains: [] },
          { name: "Solflare", features: [], chains: [] },
          { name: "Backpack", features: [], chains: [] },
        ],
      }),
    },
  },
  "connect-signing": { snapshot: { ...noWallet, flow: flow({ kind: "unlock", step: "signing", status: "waiting", firstTime: true, walletName: "Phantom" }) } },
  "connect-no-wallet": { snapshot: { ...noWallet, flow: failed("unlock", "discovering", { code: "no-wallet", moved: "no", retry: true }, { amount: undefined, fee: undefined, to: undefined }) } },
  "connect-not-deterministic": { snapshot: { ...noWallet, flow: failed("unlock", "signing-again", { code: "not-deterministic", moved: "no", retry: false }, { amount: undefined, fee: undefined, to: undefined, walletName: "Ledger" }) } },
  locked: { snapshot: { ...base, wallets: [{ ...base.wallets[0]!, unlocked: false }], shielded: null, activity: [], scan: { status: "idle" }, sync: { status: "idle" } } },
  "unlock-signing": {
    snapshot: {
      ...base,
      wallets: [{ ...base.wallets[0]!, unlocked: false }],
      shielded: null,
      activity: [],
      scan: { status: "idle" },
      flow: flow({ kind: "unlock", step: "signing", status: "waiting", firstTime: false, walletName: "Phantom" }),
    },
  },
  "unlock-signature-changed": {
    snapshot: {
      ...base,
      wallets: [{ ...base.wallets[0]!, unlocked: false }],
      shielded: null,
      activity: [],
      scan: { status: "idle" },
      flow: failed("unlock", "signing", { code: "signature-changed", moved: "no", retry: true }, { amount: undefined, fee: undefined, to: undefined, walletName: "Phantom" }),
    },
  },
  home: { snapshot: base },
  "home-empty": { snapshot: empty },
  // The public balance has not been asked for: a sync does not read it.
  "home-balance-unread": { snapshot: { ...base, publicBalance: null, publicBalanceAt: null } },
  "home-syncing": { snapshot: { ...base, sync: { status: "syncing", at: NOW - 60_000, progress: { fetched: 120, total: 300 } } } },
  "home-behind": { snapshot: { ...base, sync: { status: "behind", at: NOW - 20_000, behind: 3 } } },
  "home-rpc-down": { snapshot: { ...base, sync: { status: "unreachable", at: NOW - 12 * 60_000, detail: "api.devnet.solana.com did not answer in time" } } },
  "home-settling": {
    snapshot: {
      ...base,
      shielded: { ...base.shielded!, balance: "11228239112", spendable: "0", settling: 1 },
      activity: [{ id: "p1", kind: "send", status: "unknown", at: NOW - 20_000, amount: "1250000000", fee: "2500000", counterparty: RECIPIENT }, ...activity.slice(0, 3)],
    },
  },
  "home-mainnet": { snapshot: { ...base, cluster: "mainnet-beta", sync: { status: "mainnet" } } },
  "home-toast": { snapshot: { ...base, flow: flow({ kind: "dive", step: "done", status: "done", amount: "5000000000" }) } },
  wallets: {
    snapshot: { ...base, wallets: [...base.wallets, { address: OTHER_WALLET, walletName: "Solflare", unlocked: false }] },
    after: click(".address-chip"),
  },

  "dive-form": { snapshot: base, draft: { kind: "dive", to: "", amount: "5" }, quote: quoteDive },
  "dive-form-above-max": { snapshot: base, draft: { kind: "dive", to: "", amount: "12.5" }, quote: quoteDive },
  "dive-form-paused": { snapshot: base, draft: { kind: "dive", to: "", amount: "5" }, quote: { ...quoteDive, pool: { maxDeposit: "10000000000", paused: true } } },
  "dive-screening": { snapshot: { ...base, flow: flow({ kind: "dive", step: "screening", status: "running", amount: "5000000000", walletName: "Phantom", proofKept: true }) } },
  "dive-signing": { snapshot: { ...base, flow: flow({ kind: "dive", step: "signing", status: "waiting", amount: "5000000000", walletName: "Phantom", proofKept: true }) } },
  "dive-denied": { snapshot: { ...base, flow: failed("dive", "screening", { code: "screening-denied", moved: "no", retry: false }, { amount: "5000000000", fee: undefined, to: undefined, proofKept: true }) } },
  "dive-rejected": { snapshot: { ...base, flow: failed("dive", "signing", { code: "wallet-rejected", moved: "no", retry: true }, { amount: "5000000000", fee: undefined, to: undefined, proofKept: true, walletName: "Phantom" }) } },
  "dive-insufficient": {
    snapshot: {
      ...base,
      flow: failed("dive", "checking", { code: "insufficient-public", moved: "no", retry: false, amount: "41207400000", limit: "45002797920" }, { amount: "45000000000", fee: undefined, to: undefined }),
    },
  },
  "dive-paused": { snapshot: { ...base, flow: failed("dive", "checking", { code: "deposits-paused", moved: "no", retry: false }, { amount: "5000000000", fee: undefined, to: undefined }) } },

  "send-form": { snapshot: base, draft: { kind: "send", to: RECIPIENT, amount: "1.25" }, quote: quoteSpend, address: { ok: true, address: RECIPIENT, own: false } },
  "send-form-code": { snapshot: base, draft: { kind: "send", to: PAYMENT_CODE, amount: "1.25" }, quote: quoteSpend, address: { ok: true, address: PAYMENT_CODE, own: false, code: true, payee: RECIPIENT } },
  "send-form-empty": { snapshot: base, draft: { kind: "send", to: "", amount: "" }, quote: quoteSpend },
  "send-form-bad-address": { snapshot: base, draft: { kind: "send", to: "9fRkQ7mHsT2dXw8yLcVbN5pJ3aZu6KeG4oWiR12mVd", amount: "1.25" }, quote: quoteSpend, address: { ok: false, reason: "public-address" } },
  "send-form-too-much": { snapshot: base, draft: { kind: "send", to: RECIPIENT, amount: "20" }, quote: quoteSpend, address: { ok: true, address: RECIPIENT, own: false } },
  "send-form-consolidate": {
    snapshot: { ...base, shielded: { ...base.shielded!, largestPair: "8000000000", notes: 4 } },
    draft: { kind: "send", to: RECIPIENT, amount: "10" },
    quote: quoteSpend,
    address: { ok: true, address: RECIPIENT, own: false },
  },
  "send-form-relayer-down": { snapshot: base, draft: { kind: "send", to: RECIPIENT, amount: "1.25" }, quote: { ...quoteSpend, relayer: null, relayerError: "relayer.devnet.loch.example did not answer in time" }, address: { ok: true, address: RECIPIENT, own: false } },
  "send-proving": { snapshot: { ...base, flow: flow({ kind: "send", step: "proving", status: "running", ...sendFlow }) } },
  "send-sending": { snapshot: { ...base, flow: flow({ kind: "send", step: "sending", status: "running", cancellable: false, proofKept: true, ...sendFlow }) } },
  // The request had left when the relayer went quiet: what is known, and that the notes stay reserved.
  "send-failed": {
    snapshot: {
      ...base,
      shielded: reserved,
      flow: failed("send", "sending", { code: "relayer-unreachable", moved: "unknown", retry: true, reason: "timeout", detail: "relayer.devnet.loch.example: network_error (timeout)" }, { ...handed, fee: "2500000" }),
    },
  },
  "send-relayer-says-no": {
    snapshot: {
      ...base,
      shielded: reserved,
      flow: failed("send", "sending", { code: "relayer-unavailable", moved: "unknown", retry: true, detail: "relayer.devnet.loch.example: unavailable" }, { ...handed, fee: "2500000" }),
    },
  },
  "send-unconfirmed": {
    snapshot: {
      ...base,
      shielded: reserved,
      flow: failed("send", "confirming", { code: "relayer-unconfirmed", moved: "unknown", retry: true, detail: "relayer.devnet.loch.example answered with transaction 5VERv8NM…" }, { ...handed, fee: "2500000" }),
    },
  },
  "send-confirming": { snapshot: { ...base, shielded: reserved, flow: flow({ kind: "send", step: "confirming", status: "running", cancellable: false, ...handed, ...sendFlow, fee: "2500000" }) } },
  "send-relayer-unreachable": {
    snapshot: { ...base, flow: failed("send", "checking", { code: "relayer-unreachable", moved: "no", retry: true, reason: "unreachable", detail: "relayer.devnet.loch.example: network_error (unreachable)" }, { fee: "2500000" }) },
  },
  "send-interrupted": { snapshot: { ...base, shielded: reserved, flow: failed("send", "sending", { code: "interrupted", moved: "unknown", retry: true }, { ...handed, fee: "2500000" }) } },
  "send-fee-changed-open": {
    snapshot: {
      ...base,
      shielded: reserved,
      flow: failed("send", "checking", { code: "fee-changed", moved: "unknown", retry: true, amount: "3000000", limit: "2500000" }, { bound: true, fee: "2500000" }),
    },
  },
  "send-reserved-short": {
    snapshot: {
      ...base,
      shielded: reserved,
      flow: failed("send", "checking", { code: "reserved-short", moved: "unknown", retry: true, amount: "6000000000", limit: "6000500000" }, { bound: true, amount: "5997500000", fee: "3000000" }),
    },
  },
  "send-fee-changed": { snapshot: { ...base, flow: failed("send", "checking", { code: "fee-changed", moved: "no", retry: false, amount: "3000000", limit: "2500000" }) } },
  "send-consolidation": { snapshot: { ...base, flow: failed("send", "checking", { code: "consolidation-needed", moved: "no", retry: false, count: 4 }, { fee: "2500000" }) } },

  "surface-form": { snapshot: base, draft: { kind: "surface", to: DEST, amount: "2" }, quote: quoteSpend, address: { ok: true, address: DEST, own: false } },
  "surface-form-warnings": {
    snapshot: base,
    draft: { kind: "surface", to: WALLET, amount: "4.9975" },
    quote: quoteSpend,
    address: { ok: true, address: WALLET, own: true },
    warnings: [
      { id: "same-address", amount: "5000000000", at: NOW - 3 * 60_000, from: WALLET },
      { id: "same-amount", amount: "5000000000", at: NOW - 3 * 60_000, from: WALLET },
      { id: "soon-after", amount: "5000000000", at: NOW - 3 * 60_000, from: WALLET },
    ],
  },
  // An earlier withdrawal to the same address is still with a relayer.
  "surface-form-open-earlier": {
    snapshot: { ...base, shielded: reserved, activity: [openSurface, ...activity.slice(0, 3)] },
    draft: { kind: "surface", to: DEST, amount: "2" },
    quote: quoteSpend,
    address: { ok: true, address: DEST, own: false },
    after: reveal("#form-surface .notice--caution", "end"),
  },
  "surface-form-small": { snapshot: base, draft: { kind: "surface", to: DEST, amount: "0.0005" }, quote: quoteSpend, address: { ok: true, address: DEST, own: false } },
  "surface-proving": { snapshot: { ...base, flow: flow({ kind: "surface", step: "proving", status: "running", amount: "2000000000", fee: "2500000", to: DEST }) } },

  receive: { snapshot: base, after: RECEIVE },
  "receive-code": { snapshot: base, after: chain(RECEIVE, openDetails(".receive__more details:nth-of-type(2)"), click(".receive__code button", "Make a payment code"), reveal(".receive__more", "start")) },
  "receive-address": { snapshot: base, after: chain(RECEIVE, openDetails(".receive__more details:nth-of-type(1)"), reveal(".receive__more", "start")) },
  "receive-pay-link": {
    snapshot: base,
    payLink: { status: "kept", code: PAYMENT_CODE, link: `${PAY_PAGE}${PAYMENT_CODE}` },
    after: chain(RECEIVE, reveal("#receive-paylink-title", "start")),
  },
  "receive-pay-link-new": { snapshot: base, after: chain(RECEIVE, click(".paylink button", "Make your pay link"), reveal("#receive-paylink-title", "start")) },
  "receive-code-limit": {
    snapshot: base,
    code: { status: "limit", code: PAYMENT_CODE, made: 20 },
    after: chain(RECEIVE, openDetails(".receive__more details:nth-of-type(2)"), click(".receive__code button", "Make a payment code"), reveal(".receive__more", "start")),
  },
  activity: { snapshot: { ...base, activity }, after: click(".popup__deep-head a", "All activity") },
  "activity-receipt": {
    snapshot: { ...base, activity: activity.map((entry) => (entry.id === "a2" ? { ...entry, record: true as const } : entry)) },
    after: chain(click(".popup__deep-head a", "All activity"), click(".activity--full li:nth-child(2) button"), reveal(".activity__proof", "center")),
  },
  "activity-report": {
    snapshot: { ...base, activity: activity.map((entry) => (entry.id === "a4" ? { ...entry, record: true as const } : entry)) },
    after: chain(click(".popup__deep-head a", "All activity"), click(".activity--full li:nth-child(4) button"), reveal(".activity__proof", "center")),
  },
  "activity-claim-link": {
    snapshot: { ...base, activity: activity.map(({ counterparty, ...entry }) => (entry.id === "a2" ? { ...entry, claim: true as const, record: true as const } : { ...entry, ...(counterparty ? { counterparty } : {}) })) },
    after: chain(click(".popup__deep-head a", "All activity"), click(".activity--full li:nth-child(2) button"), reveal(".activity__proof", "center")),
  },
  "send-form-link": { snapshot: base, draft: { kind: "send", to: "", amount: "0.5" }, quote: quoteSpend, after: chain(() => undefined, click(".form__switch", "Send as a link instead")) },
  "receive-collect": { snapshot: base, after: chain(RECEIVE, openDetails(".receive__more details:nth-of-type(3)"), reveal(".receive__more", "start")) },
  "settings-depth": { snapshot: base, after: chain(...SETTINGS, row("Prove depth")) },
  // The proof is made: the code, the link, and what it shows and costs.
  "settings-depth-made": {
    snapshot: base,
    after: chain(...SETTINGS, row("Prove depth"), type("#depth-amount", "5"), type("#depth-challenge", "OTC desk 2026-10-20 #7f3a"), click(".settings button", "Make the proof")),
  },
  "surface-form-shown": {
    snapshot: base,
    draft: { kind: "surface", to: DEST, amount: "2" },
    quote: quoteSpend,
    address: { ok: true, address: DEST, own: false },
    warnings: [{ id: "shown" }],
  },
  "settings-viewing-key": { snapshot: base, after: chain(...SETTINGS, row("Viewing key"), click(".settings button", "Show viewing key")) },
  "activity-open": { snapshot: { ...base, activity }, after: chain(click(".popup__deep-head a", "All activity"), click(".activity--full li:nth-child(2) button")) },
  report: { snapshot: base, after: click(".score") },
  "report-statement": { snapshot: base, after: chain(click(".score"), scrollTo(".popup__view", 330)) },
  "report-empty": { snapshot: { ...base, scan: { status: "idle" } }, after: click(".score") },
  "report-scanning": { snapshot: { ...base, scan: { status: "running", progress: { fetched: 140, total: 300, skipped: 0 }, startedAt: NOW - 4000 } }, after: click(".score") },
  "report-failed": { snapshot: { ...base, scan: { status: "failed", error: "api.devnet.solana.com: 429 Too Many Requests" } }, after: click(".score") },
  settings: { snapshot: base, after: chain(...SETTINGS) },
  // The connect page was changed in the form and Save was pressed: Loch asks before it is sent.
  "settings-connect-confirm": {
    snapshot: base,
    after: chain(...ADVANCED, type("#set-connectUrl", "https://pages.example.org/connect.html"), click(".settings button", "Save endpoints"), reveal(".settings [role='alertdialog']", "end")),
  },
  // A release build: the connect page is compiled in, and there is no field for it.
  "settings-connect-fixed": {
    snapshot: { ...base, settings: { ...base.settings, connectFixed: true } },
    after: chain(...ADVANCED, reveal("#set-maxfee", "end")),
  },
  "settings-websites": { snapshot: base, after: chain(...SETTINGS, row("Connected sites")) },
  "settings-advanced": { snapshot: base, after: chain(...ADVANCED) },
  "settings-more": { snapshot: base, after: chain(...ADVANCED, scrollTo(".popup__view", 560)) },
  "settings-forget": {
    snapshot: base,
    after: chain(...ADVANCED, click(".settings button", "Forget this wallet on this device"), (root) =>
      setTimeout(() => root.querySelector("[role='alertdialog'].notice")?.scrollIntoView({ block: "center" }), 80),
    ),
  },
  "settings-about": { snapshot: base, after: chain(...ADVANCED, openDetails("#set-about"), scrollTo(".popup__view", 4000)) },
};

const WIDE_AFTER: Record<string, (root: ParentNode) => void> = {
  report: click(".tabs__tab", "Leak report"),
  settings: click(".tabs__tab", "Settings"),
};

const params = new URLSearchParams(location.search);
const name = params.get("story") ?? "home";
const theme = params.get("theme") === "dusk" ? "dusk" : "night";
const popup = params.get("view") !== "wide";
const story = STORIES[name] ?? STORIES.home!;
const snapshot: Snapshot = { ...story.snapshot, settings: { ...story.snapshot.settings, theme } };

const ok = <T,>(value: T): UiReply<T> => ({ ok: true, value });
const api: Api = {
  popup,
  async call<T>(request: UiRequest): Promise<UiReply<T>> {
    switch (request.type) {
      case "state":
        return ok(snapshot) as UiReply<T>;
      case "quote":
        return ok(story.quote ?? (request.want === "dive" ? quoteDive : quoteSpend)) as UiReply<T>;
      case "public-balance":
        return ok(story.balance ?? ({ status: "read", lamports: snapshot.publicBalance ?? "0", at: NOW } satisfies PublicBalanceReply)) as UiReply<T>;
      case "check-address":
        return ok(story.address ?? ({ ok: false, reason: "empty" } satisfies AddressCheck)) as UiReply<T>;
      case "surface-warnings":
        return ok(story.warnings ?? []) as UiReply<T>;
      case "viewing-key":
        return ok({ key: "lochview1" + PAYMENT_CODE.slice(8) + "qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn" }) as UiReply<T>;
      case "source-report":
        return ok({ report: "{}", transactions: 4, undisclosed: 1 }) as UiReply<T>;
      case "depth-proof": {
        const code = `lochdepth1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(23)}`;
        return ok({ code, link: `https://lochlayer.com/verify#${code}`, threshold: request.threshold, notes: 2 }) as UiReply<T>;
      }
      case "payment-code":
        return ok(story.code ?? ({ status: "made", code: PAYMENT_CODE, made: 1 } satisfies PaymentCodeReply)) as UiReply<T>;
      case "pay-link":
        if (request.action === "show") return ok(story.payLink ?? null) as UiReply<T>;
        return ok(story.payLink ?? ({ status: "made", code: PAYMENT_CODE, link: `${PAY_PAGE}${PAYMENT_CODE}` } satisfies PayLinkReply)) as UiReply<T>;
      default:
        return ok(null) as UiReply<T>;
    }
  },
  subscribe: () => () => undefined,
  copy: async () => true,
  save: () => true,
  openExpanded: () => undefined,
  requestAccess: async () => true,
  draft: async () => story.draft ?? null,
  setDraft: async () => undefined,
  packaged: (path) => path,
  now: () => NOW,
};

document.documentElement.dataset.view = popup ? "popup" : "wide";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.story = name;
document.body.insertAdjacentHTML("afterbegin", SPRITE);
const root = document.getElementById("app")!;
render(<App api={api} />, root);
const after = popup ? story.after : (WIDE_AFTER[name] ?? undefined);
setTimeout(() => {
  after?.(document);
  setTimeout(() => (document.documentElement.dataset.ready = "true"), 500);
}, 120);

export const STORY_NAMES = Object.keys(STORIES);
(window as unknown as { __stories: string[] }).__stories = STORY_NAMES;
