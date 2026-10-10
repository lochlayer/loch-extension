/**
 * @loch/design/numerals: how Loch writes amounts and addresses.
 *
 * The rules (docs/design/DESIGN.md, "Numerals"):
 *  - Displayed amounts are truncated toward zero, never rounded up: the
 *    interface must not show more than there is.
 *  - Three decimals by default, always all three ("12.480").
 *  - Anything the user is about to sign is shown exactly (`exact: true`): at
 *    least three decimals, up to nine, trailing zeros dropped.
 *  - A non-zero amount too small to show at the chosen precision is written
 *    "<0.001", never "0.000".
 *  - The decimal mark is always a point. Thousands are grouped with a thin
 *    space from 10 000 up, so no locale can misread a comma.
 *  - The sign is "+" or a true minus (U+2212), never a hyphen.
 *
 * Dependency-free and DOM-free.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** U+2009. Present in both Libre Franklin and Old Standard TT (U+202F is in neither). */
export const THIN_SPACE = " ";
/** U+2212, the true minus. */
export const MINUS = "−";
/** U+2026, used to shorten addresses. */
export const ELLIPSIS = "…";

const SOL_DECIMALS = 9;

export type AmountSign = "" | "+" | "−";

export type FormatSolOptions = {
  /** Decimals shown. Default 3. Ignored when `exact` is set. */
  decimals?: number;
  /** Show every digit that matters: at least `decimals`, up to nine. Use for anything about to be signed, and for fees. */
  exact?: boolean;
  /**
   * "auto" (default) writes a minus on negatives only; "always" also writes a
   * plus on positives (use for changes: activity rows); "never" writes none.
   */
  sign?: "auto" | "always" | "never";
};

export type AmountParts = {
  /** "", "+" or the true minus. */
  sign: AmountSign;
  /** Whole part, grouped with thin spaces from 10 000 up. */
  int: string;
  /** Fraction including its leading point, e.g. ".480". Empty when `decimals` is 0. */
  frac: string;
  /** sign + int + frac. When `negligible`, "<0.001" (after the sign). */
  text: string;
  /** True when digits were dropped to fit `decimals`. The full amount belongs in a title or a detail view. */
  truncated: boolean;
  /** True when the amount is not zero but shows as zero at this precision. */
  negligible: boolean;
};

function toBigInt(lamports: bigint | number): bigint {
  if (typeof lamports === "bigint") return lamports;
  if (!Number.isFinite(lamports)) throw new RangeError("formatSol: lamports must be finite");
  if (!Number.isInteger(lamports)) throw new RangeError("formatSol: lamports must be a whole number (use toLamports for SOL)");
  return BigInt(lamports);
}

function group(digits: string): string {
  if (digits.length < 5) return digits;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

/** Formats an amount of lamports as SOL, split into the parts the type system sets differently. */
export function formatSol(lamports: bigint | number, options: FormatSolOptions = {}): AmountParts {
  const { exact = false, sign: signMode = "auto" } = options;
  const wanted = typeof options.decimals === "number" && Number.isFinite(options.decimals) ? Math.trunc(options.decimals) : 3;
  const decimals = Math.min(SOL_DECIMALS, Math.max(0, wanted));
  const value = toBigInt(lamports);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  const whole = magnitude / LAMPORTS_PER_SOL;
  const fractionDigits = (magnitude % LAMPORTS_PER_SOL).toString().padStart(SOL_DECIMALS, "0");

  let shown: string;
  if (exact) {
    const trimmed = fractionDigits.replace(/0+$/, "");
    shown = trimmed.length >= decimals ? trimmed : fractionDigits.slice(0, decimals);
  } else {
    shown = fractionDigits.slice(0, decimals);
  }
  const truncated = /[1-9]/.test(fractionDigits.slice(shown.length));
  const negligible = magnitude !== 0n && whole === 0n && !/[1-9]/.test(shown);

  const sign: AmountSign =
    signMode === "never" || magnitude === 0n ? "" : negative ? MINUS : signMode === "always" ? "+" : "";
  const int = group(whole.toString());
  const frac = shown.length > 0 ? `.${shown}` : "";
  const smallest = decimals > 0 ? `0.${"0".repeat(decimals - 1)}1` : "1";
  const text = negligible ? `${sign}<${smallest}` : `${sign}${int}${frac}`;
  return { sign, int, frac, text, truncated, negligible };
}

/** Converts SOL held as a JavaScript number (as the scanner's `Flow.amount` is) to lamports, rounding to the nearest lamport. */
export function toLamports(sol: number): bigint {
  if (!Number.isFinite(sol)) throw new RangeError("toLamports: amount must be finite");
  return BigInt(Math.round(sol * 1e9));
}

/**
 * Parses what a person typed into an amount field into lamports. Accepts
 * digits with an optional point and up to nine decimals; spaces (including
 * thin spaces) are ignored. Returns null for anything else, including
 * commas, signs, exponents and more than nine decimals: an amount field must
 * never guess.
 */
export function parseSol(text: string): bigint | null {
  const cleaned = text.replace(/[\s  ]/g, "");
  const match = /^(\d*)(?:\.(\d{0,9}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") return null;
  return BigInt(whole === "" ? "0" : whole) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(SOL_DECIMALS, "0"));
}

/**
 * A shielded address is bech32m with the prefix "loch" and the separator "1":
 * every one of them begins `loch1`. The prefix says what kind of address it is
 * and nothing about which, so it is kept whole and what follows is shortened
 * or grouped.
 *
 * bech32 is all lower case or all upper case, never mixed. A public Solana
 * address is base58, which has neither "l" nor "O", so it can begin with
 * neither spelling: the two kinds cannot be confused.
 */
const SHIELDED_PREFIX = /^(?:loch1|LOCH1|lochpay1|LOCHPAY1)/;

function prefixLength(address: string): number {
  return SHIELDED_PREFIX.exec(address)?.[0].length ?? 0;
}

/**
 * `Fh3q…Tz8K`: the first and last four characters. The same shape the scanner
 * writes. A shielded address keeps its prefix: `loch1qw50…f3t4`.
 */
export function shortAddress(address: string, lead = 4, tail = 4): string {
  const head = prefixLength(address) + lead;
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}${ELLIPSIS}${address.slice(-tail)}`;
}

/**
 * The whole address in groups of four, for checking by eye before signing.
 * A shielded address keeps `loch1` together and groups what follows:
 * `loch1 qw50 8d6q …`.
 */
export function groupAddress(address: string): string {
  const head = prefixLength(address);
  const body = address.slice(head).replace(/(.{4})(?=.)/g, "$1 ");
  if (head === 0) return body;
  return body === "" ? address : `${address.slice(0, head)} ${body}`;
}

/** Escapes text for use in HTML or SVG markup. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export type AmountHtmlOptions = {
  /** Unit written after the figure, e.g. "SOL" or "devnet SOL". Omit in a column whose head already names the unit. */
  unit?: string;
  /** True when only the holder can see this amount. Sets it italic, in loch blue. */
  shielded?: boolean;
  /** Extra class names for the outer element. */
  className?: string;
};

/**
 * Markup for an amount in running text, a row or a table cell:
 * `<span class="fig is-public"><span class="fig-sign">+</span>5.000</span>`.
 * The exact amount, when digits were dropped, goes in `title`.
 */
export function amountHtml(parts: AmountParts, options: AmountHtmlOptions = {}, exactText?: string): string {
  const role = options.shielded ? "is-shielded" : "is-public";
  const cls = ["fig", role, options.className].filter(Boolean).join(" ");
  const title = parts.truncated && exactText ? ` title="${escapeHtml(exactText)}"` : "";
  const sign = parts.sign ? `<span class="fig-sign">${escapeHtml(parts.sign)}</span>` : "";
  const body = escapeHtml(parts.negligible ? parts.text.slice(parts.sign.length) : `${parts.int}${parts.frac}`);
  // The unit follows a no-break space.
  const unit = options.unit ? `\u00a0<span class="fig-unit">${escapeHtml(options.unit)}</span>` : "";
  return `<span class="${escapeHtml(cls)}"${title}>${sign}${body}</span>${unit}`;
}

/**
 * Markup for the shielded balance written as a sounding: whole number at full
 * size, fraction at half size and dropped. Only for display sizes (the
 * fraction must itself be at least 22px).
 *
 * What is drawn is what is announced. An amount that is not zero but too
 * small to show is drawn `<` `0` `.001`, never `0` `.000`: the "less than" is
 * a part of its own (`.sounding__less`), set at the fraction's size so that
 * the large figure is the whole number and not "<0". A balance has no sign,
 * so none is drawn: format it with `sign: "never"`.
 */
export function soundingHtml(parts: AmountParts): string {
  let less = "";
  let whole = parts.int;
  let fraction = parts.frac;
  if (parts.negligible) {
    // "<0.001" (or "<0.01", "<1" at other precisions), split at the point as any other amount is.
    const shown = parts.text.slice(parts.sign.length).replace(/^</, "");
    const point = shown.indexOf(".");
    less = `<span class="sounding__less" aria-hidden="true">&lt;</span>`;
    whole = point < 0 ? shown : shown.slice(0, point);
    fraction = point < 0 ? "" : shown.slice(point);
  }
  return (
    `<span class="sounding" aria-label="${escapeHtml(parts.text)}">${less}<span aria-hidden="true">${escapeHtml(whole)}</span>` +
    `<span class="sounding__frac" aria-hidden="true">${escapeHtml(fraction)}</span></span>`
  );
}
