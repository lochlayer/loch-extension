#!/usr/bin/env node
// Takes the style guide's screenshots into docs/design/system/shots, from the
// filesystem, in headless Chromium. Every shot is taken the same way each
// time (animations finished, no caret), so two runs of the same guide give
// the same pixels and a change can be seen by comparing.
//
//   pnpm --filter @loch/design run shots            all of them
//   node scripts/shots.mjs --out /some/dir          somewhere else (to compare with)
//   node scripts/shots.mjs popup hero               only the shots whose name contains a word
//
// Needs `build` and `guide` first, and Playwright's Chromium. The six largest
// shots (the whole guide, and all the components) are then cut to a palette
// of 256 colours, which makes them a third of the size and changes nothing an
// eye can see; that step needs python3 with Pillow and is skipped without it.
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ICON_NAMES, SPRITE, icon } from "../dist/icons.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const system = join(pkg, "..", "..", "docs", "design", "system");
const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at >= 0 ? resolve(args[at + 1]) : join(system, "shots");
const wanted = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--out");
mkdirSync(out, { recursive: true });

const guide = pathToFileURL(join(system, "index.html")).href;
const popup = pathToFileURL(join(system, "popup.html")).href;

// Two sheets that are not in the guide: every icon six times its size on its 20px grid, beside
// itself at 1x from the sprite and as a self-contained drawing; and the 16px mark enlarged, on
// the dark and the light of a browser's toolbar.
const cache = join(pkg, "node_modules", ".cache", "loch-shots");
mkdirSync(cache, { recursive: true });
const sheet = (name, css, body) => {
  const file = join(cache, `${name}.html`);
  writeFileSync(file, `<!doctype html><html lang="en" data-theme="dusk"><head><meta charset="utf-8"><title>${name}</title><link rel="stylesheet" href="${pathToFileURL(join(pkg, "all.css")).href}"><style>${css}</style></head><body>${body}</body></html>\n`);
  return pathToFileURL(file).href;
};
const icons = sheet(
  "icons",
  `body{min-height:0;width:900px;height:560px;padding:16px;background:var(--water-60);overflow:hidden}
   ul{display:grid;grid-template-columns:repeat(6,120px);gap:16px 27.6px}
   li{display:grid;gap:10px;font-size:14px;font-weight:600;line-height:1}
   .big{width:120px;height:120px;background-image:linear-gradient(rgb(168 208 224 / .14) 1px,transparent 1px),linear-gradient(90deg,rgb(168 208 224 / .14) 1px,transparent 1px);background-size:6px 6px}
   .big>.icon{width:120px;height:120px}
   .small{display:flex;align-items:center;gap:11px;height:18px}
   .small>.icon{width:16px;height:16px}`,
  `${SPRITE}<ul>${ICON_NAMES.map((name) => `<li><span class="big">${icon(name)}</span><span class="small"><svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>${icon(name)}<span>${name}</span></span></li>`).join("")}</ul>`,
);
const png = pathToFileURL(join(pkg, "mark", "icon-16.png")).href;
const mark = sheet(
  "mark",
  `body{min-height:0;width:420px;height:210px;display:grid;grid-template-columns:210px 210px;background:#fff;overflow:hidden}
   div{position:relative}
   .dark{background:#202124}
   img{position:absolute;image-rendering:pixelated}`,
  `<div class="dark"><img src="${png}" width="192" height="192" alt="" style="left:9px;top:9px"></div>
   <div><img src="${png}" width="96" height="96" alt="" style="left:10px;top:18px"><img src="${png}" width="16" height="16" alt="" style="left:130px;top:30px"><img src="${png}" width="16" height="16" alt="" style="left:4px;top:180px"></div>`,
);

/** [file, url, { width, height, scale, full, selector }] */
const SHOTS = [
  ["components-comfortable.png", guide, { selector: "#specs" }],
  ["components-compact.png", `${guide}?density=compact`, { selector: "#specs" }],
  ["guide-dusk-1440.png", `${guide}?theme=dusk`, { full: true }],
  ["guide-dusk-390.png", `${guide}?theme=dusk`, { width: 390, full: true }],
  ["guide-night-1440.png", `${guide}?theme=night`, { full: true }],
  ["guide-night-390.png", `${guide}?theme=night`, { width: 390, full: true }],
  ["hero-dusk.png", `${guide}?theme=dusk`, {}],
  ["hero-night.png", `${guide}?theme=night`, {}],
  ["leak-report.png", guide, { selector: "#report" }],
  ["popup-frames.png", guide, { selector: ".g-popups" }],
  ["popup-home.png", `${popup}#home`, { width: 380, height: 600 }],
  ["popup-home@2x.png", `${popup}#home`, { width: 380, height: 600, scale: 2 }],
  ["popup-home-night.png", `${popup}#home-night`, { width: 380, height: 600 }],
  ["popup-proving.png", `${popup}#proving`, { width: 380, height: 600 }],
  ["popup-error.png", `${popup}#error`, { width: 380, height: 600 }],
  ["popup-empty.png", `${popup}#empty`, { width: 380, height: 600 }],
  ["popup-report-night.png", `${popup}#report-night`, { width: 380, height: 600 }],
  ["icons-6x.png", icons, { width: 900, height: 560 }],
  ["mark-16px.png", mark, { width: 420, height: 210 }],
];

const browser = await chromium.launch();
const errors = [];
let taken = 0;
for (const [file, url, options] of SHOTS) {
  if (wanted.length > 0 && !wanted.some((word) => file.includes(word))) continue;
  const { width = 1440, height = 900, scale = 1, full = false, selector = "" } = options;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: "dark", reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.on("console", (message) => message.type() === "error" && errors.push(`${file}: ${message.text()}`));
  page.on("pageerror", (error) => errors.push(`${file}: ${error}`));
  page.on("request", (request) => !/^(file|data):/.test(request.url()) && errors.push(`${file}: request to ${request.url()}`));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const shot = { path: join(out, file), animations: "disabled", caret: "hide" };
  if (selector) await page.locator(selector).first().screenshot(shot);
  else await page.screenshot({ ...shot, fullPage: full });
  await context.close();
  taken++;
  console.log(`  ${file}`);
}
await browser.close();

// The long ones, as a palette. No dithering: the tints are flat and stay flat.
const long = SHOTS.map(([file]) => file).filter((file) => /^(guide|components)-/.test(file) && (wanted.length === 0 || wanted.some((word) => file.includes(word))));
if (long.length > 0) {
  const script = "import sys\nfrom PIL import Image\nfor f in sys.argv[1:]:\n    Image.open(f).convert('RGB').quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE).save(f, optimize=True)\n";
  const done = spawnSync("python3", ["-c", script, ...long.map((file) => join(out, file))], { encoding: "utf8" });
  console.log(done.status === 0 ? `  ${long.length} long shots cut to 256 colours` : `  the long shots are left in full colour: python3 with Pillow is not here (${(done.stderr || String(done.error ?? "")).trim().split("\n").pop()})`);
}

console.log(`shots: ${taken} written to ${out}`);
if (errors.length > 0) {
  console.error(`shots: ${errors.length} problem(s)\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
