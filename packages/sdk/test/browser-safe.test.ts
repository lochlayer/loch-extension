// The main and wire entry points must run in a browser and in an extension
// service worker: no node: modules, no Node globals, no network calls of
// their own. Checked twice: by reading the sources, and by bundling them for
// the browser with their real dependencies.

import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => file.replaceAll("\\", "/"));
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
      if (specifier.startsWith(".")) {
        const base = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
        visit(new URL(specifier.replace(/\.js$/, ".ts"), `file:///${base}`).pathname.slice(1));
      } else {
        packages.add(specifier);
      }
    }
  };
  visit(entry);
  return { files: [...seen].sort(), packages: [...packages].sort() };
}

const isNodeBuiltin = (specifier: string) => specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]!);

describe("sources", () => {
  it("finds the source files", () => {
    expect(files).toEqual(expect.arrayContaining(["index.ts", "wire.ts", "node.ts", "wire/client.ts", "prover.ts"]));
  });

  it("the main entry point imports no Node module and only the agreed dependencies", () => {
    const { files: reached, packages } = reach("index.ts");
    expect(reached).not.toContain("node.ts");
    expect(packages.filter(isNodeBuiltin)).toEqual([]);
    expect(packages).toEqual([
      "@noble/ciphers/chacha",
      "@noble/curves/ed25519",
      "@noble/hashes/hkdf",
      "@noble/hashes/sha2",
      "@scure/base",
      "@solana/web3.js",
      "poseidon-lite/poseidon1",
      "poseidon-lite/poseidon2",
      "poseidon-lite/poseidon3",
      "snarkjs",
    ]);
    // Everything except the filesystem helper and the checking-only entry point is part of the main entry point.
    expect(files.filter((file) => !reached.includes(file))).toEqual(["node.ts", "snarkjs.d.ts", "verify.ts"]);
  });

  it("the verify entry point imports no Node module, no prover and nothing that builds a transaction", () => {
    const { files: reached, packages } = reach("verify.ts");
    expect(packages.filter(isNodeBuiltin)).toEqual([]);
    expect(packages).not.toContain("snarkjs");
    for (const heavy of ["prover.ts", "snarkjsShim.ts", "transact.ts", "node.ts", "wire.ts"]) {
      expect(reached, heavy).not.toContain(heavy);
    }
  });

  it("the wire entry point imports no Node module, no prover and no Poseidon", () => {
    const { files: reached, packages } = reach("wire.ts");
    expect(packages.filter(isNodeBuiltin)).toEqual([]);
    expect(packages).toEqual(["@noble/curves/ed25519", "@noble/hashes/sha2", "@scure/base", "@solana/web3.js"]);
    for (const heavy of ["prover.ts", "transact.ts", "note.ts", "merkle.ts", "keys.ts", "sync.ts", "wallet.ts", "node.ts"]) {
      expect(reached, heavy).not.toContain(heavy);
    }
  });

  it("only node.ts imports Node modules", () => {
    for (const file of files) {
      const builtins = imports(file).map((entry) => entry.specifier).filter(isNodeBuiltin);
      if (file === "node.ts") expect(builtins.length).toBeGreaterThan(0);
      else expect(builtins, file).toEqual([]);
    }
  });

  it.each(files.filter((file) => file !== "node.ts" && !file.endsWith(".d.ts")))(
    "%s uses no Node or DOM-only globals and does not log",
    (file) => {
      const forbidden = [
        /\b(?:process|window|document|console|navigator|localStorage|sessionStorage|self)\s*(?:\.\s*[A-Za-z_$]|\[)/,
        /\b(?:require|importScripts|eval)\s*\(/,
        /\bnew\s+(?:XMLHttpRequest|WebSocket|Function|EventSource|Worker)\b/,
        /\bBuffer\b|\b__dirname\b|\b__filename\b/,
        /\bMath\.random\b/,
      ];
      const hits = forbidden.map((pattern) => code(file).match(pattern)?.[0]).filter(Boolean);
      expect(hits, `${file} uses ${hits.join(", ")}`).toEqual([]);
    },
  );

  it("makes no network call of its own: fetch appears only as the wire clients' default transport", () => {
    // A call of the global, not of a method or property named fetch.
    const globalFetch = /(?<![.\w])fetch\s*\(/g;
    const callers = files.filter((file) => code(file).match(globalFetch));
    expect(callers).toEqual(["wire/client.ts"]);
    expect(code("wire/client.ts").match(globalFetch)).toHaveLength(1);
    // No URLs to anywhere are baked in.
    for (const file of files) expect(code(file), file).not.toMatch(/https?:\/\/[a-z0-9]/i);
  });

  it("loads the service-worker stand-in before snarkjs and removes it afterwards", () => {
    const prover = code("prover.ts");
    const standIn = prover.indexOf('from "./snarkjsShim.js"');
    const snarkjs = prover.indexOf('from "snarkjs"');
    expect(standIn).toBeGreaterThan(-1);
    expect(snarkjs).toBeGreaterThan(standIn);
    expect(prover).toMatch(/^removeCreateObjectUrlStandIn\(\);$/m);
    // snarkjs is imported by this one module only.
    expect(files.filter((file) => imports(file).some((entry) => entry.specifier === "snarkjs"))).toEqual(["prover.ts"]);
  });

  it("takes randomness from crypto.getRandomValues only", () => {
    const users = files.filter((file) => /getRandomValues/.test(code(file)));
    expect(users).toEqual(["bytes.ts"]);
  });
});

describe("browser bundles", () => {
  const bundle = async (entry: string) => {
    const result = await build({
      entryPoints: [SRC + entry],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    const text = result.outputFiles[0]!.text;
    return { inputs, text, errors: result.errors, warnings: result.warnings };
  };
  const fromPackage = (inputs: string[], name: string) => inputs.filter((input) => input.includes(`node_modules/${name}/`));

  it("the main entry point bundles for the browser without any Node builtin", async () => {
    // esbuild fails the build if a module needs a Node builtin that has no browser replacement.
    const { inputs, text, errors } = await bundle("index.ts");
    expect(errors).toEqual([]);
    expect(text).not.toMatch(/from\s*"node:|require\("node:|from\s*"(?:fs|path|os|crypto|worker_threads)"/);
    // The browser builds are the ones that got bundled.
    expect(fromPackage(inputs, "snarkjs")).toEqual([expect.stringContaining("build/browser.esm.js")]);
    expect(fromPackage(inputs, "ffjavascript")).toEqual([expect.stringContaining("build/browser.esm.js")]);
    expect(fromPackage(inputs, "@solana/web3.js")).toEqual([expect.stringContaining("index.browser.esm.js")]);
    expect(fromPackage(inputs, "poseidon-lite").length).toBeGreaterThan(0);
    expect(inputs.some((input) => input.endsWith("src/node.ts"))).toBe(false);
  }, 120_000);

  it("a consumer that does not prove does not get snarkjs (tree-shaking works)", async () => {
    const result = await build({
      stdin: {
        contents: `import { syncWallet, deriveKeys, prepareTransfer, RelayerClient } from "./index.ts"; console.log(syncWallet, deriveKeys, prepareTransfer, RelayerClient);`,
        resolveDir: SRC,
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    // What ended up in the output, as opposed to what was parsed.
    const emitted = Object.entries(Object.values(result.metafile.outputs)[0]!.inputs)
      .filter(([, info]) => info.bytesInOutput > 0)
      .map(([input]) => input);
    expect(fromPackage(emitted, "snarkjs")).toEqual([]);
    expect(fromPackage(emitted, "ffjavascript")).toEqual([]);
    expect(emitted.some((input) => input.endsWith("src/prover.ts") || input.endsWith("src/snarkjsShim.ts"))).toBe(false);
    expect(fromPackage(emitted, "poseidon-lite").length).toBeGreaterThan(0);
    expect(emitted.some((input) => input.endsWith("src/sync.ts"))).toBe(true);
  }, 120_000);

  it("the wire entry point bundles without the prover, Poseidon or the note cipher", async () => {
    const { inputs, text, errors } = await bundle("wire.ts");
    expect(errors).toEqual([]);
    expect(text).not.toMatch(/from\s*"node:|require\("node:/);
    for (const heavy of ["snarkjs", "ffjavascript", "circom_runtime", "poseidon-lite", "@noble/ciphers", "wasmcurves"]) {
      expect(fromPackage(inputs, heavy), heavy).toEqual([]);
    }
    for (const file of ["prover.ts", "transact.ts", "merkle.ts", "note.ts", "node.ts"]) {
      expect(inputs.some((input) => input.endsWith(`src/${file}`)), file).toBe(false);
    }
  }, 120_000);
});
