// The world the end-to-end tests run in: the built extension in Chromium, a fixture web page
// with a mock wallet, and mock RPC, relayer and screener servers that speak the real protocols.
// Every server listens on 127.0.0.1 only and is closed when the tests end.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ed25519 } from "@noble/curves/ed25519";
import { deriveKeys, encodeShieldedAddress, keyDerivationMessage, terminateProver } from "@loch/sdk";
import { loadVerificationKey } from "@loch/sdk/node";
import { type BrowserContext, type Page, chromium } from "@playwright/test";
import { Keypair, SystemProgram, Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { build } from "esbuild";

import { MockChain } from "./mock/chain.js";
import { type HttpReply, MockRelayer, MockScreener } from "./mock/services.js";

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = join(here, "../dist");
export const SHOTS_DIR = join(here, "../shots");

// The mock services send no CORS headers at all, as the real relayer and screening service do
// by default. The extension reaches them through its host permissions, not through CORS: if it
// ever came to depend on a permissive header, every test here would fail.

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const originOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function jsonService(handle: (method: string, path: string, body: unknown) => Promise<HttpReply>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    // A preflight would mean the browser is treating the request as cross-origin. Refuse it.
    if (request.method === "OPTIONS") return void response.writeHead(405).end();
    const text = await readBody(request);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const reply = await handle(request.method ?? "GET", new URL(request.url ?? "/", "http://x").pathname, body);
    if (reply.drop) return void request.socket.destroy();
    response.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  };
}

async function bundle(entry: string, banner = ""): Promise<string> {
  const result = await build({ entryPoints: [join(here, "fixtures", entry)], bundle: true, write: false, format: "iife", platform: "browser", target: "chrome116", banner: { js: banner } });
  return result.outputFiles[0]!.text;
}

export interface World {
  chain: MockChain;
  relayer: MockRelayer;
  screener: MockScreener;
  wallet: Keypair;
  /** Someone else's shielded address, to send to. */
  friend: string;
  urls: { rpc: string; relayer: string; screener: string; connect: string; dapp: string };
  /** Every host the browser asked the proxy for, in order. */
  hosts: string[];
  /** Every request made by the extension's own pages and its service worker, as Playwright saw them. */
  extensionRequests: string[];
  /** The transactions the fixture site asks its wallet to sign, base64. `transferNew` pays an address the wallet never paid. */
  fixture: { transfer: string; transferNew: string; memo: string; garbage: string; recipient: string; newRecipient: string };
  profile: string;
  launch(): Promise<{ context: BrowserContext; extensionId: string }>;
  close(): Promise<void>;
}

export async function createWorld(): Promise<World> {
  const verificationKey = await loadVerificationKey();
  const screenerKey = Keypair.generate();
  const relayerKey = Keypair.generate();
  const wallet = Keypair.generate();
  // The real verification key: every proof the extension makes is checked as the program checks it.
  const chain = new MockChain({ screener: screenerKey.publicKey, verificationKey });
  chain.airdrop(relayerKey.publicKey, 10_000_000_000n);
  chain.airdrop(wallet.publicKey, 12_000_000_000n);
  const relayer = new MockRelayer({ chain, keypair: relayerKey, feeLamports: 2_500_000n, verificationKey });
  const screener = new MockScreener({ chain, keypair: screenerKey });

  const friendKey = Keypair.generate();
  const friend = encodeShieldedAddress(deriveKeys(ed25519.sign(keyDerivationMessage(), friendKey.secretKey.slice(0, 32)), friendKey.publicKey.toBytes()));

  // What the fixture site will ask its wallet to sign.
  const recipient = Keypair.generate().publicKey;
  const newRecipient = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const serialise = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const fixture = {
    recipient: recipient.toBase58(),
    newRecipient: newRecipient.toBase58(),
    transfer: serialise(new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 200_000_000 }))),
    transferNew: serialise(new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: newRecipient, lamports: 100_000_000 }))),
    memo: serialise(
      new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(
        new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("hello") }),
      ),
    ),
    garbage: Buffer.from(Array.from({ length: 180 }, (_, i) => (i * 37 + 11) % 256)).toString("base64"),
  };

  const walletConfig = `window.__MOCK_WALLET=${JSON.stringify({ name: "Test Wallet", secret: Buffer.from(wallet.secretKey.slice(0, 32)).toString("hex"), delay: 120 })};`;
  const mockWallet = await bundle("mock-wallet.ts", walletConfig);
  const dappScript = await bundle("dapp.ts", `const __FIXTURE__=${JSON.stringify(fixture)};`);
  const inject = (html: string) => html.replace("</head>", `<script src="/mock-wallet.js"></script></head>`);
  const pages = (files: Record<string, { type: string; body: string; csp?: string }>) => (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path === "/favicon.ico") return void response.writeHead(204).end();
    const file = files[path];
    if (!file) return void response.writeHead(404).end("not found");
    response.writeHead(200, { "content-type": file.type, "cache-control": "no-store", ...(file.csp ? { "content-security-policy": file.csp } : {}) }).end(file.body);
  };
  // The fixture site has a strict policy of its own, as a careful site does: scripts and styles
  // from itself only, no inline style but its own (by nonce). Whatever the extension adds to
  // the page (the Loch wallet, the in-page dialog) has to work under it without a violation.
  const DAPP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'nonce-fixture'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
  const script = { type: "text/javascript", body: mockWallet };

  const servers = {
    rpc: await listen(async (request, response) => {
      if (request.method === "OPTIONS") return void response.writeHead(405).end();
      const body = JSON.parse(await readBody(request));
      if (chain.down) return void request.socket.destroy();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await chain.handle(body)));
    }),
    relayer: await listen(jsonService((method, path, body) => relayer.handle(method, path, body))),
    screener: await listen(jsonService((method, path, body) => screener.handle(method, path, body))),
    connect: await listen(pages({ "/connect.html": { type: "text/html", body: inject(readFileSync(join(here, "fixtures/connect.html"), "utf8")) }, "/mock-wallet.js": script })),
    dapp: await listen(
      pages({ "/": { type: "text/html", body: inject(readFileSync(join(here, "fixtures/dapp.html"), "utf8")), csp: DAPP_CSP }, "/mock-wallet.js": script, "/dapp.js": { type: "text/javascript", body: dappScript } }),
    ),
  };

  // A forward proxy the browser is told to use for everything, loopback included. It records
  // every host asked for, forwards to this machine only, and refuses the rest.
  const hosts: string[] = [];
  const proxy = await listen((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      return void response.writeHead(400).end();
    }
    hosts.push(target.host);
    if (target.hostname !== "127.0.0.1") return void response.writeHead(502).end("refused by the test proxy");
    const upstream = httpRequest({ host: "127.0.0.1", port: target.port, path: target.pathname + target.search, method: request.method, headers: request.headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("connect", (request, socket) => {
    hosts.push(request.url ?? "unknown");
    socket.end("HTTP/1.1 502 Refused by the test proxy\r\n\r\n");
  });

  const extensionRequests: string[] = [];
  const profile = mkdtempSync(join(tmpdir(), "loch-e2e-"));
  const contexts: BrowserContext[] = [];
  const urls = { rpc: originOf(servers.rpc), relayer: originOf(servers.relayer), screener: originOf(servers.screener), connect: `${originOf(servers.connect)}/connect.html`, dapp: `${originOf(servers.dapp)}/` };

  return {
    chain,
    relayer,
    screener,
    wallet,
    friend,
    urls,
    hosts,
    extensionRequests,
    fixture,
    profile,
    async launch() {
      // Extensions need the full browser: Playwright's headless shell cannot load them. The
      // "chromium" channel runs the same build in the new headless mode.
      const context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        viewport: { width: 380, height: 600 },
        colorScheme: "dark",
        args: [
          `--disable-extensions-except=${EXTENSION_DIR}`,
          `--load-extension=${EXTENSION_DIR}`,
          `--proxy-server=${originOf(proxy)}`,
          "--proxy-bypass-list=<-loopback>",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-sync",
          "--disable-domain-reliability",
          "--no-pings",
          "--no-first-run",
        ],
      });
      contexts.push(context);
      // With PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 (set in vitest.e2e.config.ts) this
      // also reports what the service worker fetches, which is where the extension's network
      // access lives.
      context.on("request", (request) => {
        const worker = request.serviceWorker();
        let from = "";
        try {
          from = worker ? worker.url() : (request.frame()?.url() ?? "");
        } catch {
          from = "";
        }
        if (from.startsWith("chrome-extension://")) extensionRequests.push(request.url());
      });
      let [worker] = context.serviceWorkers();
      worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
      return { context, extensionId: new URL(worker.url()).host };
    },
    async close() {
      for (const context of contexts) await context.close().catch(() => undefined);
      for (const server of [...Object.values(servers), proxy]) {
        server.closeAllConnections();
        server.close();
      }
      rmSync(profile, { recursive: true, force: true });
      // The mock relayer and chain verify proofs with snarkjs, which keeps worker threads alive.
      await terminateProver();
    },
  };
}

/** Opens the popup's page at the popup's size. */
export async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/app.html?view=popup`);
  await page.waitForSelector(".popup");
  return page;
}

/**
 * Points the extension at the mock servers, through the same request the settings screen sends.
 * The connect page is changed with the confirmation the settings screen asks the user for.
 */
export async function configure(page: Page, world: Pick<World, "urls">): Promise<void> {
  const reply = await page.evaluate(
    (patch) => chrome.runtime.sendMessage({ loch: "ui", type: "settings", patch }),
    { rpcUrl: world.urls.rpc, relayerUrl: world.urls.relayer, screenerUrl: world.urls.screener, connectUrl: world.urls.connect, confirmConnectUrl: world.urls.connect },
  );
  if (!(reply as { ok: boolean }).ok) throw new Error(`settings were refused: ${JSON.stringify(reply)}`);
}

export const SOL = 1_000_000_000n;

/** The connect page with a mock wallet for `wallet`, served from this machine. For the run against a real validator. */
export async function serveConnectPage(wallet: Keypair): Promise<{ url: string; close(): void }> {
  const config = `window.__MOCK_WALLET=${JSON.stringify({ name: "Test Wallet", secret: Buffer.from(wallet.secretKey.slice(0, 32)).toString("hex"), delay: 120 })};`;
  const script = await bundle("mock-wallet.ts", config);
  const html = readFileSync(join(here, "fixtures/connect.html"), "utf8").replace("</head>", `<script src="/mock-wallet.js"></script></head>`);
  const server = await listen((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path === "/connect.html") return void response.writeHead(200, { "content-type": "text/html" }).end(html);
    if (path === "/mock-wallet.js") return void response.writeHead(200, { "content-type": "text/javascript" }).end(script);
    response.writeHead(path === "/favicon.ico" ? 204 : 404).end();
  });
  return {
    url: `${originOf(server)}/connect.html`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Starts Chromium with the built extension and nothing else. */
export async function launchExtension(profile: string): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 380, height: 600 },
    colorScheme: "dark",
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`, "--disable-background-networking", "--disable-component-update", "--no-first-run"],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
  return { context, extensionId: new URL(worker.url()).host };
}
