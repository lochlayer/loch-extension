import { INK, chartId, n, never, num, plural, readFlows, safeId, svgOpen, textWidth, voidSvg, widthOf } from "./shared.js";
import type { FlowLike } from "./types.js";

/**
 * Transfers in each UTC hour, 0 to 23. Flows with no block time are left out, as the scanner
 * leaves them out; so is a time that is not a number, or that no calendar has.
 */
export function hourCounts(flows: readonly FlowLike[]): number[] {
  return never(
    () => {
      const hours = new Array<number>(24).fill(0);
      for (const flow of readFlows(flows)) {
        if (!flow.time) continue;
        const h = new Date(flow.time * 1000).getUTCHours();
        if (h >= 0 && h <= 23) hours[h] = (hours[h] ?? 0) + 1;
      }
      return hours;
    },
    () => new Array<number>(24).fill(0),
  );
}

export type QuietWindow = {
  /** First quiet hour, UTC, 0 to 23. */
  start: number;
  /** Hour the window ends, UTC, 0 to 23 (start + 6, wrapped). */
  end: number;
  /** Transfers inside the window. */
  count: number;
  /** Timed transfers in total. */
  total: number;
  /** True when the scanner would report it: 20 or more timed transfers and under 5% of them in the window. */
  guessable: boolean;
};

/** Twenty-four counts, whatever was given: anything that is not a count is 0. */
function counts(hours: readonly number[]): number[] {
  const list: readonly unknown[] = Array.isArray(hours) ? hours : [];
  return Array.from({ length: 24 }, (_, h) => Math.floor(num(list[h], 0, Number.MAX_SAFE_INTEGER, 0)));
}

/** The quietest six-hour window, found exactly as the scanner's time-zone check finds it. */
export function quietWindow(hours: readonly number[]): QuietWindow | null {
  const hour = counts(hours);
  const total = hour.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let start = 0;
  let count = Infinity;
  for (let h = 0; h < 24; h++) {
    let sum = 0;
    for (let k = 0; k < 6; k++) sum += hour[(h + k) % 24] ?? 0;
    if (sum < count) {
      count = sum;
      start = h;
    }
  }
  return { start, end: (start + 6) % 24, count, total, guessable: total >= 20 && count / total < 0.05 };
}

/** An hour on the 24-hour clock, with two digits, as the scanner's sentences write it: `04:00`. */
const hh = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

/** The by-hour figure in words. */
export function byHourText(flows: readonly FlowLike[]): string {
  const hours = hourCounts(flows);
  const quiet = quietWindow(hours);
  if (!quiet) return "No transfers with a known time.";
  const peak = hours.reduce((a, b) => Math.max(a, b), 0);
  const peakHour = hours.indexOf(peak);
  const base = `${plural(quiet.total, "transfer", "transfers")} by hour of day, UTC. Busiest hour ${hh(peakHour)}, ${plural(peak, "transfer", "transfers")}.`;
  const window = `${hh(quiet.start)} to ${hh(quiet.end)} UTC`;
  return quiet.guessable
    ? `${base} Almost nothing from ${window} (${quiet.count} of ${quiet.total}): that is probably when the owner sleeps, which gives away a time zone.`
    : `${base} Quietest six hours: ${window}, ${quiet.count} of ${quiet.total}. Not quiet enough to give away a time zone.`;
}

export type ByHourOptions = {
  /** Width in px to draw at, 240 to 4000. Default 420. */
  width?: number;
  /** Height in px of the deepest column, 24 to 600. Default 96. */
  depth?: number;
  /** Prefix for the ids inside the SVG: letters, digits, "-" and "_". */
  id?: string;
};

const LABEL = 12.5;
const GAP = 2;
/** Clear space kept between two labels on one line. */
const CLEAR = 8;

/**
 * Transfers by hour of day, drawn in the same section language as the
 * stepped bed: 24 soundings hanging from the surface, deeper where the wallet
 * is busier. The quiet window is the shoal, and the shoal is the leak: when
 * the scanner would flag it, it is hatched and lettered in magenta.
 *
 * The caution is lettered under the hatching it names. It starts where the
 * hatching starts, or ends where the hatching ends when that would run it
 * off the figure. A window that wraps past midnight is hatched at both ends
 * of the day, and the words stand under the longer part. Where that would
 * run them into the figure of the busiest hour, they drop a line.
 */
export function byHourSvg(flows: readonly FlowLike[], options: ByHourOptions = {}): string {
  const width = widthOf(options, 420);
  return never(
    () => draw(flows, options ?? {}, width),
    () => voidSvg("lc-hours", width),
  );
}

function draw(flows: readonly FlowLike[], options: ByHourOptions, width: number): string {
  const depth = num(options.depth, 24, 600, 96);
  const hours = hourCounts(flows);
  const quiet = quietWindow(hours);
  const deepest = hours.reduce((a, b) => Math.max(a, b), 0);
  const peak = Math.max(1, deepest);
  const peakHour = hours.indexOf(deepest);
  const top = 24;
  const bottom = top + depth;
  const col = (width - GAP * 23) / 24;
  const id = safeId(options.id, () => chartId("hours", `${hours.join(",")}:${width}`));
  const x = (hour: number) => hour * (col + GAP);

  // Where the one figure under the columns goes: the count of the busiest hour.
  let figure: { text: string; anchor: "start" | "middle" | "end"; x: number; from: number; to: number } | null = null;
  if (deepest > 0) {
    const cx = x(peakHour) + col / 2;
    const anchor = cx < 24 ? "start" : cx > width - 24 ? "end" : "middle";
    const lx = anchor === "start" ? x(peakHour) : anchor === "end" ? x(peakHour) + col : cx;
    const w = textWidth(String(deepest), LABEL);
    const from = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
    figure = { text: String(deepest), anchor, x: lx, from, to: from + w };
  }

  // Where the caution goes: under the hatching.
  let caution: { text: string; anchor: "start" | "end"; x: number; row: number } | null = null;
  if (quiet?.guessable) {
    const label = `Quiet ${hh(quiet.start)} to ${hh(quiet.end)}`;
    const w = textWidth(label, LABEL);
    // The hatched hours, as one stretch or, past midnight, as two. The longer one carries the words.
    const late = Math.min(6, 24 - quiet.start);
    const early = 6 - late;
    const first = early >= late ? 0 : quiet.start;
    const length = early >= late ? early : late;
    const from = x(first);
    const to = x(first + length - 1) + col;
    const clear = (a: number, b: number) => !figure || b + CLEAR <= figure.from || a - CLEAR >= figure.to;
    const places: { anchor: "start" | "end"; x: number; from: number; to: number }[] = [];
    if (from + w <= width) places.push({ anchor: "start", x: from, from, to: from + w });
    if (to - w >= 0) places.push({ anchor: "end", x: to, from: to - w, to });
    if (places.length === 0) places.push({ anchor: "start", x: 0, from: 0, to: w });
    const place = places.find((p) => clear(p.from, p.to));
    caution = { text: label, anchor: (place ?? places[0]!).anchor, x: (place ?? places[0]!).x, row: place ? 0 : 1 };
  }

  const height = bottom + 28 + (caution?.row === 1 ? 16 : 0);

  let out = svgOpen({ id, width, height, className: "lc-hours", title: "Transfers by hour of day, UTC", desc: byHourText(flows) });
  out +=
    `<defs><pattern id="${id}-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line class="lc-hatch-line" x1="0.5" y1="0" x2="0.5" y2="6" stroke="${INK.magenta}" stroke-opacity="0.7"/></pattern></defs>`;

  // Hour marks along the surface, every six hours.
  for (const hour of [0, 6, 12, 18]) {
    out += `<text class="lc-quiet" x="${n(x(hour) + 5)}" y="${n(top - 9)}" font-size="${LABEL}" fill="${INK.paper2}">${String(hour).padStart(2, "0")}</text>`;
    out += `<line class="lc-rule" x1="${n(x(hour) + 0.5)}" y1="${n(top - 5)}" x2="${n(x(hour) + 0.5)}" y2="${n(top)}" stroke="${INK.rule}"/>`;
  }
  // The end of the day names the clock, where there is room beside the mark for 18.
  const roomy = x(18) + 5 + textWidth("18", LABEL) + CLEAR <= width - textWidth("24 UTC", LABEL);
  out += `<text class="lc-quiet" x="${n(width)}" y="${n(top - 9)}" text-anchor="end" font-size="${LABEL}" fill="${INK.paper2}">${roomy ? "24 UTC" : "24"}</text>`;

  // The soundings: ground under every hour, water down to the bed line, as in the stepped bed.
  const quietHours = new Set<number>();
  if (quiet?.guessable) for (let k = 0; k < 6; k++) quietHours.add((quiet.start + k) % 24);
  hours.forEach((count, hour) => {
    const h = count === 0 ? 0 : Math.max(3, (depth * count) / peak);
    out += `<rect class="lc-ground" x="${n(x(hour))}" y="${n(top + h)}" width="${n(col)}" height="${n(depth - h)}" fill="${INK.bed}"/>`;
    // The shoal: the six quietest hours, when they give the time zone away.
    if (quietHours.has(hour)) {
      out += `<rect x="${n(x(hour))}" y="${n(top + h)}" width="${n(col)}" height="${n(depth - h)}" fill="url(#${id}-h)"/>`;
    }
    if (count === 0) return;
    out += `<rect class="lc-water" x="${n(x(hour))}" y="${n(top)}" width="${n(col)}" height="${n(h)}" fill="${INK.water}"/>`;
    out += `<line class="lc-bedline" x1="${n(x(hour))}" y1="${n(top + h)}" x2="${n(x(hour) + col)}" y2="${n(top + h)}" stroke="${INK.loch}" stroke-width="2"/>`;
  });

  // One figure only: the deepest.
  if (figure) {
    out += `<text class="lc-label" x="${n(figure.x)}" y="${n(bottom + 18)}" text-anchor="${figure.anchor}" font-size="${LABEL}" font-weight="500" fill="${INK.buff}">${figure.text}</text>`;
  }

  // The caution, in words, under the hatching it names.
  if (caution) {
    out += `<text class="lc-caution" x="${n(caution.x)}" y="${n(bottom + 18 + caution.row * 16)}" text-anchor="${caution.anchor}" font-size="${LABEL}" font-weight="600" fill="${INK.magenta}">${caution.text}</text>`;
  }

  out += `<line class="lc-surface" x1="0" y1="${n(top)}" x2="${n(width)}" y2="${n(top)}" stroke="${INK.buff}" stroke-width="2"/>`;
  return out + `</svg>`;
}
