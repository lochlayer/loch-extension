#!/usr/bin/env node
// Opens the style guide and the popup from the filesystem in headless Chromium
// and checks what a reviewer would otherwise have to check by hand:
//
//   1. no console errors, no failed requests
//   2. no request to anything that is not a file:// URL (or data:)
//   3. the three font families actually loaded, from this package
//   4. no horizontal overflow at 1440, 768 and 390px, in both palettes
//   5. every interactive element shows a focus ring when it is focused from
//      the keyboard, in both palettes, with at least 3:1 against its ground
//   6. with reduced motion, no animation is left running and no transition
//      takes time
//   7. the popup fits 380 x 600 with nothing scrolling sideways
//   8. every region that scrolls sideways can be reached from the keyboard
//   9. a stepped figure shows exactly one drawing, the widest that fits, at
//      every width from 320 to 1440
//  10. under a Content-Security-Policy with no 'unsafe-inline', a page built
//      from the helpers' output and the sprite is refused nothing and is laid
//      out exactly as it is without the policy
//  11. on a real extension page, where Chrome adds a stylesheet of its own
//      that sets the body font, the body is still set in the system's face
//
//   pnpm --filter @loch/design run verify
import { chromium } from "playwright";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { byHourSvg, counterpartiesSvg, fitHtml, statementHtml, steppedBedSvg } from "../dist/charts/index.js";
import { ICON_NAMES, SPRITE, icon, use } from "../dist/icons.js";
import { amountHtml, formatSol, soundingHtml } from "../dist/numerals.js";
import { FLOWS, LABELS, REPORT } from "./lib/sample.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const guide = pathToFileURL(join(root, "docs", "design", "system", "index.html")).href;
const popup = pathToFileURL(join(root, "docs", "design", "system", "popup.html")).href;

const problems = [];
const note = (ok, text) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) problems.push(text);
};

const browser = await chromium.launch();

async function open(url, { width, height = 900, reducedMotion = "no-preference" }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url()}`));
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, requests };
}

/** Elements that stick out past the right edge of the viewport and are not inside their own scroller. */
const overflowing = (page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const out = [];
    if (scrollWidth > vw) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= vw + 0.5) continue;
        let clipped = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) {
            clipped = true;
            break;
          }
        }
        if (!clipped) out.push(`${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(" ").join(".")} right=${Math.round(r.right)}`);
      }
    }
    return { vw, scrollWidth, out: out.slice(0, 8) };
  });

console.log("\nstyle guide, from file://");
for (const theme of ["dusk", "night"]) {
  for (const width of [1440, 768, 390]) {
    const { context, page, errors, requests } = await open(`${guide}?theme=${theme}`, { width });
    if (width === 1440) {
      note(errors.length === 0, `${theme}: no console errors or failed requests${errors.length ? `: ${errors.join(" | ")}` : ""}`);
      const remote = requests.filter((u) => !u.startsWith("file://") && !u.startsWith("data:"));
      note(remote.length === 0, `${theme}: ${requests.length} requests, all file:// or data:${remote.length ? `; not local: ${remote.join(", ")}` : ""}`);
      // Faces are fetched lazily, so ask for each one rather than checking what the page happened to use.
      const fonts = await page.evaluate(() =>
        Promise.all(
          ["400 22px 'Old Standard TT'", "italic 400 22px 'Old Standard TT'", "500 14px 'Libre Franklin'", "italic 500 14px 'Libre Franklin'", "400 14px 'Loch Tabular'", "500 14px 'Loch Tabular'", "italic 600 14px 'Loch Tabular'"].map(
            async (f) => [f, (await document.fonts.load(f, f.includes("Tabular") ? "0123" : "Loch")).length > 0],
          ),
        ),
      );
      const fontFiles = requests.filter((u) => u.endsWith(".woff2"));
      note(
        fonts.every(([, ok]) => ok) && fontFiles.every((u) => u.includes("/packages/design/fonts/")),
        `${theme}: fonts loaded from the package (${fontFiles.length} woff2 files)${fonts.filter(([, ok]) => !ok).map(([f]) => `; missing ${f}`).join("")}`,
      );
    }
    const o = await overflowing(page);
    note(o.scrollWidth <= o.vw, `${theme} at ${width}px: no horizontal overflow (document ${o.scrollWidth}px)${o.out.length ? `: ${o.out.join("; ")}` : ""}`);
    await context.close();
  }
}

console.log("\nkeyboard focus");
for (const theme of ["dusk", "night"]) {
  const { context, page } = await open(`${guide}?theme=${theme}`, { width: 1440 });
  const result = await page.evaluate(async () => {
    const lum = ([r, g, b]) => {
      const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const rgb = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const ground = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const c = rgb(getComputedStyle(p).backgroundColor);
        if (c.length >= 3 && (c[3] === undefined || c[3] > 0.9)) return c;
      }
      return [5, 15, 21];
    };
    const selector = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";
    const all = [...document.querySelectorAll(selector)].filter((el) => el.tabIndex >= 0 && el.offsetParent !== null && !el.closest("dialog:not([open])"));
    const bad = [];
    // Make the browser treat focus as keyboard focus.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    for (const el of all) {
      el.focus({ focusVisible: true });
      if (document.activeElement !== el) continue;
      // The ring may be drawn by the element or by a wrapper that owns the outline (input groups).
      let ringed = null;
      for (let p = el, i = 0; p && i < 3; p = p.parentElement, i++) {
        const s = getComputedStyle(p);
        if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2) {
          ringed = p;
          break;
        }
      }
      const label = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).split(" ")[0]} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}"`;
      if (!ringed) {
        bad.push(`no ring: ${label}`);
        continue;
      }
      const ring = rgb(getComputedStyle(ringed).outlineColor);
      const bg = ground(ringed.parentElement ?? ringed);
      const [hi, lo] = [lum(ring), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < 3) bad.push(`ring ${ratio.toFixed(2)}:1 on its ground: ${label}`);
    }
    return { count: all.length, bad };
  });
  note(result.bad.length === 0, `${theme}: ${result.count} interactive elements, each with a visible focus ring${result.bad.length ? `: ${result.bad.slice(0, 10).join("; ")}` : ""}`);
  await context.close();
}

console.log("\nreduced motion");
{
  const { context, page } = await open(guide, { width: 1440, reducedMotion: "reduce" });
  const moving = await page.evaluate(() => {
    const running = document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName ?? a.transitionProperty ?? "animation");
    const slow = [];
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      const longest = Math.max(...s.transitionDuration.split(",").map((d) => parseFloat(d) * (d.includes("ms") ? 1 : 1000)));
      if (longest > 1) slow.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${longest}ms`);
    }
    return { running, slow: slow.slice(0, 6), smooth: getComputedStyle(document.documentElement).scrollBehavior };
  });
  note(moving.running.length === 0, `no animation running${moving.running.length ? `: ${[...new Set(moving.running)].join(", ")}` : ""}`);
  note(moving.slow.length === 0, `no transition takes time${moving.slow.length ? `: ${moving.slow.join("; ")}` : ""}`);
  note(moving.smooth !== "smooth", "scrolling is not smoothed");
  // Things that animate on request must not animate either.
  await page.locator("[data-replay]").click();
  await page.locator("[data-switch='density'] [data-value='compact']").click();
  await page.waitForTimeout(60);
  const afterAction = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
  note(afterAction === 0, `nothing animates after an action either (soundings replayed, density switched): ${afterAction} running`);
  await context.close();
}
{
  const { context, page } = await open(guide, { width: 1440 });
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName));
  const names = [...new Set(running)];
  note(names.every((n) => n === "loch-dashes"), `without the preference, the only motion at rest is the working dashes (${names.join(", ") || "none"})`);
  await context.close();
}

console.log("\npopup, 380 x 600");
for (const view of ["home", "home-night", "proving", "error", "empty", "report-night"]) {
  const { context, page, errors, requests } = await open(`${popup}#${view}`, { width: 380, height: 600 });
  const fit = await page.evaluate(() => {
    const frame = document.querySelector(".popup.is-shown");
    const r = frame.getBoundingClientRect();
    const wide = [...frame.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible" && !el.matches("input, .tabs")).map((el) => el.className);
    const out = [...frame.querySelectorAll("*")].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && (b.right > r.right + 0.5 || b.left < r.left - 0.5) && !el.closest("defs");
    }).map((el) => String(el.className.baseVal ?? el.className));
    // On the views that are meant to fit, nothing may need vertical scrolling either.
    const deep = frame.querySelector(".popup__deep");
    const tall = deep && !frame.querySelector(".sheet") ? deep.scrollHeight - deep.clientHeight : 0;
    return { w: r.width, h: r.height, doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], wide, out: out.slice(0, 5), tall };
  });
  const remote = requests.filter((u) => !u.startsWith("file://") && !u.startsWith("data:"));
  note(
    errors.length === 0 && remote.length === 0 && fit.w === 380 && fit.h === 600 && fit.doc[0] <= 380 && fit.doc[1] <= 600 && fit.out.length === 0 && fit.wide.length === 0 && fit.tall <= 0,
    `${view}: 380 x 600, nothing outside the frame, nothing scrolling sideways, no errors${fit.tall > 0 ? ` activity overflows by ${fit.tall}px` : ""}${errors.length ? ` errors: ${errors.join("|")}` : ""}${fit.out.length ? ` outside: ${fit.out.join(", ")}` : ""}${fit.wide.length ? ` wide: ${fit.wide.join(", ")}` : ""}${fit.doc[0] > 380 || fit.doc[1] > 600 ? ` document ${fit.doc.join("x")}` : ""}`,
  );
  await context.close();
}

console.log("\nscrolling regions");
for (const width of [1440, 390]) {
  const { context, page } = await open(guide, { width });
  const stuck = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      if (!/(auto|scroll)/.test(s.overflowX) || el.scrollWidth <= el.clientWidth + 1 || el.offsetParent === null) continue;
      // Reachable when it can take focus itself, or holds something that can.
      const reachable = el.tabIndex >= 0 || el.querySelector("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])");
      const named = el.tabIndex >= 0 ? el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") : true;
      if (!reachable || !named) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}${reachable ? " (no name)" : ""}`);
    }
    return out;
  });
  note(stuck.length === 0, `at ${width}px every region that scrolls sideways is focusable (or holds a control) and named${stuck.length ? `: ${[...new Set(stuck)].join(", ")}` : ""}`);
  await context.close();
}

console.log("\nstepped figures");
{
  const bad = [];
  let looked = 0;
  for (const width of [320, 360, 390, 480, 600, 768, 900, 1100, 1440]) {
    const { context, page } = await open(guide, { width });
    const seen = await page.evaluate(() =>
      [...document.querySelectorAll(".fit")].map((fit) => {
        const all = [...fit.children].map((el) => ({ w: Number(el.getAttribute("data-w")), shown: getComputedStyle(el).display !== "none", drawn: el.getBoundingClientRect().width }));
        return { room: fit.clientWidth, all };
      }),
    );
    for (const { room, all } of seen) {
      looked++;
      const shown = all.filter((d) => d.shown);
      const widest = Math.max(...all.filter((d) => d.w <= room).map((d) => d.w), all[0].w);
      if (shown.length !== 1) bad.push(`${width}px: ${shown.length} drawings shown in ${room}px`);
      else if (shown[0].w !== widest) bad.push(`${width}px: shows ${shown[0].w} in ${room}px, the widest that fits is ${widest}`);
      else if (Math.abs(shown[0].drawn - room) > 1) bad.push(`${width}px: the ${shown[0].w} drawing is ${Math.round(shown[0].drawn)}px wide in ${room}px`);
    }
    await context.close();
  }
  note(bad.length === 0 && looked > 0, `${looked} stepped figures looked at from 320 to 1440px: each shows one drawing, the widest that fits, filling its column${bad.length ? `: ${bad.slice(0, 6).join("; ")}` : ""}`);
}

console.log("\ncontent security policy");
{
  // A page made of nothing but what the package emits, served (by interception: no request leaves
  // the browser) once with a strict policy and once with none.
  const pkg = join(root, "packages", "design");
  const sol = (lamports, options) => formatSol(BigInt(lamports), options);
  const body = [
    SPRITE,
    `<p class="cluster" id="icons">${ICON_NAMES.map((name) => use(name)).join("")}${ICON_NAMES.map((name) => icon(name)).join("")}</p>`,
    `<figure class="chart" id="bed">${steppedBedSvg(REPORT, { width: 640, id: "csp-bed", animate: true })}</figure>`,
    `<figure class="chart" id="hours">${byHourSvg(FLOWS, { width: 420, id: "csp-hours" })}</figure>`,
    `<figure class="chart" id="who">${counterpartiesSvg(FLOWS, { labels: LABELS, width: 420, id: "csp-who" })}</figure>`,
    `<figure class="chart" id="fit">${fitHtml((width) => byHourSvg(FLOWS, { width, id: `csp-fit-${width}` }), { max: 568 })}</figure>`,
    `<div class="statement-wrap">${statementHtml(REPORT, { totalNote: "What helps." })}</div>`,
    `<p class="balance__figure">${soundingHtml(sol("12480739112"))}${soundingHtml(sol("5000"))}</p>`,
    `<p>${amountHtml(sol("-1250000000", { sign: "always" }), { shielded: true, unit: "SOL" })}</p>`,
  ].join("\n");
  const html = (extra = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>policy</title><link rel="stylesheet" href="/design/all.css"></head><body class="water" data-depth="60">${body}${extra}</body></html>`;
  const types = { ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  const POLICY = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

  async function load(policy, extra = "") {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    const refused = [];
    const remote = [];
    page.on("console", (m) => /Content Security Policy/i.test(m.text()) && refused.push(m.text().split(". ")[0]));
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://policy.loch.test") {
        remote.push(url.href);
        return route.abort();
      }
      const headers = policy ? { "content-security-policy": policy } : {};
      if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers, body: html(extra) });
      const file = normalize(join(pkg, url.pathname.replace(/^\/design\//, "")));
      if (!url.pathname.startsWith("/design/") || !file.startsWith(pkg)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: types[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    });
    await page.goto("http://policy.loch.test/", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(",");
      };
      const sprite = document.querySelector("svg.sprite");
      return {
        sprite: `${getComputedStyle(sprite).position} ${box(sprite)}`,
        boxes: [...document.querySelectorAll("body svg, body figure, body li, body span")].map(box).join(";"),
        delays: [...document.querySelectorAll(".lc-col")].map((el) => getComputedStyle(el).animationDelay).join(","),
        shown: [...document.querySelectorAll(".fit > svg")].filter((el) => getComputedStyle(el).display !== "none").length,
        inline: document.querySelectorAll("[style], style").length,
      };
    });
    await context.close();
    return { refused, remote, layout };
  }

  const strict = await load(POLICY);
  const open_ = await load(null);
  note(strict.refused.length === 0, `style-src 'self' refuses nothing the package emits${strict.refused.length ? `: ${strict.refused.slice(0, 3).join(" | ")}` : ""}`);
  note(strict.layout.inline === 0, `no style attribute and no <style> element in the page (${strict.layout.inline} found)`);
  note(JSON.stringify(strict.layout) === JSON.stringify(open_.layout), "every figure, icon and row is laid out the same with the policy as without it");
  note(/^absolute /.test(strict.layout.sprite) && /,0,0$/.test(strict.layout.sprite), `the sprite is out of the flow and takes no room (${strict.layout.sprite})`);
  note(strict.layout.delays.split(",").length > 2 && new Set(strict.layout.delays.split(",")).size === strict.layout.delays.split(",").length, `the soundings still drop one after another (${strict.layout.delays})`);
  note(strict.layout.shown === 1, `the stepped figure shows one drawing (${strict.layout.shown})`);
  note(strict.remote.length === 0 && open_.remote.length === 0, `no request to any other origin${strict.remote.length ? `: ${strict.remote.join(", ")}` : ""}`);
  // The check has teeth: one inline style of the kind the helpers used to write is refused.
  const control = await load(POLICY, `<svg width="10" height="10" style="max-width:10px"></svg>`);
  note(control.refused.length > 0, `and the same policy does refuse an inline style when there is one (${control.refused.length} refused)`);
}

console.log("\nextension page");
{
  // An unpacked extension with one page that links all.css and nothing else. Chrome injects
  // `body { font-family: <system>; font-size: 75% }` into it, unlayered; base.css has to win.
  const pkg = join(root, "packages", "design");
  const work = join(pkg, "node_modules", ".cache", "loch-verify-extension");
  const ext = join(work, "extension");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(ext, "design"), { recursive: true });
  for (const file of ["all.css", "tokens.css", "fonts.css", "base.css", "components.css"]) cpSync(join(pkg, file), join(ext, "design", file));
  cpSync(join(pkg, "fonts"), join(ext, "design", "fonts"), { recursive: true });
  writeFileSync(join(ext, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Loch design check", version: "0.0.1", background: { service_worker: "background.js" }, action: { default_popup: "page.html" } }));
  writeFileSync(join(ext, "background.js"), "// nothing\n");
  writeFileSync(join(ext, "page.html"), `<!doctype html><html lang="en" data-density="compact"><head><meta charset="utf-8"><title>check</title><link rel="stylesheet" href="design/all.css"></head><body><p id="plain">Plain text in the body.</p></body></html>`);
  let context = null;
  try {
    // Extensions need the full browser, in the new headless mode: the headless shell cannot load them.
    context = await chromium.launchPersistentContext(join(work, "profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--disable-background-networking", "--disable-component-update", "--no-first-run"],
    });
  } catch (error) {
    console.log(`  skip this Chromium cannot load an extension here: ${String(error).split("\n")[0]}`);
  }
  if (context) {
    try {
      let [worker] = context.serviceWorkers();
      worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
      const page = await context.newPage();
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/page.html`);
      const body = await page.evaluate(() => {
        const s = getComputedStyle(document.body);
        const p = getComputedStyle(document.getElementById("plain"));
        return { family: s.fontFamily, size: s.fontSize, text: `${p.fontFamily.split(",")[0]} ${p.fontSize}` };
      });
      // What Chrome put there, as DevTools would list it.
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root: doc } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.nodeId, selector: "body" });
      const matched = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
      const injected = matched.matchedCSSRules
        .filter((m) => m.rule.origin === "injected")
        .flatMap((m) => m.rule.style.cssProperties.filter((d) => /^font-(family|size)$/.test(d.name)).map((d) => `${d.name}: ${d.value}`));
      note(/^"?Libre Franklin/.test(body.family) && body.size === "14px", `the body is ${body.family.split(",")[0]} at ${body.size} (compact density), and so is plain text in it (${body.text})`);
      console.log(`       Chrome's own sheet on this page: ${injected.length ? `body { ${injected.join("; ")} }` : "none found: this Chromium no longer injects one"}`);
    } finally {
      await context.close();
    }
  }
  rmSync(work, { recursive: true, force: true });
}

await browser.close();
if (problems.length > 0) {
  console.error(`\nverify: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nverify: all checks passed");
