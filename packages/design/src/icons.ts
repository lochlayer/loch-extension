/**
 * @loch/design/icons: the icon set as strings, for places where an external
 * sprite file is awkward (file:// pages, content scripts, server rendering).
 *
 *   icon("dive")                         -> '<svg class="icon" …>…</svg>'
 *   icon("copy", { label: "Copy" })      -> the same, announced as "Copy"
 *   SPRITE                               -> the whole sprite, to inline once per document. It is
 *                                           '<svg class="sprite" width="0" height="0" …>': `.sprite`
 *                                           in components.css takes it out of the flow. No `style`
 *                                           attribute, so a strict Content-Security-Policy lets it in.
 *   use("dive")                          -> '<svg class="icon"><use href="#i-dive"/></svg>'
 */
import { ICON_BODIES, SPRITE } from "./icons.generated.js";

export { SPRITE };

export type IconName = keyof typeof ICON_BODIES;

export const ICON_NAMES = Object.keys(ICON_BODIES) as IconName[];

export type IconOptions = {
  /** Accessible name. Without one the icon is decorative and hidden from assistive technology. */
  label?: string;
  /** Extra class names, e.g. "icon--sm". */
  className?: string;
};

const escapeAttr = (value: string): string =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The drawing of an icon in the set; nothing for a name that is not one (and never anything read from a prototype). */
function body(name: string): string {
  return Object.prototype.hasOwnProperty.call(ICON_BODIES, name) ? ICON_BODIES[name as IconName] : "";
}

function open(options: IconOptions): string {
  const cls = ["icon", options.className].filter(Boolean).join(" ");
  const a11y = options.label ? `role="img" aria-label="${escapeAttr(options.label)}"` : `aria-hidden="true" focusable="false"`;
  return `<svg class="${escapeAttr(cls)}" viewBox="0 0 20 20" ${a11y}`;
}

/** A complete, self-contained inline SVG. It carries no `style` attribute: `.icon` in components.css sizes and inks it. */
export function icon(name: IconName, options: IconOptions = {}): string {
  return `${open(options)} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body(name)}</svg>`;
}

/** A reference into the sprite. `href` defaults to the inlined sprite; pass the sprite's URL to use the external file. */
export function use(name: IconName, options: IconOptions & { href?: string } = {}): string {
  return `${open(options)}><use href="${escapeAttr(options.href ?? "")}#i-${escapeAttr(name)}"/></svg>`;
}
