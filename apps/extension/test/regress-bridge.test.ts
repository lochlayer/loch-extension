// Regression tests for finding 2 of the security review, adapted from the reviewer's
// demonstration (extsec-review/browser/attack.spec.ts, test B): with another page of the connect
// origin already open, pressing Connect sent the wallet requests to that page, and a script on
// it read the 64-byte key-derivation signature.
//
//   - the bridge is one exact URL, not an origin
//   - only a tab the extension opened for the flow that is asking; never one that was open
//   - the tab is closed afterwards
//   - changing the connect URL needs an explicit confirmation, and does not move a running flow

import { describe, expect, it } from "vitest";

import type { BridgeTab, UnlockRecord } from "../src/background/core.js";
import { cancelFlow, chooseWallet, startDive, startUnlock } from "../src/background/flows.js";
import { handleContent, handleUi } from "../src/background/router.js";
import { failureCopy, plainText } from "../src/shared/copy.js";
import type { Snapshot } from "../src/shared/view.js";
import { CONNECT, type Harness, createHarness, settle } from "./harness.js";
import { connect, fund } from "./steps.js";

const BLOG = "https://connect.test/blog.html";
const NEW_CONNECT = "https://connect2.test/";

/** Records which tab every message of the worker went to. */
function watchTabs(h: Harness): { sent: { tabId: number; type: string; kind?: string }[] } {
  const sent: { tabId: number; type: string; kind?: string }[] = [];
  const inner = h.env.tabs.sendMessage;
  h.env.tabs.sendMessage = async (tabId, message) => {
    const m = message as { type: string; request?: { kind: string } };
    sent.push({ tabId, type: m.type, ...(m.request ? { kind: m.request.kind } : {}) });
    return inner(tabId, message);
  };
  return { sent };
}

/** A page that is already open in a tab the user opened, with the extension's content script on it. */
async function alreadyOpen(h: Harness, tabId: number, url: string): Promise<void> {
  h.tabs.set(tabId, url);
  const reply = await handleContent(h.core, h.sender(tabId, url), { loch: "content", type: "config" });
  expect(reply).toMatchObject({ bridge: false });
}

const snap = async (h: Harness) => ((await handleUi(h.core, { loch: "ui", type: "state" })) as { ok: true; value: Snapshot }).value;

describe("finding 2: the bridge is one exact page, in a tab the extension opened itself", () => {
  it("another page of the connect origin that is already open is never asked: Connect opens the connect page and asks only there", async () => {
    const h = createHarness();
    await alreadyOpen(h, 7, BLOG);
    const { sent } = watchTabs(h);
    const opened: string[] = [];
    const create = h.env.tabs.create;
    h.env.tabs.create = async (options) => {
      opened.push(options.url);
      return create(options);
    };

    await connect(h);
    // Before the fix: nothing was opened, and connect and both signMessage requests went to tab 7.
    expect(opened).toEqual([CONNECT]);
    expect(sent.filter((message) => message.tabId === 7)).toEqual([]);
    const bridgeTabs = new Set(sent.filter((message) => message.type === "bridge-request").map((message) => message.tabId));
    expect(bridgeTabs.size).toBe(1);
    expect(sent.filter((message) => message.type === "bridge-request").map((message) => message.kind)).toEqual(["wallets", "connect", "signMessage", "signMessage"]);
    // The tab it opened is closed again; the user's own tab is left alone.
    expect([...h.tabs.entries()]).toEqual([[7, BLOG]]);
    expect(await h.session.get("bridge:tab")).toBeUndefined();
  });

  it("the connect page itself, in a tab the user opened, is not adopted either", async () => {
    const h = createHarness();
    await alreadyOpen(h, 8, CONNECT);
    const { sent } = watchTabs(h);
    await connect(h);
    expect(sent.filter((message) => message.tabId === 8)).toEqual([]);
    expect([...h.tabs.keys()]).toEqual([8]);
  });

  it("an answer from another page of the connect origin is not an answer", async () => {
    const h = createHarness();
    h.holdWallet = true;
    await startUnlock(h.core, null);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    await settle(h);
    const waiting = h.held[0]!;
    expect(waiting.request.kind).toBe("connect");
    const answer = h.wallet.answer(waiting.request);
    h.tabs.set(7, BLOG);
    // The same nonce, the right shape, from the wrong page, and from the right page in the wrong tab.
    expect(await handleContent(h.core, h.sender(7, BLOG), { loch: "content", type: "bridge-answer", nonce: waiting.nonce, answer })).toEqual({ ok: false });
    expect(await handleContent(h.core, h.sender(7, CONNECT), { loch: "content", type: "bridge-answer", nonce: waiting.nonce, answer })).toEqual({ ok: false });
    expect(await handleContent(h.core, h.sender(waiting.tabId, BLOG), { loch: "content", type: "bridge-answer", nonce: waiting.nonce, answer })).toEqual({ ok: false });
    expect((await h.core.flow())?.status).toBe("waiting");
    // The real one still counts.
    h.holdWallet = false;
    await h.releaseWallet();
    await settle(h, (flow) => flow.step !== "connecting");
    expect((await h.core.flow())?.step).toMatch(/signing/);
  });

  it("the tab the extension opened lands somewhere else (a redirect): no bridge, and the tab is closed", async () => {
    const h = createHarness();
    h.env.tabs.create = async () => {
      h.tabs.set(55, BLOG);
      setImmediate(() => void handleContent(h.core, h.sender(55, BLOG), { loch: "content", type: "config" }));
      return { id: 55 };
    };
    await startUnlock(h.core, null);
    const flow = await settle(h);
    expect(flow.failure).toMatchObject({ code: "connect-page", retry: true, detail: CONNECT });
    expect(h.tabs.has(55)).toBe(false);
    expect(await h.session.get("bridge:tab")).toBeUndefined();
  });

  it("a tab left over from an earlier flow is not reused by the next one", async () => {
    const h = createHarness();
    await connect(h);
    await h.session.set("bridge:tab", { tabId: 31, url: CONNECT, flowId: "an-earlier-flow", ready: true } satisfies BridgeTab);
    h.tabs.set(31, CONNECT);
    fund(h, 10_000_000_000n);
    const { sent } = watchTabs(h);
    await startDive(h.core, 1_000_000_000n);
    expect((await settle(h)).status).toBe("done");
    expect(h.tabs.has(31)).toBe(false);
    expect(sent.filter((message) => message.type === "bridge-request").every((message) => message.tabId !== 31)).toBe(true);
  });

  it("the unlock sheet is told where the wallet is asked", async () => {
    const h = createHarness();
    await startUnlock(h.core, null);
    await settle(h);
    expect((await snap(h)).flow).toMatchObject({ kind: "unlock", connectUrl: CONNECT });
  });
});

describe("finding 2: the connect page setting", () => {
  it("is not changed without an explicit confirmation that names the new address", async () => {
    const h = createHarness();
    const change = (patch: Record<string, unknown>) => handleUi(h.core, { loch: "ui", type: "settings", patch });
    // As any save of the endpoints form would send it, before the fix: accepted silently.
    expect(await change({ connectUrl: NEW_CONNECT })).toMatchObject({ ok: false, error: { message: "connectUrl:confirm" } });
    expect(await change({ connectUrl: NEW_CONNECT, confirmConnectUrl: true })).toMatchObject({ ok: false, error: { message: "connectUrl:confirm" } });
    expect(await change({ connectUrl: NEW_CONNECT, confirmConnectUrl: "https://evil.example/" })).toMatchObject({ ok: false, error: { message: "connectUrl:confirm" } });
    expect((await h.core.settings()).connectUrl).toBe(CONNECT);
    // Saving the form with the connect page unchanged needs no confirmation.
    expect(await change({ connectUrl: CONNECT, rpcUrl: "https://rpc.test" })).toMatchObject({ ok: true });
    // An address with a query, or anything that is not one exact page, is refused outright.
    expect(await change({ connectUrl: `${NEW_CONNECT}?a=1`, confirmConnectUrl: `${NEW_CONNECT}?a=1` })).toMatchObject({ ok: false, error: { message: "connectUrl:query" } });
    expect(await change({ connectUrl: "http://connect2.test/", confirmConnectUrl: "http://connect2.test/" })).toMatchObject({ ok: false, error: { message: "connectUrl:insecure" } });

    expect(await change({ connectUrl: "https://connect2.test", confirmConnectUrl: "https://connect2.test" })).toMatchObject({ ok: true });
    expect((await h.core.settings()).connectUrl).toBe(NEW_CONNECT);
  });

  it("a change does not take effect for a flow that is already running", async () => {
    const h = createHarness();
    h.holdWallet = true;
    const opened: string[] = [];
    const create = h.env.tabs.create;
    h.env.tabs.create = async (options) => {
      opened.push(options.url);
      return create(options);
    };
    await startUnlock(h.core, null);
    await settle(h);
    await chooseWallet(h.core, "Phantom");
    await settle(h);
    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { connectUrl: NEW_CONNECT, confirmConnectUrl: NEW_CONNECT } })).toMatchObject({ ok: true });

    // The running flow goes on where it started, and finishes there.
    expect(((await h.core.flow()) as UnlockRecord).connectUrl).toBe(CONNECT);
    h.holdWallet = false;
    await h.releaseWallet();
    const done = await settle(h);
    expect(done.status).toBe("done");
    expect(opened).toEqual([CONNECT]);
    await h.core.clearFlow();

    // The next one uses the new address.
    await handleUi(h.core, { loch: "ui", type: "lock" });
    await startUnlock(h.core, h.wallet.address);
    await settle(h);
    expect(opened.at(-1)).toBe(NEW_CONNECT);
    await cancelFlow(h.core);
  });

  it("a failure to open it names the page the flow used", async () => {
    const copy = failureCopy({ code: "connect-page", moved: "no", retry: true }, { kind: "unlock", connectUrl: CONNECT });
    expect(copy.lines.map(plainText).join(" ")).toContain(CONNECT);
  });
});
