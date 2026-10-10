import { MINUS } from "../numerals.js";
import { INK, LIMITS, SERIF, chartId, esc, fit, labelOf, n, never, num, readReport, safeId, svgOpen, text, textWidth, voidSvg, widthOf } from "./shared.js";
import { statementLines, statementText } from "./statement.js";
import type { StatementLine } from "./statement.js";
import type { LeakReportLike } from "./types.js";

/** Column heads for the scanner's finding ids. One short word each. */
export const FINDING_SHORT_LABELS: Record<string, string> = {
  "funding-source": "Funding",
  "identified-services": "Services",
  "recurring-counterparties": "Payees",
  "time-zone": "Hours",
  "pass-through": "Amounts",
  "balance-visible": "Balance",
  "recipient-identified": "Recipient",
  "amount-pass-through": "Amount",
  "new-counterparty": "New link",
  "recurring-counterparty": "Repeat",
};

export type SteppedBedOptions = {
  /** Width in px to draw at, 240 to 4000. Draw at the width of the container (the SVG shrinks to fit, but its lettering shrinks with it). Default 640. */
  width?: number;
  /** Height in px of 100 points of depth, 40 to 1000. Default 216, or 168 below 420px wide. */
  depth?: number;
  /** Column heads by finding id, merged over {@link FINDING_SHORT_LABELS}. */
  labels?: Record<string, string>;
  /** Head of the first column. Default "No leaks". */
  startLabel?: string;
  /** Prefix for the ids inside the SVG: letters, digits, "-" and "_". Default derives one from the report. */
  id?: string;
  /** Adds the class that makes the soundings drop once (after a scan). Default false. */
  animate?: boolean;
};

const LABEL_SIZE = 12.5;
const SOUNDING_SIZE = 22;
const GAP = 2;
/** The narrowest column a 22px sounding can stand in. */
const MIN_COLUMN = 30;
/** Characters of a column head. */
const HEAD = 24;

/** No more columns than the width has room for: past that, the last column stands for every finding that is left. */
function columns(lines: StatementLine[], width: number): StatementLine[] {
  const most = Math.min(LIMITS.findings + 1, Math.max(2, Math.floor((width + GAP) / (MIN_COLUMN + GAP))));
  if (lines.length <= most) return lines;
  const tail = lines.slice(most - 1);
  const last = tail[tail.length - 1]!;
  let less = 0;
  let lost = 0;
  let merged = 0;
  for (const line of tail) {
    less = Math.min(100, less + line.less);
    lost += line.lost;
    merged += line.merged ?? 1;
  }
  return [...lines.slice(0, most - 1), { kind: "finding", title: "More", less, lost, balance: last.balance, merged }];
}

function head(line: StatementLine, labels: unknown): string {
  if (line.merged !== undefined) return "More";
  const id = line.id ?? "";
  const known = labelOf(labels, id) ?? labelOf(FINDING_SHORT_LABELS, id);
  return text(known ?? line.title.split(/\s+/)[0] ?? "", HEAD);
}

/**
 * The stepped bed. A wallet with no leaks sits 100 deep; each finding takes
 * depth away; the hatched block is what it cost; where the bed ends up is the
 * score. One column per finding, in the report's order, after a first column
 * at 100.
 *
 * Returns inline SVG markup with a <title> and a <desc> that carries the
 * whole statement. Pair it with `statementHtml(report)` for a visible table
 * of the same numbers.
 *
 * It never throws and never writes anything from the report unescaped. A
 * width or a depth that is not a finite number falls back to the default.
 */
export function steppedBedSvg(report: LeakReportLike, options: SteppedBedOptions = {}): string {
  const width = widthOf(options, 640);
  return never(
    () => draw(report, options ?? {}, width),
    () => voidSvg("lc-bed", width),
  );
}

function draw(report: LeakReportLike, options: SteppedBedOptions, width: number): string {
  const depth = num(options.depth, 40, 1000, width < 420 ? 168 : 216);
  const lines = columns(
    statementLines(report).filter((l) => l.kind !== "total"),
    width,
  );
  const count = lines.length;
  const col = (width - GAP * (count - 1)) / count;
  const start = text(options.startLabel, HEAD) || "No leaks";
  const named = lines.map((line, i) => (i === 0 ? start : head(line, options.labels)));

  // Column heads sit on one row when they fit, otherwise on two, alternating.
  const widest = named.reduce((most, h) => Math.max(most, textWidth(h, LABEL_SIZE)), 0);
  const stagger = widest + 6 > col;
  // On two rows a head has the width of two columns before it meets its neighbour.
  const heads = stagger ? named.map((h) => fit(h, LABEL_SIZE, 2 * (col + GAP) - 8)) : named;
  const headRows = stagger ? 2 : 1;
  const top = headRows * 17 + 9;
  const bottom = top + depth;
  const height = bottom + 26;
  const score = lines[lines.length - 1]!.balance;
  const id = safeId(options.id, () => chartId("bed", `${readReport(report).address}:${score}:${count}:${width}`));
  const y = (points: number) => top + (depth * points) / 100;

  const title = `Privacy score ${n(score)} of 100, drawn as a stepped bed`;
  let out = svgOpen({ id, width, height, className: `lc-bed${options.animate === true ? " is-sounding" : ""}`, title, desc: statementText(report) });

  out +=
    `<defs><pattern id="${id}-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line class="lc-hatch-line" x1="0.5" y1="0" x2="0.5" y2="6" stroke="${INK.magenta}" stroke-opacity="0.7"/></pattern></defs>`;

  let previous = 100;
  lines.forEach((line, i) => {
    const x = i * (col + GAP);
    const cx = x + col / 2;
    const bedY = y(line.balance);
    const headY = stagger && i % 2 === 1 ? top - 9 - 17 : top - 9;

    // Column head, with a leader down to the surface when it is on the upper row.
    out += `<text class="lc-label" x="${n(cx)}" y="${n(headY)}" text-anchor="middle" font-size="${LABEL_SIZE}" fill="${INK.buff}">${esc(heads[i]!)}</text>`;
    if (stagger && i % 2 === 1) {
      out += `<line class="lc-rule" x1="${n(cx)}" y1="${n(headY + 5)}" x2="${n(cx)}" y2="${n(top - 3)}" stroke="${INK.rule}"/>`;
    }

    // The ground under the bed, and the part of it this finding raised.
    if (line.balance < 100) {
      out += `<rect class="lc-ground" x="${n(x)}" y="${n(bedY)}" width="${n(col)}" height="${n(bottom - bedY)}" fill="${INK.bed}"/>`;
    }
    if (line.lost > 0) {
      out += `<rect x="${n(x)}" y="${n(bedY)}" width="${n(col)}" height="${n(y(previous) - bedY)}" fill="url(#${id}-h)"/>`;
    }

    // The water, and the bed line under it. data-i is the column's place in the drop sequence
    // (components.css turns it into a delay): an attribute, because a style attribute is
    // refused by a Content-Security-Policy without 'unsafe-inline'.
    out += `<g class="lc-col" data-i="${i}">`;
    if (line.balance > 0) {
      out += `<rect class="lc-water" x="${n(x)}" y="${n(top)}" width="${n(col)}" height="${n(bedY - top)}" fill="${INK.water}"/>`;
    }
    out += `<line class="lc-bedline" x1="${n(x)}" y1="${n(bedY)}" x2="${n(x + col)}" y2="${n(bedY)}" stroke="${INK.loch}" stroke-width="2"/>`;
    out += `</g>`;

    // The sounding: what is left. In the water when there is room, otherwise just under the bed line.
    const room = bedY - top;
    const figY = room >= SOUNDING_SIZE + 14 ? bedY - 9 : bedY + SOUNDING_SIZE + 2;
    out += `<text class="lc-sounding" data-i="${i}" x="${n(cx)}" y="${n(figY)}" text-anchor="middle" font-family="${SERIF}" font-size="${SOUNDING_SIZE}" fill="${INK.buff}">${n(line.balance)}</text>`;

    // What it cost.
    if (i === 0) {
      out += `<text class="lc-quiet" x="${n(cx)}" y="${n(bottom + 19)}" text-anchor="middle" font-size="${LABEL_SIZE}" fill="${INK.paper2}">start</text>`;
    } else {
      out += `<text class="lc-caution" x="${n(cx)}" y="${n(bottom + 19)}" text-anchor="middle" font-size="${LABEL_SIZE}" font-weight="600" fill="${INK.magenta}">${MINUS}${n(line.less)}</text>`;
    }
    previous = line.balance;
  });

  // The floor of the figure (100 deep) and, last so it lies over everything, the surface.
  out += `<line class="lc-rule" x1="0" y1="${n(bottom + 0.5)}" x2="${n(width)}" y2="${n(bottom + 0.5)}" stroke="${INK.rule}"/>`;
  out += `<line class="lc-surface" x1="0" y1="${n(top)}" x2="${n(width)}" y2="${n(top)}" stroke="${INK.buff}" stroke-width="2"/>`;
  return out + `</svg>`;
}

/** The text alternative of the stepped bed (the same string the SVG's <desc> carries). */
export function steppedBedText(report: LeakReportLike): string {
  return statementText(report);
}
