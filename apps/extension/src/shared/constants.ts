// Constants shared by every context. No imports: the content and page scripts load this too.

/** The message whose signature derives the shielded keys (docs/protocol.md section 3). */
export const KEY_DERIVATION_TEXT = "Loch key derivation v1";

export const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

export function clusterOf(genesisHash: string): Cluster {
  if (genesisHash === GENESIS["mainnet-beta"]) return "mainnet-beta";
  if (genesisHash === GENESIS.devnet) return "devnet";
  if (genesisHash === GENESIS.testnet) return "testnet";
  return "localnet";
}

/** Wallet Standard chain identifier for a cluster. */
export function chainOf(cluster: Cluster): string {
  return cluster === "mainnet-beta" ? "solana:mainnet" : `solana:${cluster}`;
}

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Rent-exempt minimum of a system account without data (890,880 lamports). */
export const SYSTEM_RENT_MINIMUM = 890_880n;
/** Rent-exempt minimum of one nullifier record (9 bytes of data). A transaction creates two. */
export const NULLIFIER_RECORD_RENT = 953_520n;
/** One signature costs this much. A deposit carries two: the depositor's and the screener's. */
export const SIGNATURE_FEE = 5_000n;
/** What a deposit costs its sender on top of the amount: two signatures and two nullifier records. */
export const DEPOSIT_OVERHEAD = 2n * SIGNATURE_FEE + 2n * NULLIFIER_RECORD_RENT;

export const DEFAULTS = {
  rpcUrl: "https://api.devnet.solana.com",
  // The ports services/relayer and services/screener listen on by default.
  relayerUrl: "http://127.0.0.1:8791",
  screenerUrl: "http://127.0.0.1:8792",
  // A port of its own: the development connect page is the only thing served there. (5173 is
  // Vite's default, where any other local dev server lands, and the bridge trusts this address.)
  connectUrl: "http://127.0.0.1:5174/connect.html",
  /** The most this wallet agrees to pay a relayer for one transaction, unless the user changes it. */
  maxFeeLamports: "5000000",
} as const;

/** Where a claim link points: the code follows the "#", which a browser never sends to the server. */
export const CLAIM_PAGE = "https://lochlayer.com/claim";
/** Where a receipt or a source-of-funds report can be checked by whoever is given one. */
export const VERIFY_PAGE = "lochlayer.com/verify";
/** A depth proof's link: the code follows the "#", which a browser never sends to the server. */
export const DEPTH_PAGE = "https://lochlayer.com/verify";
