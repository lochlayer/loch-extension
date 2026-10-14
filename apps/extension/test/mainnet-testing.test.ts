import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";

beforeAll(() => {
  (globalThis as { __LOCH_BUILD__?: unknown }).__LOCH_BUILD__ = {
    version: "0.1.0-test", artifacts: {}, network: "mainnet-beta", mainnetTesting: true,
    setup: "single-contributor development setup", circuit: "test", connectUrl: null,
  };
});

describe("the explicit mainnet testing package", () => {
  it("defaults to mainnet, accepts its exact genesis and rejects other clusters", async () => {
    const { DEFAULT_SETTINGS } = await import("../src/background/settings.js");
    const { assertAllowedCluster } = await import("../src/background/network.js");
    const { GENESIS } = await import("../src/shared/constants.js");
    const { defaultServiceUrls } = await import("../src/shared/build.js");
    expect(DEFAULT_SETTINGS.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(defaultServiceUrls().rpcUrl).toBeNull();
    expect(() => assertAllowedCluster({ cluster: "mainnet-beta", genesisHash: GENESIS["mainnet-beta"] })).not.toThrow();
    expect(() => assertAllowedCluster({ cluster: "devnet", genesisHash: GENESIS.devnet })).toThrow(/requires a mainnet RPC/);
    expect(() => assertAllowedCluster({ cluster: "mainnet-beta", genesisHash: GENESIS.devnet })).toThrow(/requires a mainnet RPC/);
  });

  it("allows deposit, sync, quote and withdrawal with matching mainnet services", async () => {
    const { createHarness, settle } = await import("./harness.js");
    const { connect, fund, dive, shielded } = await import("./steps.js");
    const { GENESIS } = await import("../src/shared/constants.js");
    const { startSpend } = await import("../src/background/flows.js");
    const { handleUi } = await import("../src/background/router.js");
    const h = createHarness();
    h.chain.genesisHash = GENESIS["mainnet-beta"];
    h.chain.maxDeposit = 10_000_000n;
    await connect(h);
    fund(h, 30_000_000n);
    await dive(h, 10_000_000n);
    expect((await shielded(h)).balance).toBe(10_000_000n);
    expect(await handleUi(h.core, { loch: "ui", type: "quote", want: "spend" })).toMatchObject({ ok: true, value: { cluster: "mainnet-beta" } });
    const recipient = Keypair.generate().publicKey;
    await startSpend(h.core, "surface", { to: recipient.toBase58(), amount: 7_500_000n, fee: 2_500_000n });
    expect((await settle(h)).status).toBe("done");
    expect(h.chain.balance(recipient)).toBe(7_500_000n);
    expect((await shielded(h)).balance).toBe(0n);
  });

  it("carries no band (its cautions are on the website) and never calls its balance test SOL", async () => {
    const { unitOf, CautionBand } = await import("../src/ui/App.js");
    expect(unitOf({ cluster: "mainnet-beta" } as never)).toBe("SOL");
    expect(unitOf({ cluster: null } as never)).toBe("SOL");
    expect(CautionBand({ snapshot: null })).toBeNull();
  });
});
