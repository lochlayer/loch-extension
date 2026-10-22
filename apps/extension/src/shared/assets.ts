// The assets the v2 pool can hold, as the interface knows them (docs/v2.md section 2). Which
// assets a pool really holds is decided on chain (`register_asset`); this table gives them a
// name, a precision and the most this wallet agrees to pay a relayer in each. A mint the relayer
// takes and this table does not know is still usable: it is named by its first characters.
// No imports beyond the amounts helpers: the interface loads this too.

import type { Cluster } from "./constants.js";

export const NATIVE_MINT = "So11111111111111111111111111111111111111112";

export interface AssetMeta {
  mint: string;
  symbol: string;
  decimals: number;
  /** The most this wallet pays a relayer per transaction in this asset, base units, unless settings say otherwise (SOL). */
  maxFee: string;
}

const SOL: AssetMeta = { mint: NATIVE_MINT, symbol: "SOL", decimals: 9, maxFee: "5000000" };

/** Known assets by cluster. Every cluster has SOL. */
export const KNOWN_ASSETS: Readonly<Record<Cluster, readonly AssetMeta[]>> = {
  "mainnet-beta": [SOL, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, maxFee: "2000000" }],
  devnet: [SOL, { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6, maxFee: "2000000" }],
  testnet: [SOL],
  localnet: [SOL],
};

/** What is known of a mint on a cluster: the table's entry, or a short name and the precision read from chain. */
export function assetMeta(cluster: Cluster | null, mint: string, decimals?: number): AssetMeta {
  const known = (cluster ? KNOWN_ASSETS[cluster] : [SOL]).find((asset) => asset.mint === mint) ?? (mint === NATIVE_MINT ? SOL : null);
  if (known) return known;
  // An unknown token: no fee is agreed to beyond what the user types and sees.
  return { mint, symbol: `${mint.slice(0, 4)}…`, decimals: decimals ?? 0, maxFee: "0" };
}

export const isNative = (mint: string | undefined): boolean => mint === undefined || mint === NATIVE_MINT;

/** Base units as text with `decimals` places, cut toward zero to `shown` places (default: all). */
export function formatUnits(units: bigint, decimals: number, shown = decimals): string {
  const negative = units < 0n;
  const value = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  let frac = (value % scale).toString().padStart(decimals, "0").slice(0, Math.min(shown, decimals));
  if (shown >= decimals) frac = frac.replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac.length > 0 ? `.${frac}` : ""}`;
}

/** What a person typed as an amount of an asset with `decimals` places, or null. Digits and one point; no more places than the asset has. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) return null;
  const frac = match[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
