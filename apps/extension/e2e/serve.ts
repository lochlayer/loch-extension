// Serves the development connect page on this machine only, for working with an unpacked
// extension by hand:
//
//   pnpm --filter @loch/extension run connect-page            http://127.0.0.1:5174/connect.html
//   pnpm --filter @loch/extension run connect-page -- --mock-wallet
//
// With --mock-wallet the page also carries a stand-in wallet ("Test Wallet") with a key made
// up for this run, so the flows can be walked through without a wallet extension. Stop it with
// Ctrl-C. It listens on 127.0.0.1 and nowhere else.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
// A port of its own, where nothing else is served: the extension trusts this exact address with
// the wallet's key-derivation signature. (5173 is Vite's default; other dev servers land there.)
const port = Number(process.env.PORT ?? 5174);
const mock = process.argv.includes("--mock-wallet");
let page = readFileSync(join(here, "fixtures/connect.html"), "utf8");
let script = "";
if (mock) {
  const wallet = Keypair.generate();
  const config = `window.__MOCK_WALLET=${JSON.stringify({ name: "Test Wallet", secret: Buffer.from(wallet.secretKey.slice(0, 32)).toString("hex"), delay: 400 })};`;
  const bundled = await build({ entryPoints: [join(here, "fixtures/mock-wallet.ts")], bundle: true, write: false, format: "iife", platform: "browser", banner: { js: config } });
  script = bundled.outputFiles[0]!.text;
  page = page.replace("</head>", `<script src="/mock-wallet.js"></script></head>`);
  console.log(`mock wallet address (fund it on your devnet or local validator): ${wallet.publicKey.toBase58()}`);
}

createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://x").pathname;
  if (path === "/connect.html") return void response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(page);
  if (mock && path === "/mock-wallet.js") return void response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(script);
  response.writeHead(path === "/favicon.ico" ? 204 : 404).end();
}).listen(port, "127.0.0.1", () => console.log(`connect page: http://127.0.0.1:${port}/connect.html (this machine only)`));
