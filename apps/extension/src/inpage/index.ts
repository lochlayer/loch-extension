// The page script. It runs in the page's own JavaScript world at document_start, where wallets
// register themselves. Two jobs:
//
//   1. On the connect page only: carry requests from the Loch interface to the wallet and the
//      answers back (the bridge).
//   2. On every page, when the wrapper is on and a wallet is connected in Loch: register the
//      Loch wallet, which stands in front of the user's wallet (inpage/wrapper.ts).
//
// Until the content script tells it to do one of the two it does nothing a page could notice:
// it sets no global, posts no window message, listens for no wallet and dispatches no event.
// With the wrapper off, and on a page that is not the connect page, that is how it stays.
//
// It talks to the content script over a private MessagePort, handed over once, while the
// document is still empty: before any code of the page exists that could see or imitate the
// exchange. So a page cannot read a bridge answer in passing, cannot forge the extension's
// verdict on a transaction, and cannot make this script register a wallet.
//
// This world is shared with the page, so nothing here is trusted by the rest of the extension
// and nothing secret ever comes here. The content script tells this script one thing about the
// user: the name of the wallet to stand in front of.

// safe.ts first: it captures the built-ins before anything else runs.
import { type Bytes, cancel, dictionary, later, messageData, messagePort, nonce, own, post, preventDefault, put, toBase64 } from "./safe.js";
import { HELLO_EVENT, PORT_EVENT, parseBridgeRequest } from "../shared/messages.js";
import { answerBridgeRequest } from "./bridge.js";
import { LOCH_ICON } from "./icon.js";
import { type StandardWallet, type WalletRegistry, isSolanaWallet, registerWallet, watchWallets } from "./standard.js";
import { createLochWallet } from "./wrapper.js";

/** How long the content script has to say it is looking at a transaction before it is passed on unchecked. */
const ACK_TIMEOUT_MS = 2_500;
const NONCE_LENGTH = 22;

(() => {
  let port: MessagePort | null = null;
  let lochWallet: StandardWallet | null = null;
  let registry: WalletRegistry | null = null;
  let registered = false;
  /** Guard requests waiting for the extension: by nonce, each answered once. */
  const waiting = dictionary<{ ack: () => void; verdict: (allow: boolean) => void }>();

  const send = (message: unknown): void => {
    if (port) post(port, message);
  };

  /** Starts listening for wallets. Only once this script has something to do with them. */
  const wallets = (): WalletRegistry => (registry ??= watchWallets(window, (wallet) => wallet === lochWallet || wallet.name === "Loch"));

  function reviewTransactions(account: string, transactions: Bytes[], done: (allow: boolean) => void): void {
    const id = nonce();
    let settled = false;
    const settle = (allow: boolean): void => {
      if (settled) return;
      settled = true;
      delete waiting[id];
      done(allow);
    };
    // If the extension is not there to look (it was reloaded, the worker did not wake), the
    // transaction goes to the wallet as it would without Loch.
    const timer = later(() => settle(true), ACK_TIMEOUT_MS);
    waiting[id] = {
      ack: () => cancel(timer),
      verdict: (allow) => {
        cancel(timer);
        settle(allow);
      },
    };
    const encoded: string[] = [];
    for (let i = 0; i < transactions.length; i++) put(encoded, i, toBase64(transactions[i]!));
    try {
      send({ type: "guard-transactions", nonce: id, account, transactions: encoded });
    } catch {
      cancel(timer);
      settle(true);
    }
  }

  function register(walletName: string): void {
    if (registered) return;
    wallets().onWallet((wallet) => {
      if (registered || wallet.name !== walletName || !isSolanaWallet(wallet)) return;
      registered = true;
      lochWallet = createLochWallet(
        wallet,
        {
          blockedKeyDerivation: () => send({ type: "guard-message", nonce: nonce() }),
          reviewTransactions,
          accounts: (addresses) => send({ type: "accounts", accounts: addresses }),
        },
        LOCH_ICON,
      );
      registerWallet(window, lochWallet);
    });
  }

  /**
   * A message from the content script. Read with what was captured at document_start, field by
   * field, from own properties: by the time one arrives the page may have replaced every
   * method there is.
   */
  function onMessage(event: unknown): void {
    const message = messageData(event);
    const type = own(message, "type");
    if (type === "ack" || type === "verdict") {
      const id = own(message, "nonce");
      if (typeof id !== "string" || id.length !== NONCE_LENGTH) return;
      // A dictionary without a prototype: only a nonce this script made and has not used is found.
      const entry = waiting[id];
      if (!entry) return;
      if (type === "ack") {
        entry.ack();
        return;
      }
      const allow = own(message, "allow");
      // Anything but a plain "yes" stops the request.
      entry.verdict(allow === true);
      return;
    }
    if (type === "config") {
      const wallet = own(message, "wallet");
      if (typeof wallet === "string" && wallet.length > 0 && wallet.length <= 64) register(wallet);
      return;
    }
    if (type === "request") {
      // The connect page only: the content script sends these nowhere else.
      const id = own(message, "nonce");
      const request = parseBridgeRequest(own(message, "request"));
      if (typeof id !== "string" || !request) return;
      void answerBridgeRequest(
        request,
        wallets()
          .list()
          .filter((wallet) => isSolanaWallet(wallet)),
      ).then((answer) => send({ type: "answer", nonce: id, answer }));
    }
  }

  // ---------------------------------------------------------------- the handshake
  // The content script offers a port in an event; whichever of the two scripts runs second
  // finds the other already listening. Both run before the page's first script, so nobody
  // else is there to take the port or to offer one of their own. Exactly one port is taken.
  const onPort = (event: Event): void => {
    if (port) return;
    const offered = messagePort(event);
    if (!offered) return;
    port = offered;
    // Tells the content script, before its dispatch returns, that the port is taken.
    preventDefault(event);
    window.removeEventListener(PORT_EVENT, onPort);
    offered.onmessage = onMessage;
  };
  window.addEventListener(PORT_EVENT, onPort);
  // If the content script is already here it answers this at once, and `onPort` has run by the
  // time the dispatch returns. If it is not, its own offer comes when it starts.
  window.dispatchEvent(new Event(HELLO_EVENT));
  if (!port) {
    // The content script runs in this same phase, before the parser builds the document. Once
    // there is a <head>, the page's own scripts may run, and an offer that comes then is not
    // the extension's. (Other extensions may add a script element before that; a head they do
    // not add.)
    const stop = new MutationObserver(() => {
      if (document.head === null && !port) return;
      stop.disconnect();
      if (!port) window.removeEventListener(PORT_EVENT, onPort);
    });
    stop.observe(document, { childList: true, subtree: true });
  }
})();
