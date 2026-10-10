import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FIT_WIDTHS,
  LIMITS,
  byHourSvg,
  byHourText,
  counterpartiesSvg,
  counterpartiesText,
  counterpartyList,
  fitHtml,
  hourCounts,
  quietWindow,
  statementHtml,
  statementLines,
  statementText,
  steppedBedSvg,
  steppedBedText,
} from "../src/charts/index.js";
import type { FlowLike, LeakReportLike } from "../src/charts/index.js";
import { ICON_NAMES, SPRITE, icon, use } from "../src/icons.js";
import { amountHtml, formatSol, soundingHtml } from "../src/numerals.js";

/*
  What the helpers are given comes, in the end, from an RPC endpoint or a
  labels file, and what they return is put into a page. These tests hold them
  to three things, whatever they are given:

    1. nothing they emit needs an inline style (a Content-Security-Policy
       without 'unsafe-inline' refuses a style attribute and a <style> element)
    2. nothing from the input reaches the output as markup
    3. the output is of a bounded size, every number in it is a sane one, and
       no input makes a helper throw
*/

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

const ME = "Fh3qJ5iBgbd24itfu7gbvo8XVHLjnNhA6aNEPnnNTz8K";
const EXCHANGE = "5tzFvgZoiXzNoHthSU8f84Fhx6vEKD3mJ5eg4w7yuAi9";
const PAYEE = "9fRkKDnqdWUjjiQF3wfLNfpjDjUQAXxFf3oeFEPV2mVd";
const T0 = 1_785_542_400;

/** Reads the hostile values through a type the helpers accept, as untyped JSON would arrive. */
const asReport = (value: unknown) => value as LeakReportLike;
const asFlows = (value: unknown) => value as readonly FlowLike[];

const report: LeakReportLike = {
  address: ME,
  score: 44,
  findings: [
    { id: "funding-source", severity: "high", title: "Funding source is public", detail: "First funds came from 5tzF…uAi9 (Exchange withdrawal). Anyone can follow this link back.", penalty: 20 },
    { id: "identified-services", severity: "high", title: "Linked to identified services", detail: "This wallet has 4 transfers with Exchange withdrawal.", penalty: 10 },
    { id: "recurring-counterparties", severity: "medium", title: "Recurring counterparties", detail: "4 addresses interact with you 3 or more times.", penalty: 16 },
    { id: "time-zone", severity: "medium", title: "Your time zone is guessable", detail: "Almost no activity between 00:00 and 06:00 UTC. That is likely your sleep window.", penalty: 10 },
  ],
};

function flows(): FlowLike[] {
  const list: FlowLike[] = [{ time: T0 + 8 * 3600, dir: "in", counterparty: EXCHANGE }];
  for (let i = 0; i < 40; i++) list.push({ time: T0 + i * 86_400 + (8 + (i % 12)) * 3600, dir: "out", counterparty: i % 3 === 0 ? PAYEE : `Other${String(i).padStart(2, "0")}`.padEnd(44, "x") });
  return list;
}

/** Every string the package can emit for ordinary input. */
function everything(): Record<string, string> {
  const labels = { [EXCHANGE]: "Exchange withdrawal" };
  const out: Record<string, string> = {
    SPRITE,
    "icons/sprite.svg": readFileSync(join(pkg, "icons", "sprite.svg"), "utf8"),
    statementHtml: statementHtml(report, { totalNote: "What helps." }),
    "statementHtml, plain": statementHtml(report, { severity: false, detail: false }),
    steppedBedSvg: steppedBedSvg(report, { width: 640 }),
    "steppedBedSvg, narrow, animated": steppedBedSvg(report, { width: 240, animate: true, labels: { "time-zone": "Sleep" }, startLabel: "Start" }),
    "steppedBedSvg, clean": steppedBedSvg({ address: ME, score: 100, findings: [] }),
    byHourSvg: byHourSvg(flows(), { width: 420 }),
    "byHourSvg, empty": byHourSvg([]),
    counterpartiesSvg: counterpartiesSvg(flows(), { labels, width: 420 }),
    "counterpartiesSvg, empty": counterpartiesSvg([]),
    "fitHtml, bed": fitHtml((width) => steppedBedSvg(report, { width })),
    "fitHtml, hours": fitHtml((width) => byHourSvg(flows(), { width }), { max: 568, className: "fit--hours" }),
    amountHtml: amountHtml(formatSol(-1_250_000_000n, { sign: "always" }), { shielded: true, unit: "SOL", className: "x" }, "1.25"),
    "amountHtml, negligible": amountHtml(formatSol(5000n)),
    soundingHtml: soundingHtml(formatSol(12_480_739_112n)),
    "soundingHtml, negligible": soundingHtml(formatSol(5000n)),
  };
  for (const name of ICON_NAMES) {
    out[`icon(${name})`] = icon(name, { label: "Label", className: "icon--sm" });
    out[`use(${name})`] = use(name, { href: "/assets/sprite.svg" });
  }
  return out;
}

const INLINE_STYLE = /\sstyle\s*=|<style[\s>/]/i;

describe("a strict Content-Security-Policy has nothing to refuse", () => {
  it("no helper emits a style attribute or a <style> element", () => {
    const all = everything();
    expect(Object.keys(all).length).toBeGreaterThan(40);
    for (const [name, markup] of Object.entries(all)) {
      expect(markup.length, name).toBeGreaterThan(20);
      expect(INLINE_STYLE.test(markup), `${name}: ${INLINE_STYLE.exec(markup)?.[0] ?? ""}`).toBe(false);
    }
  });

  it("the check itself would catch one", () => {
    for (const bad of ['<svg style="max-width:420px">', "<g style='--i:1'>", "<svg STYLE = x>", "<style>a{}</style>", "<style\n>", "<svg><style/></svg>"]) expect(INLINE_STYLE.test(bad), bad).toBe(true);
    for (const fine of ['<svg data-style="x">', "<p>a style=b</p>".replace(" style=", " styles="), '<svg class="lc-styled">']) expect(INLINE_STYLE.test(fine), fine).toBe(false);
  });

  it("no drawing shipped as a file carries one either: the sprite, the icons, the marks", () => {
    const files = [...readdirSync(join(pkg, "icons")).map((f) => join("icons", f)), ...readdirSync(join(pkg, "mark")).map((f) => join("mark", f))].filter((f) => f.endsWith(".svg"));
    expect(files.length).toBeGreaterThanOrEqual(24);
    for (const file of files) expect(INLINE_STYLE.test(readFileSync(join(pkg, file), "utf8")), file).toBe(false);
  });

  it("the sprite takes no room by its attributes and is named for the stylesheet to take out of the flow", () => {
    expect(SPRITE.startsWith('<svg xmlns="http://www.w3.org/2000/svg" class="sprite" width="0" height="0" aria-hidden="true" focusable="false">')).toBe(true);
    expect(SPRITE).toBe(readFileSync(join(pkg, "icons", "sprite.svg"), "utf8"));
    expect(readFileSync(join(pkg, "components.css"), "utf8")).toMatch(/\.sprite \{\s*position: absolute;\s*width: 0;\s*height: 0;\s*\}/);
  });

  it("a figure says how wide it was drawn in data-w, and the stylesheet keeps it from growing past that", () => {
    for (const svg of [steppedBedSvg(report, { width: 568 }), byHourSvg(flows(), { width: 568 }), counterpartiesSvg(flows(), { width: 568 })]) {
      expect(svg).toMatch(/^<svg class="lc lc-(bed|hours|who)" xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 568 [\d.]+" width="568" height="[\d.]+" data-w="568" role="img" /);
    }
    const css = readFileSync(join(pkg, "components.css"), "utf8");
    expect(css).toMatch(/\.chart svg\.lc \{\s*width: auto;\s*max-width: 100%;\s*\}/);
    // The place of a column in the drop sequence is an attribute too, and the stylesheet has a rule for each.
    for (let i = 1; i <= LIMITS.findings; i++) expect(css).toContain(`.lc [data-i="${i}"] {\n    --i: ${i};\n  }`);
  });
});

/* ------------------------------------------------------------ what is markup */

const TAGS = new Set(["svg", "title", "desc", "defs", "pattern", "line", "rect", "g", "text", "tspan", "circle", "ol", "li", "span", "strong", "small", "div"]);
const ATTRIBUTES = new Set([
  ...["class", "id", "xmlns", "viewBox", "width", "height", "role", "title"],
  ...["data-w", "data-i", "data-sev", "aria-labelledby", "aria-label", "aria-hidden"],
  ...["font-family", "font-size", "font-weight", "text-anchor", "fill", "stroke", "stroke-width", "stroke-opacity"],
  ...["x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "dx", "patternUnits", "patternTransform"],
]);
const NUMERIC = new Set(["width", "height", "data-w", "data-i", "font-size", "font-weight", "stroke-width", "stroke-opacity", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "dx"]);

/**
 * Reads markup the way a browser's tokenizer would see it and returns every
 * reason it is not what the helpers are meant to write: a tag or an attribute
 * outside the short list they use, a number that is not a sane one, or a
 * tag that does not close. Hostile input that got through unescaped shows up
 * here as one of those.
 */
function problems(markup: string): string[] {
  const found: string[] = [];
  const open: string[] = [];
  let rest = markup;
  while (rest.length > 0) {
    const lt = rest.indexOf("<");
    if (lt < 0) {
      if (rest.includes(">")) found.push(`stray ">" in text: ${rest.slice(0, 40)}`);
      break;
    }
    if (rest.slice(0, lt).includes(">")) found.push(`stray ">" in text: ${rest.slice(0, 40)}`);
    rest = rest.slice(lt);
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][A-Za-z0-9-]*="[^"<>]*")*)\s*(\/?)>/.exec(rest);
    if (!tag) {
      found.push(`not a tag the helpers write: ${rest.slice(0, 60)}`);
      break;
    }
    const [whole, closing, name, attributes, selfClosing] = tag as unknown as [string, string, string, string, string];
    if (!TAGS.has(name)) found.push(`element <${name}>`);
    if (closing) {
      const last = open.pop();
      if (last !== name) found.push(`</${name}> closes <${last ?? "nothing"}>`);
    } else if (!selfClosing) open.push(name);
    for (const [, attribute, value] of attributes.matchAll(/\s+([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/g) as IterableIterator<[string, string, string]>) {
      if (!ATTRIBUTES.has(attribute)) found.push(`attribute ${attribute} on <${name}>`);
      if (/^on/i.test(attribute)) found.push(`handler ${attribute}`);
      if (NUMERIC.has(attribute)) {
        const number = Number(value);
        if (value === "" || !Number.isFinite(number) || Math.abs(number) > 10_000) found.push(`${attribute}="${value}" on <${name}> is not a sane number`);
      }
      if (attribute === "viewBox" && !/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/.test(value)) found.push(`viewBox="${value}"`);
      if (attribute === "fill" && !/^(#[0-9A-F]{6}|url\(#[A-Za-z0-9_-]+\)|none|currentColor)$/.test(value)) found.push(`fill="${value}"`);
      if (attribute === "id" && !/^[A-Za-z0-9_-]+$/.test(value)) found.push(`id="${value}"`);
      if (/[<>]/.test(value)) found.push(`${attribute}="${value}"`);
    }
    rest = rest.slice(whole.length);
  }
  if (open.length > 0) found.push(`left open: ${open.join(", ")}`);
  if (/NaN|Infinity|undefined|\[object|function\s*\(|=>/.test(markup)) found.push(`a value was written that is not text: ${/NaN|Infinity|undefined|\[object|function\s*\(|=>/.exec(markup)?.[0] ?? ""}`);
  return found;
}

describe("the reading of markup these tests rely on", () => {
  it("accepts what the helpers write for ordinary input", () => {
    for (const [name, markup] of Object.entries(everything())) {
      if (/^(SPRITE|icons\/|icon\(|use\(|amountHtml|soundingHtml)/.test(name)) continue;
      expect(problems(markup), name).toEqual([]);
    }
  });

  it("refuses markup that got in from outside", () => {
    expect(problems('<svg class="lc"><img src=x onerror=alert(1)></svg>')).not.toEqual([]);
    expect(problems('<svg class="lc"><script>alert(1)</script></svg>')).not.toEqual([]);
    expect(problems('<span class="sev" data-sev=""><b>x</b>">High</span>')).not.toEqual([]);
    expect(problems('<text class="lc-label" x="1" onload="alert(1)">x</text>')).not.toEqual([]);
    expect(problems('<rect x="NaN" y="0" width="1" height="1"/>')).not.toEqual([]);
    expect(problems('<rect x="1e99" y="0" width="1" height="1"/>')).not.toEqual([]);
    expect(problems("<text>a</text></svg>")).not.toEqual([]);
    expect(problems('<svg class="lc" width="10"><text>fine &lt;b&gt; &quot;</text></svg>')).toEqual([]);
  });
});

/* ---------------------------------------------------------------- injection */

const HOSTILE = [
  `"><img src=x onerror=alert(1)>`,
  `</text></svg><script>alert(1)</script>`,
  `' onload='alert(1)`,
  `" onmouseover="alert(1)" x="`,
  `<svg/onload=alert(1)>`,
  `</title><script>alert(document.domain)</script>`,
  `</desc><foreignObject><iframe src=javascript:alert(1)>`,
  `]]><![CDATA[<script>`,
  `&lt;script&gt; already escaped &amp; then <b>not</b>`,
  `--><script>alert(1)</script><!--`,
  `javascript:alert(1)`,
  `url(#x) "style="fill:red`,
  `<style>*{display:none}</style>`,
  `<a href="https://evil.example">click</a>`,
];

/** The same hostile string in every field a report and its transfers have. */
function poisoned(text: string): { report: LeakReportLike; flows: FlowLike[]; labels: Record<string, string> } {
  const findings = [
    { id: text, severity: text, title: text, detail: text, penalty: 20 },
    { id: "funding-source", severity: "high", title: text, detail: text, penalty: 10 },
    { id: text, severity: "low", title: `One ${text}`, detail: "", penalty: 5 },
  ];
  const list: FlowLike[] = [];
  for (let i = 0; i < 30; i++) list.push({ time: T0 + i * 3600 * 5, dir: i % 4 === 0 ? "in" : "out", counterparty: i % 2 === 0 ? text : `${text}${i % 5}` });
  const labels: Record<string, string> = { [text]: text, [`${text}1`]: `Named ${text}` };
  return { report: asReport({ address: text, score: 65, findings }), flows: list, labels };
}

describe("nothing from a report, a transfer or a label reaches the page as markup", () => {
  it.each(HOSTILE.map((text, i) => [i, text] as const))("hostile string %i in every field", (_, text) => {
    const { report: bad, flows: badFlows, labels } = poisoned(text);
    const outputs: Record<string, string> = {
      statementHtml: statementHtml(bad, { totalNote: text }),
      steppedBedSvg: steppedBedSvg(bad, { width: 640, id: text, startLabel: text, labels: { [text]: text, "funding-source": text } }),
      "steppedBedSvg, narrow": steppedBedSvg(bad, { width: 240 }),
      byHourSvg: byHourSvg(badFlows, { id: text }),
      counterpartiesSvg: counterpartiesSvg(badFlows, { labels, id: text, width: 420 }),
      "counterpartiesSvg, narrow": counterpartiesSvg(badFlows, { labels, width: 240, max: 12 }),
      fitHtml: fitHtml((width) => steppedBedSvg(bad, { width }), { className: text, max: 400 }),
    };
    for (const [name, markup] of Object.entries(outputs)) {
      expect(problems(markup), name).toEqual([]);
      // A string with anything in it that markup is made of never arrives as it was given.
      if (/[<>"'&]/.test(text)) expect(markup.includes(text), `${name} carries the string as it was given`).toBe(false);
      expect(markup, name).not.toMatch(/<(script|img|iframe|foreignObject|style|a)\b/i);
      expect(INLINE_STYLE.test(markup), name).toBe(false);
    }
    // The words are still there to be read, escaped.
    if (text.includes("<")) expect(outputs.statementHtml).toContain("&lt;");
    if (text.includes('"')) expect(outputs.statementHtml).toContain("&quot;");
    if (text.includes("'")) expect(outputs.statementHtml).toContain("&#39;");
    // The text alternatives are plain text for the consumer to escape: they are not markup, and say so.
    for (const plain of [statementText(bad), steppedBedText(bad), byHourText(badFlows), counterpartiesText(badFlows, { labels })]) expect(typeof plain).toBe("string");
  });

  it("a severity that is not one of the three is not written at all", () => {
    const html = statementHtml(asReport({ address: ME, score: 90, findings: [{ id: "x", severity: '"><b>high</b>', title: "T", detail: "D", penalty: 10 }] }));
    expect(html).not.toContain("data-sev");
    expect(html).not.toContain("<b>");
    expect(statementLines(asReport({ address: ME, score: 0, findings: [{ id: "x", severity: "HIGH", title: "T", detail: "", penalty: 1 }] }))[1]!.severity).toBeUndefined();
    for (const severity of ["high", "medium", "low"]) {
      expect(statementHtml(asReport({ address: ME, score: 90, findings: [{ id: "x", severity, title: "T", detail: "", penalty: 10 }] }))).toContain(`data-sev="${severity}"`);
    }
  });

  it("nothing is read from a prototype: an id or an address that spells a built-in name is only a name", () => {
    const names = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype"];
    const findings = names.map((id) => ({ id, severity: "low", title: `${id} title`, detail: "", penalty: 1 }));
    const svg = steppedBedSvg(asReport({ address: "constructor", score: 94, findings }), { width: 900, labels: JSON.parse('{"__proto__":"Proto label"}') as Record<string, string> });
    expect(problems(svg)).toEqual([]);
    expect(svg).toContain(">constructor</text>");
    expect(svg).toContain(">Proto label</text>");
    const list = counterpartyList(
      names.map((counterparty) => ({ time: T0, dir: "out", counterparty })),
      {},
    );
    expect(list.map((c) => c.address).sort()).toEqual([...names].sort());
    expect(list.every((c) => c.label === undefined)).toBe(true);
    expect(problems(counterpartiesSvg(names.map((counterparty) => ({ time: T0, dir: "in", counterparty }))))).toEqual([]);
  });

  it("controls and direction marks are taken out of what is written", () => {
    const rlo = String.fromCharCode(0x202e);
    const nul = String.fromCharCode(0);
    const esc = String.fromCharCode(0x1b);
    const half = String.fromCharCode(0xd83d);
    const title = `Exchange${rlo}lagel${nul}${esc}[31m${half} done`;
    const html = statementHtml(asReport({ address: ME, score: 90, findings: [{ id: "x", severity: "low", title, detail: `a\n\tb${rlo}`, penalty: 10 }] }));
    for (const ch of [rlo, nul, esc, half]) expect(html.includes(ch)).toBe(false);
    expect(html).toContain("<strong>Exchangelagel[31m");
    expect(html).toContain("<span>a b</span>");
    const svg = counterpartiesSvg([{ time: T0, dir: "in", counterparty: PAYEE }], { labels: { [PAYEE]: `Bank${rlo}${nul}` } });
    expect(svg.includes(rlo) || svg.includes(nul)).toBe(false);
    expect(svg).toContain(">Bank, funded this wallet</text>");
  });
});

/* ------------------------------------------------------------------ numbers */

const NUMBERS: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -1e9, 1e308, 5e-324, -0, 2 ** 53, 1e21, "20", "", null, undefined, {}, [], true, 12n, Symbol("n")];

describe("a number is a finite one in a sane range before it is drawn", () => {
  it("penalties and scores of every kind", () => {
    for (const value of NUMBERS) {
      const bad = asReport({ address: ME, score: value, findings: [{ id: "funding-source", severity: "high", title: "Funding source is public", detail: "", penalty: value }, { id: "x", severity: "low", title: "X", detail: "", penalty: 10 }] });
      const lines = statementLines(bad);
      for (const line of lines) {
        expect(Number.isFinite(line.less) && line.less >= 0 && line.less <= 100, `less for ${String(value)}`).toBe(true);
        expect(Number.isFinite(line.balance) && line.balance >= 0 && line.balance <= 100, `balance for ${String(value)}`).toBe(true);
        expect(line.lost >= 0 && line.lost <= 100).toBe(true);
      }
      expect(problems(statementHtml(bad)), `statement for ${String(value)}`).toEqual([]);
      for (const width of [240, 640]) expect(problems(steppedBedSvg(bad, { width })), `bed for ${String(value)}`).toEqual([]);
    }
  });

  it("a penalty is held to the hundred points there are", () => {
    const lines = statementLines({ address: ME, score: 0, findings: [{ id: "a", severity: "high", title: "A", detail: "", penalty: 1e308 }] });
    expect(lines.map((l) => l.less)).toEqual([0, 100, 0]);
    expect(lines.map((l) => l.balance)).toEqual([100, 0, 0]);
    expect(statementText({ address: ME, score: 0, findings: [{ id: "a", severity: "high", title: "A", detail: "", penalty: -5 }] })).toContain("A: less 0, leaves 100.");
  });

  it("widths, depths and counts given as options", () => {
    for (const value of NUMBERS) {
      const size = value as number;
      const bed = steppedBedSvg(report, { width: size, depth: size });
      const hours = byHourSvg(flows(), { width: size, depth: size });
      const who = counterpartiesSvg(flows(), { width: size, max: size });
      for (const [name, svg] of Object.entries({ bed, hours, who })) {
        expect(problems(svg), `${name} for ${String(value)}`).toEqual([]);
        const width = Number(/ data-w="([^"]+)"/.exec(svg)![1]);
        expect(width >= LIMITS.minWidth && width <= LIMITS.maxWidth, `${name} width ${width} for ${String(value)}`).toBe(true);
        const height = Number(/ height="([^"]+)"/.exec(svg)![1]);
        expect(height > 0 && height <= 2000, `${name} height ${height} for ${String(value)}`).toBe(true);
      }
    }
    expect(steppedBedSvg(report, { width: 10 })).toContain('data-w="240"');
    expect(steppedBedSvg(report, { width: 1e9 })).toContain('data-w="4000"');
    expect(steppedBedSvg(report, { width: Number.NaN })).toContain('data-w="640"');
    expect(byHourSvg(flows(), { width: Number.NaN })).toContain('data-w="420"');
  });

  it("times of every kind", () => {
    for (const value of NUMBERS) {
      const list = asFlows(Array.from({ length: 30 }, (_, i) => ({ time: i === 0 ? T0 : value, dir: "out", counterparty: PAYEE, amount: value })));
      const hours = hourCounts(list);
      expect(hours).toHaveLength(24);
      expect(Object.keys(hours)).toHaveLength(24);
      expect(hours.every((count) => Number.isInteger(count) && count >= 0 && count <= 30)).toBe(true);
      expect(problems(byHourSvg(list)), `hours for ${String(value)}`).toEqual([]);
      expect(problems(counterpartiesSvg(list)), `who for ${String(value)}`).toEqual([]);
      expect(byHourText(list)).not.toMatch(/NaN|Infinity|undefined/);
    }
    // A time no calendar has is left out, as a transfer with no time is.
    expect(hourCounts([{ time: 1e300, dir: "in", counterparty: PAYEE }]).reduce((a, b) => a + b, 0)).toBe(0);
    expect(hourCounts([{ time: Number.NaN, dir: "in", counterparty: PAYEE }]).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("counts that are not counts", () => {
    for (const value of NUMBERS) {
      const quiet = quietWindow(new Array<number>(24).fill(value as number));
      if (quiet) expect(Number.isFinite(quiet.count) && Number.isFinite(quiet.total) && quiet.start >= 0 && quiet.start <= 23).toBe(true);
    }
    expect(quietWindow(asFlows("nonsense") as unknown as number[])).toBeNull();
    expect(quietWindow([1, 2, 3])).toMatchObject({ total: 6 });
  });
});

/* ------------------------------------------------------------------ bounds */

const KB = 1024;

describe("nothing in the data decides how large the markup gets, or how long it takes", () => {
  it("thousands of findings, each with a long title", () => {
    const long = "W".repeat(5_000);
    const findings = Array.from({ length: 5_000 }, (_, i) => ({ id: `finding-${i}`, severity: "medium", title: `${long} ${i}`, detail: long, penalty: 0.5 }));
    const big = asReport({ address: long, score: 0, findings });
    const lines = statementLines(big);
    expect(lines).toHaveLength(LIMITS.findings + 2);
    // The first eleven are written out; the rest are one line, and the arithmetic still ends at the score.
    expect(lines[LIMITS.findings]).toMatchObject({ kind: "finding", title: "4989 more findings", merged: 4989, less: 100, lost: 94.5, balance: 0 });
    expect(lines[lines.length - 1]).toMatchObject({ kind: "total", balance: 0 });
    const html = statementHtml(big, { totalNote: long });
    expect(html.match(/<li /g)).toHaveLength(LIMITS.findings + 2);
    expect(html.length).toBeLessThan(16 * KB);
    expect(problems(html)).toEqual([]);
    for (const width of [240, 640, 4000]) {
      const svg = steppedBedSvg(big, { width });
      expect(svg.length, `bed at ${width}`).toBeLessThan(16 * KB);
      expect(problems(svg), `bed at ${width}`).toEqual([]);
      expect(svg.match(/class="lc-col"/g)!.length).toBeLessThanOrEqual(LIMITS.findings + 1);
    }
    expect(statementText(big).length).toBeLessThan(4 * KB);
  });

  it("no more columns than the width has room for", () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, severity: "low" as const, title: `Finding ${i}`, detail: "", penalty: 5 }));
    const twelve = { address: ME, score: 40, findings };
    expect(steppedBedSvg(twelve, { width: 900 }).match(/class="lc-col"/g)).toHaveLength(13);
    const narrow = steppedBedSvg(twelve, { width: 240 });
    expect(narrow.match(/class="lc-col"/g)).toHaveLength(7);
    // The last column stands for the seven findings there was no room for: 5 points each.
    expect(narrow).toContain(">More</text>");
    expect(narrow).toContain(">−35</text>");
    expect([...narrow.matchAll(/class="lc-sounding"[^>]*>(\d+)</g)].map((m) => Number(m[1]))).toEqual([100, 95, 90, 85, 80, 75, 40]);
  });

  it("thousands of counterparties", () => {
    const many = Array.from({ length: 20_000 }, (_, i) => ({ time: T0 + i * 60, dir: i % 2 ? "in" : "out", counterparty: `Party${i}`.padEnd(44, "y") }) as FlowLike);
    const labels: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) labels[`Party${i}`.padEnd(44, "y")] = `Service number ${i} with a long name that goes on`;
    for (const max of [5, 12, 1e9]) {
      const svg = counterpartiesSvg(many, { labels, max, width: 568 });
      expect(svg.length, `max ${max}`).toBeLessThan(16 * KB);
      expect(problems(svg)).toEqual([]);
      expect(svg.match(/<circle class="lc-node-caution"/g)!.length).toBeLessThanOrEqual(LIMITS.rows);
    }
    expect(counterpartiesText(many, { labels, max: 1e9 }).length).toBeLessThan(4 * KB);
    expect(byHourSvg(many).length).toBeLessThan(16 * KB);
  });

  it("more transfers than a call stack has room for, and more than are read", () => {
    const huge = Array.from({ length: 200_000 }, (_, i) => ({ time: T0 + i, dir: "out", counterparty: `P${i}` }) as FlowLike);
    const started = Date.now();
    const who = counterpartiesSvg(huge);
    const hours = byHourSvg(huge);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(problems(who)).toEqual([]);
    expect(problems(hours)).toEqual([]);
    expect(who.length).toBeLessThan(16 * KB);
    expect(counterpartyList(huge)).toHaveLength(LIMITS.flows);
    expect(hourCounts(huge).reduce((a, b) => a + b, 0)).toBe(LIMITS.flows);
  });

  it("a megabyte in one label, one address, one id, one note", () => {
    const mega = "<b>&".repeat(262_144);
    expect(mega.length).toBeGreaterThan(1_000_000);
    const started = Date.now();
    const outputs = [
      counterpartiesSvg([{ time: T0, dir: "in", counterparty: mega }, { time: T0 + 1, dir: "out", counterparty: PAYEE }], { labels: { [mega]: mega, [PAYEE]: mega }, id: mega }),
      steppedBedSvg(asReport({ address: mega, score: 80, findings: [{ id: mega, severity: mega, title: mega, detail: mega, penalty: 20 }] }), { id: mega, startLabel: mega, labels: { [mega]: mega } }),
      statementHtml(asReport({ address: mega, score: 80, findings: [{ id: mega, severity: "high", title: mega, detail: mega, penalty: 20 }] }), { totalNote: mega }),
      byHourSvg([{ time: T0, dir: "in", counterparty: mega }], { id: mega }),
      fitHtml(() => "", { className: mega }),
    ];
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const markup of outputs) {
      expect(markup.length).toBeLessThan(16 * KB);
      expect(problems(markup)).toEqual([]);
      expect(markup).not.toContain("<b>");
    }
  });
});

/* --------------------------------------------------------------- wrong types */

describe("no input makes a helper throw", () => {
  const thrower = new Proxy(
    {},
    {
      get() {
        throw new Error("read");
      },
      has() {
        throw new Error("has");
      },
      ownKeys() {
        throw new Error("keys");
      },
      getOwnPropertyDescriptor() {
        throw new Error("descriptor");
      },
    },
  );
  const getter = Object.defineProperty({ address: ME, score: 1 }, "findings", {
    enumerable: true,
    get() {
      throw new Error("findings");
    },
  });
  const unprintable = { toString: () => { throw new Error("toString"); }, valueOf: () => { throw new Error("valueOf"); } };
  const VALUES: unknown[] = [undefined, null, 0, 42, Number.NaN, "", "report", true, Symbol("s"), 10n, [], [1, 2], {}, () => 1, new Date(0), new Map(), thrower, getter, unprintable];

  it("as the report, as its findings, as a finding, as any field of one", () => {
    const shapes: unknown[] = [];
    for (const value of VALUES) {
      shapes.push(value);
      shapes.push({ address: value, score: value, findings: value });
      shapes.push({ address: ME, score: 50, findings: [value, value] });
      shapes.push({ address: ME, score: 50, findings: [{ id: value, severity: value, title: value, detail: value, penalty: value }] });
    }
    expect(shapes.length).toBe(VALUES.length * 4);
    for (const shape of shapes) {
      const bad = asReport(shape);
      expect(() => statementLines(bad)).not.toThrow();
      expect(() => statementText(bad)).not.toThrow();
      expect(() => steppedBedText(bad)).not.toThrow();
      const html = statementHtml(bad, { totalNote: unprintable as unknown as string, severity: shape as boolean, detail: shape as boolean });
      const svg = steppedBedSvg(bad, { width: shape as number, depth: shape as number, id: shape as string, labels: shape as Record<string, string>, startLabel: shape as string, animate: shape as boolean });
      expect(problems(html)).toEqual([]);
      expect(problems(svg)).toEqual([]);
      expect(svg.startsWith('<svg class="lc lc-bed')).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg.length).toBeLessThan(16 * KB);
    }
  });

  it("as the transfers, as a transfer, as any field of one, as the labels", () => {
    const shapes: unknown[] = [];
    for (const value of VALUES) {
      shapes.push(value);
      shapes.push([value, value, value]);
      shapes.push(Array.from({ length: 25 }, (_, i) => ({ time: i ? value : T0, dir: value, counterparty: value, amount: value, asset: value })));
    }
    for (const shape of shapes) {
      const bad = asFlows(shape);
      const labels = shape as Record<string, string>;
      expect(() => hourCounts(bad)).not.toThrow();
      expect(() => byHourText(bad)).not.toThrow();
      expect(() => counterpartyList(bad, labels)).not.toThrow();
      expect(() => counterpartiesText(bad, { labels, max: shape as number })).not.toThrow();
      const hours = byHourSvg(bad, { width: shape as number, depth: shape as number, id: shape as string });
      const who = counterpartiesSvg(bad, { labels, max: shape as number, width: shape as number, id: shape as string });
      expect(problems(hours)).toEqual([]);
      expect(problems(who)).toEqual([]);
      expect(hours.startsWith('<svg class="lc lc-hours"') && hours.endsWith("</svg>")).toBe(true);
      expect(who.startsWith('<svg class="lc lc-who"') && who.endsWith("</svg>")).toBe(true);
    }
  });

  it("as the options", () => {
    for (const value of VALUES) {
      const options = value as Record<string, never>;
      expect(() => statementHtml(report, options)).not.toThrow();
      expect(() => steppedBedSvg(report, options)).not.toThrow();
      expect(() => byHourSvg(flows(), options)).not.toThrow();
      expect(() => counterpartiesSvg(flows(), options)).not.toThrow();
      expect(() => counterpartiesText(flows(), options)).not.toThrow();
      expect(() => fitHtml((width) => steppedBedSvg(report, { width }), options)).not.toThrow();
    }
  });

  it("says so, in a figure of the same kind, when something could not be read at all", () => {
    const svg = steppedBedSvg(asReport(getter), { width: 300 });
    expect(svg.startsWith('<svg class="lc lc-bed"')).toBe(true);
    // Reading the findings threw, so the statement falls back to a clean one rather than to nothing.
    expect(problems(svg)).toEqual([]);
    const hours = byHourSvg(asFlows(new Proxy([], { get() { throw new Error("read"); } })), { width: 300 });
    expect(problems(hours)).toEqual([]);
    expect(hours).toMatch(/This figure could not be drawn\.|Transfers by hour of day/);
  });
});

/* ----------------------------------------------------------- stepped figures */

describe("fitHtml", () => {
  it("draws the figure once per step, narrowest first, each with its own width and its own ids", () => {
    const html = fitHtml((width) => steppedBedSvg(report, { width }));
    expect(html.startsWith('<div class="fit"><svg class="lc lc-bed"')).toBe(true);
    expect(html.endsWith("</svg></div>")).toBe(true);
    const widths = [...html.matchAll(/<svg class="lc lc-bed"[^>]* data-w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths).toEqual([...FIT_WIDTHS]);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(problems(html)).toEqual([]);
  });

  it("stops at a widest step, or draws only the steps asked for", () => {
    const upTo = (max: number) => [...fitHtml((width) => byHourSvg(flows(), { width }), { max }).matchAll(/ data-w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(upTo(568)).toEqual([280, 318, 360, 400, 440, 480, 520, 568]);
    expect(upTo(300)).toEqual([280]);
    expect(upTo(1)).toEqual([280]);
    const chosen = fitHtml((width) => byHourSvg(flows(), { width }), { widths: [757, 280, 400, 999, 401] });
    expect([...chosen.matchAll(/ data-w="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([280, 400, 757]);
  });

  it("has a rule in the stylesheet for every step it can draw", () => {
    const css = readFileSync(join(pkg, "components.css"), "utf8");
    for (const width of FIT_WIDTHS.slice(1)) {
      expect(css, String(width)).toContain(`@container (min-width: ${width}px) {\n      .fit:has(> [data-w="${width}"]) > [data-w] {\n        display: none;\n      }\n      .fit > [data-w][data-w="${width}"] {\n        display: block;\n      }\n    }`);
    }
    expect([...css.matchAll(/@container \(min-width: (\d+)px\) \{\s*\.fit:has/g)].map((m) => Number(m[1]))).toEqual(FIT_WIDTHS.slice(1));
  });

  it("names the wrapper, and leaves out a drawing that could not be made", () => {
    expect(fitHtml(() => "<svg></svg>", { className: 'fit--bed "x"', widths: [280] })).toBe('<div class="fit fit--bed &quot;x&quot;"><svg></svg></div>');
    const html = fitHtml((width) => {
      if (width === 318) throw new Error("no");
      return `<svg data-w="${width}"></svg>`;
    }, { max: 360 });
    expect(html).toBe('<div class="fit"><svg data-w="280"></svg><svg data-w="360"></svg></div>');
  });
});

/* -------------------------------------------------------------------- icons */

describe("icons", () => {
  it("draw nothing for a name that is not in the set, and never read a prototype", () => {
    for (const name of ["constructor", "__proto__", "toString", "nope", ""]) {
      const svg = icon(name as never);
      expect(svg).toBe('<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></svg>');
    }
    expect(icon("dive")).toContain('<path d="M2.5 7h15"/>');
  });

  it("escape the name, the label, the class and the address of the sprite", () => {
    const svg = use('"><script>' as never, { href: '"><img>', label: '"<b>', className: '"><i>' });
    expect(svg).not.toMatch(/<(script|img|b|i)>/);
    expect(svg).toBe('<svg class="icon &quot;&gt;&lt;i&gt;" viewBox="0 0 20 20" role="img" aria-label="&quot;&lt;b&gt;"><use href="&quot;&gt;&lt;img&gt;#i-&quot;&gt;&lt;script&gt;"/></svg>');
  });
});
