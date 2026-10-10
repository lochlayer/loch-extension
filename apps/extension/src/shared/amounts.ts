// Amounts as the interface writes and reads them. The rules are the design system's
// (docs/design/DESIGN.md, "Numerals"); the formatting itself is @loch/design/numerals. This file
// adds what a form needs: parsing with a reason, and limits.

import { type AmountParts, formatSol, parseSol } from "@loch/design/numerals";

export { formatSol, parseSol };
export type { AmountParts };

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** u64::MAX: no amount on chain is larger. */
export const MAX_LAMPORTS = (1n << 64n) - 1n;

/** A balance or a past amount: three decimals, cut toward zero, never rounded up. */
export function displaySol(lamports: bigint, sign: "auto" | "always" | "never" = "auto"): string {
  return formatSol(lamports, { sign }).text;
}

/** Anything about to be signed, and every fee: every digit that matters. */
export function exactSol(lamports: bigint): string {
  return formatSol(lamports, { exact: true }).text;
}

/** The text to put into an amount field for exactly `lamports` (no grouping, plain point). */
export function inputSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

export type AmountProblem = "empty" | "format" | "zero" | "too-large";

export type ParsedAmount = { ok: true; lamports: bigint } | { ok: false; problem: AmountProblem };

/**
 * Reads what a person typed into an amount field. Digits, one point, at most nine decimals;
 * nothing is guessed (no commas, no signs, no exponents).
 */
export function parseAmountInput(text: string): ParsedAmount {
  if (text.trim().length === 0) return { ok: false, problem: "empty" };
  const lamports = parseSol(text);
  if (lamports === null) return { ok: false, problem: "format" };
  if (lamports === 0n) return { ok: false, problem: "zero" };
  if (lamports > MAX_LAMPORTS) return { ok: false, problem: "too-large" };
  return { ok: true, lamports };
}

export function amountProblemText(problem: AmountProblem): string {
  switch (problem) {
    case "empty":
      return "Enter an amount.";
    case "format":
      return "Write the amount with digits and a point, with at most nine decimals: 1.25";
    case "zero":
      return "The amount must be more than zero.";
    case "too-large":
      return "That is more SOL than exists.";
  }
}

/** Lamports travel between contexts as decimal strings. */
export function toLamportString(value: bigint): string {
  return value.toString();
}

export function fromLamportString(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,29})$/.test(value)) throw new RangeError("not a lamport amount");
  return BigInt(value);
}
