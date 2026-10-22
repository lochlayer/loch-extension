// Assets (docs/v2.md section 2). A note carries `assetId(mint)`; SOL is the
// native mint. Which assets a pool holds is decided by its admin
// (`register_asset`); the lists here are what clients look for in a note.

import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";

import { bytesToBigIntBE, concatBytes, utf8 } from "../bytes.js";
import { ASSET_ID_LABEL, NATIVE_MINT } from "./constants.js";

/** `sha256("loch-asset-v2" || mint)` with its first byte cleared, as a field element. */
export function assetId(mint: PublicKey): bigint {
  const digest = sha256(concatBytes(utf8(ASSET_ID_LABEL), mint.toBytes()));
  digest[0] = 0;
  return bytesToBigIntBE(digest);
}

/** What a client shows of an asset. */
export interface AssetInfo {
  mint: PublicKey;
  symbol: string;
  /** Decimal places of the base unit (9 for SOL: lamports). */
  decimals: number;
}

export const SOL_ASSET: AssetInfo = { mint: NATIVE_MINT, symbol: "SOL", decimals: 9 };

/** Assets a mainnet wallet looks for. */
export const MAINNET_ASSETS: readonly AssetInfo[] = Object.freeze([
  SOL_ASSET,
  { mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), symbol: "USDC", decimals: 6 },
  { mint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), symbol: "USDT", decimals: 6 },
]);

/** An asset list with each asset's id computed once. */
export interface AssetTable {
  readonly assets: readonly AssetInfo[];
  /** The asset whose `assetId` is `id`, if listed. */
  byId(id: bigint): AssetInfo | undefined;
  byMint(mint: PublicKey): AssetInfo | undefined;
  idOf(mint: PublicKey): bigint;
}

export function assetTable(assets: readonly AssetInfo[]): AssetTable {
  const ids = new Map<bigint, AssetInfo>();
  const mints = new Map<string, AssetInfo>();
  for (const asset of assets) {
    ids.set(assetId(asset.mint), asset);
    mints.set(asset.mint.toBase58(), asset);
  }
  return {
    assets: [...assets],
    byId: (id) => ids.get(id),
    byMint: (mint) => mints.get(mint.toBase58()),
    idOf: (mint) => assetId(mint),
  };
}

/** True for the native mint (SOL). */
export function isNativeMint(mint: PublicKey): boolean {
  return mint.equals(NATIVE_MINT);
}

export { NATIVE_MINT };
