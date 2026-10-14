/** Facts about this build, written in by scripts/build.mjs. */
declare const __LOCH_BUILD__: {
  version: string;
  artifacts: Record<string, { sha256: string; bytes: number }>;
  network: string;
  /** Explicit opt-in compiled into the mainnet testing package. */
  mainnetTesting: boolean;
  setup: string;
  circuit: string;
  /** The connect page fixed at build time, or null when it is a setting. */
  connectUrl: string | null;
  /** The RPC endpoint a new installation starts with, or null for the cluster's public one. */
  rpcUrl: string | null;
  /** The relayer and the screening service a new installation starts with, or null for this machine's. */
  relayerUrl: string | null;
  screenerUrl: string | null;
};
