#!/usr/bin/env node
// Copies the woff2 files the system uses out of the @fontsource packages into
// ./fonts, with their licences, so that fonts.css can reference them by a
// plain relative URL. That is what lets the same stylesheet work from a
// bundler (Vite rewrites the URL), from an unpacked extension and from a
// file:// page with no build step.
//
//   node scripts/sync-fonts.mjs           copy
//   node scripts/sync-fonts.mjs --check   fail if the committed copies differ from upstream
//
// The six loch-tabular-*.woff2 files are not copied: they are built from
// Libre Franklin by scripts/build-tabular.py.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkg, "fonts");
const check = process.argv.includes("--check");

const sources = [
  ["@fontsource/old-standard-tt", "files/old-standard-tt-latin-400-normal.woff2"],
  ["@fontsource/old-standard-tt", "files/old-standard-tt-latin-400-italic.woff2"],
  ["@fontsource/old-standard-tt", "files/old-standard-tt-latin-ext-400-normal.woff2"],
  ["@fontsource/old-standard-tt", "files/old-standard-tt-latin-ext-400-italic.woff2"],
  ["@fontsource/old-standard-tt", "LICENSE", "OFL-old-standard-tt.txt"],
  ["@fontsource-variable/libre-franklin", "files/libre-franklin-latin-wght-normal.woff2"],
  ["@fontsource-variable/libre-franklin", "files/libre-franklin-latin-wght-italic.woff2"],
  ["@fontsource-variable/libre-franklin", "files/libre-franklin-latin-ext-wght-normal.woff2"],
  ["@fontsource-variable/libre-franklin", "files/libre-franklin-latin-ext-wght-italic.woff2"],
  ["@fontsource-variable/libre-franklin", "LICENSE", "OFL-libre-franklin.txt"],
];

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
mkdirSync(out, { recursive: true });

let failed = false;
for (const [dep, file, rename] of sources) {
  const from = join(pkg, "node_modules", dep, file);
  const to = join(out, rename ?? file.split("/").pop());
  if (!existsSync(from)) {
    console.error(`missing ${from}: run the workspace install first`);
    process.exit(1);
  }
  if (check) {
    if (!existsSync(to) || sha(from) !== sha(to)) {
      console.error(`differs from upstream: fonts/${to.split("/").pop()}`);
      failed = true;
    }
  } else {
    copyFileSync(from, to);
    console.log(`fonts/${to.split("/").pop()}  ${sha(to).slice(0, 12)}`);
  }
}
if (check) {
  if (failed) process.exit(1);
  console.log(`fonts: ${sources.length} files match upstream`);
}
