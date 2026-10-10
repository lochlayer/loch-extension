import type { Labels } from "./types.js";

/** Shortens an address to its first and last four characters: `9WzD…AWWM`. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Looks an address up in a label map. Only own, non-empty string entries
 * count, so an address that happens to spell an Object.prototype key (the RPC
 * is untrusted input) can never produce a label.
 */
export function labelFor(labels: Labels, address: string): string | undefined {
  if (!Object.hasOwn(labels, address)) return undefined;
  const label = labels[address];
  return typeof label === "string" && label !== "" ? label : undefined;
}

/**
 * Renders an amount of an asset for a sentence: `1.500 SOL`, `25 tokens (mint EPjF…Dt1v)`.
 * SOL is written exactly, as anything about to be signed is: at least three
 * decimals, up to nine, trailing zeros dropped.
 */
export function describeAmount(amount: number, asset: string): string {
  if (asset === "SOL") return `${exactSol(amount)} SOL`;
  const n = trimNumber(amount);
  if (asset === "SPL") return `${n} tokens`;
  return `${n} tokens (mint ${shortAddress(asset)})`;
}

const LAMPORTS_PER_SOL = 1_000_000_000;
/** U+2009. Parts thousands from 10 000 up, so no locale can misread a comma. */
const THIN_SPACE = "\u2009";

/**
 * A SOL balance as running text writes one: cut toward zero at three decimals
 * (never rounded up), all three written, thousands parted by a thin space from
 * 10 000 up, and `<0.001` for an amount that is not zero but too small to show.
 * `12.480`, `0.000`, `<0.001`, `12 480.739`.
 */
export function displaySol(sol: number): string {
  if (!Number.isFinite(sol)) return String(sol);
  // A balance is never negative; back to whole lamports so the cut is exact.
  const lamports = Math.round(Math.max(0, sol) * LAMPORTS_PER_SOL);
  const thousandths = Math.floor(lamports / 1_000_000);
  if (thousandths === 0 && lamports > 0) return "<0.001";
  const whole = Math.floor(thousandths / 1000);
  const fraction = String(thousandths % 1000).padStart(3, "0");
  return `${groupThousands(whole)}.${fraction}`;
}

/** An hour of the day on the 24-hour clock, zero-padded: `04:00`, `22:00`. */
export function clockHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** `1 transfer`, `2 transfers`: the count with the noun in the right number. */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function groupThousands(whole: number): string {
  const digits = String(whole);
  return whole < 10_000 ? digits : digits.replace(/\B(?=(\d{3})+$)/g, THIN_SPACE);
}

/** SOL in full: at least three decimals, up to nine, trailing zeros dropped. */
function exactSol(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const [whole = "0", fraction = ""] = value.toFixed(9).split(".");
  return `${whole}.${fraction.replace(/0+$/, "").padEnd(3, "0")}`;
}

/** Fixed-point with up to nine decimals and no trailing zeros, never exponent notation for ordinary amounts. */
function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const fixed = value.toFixed(9);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
