#!/usr/bin/env node
// Draws the marks from one drawing, mark/source/nessie.svg (Nessie as one even line, traced to curves):
//   mark/mark.svg          the mark: her silhouette on the tile. From 24px up.
//   mark/mark-night.svg    the same drawing under the names two surfaces ask for it by
//   mark/mark-on-land.svg
//   mark/mark-small.svg    for 16 to 24px: larger in the tile, no eye, the waterline on a pixel edge
//   mark/favicon.svg       the small mark again, for the browser tab
//   mark/mascot.svg, mascot-small.svg   Nessie alone on nothing, for the extension's icon
//   mark/mark-line.svg     her line itself, not filled in. From 96px up: an avatar, a title page, a poster.
//   mark/mark-mono.svg     one colour (currentColor)
// The tile is the first screen in small: the night sky, the waterline in buff, the water. She is buff above
// the line and loch blue below it, and only her head and neck are above it.
// Run build-mark.mjs after this to rasterise the PNGs and favicon.ico. `pnpm run mark` does both.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "mark");
const source = readFileSync(join(dir, "source", "nessie.svg"), "utf8");
const shape = (id) => new RegExp(`<path id="${id}" d="([^"]+)"`).exec(source)[1];
const SHAPES = { outer: shape("outer"), inner: shape("inner"), eye: shape("eye") };

// The pigments, as tokens.css has them.
const MIDNIGHT = "#0A1420";
const WATER = "#17394A";
const BUFF = "#E4D8B4";
const LOCH = "#A8D0E0";
// The water's blue at the one depth that shows on a light ground and on a dark one alike. For the mascot only.
const MASCOT = "#5A9DB8";

const TILE = 64;
/** How far down her drawing the waterline crosses it: through her neck, clear of her back. */
const LINE_AT = 0.46;

const numbers = (d) => d.match(/-?\d+\.?\d*/g).map(Number);
function box(d) {
  const all = numbers(d);
  const xs = all.filter((_, i) => i % 2 === 0);
  const ys = all.filter((_, i) => i % 2 === 1);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
/** A shape of the drawing, moved and scaled into the tile. Every command in it is absolute, so every pair of numbers is a point. */
function place(d, { scale, dx, dy }) {
  const round = (value) => String(Math.round(value * 100) / 100);
  return d
    .replace(/(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/g, (_, x, y) => `${round(x * scale + dx)} ${round(y * scale + dy)}`)
    .replace(/\s*([MLCz])\s*/g, "$1")
    .trim();
}
/** Where her drawing lies in the tile: so wide, centred, with the waterline at `line` from the top. */
function layout(width, line) {
  const b = box(SHAPES.outer);
  const scale = width / b.width;
  const top = line - LINE_AT * b.height * scale;
  return { scale, dx: (TILE - width) / 2 - b.x * scale, dy: top - b.y * scale };
}

/**
 * One mark on the tile.
 *   id      the prefix of every id in the file, so that two marks can stand in one document
 *   width   how wide she is in the 64-unit tile
 *   line    where the waterline is, and how thick
 *   drawn   "solid": her silhouette. "line": her line, with `weight` added to it.
 *   eye     whether she has one
 */
function tile({ id, title = "Loch", note, width, line, rule, drawn, weight = 0, eye }) {
  const at = layout(width, line);
  const outer = place(SHAPES.outer, at);
  const inner = place(SHAPES.inner, at);
  const pupil = place(SHAPES.eye, at);
  const stroke = weight ? ` stroke="currentColor" stroke-width="${weight}" stroke-linejoin="round"` : "";
  const her =
    drawn === "line"
      ? `<path fill-rule="evenodd"${stroke} d="${outer}${inner}"/>${eye ? `\n      <path${stroke} d="${pupil}"/>` : ""}`
      : `<path d="${outer}"/>`;
  const cut = drawn === "solid" && eye ? `\n    <path d="${pupil}" fill="${MIDNIGHT}" stroke="${MIDNIGHT}" stroke-width="0.4"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" role="img" aria-labelledby="${id}-t">
  <title id="${id}-t">${title}</title>
  <!--
${note.map((text) => `    ${text}`).join("\n")}
    Drawn by scripts/draw-mark.mjs from mark/source/nessie.svg. Change it there, not here.
  -->
  <defs>
    <clipPath id="${id}-tile"><rect width="${TILE}" height="${TILE}" rx="8"/></clipPath>
    <clipPath id="${id}-dry"><rect width="${TILE}" height="${line}"/></clipPath>
    <clipPath id="${id}-wet"><rect y="${line}" width="${TILE}" height="${TILE - line}"/></clipPath>
    <g id="${id}-n" fill="currentColor">
      ${her}
    </g>
  </defs>
  <g clip-path="url(#${id}-tile)">
    <rect width="${TILE}" height="${line}" fill="${MIDNIGHT}"/>
    <rect y="${line}" width="${TILE}" height="${TILE - line}" fill="${WATER}"/>
    <use href="#${id}-n" color="${BUFF}" clip-path="url(#${id}-dry)"/>
    <use href="#${id}-n" color="${LOCH}" clip-path="url(#${id}-wet)"/>${cut}
    <rect y="${line - rule / 2}" width="${TILE}" height="${rule}" fill="${BUFF}"/>
  </g>
  <rect x=".5" y=".5" width="63" height="63" rx="7.5" fill="none" stroke="${BUFF}" stroke-opacity=".22"/>
</svg>
`;
}

/** One colour. The counterchange is kept: above the waterline the sky is solid and she is cut out of it; below it she is solid and the water is left open. */
function mono({ id, width, line }) {
  const at = layout(width, line);
  const outer = place(SHAPES.outer, at);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" role="img" aria-labelledby="${id}-t">
  <title id="${id}-t">Loch</title>
  <!--
    One colour (currentColor). The counterchange is kept: above the waterline
    the sky is solid and she is cut out of it; below it she is solid and the
    water is left open.
    She is whole inside the tile: her tail ends in its own tip, and nothing of her is cut by the edge.
    Drawn by scripts/draw-mark.mjs from mark/source/nessie.svg. Change it there, not here.
  -->
  <defs>
    <clipPath id="${id}-tile"><rect width="${TILE}" height="${TILE}" rx="8"/></clipPath>
    <clipPath id="${id}-wet"><rect y="${line + 1.5}" width="${TILE}" height="${TILE - line - 1.5}"/></clipPath>
    <path id="${id}-n" d="${outer}"/>
    <mask id="${id}-sky" maskUnits="userSpaceOnUse" x="0" y="0" width="${TILE}" height="${line}">
      <rect width="${TILE}" height="${line}" fill="#fff"/>
      <use href="#${id}-n" fill="#000" stroke="#000" stroke-width="1.2"/>
    </mask>
  </defs>
  <g clip-path="url(#${id}-tile)">
    <rect width="${TILE}" height="${line}" fill="currentColor" mask="url(#${id}-sky)"/>
    <use href="#${id}-n" fill="currentColor" clip-path="url(#${id}-wet)"/>
  </g>
</svg>
`;
}

/**
 * The mascot alone: her silhouette on nothing. No tile, no sky, no water, no waterline, no outline.
 * For a place that brings a ground of its own and may be light or dark: a browser's toolbar, a wallet's list.
 *   width   how wide she is in the 64-unit square; she is centred in it both ways
 *   eye     whether she has one. It is a hole, so the ground shows through it.
 */
function mascot({ id, note, width, eye }) {
  const b = box(SHAPES.outer);
  const scale = width / b.width;
  const at = { scale, dx: (TILE - width) / 2 - b.x * scale, dy: (TILE - b.height * scale) / 2 - b.y * scale };
  const d = place(SHAPES.outer, at) + (eye ? place(SHAPES.eye, at) : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" role="img" aria-labelledby="${id}-t">
  <title id="${id}-t">Loch</title>
  <!--
${note.map((text) => `    ${text}`).join("\n")}
    Drawn by scripts/draw-mark.mjs from mark/source/nessie.svg. Change it there, not here.
  -->
  <path fill="${MASCOT}"${eye ? ' fill-rule="evenodd"' : ""} d="${d}"/>
</svg>
`;
}

const whole = "She is whole inside the tile: her tail ends in its own tip, and nothing of her is cut by the edge.";
const section = [
  "Nessie in section. The tile is the first screen in small: the night sky above",
  "the waterline, the water below it, and the line itself in buff. She is one",
  "silhouette, counterchanged where the line cuts her: buff where she is exposed,",
  "loch blue where she is not. Only her head and neck are above the line.",
  whole,
];
const files = {
  "mark.svg": tile({ id: "loch-mark", note: [...section, "Use this file from 24px up. Below that, use mark-small.svg. From 96px up there is also mark-line.svg."], width: 44, line: 28, rule: 1.2, drawn: "solid", eye: true }),
  "mark-night.svg": tile({ id: "loch-mark-n", note: [...section, "The same drawing as mark.svg. The tile is dark, so it stands on the night sky, on water and on buff alike."], width: 44, line: 28, rule: 1.2, drawn: "solid", eye: true }),
  "mark-on-land.svg": tile({ id: "loch-mark-l", note: [...section, "The same drawing as mark.svg. The tile is dark, so it stands on buff land as it does on the sky."], width: 44, line: 28, rule: 1.2, drawn: "solid", eye: true }),
  "mark-small.svg": tile({
    id: "loch-mark-s",
    note: ["The mark for 16 to 24px. She is larger in the tile and has no eye, which does not", "survive at this size, and the waterline is two units deep with its top on a pixel", "edge of the 16px grid (y = 28 of 64 is 7 of 16). Her tail ends inside the tile, in a tip of its own."],
    width: 50,
    line: 28,
    rule: 2,
    drawn: "solid",
    eye: false,
  }),
  "favicon.svg": tile({
    id: "loch-fav",
    note: ["The favicon: the small mark. She is larger in the tile and has no eye, and the", "waterline is two units deep with its top on a pixel edge of the 16px grid.", "Her tail ends inside the tile, in a tip of its own."],
    width: 50,
    line: 28,
    rule: 2,
    drawn: "solid",
    eye: false,
  }),
  "mark-line.svg": tile({
    id: "loch-mark-line",
    note: ["Her line itself, not filled in: the drawing the other marks are the silhouette of.", "The same tile and the same place in it. Buff above the waterline, loch blue below.", "From 96px up only: an avatar, a title page, a poster. Smaller, her line is too fine: use mark.svg.", whole],
    width: 44,
    line: 28,
    rule: 1,
    drawn: "line",
    weight: 0.35,
    eye: true,
  }),
  "mascot.svg": mascot({
    id: "loch-mascot",
    note: ["Nessie alone, in one colour, on nothing: no tile, no waterline, no outline. Her eye is a hole.", "For a ground that is not ours and may be light or dark: the extension's icon, a wallet's list.", "Use this file from 24px up. Below that, use mascot-small.svg."],
    width: 60,
    eye: true,
  }),
  "mascot-small.svg": mascot({
    id: "loch-mascot-s",
    note: ["The mascot for 16 to 24px: no eye, which does not survive at this size."],
    width: 62,
    eye: false,
  }),
  "mark-mono.svg": mono({ id: "loch-mark-m", width: 44, line: 28 }),
};
for (const [name, svg] of Object.entries(files)) {
  writeFileSync(join(dir, name), svg);
  console.log(`mark/${name}  ${svg.length} bytes`);
}
