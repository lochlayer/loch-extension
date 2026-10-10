import { escapeHtml } from "../numerals.js";
import type { Severity } from "./types.js";

export const esc = escapeHtml;

/** Fallback inks written into the SVG, so a chart opened on its own is still legible. Inline, the stylesheet's tokens win. */
export const INK = {
  buff: "#E4D8B4",
  loch: "#A8D0E0",
  paper: "#E9EEF0",
  paper2: "#9DB3BE",
  water: "#1F4B62",
  bed: "#050F15",
  magenta: "#E58ABB",
  rule: "#557482",
} as const;

export const SANS = "'Libre Franklin', 'Helvetica Neue', Arial, sans-serif";
export const SERIF = "'Old Standard TT', Georgia, serif";

/**
 * How much of anything the helpers will draw or write. What they are given
 * comes, in the end, from an RPC endpoint or a labels file, so nothing in it
 * decides how large the markup gets.
 */
export const LIMITS = {
  /** Findings written one by one. From there on the rest are summed in one line. */
  findings: 12,
  /** Transfers read. The scanner reads a thousand transactions at most. */
  flows: 50_000,
  /** Counterparties drawn one by one. */
  rows: 12,
  /** Characters of a finding's title, its detail sentence, a label, a note, an address, an id. */
  title: 120,
  detail: 600,
  label: 48,
  note: 600,
  address: 128,
  id: 64,
  /** Pixels a figure is drawn at. */
  minWidth: 240,
  maxWidth: 4000,
} as const;

/**
 * Characters that are not text: C0 and C1 controls, and the bidirectional
 * embedding, override and isolate marks, which can make a label read as
 * something it is not. Tabs and line breaks count as a space.
 */
const NOT_TEXT = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]/g;
const BREAKS = /[\t\n\u000b\u000c\r ]+/g;
/** A surrogate pair, or one half of one on its own. */
const SURROGATES = /([\ud800-\udbff][\udc00-\udfff])|[\ud800-\udfff]/g;

/** Cuts a string to a length without leaving half a surrogate pair, ending in an ellipsis when something was cut. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}\u2026`;
}

/**
 * Whatever was given, as plain text of a bounded length: a string as it is,
 * a finite number or a boolean written out, anything else nothing. Controls and
 * direction marks are taken out and runs of spaces closed up. The result
 * still has to be escaped where it is written into markup.
 */
export function text(value: unknown, max: number): string {
  let s: string;
  if (typeof value === "string") s = value;
  else if (typeof value === "bigint" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) s = String(value);
  else return "";
  // Bound the work before anything walks the string.
  if (s.length > max * 4 + 16) s = s.slice(0, max * 4 + 16);
  s = s
    .replace(NOT_TEXT, "")
    .replace(BREAKS, " ")
    .replace(SURROGATES, (_, pair: string | undefined) => pair ?? "\ufffd")
    .trim();
  return clip(s, max);
}

/** A finite number inside a range; `fallback` for anything that is not one. */
export function num(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** The width to draw at: the option when it is a number, held to what a screen can show. */
export function drawWidth(value: unknown, fallback: number): number {
  return Math.round(num(value, LIMITS.minWidth, LIMITS.maxWidth, fallback) * 100) / 100;
}

/** Trims a coordinate to two decimals and drops a trailing ".00". Never writes anything but a number. */
export function n(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0";
}

/** Rough advance of a string in Libre Franklin at medium weight, in px. Good enough to decide whether labels collide. */
export function textWidth(value: string, size: number): number {
  let units = 0;
  for (const ch of value) {
    if (/[0-9]/.test(ch)) units += 0.65;
    else if (/[A-Z]/.test(ch)) units += 0.66;
    else if (/[il.,:;'|!]/.test(ch) || ch === " ") units += 0.28;
    else if (/[mw]/.test(ch)) units += 0.84;
    else units += 0.55;
  }
  return units * size;
}

/** Cuts a string to fit a width, ending in an ellipsis. Give it text that is already of a bounded length. */
export function fit(value: string, size: number, max: number): string {
  if (textWidth(value, size) <= max) return value;
  let cut = value;
  while (cut.length > 1 && textWidth(`${cut}\u2026`, size) > max) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}\u2026`;
}

/** A short, stable id for <title>/<desc>/<pattern> so several charts can share a document. */
export function chartId(prefix: string, seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

/** The id to use inside a figure: the option when it is one, with nothing in it but letters, digits, "-" and "_". */
export function safeId(value: unknown, fallback: () => string): string {
  const given = text(value, LIMITS.id).replace(/[^A-Za-z0-9_-]/g, "-");
  return given === "" ? fallback() : given;
}

/**
 * Opens a figure. Its size is in its `width` and `height` attributes and its
 * drawn width again in `data-w`; components.css keeps it from being shown
 * wider than that. There is no `style` attribute anywhere in a figure, so a
 * policy without 'unsafe-inline' has nothing to refuse.
 */
export function svgOpen(opts: { id: string; width: number; height: number; className: string; title: string; desc: string }): string {
  const { id, width, height, className, title, desc } = opts;
  return (
    `<svg class="lc ${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}" ` +
    `data-w="${n(width)}" role="img" aria-labelledby="${id}-t ${id}-d" font-family="${SANS}">` +
    `<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>`
  );
}

/** What a helper returns when it could not draw: a figure of the same kind that says so. */
export function voidSvg(className: string, width: number): string {
  const w = drawWidth(width, LIMITS.minWidth);
  const message = "This figure could not be drawn.";
  return (
    `<svg class="lc ${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} 48" width="${n(w)}" height="48" data-w="${n(w)}" role="img" aria-label="${message}" font-family="${SANS}">` +
    `<text class="lc-quiet" x="0" y="28" font-size="12.5" fill="${INK.paper2}">${message}</text></svg>`
  );
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `Fh3q…Tz8K`. */
export function short(address: string): string {
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** True for a plain object or an array: something whose fields can be read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** An own, enumerable-or-not property of a record, so nothing is ever read from a prototype. */
export function own(record: unknown, key: string): unknown {
  if (!isRecord(record) || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

/** Own-property lookup, so an address that spells an Object.prototype key can never produce a label. */
export function labelOf(labels: unknown, address: string): string | undefined {
  const label = own(labels, address);
  if (typeof label !== "string") return undefined;
  const clean = text(label, LIMITS.label);
  return clean === "" ? undefined : clean;
}

/** A finding as the helpers use it: every field the right type and a bounded size. */
export type ReadFinding = {
  id: string;
  /** Undefined when the report gave anything but "high", "medium" or "low". */
  severity: Severity | undefined;
  title: string;
  detail: string;
  /** 0 to 100. A penalty that is not a finite number counts as 0. */
  penalty: number;
};

const SEVERITIES: readonly string[] = ["high", "medium", "low"];

/** The report's address and its findings, read defensively. Entries that are not objects are left out. */
export function readReport(report: unknown): { address: string; findings: ReadFinding[] } {
  const address = text(own(report, "address"), LIMITS.address);
  const list = own(report, "findings");
  const findings: ReadFinding[] = [];
  if (Array.isArray(list)) {
    for (let i = 0; i < list.length; i++) {
      const item: unknown = list[i];
      if (!isRecord(item) || Array.isArray(item)) continue;
      const penalty = num(own(item, "penalty"), 0, 100, 0);
      // Only the findings written one by one have their words read. The rest are summed.
      if (findings.length >= LIMITS.findings) {
        findings.push({ id: "", severity: undefined, title: "", detail: "", penalty });
        continue;
      }
      const severity = own(item, "severity");
      findings.push({
        id: text(own(item, "id"), LIMITS.id),
        severity: typeof severity === "string" && SEVERITIES.includes(severity) ? (severity as Severity) : undefined,
        title: text(own(item, "title"), LIMITS.title),
        detail: text(own(item, "detail"), LIMITS.detail),
        penalty,
      });
    }
  }
  return { address, findings };
}

/** A transfer as the helpers use it. */
export type ReadFlow = {
  /** Block time in unix seconds; 0 when it is unknown or not a number. */
  time: number;
  dir: "in" | "out";
  counterparty: string;
};

/** The transfers, read defensively: at most `LIMITS.flows` of them, entries that are not objects left out. */
export function readFlows(flows: unknown): ReadFlow[] {
  const out: ReadFlow[] = [];
  if (!Array.isArray(flows)) return out;
  const count = Math.min(flows.length, LIMITS.flows);
  for (let i = 0; i < count; i++) {
    const item: unknown = flows[i];
    if (!isRecord(item) || Array.isArray(item)) continue;
    const time = own(item, "time");
    out.push({
      time: typeof time === "number" && Number.isFinite(time) ? time : 0,
      dir: own(item, "dir") === "in" ? "in" : "out",
      counterparty: text(own(item, "counterparty"), LIMITS.address),
    });
  }
  return out;
}

/** The width option of a helper, read where reading it cannot throw. */
export function widthOf(options: unknown, fallback: number): number {
  return never(
    () => drawWidth(own(options, "width"), fallback),
    () => fallback,
  );
}

/** Runs a helper and, should it throw on something no reading could make safe, returns `otherwise` instead. */
export function never<T>(draw: () => T, otherwise: () => T): T {
  try {
    return draw();
  } catch {
    return otherwise();
  }
}
