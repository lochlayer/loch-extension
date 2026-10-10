import { INK, LIMITS, chartId, esc, fit, labelOf, n, never, num, plural, readFlows, safeId, short, svgOpen, textWidth, voidSvg, widthOf } from "./shared.js";
import type { FlowLike, LabelsLike } from "./types.js";

export type Counterparty = {
  address: string;
  /** Transfers with this address, both directions. */
  count: number;
  inbound: number;
  outbound: number;
  /** Name from the label map, when there is one. A named address is an identified service. */
  label?: string;
  /** True for the sender of the wallet's first inbound transfer. */
  funder: boolean;
  /** True from three transfers up, the scanner's threshold. */
  recurring: boolean;
};

/**
 * Every address the wallet has dealt with, busiest first. Ties keep first-seen order.
 * Reads at most 50 000 transfers. An address is plain text of at most 128 characters
 * and a label of at most 48.
 */
export function counterpartyList(flows: readonly FlowLike[], labels?: LabelsLike): Counterparty[] {
  return never(
    () => list(flows, labels),
    () => [],
  );
}

function list(flows: readonly FlowLike[], labels: unknown): Counterparty[] {
  const read = readFlows(flows);
  const map = new Map<string, Counterparty>();
  let firstIn: { counterparty: string; time: number } | undefined;
  for (const flow of read) {
    let entry = map.get(flow.counterparty);
    if (!entry) {
      entry = { address: flow.counterparty, count: 0, inbound: 0, outbound: 0, funder: false, recurring: false };
      const label = labelOf(labels, flow.counterparty);
      if (label) entry.label = label;
      map.set(flow.counterparty, entry);
    }
    entry.count += 1;
    if (flow.dir === "in") {
      entry.inbound += 1;
      // The earliest inbound transfer; of two at the same time, the one that came first in the list.
      if (!firstIn || flow.time < firstIn.time) firstIn = flow;
    } else entry.outbound += 1;
  }
  if (firstIn) map.get(firstIn.counterparty)!.funder = true;
  for (const entry of map.values()) entry.recurring = entry.count >= 3;
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** How many addresses to draw one by one: the option when it is a number, 0 to 12. Default 5. */
function most(max: unknown): number {
  return Math.floor(num(max, 0, LIMITS.rows, 5));
}

function shown(all: readonly Counterparty[], max: number): { rows: Counterparty[]; rest: number; restCount: number } {
  // Lead with what the report names: recurring addresses, identified services, the funder.
  const rows: Counterparty[] = [];
  let total = 0;
  for (const c of all) {
    total += c.count;
    if (rows.length < max && (c.recurring || c.label !== undefined || c.funder)) rows.push(c);
  }
  let drawn = 0;
  for (const c of rows) drawn += c.count;
  return { rows, rest: all.length - rows.length, restCount: total - drawn };
}

function note(c: Counterparty): string {
  const notes: string[] = [];
  if (c.label) notes.push(c.label);
  if (c.funder) notes.push("funded this wallet");
  return notes.join(", ");
}

/** The note under an address, on one line when it fits and on two when it does not. */
function noteLines(c: Counterparty, max: number): string[] {
  const whole = note(c);
  if (whole === "") return [];
  if (textWidth(whole, LABEL) <= max || !(c.label && c.funder)) return [fit(whole, LABEL, max)];
  return [fit(c.label, LABEL, max), "funded this wallet"];
}

/** The counterparties figure in words. Plain text, not markup: escape it where it goes into a page. */
export function counterpartiesText(flows: readonly FlowLike[], options: { labels?: LabelsLike; max?: number } = {}): string {
  return never(
    () => {
      const all = list(flows, options?.labels);
      if (all.length === 0) return "No transfers, so no counterparties.";
      const { rows, rest, restCount } = shown(all, most(options?.max));
      const transfers = all.reduce((sum, c) => sum + c.count, 0);
      const parts = [`This wallet has dealt with ${plural(all.length, "address", "addresses")} in ${plural(transfers, "transfer", "transfers")}.`];
      for (const c of rows) {
        const extra = note(c);
        parts.push(`${short(c.address)}: ${plural(c.count, "transfer", "transfers")}${extra ? ` (${extra})` : ""}.`);
      }
      if (rest > 0) parts.push(`${plural(rest, "other address", "other addresses")}, ${plural(restCount, "transfer", "transfers")} between them.`);
      return parts.join(" ");
    },
    () => "The counterparties could not be read.",
  );
}

export type CounterpartiesOptions = {
  /** Address to name. A named address is drawn as an identified service, in magenta. */
  labels?: LabelsLike;
  /** Most addresses to draw one by one, 0 to 12. Default 5. The rest are summed in one last line. */
  max?: number;
  /** Width in px to draw at, 240 to 4000. Default 420. */
  width?: number;
  /** Prefix for the ids inside the SVG: letters, digits, "-" and "_". */
  id?: string;
};

const LABEL = 12.5;

/**
 * Who a wallet deals with, drawn as bearings taken from one station: the
 * wallet on the left, a ruled line to each address it keeps returning to,
 * heavier the more often. Everything here is public, so every line is solid
 * and every letter upright. An identified service is ringed in magenta.
 *
 * It never throws and never writes an address or a label unescaped.
 */
export function counterpartiesSvg(flows: readonly FlowLike[], options: CounterpartiesOptions = {}): string {
  const width = widthOf(options, 420);
  return never(
    () => draw(flows, options ?? {}, width),
    () => voidSvg("lc-who", width),
  );
}

function draw(flows: readonly FlowLike[], options: CounterpartiesOptions, width: number): string {
  const all = list(flows, options.labels);
  const { rows, rest } = shown(all, most(options.max));

  // Room on the right for the lettering: as wide as the widest address line, more if a note needs it, never more than 56%.
  const room = width * 0.56;
  let addressW = Math.max(120, rest > 0 ? textWidth(`${rest} others`, LABEL) : 0);
  let noteW = 0;
  for (const c of rows) {
    addressW = Math.max(addressW, textWidth(`${short(c.address)}  \u00d7${c.count}`, LABEL) + 6);
    noteW = Math.max(noteW, textWidth(note(c), LABEL));
  }
  const labelW = Math.min(room, Math.max(addressW, noteW) + 14);
  const notes = rows.map((c) => noteLines(c, labelW - 14));
  const noteRows = notes.reduce((deepest, l) => Math.max(deepest, l.length), 0);
  const rowH = 26 + 13 * noteRows;
  const lines = rows.length + (rest > 0 ? 1 : 0);
  const top = 8;
  const height = Math.max(96, top * 2 + Math.max(1, lines) * rowH);
  // A stable id from what is drawn: the first addresses and how many there are in all.
  const seed = `${all.slice(0, 64).map((c) => `${c.address}${c.count}`).join("")}:${all.length}:${width}`;
  const id = safeId(options.id, () => chartId("who", seed));

  let out = svgOpen({ id, width, height, className: "lc-who", title: "Who this wallet deals with", desc: counterpartiesText(flows, options) });
  if (all.length === 0) {
    out += `<text class="lc-quiet" x="0" y="${n(height / 2)}" font-size="${LABEL}" fill="${INK.paper2}">No transfers found.</text>`;
    return out + `</svg>`;
  }

  const stationX = 9;
  const stationY = height / 2;
  const nodeX = width - labelW;
  // Busiest first, so the first is the peak.
  const peak = Math.max(1, all[0]!.count);
  const rowY = (i: number) => top + rowH * i + rowH / 2;

  rows.forEach((c, i) => {
    const y = rowY(i);
    const weight = 1 + (3.5 * c.count) / peak;
    out += `<line class="lc-link" x1="${stationX}" y1="${n(stationY)}" x2="${n(nodeX)}" y2="${n(y)}" stroke="${INK.buff}" stroke-width="${n(weight)}"/>`;
  });
  if (rest > 0) {
    const y = rowY(rows.length);
    for (const dy of [-5, 0, 5]) {
      out += `<line class="lc-link-faint" x1="${stationX}" y1="${n(stationY)}" x2="${n(nodeX)}" y2="${n(y + dy)}" stroke="${INK.rule}"/>`;
    }
  }

  rows.forEach((c, i) => {
    const y = rowY(i);
    const extra = notes[i]!;
    // The address sits on the node's line; its note hangs under it.
    const ty = y + 4.5 - (extra.length * 14) / 2;
    out += `<circle class="${c.label ? "lc-node-caution" : "lc-node"}" cx="${n(nodeX)}" cy="${n(y)}" r="4" fill="${INK.bed}" stroke="${c.label ? INK.magenta : INK.buff}" stroke-width="1.5"/>`;
    out +=
      `<text class="lc-strong" x="${n(nodeX + 12)}" y="${n(ty)}" font-size="${LABEL}" font-weight="600" fill="${INK.paper}">` +
      `${esc(short(c.address))}<tspan class="lc-label" dx="7" font-weight="500" fill="${INK.buff}">\u00d7${n(c.count)}</tspan></text>`;
    extra.forEach((line, k) => {
      out += `<text class="${c.label ? "lc-note-caution" : "lc-quiet"}" x="${n(nodeX + 12)}" y="${n(ty + 14 * (k + 1))}" font-size="${LABEL}" font-weight="500" fill="${c.label ? INK.magenta : INK.paper2}">${esc(line)}</text>`;
    });
  });
  if (rest > 0) {
    const y = rowY(rows.length);
    out += `<text class="lc-quiet" x="${n(nodeX + 12)}" y="${n(y + 4.5)}" font-size="${LABEL}" fill="${INK.paper2}">${plural(rest, "other", "others")}</text>`;
  }

  // The station: this wallet. A position fix, drawn last so the lines run under it.
  out += `<circle class="lc-node" cx="${stationX}" cy="${n(stationY)}" r="7.5" fill="${INK.bed}" stroke="${INK.buff}" stroke-width="1.5"/>`;
  out += `<circle class="lc-station" cx="${stationX}" cy="${n(stationY)}" r="2.5" fill="${INK.buff}"/>`;
  return out + `</svg>`;
}
