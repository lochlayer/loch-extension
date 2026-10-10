#!/usr/bin/env node
// Screenshots of every screen and state, in both palettes, from the stories build.
//
//   node scripts/shots.mjs [story ...] [--out shots] [--only dusk|night] [--no-wide]
//
// Each popup story is captured at exactly 380 x 600; the expanded view at 1280 wide. While it
// is there it also checks what a screenshot cannot show at a glance: nothing may overflow the
// popup sideways, and the page may make no network request at all.

import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const outDir = resolve(root, option("out", "shots"));
const only = option("only", null);
const wanted = args.filter((arg, index) => !arg.startsWith("--") && !["--out", "--only"].includes(args[index - 1]));

if (!args.includes("--no-build")) {
  const built = spawnSync(process.execPath, [join(here, "build.mjs"), "--stories"], { stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

// Module scripts do not load from file://, so the stories are served from this machine only,
// on a port the system picks, for as long as this script runs.
const storiesDir = join(root, "dist-stories");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  try {
    const body = readFileSync(join(storiesDir, path));
    response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const page = `${origin}/stories.html`;
const WIDE = ["welcome", "home", "report", "settings", "send-proving", "send-failed", "home-empty", "locked", "dive-form"];

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const problems = [];
let count = 0;

async function shoot(story, theme, view) {
  const viewport = view === "popup" ? { width: 380, height: 600 } : { width: 1280, height: 800 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
  const tab = await context.newPage();
  const requests = [];
  tab.on("request", (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith("data:")) requests.push(request.url());
  });
  tab.on("pageerror", (error) => problems.push(`${story} ${theme} ${view}: ${error.message}`));
  tab.on("console", (message) => {
    if (message.type() === "error") problems.push(`${story} ${theme} ${view}: console: ${message.text()}`);
  });
  await tab.goto(`${page}?story=${story}&theme=${theme}&view=${view}`);
  await tab.waitForSelector("html[data-ready='true']", { timeout: 10_000 });
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForTimeout(150);
  const overflow = await tab.evaluate((width) => {
    const out = [];
    if (document.documentElement.scrollWidth > width) out.push(`document is ${document.documentElement.scrollWidth}px wide`);
    for (const node of document.querySelectorAll("body *")) {
      if (node.closest("svg") || node.closest("[hidden]")) continue;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") continue;
      if (node.classList.contains("visually-hidden")) continue;
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > width + 0.5 || box.left < -0.5) out.push(`${node.tagName.toLowerCase()}.${node.className} spans ${Math.round(box.left)}..${Math.round(box.right)}`);
      // Text cut off inside its own box, where the box is not meant to scroll or to end in an ellipsis.
      if (node.scrollWidth > node.clientWidth + 1 && style.overflowX === "visible" && node.children.length === 0) out.push(`${node.tagName.toLowerCase()}.${node.className} text overflows its box`);
    }
    return out.slice(0, 6);
  }, viewport.width);
  for (const item of overflow) problems.push(`${story} ${theme} ${view}: overflow: ${item}`);
  for (const url of requests) problems.push(`${story} ${theme} ${view}: network request: ${url}`);
  const file = join(outDir, view === "popup" ? `${story}-${theme}.png` : `wide-${story}-${theme}.png`);
  await tab.screenshot({ path: file, fullPage: view !== "popup" });
  count++;
  await context.close();
}

const probe = await browser.newPage();
await probe.goto(page);
const all = await probe.evaluate(() => window.__stories);
await probe.close();
const stories = wanted.length > 0 ? all.filter((name) => wanted.includes(name)) : all;
const themes = only ? [only] : ["dusk", "night"];

for (const story of stories) {
  for (const theme of themes) {
    await shoot(story, theme, "popup");
    if (!args.includes("--no-wide") && WIDE.includes(story)) await shoot(story, theme, "wide");
  }
}
await browser.close();
server.close();

console.log(`${count} screenshots in ${outDir}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
