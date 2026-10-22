// The service worker. It owns every secret and all state; pages and content scripts only send
// it messages. This file wires the browser's events to the Core and nothing more.

import { RelayerClientV2 } from "@loch/sdk/v2";
import { RelayerClient, ScreenerClient } from "@loch/sdk/wire";
import { scanAddressDetailed } from "@loch/scanner-core";

import { toBase64 } from "../shared/bytes.js";
import { isRecord } from "../shared/guards.js";
import { CONTENT_PORT, classifySender, parseContentMessage } from "../shared/messages.js";
import { STATE_CHANGED } from "../shared/view.js";
import { isBridgeTab, forgetBridgeTab } from "./bridge.js";
import { Core, type Env } from "./core.js";
import { bridgeTabClosed, resumeFlow } from "./flows.js";
import { chromeKV } from "./kv.js";
import { createChain } from "./network.js";
import { checkOhttp, rpcTransport } from "./ohttp.js";
import { PROVER_PORT } from "../shared/proverProtocol.js";
import { acceptProverPort, offscreenDepthProver, offscreenProver, offscreenProverV2 } from "./proverProxy.js";
import { handleContent, handleUi } from "./router.js";
import { resumeScan } from "./scan.js";

// Storage is for this extension's own pages and worker, and for nothing else. The first thing
// the worker does, before it reads or writes anything: by default chrome.storage.local can be
// read and written from the content-script world, that is, from code running inside whatever
// web page is open. The content script needs no storage at all (content/index.ts). Session
// storage is restricted by default; stating it makes sure no earlier version left it open.
const storageLocked = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: chrome.storage.AccessLevel.TRUSTED_CONTEXTS }),
  chrome.storage.session.setAccessLevel({ accessLevel: chrome.storage.AccessLevel.TRUSTED_CONTEXTS }),
]).then(
  () => true,
  () => false,
);

let notifyQueued = false;
let dialogAssets: Promise<{ css: string; fonts: { normal: string; italic: string } }> | null = null;

async function packaged(path: string): Promise<Uint8Array> {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`missing from the extension package: ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

const env: Env = {
  local: chromeKV(chrome.storage.local),
  session: chromeKV(chrome.storage.session),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  chain: (settings) => createChain(settings, { rpcTransport }),
  relayer: (settings, chain) => new RelayerClient(settings.relayerUrl, { fetch: (url, init) => chain.fetch(url, init) }),
  relayerV2: (settings, chain) => new RelayerClientV2(settings.relayerUrl, { fetch: (url, init) => chain.fetch(url, init) }),
  screener: (settings, chain) => new ScreenerClient(settings.screenerUrl, { fetch: (url, init) => chain.fetch(url, init) }),
  prover: offscreenProver,
  proverV2: offscreenProverV2,
  depthProver: offscreenDepthProver,
  tabs: {
    create: async (options) => {
      const tab = await chrome.tabs.create(options);
      if (tab.id === undefined) throw new Error("the tab has no id");
      return { id: tab.id };
    },
    remove: (tabId) => chrome.tabs.remove(tabId),
    sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
  },
  notify: () => {
    // Coalesced: many changes in one turn tell the pages once.
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      chrome.runtime.sendMessage({ loch: "worker", type: STATE_CHANGED }).catch(() => undefined);
    });
  },
  scan: (connection, address, options) => scanAddressDetailed(connection, address, options),
  checkOhttp,
  dialogAssets: () => {
    dialogAssets ??= (async () => {
      const [css, normal, italic] = await Promise.all([
        packaged("dialog.css"),
        packaged("fonts/libre-franklin-latin-wght-normal.woff2"),
        packaged("fonts/libre-franklin-latin-wght-italic.woff2"),
      ]);
      return { css: new TextDecoder().decode(css), fonts: { normal: toBase64(normal), italic: toBase64(italic) } };
    })();
    return dialogAssets;
  },
};

const core = new Core(env);

// Whatever woke the worker, first settle what the last one left unfinished.
const ready = (async () => {
  await storageLocked;
  await resumeScan(core);
  await resumeFlow(core);
})().catch(() => undefined);

// Ports. Two kinds are accepted, each only from the context the browser says is at its other end:
//
//   the prover's         from this extension's own offscreen document; the witness travels over it
//   a content script's   from the top frame of an active http(s) page; everything a page can ask
//                        of the worker arrives here and is answered here, so that none of it
//                        (the bridge answer least of all) is delivered to the extension's pages
chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (port.name === PROVER_PORT && sender && sender.tab === undefined && classifySender(sender, chrome.runtime.id) === "offscreen") {
    acceptProverPort(port);
    return;
  }
  if (port.name === CONTENT_PORT && sender && classifySender(sender, chrome.runtime.id) === "content") {
    port.onMessage.addListener((raw: unknown) => {
      if (!isRecord(raw) || typeof raw.id !== "number") return;
      const id = raw.id;
      const parsed = parseContentMessage(raw.message);
      const answer = (reply: unknown) => {
        try {
          port.postMessage({ id, reply });
        } catch {
          // The page went away before the answer was ready.
        }
      };
      // A message of the wrong shape from a web page is answered with nothing in it.
      if (!parsed) return answer(null);
      void ready.then(() => handleContent(core, sender, parsed)).then(answer, () => answer({ ok: false }));
    });
    return;
  }
  port.disconnect();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only the extension's own pages speak this way. A content script uses its port.
  if (classifySender(sender, chrome.runtime.id) !== "ui") return false;
  if (!isRecord(message) || message.loch !== "ui") return false;
  void ready.then(() => handleUi(core, message)).then(sendResponse, () => sendResponse({ ok: false, error: { code: "failed", message: "the request failed" } }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(async () => {
    if (!(await isBridgeTab(core, tabId))) return;
    await forgetBridgeTab(core);
    await bridgeTabClosed(core);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  // Nothing to migrate in v0.1. The listener exists so an update wakes the worker and resumes.
});
