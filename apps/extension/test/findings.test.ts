// Things found in other packages while building the extension, each shown by a minimal test of
// the package as it is, next to the way the extension works around it. They are reported to
// the packages' owners; when one is fixed there, its test here says so by failing, and is then
// replaced by a test of the fixed behaviour the extension now relies on.
//
// Both findings that stood here were fixed in @loch/design, and the workarounds are gone:
//
//   - soundingHtml drew a non-zero amount below 0.001 as "0" ".000". It now draws "<" "0" ".001",
//     and the extension's Sounding (src/ui/parts.tsx) writes the same three parts.
//   - base.css set the body font only inside a cascade layer, which the stylesheet Chrome adds to
//     extension pages overrides. It now says it once more outside the layers, and app.css no
//     longer restates it. (e2e/extension.spec.ts checks the font the real popup ends up with.)

import { readFileSync } from "node:fs";

import { formatSol, groupAddress, shortAddress, soundingHtml } from "@loch/design/numerals";
import { describe, expect, it } from "vitest";

import { shortAddress as copyShortAddress } from "../src/shared/copy.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("@loch/design, as the extension relies on it", () => {
  it("a non-zero amount below the display precision is drawn as < 0 .001, and the extension draws the same three parts", () => {
    const html = soundingHtml(formatSol(5_000n));
    expect(html).toContain('aria-label="&lt;0.001"');
    expect(html).toContain('<span class="sounding__less" aria-hidden="true">&lt;</span><span aria-hidden="true">0</span><span class="sounding__frac" aria-hidden="true">.001</span>');
    const parts = read("../src/ui/parts.tsx");
    expect(parts).toContain('class="sounding__less"');
    expect(parts).not.toContain('"<0"');
  });

  it("the body font is held by the package outside its layers, and app.css does not restate it", () => {
    const base = read("../../../packages/design/base.css");
    const layered = base.indexOf("@layer loch.base");
    expect(layered).toBeGreaterThan(-1);
    // The unlayered rule, after the layers: what beats Chrome's own sheet for extension pages.
    expect(base).toMatch(/\n\}\n[\s\S]*\nbody \{\n  font-family: var\(--font-sans\);\n  font-size: var\(--text-body\);\n\}/);
    const app = read("../src/ui/app.css");
    const body = /\nbody \{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(body).not.toMatch(/font-family|font-size|line-height/);
    expect(app).not.toContain("@layer");
  });

  it("the local components that moved into the package are gone from app.css", () => {
    const app = read("../src/ui/app.css");
    for (const selector of [".balance__row", ".quiet-link", ".sync", ".unsurveyed", ".choose", ".reasons"]) {
      expect(app, selector).not.toMatch(new RegExp(`(^|\\n)\\${selector}[ ,.:_\\[{-]`));
    }
    const components = read("../../../packages/design/components.css");
    for (const selector of [".balance__row", ".link--quiet", ".link--caution", ".is-unsurveyed", ".picklist__row", ".reasons"]) {
      expect(components, selector).toContain(`${selector} `);
    }
  });

  it("addresses are shortened and grouped by the package: a shielded address keeps loch1 whole", () => {
    const shielded = "loch1q87ep4a7lwncng5nw8hhst92u0nu49c3u6d5evle76kee3wzph57mljdndnkyt92jgjudplsxjf80nszkrh3ng58cdcrm64pmxzgvcg5p36df";
    expect(copyShortAddress(shielded)).toBe(shortAddress(shielded));
    expect(copyShortAddress(shielded)).toBe("loch1q87e…36df");
    expect(copyShortAddress("9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj")).toBe("9C6h…Jtpj");
    expect(groupAddress(shielded).startsWith("loch1 q87e p4a7 ")).toBe(true);
  });

  it("the extension pages allow no inline style: neither as an attribute nor as an element", () => {
    const manifest = read("../scripts/manifest.mjs");
    expect(manifest).toContain(`"style-src 'self'"`);
    expect(manifest).not.toContain("unsafe-inline");
    expect(manifest).not.toContain("style-src-attr");
    // What the interface itself writes: no style attribute as a string anywhere.
    for (const file of ["../src/ui/App.tsx", "../src/ui/flows.tsx", "../src/ui/views.tsx", "../src/ui/parts.tsx", "../src/content/dialog.ts"]) {
      expect(read(file), file).not.toMatch(/style="|setAttribute\("style"/);
    }
  });
});
