// Reads tokens.css and resolves the colour tokens of each palette to plain
// sRGB, so that contrast can be measured from the file that ships rather
// than from a copy of its values.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const tokensPath = join(here, "..", "..", "tokens.css");
export const basePath = join(here, "..", "..", "base.css");
export const componentsPath = join(here, "..", "..", "components.css");

function block(css, startsWith) {
  const at = css.indexOf(startsWith);
  if (at < 0) throw new Error(`tokens.css: block not found: ${startsWith}`);
  const open = css.indexOf("{", at);
  let depth = 1;
  let i = open + 1;
  while (depth > 0) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(open + 1, i - 1);
}

function declarations(body) {
  const out = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[match[1]] = match[2].trim();
  return out;
}

/** Custom properties of a palette, unresolved: pigments + dusk (+ night) + the root's ground roles. */
export function paletteTokens(theme = "dusk") {
  const css = readFileSync(tokensPath, "utf8");
  const pigments = declarations(block(css, ":root {\n    --pigment-buff"));
  const dusk = declarations(block(css, ':root,\n  [data-theme="dusk"] {'));
  const night = theme === "night" ? declarations(block(css, '[data-theme="night"] {')) : {};
  const roles = declarations(block(css, ":root,\n  [data-theme] {"));
  return { ...pigments, ...dusk, ...night, ...roles };
}

/** What a ground points each role at: the custom properties `.land { … }` or `.water { … }` sets in base.css. */
export function groundRoles(ground) {
  return declarations(block(readFileSync(basePath, "utf8"), `\n  .${ground} {`));
}

/** The token behind a role on a ground: "--text-2" on water is "--paper-2", on land "--land-ink-2". */
export function inkOnGround(ground, role) {
  const value = groundRoles(ground)[role];
  const match = /^var\((--[\w-]+)\)$/.exec(value ?? "");
  if (!match) throw new Error(`base.css: .${ground} does not set ${role} to a token`);
  return match[1];
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule in components.css as [selector list, body], at-rules flattened. */
export function componentRules() {
  const css = stripComments(readFileSync(componentsPath, "utf8"));
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    if (selector.startsWith("@") || /^(from|to|\d+%)$/.test(selector)) continue;
    rules.push([selector, match[2]]);
  }
  return rules;
}

/** The role a rule in components.css sets its text in: `color: var(--text-2)` gives "--text-2". */
export function inkOf(selector) {
  const rule = componentRules().find(([s]) => s === selector);
  if (!rule) throw new Error(`components.css: no rule for ${selector}`);
  const match = /(?:^|;|\s)color:\s*var\((--[\w-]+)\)/.exec(rule[1]);
  if (!match) throw new Error(`components.css: ${selector} does not set color to a role`);
  return match[1];
}

/**
 * Rules that set text in the disabled ink although nothing about them is
 * disabled. The disabled ink measures 3.7 to 5.9 on water and 3.2 to 3.9 on
 * land: it is for controls that cannot be used, which need not be read, and
 * for a placeholder inside a field, which is measured on its own.
 */
export function disabledInkMisuse() {
  const allowed = /:disabled|\[aria-disabled|::placeholder/;
  return componentRules()
    .filter(([, body]) => /(?:^|;|\s)color:\s*var\(--text-disabled\)/.test(body))
    .flatMap(([selector]) => selector.split(",").map((part) => part.trim()))
    .filter((part) => !allowed.test(part));
}

/** Resolves var() chains. Returns the raw CSS value. */
export function resolve(tokens, value) {
  let v = value;
  for (let guard = 0; guard < 12 && /var\(/.test(v); guard++) {
    v = v.replace(/var\((--[\w-]+)\)/g, (_, name) => {
      if (!(name in tokens)) throw new Error(`tokens.css: ${name} is not defined`);
      return tokens[name];
    });
  }
  return v;
}

/** Parses #rgb, #rrggbb or rgb(r g b / a) into { r, g, b, a } with channels 0 to 255. */
export function parseColor(value) {
  const v = value.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const int = parseInt(m[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
  }
  m = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`cannot parse colour: ${value}`);
}

export function color(tokens, name) {
  return parseColor(resolve(tokens, tokens[name] ?? name));
}

/** Composites a possibly translucent colour over an opaque one. */
export function over(fg, bg) {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

export function luminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio. A translucent foreground is composited over the background first. */
export function contrast(fg, bg) {
  const f = fg.a < 1 ? over(fg, bg) : fg;
  const [hi, lo] = [luminance(f), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function hex({ r, g, b }) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

const INK_NAMES = {
  "--paper": "paper",
  "--paper-2": "paper 2",
  "--paper-disabled": "paper, faint",
  "--land-ink": "land ink",
  "--land-ink-2": "land ink 2",
  "--land-ink-disabled": "land ink, disabled",
};

/**
 * Every pairing the system allows, and the ones it forbids. `min` is the
 * WCAG threshold the pairing has to meet: 4.5 for text, 3 for the edge of a
 * control, a focus ring or a mark in a figure.
 */
export function pairings(theme) {
  const water = [
    ["--water-0", "water, 0 m"],
    ["--water-20", "water, 20 m"],
    ["--water-60", "water, 60 m"],
    ["--water-120", "water, 120 m"],
    ["--water-180", "water, 180 m"],
    ["--bed", "the bed, 230 m"],
  ];
  const allowed = [];
  const add = (fg, bg, min, use, fgName, bgName) => allowed.push({ fg, bg, min, use, fgName, bgName });

  add("--land-ink", "--land", 4.5, "text on land", "land ink", "land");
  add("--land-ink-2", "--land", 4.5, "secondary text on land", "land ink 2", "land");
  add("--land-caution", "--land", 4.5, "caution text on land", "caution", "land");
  add("--land-ink", "--land-raised", 4.5, "text in a field on land", "land ink", "land, raised");
  add("--land-ink-2", "--land-raised", 4.5, "placeholder in a field on land", "land ink 2", "land, raised");
  add("--land-on-action", "--land-action", 4.5, "primary button on land", "on action", "action");
  add("--land-on-action", "--land-action-hover", 4.5, "primary button on land, hover", "on action", "action, hover");
  add("--land-rule-strong", "--land", 3, "edge of a control on land", "control rule", "land");
  add("--land-ink", "--land", 3, "focus ring on land", "focus", "land");
  add("--on-caution-band", "--caution-band", 4.5, "text on the caution band", "band text", "caution band");

  // The website's sky: land that is not flat, dark in both palettes and lettered as night in both. What stands
  // in it stands, at the lightest, on the haze over the water at night, and at dusk on the sky where it meets
  // the water (text) or on the water's own surface tint, which is the lightest the sky is behind a masthead.
  if (theme === "night") {
    add("--land-ink", "--pigment-midnight-haze", 4.5, "text on the sky at night", "land ink", "the sky at night, at the water");
    add("--land-ink-2", "--pigment-midnight-haze", 4.5, "secondary text on the sky at night", "land ink 2", "the sky at night, at the water");
    add("--land-caution", "--pigment-midnight-haze", 4.5, "caution text on the sky at night", "caution", "the sky at night, at the water");
    add("--land-rule-strong", "--pigment-midnight-haze", 3, "edge of a control on the sky at night", "control rule", "the sky at night, at the water");
    add("--land-ink", "--pigment-prussian-dusk", 4.5, "text on the sky at dusk", "land ink", "the sky at dusk, at the water");
    add("--land-ink-2", "--pigment-prussian-0", 4.5, "secondary text in a masthead at dusk", "land ink 2", "the sky at dusk, behind a masthead");
    add("--land-rule-strong", "--pigment-prussian-0", 3, "edge of a control in a masthead at dusk", "control rule", "the sky at dusk, behind a masthead");
  }

  for (const [bg, bgName] of water) {
    add("--paper", bg, 4.5, "text", "paper", bgName);
    add("--paper-2", bg, 4.5, "secondary text", "paper 2", bgName);
    add("--loch", bg, 4.5, "shielded data, water lettering", "loch", bgName);
    add("--buff", bg, 4.5, "public data", "buff", bgName);
    add("--water-caution", bg, 4.5, "caution text", "magenta", bgName);
    add("--water-rule-control", bg, 3, "edge of a control", "control rule", bgName);
    add("--pigment-buff", bg, 3, "focus ring, waterline", "buff", bgName);
  }

  // Text a component sets in a role, measured as that role resolves on each ground. Read from
  // components.css and base.css, so a rule changed back to a fainter ink fails here.
  const stages = [
    [".progress__stages", "a stage not yet reached, or done"],
    ['.progress__stages > [data-state="now"]', "the stage in progress"],
  ];
  for (const [selector, what] of stages) {
    const role = inkOf(selector);
    const landInk = inkOnGround("land", role);
    add(landInk, "--land", 4.5, `${what} (${selector})`, INK_NAMES[landInk] ?? landInk, "land");
    const waterInk = inkOnGround("water", role);
    for (const [bg, bgName] of water) add(waterInk, bg, 4.5, `${what} (${selector})`, INK_NAMES[waterInk] ?? waterInk, bgName);
  }
  // The placeholder of the amount field is set in the disabled ink, inside a field.
  for (const [bg, bgName] of water) allowed.push({ fg: "--paper-disabled", bg, under: "--water-sunk", min: 4.5, use: "placeholder in the amount field", fgName: "paper, faint", bgName: `a field in ${bgName}` });
  add("--land-ink-disabled", "--land-raised", 3, "placeholder in the amount field on land: large text only, 27.5px at comfortable density", "land ink, disabled", "land, raised");

  add("--pigment-ink", "--pigment-buff", 4.5, "primary button in water", "ink", "buff");
  add("--pigment-ink", "--pigment-buff-lit", 4.5, "primary button in water, hover", "ink", "buff, lit");
  add("--pigment-ink", "--pigment-buff-worn", 4.5, "primary button in water, pressed", "ink", "buff, worn");
  add("--buff", "--chart-water", 4.5, "soundings in a figure", "buff", "chart water");
  add("--loch", "--chart-water", 3, "bed line against chart water", "loch", "chart water");
  add("--water-caution", "--bed", 3, "hatching on the raised bed", "magenta", "the bed");

  const forbidden = [];
  const no = (fg, bg, why, fgName, bgName) => forbidden.push({ fg, bg, why, fgName, bgName });
  if (theme === "dusk") {
    no("--loch", "--land", "shielded data never stands on land", "loch", "land");
    no("--paper", "--land", "paper is for water", "paper", "land");
    no("--paper-2", "--land", "paper is for water", "paper 2", "land");
    no("--water-caution", "--land", "use the deep magenta on buff", "magenta", "land");
  } else {
    no("--pigment-magenta-deep", "--land", "use the light magenta on midnight", "deep magenta", "land");
    no("--pigment-ink", "--land", "ink is for buff", "ink", "land");
    no("--land-ink-2", "--pigment-prussian-dusk", "toward the horizon the sky at dusk is lettered in the full ink", "land ink 2", "the sky at dusk, at the water");
    no("--land-rule-strong", "--pigment-prussian-dusk", "no control stands on the sky at dusk below a masthead", "control rule", "the sky at dusk, at the water");
  }
  no("--pigment-ink", "--water-0", "ink is for buff", "ink", "water, 0 m");
  no("--pigment-magenta-deep", "--water-0", "use the light magenta in water", "deep magenta", "water, 0 m");
  no("--pigment-ink-soft", "--water-0", "land's secondary ink is for buff", "ink soft", "water, 0 m");
  no("--paper-disabled", "--water-0", "disabled text only: never for anything that must be read", "paper, faint", "water, 0 m");
  no("--water-rule-strong", "--water-0", "a rule, not the edge of a control", "strong rule", "water, 0 m");
  return { allowed, forbidden };
}

/** Measures every pairing of a palette. */
export function measure(theme) {
  const tokens = paletteTokens(theme);
  const { allowed, forbidden } = pairings(theme);
  const run = (p) => {
    // `under` is a translucent fill (a field) lying on the ground: the text is measured against the two together.
    const bg = p.under ? over(color(tokens, p.under), color(tokens, p.bg)) : color(tokens, p.bg);
    const fg = color(tokens, p.fg);
    return { ...p, ratio: contrast(fg, bg), fgHex: hex(fg.a < 1 ? over(fg, bg) : fg), bgHex: hex(bg) };
  };
  return { theme, tokens, allowed: allowed.map(run), forbidden: forbidden.map(run) };
}
