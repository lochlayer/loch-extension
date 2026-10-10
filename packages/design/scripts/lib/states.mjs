// Builds a stylesheet that pins interactive states so a static page can show
// them: every rule in the package that depends on :hover, :active,
// :focus-visible or :focus-within is copied with the pseudo-class swapped for
// a class (.is-hover, .is-active, .is-focus, .is-focus-within). Generated from
// the shipped CSS, so the style guide cannot drift from it.

const PSEUDO = /:(hover|active|focus-visible|focus-within)\b/;
const SWAP = [
  [/:hover\b/g, ".is-hover"],
  [/:active\b/g, ".is-active"],
  [/:focus-visible\b/g, ".is-focus"],
  [/:focus-within\b/g, ".is-focus-within"],
];

function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of prelude) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function forceStates(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;

  function skipBlock() {
    let depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
  }

  function parseBlock() {
    let out = "";
    while (i < css.length) {
      const start = i;
      while (i < css.length && css[i] !== "{" && css[i] !== "}" && css[i] !== ";") i++;
      if (i >= css.length) break;
      if (css[i] === "}") {
        i++;
        return out;
      }
      if (css[i] === ";") {
        i++;
        continue;
      }
      const prelude = css.slice(start, i).trim().replace(/\s+/g, " ");
      i++;
      if (prelude.startsWith("@")) {
        if (/^@(keyframes|font-face)/.test(prelude)) {
          skipBlock();
          continue;
        }
        const inner = parseBlock();
        if (inner.trim()) out += `${prelude} {\n${inner}}\n`;
      } else {
        const bodyStart = i;
        skipBlock();
        const body = css.slice(bodyStart, i - 1).trim().replace(/\s+/g, " ");
        const selectors = splitSelectors(prelude).filter((s) => PSEUDO.test(s));
        if (selectors.length > 0) {
          const swapped = selectors.map((s) => SWAP.reduce((acc, [re, cls]) => acc.replace(re, cls), s));
          out += `${swapped.join(", ")} { ${body} }\n`;
        }
      }
    }
    return out;
  }

  return parseBlock();
}
