import { describe, expect, it } from "vitest";
import { MINUS, THIN_SPACE, amountHtml, formatSol, groupAddress, parseSol, shortAddress, soundingHtml, toLamports } from "../src/numerals.js";

describe("formatSol", () => {
  it("writes three decimals, always all three", () => {
    expect(formatSol(12_480_739_112n).text).toBe("12.480");
    expect(formatSol(41_207_000_000n).text).toBe("41.207");
    expect(formatSol(1_250_000_000n).text).toBe("1.250");
    expect(formatSol(0n).text).toBe("0.000");
  });

  it("truncates toward zero and never rounds up", () => {
    const parts = formatSol(999_999_999n);
    expect(parts.text).toBe("0.999");
    expect(parts.truncated).toBe(true);
    expect(formatSol(1_999_999_999n).text).toBe("1.999");
    expect(formatSol(-1_999_999_999n).text).toBe(`${MINUS}1.999`);
    expect(formatSol(1_250_000_000n).truncated).toBe(false);
  });

  it("never shows a non-zero amount as zero", () => {
    const fee = formatSol(5000n);
    expect(fee.negligible).toBe(true);
    expect(fee.text).toBe("<0.001");
    expect(formatSol(-5000n, { sign: "always" }).text).toBe(`${MINUS}<0.001`);
    expect(formatSol(0n).negligible).toBe(false);
  });

  it("is exact on request: at least three decimals, up to nine, trailing zeros dropped", () => {
    expect(formatSol(5000n, { exact: true }).text).toBe("0.000005");
    expect(formatSol(12_480_739_112n, { exact: true }).text).toBe("12.480739112");
    expect(formatSol(1_250_000_000n, { exact: true }).text).toBe("1.250");
    expect(formatSol(1_250_100_000n, { exact: true }).text).toBe("1.2501");
    expect(formatSol(1n, { exact: true }).text).toBe("0.000000001");
    expect(formatSol(12_480_739_112n, { exact: true }).truncated).toBe(false);
  });

  it("signs changes with a plus or a true minus, never a hyphen", () => {
    expect(formatSol(5_000_000_000n, { sign: "always" }).sign).toBe("+");
    expect(formatSol(-1_250_000_000n, { sign: "always" }).sign).toBe("−");
    expect(formatSol(-1_250_000_000n).text).toBe("−1.250");
    expect(formatSol(-1_250_000_000n, { sign: "never" }).text).toBe("1.250");
    expect(formatSol(0n, { sign: "always" }).sign).toBe("");
    expect(formatSol(5_000_000_000n).sign).toBe("");
  });

  it("groups thousands with a thin space from 10 000 up, and uses a point for decimals", () => {
    expect(formatSol(9_999_000_000_000n).int).toBe("9999");
    expect(formatSol(104_219_500_000_000n).text).toBe(`104${THIN_SPACE}219.500`);
    expect(formatSol(1_234_567_000_000_000n).int).toBe(`1${THIN_SPACE}234${THIN_SPACE}567`);
    expect(formatSol(104_219_500_000_000n).text).not.toContain(",");
  });

  it("splits into the parts the type system sets differently", () => {
    expect(formatSol(12_480_739_112n)).toMatchObject({ sign: "", int: "12", frac: ".480" });
    expect(formatSol(12_480_739_112n, { decimals: 0 })).toMatchObject({ int: "12", frac: "", text: "12" });
  });

  it("accepts whole-number lamports as a number and refuses anything else", () => {
    expect(formatSol(1_250_000_000).text).toBe("1.250");
    expect(() => formatSol(1.5)).toThrow(RangeError);
    expect(() => formatSol(Number.NaN)).toThrow(RangeError);
  });
});

describe("parseSol", () => {
  it("parses what a person types, exactly", () => {
    expect(parseSol("1.25")).toBe(1_250_000_000n);
    expect(parseSol("0.000000001")).toBe(1n);
    expect(parseSol(".5")).toBe(500_000_000n);
    expect(parseSol("12")).toBe(12_000_000_000n);
    expect(parseSol("12.")).toBe(12_000_000_000n);
    expect(parseSol(`104${THIN_SPACE}219.5`)).toBe(104_219_500_000_000n);
    expect(parseSol("0.1")! + parseSol("0.2")!).toBe(parseSol("0.3"));
  });

  it("never guesses", () => {
    for (const bad of ["", ".", "1,25", "1.0000000001", "-1", "+1", "1e9", "abc", "1.2.3", "0x10"]) {
      expect(parseSol(bad), bad).toBeNull();
    }
  });

  it("round-trips through formatSol", () => {
    for (const lamports of [0n, 1n, 5000n, 999_999_999n, 12_480_739_112n, 104_219_500_000_000n]) {
      expect(parseSol(formatSol(lamports, { exact: true }).text)).toBe(lamports);
    }
  });
});

describe("toLamports", () => {
  it("converts the scanner's floating-point SOL to the nearest lamport", () => {
    expect(toLamports(1.25)).toBe(1_250_000_000n);
    expect(toLamports(0.1 + 0.2)).toBe(300_000_000n);
    expect(() => toLamports(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("addresses", () => {
  const address = "Fh3qJ5iBgbd24itfu7gbvo8XVHLjnNhA6aNEPnnNTz8K";
  // bech32m, prefix "loch", separator "1": 114 characters.
  const shielded = "loch1q87ep4a7lwncng5nw8hhst92u0nu49c3u6d5evle76kee3wzph57mljdndnkyt92jgjudplsxjf80nszkrh3ng58cdcrm64pmxzgvcg5p36df";

  it("shortens to four and four, as the scanner does", () => {
    expect(shortAddress(address)).toBe("Fh3q…Tz8K");
    expect(shortAddress("short")).toBe("short");
  });
  it("groups in fours for checking by eye", () => {
    expect(groupAddress(address)).toBe("Fh3q J5iB gbd2 4itf u7gb vo8X VHLj nNhA 6aNE PnnN Tz8K");
    expect(groupAddress(address).replace(/ /g, "")).toBe(address);
  });

  it("keeps the prefix of a shielded address together and groups what follows", () => {
    expect(shielded).toHaveLength(114);
    const grouped = groupAddress(shielded);
    expect(grouped.startsWith("loch1 q87e p4a7 lwnc ng5n ")).toBe(true);
    expect(grouped).not.toMatch(/^loch 1/);
    const groups = grouped.split(" ");
    expect(groups[0]).toBe("loch1");
    // 109 characters after the prefix: 27 groups of four and one left over.
    expect(groups).toHaveLength(29);
    expect(groups.slice(1, -1).every((g) => g.length === 4)).toBe(true);
    expect(groups[groups.length - 1]).toBe("f");
    expect(grouped.replace(/ /g, "")).toBe(shielded);
    // bech32 may be written all in capitals. Never mixed.
    expect(groupAddress(shielded.toUpperCase()).startsWith("LOCH1 Q87E P4A7 ")).toBe(true);
    expect(groupAddress("loch1")).toBe("loch1");
    expect(groupAddress("loch1q")).toBe("loch1 q");
    expect(groupAddress("loch1q87ep")).toBe("loch1 q87e p");
  });

  it("leaves every other address as it was", () => {
    // A public address can begin "Loch1" (base58 has L, o, c, h and 1) and is still grouped in fours.
    expect(groupAddress("Loch1Abcd")).toBe("Loch 1Abc d");
    expect(groupAddress("lochness")).toBe("loch ness");
    expect(groupAddress("")).toBe("");
    expect(groupAddress("abc")).toBe("abc");
    expect(groupAddress("abcd")).toBe("abcd");
    expect(groupAddress("abcde")).toBe("abcd e");
  });

  it("shortens a shielded address to its prefix, four characters and the last four", () => {
    expect(shortAddress(shielded)).toBe("loch1q87e…36df");
    expect(shortAddress("loch1q87ep4a7x")).toBe("loch1q87ep4a7x");
    expect(shortAddress("Loch1AbcdEfghJkmn")).toBe("Loch…Jkmn");
  });

  it("keeps the prefix of a payment code whole as well", () => {
    const code = "lochpay1q87ep4a7lwncng5nw8hhst92u0nu49c3u6d5evle76kee3wzph57mljdndnkyt92jgjudplsxjf80nszkrh3ng58cdcrm64pmxzgvcfd323ddheptfsehytkcj36ce325yep3gvlm84p03r88jm6rafud5ws8y5m";
    expect(groupAddress(code).startsWith("lochpay1 q87e p4a7 ")).toBe(true);
    expect(groupAddress(code.toUpperCase()).startsWith("LOCHPAY1 Q87E ")).toBe(true);
    expect(groupAddress(code).replace(/ /g, "")).toBe(code);
    expect(shortAddress(code)).toBe("lochpay1q87e…8y5m");
    // Not a payment code: "lochpay" without the separator is grouped like any other text.
    expect(groupAddress("lochpayq")).toBe("loch payq");
  });
});

describe("markup", () => {
  it("sets a public amount upright and a shielded one italic, by class", () => {
    const pub = amountHtml(formatSol(5_000_000_000n, { sign: "always" }));
    expect(pub).toBe('<span class="fig is-public"><span class="fig-sign">+</span>5.000</span>');
    const shielded = amountHtml(formatSol(-1_250_000_000n, { sign: "always" }), { shielded: true, unit: "SOL" });
    expect(shielded).toContain('class="fig is-shielded"');
    expect(shielded).toContain(`<span class="fig-sign">${MINUS}</span>1.250`);
    expect(shielded).toContain(' <span class="fig-unit">SOL</span>');
  });

  it("puts the exact amount in the title when digits were dropped", () => {
    const lamports = 12_480_739_112n;
    const html = amountHtml(formatSol(lamports), {}, formatSol(lamports, { exact: true }).text);
    expect(html).toContain('title="12.480739112"');
    expect(amountHtml(formatSol(1_250_000_000n), {}, "1.250")).not.toContain("title=");
  });

  it("writes a negligible amount as less-than, escaped", () => {
    expect(amountHtml(formatSol(5000n))).toContain("&lt;0.001");
  });

  it("escapes the unit", () => {
    expect(amountHtml(formatSol(1n), { unit: "<b>" })).toContain("&lt;b&gt;");
  });

  it("writes the shielded balance as a sounding with an accessible name", () => {
    const html = soundingHtml(formatSol(12_480_739_112n));
    expect(html).toContain('aria-label="12.480"');
    expect(html).toContain('<span aria-hidden="true">12</span><span class="sounding__frac" aria-hidden="true">.480</span>');
  });

  it("follows the unit with a no-break space", () => {
    expect(amountHtml(formatSol(1_250_000_000n), { unit: "SOL" })).toBe(`<span class="fig is-public">1.250</span>${String.fromCharCode(0xa0)}<span class="fig-unit">SOL</span>`);
  });

  it("escapes every part it is given, even parts no formatter would make", () => {
    const parts = { sign: "<" as never, int: '"><i>', frac: "<b>", text: "x", truncated: true, negligible: false };
    const amount = amountHtml(parts, { className: '"><u>', unit: "<s>" }, '"<em>');
    expect(amount).not.toMatch(/<(i|b|u|s|em)>/);
    expect(amount).toContain('class="fig is-public &quot;&gt;&lt;u&gt;"');
    expect(amount).toContain('title="&quot;&lt;em&gt;"');
    const sounding = soundingHtml(parts);
    expect(sounding).not.toMatch(/<(i|b)>/);
    expect(sounding).toContain("&quot;&gt;&lt;i&gt;");
  });
});

describe("a sounding is never drawn as zero when it is not zero", () => {
  /** What a reader sees: the whole number and the fraction, as drawn. */
  const drawn = (html: string) => {
    const match = /^<span class="sounding" aria-label="[^"]*">(?:<span class="sounding__less" aria-hidden="true">([^<]*)<\/span>)?<span aria-hidden="true">([^<]*)<\/span><span class="sounding__frac" aria-hidden="true">([^<]*)<\/span><\/span>$/.exec(html)!;
    return `${match[1] ?? ""}${match[2]}|${match[3]}`.replace(/&lt;/g, "<");
  };
  const spoken = (html: string) => /aria-label="([^"]*)"/.exec(html)![1]!.replace(/&lt;/g, "<");

  it("draws nothing as 0.000 and the smallest shown amount as 0.001", () => {
    expect(soundingHtml(formatSol(0n))).toBe('<span class="sounding" aria-label="0.000"><span aria-hidden="true">0</span><span class="sounding__frac" aria-hidden="true">.000</span></span>');
    expect(drawn(soundingHtml(formatSol(0n)))).toBe("0|.000");
    expect(spoken(soundingHtml(formatSol(0n)))).toBe("0.000");
    expect(drawn(soundingHtml(formatSol(1_000_000n)))).toBe("0|.001");
    expect(spoken(soundingHtml(formatSol(1_000_000n)))).toBe("0.001");
    expect(drawn(soundingHtml(formatSol(1_999_999n)))).toBe("0|.001");
  });

  it("draws anything between as less than 0.001, the same as it is announced", () => {
    for (const lamports of [1n, 5_000n, 999_999n]) {
      const html = soundingHtml(formatSol(lamports));
      expect(drawn(html), String(lamports)).toBe("<0|.001");
      expect(spoken(html), String(lamports)).toBe("<0.001");
      // The sign is a part of its own, so the large figure is the whole number and not "<0".
      expect(html).toBe('<span class="sounding" aria-label="&lt;0.001"><span class="sounding__less" aria-hidden="true">&lt;</span><span aria-hidden="true">0</span><span class="sounding__frac" aria-hidden="true">.001</span></span>');
      expect(html).not.toContain(">.000<");
    }
  });

  it("says the same thing to the eye and to the ear at every boundary", () => {
    for (const lamports of [0n, 1n, 5_000n, 999_999n, 1_000_000n, 1_000_001n, 999_999_999n, 1_000_000_000n, 12_480_739_112n, 104_219_500_000_000n]) {
      const html = soundingHtml(formatSol(lamports));
      expect(drawn(html).replace("|", ""), String(lamports)).toBe(spoken(html));
    }
  });

  it("splits at the point at other precisions too", () => {
    expect(drawn(soundingHtml(formatSol(5_000n, { decimals: 2 })))).toBe("<0|.01");
    expect(drawn(soundingHtml(formatSol(5_000n, { decimals: 0 })))).toBe("<1|");
    expect(drawn(soundingHtml(formatSol(5_000n, { exact: true })))).toBe("0|.000005");
  });
});

describe("formatSol with an option that is not a number", () => {
  it("falls back to three decimals", () => {
    expect(formatSol(12_480_739_112n, { decimals: Number.NaN }).text).toBe("12.480");
    expect(formatSol(12_480_739_112n, { decimals: Number.POSITIVE_INFINITY }).text).toBe("12.480");
    expect(formatSol(12_480_739_112n, { decimals: 99 }).text).toBe("12.480739112");
    expect(formatSol(12_480_739_112n, { decimals: -3 }).text).toBe("12");
  });
});
