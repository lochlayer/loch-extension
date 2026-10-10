// Regression tests for the security review, in the browser: the built extension in Chromium,
// hostile pages, real proofs. Adapted from the reviewer's demonstrations
// (extsec-review/browser/attack.spec.ts). Each test below reproduced a finding before the fix.
//
//   finding 2    another page of the connect origin is never asked; no page script sees the signature
//   finding 3    a page cannot test whether an address is this browser's Loch wallet
//   finding 5    what the guard and the warning hold against, and (named as such) what they cannot
//   finding 7    a page cannot tell that Loch is installed while the wrapper has nothing to offer it
//   finding 8    the content-script world has no access to chrome.storage.local
//   finding 10   the witness reaches the prover and no other extension page
//
// Everything listens on 127.0.0.1 with ports the system picks and is closed at the end.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ed25519 } from "@noble/curves/ed25519";
import { deriveKeys, keyDerivationMessage } from "@loch/sdk";
import { type BrowserContext, type Page, expect as playwrightExpect } from "@playwright/test";
import { Keypair } from "@solana/web3.js";
import { build } from "esbuild";
import { afterAll, beforeAll, test } from "vitest";

import { SHOTS_DIR, type World, createWorld, openPopup } from "./env.js";

const expect = playwrightExpect.configure({ timeout: 30_000 });
const here = fileURLToPath(new URL(".", import.meta.url));

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const originOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ------------------------------------------------------------------ an ordinary, hostile site
//
// Its script runs as the page's own. Nothing is clicked on it and no wallet is connected to it.
const EVIL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>an ordinary site</title>
<script>
// The very first script of the page. Everything it can observe of an extension is collected here.
window.__fp = { messages: [], events: [], registerCalls: 0, appReady: 0, globals: [] };
window.addEventListener("message", (e) => { try { window.__fp.messages.push(JSON.parse(JSON.stringify(e.data))); } catch { window.__fp.messages.push("unclonable"); } });
for (const name of ["loch:port:1", "loch:hello:1", "loch:taken:1"]) window.addEventListener(name, () => window.__fp.events.push(name));
window.addEventListener("wallet-standard:app-ready", () => window.__fp.appReady++);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode32(text) {
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(B58.indexOf(ch));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}
window.__transferTx = function (from58) {
  // legacy transaction: 1 signature slot, keys [from, to, system program], one System.Transfer of 1 lamport
  const from = b58decode32(from58);
  const to = crypto.getRandomValues(new Uint8Array(32));
  return new Uint8Array([1, ...new Uint8Array(64), 1, 0, 1, 3, ...from, ...to, ...new Uint8Array(32), ...new Uint8Array(32), 1, 2, 2, 0, 1, 12, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
};
function nonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}
// Everything a page can try in order to get a reaction out of the extension's scripts.
window.__poke = async function () {
  const out = { offerNotCancelled: true, heard: [], dialogs: 0 };
  const observer = new MutationObserver(() => { out.dialogs += document.querySelectorAll("loch-dialog").length; });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // 1. The window-message protocol the extension used to speak, in both directions.
  const id = nonce();
  for (const data of [
    { channel: "loch:bridge:1", to: "content", type: "ready" },
    { channel: "loch:bridge:1", to: "content", type: "guard-message", nonce: id },
    { channel: "loch:bridge:1", to: "page", type: "config", enabled: true, wallet: "Test Wallet", bridge: false },
    { channel: "loch:bridge:1", to: "page", type: "config", enabled: true, wallet: "Phantom", bridge: true },
    { type: "guard-message", nonce: id },
    { type: "config", wallet: "Test Wallet" },
  ]) window.postMessage(data, location.origin);
  // 2. The handshake of the private channel: say hello, and offer a port of our own.
  window.dispatchEvent(new Event("loch:hello:1"));
  const channel = new MessageChannel();
  channel.port1.onmessage = (e) => out.heard.push(e.data);
  out.offerNotCancelled = window.dispatchEvent(new MessageEvent("loch:port:1", { ports: [channel.port2], cancelable: true }));
  channel.port1.postMessage({ type: "guard-message", nonce: id });
  channel.port1.postMessage({ type: "config", wallet: "Test Wallet" });
  channel.port1.postMessage({ type: "accounts", accounts: ["11111111111111111111111111111111"] });
  // 3. The Wallet Standard: how many apps answer a wallet that registers, besides nobody?
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: () => { window.__fp.registerCalls++; } }));
  const found = [];
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: (...ws) => (found.push(...ws.map((w) => w.name)), () => undefined) } }));
  await new Promise((r) => setTimeout(r, 1200));
  observer.disconnect();
  out.wallets = found;
  out.globals = Object.getOwnPropertyNames(window).filter((name) => /loch/i.test(name));
  out.fp = window.__fp;
  return out;
};
</script></head><body><h1>An ordinary site</h1><p>Nothing to see.</p></body></html>`;

// A page on the SAME ORIGIN as the connect page that is not the connect page: think blog, docs,
// landing page. It has the user's wallet on it, and a script that only listens.
const BLOG_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Loch blog</title>
<script>
window.__seen = [];
window.addEventListener("message", (e) => { try { window.__seen.push(JSON.parse(JSON.stringify(e.data))); } catch {} });
for (const name of ["loch:port:1", "loch:hello:1"]) window.addEventListener(name, () => window.__seen.push({ event: name }));
</script>
<script src="/mock-wallet.js"></script></head><body><h1>News from the Loch</h1><p>A post.</p></body></html>`;

// What a script on the connect page itself could pick up in passing, if answers still crossed
// the window: it reports every window message it sees to its server.
const LISTENER = `<script>
window.addEventListener("message", (e) => { try { navigator.sendBeacon("/seen", JSON.stringify(e.data)); } catch {} });
for (const name of ["loch:port:1", "loch:hello:1"]) window.addEventListener(name, (e) => navigator.sendBeacon("/seen", JSON.stringify({ event: name, ports: e.ports ? e.ports.length : 0 })));
</script>`;

let world: World;
let context: BrowserContext;
let extensionId: string;
let popup: Page;
let evil: Server;
let alt: Server;
let evilUrl = "";
let altOrigin = "";
/** Every path asked of the connect origin's server, in order. */
const altRequests: string[] = [];
/** What the listening script on the connect page reported. */
const seenOnConnectPage: string[] = [];
let kdSignatureB64 = "";
let spendingKey = "";

const ui = (request: Record<string, unknown>) => popup.evaluate((r) => chrome.runtime.sendMessage(r), request) as Promise<{ ok: boolean; value?: never; error?: { code: string; message: string } }>;
const state = async () => (await ui({ loch: "ui", type: "state" })).value as unknown as { flow: { status: string } | null; shielded: { balance: string; settling: number; address: string } | null; scan: { status: string; report?: unknown }; settings: { connectUrl: string } };
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const idle = (s: Awaited<ReturnType<typeof state>>) => s.flow === null || (s.flow.status !== "running" && s.flow.status !== "waiting");

beforeAll(async () => {
  world = await createWorld();
  const secret = world.wallet.secretKey.slice(0, 32);
  const signature = ed25519.sign(keyDerivationMessage(), secret);
  kdSignatureB64 = Buffer.from(signature).toString("base64");
  spendingKey = deriveKeys(signature, world.wallet.publicKey.toBytes()).privateKey.toString();

  const walletConfig = `window.__MOCK_WALLET=${JSON.stringify({ name: "Test Wallet", secret: Buffer.from(secret).toString("hex"), delay: 60 })};`;
  const bundled = await build({ entryPoints: [join(here, "fixtures/mock-wallet.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "chrome116", banner: { js: walletConfig } });
  const mockWallet = bundled.outputFiles[0]!.text;
  const connectHtml = readFileSync(join(here, "fixtures/connect.html"), "utf8").replace("</head>", `${LISTENER}<script src="/mock-wallet.js"></script></head>`);

  evil = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(EVIL_HTML);
  });
  alt = await listen((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    altRequests.push(path);
    if (path === "/seen") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seenOnConnectPage.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(204).end();
      });
      return;
    }
    if (path === "/connect.html") return void response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(connectHtml);
    if (path === "/blog.html") return void response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(BLOG_HTML);
    if (path === "/mock-wallet.js") return void response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(mockWallet);
    response.writeHead(path === "/favicon.ico" ? 204 : 404).end();
  });
  evilUrl = `${originOf(evil)}/`;
  altOrigin = originOf(alt);

  ({ context, extensionId } = await world.launch());
  popup = await openPopup(context, extensionId);
  // The connect page is <altOrigin>/connect.html: exactly one URL.
  const connect = `${altOrigin}/connect.html`;
  const reply = await ui({ loch: "ui", type: "settings", patch: { rpcUrl: world.urls.rpc, relayerUrl: world.urls.relayer, screenerUrl: world.urls.screener, connectUrl: connect, confirmConnectUrl: connect } });
  expect(reply.ok).toBe(true);
});

afterAll(async () => {
  await world?.close();
  for (const server of [evil, alt]) {
    server?.closeAllConnections();
    server?.close();
  }
});

test("finding 7: before any wallet is connected, a page finds no trace of Loch, whatever it tries", async () => {
  const site = await context.newPage();
  await site.goto(evilUrl);
  const poked = (await site.evaluate(() => (window as unknown as { __poke: () => Promise<unknown> }).__poke())) as {
    offerNotCancelled: boolean;
    heard: unknown[];
    dialogs: number;
    wallets: string[];
    globals: string[];
    fp: { messages: unknown[]; events: string[]; registerCalls: number; appReady: number };
  };
  // Before the fix: window.__lochPageScript === true, and a "config" message telling the page so.
  expect(poked.globals).toEqual([]);
  expect(await site.evaluate(() => (window as unknown as Record<string, unknown>).__lochPageScript)).toBeUndefined();
  // The only window messages are the page's own six.
  expect(poked.fp.messages).toHaveLength(6);
  expect(poked.fp.messages.filter((message) => JSON.stringify(message).includes('"ack"') || JSON.stringify(message).includes('"verdict"'))).toEqual([]);
  // The handshake is over before the page's first script: its hello gets no offer, its offer is not taken, its port hears nothing.
  expect(poked.fp.events).toEqual(["loch:hello:1", "loch:port:1"]); // the page's own two dispatches, and no third
  expect(poked.offerNotCancelled).toBe(true);
  expect(poked.heard).toEqual([]);
  // Nobody listens for wallets, nobody announces an app, no wallet named Loch, no dialog.
  expect(poked.fp.registerCalls).toBe(0);
  expect(poked.fp.appReady).toBe(1); // the page's own
  expect(poked.wallets).toEqual([]);
  expect(poked.dialogs).toBe(0);
  await site.close();
});

test("finding 2: another page of the connect origin, already open, is never asked; the connect page is opened and no page script sees the signature", async () => {
  const blog = await context.newPage();
  await blog.goto(`${altOrigin}/blog.html`);
  await blog.waitForTimeout(600); // its content script announces itself
  altRequests.length = 0;

  await popup.getByRole("button", { name: "Connect wallet" }).click();
  const wallet = popup.getByRole("button", { name: /Test Wallet/ });
  await wallet.waitFor({ timeout: 30_000 });
  // The sheet names the page the wallet will be asked on.
  await expect(popup.locator(".sheet .connect-place")).toHaveText(`${new URL(altOrigin).host}/connect.html`);
  await wallet.click();
  await until(state, (s) => s.shielded !== null && idle(s), 60_000);
  await ui({ loch: "ui", type: "flow-dismiss" });

  // Before the fix: connect.html was never requested, and the blog's script had the signature.
  expect(altRequests.filter((path) => path === "/connect.html")).toHaveLength(1);
  const seen = (await blog.evaluate(() => (window as unknown as { __seen: unknown[] }).__seen)) as unknown[];
  expect(seen).toEqual([]);
  expect(await blog.evaluate(() => window.__mockWallet.log)).toEqual([]);
  // The connect page had a script listening on the window as well. Requests and answers cross a
  // private port now, so it picked up nothing: no request, no answer, no handshake event.
  await popup.waitForTimeout(300);
  expect(seenOnConnectPage).toEqual([]);
  expect(JSON.stringify([seen, seenOnConnectPage])).not.toContain(kdSignatureB64);
  // The tab the extension opened is closed again; the blog tab was left alone.
  expect(context.pages().filter((page) => page.url().includes("/connect.html"))).toEqual([]);
  expect(context.pages().some((page) => page.url().includes("/blog.html"))).toBe(true);
  await blog.close();
});

test("finding 2: the connect page in a tab the user opened is not adopted either", async () => {
  const own = await context.newPage();
  await own.goto(`${altOrigin}/connect.html`);
  await own.waitForTimeout(500);
  await ui({ loch: "ui", type: "lock" });
  altRequests.length = 0;
  expect((await ui({ loch: "ui", type: "unlock", address: world.wallet.publicKey.toBase58() })).ok).toBe(true);
  await until(state, (s) => s.shielded !== null && idle(s), 60_000);
  await ui({ loch: "ui", type: "flow-dismiss" });
  // A second copy was opened for the flow; the user's tab was never asked.
  expect(altRequests.filter((path) => path === "/connect.html")).toHaveLength(1);
  expect(await own.evaluate(() => window.__mockWallet.log)).toEqual([]);
  expect(await own.locator("[data-loch-status]").innerText()).toBe("");
  await own.close();
});

test("finding 10: the witness goes to the prover and to no other page of the extension", async () => {
  await popup.evaluate(() => {
    (window as unknown as { __heard: unknown[] }).__heard = [];
    chrome.runtime.onMessage.addListener((message: unknown) => {
      (window as unknown as { __heard: unknown[] }).__heard.push(message);
      return false;
    });
  });
  expect((await ui({ loch: "ui", type: "dive", amount: "2000000000" })).ok).toBe(true);
  await until(state, (s) => s.shielded?.balance === "2000000000" && idle(s), 120_000);
  await ui({ loch: "ui", type: "flow-dismiss" });
  // A private send: its witness spends a real note with the real spending key.
  const quote = (await ui({ loch: "ui", type: "quote", want: "spend" })).value as unknown as { relayer: { fee: string } };
  const fee = quote.relayer.fee;
  expect((await ui({ loch: "ui", type: "send", to: world.friend, amount: "100000000", fee })).ok).toBe(true);
  await until(state, (s) => s.shielded?.balance === (2_000_000_000n - 100_000_000n - BigInt(fee)).toString() && s.shielded.settling === 0 && idle(s), 120_000);
  await ui({ loch: "ui", type: "flow-dismiss" });
  expect(world.relayer.sent).toHaveLength(1);

  const heard = (await popup.evaluate(() => (window as unknown as { __heard: unknown[] }).__heard)) as Record<string, unknown>[];
  // Before the fix: two "prove" messages with the full circuit input, inPrivateKey included.
  expect(heard.filter((message) => message.type === "prove" || "input" in message)).toEqual([]);
  expect(JSON.stringify(heard)).not.toContain(spendingKey);
  expect(JSON.stringify(heard)).not.toContain("inPrivateKey");
  // What an extension page does hear: that the state changed and, at most, the request to open
  // the prover's port. Nothing a content script said either: the dive-in above went through the
  // bridge, and its answers (like the key-derivation signature at unlock) go to the worker alone.
  expect([...new Set(heard.map((message) => String(message.type)))].filter((type) => type !== "loch:state-changed" && type !== "connect")).toEqual([]);
  expect(heard.length).toBeGreaterThan(0);
});

test("finding 3: after a leak scan, a page still cannot test whether an address is this browser's Loch wallet", async () => {
  // The wallet has paid the fixture's recipient again and again: a transfer to it draws a warning when it is reviewed.
  const now = Math.floor(Date.now() / 1000);
  world.chain.seedTransfers(world.wallet.publicKey.toBase58(), [
    { dir: "in", counterparty: Keypair.generate().publicKey.toBase58(), sol: 12, time: now - 9 * 86_400 },
    ...Array.from({ length: 5 }, (_, i) => ({ dir: "out" as const, counterparty: world.fixture.recipient, sol: 0.1 + i / 100, time: now - (8 - i) * 86_400 })),
  ]);
  await ui({ loch: "ui", type: "scan-start" });
  await until(state, (s) => s.scan.status === "done" && !!s.scan.report, 60_000);

  const real = world.wallet.publicKey.toBase58();
  // In reality: the public list of addresses that deposited into the pool.
  const candidates = Array.from({ length: 299 }, () => Keypair.generate().publicKey.toBase58());
  candidates.splice(137, 0, real);

  // A site with the user's wallet on it, so the Loch wallet is there to be asked. Never connected, never clicked.
  const site = await context.newPage();
  await site.goto(`${world.urls.dapp}?wallet=Loch`);
  await expect(site.locator("#wallets")).toContainText("Loch");
  const probe = (await site.evaluate(
    async ([list, recipient]) => {
      const found: { name: string; features: Record<string, Record<string, (...inputs: unknown[]) => Promise<unknown>>> }[] = [];
      window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: (...ws: never[]) => (found.push(...ws), () => undefined) } }));
      const loch = found.find((w) => w.name === "Loch")!;
      let dialogs = 0;
      const observer = new MutationObserver(() => {
        for (const el of document.querySelectorAll("loch-dialog")) {
          dialogs++;
          el.remove();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      // A System transfer from the candidate to an address its history knows well.
      const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const decode = (text: string) => {
        let n = 0n;
        for (const ch of text) n = n * 58n + BigInt(B58.indexOf(ch));
        const out = new Uint8Array(32);
        for (let i = 31; i >= 0; i--) {
          out[i] = Number(n & 255n);
          n >>= 8n;
        }
        return out;
      };
      const tx = (from: string) => new Uint8Array([1, ...new Uint8Array(64), 1, 0, 1, 3, ...decode(from), ...decode(recipient!), ...new Uint8Array(32), ...new Uint8Array(32), 1, 2, 2, 0, 1, 12, 2, 0, 0, 0, 0, 194, 235, 11, 0, 0, 0, 0]);
      const results: { account: string; outcome: string; ms: number }[] = [];
      await Promise.all(
        (list as string[]).map(async (account) => {
          const started = performance.now();
          const settled = await Promise.race([
            loch.features["solana:signTransaction"]!.signTransaction!({ account: { address: account, publicKey: decode(account), chains: ["solana:devnet"], features: [] }, transaction: tx(account), chain: "solana:devnet" }).then(
              () => "signed",
              (error: Error) => `rejected: ${error.message}`,
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 6000)),
          ]);
          results.push({ account, outcome: settled, ms: Math.round(performance.now() - started) });
        }),
      );
      observer.disconnect();
      return { results, dialogs };
    },
    [candidates, world.fixture.recipient] as const,
  )) as { results: { account: string; outcome: string; ms: number }[]; dialogs: number };

  // Before the fix (through the window messages a page could then post itself): 299 verdicts and,
  // for the user's own address, a dialog and no verdict. Now every address is answered alike.
  expect(probe.dialogs).toBe(0);
  expect(new Set(probe.results.map((result) => result.outcome))).toEqual(new Set(["rejected: invalid account"]));
  const own = probe.results.find((result) => result.account === real)!;
  const others = probe.results.filter((result) => result.account !== real).map((result) => result.ms);
  expect(own.ms).toBeLessThanOrEqual(Math.max(...others) + 50);
  expect(await site.locator("loch-dialog").count()).toBe(0);

  // The old way in, posting review requests on the window: nobody answers, nothing appears.
  const posted = (await site.evaluate(async (list) => {
    const verdicts: unknown[] = [];
    window.addEventListener("message", (e) => {
      if (e.data?.type === "verdict" || e.data?.type === "ack") verdicts.push(e.data);
    });
    for (const account of list as string[]) {
      const id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      window.postMessage({ channel: "loch:bridge:1", to: "content", type: "guard-transactions", nonce: id, account, transactions: ["AQ=="] }, location.origin);
    }
    await new Promise((r) => setTimeout(r, 1500));
    return { verdicts: verdicts.length, dialogs: document.querySelectorAll("loch-dialog").length };
  }, candidates)) as { verdicts: number; dialogs: number };
  expect(posted).toEqual({ verdicts: 0, dialogs: 0 });

  // (Playwright runs `evaluate` as a user gesture, so the probe above had one, and its first
  // candidate was the one account that gesture could have reviewed. Let that gesture lapse.)
  await site.waitForTimeout(5_300);

  // The wallet now gives this site the account: a connect made through the Loch wallet.
  const done = (count: number) => expect(site.locator("body")).toHaveAttribute("data-done", String(count), { timeout: 20_000 });
  const walletSigned = async () => (await site.evaluate(() => window.__mockWallet.log)).filter((entry) => entry.method === "signTransaction").length;
  await site.locator("#connect").click();
  await done(1);
  await site.waitForTimeout(5_300);

  // Without a user gesture nothing is reviewed, even now: a script cannot draw dialogs by itself.
  const cdp = await context.newCDPSession(site);
  await cdp.send("Runtime.evaluate", { expression: `document.getElementById("sign-transfer").click()`, userGesture: false });
  await done(2);
  expect(await walletSigned()).toBe(1);
  expect(await site.locator("loch-dialog").count()).toBe(0);

  // With one (a real click), for the account the site was given: the warning is there.
  await site.locator("#sign-transfer").click();
  await expect(site.locator("loch-dialog")).toBeAttached({ timeout: 15_000 });
  await site.keyboard.press("Escape");
  await done(3);
  expect(await walletSigned()).toBe(1);
  await site.close();
});

test("finding 5: through the Loch wallet, a getter, a replaced built-in, a forged verdict and a swapped transaction no longer get past it", async () => {
  const site = await context.newPage();
  await site.setViewportSize({ width: 1000, height: 720 });
  await site.goto(`${world.urls.dapp}?wallet=Loch`);
  await expect(site.locator("#wallets")).toContainText("Loch");
  const fixture = world.fixture;

  const first = (await site.evaluate(async (fx) => {
    const enc = (text: string) => new TextEncoder().encode(text);
    const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
    const bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const KD = "Loch key derivation v1";
    type W = { name: string; accounts: { address: string }[]; features: Record<string, Record<string, (...inputs: unknown[]) => Promise<{ signature: Uint8Array; signedTransaction: Uint8Array }[]>>> };
    const found: W[] = [];
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: (...ws: W[]) => (found.push(...ws), () => undefined) } }));
    const real = found.find((w) => w.name === "Test Wallet")!;
    const loch = found.find((w) => w.name === "Loch")!;
    const out: Record<string, unknown> = { wallets: found.map((w) => w.name) };
    const attempt = async (run: () => Promise<{ signature: Uint8Array }[]>) => {
      try {
        return `signed: ${b64((await run())[0]!.signature)}`;
      } catch (error) {
        return `refused: ${String((error as Error).message).slice(0, 34)}`;
      }
    };

    await loch.features["standard:connect"]!.connect!();
    const account = loch.accounts[0];

    // 0. baseline: the plain request is not passed on.
    out.baseline = await attempt(() => loch.features["solana:signMessage"]!.signMessage!({ account, message: enc(KD) }));

    // 2. a message that reads differently the second time.
    let reads = 0;
    const twoFaced = {
      account,
      get message() {
        return reads++ === 0 ? enc("hello") : enc(KD);
      },
    };
    out.getter = await attempt(() => loch.features["solana:signMessage"]!.signMessage!(twoFaced));
    out.getterReads = reads;

    // 3. the guard asks a global the page owns whether the message is bytes; and more of the same.
    const typed = Object.getPrototypeOf(Uint8Array.prototype);
    const saved = { isView: ArrayBuffer.isView, length: Object.getOwnPropertyDescriptor(typed, "length")!, charCodeAt: String.prototype.charCodeAt, keys: Object.keys };
    ArrayBuffer.isView = (() => false) as unknown as typeof ArrayBuffer.isView;
    Object.defineProperty(typed, "length", { configurable: true, get: () => 0 });
    String.prototype.charCodeAt = () => 0;
    Object.keys = () => [];
    let patched: Promise<string>;
    try {
      patched = attempt(() => loch.features["solana:signMessage"]!.signMessage!({ account, message: new Uint8Array([76, 111, 99, 104, 32, 107, 101, 121, 32, 100, 101, 114, 105, 118, 97, 116, 105, 111, 110, 32, 118, 49]) }));
    } finally {
      ArrayBuffer.isView = saved.isView;
      Object.defineProperty(typed, "length", saved.length);
      String.prototype.charCodeAt = saved.charCodeAt;
      Object.keys = saved.keys;
    }
    out.patched = await patched;

    // 5. the leak warning: Loch is shown one transaction, the wallet is to be given another.
    let txReads = 0;
    const swapped = {
      account,
      chain: "solana:devnet",
      get transaction() {
        return txReads++ === 0 ? bytes(fx.memo) : bytes(fx.transfer);
      },
    };
    await loch.features["solana:signTransaction"]!.signTransaction!(swapped);
    out.txReads = txReads;

    // 1. around it: the real wallet is on the same page. This cannot be closed, and is not claimed to be.
    out.direct = await attempt(() => real.features["solana:signMessage"]!.signMessage!({ account, message: enc(KD) }));
    out.walletLog = window.__mockWallet.log;
    return out;
  }, fixture)) as { wallets: string[]; baseline: string; getter: string; getterReads: number; patched: string; txReads: number; direct: string; walletLog: { method: string; payload?: string }[] };

  const kd = Buffer.from("Loch key derivation v1").toString("base64");
  const hello = Buffer.from("hello").toString("base64");
  const helloSignature = Buffer.from(ed25519.sign(Buffer.from("hello"), world.wallet.secretKey.slice(0, 32))).toString("base64");
  expect(first.baseline).toMatch(/^refused: Loch did not pass this request on/);
  // The getter: read once; the wallet signed "hello", which is what Loch checked. Before the fix: the key-derivation signature.
  expect(first.getterReads).toBe(1);
  expect(first.getter).toBe(`signed: ${helloSignature}`);
  // The replaced built-ins: still refused. Before the fix: the key-derivation signature.
  expect(first.patched).toMatch(/^refused: Loch did not pass this request on/);
  // The swap: read once, and the wallet was given the transaction Loch looked at (the memo), not the transfer.
  expect(first.txReads).toBe(1);
  const beforeDirect = first.walletLog.slice(0, -1);
  expect(beforeDirect.filter((entry) => entry.method === "signTransaction").map((entry) => entry.payload)).toEqual([fixture.memo]);
  // Through the Loch wallet the real wallet never saw the key-derivation message...
  expect(beforeDirect.filter((entry) => entry.payload === kd)).toEqual([]);
  expect(beforeDirect.filter((entry) => entry.method === "signMessage").map((entry) => entry.payload)).toEqual([hello]);
  // ...and asked directly, it signs it. Loch is not in that path, and says so (README, the settings, the dialogs).
  expect(first.direct).toBe(`signed: ${kdSignatureB64}`);

  // The refused requests raised the dialog that says why (one, however many requests there were).
  await expect(site.locator("loch-dialog")).toHaveCount(1);
  await site.screenshot({ path: join(SHOTS_DIR, "e2e-24-wrapper-not-passed-on.png") });
  await site.keyboard.press("Escape");
  await expect(site.locator("loch-dialog")).toHaveCount(0);

  // 4. the leak warning: the page answers for the user with a forged verdict, on every channel it has.
  await site.evaluate((fx) => {
    type W = { name: string; accounts: unknown[]; features: Record<string, Record<string, (...inputs: unknown[]) => Promise<unknown>>> };
    const found: W[] = [];
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: (...ws: W[]) => (found.push(...ws), () => undefined) } }));
    const loch = found.find((w) => w.name === "Loch")!;
    const state = ((window as unknown as { __forge: { outcome: string; dialogs: number } }).__forge = { outcome: "pending", dialogs: 0 });
    const forge = (data: unknown) => {
      for (const allow of [true]) {
        window.postMessage({ channel: "loch:bridge:1", to: "page", type: "verdict", nonce: (data as { nonce?: string })?.nonce ?? "AAAAAAAAAAAAAAAAAAAAAA", allow }, location.origin);
        window.postMessage({ type: "verdict", nonce: (data as { nonce?: string })?.nonce ?? "AAAAAAAAAAAAAAAAAAAAAA", allow }, location.origin);
      }
    };
    // Answer whatever the extension might post about a review (it posts nothing on the window now).
    window.addEventListener("message", (e) => {
      if (e.data && (e.data as { type?: string }).type === "guard-transactions") forge(e.data);
    });
    const button = document.createElement("button");
    button.id = "forge";
    button.textContent = "forge";
    button.addEventListener("click", () => {
      const spam = setInterval(() => forge({}), 50);
      // Promise reactions are the page's too.
      const then = Promise.prototype.then;
      Promise.prototype.then = function (this: Promise<unknown>, ok, no) {
        return then.call(this, ok ? () => (ok as (v: unknown) => unknown)(true) : ok, no);
      } as typeof Promise.prototype.then;
      const pending = loch.features["solana:signTransaction"]!.signTransaction!({ account: loch.accounts[0], transaction: Uint8Array.from(atob(fx.transfer), (c) => c.charCodeAt(0)), chain: "solana:devnet" });
      Promise.prototype.then = then;
      then.call(
        pending,
        () => void ((state.outcome = "signed"), clearInterval(spam)),
        (error: Error) => void ((state.outcome = `rejected: ${error.message}`), clearInterval(spam)),
      );
    });
    document.body.append(button);
    new MutationObserver(() => (state.dialogs = document.querySelectorAll("loch-dialog").length)).observe(document.documentElement, { childList: true, subtree: true });
  }, fixture);
  const forgeState = () => site.evaluate(() => (window as unknown as { __forge: { outcome: string; dialogs: number } }).__forge);
  const signed = async () => (await site.evaluate(() => window.__mockWallet.log)).filter((entry) => entry.method === "signTransaction").length;
  const signedBefore = await signed();
  await site.locator("#forge").click();
  await expect(site.locator("loch-dialog")).toBeAttached({ timeout: 15_000 });
  await site.waitForTimeout(2000);
  // Before the fix: signed within milliseconds, the dialog never mattering. Now only the user's answer counts.
  expect(await forgeState()).toEqual({ outcome: "pending", dialogs: 1 });
  expect(await signed()).toBe(signedBefore);
  // The page takes the dialog away. Then nobody answers, and the request is never passed on.
  await site.evaluate(() => document.querySelector("loch-dialog")?.remove());
  await site.waitForTimeout(1500);
  expect((await forgeState()).outcome).toBe("pending");
  expect(await signed()).toBe(signedBefore);
  await site.close();
});

test("finding 7: with the wrapper off, a page learns neither that Loch is installed nor which wallet the user has", async () => {
  expect((await ui({ loch: "ui", type: "settings", patch: { wrapperEnabled: false } })).ok).toBe(true);
  try {
    for (const url of [evilUrl, `${world.urls.dapp}?wallet=Loch`]) {
      const site = await context.newPage();
      await site.goto(url);
      await site.waitForTimeout(1500);
      // The fixture site has no probe of its own: give it the ordinary site's.
      const poked = (await site.evaluate(async () => {
        const w = window as unknown as { __poke?: () => Promise<Record<string, unknown>>; __lochPageScript?: unknown };
        if (w.__poke) return { ...(await w.__poke()), flag: w.__lochPageScript };
        const messages: unknown[] = [];
        window.addEventListener("message", (e) => messages.push(e.data));
        const found: string[] = [];
        let dialogs = 0;
        new MutationObserver(() => (dialogs += document.querySelectorAll("loch-dialog").length)).observe(document.documentElement, { childList: true, subtree: true });
        window.postMessage({ channel: "loch:bridge:1", to: "page", type: "config", enabled: true, wallet: "Test Wallet", bridge: false }, location.origin);
        window.postMessage({ type: "config", wallet: "Test Wallet" }, location.origin);
        window.postMessage({ channel: "loch:bridge:1", to: "content", type: "guard-message", nonce: "AAAAAAAAAAAAAAAAAAAAAA" }, location.origin);
        const channel = new MessageChannel();
        const heard: unknown[] = [];
        channel.port1.onmessage = (e) => heard.push(e.data);
        const offerNotCancelled = window.dispatchEvent(new MessageEvent("loch:port:1", { ports: [channel.port2], cancelable: true }));
        channel.port1.postMessage({ type: "config", wallet: "Test Wallet" });
        channel.port1.postMessage({ type: "guard-message", nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
        await new Promise((r) => setTimeout(r, 1200));
        window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register: (...ws: { name: string }[]) => (found.push(...ws.map((x) => x.name)), () => undefined) } }));
        return { wallets: found, dialogs, heard, offerNotCancelled, flag: w.__lochPageScript, fp: { messages: messages.filter((m) => JSON.stringify(m).includes("ack") || JSON.stringify(m).includes("verdict")) } };
      })) as { wallets: string[]; dialogs: number; heard: unknown[]; offerNotCancelled: boolean; flag: unknown; fp: { messages: unknown[]; registerCalls?: number; appReady?: number } };
      // Before the fix: the flag, and a "config" message with enabled: false and the wallet's name.
      expect(poked.flag, url).toBeUndefined();
      expect(poked.wallets.filter((name) => name === "Loch"), url).toEqual([]);
      expect(poked.dialogs, url).toBe(0);
      expect(poked.heard, url).toEqual([]);
      expect(poked.offerNotCancelled, url).toBe(true);
      if (poked.fp.registerCalls === undefined) expect(poked.fp.messages, url).toEqual([]);
      if (poked.fp.registerCalls !== undefined) {
        expect(poked.fp.registerCalls).toBe(0);
        expect(poked.fp.appReady).toBe(1);
        expect(poked.fp.messages).toHaveLength(6); // its own, and nothing from the extension
      }
      await site.close();
    }
  } finally {
    await ui({ loch: "ui", type: "settings", patch: { wrapperEnabled: true } });
  }
});

test("finding 8: the content-script world can neither read nor write the extension's storage", async () => {
  const site = await context.newPage();
  await site.goto(evilUrl);
  await site.waitForTimeout(500);
  const cdp = await context.newCDPSession(site);
  const contexts: { id: number; origin: string; name: string; auxData?: { type?: string } }[] = [];
  cdp.on("Runtime.executionContextCreated", (event) => contexts.push(event.context as never));
  await cdp.send("Runtime.enable");
  await site.waitForTimeout(300);
  const isolated = contexts.find((c) => c.auxData?.type === "isolated" && String(c.origin).includes(extensionId));
  expect(isolated, "the extension's content-script world").toBeDefined();
  // What code with the content script's privileges (a compromised renderer) can reach.
  const run = async (expression: string): Promise<string> => {
    const reply = await cdp.send("Runtime.evaluate", { expression, contextId: isolated!.id, awaitPromise: true, returnByValue: true });
    return String(reply.result?.value ?? reply.exceptionDetails?.exception?.description ?? reply.exceptionDetails?.text);
  };
  const attempt = (code: string) => run(`(async()=>{try{${code}}catch(e){return "REFUSED "+e.message}})()`);
  // Before the fix: the wallets list with the public address, the settings, and a successful write of connectUrl.
  expect(await attempt(`return JSON.stringify(Object.keys(await chrome.storage.local.get(null)))`)).toMatch(/^REFUSED .*Access to storage is not allowed from this context/);
  expect(await attempt(`return JSON.stringify((await chrome.storage.local.get("wallets")).wallets)`)).toMatch(/^REFUSED /);
  expect(await attempt(`return JSON.stringify(Object.keys(await chrome.storage.session.get(null)))`)).toMatch(/^REFUSED /);
  const before = (await state()).settings.connectUrl;
  expect(await attempt(`await chrome.storage.local.set({settings:{connectUrl:"http://127.0.0.1:9/attacker.html"}});return "written"`)).toMatch(/^REFUSED /);
  expect(await attempt(`await chrome.storage.local.remove("wallets");return "removed"`)).toMatch(/^REFUSED /);
  expect(await attempt(`await chrome.storage.local.clear();return "cleared"`)).toMatch(/^REFUSED /);
  const onDisk = (await popup.evaluate(async () => await chrome.storage.local.get(["settings", "wallets"]))) as { settings: { connectUrl: string }; wallets: unknown[] };
  expect(onDisk.settings.connectUrl).toBe(before);
  expect(onDisk.wallets).toHaveLength(1);
  // The content script itself still works without it: all it has is its port to the worker.
  expect(
    await attempt(`return await new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: "loch-content" });
      port.onMessage.addListener((answer) => resolve(JSON.stringify(answer.reply)));
      port.postMessage({ id: 1, message: { loch: "content", type: "config" } });
    })`),
  ).toBe(JSON.stringify({ enabled: true, wallet: "Test Wallet", bridge: false }));
  // A content script's runtime.sendMessage is no longer listened to (it would reach every extension page).
  expect(await attempt(`return String(await Promise.race([chrome.runtime.sendMessage({loch:"content",type:"config"}), new Promise((r) => setTimeout(() => r("no answer"), 800))]))`)).toMatch(/no answer|undefined|REFUSED/);

  // And nothing of the package is reachable from a page.
  const war = await site.evaluate(async (id) => {
    try {
      return `fetched ${(await fetch(`chrome-extension://${id}/manifest.json`)).status}`;
    } catch (error) {
      return `blocked (${(error as Error).message})`;
    }
  }, extensionId);
  expect(war).toMatch(/^blocked/);
  await site.close();
});

test("finding 2: the settings screen asks before the connect page is changed", async () => {
  await popup.locator(".address-chip").click();
  await popup.getByRole("button", { name: /^Settings/ }).click();
  const field = popup.locator("#set-connectUrl");
  await expect(field).toHaveValue(`${altOrigin}/connect.html`);
  await field.fill("http://127.0.0.1:9/other.html");
  await popup.getByRole("button", { name: "Save endpoints" }).click();
  const ask = popup.getByRole("alertdialog");
  await expect(ask).toContainText("Ask your wallet on 127.0.0.1:9/other.html?");
  await expect(ask).toContainText("can take the signature, and with it your shielded funds, for good");
  await ask.scrollIntoViewIfNeeded();
  await popup.screenshot({ path: join(SHOTS_DIR, "e2e-20-settings-connect-confirm.png") });
  // Nothing was saved by pressing Save.
  expect((await state()).settings.connectUrl).toBe(`${altOrigin}/connect.html`);
  await ask.getByRole("button", { name: "Keep the current page" }).click();
  await expect(field).toHaveValue(`${altOrigin}/connect.html`);
  expect((await state()).settings.connectUrl).toBe(`${altOrigin}/connect.html`);
  // And with the confirmation, it is.
  await field.fill("http://127.0.0.1:9/other.html");
  await popup.getByRole("button", { name: "Save endpoints" }).click();
  await popup.getByRole("alertdialog").getByRole("button", { name: "Use this page" }).click();
  await until(state, (s) => s.settings.connectUrl === "http://127.0.0.1:9/other.html", 10_000);
  const back = `${altOrigin}/connect.html`;
  await ui({ loch: "ui", type: "settings", patch: { connectUrl: back, confirmConnectUrl: back } });
});
