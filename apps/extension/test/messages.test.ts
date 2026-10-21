import { describe, expect, it } from "vitest";

import { acceptBridgeAnswer, noteContentScript } from "../src/background/bridge.js";
import { BRIDGE_TTL_MS, type BridgeTab, type PendingBridge } from "../src/background/core.js";
import { handleContent, handleUi, parseUiRequest } from "../src/background/router.js";
import { checkConnectUrl, isConnectPage } from "../src/background/settings.js";
import {
  classifySender,
  parseBridgeAnswer,
  parseBridgeRequest,
  parseContentMessage,
  parseToContent,
  parseToContentScript,
  parseToPage,
  senderOrigin,
} from "../src/shared/messages.js";
import { CONNECT, EXTENSION_ID, createHarness } from "./harness.js";

const ID = EXTENSION_ID;
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
const ADDRESS = "Fh3qJ5iBgbd2x9vVqk1mF7yq8a3xgWzJYQeU1cTz8KTz";
const SIG_B64 = Buffer.alloc(64, 1).toString("base64");
const KEY_B64 = Buffer.alloc(32, 2).toString("base64");

describe("who sent a message", () => {
  const page = { id: ID, url: "https://example.org/app", origin: "https://example.org", frameId: 0, tab: { id: 7 } };

  it("recognises the extension's own pages by what the browser reports", () => {
    expect(classifySender({ id: ID, url: `chrome-extension://${ID}/app.html?view=popup`, origin: `chrome-extension://${ID}` }, ID)).toBe("ui");
    expect(classifySender({ id: ID, url: `chrome-extension://${ID}/app.html`, origin: `chrome-extension://${ID}`, tab: { id: 3 }, frameId: 0 }, ID)).toBe("ui");
    expect(classifySender({ id: ID, url: `chrome-extension://${ID}/offscreen.html` }, ID)).toBe("offscreen");
  });

  it("treats a content script as a content script, whatever its message says", () => {
    expect(classifySender(page, ID)).toBe("content");
  });

  it("rejects another extension, another origin, a frame, a page without a tab", () => {
    expect(classifySender({ ...page, id: "otherotherotherotherotherotherot" }, ID)).toBeNull();
    expect(classifySender({ id: ID, url: `chrome-extension://otherotherotherotherotherotherot/app.html` }, ID)).toBeNull();
    expect(classifySender({ id: ID, url: `chrome-extension://${ID}/app.html`, origin: "https://evil.example" }, ID)).toBeNull();
    expect(classifySender({ id: ID, url: `chrome-extension://${ID}/other.html` }, ID)).toBeNull();
    expect(classifySender({ ...page, frameId: 3 }, ID)).toBeNull();
    expect(classifySender({ ...page, tab: undefined }, ID)).toBeNull();
    expect(classifySender({ ...page, url: "file:///etc/passwd" }, ID)).toBeNull();
    expect(classifySender({ ...page, documentLifecycle: "prerender" }, ID)).toBeNull();
    expect(classifySender({}, ID)).toBeNull();
  });

  it("a page cannot pass for the interface by naming an extension URL in its path", () => {
    expect(classifySender({ ...page, url: `https://example.org/chrome-extension://${ID}/app.html` }, ID)).toBe("content");
  });

  it("reads the origin from the browser's report", () => {
    expect(senderOrigin(page)).toBe("https://example.org");
    expect(senderOrigin({ url: "http://127.0.0.1:5174/connect.html" })).toBe("http://127.0.0.1:5174");
    expect(senderOrigin({ url: "chrome://newtab" })).toBeNull();
    expect(senderOrigin({})).toBeNull();
  });

  it("the connect page is one exact address: same origin, same path, nothing after it", () => {
    const connect = "https://connect.test/connect.html";
    expect(isConnectPage(connect, connect)).toBe(true);
    // Any other page of the same origin is not the connect page.
    for (const other of [
      "https://connect.test/",
      "https://connect.test/blog.html",
      "https://connect.test/connect.html/",
      "https://connect.test/connect.html?x=1",
      "https://connect.test/connect.html#top",
      "https://connect.test/connect.html?",
      "https://connect.test/Connect.html",
      "https://connect.test/a/../connect.htm",
      "http://connect.test/connect.html",
      "https://connect.test:8443/connect.html",
      "https://evil.example/connect.html",
      "https://connect.test.evil.example/connect.html",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/connect.html",
      "not a url",
      "",
    ]) {
      expect(isConnectPage(other, connect), other).toBe(false);
    }
    expect(isConnectPage(undefined, connect)).toBe(false);
    // What the browser normalises is the same address: a path written with dot segments, a default port.
    expect(isConnectPage("https://connect.test:443/x/../connect.html", connect)).toBe(true);
    // A setting that is itself not an exact address matches nothing.
    expect(isConnectPage("https://connect.test/connect.html?x=1", "https://connect.test/connect.html?x=1")).toBe(false);
  });

  it("the connect page setting takes an exact address and nothing else", () => {
    expect(checkConnectUrl("https://connect.loch.example/")).toEqual({ ok: true, url: "https://connect.loch.example/", origin: "https://connect.loch.example" });
    expect(checkConnectUrl("https://connect.loch.example")).toMatchObject({ ok: true, url: "https://connect.loch.example/" });
    expect(checkConnectUrl(" http://127.0.0.1:5174/connect.html ")).toMatchObject({ ok: true, url: "http://127.0.0.1:5174/connect.html" });
    expect(checkConnectUrl("https://x.example/c?next=1")).toEqual({ ok: false, problem: "query" });
    expect(checkConnectUrl("https://x.example/c#f")).toEqual({ ok: false, problem: "fragment" });
    expect(checkConnectUrl("http://x.example/c")).toEqual({ ok: false, problem: "insecure" });
    expect(checkConnectUrl("https://user:pw@x.example/c")).toEqual({ ok: false, problem: "credentials" });
    expect(checkConnectUrl("javascript:alert(1)")).toEqual({ ok: false, problem: "scheme" });
  });
});

describe("message shapes", () => {
  it("accepts exactly the bridge requests there are", () => {
    expect(parseBridgeRequest({ kind: "wallets" })).toEqual({ kind: "wallets" });
    expect(parseBridgeRequest({ kind: "connect", wallet: "Phantom", silent: false })).not.toBeNull();
    expect(parseBridgeRequest({ kind: "signMessage", wallet: "Phantom", address: ADDRESS, message: "TG9jaA==" })).not.toBeNull();
    expect(parseBridgeRequest({ kind: "signTransaction", wallet: "Phantom", address: ADDRESS, transaction: "AAAA", chain: "solana:devnet" })).not.toBeNull();
  });

  it("rejects malformed bridge requests", () => {
    const bad: unknown[] = [
      null,
      "wallets",
      { kind: "wallets", extra: 1 },
      { kind: "connect", wallet: "", silent: false },
      { kind: "connect", wallet: "Phantom", silent: "no" },
      { kind: "connect", wallet: "Phan\u0000tom", silent: false },
      { kind: "connect", wallet: "x".repeat(65), silent: false },
      { kind: "signMessage", wallet: "Phantom", address: "not base58 !!", message: "TG9jaA==" },
      { kind: "signMessage", wallet: "Phantom", address: ADDRESS, message: "not-base64" },
      { kind: "signTransaction", wallet: "Phantom", address: ADDRESS, transaction: "", chain: "solana:devnet" },
      { kind: "signTransaction", wallet: "Phantom", address: ADDRESS, transaction: "AAAA", chain: "ethereum:1" },
      { kind: "signTransaction", wallet: "Phantom", address: ADDRESS, transaction: "A".repeat(5468), chain: "solana:devnet" },
      { kind: "exportSeed" },
    ];
    for (const value of bad) expect(parseBridgeRequest(value), JSON.stringify(value)).toBeNull();
  });

  it("reads an answer only in the shape its request is answered with", () => {
    const signed = { ok: true, value: { kind: "signMessage", signature: SIG_B64 } };
    expect(parseBridgeAnswer(signed, "signMessage")).toEqual(signed);
    expect(parseBridgeAnswer(signed, "connect")).toBeNull();
    expect(parseBridgeAnswer(signed, "signTransaction")).toBeNull();
    expect(parseBridgeAnswer({ ok: true, value: { kind: "connect", accounts: [{ address: ADDRESS, publicKey: KEY_B64 }] } }, "connect")).not.toBeNull();
    expect(parseBridgeAnswer({ ok: false, error: { code: "rejected", message: "User rejected the request." } }, "connect")).toEqual({
      ok: false,
      error: { code: "rejected", message: "User rejected the request." },
    });
  });

  it("rejects malformed answers", () => {
    const bad: [unknown, Parameters<typeof parseBridgeAnswer>[1]][] = [
      [{ ok: true, value: { kind: "signMessage", signature: SIG_B64.slice(4) } }, "signMessage"],
      [{ ok: true, value: { kind: "signMessage", signature: SIG_B64, secret: "x" } }, "signMessage"],
      [{ ok: true, value: { kind: "signMessage", signature: SIG_B64 }, also: 1 }, "signMessage"],
      [{ ok: true, value: { kind: "connect", accounts: [{ address: ADDRESS, publicKey: "AAAA" }] } }, "connect"],
      [{ ok: true, value: { kind: "connect", accounts: [{ address: "x", publicKey: KEY_B64 }] } }, "connect"],
      [{ ok: true, value: { kind: "connect", accounts: Array.from({ length: 17 }, () => ({ address: ADDRESS, publicKey: KEY_B64 })) } }, "connect"],
      [{ ok: true, value: { kind: "wallets", wallets: [{ name: "Phantom", features: "all", chains: [] }] } }, "wallets"],
      [{ ok: true, value: { kind: "wallets", wallets: [{ name: "Phantom", features: [], chains: [], icon: "data:..." }] } }, "wallets"],
      [{ ok: true, value: { kind: "signTransaction", signedTransaction: "" } }, "signTransaction"],
      [{ ok: false, error: { code: "pwned", message: "x" } }, "connect"],
      [{ ok: false, error: { code: "failed" } }, "connect"],
      [{ ok: "yes" }, "connect"],
      [null, "connect"],
    ];
    for (const [value, kind] of bad) expect(parseBridgeAnswer(value, kind), JSON.stringify(value)).toBeNull();
  });

  it("cuts what a wallet says to 200 characters", () => {
    const answer = parseBridgeAnswer({ ok: false, error: { code: "failed", message: "x".repeat(400) } }, "connect");
    expect(answer && !answer.ok && answer.error.message.length).toBe(200);
  });

  it("page script and content script messages: exact shapes", () => {
    const config = { type: "config", wallet: "Phantom" };
    expect(parseToPage(config)).toEqual(config);
    expect(parseToPage({ ...config, secret: "x" })).toBeNull();
    expect(parseToPage({ type: "config", wallet: null })).toBeNull();
    expect(parseToPage({ type: "config", wallet: "" })).toBeNull();
    expect(parseToPage({ type: "verdict", nonce: NONCE, allow: true })).not.toBeNull();
    expect(parseToPage({ type: "verdict", nonce: "short", allow: true })).toBeNull();
    expect(parseToPage({ type: "verdict", nonce: NONCE, allow: "yes" })).toBeNull();
    expect(parseToPage({ type: "ack", nonce: NONCE })).not.toBeNull();
    expect(parseToPage({ type: "request", nonce: NONCE, request: { kind: "wallets" } })).not.toBeNull();
    expect(parseToPage({ type: "request", nonce: NONCE, request: { kind: "dump" } })).toBeNull();

    expect(parseToContent({ type: "answer", nonce: NONCE, answer: { anything: 1 } })).not.toBeNull();
    expect(parseToContent({ type: "answer", nonce: "x", answer: {} })).toBeNull();
    expect(parseToContent({ type: "guard-message", nonce: NONCE })).not.toBeNull();
    expect(parseToContent({ type: "guard-transactions", nonce: NONCE, account: ADDRESS, transactions: ["AAAA"] })).not.toBeNull();
    expect(parseToContent({ type: "guard-transactions", nonce: NONCE, account: ADDRESS, transactions: [] })).toBeNull();
    expect(parseToContent({ type: "guard-transactions", nonce: NONCE, account: ADDRESS, transactions: Array(9).fill("AAAA") })).toBeNull();
    expect(parseToContent({ type: "accounts", accounts: [ADDRESS, ADDRESS] })).toEqual({ type: "accounts", accounts: [ADDRESS] });
    expect(parseToContent({ type: "accounts", accounts: [] })).toBeNull();
    expect(parseToContent({ type: "accounts", accounts: ["not an address"] })).toBeNull();
    expect(parseToContent({ type: "accounts", accounts: Array(17).fill(ADDRESS) })).toBeNull();
    expect(parseToContent({ type: "state" })).toBeNull();
    // Nothing announces the page script any more: there is no "ready".
    expect(parseToContent({ type: "ready" })).toBeNull();
  });

  it("a content script can send five things and nothing else", () => {
    expect(parseContentMessage({ loch: "content", type: "config" })).not.toBeNull();
    expect(parseContentMessage({ loch: "content", type: "dialog-assets" })).not.toBeNull();
    expect(parseContentMessage({ loch: "content", type: "bridge-answer", nonce: NONCE, answer: {} })).not.toBeNull();
    expect(parseContentMessage({ loch: "content", type: "review", account: ADDRESS, transactions: ["AAAA"] })).not.toBeNull();
    expect(parseContentMessage({ loch: "content", type: "accounts", accounts: [ADDRESS] })).not.toBeNull();
    for (const value of [
      { loch: "ui", type: "state" },
      { loch: "content", type: "state" },
      { loch: "content", type: "unlock", address: ADDRESS },
      { loch: "content", type: "config", extra: true },
      { loch: "content", type: "bridge-answer", nonce: "bad", answer: {} },
      { loch: "content", type: "review", account: "x", transactions: ["AAAA"] },
      { loch: "content", type: "review", account: ADDRESS, transactions: ["***"] },
      { loch: "content", type: "accounts", accounts: ["x"] },
      { loch: "content", type: "accounts", accounts: [ADDRESS], origin: "https://other.example" },
      { loch: "content", type: "public-balance" },
      { target: "loch-offscreen", type: "prove", input: {} },
    ]) {
      expect(parseContentMessage(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("worker to content script", () => {
    expect(parseToContentScript({ loch: "worker", type: "bridge-request", nonce: NONCE, url: CONNECT, request: { kind: "wallets" } })).not.toBeNull();
    expect(parseToContentScript({ loch: "worker", type: "bridge-request", nonce: NONCE, request: { kind: "wallets" } })).toBeNull();
    expect(parseToContentScript({ loch: "worker", type: "bridge-request", nonce: NONCE, url: CONNECT, request: { kind: "dump" } })).toBeNull();
    expect(parseToContentScript({ loch: "worker", type: "status", text: "x".repeat(301) })).toBeNull();
  });

  it("interface requests are checked field by field", () => {
    expect(parseUiRequest({ loch: "ui", type: "state" })).toEqual({ loch: "ui", type: "state" });
    expect(parseUiRequest({ loch: "ui", type: "dive", amount: "1000" })).not.toBeNull();
    expect(parseUiRequest({ loch: "ui", type: "flow-retry" })).toEqual({ loch: "ui", type: "flow-retry" });
    expect(parseUiRequest({ loch: "ui", type: "flow-retry", fee: "3000000" })).toEqual({ loch: "ui", type: "flow-retry", fee: "3000000" });
    expect(parseUiRequest({ loch: "ui", type: "public-balance" })).toEqual({ loch: "ui", type: "public-balance" });
    for (const value of [
      { loch: "ui", type: "dive", amount: "1.5" },
      { loch: "ui", type: "dive", amount: -1 },
      { loch: "ui", type: "send", to: "loch1x", amount: "1" },
      { loch: "ui", type: "surface", to: "nope", amount: "1", fee: "1" },
      { loch: "ui", type: "unlock", address: "nope" },
      { loch: "ui", type: "settings", patch: "x" },
      { loch: "ui", type: "flow-retry", fee: "1.5" },
      { loch: "ui", type: "flow-retry", fee: -1 },
      { loch: "ui", type: "export-keys" },
      { loch: "content", type: "state" },
    ]) {
      expect(parseUiRequest(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("answers from the bridge", () => {
  async function waiting() {
    const h = createHarness();
    const tab: BridgeTab = { tabId: 41, url: CONNECT, flowId: "f", ready: true };
    h.tabs.set(41, CONNECT);
    await h.session.set("bridge:tab", tab);
    const pending: PendingBridge = { nonce: NONCE, flowId: "f", tabId: 41, url: CONNECT, request: { kind: "connect", wallet: "Phantom", silent: false }, createdAt: h.clock.now };
    await h.session.set("bridge:pending", pending);
    const answer = { ok: true, value: { kind: "connect", accounts: [{ address: h.wallet.address, publicKey: Buffer.from(h.wallet.keypair.publicKey.toBytes()).toString("base64") }] } };
    return { h, answer };
  }

  it("accepts the answer to the waiting request, from its tab and origin, once", async () => {
    const { h, answer } = await waiting();
    const accepted = await acceptBridgeAnswer(h.core, h.sender(41), NONCE, answer);
    expect(accepted?.answer.ok).toBe(true);
    // The nonce is used up: the same answer again is ignored.
    expect(await acceptBridgeAnswer(h.core, h.sender(41), NONCE, answer)).toBeNull();
  });

  it("ignores a wrong nonce and keeps waiting", async () => {
    const { h, answer } = await waiting();
    expect(await acceptBridgeAnswer(h.core, h.sender(41), "BBBBBBBBBBBBBBBBBBBBBB", answer)).toBeNull();
    expect(await acceptBridgeAnswer(h.core, h.sender(41), NONCE, answer)).not.toBeNull();
  });

  it("ignores the right nonce from another origin, another page of the connect origin, another tab or a frame", async () => {
    const { h, answer } = await waiting();
    expect(await acceptBridgeAnswer(h.core, h.sender(41, "https://evil.example/connect.html"), NONCE, answer)).toBeNull();
    // The tab the request went to has since gone to another page of the same origin.
    expect(await acceptBridgeAnswer(h.core, h.sender(41, "https://connect.test/blog.html"), NONCE, answer)).toBeNull();
    expect(await acceptBridgeAnswer(h.core, h.sender(41, `${CONNECT}?x=1`), NONCE, answer)).toBeNull();
    expect(await acceptBridgeAnswer(h.core, h.sender(41, `${CONNECT}#x`), NONCE, answer)).toBeNull();
    expect(await acceptBridgeAnswer(h.core, h.sender(42, CONNECT), NONCE, answer)).toBeNull();
    expect(await acceptBridgeAnswer(h.core, { ...h.sender(41), frameId: 2 }, NONCE, answer)).toBeNull();
    // None of those consumed the request.
    expect(await acceptBridgeAnswer(h.core, h.sender(41), NONCE, answer)).not.toBeNull();
  });

  it("turns an answer of the wrong shape into a failure instead of trusting it", async () => {
    const { h } = await waiting();
    const accepted = await acceptBridgeAnswer(h.core, h.sender(41), NONCE, { ok: true, value: { kind: "signMessage", signature: SIG_B64 } });
    expect(accepted?.answer).toMatchObject({ ok: false, error: { code: "failed" } });
  });

  it("drops an answer that comes too late", async () => {
    const { h, answer } = await waiting();
    h.clock.now += BRIDGE_TTL_MS + 1;
    expect(await acceptBridgeAnswer(h.core, h.sender(41), NONCE, answer)).toBeNull();
  });

  it("only the tab the extension opened, at exactly the connect address, hosts the bridge", async () => {
    const h = createHarness();
    const config = (tabId: number, url: string) => handleContent(h.core, h.sender(tabId, url), { loch: "content", type: "config" });
    // No flow is asking: nothing is a bridge, the connect page included. It is never adopted.
    h.tabs.set(6, CONNECT);
    expect(await noteContentScript(h.core, h.sender(6, CONNECT))).toBe(false);
    expect(await config(6, CONNECT)).toMatchObject({ bridge: false });
    expect(await h.session.get("bridge:tab")).toBeUndefined();

    // The extension opened tab 41 for a flow.
    await h.session.set("bridge:tab", { tabId: 41, url: CONNECT, flowId: "f", ready: false } satisfies BridgeTab);
    h.tabs.set(41, CONNECT);
    h.tabs.set(5, "https://evil.example/");
    h.tabs.set(7, "https://connect.test/blog.html");
    expect(await config(5, "https://evil.example/")).toMatchObject({ bridge: false });
    // Another page of the connect origin, and the connect page itself in a tab the user opened.
    expect(await config(7, "https://connect.test/blog.html")).toMatchObject({ bridge: false });
    expect(await config(6, CONNECT)).toMatchObject({ bridge: false });
    expect(await h.session.get<BridgeTab>("bridge:tab")).toMatchObject({ tabId: 41, ready: false });
    // Its own tab, at the exact address.
    expect(await config(41, CONNECT)).toMatchObject({ bridge: true });
    expect(await h.session.get<BridgeTab>("bridge:tab")).toMatchObject({ tabId: 41, ready: true });
    // A frame inside it is not the page.
    expect(await noteContentScript(h.core, { ...h.sender(41, CONNECT), frameId: 3 })).toBe(false);
    // The tab goes to another page of the same origin: it stops being a bridge and is closed.
    expect(await config(41, "https://connect.test/blog.html")).toMatchObject({ bridge: false });
    expect(await h.session.get("bridge:tab")).toBeUndefined();
    expect(h.tabs.has(41)).toBe(false);
  });

  it("the interface gets an error, not an exception, for a request it cannot make", async () => {
    const h = createHarness();
    expect(await handleUi(h.core, { loch: "ui", type: "nonsense" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await handleUi(h.core, { loch: "ui", type: "dive", amount: "1000000000" })).toMatchObject({ ok: false });
  });
});
