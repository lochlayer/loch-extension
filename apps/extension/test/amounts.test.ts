import { describe, expect, it } from "vitest";

import { amountProblemText, displaySol, exactSol, fromLamportString, inputSol, parseAmountInput } from "../src/shared/amounts.js";

const SOL = 1_000_000_000n;

describe("amounts as the interface writes them", () => {
  it("cuts toward zero at three decimals and never rounds a balance up", () => {
    expect(displaySol(12_480_739_112n)).toBe("12.480");
    expect(displaySol(12_480_999_999n)).toBe("12.480");
    expect(displaySol(1_999_999_999n)).toBe("1.999");
    expect(displaySol(999_999n)).toBe("<0.001");
    expect(displaySol(0n)).toBe("0.000");
  });

  it("writes all three decimals, and never more precision than exists", () => {
    expect(displaySol(5n * SOL)).toBe("5.000");
    expect(displaySol(41_207_000_000n)).toBe("41.207");
    expect(exactSol(5n * SOL)).toBe("5.000");
  });

  it("writes fees and anything about to be signed exactly", () => {
    expect(exactSol(5_000n)).toBe("0.000005");
    expect(exactSol(2_500_000n)).toBe("0.0025");
    expect(exactSol(1_250_000_001n)).toBe("1.250000001");
    expect(exactSol(890_880n)).toBe("0.00089088");
  });

  it("groups thousands with a thin space from 10 000 up, never a comma", () => {
    expect(displaySol(10_000n * SOL)).toBe("10 000.000");
    expect(displaySol(9_999n * SOL)).toBe("9999.000");
    expect(displaySol(1_234_567n * SOL)).not.toContain(",");
  });

  it("signs a change with a plus or a true minus", () => {
    expect(displaySol(5n * SOL, "always")).toBe("+5.000");
    expect(displaySol(-1_250_000_000n, "always")).toBe("−1.250");
  });

  it("puts an exact amount back into a field", () => {
    expect(inputSol(1_250_000_000n)).toBe("1.25");
    expect(inputSol(5n * SOL)).toBe("5");
    expect(inputSol(1n)).toBe("0.000000001");
    expect(parseAmountInput(inputSol(12_480_739_112n))).toEqual({ ok: true, lamports: 12_480_739_112n });
  });
});

describe("amounts as a person types them", () => {
  it("reads digits and one point, up to nine decimals", () => {
    expect(parseAmountInput("1.25")).toEqual({ ok: true, lamports: 1_250_000_000n });
    expect(parseAmountInput("0.000000001")).toEqual({ ok: true, lamports: 1n });
    expect(parseAmountInput(" 5 ")).toEqual({ ok: true, lamports: 5n * SOL });
    expect(parseAmountInput(".5")).toMatchObject({ ok: expect.any(Boolean) });
  });

  it("never guesses", () => {
    for (const text of ["1,25", "1e3", "-1", "+1", "1.2.3", "abc", "1.0000000001", "0x10", "١٢"]) {
      expect(parseAmountInput(text), text).toEqual({ ok: false, problem: "format" });
    }
  });

  it("says what is wrong", () => {
    expect(parseAmountInput("")).toEqual({ ok: false, problem: "empty" });
    expect(parseAmountInput("   ")).toEqual({ ok: false, problem: "empty" });
    expect(parseAmountInput("0")).toEqual({ ok: false, problem: "zero" });
    expect(parseAmountInput("0.000")).toEqual({ ok: false, problem: "zero" });
    expect(parseAmountInput("99999999999999999999")).toEqual({ ok: false, problem: "too-large" });
    for (const problem of ["empty", "format", "zero", "too-large"] as const) expect(amountProblemText(problem)).toMatch(/\.$|\d$/);
  });

  it("carries lamports between contexts as decimal strings only", () => {
    expect(fromLamportString("1250000000")).toBe(1_250_000_000n);
    for (const text of ["", "01", "-1", "1.5", "1e9", " 1"]) expect(() => fromLamportString(text), text).toThrow(RangeError);
  });
});
