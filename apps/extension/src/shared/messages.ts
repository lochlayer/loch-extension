// Every message that crosses a context boundary, and the checks that read it.
//
// There are four contexts:
//
//   page script     (MAIN world of a web page)   untrusted: the page's own code runs beside it
//   content script  (isolated world)             trusted code in an untrusted process
//   service worker                               owns all state and every secret
//   extension pages (popup, expanded view, offscreen prover)
//
// Rules:
//   - A message is `unknown` until one of the parse functions here has accepted it. They accept
//     an exact shape: required fields of the right type and size, and no others.
//   - The service worker decides who sent a message from what the browser says about the sender
//     (`classifySender`), never from what the message claims.
//   - A bridge request carries a nonce made by the service worker. An answer is accepted once,
//     only for a nonce that is waiting, only from the tab and the exact address it was sent to.
//   - The page script and the content script talk over a private MessagePort that is handed
//     over once, at document_start, before any code of the page runs (content/index.ts). The
//     page's own scripts cannot read what crosses it and cannot put anything on it. What the
//     page script sends is still untrusted: it runs in the page's world.
//   - Nothing that travels toward a page contains a secret or wallet state.

import { hasOnlyKeys, isBase58Address, isBase64, isNonEmptyString, isRecord, isString } from "./guards.js";

// ------------------------------------------------------------------ limits

/** A serialised Solana transaction is at most 4,096 bytes (version 1, SIMD-0385); base64 of that is 5,464 characters. */
export const MAX_TRANSACTION_B64 = 5464;
/** Messages to sign that the wrapper inspects. Larger ones are passed through unread. */
export const MAX_MESSAGE_B64 = 16 * 1024;
export const MAX_WALLETS = 16;
export const MAX_WALLET_NAME = 64;
export const MAX_ACCOUNTS = 16;
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

function isWalletName(value: unknown): value is string {
  // Printable, no control characters: the name is shown in the interface.
  return isNonEmptyString(value, MAX_WALLET_NAME) && !/[\u0000-\u001f\u007f]/.test(value);
}

// ----------------------------------------------------- bridge: request, answer

export type BridgeRequest =
  | { kind: "wallets" }
  | { kind: "connect"; wallet: string; silent: boolean }
  | { kind: "signMessage"; wallet: string; address: string; message: string }
  | { kind: "signTransaction"; wallet: string; address: string; transaction: string; chain: string };

export type BridgeKind = BridgeRequest["kind"];

export interface WalletInfo {
  name: string;
  /** Wallet Standard feature names the wallet offers, e.g. "solana:signMessage". */
  features: string[];
  /** Chains it lists, e.g. "solana:devnet". */
  chains: string[];
}

export interface BridgeAccount {
  address: string;
  /** The 32-byte public key, base64. Must encode to `address`. */
  publicKey: string;
}

export type BridgeValue =
  | { kind: "wallets"; wallets: WalletInfo[] }
  | { kind: "connect"; accounts: BridgeAccount[] }
  | { kind: "signMessage"; signature: string }
  | { kind: "signTransaction"; signedTransaction: string };

/** "unsupported-version": the wallet does not list version 1 among the transactions it signs. */
export type BridgeErrorCode = "rejected" | "no-wallet" | "no-account" | "unsupported" | "unsupported-version" | "failed";

export interface BridgeFailure {
  code: BridgeErrorCode;
  /** What the wallet said, cut to 200 characters. Shown as text, never interpreted. */
  message: string;
}

export type BridgeAnswer = { ok: true; value: BridgeValue } | { ok: false; error: BridgeFailure };

const BRIDGE_ERROR_CODES: readonly string[] = ["rejected", "no-wallet", "no-account", "unsupported", "unsupported-version", "failed"];
const CHAIN_PATTERN = /^solana:(mainnet|devnet|testnet|localnet)$/;

export function parseBridgeRequest(value: unknown): BridgeRequest | null {
  if (!isRecord(value) || !isString(value.kind, 32)) return null;
  switch (value.kind) {
    case "wallets":
      return hasOnlyKeys(value, ["kind"]) ? { kind: "wallets" } : null;
    case "connect":
      if (!hasOnlyKeys(value, ["kind", "wallet", "silent"]) || !isWalletName(value.wallet) || typeof value.silent !== "boolean") return null;
      return { kind: "connect", wallet: value.wallet, silent: value.silent };
    case "signMessage":
      if (!hasOnlyKeys(value, ["kind", "wallet", "address", "message"])) return null;
      if (!isWalletName(value.wallet) || !isBase58Address(value.address) || !isBase64(value.message, MAX_MESSAGE_B64)) return null;
      return { kind: "signMessage", wallet: value.wallet, address: value.address, message: value.message };
    case "signTransaction":
      if (!hasOnlyKeys(value, ["kind", "wallet", "address", "transaction", "chain"])) return null;
      if (!isWalletName(value.wallet) || !isBase58Address(value.address)) return null;
      if (!isBase64(value.transaction, MAX_TRANSACTION_B64) || value.transaction.length === 0) return null;
      if (!isString(value.chain, 32) || !CHAIN_PATTERN.test(value.chain)) return null;
      return { kind: "signTransaction", wallet: value.wallet, address: value.address, transaction: value.transaction, chain: value.chain };
    default:
      return null;
  }
}

function parseStringList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item, maxLength)) return null;
    out.push(item);
  }
  return out;
}

function parseWalletInfo(value: unknown): WalletInfo | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "features", "chains"]) || !isWalletName(value.name)) return null;
  const features = parseStringList(value.features, 64, 96);
  const chains = parseStringList(value.chains, 32, 64);
  if (!features || !chains) return null;
  return { name: value.name, features, chains };
}

function parseBridgeValue(value: unknown, expected: BridgeKind): BridgeValue | null {
  if (!isRecord(value) || value.kind !== expected) return null;
  switch (expected) {
    case "wallets": {
      if (!hasOnlyKeys(value, ["kind", "wallets"]) || !Array.isArray(value.wallets) || value.wallets.length > MAX_WALLETS) return null;
      const wallets: WalletInfo[] = [];
      for (const item of value.wallets) {
        const wallet = parseWalletInfo(item);
        if (!wallet) return null;
        wallets.push(wallet);
      }
      return { kind: "wallets", wallets };
    }
    case "connect": {
      if (!hasOnlyKeys(value, ["kind", "accounts"]) || !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS) return null;
      const accounts: BridgeAccount[] = [];
      for (const item of value.accounts) {
        if (!isRecord(item) || !hasOnlyKeys(item, ["address", "publicKey"])) return null;
        if (!isBase58Address(item.address) || !isBase64(item.publicKey, 44) || item.publicKey.length !== 44) return null;
        accounts.push({ address: item.address, publicKey: item.publicKey });
      }
      return { kind: "connect", accounts };
    }
    case "signMessage":
      if (!hasOnlyKeys(value, ["kind", "signature"]) || !isBase64(value.signature, 88) || value.signature.length !== 88) return null;
      return { kind: "signMessage", signature: value.signature };
    case "signTransaction":
      if (!hasOnlyKeys(value, ["kind", "signedTransaction"])) return null;
      if (!isBase64(value.signedTransaction, MAX_TRANSACTION_B64) || value.signedTransaction.length === 0) return null;
      return { kind: "signTransaction", signedTransaction: value.signedTransaction };
  }
}

/** Reads the answer to a bridge request of kind `expected`. Null for anything that is not exactly that. */
export function parseBridgeAnswer(value: unknown, expected: BridgeKind): BridgeAnswer | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (value.ok) {
    if (!hasOnlyKeys(value, ["ok", "value"])) return null;
    const parsed = parseBridgeValue(value.value, expected);
    return parsed ? { ok: true, value: parsed } : null;
  }
  if (!hasOnlyKeys(value, ["ok", "error"]) || !isRecord(value.error) || !hasOnlyKeys(value.error, ["code", "message"])) return null;
  const { code, message } = value.error;
  if (!isString(code, 32) || !BRIDGE_ERROR_CODES.includes(code) || !isString(message, 400)) return null;
  return { ok: false, error: { code: code as BridgeErrorCode, message: message.slice(0, 200) } };
}

// -------------------------------------------------- page script <-> content script

/**
 * The two events of the handshake that hands the page script its port. They are dispatched on
 * the window, synchronously, while the document is still empty (document_start), and never
 * again. The names are not secret; what protects the exchange is that it is over before any
 * script of the page exists.
 */
export const PORT_EVENT = "loch:port:1";
export const HELLO_EVENT = "loch:hello:1";

/** Content script to page script, over the private port. */
export type ToPage =
  /** Sent only when the wrapper is on and a wallet is connected in Loch: register the Loch wallet in front of `wallet`. */
  | { type: "config"; wallet: string }
  | { type: "request"; nonce: string; request: BridgeRequest }
  /** The content script has the guard request and is looking at it. Until this arrives the page script may give up waiting. */
  | { type: "ack"; nonce: string }
  | { type: "verdict"; nonce: string; allow: boolean };

/** Page script to content script, over the private port. */
export type ToContent =
  | { type: "answer"; nonce: string; answer: unknown }
  /** The page asked to sign the key-derivation message through the Loch wallet. It is refused; this asks for the explanation to be shown. */
  | { type: "guard-message"; nonce: string }
  | { type: "guard-transactions"; nonce: string; account: string; transactions: string[] }
  /** Addresses the real wallet gave this page through the Loch wallet (its connect result, its account list). */
  | { type: "accounts"; accounts: string[] };

export const MAX_GUARDED_TRANSACTIONS = 8;
/** Accounts of one site the worker remembers. A wallet rarely gives a site more than one. */
export const MAX_SITE_ACCOUNTS = 4;

export function parseToPage(value: unknown): ToPage | null {
  if (!isRecord(value) || !isString(value.type, 32)) return null;
  switch (value.type) {
    case "config":
      if (!hasOnlyKeys(value, ["type", "wallet"]) || !isWalletName(value.wallet)) return null;
      return { type: "config", wallet: value.wallet };
    case "request": {
      if (!hasOnlyKeys(value, ["type", "nonce", "request"]) || !isNonce(value.nonce)) return null;
      const request = parseBridgeRequest(value.request);
      return request ? { type: "request", nonce: value.nonce, request } : null;
    }
    case "ack":
      if (!hasOnlyKeys(value, ["type", "nonce"]) || !isNonce(value.nonce)) return null;
      return { type: "ack", nonce: value.nonce };
    case "verdict":
      if (!hasOnlyKeys(value, ["type", "nonce", "allow"]) || !isNonce(value.nonce) || typeof value.allow !== "boolean") return null;
      return { type: "verdict", nonce: value.nonce, allow: value.allow };
    default:
      return null;
  }
}

function parseAddressList(value: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!isBase58Address(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export function parseToContent(value: unknown): ToContent | null {
  if (!isRecord(value) || !isString(value.type, 32)) return null;
  switch (value.type) {
    case "answer":
      if (!hasOnlyKeys(value, ["type", "nonce", "answer"]) || !isNonce(value.nonce)) return null;
      // The answer's own shape is checked against the request it answers, by whoever holds the request.
      return { type: "answer", nonce: value.nonce, answer: value.answer };
    case "guard-message":
      if (!hasOnlyKeys(value, ["type", "nonce"]) || !isNonce(value.nonce)) return null;
      return { type: "guard-message", nonce: value.nonce };
    case "guard-transactions": {
      if (!hasOnlyKeys(value, ["type", "nonce", "account", "transactions"]) || !isNonce(value.nonce)) return null;
      if (!isBase58Address(value.account) || !Array.isArray(value.transactions)) return null;
      if (value.transactions.length === 0 || value.transactions.length > MAX_GUARDED_TRANSACTIONS) return null;
      const transactions: string[] = [];
      for (const item of value.transactions) {
        // Transactions a wallet is asked to sign may exceed the wire limit before signing; allow some room.
        if (!isBase64(item, 4 * MAX_TRANSACTION_B64) || item.length === 0) return null;
        transactions.push(item);
      }
      return { type: "guard-transactions", nonce: value.nonce, account: value.account, transactions };
    }
    case "accounts": {
      if (!hasOnlyKeys(value, ["type", "accounts"])) return null;
      const accounts = parseAddressList(value.accounts, MAX_ACCOUNTS);
      return accounts ? { type: "accounts", accounts } : null;
    }
    default:
      return null;
  }
}

// ----------------------------------------------------- content script -> service worker

/**
 * The name of the port a content script opens to the service worker. Everything a content
 * script says goes over it, as `{ id, message }`, and is answered as `{ id, reply }`. A port has
 * two ends; `runtime.sendMessage` from a content script would also be delivered to every open
 * page of the extension, and one of these messages carries the key-derivation signature.
 */
export const CONTENT_PORT = "loch-content";

export type ContentMessage =
  | { loch: "content"; type: "config" }
  | { loch: "content"; type: "bridge-answer"; nonce: string; answer: unknown }
  /** Addresses the real wallet gave this page through the Loch wallet. Reviews are made for these and no others. */
  | { loch: "content"; type: "accounts"; accounts: string[] }
  | { loch: "content"; type: "review"; account: string; transactions: string[] }
  | { loch: "content"; type: "dialog-assets" };

export function parseContentMessage(value: unknown): ContentMessage | null {
  if (!isRecord(value) || value.loch !== "content" || !isString(value.type, 32)) return null;
  switch (value.type) {
    case "config":
      return hasOnlyKeys(value, ["loch", "type"]) ? { loch: "content", type: "config" } : null;
    case "dialog-assets":
      return hasOnlyKeys(value, ["loch", "type"]) ? { loch: "content", type: "dialog-assets" } : null;
    case "bridge-answer":
      if (!hasOnlyKeys(value, ["loch", "type", "nonce", "answer"]) || !isNonce(value.nonce)) return null;
      return { loch: "content", type: "bridge-answer", nonce: value.nonce, answer: value.answer };
    case "accounts": {
      if (!hasOnlyKeys(value, ["loch", "type", "accounts"])) return null;
      const accounts = parseAddressList(value.accounts, MAX_ACCOUNTS);
      return accounts ? { loch: "content", type: "accounts", accounts } : null;
    }
    case "review": {
      if (!hasOnlyKeys(value, ["loch", "type", "account", "transactions"]) || !isBase58Address(value.account)) return null;
      if (!Array.isArray(value.transactions) || value.transactions.length === 0 || value.transactions.length > MAX_GUARDED_TRANSACTIONS) return null;
      const transactions: string[] = [];
      for (const item of value.transactions) {
        if (!isBase64(item, 4 * MAX_TRANSACTION_B64) || item.length === 0) return null;
        transactions.push(item);
      }
      return { loch: "content", type: "review", account: value.account, transactions };
    }
    default:
      return null;
  }
}

/** Service worker to content script (through `chrome.tabs.sendMessage`). */
export type ToContentScript =
  /** `url`: the connect page the request is for. The content script passes it on only if that is exactly where it runs. */
  | { loch: "worker"; type: "bridge-request"; nonce: string; url: string; request: BridgeRequest }
  | { loch: "worker"; type: "status"; text: string };

export function parseToContentScript(value: unknown): ToContentScript | null {
  if (!isRecord(value) || value.loch !== "worker" || !isString(value.type, 32)) return null;
  if (value.type === "bridge-request") {
    if (!hasOnlyKeys(value, ["loch", "type", "nonce", "url", "request"]) || !isNonce(value.nonce) || !isNonEmptyString(value.url, 2048)) return null;
    const request = parseBridgeRequest(value.request);
    return request ? { loch: "worker", type: "bridge-request", nonce: value.nonce, url: value.url, request } : null;
  }
  if (value.type === "status") {
    if (!hasOnlyKeys(value, ["loch", "type", "text"]) || !isString(value.text, 300)) return null;
    return { loch: "worker", type: "status", text: value.text };
  }
  return null;
}

/** What the content script is told about this page. */
export interface ContentConfig {
  /** The wrapper is on: register the Loch wallet. */
  enabled: boolean;
  /** The wallet Loch proxies to, by its Wallet Standard name. Null until one is connected, and always null while the wrapper is off. */
  wallet: string | null;
  /** This page is the connect page, in the tab the extension opened for it: it may be asked to reach the wallet. */
  bridge: boolean;
  /**
   * The palette chosen in Loch is night. Set for the bridge page and for no other: the connect
   * page has no script of its own, so the content script sets `data-theme="night"` on its root
   * (apps/connect draws the night palette from that attribute).
   */
  night?: true;
}

export interface ReviewWarning {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}

export interface ReviewTransfer {
  to: string;
  /** Already formatted for reading, e.g. "1.250 SOL" or "25 of token 4zMM…ncDU". */
  amount: string;
}

export type ReviewReply = { action: "pass" } | { action: "warn"; warnings: ReviewWarning[]; transfers: ReviewTransfer[] };

// -------------------------------------------------------------------- senders

export type SenderKind = "ui" | "content" | "worker" | "offscreen";

export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  tab?: { id?: number };
  documentLifecycle?: string;
}

/**
 * Who sent a runtime message, from what the browser reports. Returns null for anything that is
 * not one of this extension's own contexts.
 *
 *   ui         one of this extension's pages (popup or expanded view)
 *   offscreen  the prover document
 *   content    this extension's content script in the top frame of an http(s) page
 */
export function classifySender(sender: SenderLike, extensionId: string): SenderKind | null {
  if (sender.id !== extensionId) return null;
  const ownOrigin = `chrome-extension://${extensionId}`;
  const url = typeof sender.url === "string" ? sender.url : "";
  if (url.startsWith(`${ownOrigin}/`)) {
    if (sender.origin !== undefined && sender.origin !== ownOrigin) return null;
    const path = url.slice(ownOrigin.length).split(/[?#]/)[0];
    if (path === "/app.html") return "ui";
    if (path === "/offscreen.html") return "offscreen";
    if (path === "/background.js") return "worker";
    return null;
  }
  if (sender.tab?.id === undefined || sender.frameId !== 0) return null;
  if (!/^https?:\/\//.test(url)) return null;
  // A prerendered or cached document must not act for the visible page.
  if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active") return null;
  return "content";
}

/** The origin a content-script message really came from, or null. */
export function senderOrigin(sender: SenderLike): string | null {
  const text = sender.origin ?? sender.url;
  if (typeof text !== "string") return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
