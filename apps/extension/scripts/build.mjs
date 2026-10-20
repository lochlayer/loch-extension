#!/usr/bin/env node
// Builds the loadable extension into apps/extension/dist.
//
//   node scripts/build.mjs            production build
//   node scripts/build.mjs --dev      unminified, with source maps
//   node scripts/build.mjs --connect-url https://connect.example.org/
//                                     a release build: the connect page is compiled in as a
//                                     constant, the setting is gone, and nothing stored can
//                                     move it. (Or set LOCH_CONNECT_URL.) Without it the
//                                     connect page is a setting, for development.
//
// Steps:
//   1. Check the prover artifacts against circuits/artifacts/devnet/manifest.json and, for the
//      depth proof, circuits/artifacts/devnet/depth/manifest.json (sha256 and size).
//      A mismatch stops the build: the extension would produce proofs the program refuses.
//   2. Build the extension pages (app.html, offscreen.html) and the service worker as ES modules.
//   3. Build the content script and the page script as single classic scripts (IIFE): content
//      scripts cannot be modules.
//   4. Copy the artifacts, the icons, the fonts and stylesheet of the in-page dialog, and write
//      manifest.json.
//
// Nothing is fetched from the network and nothing remote is referenced by the output.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";
import { build } from "vite";

import { manifest } from "./manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repo = resolve(root, "../..");
const src = join(root, "src");
if (![undefined, "0", "1"].includes(process.env.LOCH_MAINNET_TESTING)) throw new Error("build: LOCH_MAINNET_TESTING must be 0 or 1");
const mainnetTesting = process.env.LOCH_MAINNET_TESTING === "1";
const out = join(root, process.argv.includes("--stories") ? "dist-stories" : mainnetTesting ? "dist-mainnet" : "dist");
const dev = process.argv.includes("--dev");
// --stories builds the interface alone, with fixture data, as a plain web page for screenshots
// and design review. It goes to dist-stories and is never part of the extension.
const stories = process.argv.includes("--stories");
const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------- 1. artifacts
const artifactsDir = join(repo, "circuits/artifacts/devnet");
const artifactManifest = JSON.parse(readFileSync(join(artifactsDir, "manifest.json"), "utf8"));
// The transaction circuit's files, and the depth proof's (circuits/artifacts/devnet/depth, its own
// manifest). Each is checked against the manifest next to it, and all of them land side by side
// in prover/: the names differ.
const ARTIFACT_SETS = [
  { dir: artifactsDir, manifest: artifactManifest, files: ["transaction.wasm", "transaction_final.zkey"] },
  { dir: join(artifactsDir, "depth"), manifest: JSON.parse(readFileSync(join(artifactsDir, "depth", "manifest.json"), "utf8")), files: ["depth.wasm", "depth_final.zkey"] },
];
const ARTIFACT_FILES = ARTIFACT_SETS.flatMap((set) => set.files);
const artifacts = {};
for (const set of ARTIFACT_SETS) {
  for (const name of set.files) {
    const expected = set.manifest.files?.[name];
    if (!expected) throw new Error(`build: ${name} is not listed in ${relative(repo, join(set.dir, "manifest.json"))}`);
    const bytes = readFileSync(join(set.dir, name));
    const actual = sha256(bytes);
    if (actual !== expected.sha256 || bytes.length !== expected.bytes) {
      throw new Error(
        `build: ${name} does not match the manifest (sha256 ${actual}, ${bytes.length} bytes; expected ${expected.sha256}, ${expected.bytes} bytes). Refusing to build.`,
      );
    }
    artifacts[name] = { sha256: actual, bytes: bytes.length };
  }
}
// The connect page, when this build fixes it. It is where the wallet is asked for the signature
// that is the key to the shielded balance, so the rules are those of the setting
// (src/background/settings.ts, checkConnectUrl), applied here so that a bad value stops the build.
function fixedConnectUrl() {
  const at = process.argv.indexOf("--connect-url");
  const given = at >= 0 ? process.argv[at + 1] : process.env.LOCH_CONNECT_URL;
  if (given === undefined || given === "") {
    if (at >= 0) throw new Error("build: --connect-url needs an address");
    return null;
  }
  let url;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`build: the connect URL is not a web address: ${given}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("build: the connect URL must be https (plain http only for this machine)");
  if (url.username !== "" || url.password !== "") throw new Error("build: the connect URL must not carry a user name or password");
  if (url.search !== "" || url.hash !== "") throw new Error("build: the connect URL is one exact address: no query, no fragment");
  return url.href;
}

// The RPC endpoint, the relayer and the screening service a new installation starts with, when this
// build names them (LOCH_RPC_URL, LOCH_RELAYER_URL, LOCH_SCREENER_URL). They stay settings: the user
// can point any of them elsewhere. Without them the RPC endpoint is the cluster's public one and the
// two services are the ports of the development services on this machine. An RPC address that carries
// a provider's key has a path and is refused here: a key in a package is a key given to everyone.
function defaultEndpoint(name) {
  const given = process.env[name];
  if (given === undefined || given === "") return null;
  let url;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`build: ${name} is not a web address: ${given}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`build: ${name} must be https (plain http only for this machine)`);
  if (url.username !== "" || url.password !== "") throw new Error(`build: ${name} must not carry a user name or password`);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new Error(`build: ${name} is a service's origin: no path, no query, no fragment`);
  return url.origin;
}

const buildInfo = {
  version: pkg.version,
  artifacts,
  network: mainnetTesting ? "mainnet-beta" : artifactManifest.network,
  mainnetTesting,
  setup: artifactManifest.setup?.kind ?? "unknown",
  circuit: artifactManifest.circuit?.main ?? "unknown",
  connectUrl: fixedConnectUrl(),
  rpcUrl: defaultEndpoint("LOCH_RPC_URL"),
  relayerUrl: defaultEndpoint("LOCH_RELAYER_URL"),
  screenerUrl: defaultEndpoint("LOCH_SCREENER_URL"),
};

// -------------------------------------------------------------------- 2. pages
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const shared = {
  configFile: false,
  root: src,
  logLevel: "warn",
  define: {
    __LOCH_BUILD__: JSON.stringify(buildInfo),
  },
  resolve: {
    // One copy of each, whatever a dependency asks for.
    dedupe: ["@solana/web3.js", "@noble/curves", "@noble/hashes", "preact"],
  },
};

await build({
  ...shared,
  base: stories ? "./" : "/",
  build: {
    outDir: out,
    emptyOutDir: false,
    target: "chrome116",
    minify: !dev,
    sourcemap: dev,
    assetsInlineLimit: 0,
    modulePreload: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      input: stories
        ? { stories: join(src, "stories.html") }
        : {
            app: join(src, "app.html"),
            offscreen: join(src, "offscreen.html"),
            background: join(src, "background/index.ts"),
          },
      output: {
        format: "es",
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

const design = dirname(require.resolve("@loch/design/package.json"));
mkdirSync(join(out, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128]) cpSync(join(design, `mark/icon-${size}.png`), join(out, `icons/icon-${size}.png`));
cpSync(join(design, "mark/mascot.svg"), join(out, "icons/mascot.svg"));

if (stories) {
  console.log(`\nLoch interface stories -> ${relative(process.cwd(), out)} (not the extension)`);
  process.exit(0);
}

// ------------------------------------------------- 3. content and page scripts
for (const [name, entry] of [
  ["content", "content/index.ts"],
  ["inpage", "inpage/index.ts"],
]) {
  await build({
    ...shared,
    build: {
      outDir: out,
      emptyOutDir: false,
      target: "chrome116",
      minify: !dev,
      sourcemap: false,
      lib: { entry: join(src, entry), formats: ["iife"], name: `loch_${name}`, fileName: () => `${name}.js` },
    },
  });
}

// ------------------------------------------------------------------ 4. statics
mkdirSync(join(out, "prover"), { recursive: true });
for (const set of ARTIFACT_SETS) for (const name of set.files) cpSync(join(set.dir, name), join(out, "prover", name));

// The in-page dialog (leak warnings, the key-derivation guard) is drawn by the content script
// inside a closed shadow root. It uses the design system's own CSS, rewritten for a shadow root:
// tokens move from :root to :host, and rem becomes px so a page's root font size cannot scale it.
// The content script asks the service worker for this file and the two font files when it first
// needs them, so nothing here has to be web-accessible.
const dialogSource = ["tokens.css", "base.css", "components.css"].map((file) => readFileSync(join(design, file), "utf8")).join("\n");
const dialogExtra = readFileSync(join(src, "content/dialog.css"), "utf8");
const dialogCss = (dialogSource + "\n" + dialogExtra)
  .replace(/:root\b/g, ":host")
  .replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${Math.round(Number(n) * 16 * 1000) / 1000}px`);
const minified = await transform(dialogCss, { loader: "css", minify: !dev });
writeFileSync(join(out, "dialog.css"), minified.code);
mkdirSync(join(out, "fonts"), { recursive: true });
for (const file of ["libre-franklin-latin-wght-normal.woff2", "libre-franklin-latin-wght-italic.woff2", "OFL-libre-franklin.txt", "OFL-old-standard-tt.txt"]) {
  cpSync(join(design, "fonts", file), join(out, "fonts", file));
}


// The licences of what is bundled, read from the packages themselves.
const bundled = ["@solana/web3.js", "snarkjs", "ffjavascript", "wasmcurves", "circom_runtime", "fastfile", "preact", "@noble/curves", "@noble/hashes", "@noble/ciphers", "@scure/base", "poseidon-lite", "bn.js", "buffer", "borsh", "bs58", "@hpke/core", "@hpke/dhkem-x25519", "@hpke/chacha20poly1305"];
const licences = ["Loch extension: third-party software in this package", ""];
const roots = [root, ...["@loch/sdk", "@loch/rpc-client", "@loch/scanner-core"].map((name) => dirname(require.resolve(`${name}/package.json`)))];
for (const name of bundled) {
  for (const from of roots) {
    try {
      let dir = dirname(createRequire(join(from, "package.json")).resolve(name));
      while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== name) {
        const parent = dirname(dir);
        if (parent === dir) throw new Error("no package.json");
        dir = parent;
      }
      const manifestOf = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      licences.push(`${manifestOf.name} ${manifestOf.version}: ${typeof manifestOf.license === "string" ? manifestOf.license : "see the package"}`);
      break;
    } catch {
      // Not reachable from here; try the next place.
    }
  }
}
licences.push("", "Fonts: Old Standard TT and Libre Franklin (and Loch Tabular, derived from it), SIL Open Font License 1.1.", "See fonts/OFL-old-standard-tt.txt and fonts/OFL-libre-franklin.txt.", "", "snarkjs and its companions are GPL-3.0. The extension's own source is in the Loch repository.");
writeFileSync(join(out, "licences.txt"), licences.join("\n") + "\n");

writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest({ version: pkg.version, mainnetTesting, hosts: [buildInfo.rpcUrl, buildInfo.relayerUrl, buildInfo.screenerUrl].filter(Boolean) }), null, 2) + "\n");
writeFileSync(join(out, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n");

// ------------------------------------------------------------------- 5. checks
// No remote reference may survive in what the browser executes or styles with.
const offenders = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(html|css)$/.test(name)) {
      const text = readFileSync(path, "utf8");
      const remote = text.match(/(?:src|href)=["']https?:\/\/[^"']+|url\(\s*["']?https?:\/\/[^)]+|@import\s+["']https?:/g);
      if (remote) offenders.push(`${relative(out, path)}: ${remote.join(", ")}`);
    }
  }
};
walk(out);
if (offenders.length > 0) throw new Error(`build: remote references in the output:\n  ${offenders.join("\n  ")}`);
for (const required of ["manifest.json", "background.js", "content.js", "inpage.js", "app.html", "offscreen.html", "dialog.css"]) {
  if (!existsSync(join(out, required))) throw new Error(`build: ${required} is missing from the output`);
}

// ------------------------------------------------------------------- 6. report
const sizes = [];
const measure = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) measure(path);
    else sizes.push([relative(out, path), statSync(path).size]);
  }
};
measure(out);
sizes.sort((a, b) => a[0].localeCompare(b[0]));
const kb = (n) => `${(n / 1024).toFixed(1)} kB`.padStart(11);
console.log(`\nLoch extension ${pkg.version} -> ${relative(process.cwd(), out) || "."}`);
for (const [file, size] of sizes) console.log(`${kb(size)}  ${file}`);
console.log(`${kb(sizes.reduce((sum, [, size]) => sum + size, 0))}  total`);
console.log(`prover artifacts checked against the manifest: ${ARTIFACT_FILES.map((name) => `${name} ${artifacts[name].sha256.slice(0, 12)}`).join(", ")}`);
if (buildInfo.rpcUrl) console.log(`default RPC endpoint in this build: ${buildInfo.rpcUrl}`);
if (buildInfo.relayerUrl || buildInfo.screenerUrl) console.log(`default services in this build: relayer ${buildInfo.relayerUrl ?? "(this machine)"}, screener ${buildInfo.screenerUrl ?? "(this machine)"}`);
console.log(buildInfo.connectUrl ? `connect page fixed in this build: ${buildInfo.connectUrl}` : "connect page: a setting (development build). A release build fixes it with --connect-url.");
