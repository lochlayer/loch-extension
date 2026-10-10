#!/usr/bin/env python3
"""
Builds "Loch Tabular": the ten digits of Libre Franklin, re-spaced to one
advance width so that figures line up in columns.

Why this exists: the Libre Franklin distributed by Google Fonts / @fontsource
has no `tnum` feature, so `font-variant-numeric: tabular-nums` does nothing.
Loch is a product about balances and amounts. This script takes the upstream
variable fonts, cuts static instances at the three weights the system uses,
keeps only 0-9, centres each digit on a common advance, and writes six small
woff2 files into ../fonts. fonts.css exposes them with `unicode-range: U+30-39`,
so every other character still comes from Libre Franklin itself.

Run by hand when the upstream font changes (the output is committed):

    pnpm --filter @loch/design run fonts:tabular     # needs python3 + fonttools + brotli

Licence: Libre Franklin is under the SIL Open Font License 1.1 with no
Reserved Font Name. The derivative is renamed and ships under the same licence
(fonts/OFL-libre-franklin.txt).
"""
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
SRC = PKG / "node_modules" / "@fontsource-variable" / "libre-franklin" / "files"
OUT = PKG / "fonts"

WEIGHTS = (400, 500, 600)
STYLES = {"normal": "libre-franklin-latin-wght-normal.woff2", "italic": "libre-franklin-latin-wght-italic.woff2"}
DIGITS = [chr(c) for c in range(0x30, 0x3A)]
FAMILY = "Loch Tabular"


MIN_SIDE = 22  # units of clear space kept either side of the widest digit


def tabular_width(weight):
    """
    One advance for all ten digits at this weight: the widest digit's ink plus
    MIN_SIDE on each side, rounded to 10 units. Measured on the roman and used
    for the italic too, so an upright row and an italic row share a column.
    Wider than this and "1" floats; narrower and two zeros touch.
    """
    font = TTFont(SRC / STYLES["normal"])
    font = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False)
    cmap = font.getBestCmap()
    glyf = font["glyf"]
    ink = max(glyf[cmap[ord(d)]].xMax - glyf[cmap[ord(d)]].xMin for d in DIGITS)
    return int(round((ink + 2 * MIN_SIDE) / 10.0)) * 10


def build(style, weight):
    font = TTFont(SRC / STYLES[style])
    font = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=False)

    options = subset.Options()
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.notdef_outline = True
    options.glyph_names = False
    options.hinting = False
    sub = subset.Subsetter(options)
    sub.populate(unicodes=[ord(d) for d in DIGITS])
    sub.subset(font)

    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    glyf = font["glyf"]
    target = tabular_width(weight)
    for d in DIGITS:
        name = cmap[ord(d)]
        advance, lsb = hmtx[name]
        glyph = glyf[name]
        # Centre the old advance, not the ink: that keeps the designer's side bearings in
        # proportion, which is what keeps a slanted or lopsided digit looking centred.
        shift = int(round((target - advance) / 2.0))
        if glyph.numberOfContours > 0:
            coords = glyph.coordinates
            coords.translate((shift, 0))
            glyph.coordinates = coords
            glyph.recalcBounds(glyf)
        hmtx[name] = (target, lsb + shift)

    sub_family = {"normal": "Regular", "italic": "Italic"}[style]
    ps = f"LochTabular-{weight}{'Italic' if style == 'italic' else ''}"
    for record in font["name"].names:
        if record.nameID == 1:
            record.string = FAMILY
        elif record.nameID == 2:
            record.string = sub_family
        elif record.nameID == 3:
            record.string = f"{FAMILY} {weight} {sub_family}; derived from Libre Franklin"
        elif record.nameID == 4:
            record.string = f"{FAMILY} {weight} {sub_family}"
        elif record.nameID == 6:
            record.string = ps
    font["OS/2"].usWeightClass = weight
    font["hhea"].advanceWidthMax = max(w for w, _ in hmtx.metrics.values())

    OUT.mkdir(exist_ok=True)
    out = OUT / f"loch-tabular-{weight}-{style}.woff2"
    font.flavor = "woff2"
    font.save(out)
    return out, target


def main():
    if not SRC.exists():
        sys.exit(f"missing {SRC}: run pnpm install first")
    for style in STYLES:
        for weight in WEIGHTS:
            out, target = build(style, weight)
            print(f"{out.name}: digits on {target} units, {out.stat().st_size} bytes")


if __name__ == "__main__":
    main()
