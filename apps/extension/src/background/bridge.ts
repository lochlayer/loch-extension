// The wallet bridge, service worker side.
//
// The user's wallet can only be reached from a web page. The extension therefore asks a page to
// do it: the connect page, and nothing else. A page hosts the wallet objects in its own
// JavaScript world and can read everything that passes through them, including the
// key-derivation signature, so three things must all hold before a page is asked or believed:
//
//   - its address is exactly the connect URL: same origin, same path, no query, no fragment.
//     Another page of the same origin (a blog, a landing page) is not the connect page;
//   - it is in a tab this extension opened itself, for the flow that is asking. A tab that was
//     already open is never adopted, whatever its address;
//   - the browser, not the page, says so (the sender of the message).
//
// The connect URL a flow uses is fixed when the flow starts (FlowRecord.connectUrl), so changing
// the setting cannot redirect a flow that is already running.
//
// A request goes: service worker -> content script (chrome.tabs.sendMessage) -> page script
// (a private port) -> wallet, and the answer comes back the same way. Each request carries a
// nonce made here. An answer is accepted once, for the nonce that is waiting, from the tab and
// the address the request was sent to, in the shape that kind of request is answered with.

import { randomToken } from "../shared/bytes.js";
import { isRecord } from "../shared/guards.js";
import { type BridgeAnswer, type BridgeRequest, type SenderLike, parseBridgeAnswer } from "../shared/messages.js";
import { BRIDGE_TTL_MS, type BridgeTab, type Core, type DiveRecord, type FlowRecord, type PendingBridge, type SpendRecord, type UnlockRecord, fail } from "./core.js";
import { isConnectPage } from "./settings.js";

const TAB_KEY = "bridge:tab";
const PENDING_KEY = "bridge:pending";
/** How long the connect page gets to load and announce itself. */
const OPEN_TIMEOUT_MS = 15_000;

/** A flow that reaches the wallet: a move is signed by it too. */
type BridgeFlow = UnlockRecord | DiveRecord | (SpendRecord & { move: true; connectUrl: string });

function usesBridge(flow: FlowRecord): flow is BridgeFlow {
  return flow.kind === "unlock" || flow.kind === "dive" || (flow.kind === "surface" && flow.move === true && flow.connectUrl !== undefined);
}

/** Asks the tab's content script where it is. True only when it answers from exactly the tab's address. */
async function tabAnswers(core: Core, tab: BridgeTab): Promise<boolean> {
  try {
    const reply = await core.env.tabs.sendMessage(tab.tabId, { loch: "worker", type: "status", text: "" });
    return isRecord(reply) && reply.ok === true && isConnectPage(reply.url, tab.url);
  } catch {
    return false;
  }
}

async function dropTab(core: Core, tab: BridgeTab | undefined): Promise<void> {
  await core.env.session.remove([TAB_KEY, PENDING_KEY]);
  if (tab) await core.env.tabs.remove(tab.tabId).catch(() => undefined);
}

/**
 * Opens the connect page for `flow` and returns once its content script is there. The tab this
 * flow already opened is used again; no other tab ever is. It is opened in the background, so
 * that a popup the user is looking at stays open.
 */
export async function ensureBridgeTab(core: Core, flow: FlowRecord): Promise<BridgeTab> {
  if (!usesBridge(flow)) throw fail("internal");
  const url = flow.connectUrl;
  const known = await core.env.session.get<BridgeTab>(TAB_KEY);
  if (known && known.flowId === flow.id && known.url === url && (await tabAnswers(core, known))) {
    if (!known.ready) await core.env.session.set(TAB_KEY, { ...known, ready: true } satisfies BridgeTab);
    return { ...known, ready: true };
  }
  // A tab left from another flow, or one that went elsewhere: close it. It is never reused.
  if (known) await dropTab(core, known);

  let created: { id: number };
  try {
    created = await core.env.tabs.create({ url, active: false });
  } catch {
    throw fail("connect-page", { retry: true, detail: url });
  }
  const tab: BridgeTab = { tabId: created.id, url, flowId: flow.id, ready: false };
  await core.env.session.set(TAB_KEY, tab);
  const deadline = core.env.now() + OPEN_TIMEOUT_MS;
  while (core.env.now() < deadline) {
    const current = await core.env.session.get<BridgeTab>(TAB_KEY);
    // Closed, or replaced, while it was loading.
    if (!current || current.tabId !== tab.tabId) break;
    if (current.ready) return current;
    // Its content script may have announced itself before the record above was written.
    if (await tabAnswers(core, tab)) {
      const ready: BridgeTab = { ...tab, ready: true };
      await core.env.session.set(TAB_KEY, ready);
      return ready;
    }
    await core.env.sleep(150);
  }
  await dropTab(core, tab);
  throw fail("connect-page", { retry: true, detail: url });
}

/**
 * A content script announced itself. Returns whether it is the bridge: the tab the extension
 * opened, showing exactly the connect URL it was opened at. Any other page gets false, the
 * connect origin's other pages included, and so does the connect page in a tab the user opened.
 */
export async function noteContentScript(core: Core, sender: SenderLike): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0) return false;
  const known = await core.env.session.get<BridgeTab>(TAB_KEY);
  if (!known || known.tabId !== tabId) return false;
  if (isConnectPage(sender.url, known.url)) {
    if (!known.ready) await core.env.session.set(TAB_KEY, { ...known, ready: true } satisfies BridgeTab);
    return true;
  }
  // The tab the extension opened went somewhere else (a redirect, a link). It is no bridge any
  // more, and it is the extension's to close.
  await dropTab(core, known);
  return false;
}

/** Closes the connect tab. It is always one the extension opened. */
export async function closeBridgeTab(core: Core): Promise<void> {
  await dropTab(core, await core.env.session.get<BridgeTab>(TAB_KEY));
}

/** Sends one request toward the wallet. The flow then waits; the answer arrives as an event. */
export async function sendBridgeRequest(core: Core, flow: FlowRecord, request: BridgeRequest): Promise<void> {
  const tab = await ensureBridgeTab(core, flow);
  const pending: PendingBridge = { nonce: randomToken(), flowId: flow.id, tabId: tab.tabId, url: tab.url, request, createdAt: core.env.now() };
  await core.env.session.set(PENDING_KEY, pending);
  let reply: unknown;
  try {
    reply = await core.env.tabs.sendMessage(tab.tabId, { loch: "worker", type: "bridge-request", nonce: pending.nonce, url: tab.url, request });
  } catch {
    reply = null;
  }
  if (!isRecord(reply) || reply.accepted !== true) {
    await core.env.session.remove(PENDING_KEY);
    throw fail("connect-page", { retry: true });
  }
}

export async function pendingBridge(core: Core): Promise<PendingBridge | null> {
  return (await core.env.session.get<PendingBridge>(PENDING_KEY)) ?? null;
}

export type AcceptedAnswer = { pending: PendingBridge; answer: BridgeAnswer };

/**
 * Checks an answer that claims to come from the bridge. Returns it only if a request with that
 * nonce is waiting, the browser says the message came from the top frame of the tab the request
 * was sent to, that tab still shows exactly the connect URL, and it is not too old. The nonce is
 * used up either way once the sender is right, so an answer cannot be replayed.
 */
export async function acceptBridgeAnswer(core: Core, sender: SenderLike, nonce: string, answer: unknown): Promise<AcceptedAnswer | null> {
  const pending = await pendingBridge(core);
  if (!pending || pending.nonce !== nonce) return null;
  if (sender.tab?.id !== pending.tabId || sender.frameId !== 0 || !isConnectPage(sender.url, pending.url)) return null;
  await core.env.session.remove(PENDING_KEY);
  if (core.env.now() - pending.createdAt > BRIDGE_TTL_MS) return null;
  const parsed = parseBridgeAnswer(answer, pending.request.kind);
  // An answer of the wrong shape is a failed request, not something to ignore: the flow must not hang.
  return { pending, answer: parsed ?? { ok: false, error: { code: "failed", message: "the page returned an answer Loch could not read" } } };
}

export async function isBridgeTab(core: Core, tabId: number): Promise<boolean> {
  const known = await core.env.session.get<BridgeTab>(TAB_KEY);
  return known !== undefined && known.tabId === tabId;
}

export async function forgetBridgeTab(core: Core): Promise<void> {
  await core.env.session.remove([TAB_KEY, PENDING_KEY]);
}
