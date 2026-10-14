import { beforeAll, describe, expect, it } from "vitest";

const RPC = "https://rpc.example.org";
const RELAYER = "https://relayer.example.org";
const SCREENER = "https://screener.example.org";

beforeAll(() => {
  (globalThis as { __LOCH_BUILD__?: unknown }).__LOCH_BUILD__ = {
    version: "0.1.0-test", artifacts: {}, network: "mainnet-beta", mainnetTesting: true,
    setup: "test", circuit: "test", connectUrl: null, rpcUrl: RPC, relayerUrl: RELAYER, screenerUrl: SCREENER,
  };
});

describe("a build that names its endpoints", () => {
  it("starts a new installation with them, and they remain settings", async () => {
    const { DEFAULT_SETTINGS, normaliseSettings, allowedOrigins } = await import("../src/background/settings.js");
    expect(DEFAULT_SETTINGS).toMatchObject({ rpcUrl: RPC, relayerUrl: RELAYER, screenerUrl: SCREENER });
    expect(allowedOrigins(DEFAULT_SETTINGS).sort()).toEqual([RELAYER, RPC, SCREENER].sort());
    expect(normaliseSettings({ rpcUrl: "https://own.example.net" }).rpcUrl).toBe("https://own.example.net");
  });

  it("may reach them without asking: each is a host permission of the package", async () => {
    const { manifest } = (await import("../scripts/manifest.mjs" as string)) as { manifest(options: object): { host_permissions: string[] } };
    const hosts = manifest({ version: "0.1.0", mainnetTesting: true, hosts: [RPC, RELAYER, SCREENER] }).host_permissions;
    for (const origin of [RPC, RELAYER, SCREENER]) expect(hosts).toContain(`${origin}/*`);
  });
});
