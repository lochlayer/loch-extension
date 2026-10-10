import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
  Builds a throwaway app that consumes the package exactly as the website and
  the extension will: by its name, through the exports map, with Vite. The app
  lives under node_modules/.cache so nothing is left in the tree.
*/
const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(pkg, "node_modules", ".cache", "loch-vite-fixture");
const out = join(app, "dist");

let css = "";
let js = "";
let files: string[] = [];

beforeAll(async () => {
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, "node_modules", "@loch"), { recursive: true });
  symlinkSync(pkg, join(app, "node_modules", "@loch", "design"), "dir");
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "loch-vite-fixture", private: true, type: "module" }));
  writeFileSync(join(app, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fixture</title></head><body><div id="app"></div><script type="module" src="./main.js"></script></body></html>`);
  writeFileSync(
    join(app, "main.js"),
    `import "@loch/design/all.css";
import { steppedBedSvg, statementHtml } from "@loch/design/charts";
import { formatSol } from "@loch/design/numerals";
import { icon } from "@loch/design/icons";
import sprite from "@loch/design/icons/sprite.svg";
import dive from "@loch/design/icons/dive.svg";
import mark from "@loch/design/mark/mark.svg";
import icon128 from "@loch/design/mark/icon-128.png";
const report = { address: "Fh3qJ5iBgbd24itfu7gbvo8XVHLjnNhA6aNEPnnNTz8K", score: 80, findings: [{ id: "funding-source", severity: "high", title: "Funding source is public", detail: "", penalty: 20 }] };
document.getElementById("app").innerHTML = steppedBedSvg(report) + statementHtml(report) + icon("dive") + formatSol(12480739112n).text + [sprite, dive, mark, icon128].join(" ");
`,
  );
  await build({ root: app, logLevel: "silent", configFile: false, build: { outDir: out, emptyOutDir: true, minify: false } });
  files = readdirSync(join(out, "assets"));
  css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(out, "assets", f), "utf8")).join("\n");
  js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, "assets", f), "utf8")).join("\n");
}, 120_000);

afterAll(() => rmSync(app, { recursive: true, force: true }));

describe("consumed through Vite by package name", () => {
  it("bundles all four stylesheets from all.css", () => {
    expect(css).toContain("--pigment-buff");
    expect(css).toContain('font-family: "Old Standard TT"');
    expect(css).toContain(".is-shielded");
    expect(css).toContain(".caution-band");
    expect(css).toContain("@layer loch.tokens");
  });

  it("ships every font from inside the package, as a file or inlined", () => {
    for (const name of ["old-standard-tt-latin-400-normal", "old-standard-tt-latin-400-italic", "libre-franklin-latin-wght-normal", "libre-franklin-latin-wght-italic"]) {
      expect(files.some((f) => f.startsWith(name) && f.endsWith(".woff2")), name).toBe(true);
    }
    // The six Loch Tabular files are under Vite's inline limit, so they arrive as data: URIs.
    const fontUrls = [...css.matchAll(/url\(([^)]+)\)\s*format\("woff2"\)/g)].map((m) => m[1]!.replace(/["']/g, ""));
    expect(fontUrls).toHaveLength(14);
    for (const url of fontUrls) expect(url.startsWith("data:font/woff2") || /^\/assets\/[\w-]+\.woff2$/.test(url), url).toBe(true);
  });

  it("makes no reference to any other host", () => {
    const remote = /https?:\/\/(?!www\.w3\.org\/(2000\/svg|1999\/xlink))/;
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(remote);
    expect(js.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(remote);
  });

  it("resolves the chart helpers, numerals and icons through the exports map", () => {
    expect(js).toContain("drawn as a stepped bed");
    expect(js).toContain("statement__row");
    expect(js).toContain("LAMPORTS_PER_SOL");
    expect(js).toContain("stroke-linecap");
  });

  it("resolves the sprite, a single icon and the mark as assets", () => {
    expect(js).toMatch(/sprite[\w-]*\.svg|data:image\/svg\+xml/);
    expect(js).toMatch(/mark[\w-]*\.svg|data:image\/svg\+xml/);
    expect(files.some((f) => /^icon-128[\w-]*\.png$/.test(f)) || js.includes("data:image/png")).toBe(true);
  });
});
