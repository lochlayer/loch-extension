#!/usr/bin/env node
// Writes the living style guide into docs/design/system:
//   index.html   every token, type role, component and state
//   popup.html   the extension popup alone, at its real 380 x 600
//   states.css   pinned :hover / :active / :focus-visible copies of the package's own rules
//
// The pages link the package's stylesheets by relative path and inline the
// icon sprite and the charts (rendered here by the built chart helpers), so
// they open straight from the filesystem with no server and no module loading.
//
//   pnpm --filter @loch/design run build && pnpm --filter @loch/design run guide
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  byHourSvg,
  byHourText,
  counterpartiesSvg,
  counterpartiesText,
  fitHtml,
  statementHtml,
  statementText,
  steppedBedSvg,
} from "../dist/charts/index.js";
import { amountHtml, formatSol, groupAddress, shortAddress, soundingHtml } from "../dist/numerals.js";
import { ICON_NAMES, SPRITE } from "../dist/icons.js";
import { measure, paletteTokens, resolve } from "./lib/tokens.mjs";
import { forceStates } from "./lib/states.mjs";
import { FLOWS, LABELS, RECIPIENT, REPORT, SEND_FAILURE, SHIELDED, WALLET } from "./lib/sample.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkg, "..", "..", "docs", "design", "system");
mkdirSync(out, { recursive: true });
const P = relative(out, pkg).split("\\").join("/"); // ../../../packages/design

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ic = (name, cls = "") => `<svg class="icon${cls ? ` ${cls}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
const sol = (lamports, opts) => formatSol(BigInt(lamports), opts);
const me = shortAddress(WALLET);
const to = shortAddress(RECIPIENT);
const score = REPORT.score;

/* ------------------------------------------------------------------ helpers */

const spec = (name, note, body, opts = {}) => `
<article class="g-spec${opts.wide ? " g-spec--wide" : ""}" id="c-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}">
  <header class="g-spec__head">
    <h3 class="g-spec__name">${name}</h3>
    <p class="g-spec__note">${note}</p>
    ${opts.code ? `<p class="g-spec__code"><code>${esc(opts.code)}</code></p>` : ""}
  </header>
  <div class="g-spec__body">${body}${opts.after ?? ""}</div>
</article>`;

const states = (items, cls = "") => `<div class="g-states${cls ? ` ${cls}` : ""}">${items.map(([cap, html]) => `<figure class="g-state">${html}<figcaption>${cap}</figcaption></figure>`).join("")}</div>`;

const sub = (title) => `<p class="g-sub">${title}</p>`;

/* -------------------------------------------------------------------- colour */

function matrix(theme) {
  const m = measure(theme);
  const tokens = m.tokens;
  const grounds = [
    ["--land", "Land", "land"],
    ["--water-0", "Water, 0 m", "water"],
    ["--water-20", "20 m", "water"],
    ["--water-60", "60 m", "water"],
    ["--water-120", "120 m", "water"],
    ["--water-180", "180 m", "water"],
    ["--bed", "The bed, 230 m", "water"],
  ];
  const inks = {
    land: [
      ["--land-ink", "Land ink"],
      ["--land-ink-2", "Land ink 2"],
      ["--land-caution", "Caution"],
    ],
    water: [
      ["--paper", "Paper"],
      ["--paper-2", "Paper 2"],
      ["--loch", "Loch blue"],
      ["--buff", "Buff"],
      ["--water-caution", "Magenta"],
    ],
  };
  const ratio = (fg, bg) => m.allowed.find((p) => p.fg === fg && p.bg === bg && p.min === 4.5)?.ratio;
  const rows = grounds
    .map(([bg, name, kind]) => {
      const cells = inks[kind]
        .map(([fg, fgName]) => {
          const r = ratio(fg, bg);
          return `<span class="g-pair" style="color:var(${fg})"><b class="fig">${r.toFixed(1)}</b><span>${fgName}</span></span>`;
        })
        .join("");
      return `<div class="g-ground" style="background:var(${bg})">
        <span class="g-ground__name" style="color:var(${kind === "land" ? "--land-ink" : "--paper"})"><b>${name}</b><code>${bg}</code><code>${resolve(tokens, tokens[bg])}</code></span>
        <span class="g-ground__pairs">${cells}</span>
      </div>${bg === "--land" ? `<hr class="waterline">` : ""}`;
    })
    .join("");
  return `<figure class="g-section" data-theme="${theme}">
    ${rows}
    <figcaption class="g-section__cap" style="background:var(--bed)"><b>${theme === "dusk" ? "Dusk, the default" : "Night"}</b> ${
      theme === "dusk"
        ? "Buff land over blue water. Each figure is the measured contrast of that ink on that ground, set in that ink."
        : "The same chart with the light gone: <code>data-theme=\"night\"</code>. Land turns to midnight, the water's own blue gone dark, and is lettered in buff; the waterline becomes a drawn line. Nothing below it changes."
    }</figcaption>
  </figure>`;
}

function forbiddenTable() {
  const rows = [...measure("dusk").forbidden, ...measure("night").forbidden.filter((p) => /land/.test(p.bgName)).map((p) => ({ ...p, bgName: "night land" }))];
  return `<table class="table g-forbidden">
    <caption>Forbidden pairings</caption>
    <thead><tr><th scope="col">Ink</th><th scope="col">Ground</th><th scope="col" class="num">Ratio</th><th scope="col">Why</th></tr></thead>
    <tbody>${rows.map((p) => `<tr><th scope="row">${p.fgName}</th><td class="g-nowrap">${p.bgName}</td><td class="num">${p.ratio.toFixed(1)}</td><td>${p.why}</td></tr>`).join("")}</tbody>
  </table>`;
}

const roleRows = [
  ["--ground", "The fill of the ground itself", "--land", "--water-0 … --bed"],
  ["--text", "Running text, labels", "--land-ink", "--paper"],
  ["--text-2", "Secondary text, hints, meta", "--land-ink-2", "--paper-2"],
  ["--public", "Public data: upright", "--land-ink", "--buff"],
  ["--shielded", "Shielded data: italic", "not allowed on land", "--loch"],
  ["--heading", "Display headings", "--land-ink, upright", "--loch, italic"],
  ["--caution", "Cautions only", "--land-caution", "--water-caution"],
  ["--action / --on-action", "The primary action", "ink fill (buff at night)", "buff fill, ink label"],
  ["--rule / --rule-strong", "Hairlines", "--land-rule…", "--water-rule…"],
  ["--rule-control", "The edge of a control (3:1)", "--land-rule-strong", "--water-rule-control"],
  ["--field", "The fill of an input or code", "--land-raised", "--water-sunk"],
  ["--focus", "The focus ring", "--land-ink", "buff"],
];

const colour = () => `
<section class="band water" data-depth="20" id="colour" aria-labelledby="colour-t">
  <div class="contour" aria-hidden="true"><span>20 m</span></div>
  <div class="wrap">
    <div class="section-head">
      <h2 class="t-display-2" id="colour-t">Four inks, and what each one is for.</h2>
      <p class="t-lede">An Admiralty chart is printed in buff, blue, black and magenta. So is Loch. A colour here is a role, not a swatch: components never name a pigment, they ask the ground they stand on.</p>
    </div>

    <div class="g-sections">
      ${matrix("dusk")}
      ${matrix("night")}
    </div>

    <div class="g-cols g-cols--rules">
      <div>
        <h3 class="g-h3">What each colour means</h3>
        <dl class="deflist g-meanings">
          <div class="deflist__row"><dt><span class="g-chip" style="background:var(--pigment-buff)"></span>Buff</dt><dd>Land. On water it is whatever is public (an amount the chain can see), and the one solid thing to stand on: the primary action. It is also the waterline and the focus ring.</dd></div>
          <div class="deflist__row"><dt><span class="g-chip" style="background:var(--pigment-loch)"></span>Loch blue</dt><dd>Water lettering. Every shielded figure and every italic heading. Never on land.</dd></div>
          <div class="deflist__row"><dt><span class="g-chip" style="background:var(--pigment-paper)"></span>Paper</dt><dd>Running text and interface text on water. Paper 2 is its secondary.</dd></div>
          <div class="deflist__row"><dt><span class="g-chip" style="background:var(--pigment-ink)"></span>Ink</dt><dd>Text and detail on buff, and the label of a buff button.</dd></div>
          <div class="deflist__row"><dt><span class="g-chip" style="background:var(--pigment-magenta)"></span>Chart magenta</dt><dd>Cautions and nothing else: devnet, unaudited, a leak and what it cost, a failed action, an invalid field. Never a button, never a decoration. Deep magenta on buff, light magenta on dark grounds.</dd></div>
          <div class="deflist__row"><dt><span class="g-chip" style="background:var(--pigment-midnight)"></span>Midnight</dt><dd>Land in the night palette: the water's own blue gone dark, lettered in buff. On the website it is the sky.</dd></div>
          <div class="deflist__row"><dt><span class="g-chip g-chip--tints"></span>Prussian tints</dt><dd>Water, named by depth: 0, 20, 60, 120, 180 and the bed at 230 m. Flat steps, never a gradient. Depth only ever increases down a surface.</dd></div>
        </dl>
        <div class="table-scroll g-gap" data-density="compact" tabindex="0" role="group" aria-label="Forbidden pairings">${forbiddenTable()}</div>
      </div>
      <div>
        <h3 class="g-h3">Ground roles</h3>
        <div class="table-scroll" tabindex="0" role="group" aria-label="Ground roles">
        <table class="table g-roles">
          <thead><tr><th scope="col">Role</th><th scope="col">For</th><th scope="col">On <code>.land</code></th><th scope="col">In <code>.water</code></th></tr></thead>
          <tbody>${roleRows.map(([a, b, c, d]) => `<tr><th scope="row"><code>${a}</code></th><td>${b}</td><td>${c}</td><td>${d}</td></tr>`).join("")}</tbody>
        </table>
        </div>
        <p class="t-fine g-note">A component never names a pigment. It reads these roles, and the ground it stands on (<code>.land</code> or <code>.water</code>) decides what they are. That is why one button works on buff, on midnight and at every depth.</p>
      </div>
    </div>
  </div>
</section>`;

/* ---------------------------------------------------------------------- type */

const SIZES = [
  [12, "104", "9", "serif"],
  [11, "83.5", "8", "serif"],
  [10, "67", "7", "serif"],
  [9, "53.5", "6", "serif"],
  [8, "43", "5", "serif"],
  [7, "34", "4", "serif"],
  [6, "27.5", "3", "serif"],
  [5, "22", "2", "serif"],
  [4, "17.5", "1", "sans"],
  [3, "15.5", "½", "sans"],
  [2, "14", "0", "sans"],
  [1, "12.5", "−½", "sans"],
];

const roleSpec = [
  ["t-display-1", "Display 1", "clamp 43 to 83.5", "34", "The Loch is not."],
  ["t-display-2", "Display 2", "clamp 34 to 43", "27.5", "Take a sounding of your own wallet."],
  ["t-display-3", "Display 3", "27.5", "22", "Dive in"],
  ["t-lede", "Lede", "22", "15.5", "Loch adds a shielded balance to the wallet you already use."],
  ["t-body", "Body", "17.5", "14", "A zero-knowledge proof shows the payment is valid without showing the sender, the recipient or the amount."],
  ["t-small", "Small", "15.5", "12.5", "The deposit itself is public. Anyone can see that you dived in, and how much."],
  ["t-label", "Label", "14", "12.5", "Solana wallet address"],
  ["t-fine", "Fine", "14", "12.5", "The scan reads public chain data only."],
];

const type = () => `
<section class="band water" data-depth="60" id="type" aria-labelledby="type-t">
  <div class="contour" aria-hidden="true"><span>60 m</span></div>
  <div class="wrap">
    <div class="section-head">
      <h2 class="t-display-2" id="type-t">Two faces, from the years the loch was sounded.</h2>
      <p class="t-lede">Old Standard TT is the engraved lettering of a 1900 survey plate. Libre Franklin is Franklin Gothic, 1902: the plain half of the pair. Both are served from inside the package. There is no monospace outside code.</p>
    </div>

    <div class="g-faces">
      <div class="g-face">
        <p class="g-face__a" style="font-family:var(--font-serif)">Loch Ness, 230 m</p>
        <p class="g-face__a is-shielded" style="font-family:var(--font-serif);font-weight:400">Loch Ness, 230 m</p>
        <p class="t-fine"><b>Old Standard TT.</b> Roman and italic, weight 400. Never bold. Never below 22px. Display headings and display figures only.</p>
      </div>
      <div class="g-face">
        <p class="g-face__b">Dive in, send privately, surface</p>
        <p class="g-face__b is-shielded">Dive in, send privately, surface</p>
        <p class="t-fine"><b>Libre Franklin.</b> Variable. 400 for text, 500 for emphasis and small italic, 600 for labels and buttons. Everything that is not display.</p>
      </div>
      <div class="g-face">
        <p class="g-face__c"><span>1,111.111</span><span class="fig">1,111.111</span></p>
        <p class="g-face__c"><span>8,888.888</span><span class="fig">8,888.888</span></p>
        <p class="t-fine"><b>Loch Tabular.</b> Libre Franklin ships no tabular figures, so its ten digits are re-spaced onto one width and served as a tiny third face. Left: proportional. Right: <code>.fig</code>.</p>
      </div>
    </div>

    <h3 class="g-h3">The lettering rule</h3>
    <div class="g-rule">
      <div class="g-rule__cell">
        <p class="t-fine">Public, display</p>
        <p class="figure is-public">41.207</p>
      </div>
      <div class="g-rule__cell">
        <p class="t-fine">Shielded, display</p>
        <p class="figure is-shielded">12.480</p>
      </div>
      <div class="g-rule__cell">
        <p class="t-fine">Public, text size</p>
        <p class="is-public g-rule__text">Dived in <span class="fig"><span class="fig-sign">+</span>5.000</span></p>
      </div>
      <div class="g-rule__cell">
        <p class="t-fine">Shielded, text size</p>
        <p class="is-shielded g-rule__text">Sent privately <span class="fig"><span class="fig-sign">−</span>1.250</span></p>
      </div>
    </div>
    <div class="g-cols">
      <div class="stack--tight stack">
        <p class="t-body"><strong>Upright is public. Italic is shielded.</strong> A datum the chain can see (an address, a deposit, a public balance, the privacy score) is upright: buff on water, ink on land. A datum only its holder can see is italic, in loch blue. This is an encoding, so it has no exceptions and it is never used for emphasis.</p>
        <p class="t-body">Display headings follow the ground they stand on, as names do on a map: upright on land, italic in water. The name Loch is always italic. Body copy and interface text are always upright sans.</p>
      </div>
      <div class="stack--tight stack">
        <p class="t-body"><strong>The 22px floor.</strong> Old Standard&rsquo;s italic is superb large and too thin to read small on a 1x display. Below 22px the italic is Libre Franklin&rsquo;s, at weight 500. The slope carries the meaning at every size; the serif is only the voice it has when it is large.</p>
        <div class="g-floor">
          <p><span class="t-fine">17.5px, as the mock had it</span><span style="font-family:var(--font-serif);font-style:italic;font-size:var(--size-4);color:var(--loch)">Received privately +0.730</span></p>
          <p><span class="t-fine">17.5px, the rule</span><span class="is-shielded" style="font-size:var(--size-4)">Received privately <span class="fig">+0.730</span></span></p>
          <p><span class="t-fine">14px, the rule</span><span class="is-shielded" style="font-size:var(--size-2)">Received privately <span class="fig">+0.730</span></span></p>
          <p><span class="t-fine">22px and up</span><span style="font-family:var(--font-serif);font-style:italic;font-size:var(--size-5);color:var(--loch)">Received privately</span></p>
        </div>
      </div>
    </div>

    <h3 class="g-h3">The scale</h3>
    <p class="t-small g-note">Ratio 5:4, a major third, anchored at 14px and rounded to the half pixel. Text may use the half steps either side of the anchor. Display uses whole steps only.</p>
    <div class="g-scale">
      ${SIZES.map(
        ([i, px, step, face]) => `<div class="g-scale__row">
        <span class="g-scale__meta"><code>--size-${i}</code><span class="fig">${px}</span><span>step ${step}</span></span>
        <span class="g-scale__sample${face === "sans" ? " g-scale__sample--text" : ""}" style="font-size:var(--size-${i});font-family:var(--font-${face})${face === "serif" ? ";font-style:italic;color:var(--loch)" : ""}">${i >= 11 ? "Loch" : i >= 9 ? "The Loch" : i >= 5 ? "The Loch is not." : "Pay from it, and the payment doesn&rsquo;t bring your history along."}</span>
      </div>`,
      ).join("")}
    </div>

    <h3 class="g-h3">Type roles, in both densities</h3>
    <div class="g-roles-grid">
      <div>
        ${sub("Comfortable: the website")}
        ${roleSpec.map(([cls, name, a]) => `<div class="g-role"><span class="g-role__meta"><code>.${cls}</code><span class="fig">${a}</span></span><p class="${cls}">${roleSpec.find((r) => r[0] === cls)[4]}</p></div>`).join("")}
      </div>
      <div data-density="compact">
        ${sub("Compact: the extension popup")}
        ${roleSpec.map(([cls, name, a, b]) => `<div class="g-role"><span class="g-role__meta"><code>.${cls}</code><span class="fig">${b}</span></span><p class="${cls}">${roleSpec.find((r) => r[0] === cls)[4]}</p></div>`).join("")}
      </div>
    </div>
  </div>
</section>`;

/* ------------------------------------------------------------------ numerals */

const truncRows = [
  ["12480739112", "A balance"],
  ["41207000000", "A whole thousandth"],
  ["1250000000", "A round amount"],
  ["999999999", "Just under 1 SOL: never rounded up"],
  ["5000", "A fee"],
  ["104219500000000", "Five figures and up: thin spaces"],
  ["0", "Zero"],
];

const numerals = () => `
<section class="band water" data-depth="60" id="numerals" aria-labelledby="num-t" style="padding-top:0">
  <div class="wrap">
    <div class="section-head">
      <h2 class="t-display-2" id="num-t">Figures are the product.</h2>
      <p class="t-lede">Balances, amounts, scores and depths. Lining figures everywhere; tabular wherever two figures can sit above one another.</p>
    </div>

    <div class="g-cols g-cols--num">
      <div>
        ${sub("The shielded balance, written as a sounding")}
        <div class="balance balance--shielded g-gap-s">
          <p class="balance__label">Shielded balance</p>
          <p class="balance__figure">${soundingHtml(sol("12480739112"))}<span class="fig-unit">devnet SOL</span></p>
          <p class="balance__note">In the Loch. Visible only to you.</p>
        </div>
        <p class="t-small g-note">A chart writes twelve and a half metres as 12 with a small dropped 5. The whole number is full size; the fraction, with its point, is half size and dropped 0.16em. Only where the fraction itself reaches 22px.</p>
        ${sub("A public balance")}
        <div class="balance balance--public g-gap-s">
          <p class="balance__label">Public balance</p>
          <p class="balance__figure"><span class="figure is-public">41.207</span><span class="fig-unit">SOL</span></p>
        </div>
        <p class="t-small g-note">Upright roman, every digit the same size. Heights stand up; depths slope.</p>
      </div>
      <div>
        ${sub("In a column")}
        <table class="table">
          <thead><tr><th scope="col">Activity</th><th scope="col">When</th><th scope="col" class="num">SOL</th></tr></thead>
          <tbody>
            <tr><th scope="row" class="is-public">Dived in</th><td class="fig t-quiet">3 Oct, 14:02</td><td class="num is-public">${amountHtml(sol("5000000000", { sign: "always" }))}</td></tr>
            <tr><th scope="row" class="is-shielded">Sent privately</th><td class="fig t-quiet">2 Oct, 19:40</td><td class="num">${amountHtml(sol("-1250000000", { sign: "always" }), { shielded: true })}</td></tr>
            <tr><th scope="row" class="is-shielded">Received privately</th><td class="fig t-quiet">28 Sep, 08:11</td><td class="num">${amountHtml(sol("730000000", { sign: "always" }), { shielded: true })}</td></tr>
            <tr><th scope="row" class="is-public">Surfaced</th><td class="fig t-quiet">26 Sep, 11:27</td><td class="num is-public">${amountHtml(sol("-2000000000", { sign: "always" }))}</td></tr>
            <tr><th scope="row" class="is-shielded">Sent privately</th><td class="fig t-quiet">21 Sep, 16:55</td><td class="num">${amountHtml(sol("-11048200000", { sign: "always" }), { shielded: true })}</td></tr>
          </tbody>
        </table>
        <p class="t-small g-note">The points line up because every digit is one width, upright or italic. A change always carries its sign, a plus or a true minus, set upright even on a shielded amount. A unit that the column head already names is not repeated.</p>
      </div>
    </div>

    <div class="g-cols g-cols--num">
      <div>
        ${sub("How SOL is shortened for display")}
        <div class="table-scroll" tabindex="0" role="group" aria-label="How SOL is shortened for display">
        <table class="table">
          <thead><tr><th scope="col" class="num">Lamports</th><th scope="col" class="num">Shown</th><th scope="col" class="num">Exact</th><th scope="col">Case</th></tr></thead>
          <tbody>${truncRows
            .map(([l, why]) => `<tr><td class="num t-quiet">${l}</td><td class="num is-public">${sol(l).text}</td><td class="num">${sol(l, { exact: true }).text}</td><td>${why}</td></tr>`)
            .join("")}</tbody>
        </table>
        </div>
      </div>
      <div>
        ${sub("The rules")}
        <ul class="g-list t-small">
          <li><strong>Truncate, never round up.</strong> A displayed amount is cut toward zero at three decimals, and all three are always written.</li>
          <li><strong>Exact before signing.</strong> Anything about to be signed, and every fee, is written in full: at least three decimals, up to nine, trailing zeros dropped.</li>
          <li><strong>Never 0.000 for something.</strong> A non-zero amount too small to show is written &lt;0.001.</li>
          <li><strong>Point and thin space.</strong> The decimal mark is always a point. From 10 000 up, thousands are parted by a thin space, so no locale can misread a comma.</li>
          <li><strong>Units.</strong> After a no-break space, upright, strong, one size down, in secondary ink: <span class="fig is-public">41.207</span>&nbsp;<span class="fig-unit">SOL</span>. On devnet a balance says devnet SOL.</li>
          <li><strong>No colour for direction.</strong> Plus and minus say it. Magenta is for cautions.</li>
        </ul>
        <p class="t-fine g-note">All of this is <code>formatSol()</code>, <code>parseSol()</code> and <code>amountHtml()</code> in <code>@loch/design/numerals</code>.</p>
      </div>
    </div>
  </div>
</section>`;

/* -------------------------------------------------------------------- layout */

const spaces = [
  ["05", 2],
  ["1", 4],
  ["2", 8],
  ["3", 12],
  ["4", 16],
  ["5", 20],
  ["6", 24],
  ["8", 32],
  ["10", 40],
  ["12", 48],
  ["16", 64],
  ["24", 96],
  ["32", 128],
];

const densityRows = [
  ["--text-body", "17.5", "14"],
  ["--text-control", "15.5", "14"],
  ["--text-fine", "14", "12.5"],
  ["--gutter", "16 to 48", "16"],
  ["--stack", "24", "12"],
  ["--row-y", "16", "8"],
  ["--row-min", "56", "40"],
  ["--control-sm", "36", "28"],
  ["--control-md", "44", "36"],
  ["--control-lg", "52", "44"],
  ["--control-x", "20", "12"],
  ["--icon", "20", "18"],
  ["--band-top / --band-bottom", "68 to 104 / 76 to 116", "16 / 16"],
];

const densityDemo = (d) => `
<div class="g-density" data-density="${d}">
  ${sub(d === "comfortable" ? "Comfortable" : "Compact")}
  <div class="cluster">
    <button class="btn btn--primary btn--lg" type="button">Large</button>
    <button class="btn btn--primary" type="button">Medium</button>
    <button class="btn btn--secondary btn--sm" type="button">Small</button>
  </div>
  <div class="field g-gap-s">
    <label class="field__label" for="dens-${d}">Recipient</label>
    <input class="input" id="dens-${d}" type="text" placeholder="A Loch address" autocomplete="off">
    <p class="field__hint">Only you and the recipient will see this payment.</p>
  </div>
  <ul class="activity g-gap-s">
    <li class="activity__row is-public">${ic("dive")}<span class="activity__main"><span class="activity__title">Dived in</span><span class="activity__meta">From ${me}, today 14:02</span></span><span class="activity__amount fig"><span class="fig-sign">+</span>5.000</span></li>
    <li class="activity__row is-shielded">${ic("send")}<span class="activity__main"><span class="activity__title">Sent privately</span><span class="activity__meta">Yesterday 19:40</span></span><span class="activity__amount fig"><span class="fig-sign">−</span>1.250</span></li>
  </ul>
</div>`;

const layout = () => `
<section class="band water" data-depth="120" id="layout" aria-labelledby="layout-t">
  <div class="contour" aria-hidden="true"><span>120 m</span></div>
  <div class="wrap">
    <div class="section-head">
      <h2 class="t-display-2" id="layout-t">One section, two densities.</h2>
      <p class="t-lede">The website is a long descent and the popup is 380 by 600. The same components serve both: they read role tokens, and a density sets the roles.</p>
    </div>

    <div class="g-cols">
      ${densityDemo("comfortable")}
      ${densityDemo("compact")}
    </div>

    <div class="g-cols g-cols--layout">
      <div>
        <h3 class="g-h3">Density roles</h3>
        <table class="table">
          <thead><tr><th scope="col">Token</th><th scope="col" class="num">Comfortable</th><th scope="col" class="num">Compact</th></tr></thead>
          <tbody>${densityRows.map(([t, a, b]) => `<tr><th scope="row"><code>${t}</code></th><td class="num">${a}</td><td class="num">${b}</td></tr>`).join("")}</tbody>
        </table>
        <p class="t-fine g-note">Pixels at a 16px root. Set <code>data-density="compact"</code> on the root of the popup; the website needs nothing.</p>
      </div>
      <div>
        <h3 class="g-h3">Space</h3>
        <div class="g-spaces">
          ${spaces.map(([n, px]) => `<div class="g-space"><code>--space-${n}</code><span class="fig">${px}</span><i style="width:${px}px"></i></div>`).join("")}
        </div>
        <p class="t-fine g-note">A 4px base. The page column is 1248px with 16 to 48px gutters; running text is held to 34em. Everything is left-aligned. Nothing is centred.</p>
      </div>
    </div>

    <div class="g-cols g-cols--3">
      <div>
        <h3 class="g-h3">Line and corner</h3>
        <div class="g-lines">
          <p><i style="border-top:var(--hair) solid var(--rule-strong)"></i><span><code>--hair</code> 1px. Every rule and every outline.</span></p>
          <p><i style="border-top:var(--line) solid var(--waterline)"></i><span><code>--line</code> 2px. The waterline, the bed line, the focus ring, the selected tab.</span></p>
          <p><i class="g-corner" style="border-radius:var(--radius-control)"></i><span><code>--radius-control</code> 2px. Controls only: enough to stop a 1px outline chipping at 1x.</span></p>
          <p><i class="g-corner"></i><span><code>--radius-0</code>. Bands, rows, tables, figures, sheets, the popup. Nothing is a pill and nothing is a card.</span></p>
        </div>
      </div>
      <div>
        <h3 class="g-h3">Focus</h3>
        <div class="g-focus">
          <div class="water" data-depth="120"><button class="btn btn--primary is-focus" type="button">In water</button><button class="btn btn--secondary is-focus" type="button">In water</button></div>
          <div class="land"><button class="btn btn--primary is-focus" type="button">On land</button><button class="btn btn--secondary is-focus" type="button">On land</button></div>
        </div>
        <p class="t-fine g-note">A 2px ring, 2px clear of the element. Buff in water, the land&rsquo;s own ink on land. Shown for keyboard focus on every interactive element, in both palettes.</p>
      </div>
      <div>
        <h3 class="g-h3">Motion</h3>
        <table class="table">
          <tbody>
            <tr><th scope="row"><code>--dur-1</code></th><td class="num">120 ms</td><td>Colour on hover and press</td></tr>
            <tr><th scope="row"><code>--dur-2</code></th><td class="num">200 ms</td><td>A small part moves: toggle, tab line</td></tr>
            <tr><th scope="row"><code>--dur-3</code></th><td class="num">320 ms</td><td>A surface arrives: sheet, toast</td></tr>
            <tr><th scope="row"><code>--dur-sounding</code></th><td class="num">900 ms</td><td>Soundings drop, once, after a scan</td></tr>
          </tbody>
        </table>
        <p class="t-fine g-note">Motion only answers an action. Nothing moves on load or on scroll. With reduced motion every duration collapses and the working dashes stand still.</p>
      </div>
    </div>
  </div>
</section>`;

/* ---------------------------------------------------------------- components */

const btnRow = (kind, label, icon) =>
  states([
    ["Default", `<button class="btn btn--${kind}" type="button">${icon ? ic(icon) : ""}${label}</button>`],
    ["Hover", `<button class="btn btn--${kind} is-hover" type="button" tabindex="-1">${icon ? ic(icon) : ""}${label}</button>`],
    ["Pressed", `<button class="btn btn--${kind} is-active" type="button" tabindex="-1">${icon ? ic(icon) : ""}${label}</button>`],
    ["Focus", `<button class="btn btn--${kind} is-focus" type="button" tabindex="-1">${icon ? ic(icon) : ""}${label}</button>`],
    ["Disabled", `<button class="btn btn--${kind}" type="button" disabled>${icon ? ic(icon) : ""}${label}</button>`],
    ["Working", `<button class="btn btn--${kind}" type="button" aria-busy="true" tabindex="-1">${icon ? ic(icon) : ""}${label}</button>`],
  ]);

const components = () => `
<section class="band water" data-depth="120" id="components" aria-labelledby="comp-t" style="padding-top:0">
  <div class="wrap">
    <div class="section-head">
      <h2 class="t-display-2" id="comp-t">Ruled, flat and quiet.</h2>
      <p class="t-lede">Hairlines and tints do the structural work. No shadows, no gradients, no cards. Every state is shown; the pinned ones are generated from the package&rsquo;s own rules.</p>
    </div>
    <div class="g-density-switch">
      <span class="t-label" id="dens-label">Show the components at</span>
      <div class="segmented" role="radiogroup" aria-labelledby="dens-label" data-switch="density">
        <button type="button" role="radio" aria-checked="true" data-value="comfortable">Comfortable</button>
        <button type="button" role="radio" aria-checked="false" data-value="compact">Compact</button>
      </div>
    </div>

    <div class="g-specs" id="specs" data-density="comfortable">
    ${spec(
      "Button",
      "Primary is the one action a view exists for: a buff block to stand on. Secondary is an outline. Quiet has no edge until hovered. A label is a plain verb; it never ends in an arrow.",
      `${sub("Primary")}${btnRow("primary", "Send privately", "send")}
       ${sub("Secondary")}${btnRow("secondary", "Dive in", "dive")}
       ${sub("Quiet")}${btnRow("quiet", "All activity")}
       ${sub("Sizes, icon only, stacked")}
       ${states([
         ["Large", `<button class="btn btn--primary btn--lg" type="button">Scan this address</button>`],
         ["Medium", `<button class="btn btn--primary" type="button">Scan this address</button>`],
         ["Small", `<button class="btn btn--secondary btn--sm" type="button">Join the waitlist</button>`],
         ["Icon only", `<button class="btn btn--secondary btn--icon" type="button" aria-label="Refresh">${ic("refresh")}</button>`],
         ["Icon only, quiet", `<button class="btn btn--quiet btn--icon btn--sm" type="button" aria-label="Close">${ic("close")}</button>`],
         ["Stacked", `<button class="btn btn--secondary btn--stacked" type="button" style="width:6.75rem">${ic("surface")}Surface</button>`],
       ])}
       ${sub("On land")}
       <div class="g-on-land land">${states([
         ["Primary", `<button class="btn btn--primary" type="button">Join the waitlist</button>`],
         ["Hover", `<button class="btn btn--primary is-hover" type="button" tabindex="-1">Join the waitlist</button>`],
         ["Secondary", `<button class="btn btn--secondary" type="button">Read the cautions</button>`],
         ["Hover", `<button class="btn btn--secondary is-hover" type="button" tabindex="-1">Read the cautions</button>`],
         ["Focus", `<button class="btn btn--secondary is-focus" type="button" tabindex="-1">Read the cautions</button>`],
         ["Disabled", `<button class="btn btn--primary" type="button" disabled>Join the waitlist</button>`],
       ])}</div>`,
      { code: '<button class="btn btn--primary">…</button>' },
    )}

    ${spec(
      "Link",
      "A link in running text needs no class. A button that reads as a link takes .link. The quiet link states a status at the end of a row and acts on it: one size down, in the secondary ink, never louder than what it sits beside.",
      `${states([
        ["Link", `<button class="link" type="button">Copy the address</button>`],
        ["Hover", `<button class="link is-hover" type="button" tabindex="-1">Copy the address</button>`],
        ["Focus", `<button class="link is-focus" type="button" tabindex="-1">Copy the address</button>`],
        ["Disabled", `<button class="link" type="button" disabled>Copy the address</button>`],
      ])}
      ${sub("Quiet: a status that can be pressed")}
      ${states([
        ["Quiet", `<a class="link link--quiet" href="#c-link">Receive</a>`],
        ["Hover", `<a class="link link--quiet is-hover" href="#c-link" tabindex="-1">Receive</a>`],
        ["Focus", `<a class="link link--quiet is-focus" href="#c-link" tabindex="-1">Receive</a>`],
        ["With a time", `<button class="link link--quiet fig" type="button" title="Press to sync with the chain now.">Synced 14:02</button>`],
        ["Working", `<button class="link link--quiet fig" type="button" aria-busy="true" tabindex="-1">Syncing</button>`],
        ["Caution", `<button class="link link--quiet link--caution" type="button" title="The RPC endpoint did not answer. Press to try again.">${ic("caution")}Cannot reach RPC</button>`],
        ["Disabled", `<button class="link link--quiet" type="button" disabled>Receive</button>`],
      ])}
      ${sub("At the end of a row, and on land")}
      <div class="g-fields g-fields--2">
        <div class="g-link-demo water" data-depth="60">
          <section class="balance balance--shielded" aria-label="Shielded balance, with its sync state">
            <div class="balance__row"><p class="balance__label">Shielded balance</p><button class="link link--quiet fig" type="button" title="Press to sync with the chain now.">Synced 14:02</button></div>
            <p class="balance__figure">${soundingHtml(sol("12480739112"))}<span class="fig-unit">devnet SOL</span></p>
            <div class="balance__row"><p class="balance__note">In the Loch. Visible only to you.</p><a class="link link--quiet" href="#c-link">Receive</a></div>
          </section>
        </div>
        <div class="g-on-land land">${states([
          ["Link", `<button class="link" type="button">Copy the address</button>`],
          ["Quiet", `<a class="link link--quiet" href="#c-link">All activity</a>`],
          ["Working", `<button class="link link--quiet fig" type="button" aria-busy="true" tabindex="-1">Scanning</button>`],
          ["Caution", `<button class="link link--quiet link--caution" type="button">${ic("caution")}Scan failed</button>`],
        ])}</div>
      </div>`,
      { code: '<button class="link link--quiet fig">Synced 14:02</button>' },
    )}

    ${spec(
      "Field and text input",
      "A label above, a hint below, and when something is wrong a sentence that says what happened and what to do. The error is announced and the field is marked aria-invalid.",
      `<div class="g-fields">
        <div class="field"><label class="field__label" for="f1">Email address</label><input class="input" id="f1" type="email" placeholder="you@example.com" autocomplete="off" aria-describedby="f1h"><p class="field__hint" id="f1h">Used for two emails and nothing else.</p></div>
        <div class="field"><label class="field__label" for="f2">Hover</label><input class="input is-hover" id="f2" type="text" value="nessie@example.com" tabindex="-1"></div>
        <div class="field"><label class="field__label" for="f3">Focus</label><input class="input is-focus" id="f3" type="text" value="nessie@example.com" tabindex="-1"></div>
        <div class="field"><label class="field__label" for="f4">Error</label><input class="input" id="f4" type="text" value="nessie@" aria-invalid="true" aria-describedby="f4e"><p class="field__error" id="f4e">${ic("caution")}<span>That email address is not complete. Check it and try again.</span></p></div>
        <div class="field"><label class="field__label" for="f5">Disabled</label><input class="input" id="f5" type="text" value="Not available on devnet" disabled></div>
        <div class="field"><label class="field__label" for="f6">Read only</label><input class="input" id="f6" type="text" value="${me}" readonly></div>
        <div class="field g-fields__wide"><label class="field__label" for="f7">Note <small>(optional)</small></label><textarea class="input" id="f7" rows="2" placeholder="Only you will see this note"></textarea></div>
      </div>`,
      { code: '<div class="field"><label class="field__label">…</label><input class="input">…</div>' },
    )}

    ${spec(
      "Address input",
      "A Solana address is set in tabular figures, never in a monospace. Once it is valid it is repeated underneath in groups of four, so it can be checked by eye before anything is signed.",
      `<div class="g-fields g-fields--2">
        <div class="field">
          <label class="field__label" for="a1">Solana wallet address</label>
          <div class="input-group input-group--address"><input class="input input--lg" id="a1" type="text" placeholder="Paste an address" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn btn--quiet btn--sm" type="button">Paste</button></div>
          <p class="field__hint">The scan reads public chain data only. It never asks you to connect a wallet or sign anything.</p>
        </div>
        <div class="field">
          <label class="field__label" for="a2">Valid</label>
          <div class="input-group input-group--address"><input class="input input--lg" id="a2" type="text" value="${RECIPIENT}" autocomplete="off" spellcheck="false">${ic("check", "input-group__ok")}</div>
          <p class="address-full">${groupAddress(RECIPIENT)}</p>
        </div>
        <div class="field">
          <label class="field__label" for="a3">Error</label>
          <div class="input-group input-group--address"><input class="input input--lg" id="a3" type="text" value="0xA91f2c44Be07d1" aria-invalid="true" aria-describedby="a3e" autocomplete="off" spellcheck="false"><button class="btn btn--quiet btn--sm" type="button">Paste</button></div>
          <p class="field__error" id="a3e">${ic("caution")}<span>That is not a Solana address. An address has 32 to 44 letters and digits, and never 0, O, I or l.</span></p>
        </div>
        <div class="field">
          <label class="field__label" for="a4">Focus</label>
          <div class="input-group input-group--address is-focus-within"><input class="input input--lg" id="a4" type="text" value="7Yk2" tabindex="-1" autocomplete="off" spellcheck="false"><button class="btn btn--quiet btn--sm" type="button" tabindex="-1">Paste</button></div>
        </div>
      </div>`,
      { code: '<div class="input-group input-group--address">…</div>' },
    )}

    ${spec(
      "Amount input",
      "The figure is typed at display size and follows the lettering rule. Sending privately, the amount is shielded, so it is italic. Diving in or surfacing, the chain sees the amount, so it is upright.",
      `<div class="g-fields g-fields--2">
        <div class="field amount amount--shielded">
          <label class="field__label" for="m1">Amount to send privately</label>
          <div class="amount__box"><input class="amount__input" id="m1" inputmode="decimal" value="1.250" autocomplete="off"><span class="amount__unit">SOL</span><button class="btn btn--quiet btn--sm" type="button">Max</button></div>
          <p class="field__hint">Shielded balance <span class="fig is-shielded">12.480</span> SOL</p>
        </div>
        <div class="field amount amount--public">
          <label class="field__label" for="m2">Amount to dive in with</label>
          <div class="amount__box"><input class="amount__input" id="m2" inputmode="decimal" value="5.000" autocomplete="off"><span class="amount__unit">SOL</span><button class="btn btn--quiet btn--sm" type="button">Max</button></div>
          <p class="field__hint">Public balance <span class="fig is-public">41.207</span> SOL. This deposit will be visible on-chain.</p>
        </div>
        <div class="field amount amount--shielded">
          <label class="field__label" for="m3">Empty</label>
          <div class="amount__box"><input class="amount__input" id="m3" inputmode="decimal" placeholder="0.000" autocomplete="off"><span class="amount__unit">SOL</span><button class="btn btn--quiet btn--sm" type="button">Max</button></div>
        </div>
        <div class="field amount amount--shielded">
          <label class="field__label" for="m4">Error</label>
          <div class="amount__box"><input class="amount__input" id="m4" inputmode="decimal" value="20.000" aria-invalid="true" aria-describedby="m4e" autocomplete="off"><span class="amount__unit">SOL</span><button class="btn btn--quiet btn--sm" type="button">Max</button></div>
          <p class="field__error" id="m4e">${ic("caution")}<span>That is more than your shielded balance of 12.480 SOL. Enter 12.480 or less.</span></p>
        </div>
      </div>`,
      { code: '<div class="field amount amount--shielded">…</div>' },
    )}

    ${spec(
      "Select, checkbox, toggle",
      "Native controls, redrawn square. The toggle is a block that crosses its track, not a pill.",
      `<div class="g-fields">
        <div class="field"><label class="field__label" for="s1">Relayer</label><div class="select"><select class="input" id="s1"><option>Loch devnet relayer</option><option>Custom relayer</option></select></div></div>
        <div class="field"><label class="field__label" for="s2">Focus</label><div class="select"><select class="input is-focus" id="s2" tabindex="-1"><option>Loch devnet relayer</option></select></div></div>
        <div class="field"><label class="field__label" for="s3">Disabled</label><div class="select"><select class="input" id="s3" disabled><option>Mainnet (after both audits)</option></select></div></div>
      </div>
      ${states([
        ["Off", `<label class="choice"><input class="checkbox" type="checkbox"><span>Warn me before a public transfer</span></label>`],
        ["On", `<label class="choice"><input class="checkbox" type="checkbox" checked><span>Warn me before a public transfer</span></label>`],
        ["Focus", `<label class="choice"><input class="checkbox is-focus" type="checkbox" checked tabindex="-1"><span>Warn me</span></label>`],
        ["Disabled", `<label class="choice"><input class="checkbox" type="checkbox" checked disabled><span>Screen deposits</span></label>`],
      ])}
      ${states([
        ["Off", `<label class="choice"><input class="toggle" type="checkbox" role="switch"><span>Leak warnings<small>Check each transfer before you sign it</small></span></label>`],
        ["On", `<label class="choice"><input class="toggle" type="checkbox" role="switch" checked><span>Leak warnings<small>Check each transfer before you sign it</small></span></label>`],
        ["Focus", `<label class="choice"><input class="toggle is-focus" type="checkbox" role="switch" checked tabindex="-1"><span>Leak warnings</span></label>`],
        ["Disabled", `<label class="choice"><input class="toggle" type="checkbox" role="switch" disabled><span>Telemetry<small>There is none to turn on</small></span></label>`],
      ])}`,
    )}

    ${spec(
      "Pick list",
      "A list of things to pick one of: the wallets found on a page, the wallets on this device, the entries of a menu. Ruled rows, as activity is. Pressing a row acts at once, and the words at its end say what that does, or the state the row is in.",
      `<div class="g-fields g-fields--2">
        <div class="g-pick">
          <p class="t-label" id="pick-found">Wallets found on the connect page</p>
          <ul class="picklist g-gap-xs" aria-labelledby="pick-found">
            <li><button class="picklist__row" type="button">${ic("wallet")}<span class="picklist__name">Phantom</span><span class="picklist__go">Connect</span></button></li>
            <li><button class="picklist__row is-hover" type="button" tabindex="-1">${ic("wallet")}<span class="picklist__name">Solflare</span><span class="picklist__go">Connect</span></button></li>
            <li><button class="picklist__row is-focus" type="button" tabindex="-1">${ic("wallet")}<span class="picklist__name">Backpack</span><span class="picklist__go">Connect</span></button></li>
            <li><button class="picklist__row" type="button" disabled>${ic("wallet")}<span class="picklist__name">A hardware wallet</span><span class="picklist__go">Cannot sign messages</span></button></li>
          </ul>
          <p class="t-fine g-gap-xs">Default, hover, focus, disabled.</p>
        </div>
        <div class="g-pick">
          <ul class="picklist" aria-label="Wallets on this device">
            <li><button class="picklist__row" type="button" aria-current="true">${ic("check")}<span class="picklist__name">Phantom <span class="picklist__note fig">${me}</span></span><span class="picklist__go">Showing</span></button></li>
            <li><button class="picklist__row" type="button">${ic("wallet")}<span class="picklist__name">Solflare <span class="picklist__note fig">8sKp…Dn4Y</span></span><span class="picklist__go">Locked</span></button></li>
          </ul>
          <ul class="picklist g-gap-s" aria-label="More">
            <li><a class="picklist__row" href="#c-pick-list">${ic("settings")}<span class="picklist__name">Settings</span><span class="picklist__go">Endpoints, palette, this device</span></a></li>
            <li><a class="picklist__row" href="#c-pick-list"><span class="picklist__name">A row with no icon, whose name is long enough to be cut short</span><span class="picklist__go">Open</span></a></li>
          </ul>
          <p class="t-fine g-gap-xs">The one chosen now is marked aria-current. A row can be a link, and the icon can be left out.</p>
        </div>
      </div>
      ${sub("On land")}
      <div class="g-on-land land"><ul class="picklist g-pick" aria-label="Reports">
        <li><a class="picklist__row" href="#c-pick-list" aria-current="true">${ic("scan")}<span class="picklist__name">Leak report <span class="picklist__note fig">${me}</span></span><span class="picklist__go">Open</span></a></li>
        <li><a class="picklist__row is-hover" href="#c-pick-list" tabindex="-1">${ic("scan")}<span class="picklist__name">Leak report <span class="picklist__note fig">9fRk…2mVd</span></span><span class="picklist__go">Open</span></a></li>
      </ul></div>`,
      { code: '<ul class="picklist"><li><button class="picklist__row">…</button></li></ul>' },
    )}

    ${spec(
      "Disclosure",
      "Something most people can leave closed. It is a native details element, so it opens without JavaScript and from the keyboard. The chevron points along the line when closed and down when open. What is in use now can be said at the end of the line.",
      `<div class="g-fields g-fields--2">
        <details class="disclosure">
          <summary>${ic("chevron", "icon--sm")}<span>Use your own RPC</span><small>Default: api.devnet.solana.com</small></summary>
          <div class="disclosure__body"><p>Point the scan at a node or a provider you trust.</p></div>
        </details>
        <details class="disclosure" open>
          <summary>${ic("chevron", "icon--sm")}<span>Use your own RPC</span><small>Default: api.devnet.solana.com</small></summary>
          <div class="disclosure__body">
            <p>Point the scan at a node or a provider you trust. Its address is kept in this browser only and is sent to nobody.</p>
            <div class="field"><label class="field__label" for="d1">RPC endpoint</label><div class="field-row"><input class="input" id="d1" type="url" placeholder="https://" autocomplete="off"><button class="btn btn--secondary" type="button">Save</button></div></div>
          </div>
        </details>
      </div>
      ${sub("Hover, focus, and several in a row")}
      <div class="g-fields g-fields--2">
        <div>
          <details class="disclosure"><summary class="is-hover" tabindex="-1">${ic("chevron", "icon--sm")}<span>What an observer sees</span></summary><div class="disclosure__body"><p>A proof and the relayer’s fee.</p></div></details>
          <details class="disclosure"><summary class="is-focus" tabindex="-1">${ic("chevron", "icon--sm")}<span>Who screens deposits</span></summary><div class="disclosure__body"><p>A screening authority co-signs each deposit.</p></div></details>
          <details class="disclosure"><summary>${ic("chevron", "icon--sm")}<span>Whether withdrawals can be paused</span></summary><div class="disclosure__body"><p>They cannot. The pause switch stops new deposits and nothing else.</p></div></details>
        </div>
        <div class="g-on-land land">
          <details class="disclosure" open><summary>${ic("chevron", "icon--sm")}<span>On land</span><small>Open</small></summary><div class="disclosure__body"><p>The same component on buff, and on midnight at night.</p></div></details>
        </div>
      </div>`,
      { code: '<details class="disclosure"><summary>…</summary><div class="disclosure__body">…</div></details>' },
    )}

    ${spec(
      "Caution band",
      "Status that must not be missed is printed first, the way a chart prints its cautions: one flat band of magenta. No icon, no animation, no warning yellow.",
      `<p class="caution-band"><strong>Devnet.</strong> Test SOL only. Nothing here has real value.</p>
       <p class="caution-band g-gap-s"><strong>v0.1, devnet only, unaudited.</strong> Nothing here is ready for real funds. <a href="#c-caution-band">Read the cautions</a></p>`,
      { code: '<p class="caution-band">…</p>' },
    )}

    ${spec(
      "Notice",
      "A note printed on the chart: a rule, a title, a sentence. Magenta for a caution. Buff for something that happened: there is no green in this system.",
      `<div class="g-fields g-fields--3">
        <div class="notice notice--caution"><p class="notice__title">${ic("caution")}This will be public</p><p>Surfacing 5.000 SOL a few minutes after diving in with 5.000 SOL links the two. Surface a different amount, or wait.</p><div class="notice__actions"><button class="btn btn--secondary btn--sm" type="button">Change the amount</button></div></div>
        <div class="notice"><p class="notice__title">${ic("info")}Deposits are screened</p><p>A screening authority co-signs each deposit and can refuse funds from flagged sources.</p></div>
        <div class="notice notice--done"><p class="notice__title">${ic("check")}Dived in</p><p><span class="fig is-public">5.000</span> SOL is in the Loch. The deposit is public; what you do with it now is not.</p></div>
      </div>
      <div class="g-fields g-fields--3 g-gap-s">
        <p class="notice notice--inline notice--caution">${ic("caution")}<span>This recipient is an identified service.</span></p>
        <p class="notice notice--inline">${ic("info")}<span>Withdrawals cannot be paused.</span></p>
        <p class="notice notice--inline notice--done">${ic("check")}<span>Address copied.</span></p>
      </div>
      <div class="g-add">
        ${sub("With its reasons")}
        <div class="g-fields g-fields--2">
          <div class="notice notice--caution" role="status">
            <p class="notice__title">${ic("caution")}This withdrawal points back at your deposit</p>
            <ul class="reasons">
              <li>It goes to the address you dived in from.</li>
              <li>It is the same amount as your dive-in today 14:02.</li>
              <li>It comes soon after it: you dived in today 14:02.</li>
            </ul>
            <p>You can still surface. Another amount, later, to a fresh address gives less away.</p>
          </div>
          <div class="notice">
            <p class="notice__title">${ic("info")}What the scan will read</p>
            <ul class="reasons">
              <li>The latest 100 transactions of the address.</li>
              <li>Its balance, and how many token accounts it owns.</li>
            </ul>
          </div>
        </div>
        ${sub("Status: the answer to a form, shown by the page’s address or by script")}
        <div class="g-fields g-fields--2">
          <div class="notice notice--done notice--status" id="status-joined" tabindex="-1" data-shown><p class="notice__title">${ic("check")}Joined the waitlist</p><p>You will get one message when the devnet alpha is ready to try, and one when the audited release is.</p></div>
          <div class="notice notice--caution notice--status" id="status-refused" tabindex="-1" data-shown><p class="notice__title">${ic("caution")}That address was not accepted</p><p>Nothing was stored. Check the address for typing mistakes and join again.</p></div>
        </div>
        <p class="t-small g-gap-s">Those two are shown by <code>data-shown</code>. The next one has no attribute and is shown only when the address of this page ends in its id, which needs no JavaScript: <a href="#status-answer">show it</a>, <a href="#c-notice">put it away</a>.</p>
        <div class="notice notice--done notice--status g-gap-s" id="status-answer" tabindex="-1"><p class="notice__title">${ic("check")}Shown by the address of this page</p><p>This notice is here because the address ends in #status-answer. A service answers a plain form post by sending the browser back to the fragment of the answer.</p></div>
      </div>`,
      { code: '<div class="notice notice--caution">…</div>' },
    )}

    ${spec(
      "Waterline and contour",
      "The waterline is the one hard line: land above it, water below it, always. A contour divides water from deeper water and is lettered with its depth, in small sloping figures, as a chart letters one.",
      `<div class="g-wl">
        <div class="land g-wl__land"><span class="t-label">Land: public</span></div>
        <hr class="waterline">
        <div class="water g-wl__water" data-depth="0"><span class="is-shielded">Water: shielded</span></div>
        <div class="contour" aria-hidden="true" style="background:linear-gradient(var(--water-0) 50%, var(--water-20) 50%)"><span>20 m</span></div>
        <div class="water g-wl__water" data-depth="20"></div>
        <div class="contour" aria-hidden="true" style="background:linear-gradient(var(--water-20) 50%, var(--water-60) 50%)"><span>60 m</span></div>
        <div class="water g-wl__water" data-depth="60"></div>
      </div>`,
      { code: '<hr class="waterline">  <div class="contour"><span>20 m</span></div>' },
    )}

    ${spec(
      "Page head",
      "A page that is not the first one has no mirrored headline. Its title stands on land, above the one waterline, and its text is in the water under it. The line under the title is said more quietly.",
      `<div class="g-page">
        <div class="land">
          <div class="wrap page-head">
            <p class="t-display-1">What this site keeps.</p>
            <p class="t-lede">Nothing, unless you give it an email address. This page says what that means, line by line.</p>
          </div>
        </div>
        <hr class="waterline">
        <div class="page water" data-depth="0">
          <div class="wrap">
            <dl class="deflist">
              <div class="deflist__row"><dt>What is stored</dt><dd>Nothing about you, with one exception: if you join the waitlist, your email address and the day you joined.</dd></div>
              <div class="deflist__row"><dt>Cookies</dt><dd>None. The site sets no cookies and reads none.</dd></div>
            </dl>
          </div>
        </div>
      </div>
      <p class="t-fine g-gap-s">The title is the page’s h1. Land, then <code>hr.waterline</code>, then <code>.page.water</code>: one waterline, land above it, as on every surface.</p>`,
      { code: '<div class="land"><div class="wrap page-head">…</div></div><hr class="waterline"><div class="page water">…</div>' },
    )}

    ${spec(
      "Definition rows",
      "Ruled term and description. The cautions are lettered in magenta; the commitments are not. The key and value form is for review before signing.",
      `<div class="g-fields g-fields--2">
        <section class="deflist deflist--caution" aria-labelledby="dl1"><h3 class="deflist__title" id="dl1">Cautions</h3><dl>
          <div class="deflist__row"><dt>Devnet only</dt><dd>Loch v0.1 is for Solana devnet and test SOL. There is no mainnet deployment and nowhere to send real funds.</dd></div>
          <div class="deflist__row"><dt>Unaudited</dt><dd>Neither the circuit nor the program has had an external audit. Mainnet waits for both.</dd></div>
        </dl></section>
        <section class="deflist" aria-labelledby="dl2"><h3 class="deflist__title" id="dl2">Commitments</h3><dl>
          <div class="deflist__row"><dt>Withdrawals always open</dt><dd>The pause switch stops new deposits and nothing else. Nobody, including us, can stop you surfacing.</dd></div>
          <div class="deflist__row"><dt>No analytics</dt><dd>No cookies, no trackers, no third-party requests. The extension sends no telemetry.</dd></div>
        </dl></section>
      </div>
      <dl class="deflist deflist--kv g-gap g-kv">
        <div class="deflist__row"><dt>To</dt><dd><span class="fig is-shielded">${to}</span></dd></div>
        <div class="deflist__row"><dt>Amount</dt><dd><span class="fig is-shielded">1.250</span> SOL</dd></div>
        <div class="deflist__row"><dt>Relayer fee</dt><dd><span class="fig is-public">0.000005</span> SOL</dd></div>
      </dl>`,
      { code: '<section class="deflist deflist--caution">…</section>' },
    )}

    ${spec(
      "Data table",
      "Hairline rows, sentence-case heads in secondary ink, figures right-aligned and tabular.",
      `<div class="table-scroll" tabindex="0" role="group" aria-label="Findings and their penalties"><table class="table table--interactive">
        <thead><tr><th scope="col">Finding</th><th scope="col">Fires when</th><th scope="col">Severity</th><th scope="col" class="num">Penalty</th></tr></thead>
        <tbody>
          <tr><th scope="row">Funding source is public</th><td>The wallet ever received anything</td><td><span class="sev" data-sev="high">High</span></td><td class="num">20</td></tr>
          <tr><th scope="row">Recurring counterparties</th><td>An address appears three times or more</td><td><span class="sev" data-sev="medium">Medium</span></td><td class="num">4 each</td></tr>
          <tr class="is-hover"><th scope="row">Your time zone is guessable</th><td>The quietest six hours hold under 5%</td><td><span class="sev" data-sev="medium">Medium</span></td><td class="num">10</td></tr>
          <tr><th scope="row">Balance is visible to everyone</th><td>Over 10 SOL or over 10 token accounts</td><td><span class="sev" data-sev="low">Low</span></td><td class="num">5</td></tr>
        </tbody>
      </table></div>`,
      { code: '<table class="table">…</table>' },
    )}

    ${spec(
      "Activity row",
      "The lettering rule where it matters most. A deposit is upright because the chain saw it; a private transfer is italic because it did not. The legend sits wherever both kinds meet.",
      `<div class="g-activity">
        <ul class="activity">
          <li class="activity__row is-public">${ic("dive")}<span class="activity__main"><span class="activity__title">Dived in</span><span class="activity__meta">From ${me}, today 14:02</span></span><span class="activity__amount fig"><span class="fig-sign">+</span>5.000</span></li>
          <li class="activity__row is-shielded">${ic("send")}<span class="activity__main"><span class="activity__title">Sent privately</span><span class="activity__meta">Yesterday 19:40</span></span><span class="activity__amount fig"><span class="fig-sign">−</span>1.250</span></li>
          <li class="activity__row is-shielded">${ic("receive")}<span class="activity__main"><span class="activity__title">Received privately</span><span class="activity__meta">28 Sep</span></span><span class="activity__amount fig"><span class="fig-sign">+</span>0.730</span></li>
          <li class="activity__row is-public">${ic("surface")}<span class="activity__main"><span class="activity__title">Surfaced</span><span class="activity__meta">To 9fRk…2mVd, 26 Sep</span></span><span class="activity__amount fig"><span class="fig-sign">−</span>2.000</span></li>
          <li class="activity__row is-shielded" data-state="pending">${ic("send")}<span class="activity__main"><span class="activity__title">Sending privately</span><span class="activity__meta">Generating the proof</span></span><span class="activity__amount fig"><span class="fig-sign">−</span>0.400</span></li>
        </ul>
        <p class="legend g-gap-s"><span>Upright is public on-chain.</span><span class="is-shielded">Italic is shielded.</span></p>
      </div>`,
      { code: '<li class="activity__row is-shielded">…</li>' },
    )}

    ${spec(
      "Balance and score",
      "The shielded balance is a sounding. The public balance and the privacy score are upright: the score is worked out from public history, so anyone can know it.",
      `<div class="g-fields g-fields--balance">
        <section class="balance balance--shielded"><p class="balance__label">Shielded balance</p><p class="balance__figure">${soundingHtml(sol("12480739112"))}<span class="fig-unit">devnet SOL</span></p><p class="balance__note">In the Loch. Visible only to you.</p></section>
        <section class="balance balance--public"><p class="balance__label">Public balance</p><p class="balance__figure"><span class="figure is-public">41.207</span><span class="fig-unit">SOL</span></p><p class="balance__note">Anyone can read this.</p></section>
        <div class="score"><p class="score__label">Privacy score</p><p class="score__figure"><span class="figure figure--xl is-public">${score}</span><span class="score__of">of 100</span></p><p class="score__verdict">Shallow water. Most of this wallet&rsquo;s story can be read from the surface.</p></div>
      </div>
      <div class="g-add">
        ${sub("An amount too small to show is never drawn as zero")}
        <div class="g-fields g-fields--balance">
          <section class="balance balance--shielded"><p class="balance__label">Shielded balance</p><p class="balance__figure">${soundingHtml(sol("5000"))}<span class="fig-unit">devnet SOL</span></p><p class="balance__note">It holds <span class="fig is-shielded">0.000005</span> SOL: less than a thousandth, and not nothing.</p></section>
          <section class="balance balance--shielded"><p class="balance__label">Shielded balance</p><p class="balance__figure">${soundingHtml(sol("0"))}<span class="fig-unit">devnet SOL</span></p><p class="balance__note">Nothing in the Loch yet.</p></section>
        </div>
      </div>`,
      { code: '<span class="sounding">12<span class="sounding__frac">.480</span></span>' },
    )}

    ${spec(
      "Severity, flag, address chip",
      "Severity is a word in a box, and only High takes the caution ink. An address is shortened to four and four, with a copy action.",
      `${states([
        ["High", `<span class="sev" data-sev="high">High</span>`],
        ["Medium", `<span class="sev" data-sev="medium">Medium</span>`],
        ["Low", `<span class="sev" data-sev="low">Low</span>`],
        ["Flag", `<span class="flag">Example report</span>`],
      ])}
      ${states([
        ["Address chip", `<span class="address-chip"><span class="address-chip__text fig">${me}</span><button class="address-chip__copy" type="button" aria-label="Copy address ${me}" data-copy="${WALLET}">${ic("copy", "icon--sm")}</button></span>`],
        ["Hover", `<span class="address-chip"><span class="address-chip__text fig">${me}</span><button class="address-chip__copy is-hover" type="button" tabindex="-1" aria-label="Copy">${ic("copy", "icon--sm")}</button></span>`],
        ["Focus", `<span class="address-chip"><span class="address-chip__text fig">${me}</span><button class="address-chip__copy is-focus" type="button" tabindex="-1" aria-label="Copy">${ic("copy", "icon--sm")}</button></span>`],
        ["Copied", `<span class="address-chip" data-copied><span class="address-chip__text fig">${me}</span><button class="address-chip__copy" type="button" tabindex="-1" aria-label="Copied">${ic("check", "icon--sm")}</button></span>`],
        ["Wallet switch", `<button class="address-chip" type="button" aria-label="Connected wallet: Phantom, ${me}. Switch wallet"><span class="address-chip__name">Phantom</span><span class="address-chip__text fig">${me}</span>${ic("chevron", "icon--sm")}</button>`],
      ])}
      <p class="address-full g-gap-s">${groupAddress(WALLET)}</p>
      <div class="g-add">
        ${sub("A shielded address keeps its prefix whole")}
        <p><span class="address-chip"><span class="address-chip__text fig is-shielded">${shortAddress(SHIELDED)}</span><button class="address-chip__copy" type="button" aria-label="Copy shielded address ${shortAddress(SHIELDED)}" data-copy="${SHIELDED}">${ic("copy", "icon--sm")}</button></span></p>
        <p class="address-full is-shielded g-gap-s">${groupAddress(SHIELDED)}</p>
      </div>`,
      { code: '<span class="address-chip">…</span>' },
    )}

    ${spec(
      "Tabs and segmented control",
      "The selected tab stands on a short length of waterline. A segmented control is for two or three exclusive choices; the chosen one is a buff block.",
      `<div class="tabs" role="tablist" aria-label="Views">
        <button class="tabs__tab" type="button" role="tab" aria-selected="true">Balance</button>
        <button class="tabs__tab" type="button" role="tab" aria-selected="false" tabindex="-1">Activity</button>
        <button class="tabs__tab is-hover" type="button" role="tab" aria-selected="false" tabindex="-1">Leak report</button>
        <button class="tabs__tab is-focus" type="button" role="tab" aria-selected="false" tabindex="-1">Settings</button>
        <button class="tabs__tab" type="button" role="tab" aria-selected="false" tabindex="-1" disabled>Viewing keys</button>
      </div>
      ${states(
        [
          ["Default", `<div class="segmented" role="radiogroup" aria-label="Show"><button type="button" role="radio" aria-checked="true">All</button><button type="button" role="radio" aria-checked="false">Public</button><button type="button" role="radio" aria-checked="false">Shielded</button></div>`],
          ["Hover, focus", `<div class="segmented" role="radiogroup" aria-label="Show"><button type="button" role="radio" aria-checked="false" tabindex="-1">All</button><button class="is-hover" type="button" role="radio" aria-checked="false" tabindex="-1">Public</button><button class="is-focus" type="button" role="radio" aria-checked="true" tabindex="-1">Shielded</button></div>`],
          ["Disabled", `<div class="segmented" role="radiogroup" aria-label="Network"><button type="button" role="radio" aria-checked="true">Devnet</button><button type="button" role="radio" aria-checked="false" disabled>Mainnet</button></div>`],
        ],
        "g-gap",
      )}`,
      { code: '<div class="tabs" role="tablist">…</div>' },
    )}

    ${spec(
      "Progress",
      "A proof takes several seconds. The line is a sounding being taken: dashed for what is still to do, solid for what is done, with one plain sentence for what is happening now. Never a percentage that is not known.",
      `<div class="g-fields g-fields--2">
        <div class="progress" style="--progress:0.46" role="group" aria-label="Sending privately">
          <div class="progress__line" aria-hidden="true"><span></span></div>
          <ol class="progress__stages"><li data-state="done">Checked</li><li data-state="now" aria-current="step">Proving</li><li>Sending</li><li>Confirmed</li></ol>
          <p class="progress__status"><span>Generating the proof on this device. About 8 seconds.</span><span class="fig">0:05</span></p>
        </div>
        <div class="progress" style="--progress:0.72" data-state="failed" role="group" aria-label="Sending privately">
          <div class="progress__line" aria-hidden="true"><span></span></div>
          <ol class="progress__stages"><li data-state="done">Checked</li><li data-state="done">Proved</li><li data-state="now" aria-current="step">Sending</li><li>Confirmed</li></ol>
          <p class="progress__status"><span>The relayer did not answer in time. It may have received the request.</span><span class="fig">0:31</span></p>
        </div>
        <div><span class="working" role="progressbar" aria-label="Reading the chain"></span><p class="t-small g-gap-s">Reading 300 transactions from your RPC node.</p></div>
        <div class="progress" style="--progress:1" role="group" aria-label="Sending privately">
          <div class="progress__line" aria-hidden="true"><span></span></div>
          <ol class="progress__stages"><li data-state="done">Checked</li><li data-state="done">Proved</li><li data-state="done">Sent</li><li data-state="now">Confirmed</li></ol>
          <p class="progress__status"><span>Sent privately. The chain shows a proof and a fee, nothing else.</span><span class="fig">0:14</span></p>
        </div>
      </div>`,
      { code: '<div class="progress" style="--progress: 0.46">…</div>' },
    )}

    ${spec(
      "Sheet, dialog, toast",
      "A deeper tint, a hairline and a plain scrim. A sheet rises from the bed of the popup; a dialog sits in the page. Neither casts a shadow.",
      `<div class="g-fields g-fields--2">
        <div class="g-sheet-demo water" data-depth="60">
          <div class="scrim"></div>
          <section class="sheet" role="group" aria-labelledby="sh1">
            <header class="sheet__head"><h3 class="sheet__title" id="sh1">Surface</h3><button class="btn btn--quiet btn--icon btn--sm" type="button" aria-label="Close">${ic("close")}</button></header>
            <div class="sheet__body"><dl class="deflist deflist--kv">
              <div class="deflist__row"><dt>To</dt><dd><span class="fig is-public">9fRk…2mVd</span></dd></div>
              <div class="deflist__row"><dt>Amount</dt><dd><span class="fig is-public">2.000</span> SOL</dd></div>
            </dl></div>
            <footer class="sheet__foot"><button class="btn btn--secondary" type="button">Cancel</button><button class="btn btn--primary" type="button">Surface</button></footer>
          </section>
        </div>
        <div class="g-toasts">
          <div class="toast toast--done">${ic("check")}<p>Surfaced. <span class="fig is-public">2.000</span> SOL sent to 9fRk…2mVd.</p></div>
          <div class="toast">${ic("info")}<p>Address copied.</p></div>
          <div class="toast toast--caution">${ic("caution")}<p>The RPC node did not answer. Check your connection and try again.</p><button class="btn btn--quiet btn--sm" type="button">Try again</button></div>
          <button class="btn btn--secondary" type="button" data-open="demo-dialog">Open a dialog</button>
        </div>
      </div>
      <dialog class="dialog" id="demo-dialog" aria-labelledby="dg1">
        <header class="sheet__head"><h3 class="sheet__title" id="dg1">Remove this wallet from Loch</h3><button class="btn btn--quiet btn--icon btn--sm" type="button" aria-label="Close" data-close>${ic("close")}</button></header>
        <div class="sheet__body stack"><p class="t-small">Your shielded balance stays in the Loch. To see it again, connect the same wallet and sign the same message.</p></div>
        <footer class="sheet__foot"><button class="btn btn--secondary" type="button" data-close>Keep it</button><button class="btn btn--primary" type="button" data-close>Remove</button></footer>
      </dialog>`,
      { code: '<dialog class="sheet">…</dialog>' },
    )}

    ${spec(
      "Loading, empty, failure",
      "Loading is unsurveyed water: a chart marks what it has not measured with a broken line, and so do we. Empty says what is not here yet and what to do. Failure says what happened, whether funds moved, and what to do next.",
      `<div class="g-fields g-fields--3">
        <div><div class="skeleton" role="status" aria-label="Loading activity"><span></span><span></span><span></span></div></div>
        <div class="empty"><p class="empty__title">Nothing in the Loch yet</p><p>Dive in to move test SOL from your public wallet into your shielded balance.</p><button class="btn btn--primary btn--sm" type="button">${ic("dive")}Dive in</button></div>
        <div class="failure" role="group" aria-label="Error"><p class="failure__title">${ic("caution")}The relayer did not answer in time</p><p>It may have received the request. The chain does not show the transfer so far.</p><p class="failure__detail">relayer.devnet timed out after 20 s</p><div class="cluster"><button class="btn btn--primary btn--sm" type="button">Try again</button><button class="btn btn--quiet btn--sm" type="button">Settings</button></div></div>
      </div>`,
      {
        code: '<div class="failure">…</div>',
        after: `<div class="g-add">
        ${sub("A figure that has not been read yet")}
        <div class="g-fields g-fields--balance">
          <section class="balance balance--shielded"><p class="balance__label">Shielded balance</p><p class="balance__figure"><span class="sounding is-unsurveyed" role="img" aria-label="Locked"></span><span class="fig-unit">devnet SOL</span></p><p class="balance__note">Locked. One signature from Phantom unlocks it.</p></section>
          <section class="balance balance--public"><p class="balance__label">Public balance</p><p class="balance__figure"><span class="figure is-public is-unsurveyed" role="img" aria-label="Not read yet"></span><span class="fig-unit">SOL</span></p><p class="balance__note">Reading the chain.</p></section>
          <div class="score"><p class="score__label">Privacy score</p><p class="score__figure"><span class="figure figure--xl is-public is-unsurveyed" role="img" aria-label="Not scanned yet"></span><span class="score__of">of 100</span></p><p class="score__verdict">Not scanned yet. A scan reads public history only.</p></div>
        </div>
        <div class="g-fields g-fields--2 g-gap">
          <dl class="deflist deflist--kv g-kv">
            <div class="deflist__row"><dt>Relayer fee</dt><dd><span class="fig is-unsurveyed" role="img" aria-label="Not known yet"></span> SOL</dd></div>
            <div class="deflist__row"><dt>Leaves your shielded balance</dt><dd><span class="fig is-shielded">11.230</span> SOL</dd></div>
          </dl>
          <div class="g-on-land land"><div class="balance balance--public"><p class="balance__label">Public balance</p><p class="balance__figure"><span class="figure is-public is-unsurveyed" role="img" aria-label="Not read yet"></span><span class="fig-unit">SOL</span></p></div></div>
        </div>
        <p class="t-fine g-gap-s">The broken line stands where the figure will stand and is about as long, so nothing moves when it arrives. A figure that is not known is never written 0.000.</p>
      </div>`,
      },
    )}

    ${spec(
      "Stepped figure",
      "A page that cannot measure its column (a static page, a page read without JavaScript) carries a figure drawn at several widths, and shows the widest that fits. Here the same figure stands in three columns; each shows one drawing.",
      `<div class="g-fits">
        ${[
          ["a", "A column 300px wide."],
          ["b", "430px wide, or as wide as this screen allows."],
          ["c", "600px wide, or as wide as this screen allows."],
        ]
          .map(([key, caption]) => `<figure class="chart g-fit g-fit--${key}">${fitHtml((width) => byHourSvg(FLOWS, { width, id: `fit-${key}-${width}` }), { widths: [280, 400, 568] })}<figcaption class="chart__caption">${caption}</figcaption></figure>`)
          .join("")}
      </div>
      <p class="t-fine g-gap-s">Each carries the same three drawings, made at 280, 400 and 568px, and shows the widest that fits it: on a wide screen, one of each. A container query chooses; the others are not displayed, so a screen reader meets the figure once. With JavaScript, draw once at the column’s width instead and redraw when it changes.</p>`,
      { code: 'fitHtml((width) => byHourSvg(flows, { width }), { max: 568 })' },
    )}

    ${spec(
      "Code",
      "The only place the monospace appears. It is the system face: no font is loaded for it.",
      `<div class="code"><pre tabindex="0" role="group" aria-label="Command to run the scanner"><code>npx tsx src/scan.ts &lt;ADDRESS&gt; --rpc &lt;RPC_URL&gt;</code></pre><button class="btn btn--quiet btn--sm" type="button" data-copy="npx tsx src/scan.ts <ADDRESS> --rpc <RPC_URL>">${ic("copy", "icon--sm")}Copy</button></div>
      <p class="t-small g-gap-s">Inline: set <code>data-theme="night"</code> on the root element.</p>
      <div class="g-add">
        ${sub("A long line scrolls inside the box, and the box can be reached from the keyboard")}
        <div class="g-fields g-fields--2">
          <div class="code"><pre class="is-focus" tabindex="0" role="group" aria-label="A long command"><code>pnpm --filter loch-scanner scan ${WALLET} --rpc https://api.devnet.solana.com --limit 300</code></pre></div>
          <div class="code code--wrap"><pre><code>pnpm --filter loch-scanner scan ${WALLET} --rpc https://api.devnet.solana.com --limit 300</code></pre></div>
        </div>
        <p class="t-fine g-gap-s">Left: the pre takes <code>tabindex="0"</code>, a role and a name, and the ring is drawn round the box. Right: <code>.code--wrap</code> breaks the line instead, so nothing scrolls.</p>
      </div>`,
      { code: '<div class="code"><pre tabindex="0" role="group" aria-label="…"><code>…</code></pre></div>' },
    )}

    ${spec(
      "Icons",
      "Seventeen, drawn on a 20px grid with a 1.5px round stroke, in the chart&rsquo;s own line: a full-width stroke is the waterline, and anything under the surface is dashed. There is no padlock. Shielded is a dashed ring under the line; public is a solid ring above it.",
      `<ul class="g-icons">${ICON_NAMES.map((n) => `<li>${ic(n)}<span>${n}</span></li>`).join("")}</ul>
       <ul class="g-icons g-icons--sizes">
        <li>${ic("send", "icon--sm")}<span>16</span></li><li>${ic("send")}<span>20</span></li><li>${ic("send", "icon--lg")}<span>24</span></li>
        <li class="is-shielded">${ic("shielded")}<span>Shielded</span></li><li class="is-public">${ic("public")}<span>Public</span></li><li class="t-caution">${ic("caution")}<span>Caution</span></li>
       </ul>`,
      { code: '<svg class="icon"><use href="#i-dive"/></svg>' },
    )}

    ${spec(
      "Mark",
      "Nessie in section, on a tile that is the first screen in small: the night sky, the waterline in buff, the water. She is buff where she is exposed and loch blue where she is not, and only her head and neck are above the line. Below 24px use the small drawing. From 96px up there is also her line, not filled in.",
      `<div class="g-marks">
        <figure class="water" data-depth="0"><img src="${P}/mark/mark.svg" width="96" height="96" alt=""><img src="${P}/mark/mark.svg" width="48" height="48" alt=""><img src="${P}/mark/mark.svg" width="32" height="32" alt=""><img src="${P}/mark/mark-small.svg" width="24" height="24" alt=""><img src="${P}/mark/icon-16.png" width="16" height="16" alt=""><figcaption>On water: mark.svg, mark-small.svg at 24, icon-16.png</figcaption></figure>
        <figure data-theme="dusk" class="land"><img src="${P}/mark/mark-on-land.svg" width="96" height="96" alt=""><img src="${P}/mark/mark-on-land.svg" width="48" height="48" alt=""><img src="${P}/mark/mark-on-land.svg" width="32" height="32" alt=""><img src="${P}/mark/mark-small.svg" width="24" height="24" alt=""><img src="${P}/mark/icon-16.png" width="16" height="16" alt=""><figcaption>On buff land: mark-on-land.svg, the same drawing</figcaption></figure>
        <figure data-theme="night" class="land"><img src="${P}/mark/mark-night.svg" width="96" height="96" alt=""><img src="${P}/mark/mark-night.svg" width="48" height="48" alt=""><img src="${P}/mark/mark-night.svg" width="32" height="32" alt=""><img src="${P}/mark/mark-small.svg" width="24" height="24" alt=""><img src="${P}/mark/icon-16.png" width="16" height="16" alt=""><figcaption>Night: mark-night.svg, the same drawing</figcaption></figure>
        <figure class="water g-marks__mono" data-depth="bed">${readFileSync(join(pkg, "mark", "mark-mono.svg"), "utf8").replace("<svg ", '<svg width="96" height="96" ')}<span class="brand"><img src="${P}/mark/mark.svg" width="30" height="30" alt=""><span class="brand__name">Loch</span></span><figcaption>One colour: mark-mono.svg takes currentColor. With the name.</figcaption></figure>
        <figure class="water" data-depth="120"><img src="${P}/mark/mark-line.svg" width="160" height="160" alt=""><img src="${P}/mark/mark-line.svg" width="96" height="96" alt=""><figcaption>Her line: mark-line.svg, from 96px up. An avatar, a title page, a poster.</figcaption></figure>
      </div>`,
    )}
    </div>
  </div>
</section>`;

/* ------------------------------------------------------------------- product */

const observer = (text) => `<p class="observer"><span class="observer__label">An observer sees</span> ${text}</p>`;

const report = () => `
<article class="report water" data-depth="120" id="report" aria-labelledby="report-flag">
  <header class="report__head">
    <span class="flag" id="report-flag">Example report</span>
    <p>This wallet is invented. The findings, penalties and wording are the scanner&rsquo;s own.</p>
  </header>
  <div class="report__body">
    <div class="score">
      <p class="score__label">Privacy score</p>
      <p class="score__figure"><span class="figure figure--xl is-public">${score}</span><span class="score__of">of 100</span></p>
      <p class="score__verdict">Shallow water. Most of this wallet&rsquo;s story can be read from the surface.</p>
      <p class="t-fine">Leak report for <span class="fig">${me}</span>. ${REPORT.scannedTransactions} transactions scanned, ${REPORT.transfers} transfers.</p>
    </div>
    <figure class="chart">
      <div class="g-wide">${steppedBedSvg(REPORT, { width: 700, id: "bed-w" })}</div>
      <div class="g-narrow">${steppedBedSvg(REPORT, { width: 318, id: "bed-n" })}</div>
      <figcaption class="chart__caption">A wallet with no leaks sits 100 deep, out of sight. Each finding takes depth away; the hatching is what it cost. Where the bed ends up is the score.</figcaption>
      <p><button class="btn btn--secondary btn--sm" type="button" data-replay>Take the soundings again</button></p>
    </figure>
  </div>
  <div class="report__section">
    <h3 class="report__title">The same, as a statement</h3>
    ${statementHtml(REPORT, { totalNote: "What helps: a fresh address for each payer, no forwarding of exact amounts, and savings kept in a shielded balance." })}
  </div>
  <div class="report__section">
    <h3 class="report__title">Two more figures, when the scan kept its transfers</h3>
    <div class="report__figures">
      <figure class="chart">
        <div class="g-wide">${byHourSvg(FLOWS, { width: 480, id: "hours-w" })}</div>
        <div class="g-narrow">${byHourSvg(FLOWS, { width: 318, id: "hours-n" })}</div>
        <figcaption class="chart__caption">Transfers by hour of day, UTC. Deeper is busier. The shoal where almost nothing happens is when the owner sleeps, and that gives away a time zone.</figcaption>
      </figure>
      <figure class="chart">
        <div class="g-wide">${counterpartiesSvg(FLOWS, { labels: LABELS, width: 480, id: "who-w" })}</div>
        <div class="g-narrow">${counterpartiesSvg(FLOWS, { labels: LABELS, width: 318, id: "who-n" })}</div>
        <figcaption class="chart__caption">Who this wallet deals with. A heavier line is more transfers. An identified service is ringed in magenta.</figcaption>
      </figure>
    </div>
  </div>
</article>`;

const steps = () => `
<ol class="steps">
  <li class="step step--dive">
    <div class="step__diagram" aria-hidden="true"><span class="step__place">Your wallet</span><span class="step__leg"></span><span class="step__run"></span></div>
    <h3 class="step__title t-display-3"><span class="step__n">1</span>Dive in</h3>
    <p>Deposit SOL from your public wallet into the Loch. A screening authority checks where the funds came from and co-signs the deposit.</p>
    ${observer("your address, the amount, and that it went into the Loch.")}
  </li>
  <li class="step step--move">
    <div class="step__diagram" aria-hidden="true"><span class="step__where">in the Loch</span><span class="step__run"></span></div>
    <h3 class="step__title t-display-3"><span class="step__n">2</span>Send privately</h3>
    <p>Pay any other Loch balance. A zero-knowledge proof shows the payment is valid. A relayer submits it and takes its fee from the shielded amount.</p>
    ${observer("a proof, two nullifiers, two new commitments and the relayer&rsquo;s fee. No sender, no recipient, no amount.")}
  </li>
  <li class="step step--surface">
    <div class="step__diagram" aria-hidden="true"><span class="step__place">Any address</span><span class="step__run"></span><span class="step__leg"></span></div>
    <h3 class="step__title t-display-3"><span class="step__n">3</span>Surface</h3>
    <p>Withdraw to any Solana address, yours or someone else&rsquo;s. Withdrawals can&rsquo;t be paused, by us or by anyone.</p>
    ${observer("an address receive an amount from the Loch. Not which deposit it came from. Timing and matching amounts can still give it away.")}
  </li>
</ol>`;

/* --------------------------------------------------------------- popup frames */

const popupLand = (opts = {}) => `
  <div class="popup__land land">
    <p class="caution-band" role="status"><strong>Devnet.</strong> Test SOL only. Nothing here has real value.</p>
    <header class="popup__head">
      <span class="brand brand--sm"><img src="${P}/mark/mark-small.svg" width="24" height="24" alt=""><span class="brand__name">Loch</span></span>
      <button class="address-chip" type="button" aria-label="Connected wallet: Phantom, ${me}. Switch wallet"><span class="address-chip__name">Phantom</span><span class="address-chip__text fig">${me}</span>${ic("chevron", "icon--sm")}</button>
    </header>
    <div class="popup__public">
      <div class="balance balance--public">
        <p class="balance__label">Public balance</p>
        <p class="balance__figure"><span class="figure is-public">${opts.publicBalance ?? "41.207"}</span><span class="fig-unit">SOL</span></p>
      </div>
      <a class="score score--inline" href="#report" aria-label="${opts.noScore ? "No leak scan yet. Scan this wallet" : `Privacy score ${score} of 100. Open the leak report`}">
        <span class="score__label">Privacy score</span>
        <span class="score__figure">${opts.noScore ? `<span class="score__link">Scan this wallet</span>` : `<span class="figure is-public">${score}</span><span class="score__of">of 100</span><span class="score__link">Leak report</span>`}</span>
      </a>
    </div>
  </div>
  <hr class="waterline">`;

const popupActivity = `
  <section class="popup__deep water" data-depth="120" aria-label="Recent activity">
    <div class="popup__deep-head"><h2>Recent activity</h2><a href="#c-activity-row">All activity</a></div>
    <ul class="activity">
      <li class="activity__row is-public">${ic("dive")}<span class="activity__main"><span class="activity__title">Dived in</span><span class="activity__meta">From ${me}, today 14:02</span></span><span class="activity__amount fig"><span class="fig-sign">+</span>5.000</span></li>
      <li class="activity__row is-shielded">${ic("send")}<span class="activity__main"><span class="activity__title">Sent privately</span><span class="activity__meta">Yesterday 19:40</span></span><span class="activity__amount fig"><span class="fig-sign">−</span>1.250</span></li>
      <li class="activity__row is-shielded">${ic("receive")}<span class="activity__main"><span class="activity__title">Received privately</span><span class="activity__meta">28 Sep</span></span><span class="activity__amount fig"><span class="fig-sign">+</span>0.730</span></li>
      <li class="activity__row is-public">${ic("surface")}<span class="activity__main"><span class="activity__title">Surfaced</span><span class="activity__meta">To 9fRk…2mVd, 26 Sep</span></span><span class="activity__amount fig"><span class="fig-sign">−</span>2.000</span></li>
    </ul>
    <p class="popup__foot legend"><span>Upright is public on-chain.</span><span class="is-shielded">Italic is shielded.</span></p>
  </section>`;

const popupWater = (opts = {}) => `
  <div class="popup__water water" data-depth="60">
    <section class="balance balance--shielded" aria-label="Shielded balance">
      <p class="balance__label">Shielded balance</p>
      <p class="balance__figure">${soundingHtml(sol(opts.shielded ?? "12480739112"))}<span class="fig-unit">devnet SOL</span></p>
      <p class="balance__note">${opts.note ?? "In the Loch. Visible only to you."}</p>
    </section>
    <div class="popup__actions">
      <button class="btn ${opts.empty ? "btn--primary" : "btn--secondary"} btn--stacked" type="button">${ic("dive")}Dive in</button>
      <button class="btn ${opts.empty ? "btn--secondary" : "btn--primary"} btn--stacked" type="button"${opts.empty ? " disabled" : ""}>${ic("send")}Send privately</button>
      <button class="btn btn--secondary btn--stacked" type="button"${opts.empty ? " disabled" : ""}>${ic("surface")}Surface</button>
    </div>
  </div>`;

// In the guide each frame carries its own density and palette. On popup.html the root does (as the extension will), so the frames carry neither.
let standalone = false;
const popupFrame = (id, theme, label, inner) =>
  standalone ? `<main class="popup" id="${id}" aria-label="${label}">${inner}</main>` : `<main class="popup" id="${id}" data-density="compact" data-theme="${theme}" aria-label="${label}">${inner}</main>`;

const popups = {
  home: (theme, id = `popup-home-${theme}`) => popupFrame(id, theme, "Loch popup: home", popupLand() + popupWater() + popupActivity),
  proving: (theme = "dusk", id = "popup-proving") =>
    popupFrame(
      id,
      theme,
      "Loch popup: sending privately, proof in progress",
      popupLand() +
        popupWater() +
        popupActivity +
        `<div class="scrim"></div>
      <section class="sheet" role="dialog" aria-labelledby="${id}-t">
        <header class="sheet__head"><h2 class="sheet__title" id="${id}-t">Sending privately</h2></header>
        <div class="sheet__body stack">
          <dl class="deflist deflist--kv">
            <div class="deflist__row"><dt>To</dt><dd><span class="fig is-shielded">${to}</span></dd></div>
            <div class="deflist__row"><dt>Amount</dt><dd><span class="fig is-shielded">1.250</span> SOL</dd></div>
            <div class="deflist__row"><dt>Relayer fee</dt><dd><span class="fig is-public">0.000005</span> SOL</dd></div>
          </dl>
          <div class="progress" style="--progress:0.46" role="group" aria-label="Sending privately">
            <div class="progress__line" aria-hidden="true"><span></span></div>
            <ol class="progress__stages"><li data-state="done">Checked</li><li data-state="now" aria-current="step">Proving</li><li>Sending</li><li>Confirmed</li></ol>
            <p class="progress__status" role="status"><span>Generating the proof on this device. About 8 seconds.</span><span class="fig">0:05</span></p>
          </div>
          ${observer("a proof and the relayer&rsquo;s fee. No sender, no recipient, no amount.")}
        </div>
        <footer class="sheet__foot"><button class="btn btn--secondary" type="button">Cancel</button><button class="btn btn--primary" type="button" aria-busy="true">Sending</button></footer>
      </section>`,
    ),
  error: (theme = "dusk", id = "popup-error") =>
    popupFrame(
      id,
      theme,
      "Loch popup: a send that failed",
      popupLand() +
        popupWater() +
        popupActivity +
        `<div class="scrim"></div>
      <section class="sheet" role="alertdialog" aria-labelledby="${id}-t">
        <header class="sheet__head"><h2 class="sheet__title" id="${id}-t">Send privately</h2><button class="btn btn--quiet btn--icon btn--sm" type="button" aria-label="Close">${ic("close")}</button></header>
        <div class="sheet__body stack">
          <div class="progress" style="--progress:0.72" data-state="failed" role="group" aria-label="Sending privately">
            <div class="progress__line" aria-hidden="true"><span></span></div>
            <ol class="progress__stages"><li data-state="done">Checked</li><li data-state="done">Proved</li><li data-state="now" aria-current="step">Sending</li><li>Confirmed</li></ol>
          </div>
          <div class="failure" role="alert">
            <p class="failure__title">${ic("caution")}${esc(SEND_FAILURE.title)}</p>
            ${SEND_FAILURE.lines.map((line) => `<p>${esc(line)}</p>`).join("\n            ")}
            <p class="failure__detail">${esc(SEND_FAILURE.detail)}</p>
          </div>
        </div>
        <footer class="sheet__foot"><button class="btn btn--secondary" type="button">Settings</button><button class="btn btn--primary" type="button">Try again</button></footer>
      </section>`,
    ),
  empty: (theme = "dusk", id = "popup-empty") =>
    popupFrame(
      id,
      theme,
      "Loch popup: nothing in the Loch yet",
      popupLand({ publicBalance: "2.000", noScore: true }) +
        popupWater({ shielded: "0", note: "Nothing in the Loch yet.", empty: true }) +
        `<section class="popup__deep water" data-depth="120" aria-label="Recent activity">
        <div class="popup__deep-head"><h2>Recent activity</h2></div>
        <div class="empty">
          <p class="empty__title">No activity yet</p>
          <p>Dive in to move test SOL from your public wallet into your shielded balance. The deposit is public. What you do after it is not.</p>
        </div>
        <p class="popup__foot legend"><span>Upright is public on-chain.</span><span class="is-shielded">Italic is shielded.</span></p>
      </section>`,
    ),
  report: (theme = "dusk", id = "popup-report") =>
    popupFrame(
      id,
      theme,
      "Loch popup: leak report",
      popupLand() +
        `<div class="popup__view water" data-depth="60">
        <div class="popup__deep-head" style="padding-top:0"><h2>Leak report for ${me}</h2><a href="#popups">Close</a></div>
        <figure class="chart">${steppedBedSvg(REPORT, { width: 348, id: `${id}-bed` })}</figure>
        <div class="g-gap-s">${statementHtml(REPORT, { detail: false })}</div>
      </div>`,
    ),
};

const product = () => `
<section class="band water" data-depth="180" id="product" aria-labelledby="product-t">
  <div class="contour" aria-hidden="true"><span>180 m</span></div>
  <div class="wrap">
    <div class="section-head">
      <h2 class="t-display-2" id="product-t">Put together.</h2>
      <p class="t-lede">The leak report, the three steps, and the extension popup, with the content they will carry.</p>
    </div>

    <h3 class="g-h3" id="leak-report">The leak report</h3>
    <p class="t-small g-note">The stepped bed is the arithmetic: 100, less each finding, leaves the score. The statement underneath is the same numbers as text, and is what a screen reader is given.</p>
    ${report()}

    <h3 class="g-h3" id="how">How it works</h3>
    <p class="t-small g-note">A real sequence, so it is numbered. Solid buff legs cross the line in plain sight; the shielded run is dashed. Under each step, what anyone watching the chain can see.</p>
    ${steps()}

    <h3 class="g-h3" id="popups">The popup, 380 by 600</h3>
    <p class="t-small g-note">The same section at compact density: a band of land with the public wallet, the waterline, the shielded balance beneath it.</p>
    <div class="g-popups">
      <figure>${popups.home("dusk")}<figcaption>Home, dusk</figcaption></figure>
      <figure>${popups.home("night")}<figcaption>Home, night</figcaption></figure>
      <figure>${popups.proving()}<figcaption>Sending privately: the proof in progress</figcaption></figure>
      <figure>${popups.error()}<figcaption>A send that failed</figcaption></figure>
      <figure>${popups.empty()}<figcaption>Nothing in the Loch yet</figcaption></figure>
      <figure>${popups.report("night")}<figcaption>Leak report, night</figcaption></figure>
    </div>
  </div>
</section>`;

/* ---------------------------------------------------------------------- page */

const head = (title, extra = "", density = "") => `<!doctype html>
<html lang="en" data-theme="dusk"${density ? ` data-density="${density}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="The Loch design system: tokens, type, components and states, in both palettes and both densities.">
<meta name="color-scheme" content="dark">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="${P}/mark/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${P}/all.css">
<link rel="stylesheet" href="states.css">
<link rel="stylesheet" href="guide.css">
${extra}</head>`;

const index = `${head("Loch design system")}
<body>
${SPRITE}
<a class="skip-link" href="#main">Skip to content</a>

<header class="masthead land">
  <div class="wrap masthead__row">
    <a class="brand" href="#top" aria-label="Loch design system, top"><img class="g-mark-dusk" src="${P}/mark/mark-on-land.svg" width="30" height="30" alt=""><img class="g-mark-night" src="${P}/mark/mark-night.svg" width="30" height="30" alt=""><span class="brand__name">Loch</span></a>
    <nav class="nav" aria-label="Sections">
      <a href="#colour">Colour</a>
      <a href="#type">Type</a>
      <a href="#numerals">Numerals</a>
      <a href="#layout">Layout</a>
      <a href="#components">Components</a>
      <a href="#product">Product</a>
    </nav>
    <div class="segmented" role="radiogroup" aria-label="Palette" data-switch="theme">
      <button type="button" role="radio" aria-checked="true" data-value="dusk">Dusk</button>
      <button type="button" role="radio" aria-checked="false" data-value="night">Night</button>
    </div>
  </div>
</header>

<main id="main">
<section class="hero water" data-depth="0" id="top" aria-labelledby="hero-t">
  <div class="wrap hero__grid">
    <h1 class="mirror" id="hero-t">
      <span class="mirror__land">Upright is public.</span>
      <span class="mirror__water">Italic is shielded.</span>
    </h1>
    <div class="hero__body">
      <p class="t-lede">The Loch design system. Every surface is a section through the loch: a band of land above one hard waterline holds what anyone can see, and the water below it steps darker at each depth contour, down to the bed.</p>
      <p class="t-body">Lettering follows the cartographer&rsquo;s rule: upright for what is public on-chain, italic for what is shielded. Chart magenta is kept for cautions and nothing else.</p>
      <div class="hero__actions">
        <a class="btn btn--primary btn--lg" href="#components">See the components</a>
        <a class="btn btn--secondary btn--lg" href="#popups">See the popup</a>
      </div>
      <p class="t-small t-caution"><strong>v0.1, devnet only, unaudited.</strong> This page is the living guide to <code>@loch/design</code>. It loads no fonts, scripts or styles from anywhere but this repository.</p>
    </div>
    <figure class="hero__figure">
      ${popupFrame("popup-hero", "", "The extension popup, as designed", popupLand() + popupWater() + popupActivity).replace(' data-theme=""', "").replace("<main ", "<div inert ").replace("</main>", "</div>")}
      <figcaption>The extension popup, with example figures. On a wide screen it hangs through the waterline, so its waterline and the page&rsquo;s are one line.</figcaption>
    </figure>
  </div>
</section>
${colour()}
${type()}
${numerals()}
${layout()}
${components()}
${product()}
</main>

<footer class="footer band water" data-depth="bed">
  <div class="contour" aria-hidden="true"><span>230 m</span></div>
  <div class="wrap">
    <div class="footer__grid">
      <div class="footer__brand">
        <img src="${P}/mark/mark.svg" width="64" height="64" alt="">
        <div><p class="footer__name">Loch</p><p class="footer__status">v0.1, devnet only, unaudited.</p></div>
      </div>
      <nav class="footer__links" aria-label="This guide"><a href="#colour">Colour</a><a href="#type">Type</a><a href="#numerals">Numerals</a></nav>
      <nav class="footer__links" aria-label="More"><a href="#components">Components</a><a href="#product">Product</a><a href="popup.html">The popup alone</a></nav>
    </div>
    <div class="footer__end">
      <p class="footer__depth">Loch Ness is about 230 metres at its deepest. This is the bed.</p>
      <p class="t-fine">No cookies. No analytics. No third-party requests.</p>
    </div>
  </div>
</footer>
<p class="visually-hidden" role="status" aria-live="polite" id="live"></p>
<script src="guide.js"></script>
</body>
</html>
`;

standalone = true;
const popupPage = `${head("Loch", `<style>html,body{margin:0;width:380px;height:600px;overflow:hidden;background:var(--water-60)}.popup{display:none}.popup.is-shown{display:flex}</style>\n`, "compact")}
<body>
${SPRITE}
${popups.home("dusk", "home")}
${popups.proving("dusk", "proving")}
${popups.error("dusk", "error")}
${popups.empty("dusk", "empty")}
${popups.report("dusk", "report")}
<script src="guide.js"></script>
</body>
</html>
`;

const css = ["tokens.css", "base.css", "components.css"].map((f) => readFileSync(join(pkg, f), "utf8")).join("\n");
const statesCss = `/* Generated by packages/design/scripts/build-guide.mjs from the package's own CSS. Do not edit.
   Pins :hover, :active, :focus-visible and :focus-within as classes so the guide can show them. */
@layer loch.tokens, loch.reset, loch.base, loch.components, loch.utilities;
${forceStates(css)}`;

writeFileSync(join(out, "index.html"), index);
writeFileSync(join(out, "popup.html"), popupPage);
writeFileSync(join(out, "states.css"), statesCss);

// The text alternatives, printed so a build log shows what assistive technology is given.
console.log(`guide: wrote index.html (${(index.length / 1024).toFixed(0)} kB), popup.html, states.css`);
console.log(`  bed:   ${statementText(REPORT)}`);
console.log(`  hours: ${byHourText(FLOWS)}`);
console.log(`  who:   ${counterpartiesText(FLOWS, { labels: LABELS })}`);
void paletteTokens;
