#!/usr/bin/env node
// Contact sheets of the screenshots, six popups to a sheet, for looking at many at once.
//
//   node scripts/contact.mjs <shots dir> <out dir> [filter]

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

const [dir, out, filter = ""] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: contact.mjs <shots dir> <out dir> [filter]");
  process.exit(1);
}
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".png") && !name.startsWith("wide-") && !name.startsWith("e2e-") && name.includes(filter))
  .sort();
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1290 } });
for (let i = 0; i < files.length; i += 6) {
  const group = files.slice(i, i + 6);
  const cells = group
    .map((name) => `<figure><img src="data:image/png;base64,${readFileSync(join(dir, name)).toString("base64")}"><figcaption>${name.replace(".png", "")}</figcaption></figure>`)
    .join("");
  const html = `<!doctype html><style>body{margin:0;background:#3a3f44;font:13px sans-serif;color:#fff}main{display:grid;grid-template-columns:repeat(3,380px);gap:8px 14px;padding:8px}figure{margin:0}img{display:block;width:380px;height:600px}figcaption{padding:2px 0 4px}</style><main>${cells}</main>`;
  await page.setContent(html);
  const file = resolve(out, `sheet-${String(i / 6 + 1).padStart(2, "0")}.png`);
  await page.screenshot({ path: file });
  writeFileSync(file.replace(".png", ".txt"), group.join("\n"));
}
await browser.close();
console.log(`${Math.ceil(files.length / 6)} sheets in ${out}`);
