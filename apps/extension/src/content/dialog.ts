// The in-page dialog: the wrapper's two protections, shown on top of the site that asked.
//
// It lives in a closed shadow root on an element this script adds to the page. The page can see
// that an element exists; it cannot read the dialog, style it or press its buttons through the
// DOM. It can remove the element: then the question is never answered and the request the
// dialog was about is never passed on. The stylesheet is the design system's own, rewritten for a shadow root by the build
// (dist/dialog.css); the fonts arrive as bytes and are registered under names of their own, so
// nothing is fetched from the page's context and the page's CSP is not involved.

import type { ReviewReply } from "../shared/messages.js";

export interface DialogAssets {
  css: string;
  fonts: { normal: string; italic: string };
}

const FONT_FAMILY = "Loch Dialog Sans";
let fontsReady: Promise<void> | null = null;

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function loadFonts(assets: DialogAssets): Promise<void> {
  fontsReady ??= (async () => {
    try {
      const faces = [
        new FontFace(FONT_FAMILY, fromBase64(assets.fonts.normal), { style: "normal", weight: "100 900" }),
        new FontFace(FONT_FAMILY, fromBase64(assets.fonts.italic), { style: "italic", weight: "100 900" }),
      ];
      for (const face of faces) {
        await face.load();
        document.fonts.add(face);
      }
    } catch {
      // The dialog falls back to the system sans. It still says what it has to say.
    }
  })();
  return fontsReady;
}

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function cautionIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M10 3.25L17.5 16.5h-15z", "M10 8.5v3.75", "M10 14.4v.1"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

interface OpenDialog {
  labelledBy: string;
  title: string;
  body: Node[];
  /** Buttons, in order. The first with `initial` gets the focus. */
  buttons: { label: string; kind: "primary" | "secondary"; value: boolean; initial?: boolean }[];
  /** What Escape and a click outside mean. */
  dismiss: boolean;
}

/** Shows a modal dialog and resolves with the value of the button that closed it. */
async function open(assets: DialogAssets, spec: OpenDialog): Promise<boolean> {
  await loadFonts(assets);
  const host = document.createElement("loch-dialog");
  // Styled through the CSSOM, and the stylesheet adopted as an object: no style attribute and no
  // <style> element, so a page whose Content-Security-Policy forbids inline styles reports
  // nothing and the dialog looks the same there.
  host.style.setProperty("all", "initial");
  host.style.setProperty("position", "fixed");
  host.style.setProperty("inset", "0");
  host.style.setProperty("z-index", "2147483647");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(assets.css);
  root.adoptedStyleSheets = [sheet];

  return new Promise<boolean>((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const close = (value: boolean) => {
      host.remove();
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const buttons = spec.buttons.map((button) => {
      const node = el("button", { class: `btn btn--${button.kind}`, type: "button" }, button.label);
      node.addEventListener("click", () => close(button.value));
      return node;
    });
    const dialog = el(
      "section",
      { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": spec.labelledBy, tabindex: "-1" },
      el("p", { class: "caution-band" }, el("strong", {}, "Loch."), " Devnet alpha, unaudited."),
      el("header", { class: "sheet__head" }, el("h2", { class: "sheet__title", id: spec.labelledBy }, spec.title)),
      el("div", { class: "sheet__body stack" }, ...spec.body),
      el("footer", { class: "sheet__foot" }, ...buttons),
    );
    const scrim = el("div", { class: "scrim" });
    scrim.addEventListener("click", () => close(spec.dismiss));
    const frame = el("div", { class: "loch-frame water", "data-theme": "dusk", "data-density": "compact", "data-depth": "bed" }, scrim, dialog);

    const focusable = () => buttons.filter((button) => !button.disabled);
    const onKey = (event: KeyboardEvent) => {
      if (!host.isConnected) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(spec.dismiss);
      } else if (event.key === "Tab") {
        // Keep the focus inside the dialog.
        const items = focusable();
        const index = items.indexOf(root.activeElement as HTMLButtonElement);
        const next = items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length];
        event.preventDefault();
        event.stopPropagation();
        next?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    root.append(frame);
    (document.body ?? document.documentElement).append(host);
    const initial = buttons[spec.buttons.findIndex((button) => button.initial)] ?? buttons[0];
    initial?.focus();
  });
}

/**
 * The site asked the Loch wallet for the key-derivation signature. Loch did not pass it on; say
 * why, and say what Loch cannot do: a site can ask the real wallet without going through Loch.
 */
export function showBlockedDialog(assets: DialogAssets): Promise<boolean> {
  const body = [
    el(
      "div",
      { class: "failure", role: "alert" },
      el("p", { class: "failure__title" }, cautionIcon(), "This site asked for the key to your shielded balance"),
      el("p", {}, "Through the Loch wallet, it asked your wallet to sign the message “Loch key derivation v1”. Whoever has that signature can read and spend your shielded balance, for good."),
      el("p", {}, "Loch did not pass the request on, so nothing was signed and nothing moved."),
      el("p", {}, "Loch cannot stop a site from asking your wallet directly. If your wallet itself shows this message on a website, decline it there: Loch asks for it only on its own connect page, after you press Connect or Unlock in the Loch extension."),
    ),
  ];
  return open(assets, {
    labelledBy: "loch-blocked-title",
    title: "Loch did not pass on a signature request",
    body,
    buttons: [{ label: "Close", kind: "primary", value: false, initial: true }],
    dismiss: false,
  });
}

/** A public transfer that gives something away. Resolves true for "Send anyway", false for "Cancel". */
export function showWarningDialog(assets: DialogAssets, review: Extract<ReviewReply, { action: "warn" }>): Promise<boolean> {
  const rows = review.transfers.map((transfer) =>
    el(
      "div",
      { class: "deflist__row" },
      el("dt", {}, "To"),
      el("dd", {}, el("span", { class: "fig is-public", title: transfer.to }, short(transfer.to)), el("span", { class: "loch-amount fig is-public" }, transfer.amount)),
    ),
  );
  const warnings = review.warnings.map((warning) =>
    el(
      "li",
      { class: "statement__row" },
      el("span", { class: "sev", "data-sev": warning.severity }, warning.severity === "high" ? "High" : warning.severity === "medium" ? "Medium" : "Low"),
      el("span", { class: "statement__what" }, el("strong", {}, warning.title), el("span", {}, warning.detail)),
    ),
  );
  const body = [
    el("p", { class: "t-small" }, "This site asked your wallet to send a public transfer. Anyone can see the sender, the recipient and the amount, and this is what it would add to what your wallet’s history already gives away."),
    el("dl", { class: "deflist deflist--kv" }, ...rows),
    el("ol", { class: "statement" }, ...warnings),
    el(
      "p",
      { class: "observer" },
      el("span", { class: "observer__label" }, "Loch does not change the transaction"),
      " If you go on, your wallet is given a copy of exactly what the site sent, and asks you as usual. Loch sees only what a site sends through the Loch wallet: a site can also ask your wallet directly.",
    ),
  ];
  return open(assets, {
    labelledBy: "loch-warning-title",
    title: "Before you send this publicly",
    body,
    buttons: [
      { label: "Send anyway", kind: "secondary", value: true },
      { label: "Cancel", kind: "primary", value: false, initial: true },
    ],
    dismiss: false,
  });
}

function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
