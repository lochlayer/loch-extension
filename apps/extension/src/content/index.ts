// The content script. It runs in every http(s) page's top frame, in an isolated world: it
// shares the page's DOM and nothing else. It is the only part of a web page the service worker
// listens to, and it passes on very little:
//
//   page script -> here -> service worker
//     the answer to a bridge request (only on the connect page, only for a request that is waiting)
//     the addresses the real wallet gave this page through the Loch wallet
//     transactions a site asked the Loch wallet to sign, for a verdict
//
//   service worker -> here -> page script
//     the wallet to stand in front of (only with the wrapper on and a wallet connected)
//     a bridge request (only on the connect page, in the tab the extension opened)
//
// It reaches the page script over a private MessagePort, handed over at document_start, before
// any code of the page runs (see `link` below). It never posts a window message and never
// touches the page's DOM, with two exceptions: the in-page dialog, drawn here in a closed shadow
// root, when the Loch wallet has something to say; and, on the connect page in the tab the
// extension opened, the status line that page offers and the palette of its root element.
//
// On a page where the wrapper is off, or where no wallet is connected in Loch, and which is not
// the connect page, it does nothing a page could notice. It needs no storage: everything it
// knows it is told by the service worker.

import { isRecord } from "../shared/guards.js";
import {
  CONTENT_PORT,
  type ContentConfig,
  type ContentMessage,
  HELLO_EVENT,
  PORT_EVENT,
  type ReviewReply,
  type ToContent,
  type ToPage,
  parseToContent,
  parseToContentScript,
} from "../shared/messages.js";
import { type DialogAssets, showBlockedDialog, showWarningDialog } from "./dialog.js";

let config: ContentConfig = { enabled: false, wallet: null, bridge: false };
let alive = true;
/** Nonces of bridge requests the page has been sent and has not answered. Each is answered once. */
const pendingBridge = new Set<string>();
let assets: Promise<DialogAssets | null> | null = null;
/** One dialog at a time; a page cannot stack them. */
let dialogOpen: Promise<unknown> = Promise.resolve();
/** The "this site asked for your key" dialog is on screen or about to be. Further requests add nothing. */
let blockedShowing = false;
/** A transient user activation lasts about this long in Chromium. */
const ACTIVATION_MS = 5_000;
/** The one account whose transactions are reviewed during the current user activation. */
let reviewing: { account: string; until: number } | null = null;

// ------------------------------------------------------------ to the service worker
//
// Over a port, opened when there is something to say and closed when it has been answered. Only
// the service worker listens for it. (A runtime.sendMessage from here would also reach the popup
// and the expanded view, and the answer to a bridge request is the key-derivation signature.)

let worker: chrome.runtime.Port | null = null;
let nextRequest = 1;
const awaiting = new Map<number, (reply: unknown) => void>();

function workerPort(): chrome.runtime.Port {
  if (worker) return worker;
  const opened = chrome.runtime.connect({ name: CONTENT_PORT });
  worker = opened;
  opened.onMessage.addListener((answer: unknown) => {
    if (!isRecord(answer) || typeof answer.id !== "number") return;
    const resolve = awaiting.get(answer.id);
    awaiting.delete(answer.id);
    resolve?.(answer.reply);
    if (awaiting.size === 0 && worker === opened) {
      worker = null;
      opened.disconnect();
    }
  });
  opened.onDisconnect.addListener(() => {
    if (worker === opened) worker = null;
    // The worker stopped, or refused the port. Whoever was waiting gets no answer.
    for (const [id, resolve] of awaiting) {
      awaiting.delete(id);
      resolve(null);
    }
  });
  return opened;
}

async function ask<T>(message: ContentMessage): Promise<T | null> {
  if (!alive) return null;
  try {
    const port = workerPort();
    const id = nextRequest++;
    return await new Promise<T | null>((resolve) => {
      awaiting.set(id, resolve as (reply: unknown) => void);
      port.postMessage({ id, message });
    });
  } catch {
    // The extension was reloaded or removed: this script is an orphan. Stop relaying.
    alive = false;
    return null;
  }
}

function dialogAssets(): Promise<DialogAssets | null> {
  assets ??= ask<DialogAssets>({ loch: "content", type: "dialog-assets" }).then((reply) => (isRecord(reply) && typeof reply.css === "string" ? reply : null));
  return assets;
}

// ------------------------------------------------------- the private channel
//
// The page script lives in the page's world, so a window message between the two would be
// readable, and forgeable, by every script of the page. Instead this script makes a
// MessageChannel and hands one end to the page script inside an event, dispatched synchronously
// while the document is still empty. Both scripts are injected at document_start, before the
// parser builds anything, so the page's own scripts do not exist yet: nobody else can take the
// port, and nobody can offer one in its place later, because the listeners are gone by then.
//
// The page script signals that it took the port by cancelling the event, which this script sees
// as the return value of dispatchEvent: no second event, nothing left to observe.

const channel = new MessageChannel();
const port = channel.port1;
let linked = false;

const offer = (): boolean => {
  // False when a listener called preventDefault: the page script has the port.
  linked = !window.dispatchEvent(new MessageEvent(PORT_EVENT, { ports: [channel.port2], cancelable: true }));
  return linked;
};

function link(): void {
  // The page script ran first and is listening: it takes the port now.
  if (offer()) return;
  // Otherwise it runs next, in this same phase, and says hello.
  const stop = new MutationObserver(() => {
    // Until the parser has built a <head> no script of the page can have run. From then on a
    // hello is not the page script's, and gets no answer.
    if (document.head === null && !linked) return;
    disarm();
  });
  const onHello = (): void => {
    disarm();
    offer();
  };
  const disarm = (): void => {
    stop.disconnect();
    window.removeEventListener(HELLO_EVENT, onHello);
  };
  window.addEventListener(HELLO_EVENT, onHello);
  stop.observe(document, { childList: true, subtree: true });
}

const post = (message: ToPage): void => {
  if (linked) port.postMessage(message);
};

function sendConfig(): void {
  // Nothing is said to a page unless there is a Loch wallet to register on it.
  if (config.enabled && config.wallet !== null) post({ type: "config", wallet: config.wallet });
}

async function loadConfig(): Promise<void> {
  const reply = await ask<ContentConfig>({ loch: "content", type: "config" });
  if (isRecord(reply) && typeof reply.enabled === "boolean" && typeof reply.bridge === "boolean") {
    config = { enabled: reply.enabled, wallet: reply.enabled && typeof reply.wallet === "string" ? reply.wallet : null, bridge: reply.bridge };
    // The connect page has no script and is drawn in dusk unless its root says otherwise. Only the
    // bridge page is ever told `night` (the service worker decides that from the tab and its exact
    // address), and nothing but this one attribute of the root element is set.
    if (config.bridge && reply.night === true) document.documentElement.setAttribute("data-theme", "night");
  }
  sendConfig();
}

function setStatus(text: string): void {
  // The connect page may show what is going on. It offers an element for that; nothing else is touched.
  const target = document.querySelector("[data-loch-status]");
  if (target) target.textContent = text;
}

/**
 * Whether a review of `account`'s transactions may be asked of the service worker now: only
 * while the page has a fresh user gesture, and for one account per gesture. A page nobody has
 * clicked on gets no review at all, and so learns nothing from one.
 */
function mayReview(account: string): boolean {
  if (navigator.userActivation?.isActive !== true) return false;
  const now = performance.now();
  if (reviewing && now < reviewing.until) return reviewing.account === account;
  reviewing = { account, until: now + ACTIVATION_MS };
  return true;
}

function onPageMessage(message: ToContent): void {
  switch (message.type) {
    case "answer":
      // Only the answer to a request that went out, and only once.
      if (!pendingBridge.delete(message.nonce)) return;
      void ask({ loch: "content", type: "bridge-answer", nonce: message.nonce, answer: message.answer });
      return;
    case "accounts":
      if (!config.enabled) return;
      void ask({ loch: "content", type: "accounts", accounts: message.accounts });
      return;
    case "guard-message":
      if (!config.enabled || blockedShowing) return;
      blockedShowing = true;
      dialogOpen = dialogOpen
        .then(async () => {
          const loaded = await dialogAssets();
          if (loaded) await showBlockedDialog(loaded);
        })
        .catch(() => undefined)
        .then(() => {
          blockedShowing = false;
        });
      return;
    case "guard-transactions": {
      if (!config.enabled) return;
      post({ type: "ack", nonce: message.nonce });
      const verdict = (allow: boolean) => post({ type: "verdict", nonce: message.nonce, allow });
      if (!mayReview(message.account)) return verdict(true);
      void (async () => {
        const reply = await ask<ReviewReply>({ loch: "content", type: "review", account: message.account, transactions: message.transactions });
        if (!isRecord(reply) || reply.action !== "warn") return verdict(true);
        const loaded = await dialogAssets();
        if (!loaded) return verdict(true);
        const shown = dialogOpen.then(() => showWarningDialog(loaded, reply));
        dialogOpen = shown.catch(() => undefined);
        verdict(await shown.catch(() => true));
      })();
      return;
    }
  }
}

port.onmessage = (event: MessageEvent<unknown>) => {
  const message = parseToContent(event.data);
  if (message) onPageMessage(message);
};

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  // Only this extension's own worker and pages: a message from a tab is not one of them.
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  const message = parseToContentScript(raw);
  if (!message) return false;
  if (message.type === "status") {
    if (message.text) setStatus(message.text);
    sendResponse({ ok: true, url: window.location.href });
    return false;
  }
  // A bridge request. The service worker sends one only to the tab it opened at the connect
  // page; this checks the address once more, exactly, where the page cannot fake it.
  if (!linked || window.location.href !== message.url) {
    sendResponse({ accepted: false });
    return false;
  }
  pendingBridge.add(message.nonce);
  setStatus(statusFor(message.request.kind));
  post({ type: "request", nonce: message.nonce, request: message.request });
  sendResponse({ accepted: true });
  return false;
});

function statusFor(kind: string): string {
  switch (kind) {
    case "wallets":
      return "Looking for your wallet on this page.";
    case "connect":
      return "Your wallet is asking whether to connect. Answer it there.";
    case "signMessage":
      return "Your wallet is asking you to sign one message. It unlocks your shielded balance on this device.";
    case "signTransaction":
      return "Your wallet is asking you to approve the deposit.";
    default:
      return "";
  }
}

link();
void loadConfig();
