#!/usr/bin/env node
// Rasterises the mark for the places that cannot take SVG:
//   mark/icon-16.png, icon-32.png, icon-48.png, icon-128.png   extension icons: the mascot alone, transparent
//   mark/favicon.ico                                            the mark on its tile, 16, 32 and 48 in one file
// 16px is drawn from the small file of each (pixel-fitted, no eye); everything larger from the full one.
// Uses the Chromium that Playwright already has. No network. Output is committed.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "mark");
const uri = (file) => `data:image/svg+xml;base64,${readFileSync(join(dir, file)).toString("base64")}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 160, height: 160 }, deviceScaleFactor: 1 });
async function raster(file, size) {
  await page.setContent(
    `<body style="margin:0;background:transparent"><img src="${uri(file)}" width="${size}" height="${size}" style="display:block"></body>`,
  );
  await page.locator("img").evaluate((img) => img.decode());
  return page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
}
for (const size of [16, 32, 48, 128]) {
  const file = size < 24 ? "mascot-small.svg" : "mascot.svg";
  const icon = await raster(file, size);
  writeFileSync(join(dir, `icon-${size}.png`), icon);
  console.log(`mark/icon-${size}.png  ${icon.length} bytes  (${file})`);
}
const png = {};
for (const size of [16, 32, 48]) png[size] = await raster(size < 24 ? "mark-small.svg" : "mark.svg", size);
await browser.close();

// favicon.ico: an ICONDIR, one 16-byte entry per image, then the PNGs as they are.
const entries = [16, 32, 48];
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach((size, i) => {
  const at = 6 + 16 * i;
  header.writeUInt8(size, at);
  header.writeUInt8(size, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(png[size].length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += png[size].length;
});
writeFileSync(join(dir, "favicon.ico"), Buffer.concat([header, ...entries.map((s) => png[s])]));
console.log(`mark/favicon.ico  ${offset} bytes`);
