// The Wallet Standard, as far as this script needs it: finding the wallets a page has, and
// registering one. Written out here (it is two events) so the page script has no dependencies.

export interface StandardAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
  readonly label?: string;
  readonly icon?: string;
}

export interface StandardWallet {
  readonly version: string;
  readonly name: string;
  readonly icon: string;
  readonly chains: readonly string[];
  readonly features: Readonly<Record<string, unknown>>;
  readonly accounts: readonly StandardAccount[];
}

type RegisterApi = { register(...wallets: StandardWallet[]): () => void };

const REGISTER_EVENT = "wallet-standard:register-wallet";
const APP_READY_EVENT = "wallet-standard:app-ready";

export interface WalletRegistry {
  /** The wallets registered on this page, in the order they arrived. */
  list(): StandardWallet[];
  /** Calls `listener` for each wallet already here and each one that arrives later. */
  onWallet(listener: (wallet: StandardWallet) => void): void;
}

/** Listens as an app does. Wallets in `ignore` are not collected (the Loch wallet itself). */
export function watchWallets(target: EventTarget, ignore: (wallet: StandardWallet) => boolean): WalletRegistry {
  const wallets: StandardWallet[] = [];
  const listeners: ((wallet: StandardWallet) => void)[] = [];
  const api: RegisterApi = {
    register(...added) {
      for (const wallet of added) {
        if (!isWallet(wallet) || ignore(wallet) || wallets.includes(wallet)) continue;
        wallets.push(wallet);
        for (const listener of listeners) listener(wallet);
      }
      return () => {
        for (const wallet of added) {
          const index = wallets.indexOf(wallet);
          if (index >= 0) wallets.splice(index, 1);
        }
      };
    },
  };
  target.addEventListener(REGISTER_EVENT, (event) => {
    const callback = (event as CustomEvent<unknown>).detail;
    if (typeof callback === "function") {
      try {
        (callback as (api: RegisterApi) => void)(api);
      } catch {
        // A wallet that throws while registering is that wallet's problem.
      }
    }
  });
  try {
    target.dispatchEvent(new CustomEvent(APP_READY_EVENT, { detail: api }));
  } catch {
    // Nothing is listening yet.
  }
  return {
    list: () => wallets.slice(),
    onWallet(listener) {
      listeners.push(listener);
      for (const wallet of wallets.slice()) listener(wallet);
    },
  };
}

/** Registers `wallet` with every app on the page, now and later. */
export function registerWallet(target: EventTarget, wallet: StandardWallet): void {
  const callback = (api: RegisterApi) => {
    api.register(wallet);
  };
  try {
    target.dispatchEvent(new CustomEvent(REGISTER_EVENT, { detail: callback }));
  } catch {
    // No app yet.
  }
  target.addEventListener(APP_READY_EVENT, (event) => {
    const api = (event as CustomEvent<unknown>).detail as RegisterApi | undefined;
    if (api && typeof api.register === "function") callback(api);
  });
}

function isWallet(value: unknown): value is StandardWallet {
  if (typeof value !== "object" || value === null) return false;
  const wallet = value as Partial<StandardWallet>;
  return typeof wallet.name === "string" && typeof wallet.features === "object" && wallet.features !== null;
}

/** Whether a wallet lists any Solana chain. */
export function isSolanaWallet(wallet: StandardWallet): boolean {
  try {
    return Array.from(wallet.chains ?? []).some((chain) => typeof chain === "string" && chain.startsWith("solana:"));
  } catch {
    return false;
  }
}
