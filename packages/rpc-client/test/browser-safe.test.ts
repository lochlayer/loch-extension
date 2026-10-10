// The package must run in a page and in an extension service worker: Web
// Crypto and fetch only, no node: modules, no Node globals, no logging.
// Checked three ways: by reading the sources, by bundling them for the
// browser with their real dependencies, and by running that bundle in a
// context that has only the globals a service worker has.

import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { decodeRequest, encodeResponse } from "../src/bhttp.js";
import { KEM_X_WING, MEDIA_TYPE_RESPONSE, encodeKeyConfigList } from "../src/keyConfig.js";
import { decapsulateRequest, gatewayKeyConfig, generateGatewaySecretKey, importGatewayKey } from "../src/ohttp.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => file.replaceAll("\\", "/"))
  .sort();
const read = (file: string) => readFileSync(SRC + file, "utf8");

/** Source with comments removed, so prose about Node or fetch does not trip the checks. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** Every module specifier a file imports or re-exports from, with whether the import is type-only. */
function imports(file: string): { specifier: string; typeOnly: boolean }[] {
  const found: { specifier: string; typeOnly: boolean }[] = [];
  const source = code(file);
  for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s+"([^"]+)"/gm)) {
    found.push({ specifier: match[3]!, typeOnly: match[2] !== undefined });
  }
  for (const match of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)|^\s*import\s+"([^"]+)"/gm)) {
    found.push({ specifier: (match[1] ?? match[2])!, typeOnly: false });
  }
  return found;
}

/** Files and packages reachable at runtime from an entry point. */
function reach(entry: string): { files: string[]; packages: string[] } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { specifier, typeOnly } of imports(file)) {
      if (typeOnly) continue;
      if (specifier.startsWith(".")) visit(specifier.slice(2).replace(/\.js$/, ".ts"));
      else packages.add(specifier);
    }
  };
  visit(entry);
  return { files: [...seen].sort(), packages: [...packages].sort() };
}

const isNodeBuiltin = (specifier: string) => specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]!);
const HPKE = ["@hpke/chacha20poly1305", "@hpke/common", "@hpke/core", "@hpke/dhkem-x25519", "@hpke/hybridkem-x-wing"];

describe("sources", () => {
  it("finds the source files", () => {
    expect(files).toEqual([
      "bhttp.ts",
      "bytes.ts",
      "describe.ts",
      "directFetch.ts",
      "errors.ts",
      "http.ts",
      "index.ts",
      "keyConfig.ts",
      "ohttp.ts",
      "ohttpFetch.ts",
      "padding.ts",
      "protocol.ts",
      "web3.ts",
    ]);
  });

  it("the main and protocol entry points import the HPKE packages and nothing else", () => {
    const main = reach("index.ts");
    expect(main.packages).toEqual(HPKE);
    expect(main.files).not.toContain("web3.ts");
    const protocol = reach("protocol.ts");
    expect(protocol.packages).toEqual(HPKE);
    expect(protocol.files).not.toContain("web3.ts");
    expect(protocol.files).not.toContain("ohttpFetch.ts");
  });

  it("only the web3 entry point imports @solana/web3.js", () => {
    expect(reach("web3.ts").packages).toEqual(["@solana/web3.js"]);
    for (const file of files) {
      const specifiers = imports(file).map((entry) => entry.specifier);
      if (file !== "web3.ts") expect(specifiers, file).not.toContain("@solana/web3.js");
    }
  });

  it("no file imports a Node module or anything outside the agreed dependencies", () => {
    for (const file of files) {
      for (const { specifier } of imports(file)) {
        expect(isNodeBuiltin(specifier), `${file} imports ${specifier}`).toBe(false);
        expect(specifier.startsWith("./") || [...HPKE, "@solana/web3.js"].includes(specifier), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it.each(files)("%s uses no Node or DOM-only globals and does not log", (file) => {
    const forbidden = [
      /\b(?:process|window|document|console|navigator|localStorage|sessionStorage|indexedDB|globalThis|self)\s*(?:\.\s*[A-Za-z_$]|\[)/,
      /\b(?:require|importScripts|eval)\s*\(/,
      /\bnew\s+(?:XMLHttpRequest|WebSocket|Function|EventSource|Worker)\b/,
      /\bBuffer\b|\b__dirname\b|\b__filename\b/,
      /\bMath\.random\b/,
    ];
    const hits = forbidden.map((pattern) => code(file).match(pattern)?.[0]).filter(Boolean);
    expect(hits, `${file} uses ${hits.join(", ")}`).toEqual([]);
  });

  it("calls the global fetch in one place only: the default transport", () => {
    // A call of the global, not of a method or property named fetch.
    const globalFetch = /(?<![.\w])fetch\s*\(/g;
    expect(files.filter((file) => code(file).match(globalFetch))).toEqual(["http.ts"]);
    expect(code("http.ts").match(globalFetch)).toHaveLength(1);
  });

  it("bakes in no address to contact: the only URLs are an identifier and this machine's discard port", () => {
    const urls = files.flatMap((file) => [...code(file).matchAll(/\b(?:https?|wss?):\/\/[^\s"'`]+/g)].map((match) => `${file}: ${match[0]}`));
    expect(urls).toEqual(["ohttpFetch.ts: https://iana.org/assignments/http-problem-types#ohttp-key", "web3.ts: ws://127.0.0.1:9/"]);
  });

  it("takes randomness from crypto.getRandomValues only, and only for keys and nonces", () => {
    expect(files.filter((file) => /getRandomValues/.test(code(file)))).toEqual(["ohttp.ts"]);
  });

  it("keeps nothing: no storage API and no module-level record of requests", () => {
    for (const file of files) expect(code(file), file).not.toMatch(/\b(?:caches|cookieStore|indexedDB|localStorage|sessionStorage)\b/);
  });
});

describe("browser bundles", () => {
  const bundle = async (entry: string, format: "esm" | "iife" = "esm") => {
    const result = await build({
      entryPoints: [SRC + entry],
      bundle: true,
      platform: "browser",
      format,
      globalName: format === "iife" ? "LochRpcClient" : undefined,
      target: "es2022",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    return { inputs: Object.keys(result.metafile.inputs), text: result.outputFiles[0]!.text, errors: result.errors };
  };
  const fromPackage = (inputs: string[], name: string) => inputs.filter((input) => input.includes(`node_modules/${name}/`));
  const nodeImport = /from\s*"node:|require\("node:|from\s*"(?:fs|path|os|crypto|http|https|net|tls|worker_threads|buffer)"/;

  it.each(["index.ts", "protocol.ts"])("%s bundles for the browser without any Node builtin and without web3.js", async (entry) => {
    // esbuild fails the build if a module needs a Node builtin that has no browser replacement.
    const { inputs, text, errors } = await bundle(entry);
    expect(errors).toEqual([]);
    expect(text).not.toMatch(nodeImport);
    expect(fromPackage(inputs, "@solana/web3.js")).toEqual([]);
    expect(fromPackage(inputs, "@hpke/core").length).toBeGreaterThan(0);
    // X-Wing and the ML-KEM-768 under it are pure JavaScript and come along.
    expect(fromPackage(inputs, "@hpke/hybridkem-x-wing").length).toBeGreaterThan(0);
    expect(fromPackage(inputs, "mlkem").length).toBeGreaterThan(0);
    expect(inputs.some((input) => input.endsWith("src/web3.ts"))).toBe(false);
    // Small enough for an extension: the whole client with its cryptography.
    expect(text.length).toBeLessThan(400_000);
  });

  it("web3.ts bundles for the browser with the browser build of web3.js", async () => {
    const { inputs, text, errors } = await bundle("web3.ts");
    expect(errors).toEqual([]);
    expect(text).not.toMatch(nodeImport);
    expect(fromPackage(inputs, "@solana/web3.js")).toEqual([expect.stringContaining("index.browser.esm.js")]);
  }, 60_000);

  it("the bundle runs with only the globals of a service worker: no process, no Buffer, no require", async () => {
    const { text } = await bundle("index.ts", "iife");

    // The gateway lives out here; the bundle reaches it through the fetch it is given. It has an
    // X25519 key and an X-Wing key, listed in that order: the bundle must pick X-Wing by itself.
    const keys = [await importGatewayKey(3, generateGatewaySecretKey()), await importGatewayKey(4, generateGatewaySecretKey(), undefined, KEM_X_WING)];
    const seen: string[] = [];
    const transport = async (_url: string, init: { body: Uint8Array }) => {
      const decapsulated = await decapsulateRequest((keyId) => keys.find((key) => key.keyId === keyId), new Uint8Array(init.body));
      const request = decodeRequest(decapsulated.request);
      seen.push(`key ${decapsulated.keyId}: ${request.method} ${request.scheme}://${request.authority}${request.path} ${new TextDecoder().decode(request.content)}`);
      const sealed = await decapsulated.sealResponse(
        encodeResponse({ status: 200, headers: [["content-type", "application/json"]], content: new TextEncoder().encode('{"result":7}') }),
      );
      return new Response(sealed as Uint8Array<ArrayBuffer>, { status: 200, headers: { "content-type": MEDIA_TYPE_RESPONSE } });
    };

    const context = vm.createContext({
      crypto: globalThis.crypto,
      fetch: () => Promise.reject(new Error("the global fetch must not be used when a transport is given")),
      Response,
      Request,
      Headers,
      URL,
      URLSearchParams,
      Blob,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      // What the test passes in.
      transport,
      keyConfig: Array.from(encodeKeyConfigList(keys.map(gatewayKeyConfig))),
    });
    expect(vm.runInContext("typeof process + typeof Buffer + typeof require + typeof module", context)).toBe("undefinedundefinedundefinedundefined");
    vm.runInContext(text, context);
    const outcome = (await vm.runInContext(
      `(async () => {
        const ohttpFetch = LochRpcClient.createOhttpFetch({ relayUrl: "https://relay.example/", keyConfig: new Uint8Array(keyConfig), fetch: transport });
        const response = await ohttpFetch("https://rpc.loch.example/", { method: "POST", headers: { "content-type": "application/json" }, body: '{"method":"getSlot"}' });
        return JSON.stringify({ status: response.status, body: await response.json(), exports: Object.keys(LochRpcClient).sort() });
      })()`,
      context,
    )) as string;
    expect(JSON.parse(outcome)).toEqual({
      status: 200,
      body: { result: 7 },
      exports: ["DEFAULT_FORWARD_HEADERS", "DEFAULT_REQUEST_PADDING_BUCKETS", "RpcClientError", "createDirectFetch", "createOhttpFetch", "describeKeyConfigs"],
    });
    expect(seen).toEqual(['key 4: POST https://rpc.loch.example/ {"method":"getSlot"}']);
  }, 60_000);
});
