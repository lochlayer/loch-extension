import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
const read = (file: string) => readFileSync(SRC + file, "utf8");

/** Source with comments removed, so prose about Node or the DOM does not trip the checks. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

/** Every module specifier a file imports or re-exports from. */
const specifiers = (file: string) => [...code(file).matchAll(/\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|\bimport\s+"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? m[3]);

describe("the library stays browser-safe", () => {
  it("has source files to check", () => {
    expect(files).toEqual(expect.arrayContaining(["analyse.ts", "analysis.ts", "flows.ts", "index.ts", "preflight.ts", "rpc.ts"]));
  });

  it.each(files)("%s imports only relative modules or @solana/web3.js", (file) => {
    for (const specifier of specifiers(file)) {
      expect(specifier === "@solana/web3.js" || specifier?.startsWith("./"), `${file} imports ${specifier}`).toBe(true);
    }
  });

  it.each(files)("%s uses no Node or DOM-only globals, console output or network calls of its own", (file) => {
    // Usage patterns, not bare words: the finding texts legitimately say things like "sleep window".
    const forbidden = [
      /\b(?:process|window|document|console|navigator|localStorage|sessionStorage|globalThis|self)\s*(?:\.\s*[A-Za-z_$]|\[)/,
      /\b(?:require|fetch|importScripts|eval)\s*\(/,
      /\bnew\s+(?:XMLHttpRequest|WebSocket|Function|EventSource)\b/,
      /\bBuffer\b|\b__dirname\b|\b__filename\b/,
    ];
    const hits = forbidden.map((pattern) => code(file).match(pattern)?.[0]).filter(Boolean);
    expect(hits, `${file} uses ${hits.join(", ")}`).toEqual([]);
  });

  it("keeps @solana/web3.js out of the pure analysis entry point at runtime", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      // Type-only imports are erased by the compiler; only runtime imports count.
      const runtime = [...code(file).matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]!);
      for (const specifier of runtime) {
        expect(specifier.startsWith("./"), `${file} imports ${specifier} at runtime`).toBe(true);
        visit(specifier.slice(2).replace(/\.js$/, ".ts"));
      }
    };
    visit("analysis.ts");
    expect([...seen].sort()).toEqual(["analyse.ts", "analysis.ts", "flows.ts", "format.ts", "preflight.ts"]);
  });
});
