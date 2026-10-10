import { describe, expect, it } from "vitest";

import { BlockedRequestError, MainnetRefusedError, assertAllowedCluster, guardedFetch, readCluster } from "../src/background/network.js";
import { DEFAULT_SETTINGS, allowedOrigins, checkEndpoint, endpointProblemText, isLoopbackHost, normaliseSettings } from "../src/background/settings.js";
import { handleUi } from "../src/background/router.js";
import { startDive, startSpend } from "../src/background/flows.js";
import { syncWalletNow } from "../src/background/sync.js";
import { GENESIS, clusterOf } from "../src/shared/constants.js";
import { RELAYER, RPC, SCREENER, createHarness, settle } from "./harness.js";
import { connect, fund } from "./steps.js";

describe("the guarded fetch", () => {
  it("only reaches the configured origins", async () => {
    const seen: string[] = [];
    const fetcher = guardedFetch(["https://rpc.test"], async (input) => {
      seen.push(String(input));
      return new Response("{}");
    });
    await fetcher("https://rpc.test/path", { method: "POST", body: "{}" });
    await expect(fetcher("https://telemetry.example/collect")).rejects.toBeInstanceOf(BlockedRequestError);
    await expect(fetcher("https://rpc.test.evil.example/")).rejects.toBeInstanceOf(BlockedRequestError);
    await expect(fetcher("http://rpc.test/")).rejects.toBeInstanceOf(BlockedRequestError);
    expect(seen).toEqual(["https://rpc.test/path"]);
  });

  it("sends no cookies, no referrer, follows no redirect, and drops headers that identify the client", async () => {
    let init: RequestInit | undefined;
    const fetcher = guardedFetch(["https://rpc.test"], async (_input, given) => {
      init = given;
      return new Response("{}");
    });
    await fetcher("https://rpc.test/", { method: "POST", headers: { "content-type": "application/json", "solana-client": "js/1.99.0", "x-user": "someone" }, body: "{}" });
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    const headers = new Headers(init?.headers);
    expect([...headers.keys()]).toEqual(["content-type"]);
  });

  it("gives up after a timeout", async () => {
    const fetcher = guardedFetch(["https://rpc.test"], (_input, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))), 20);
    await expect(fetcher("https://rpc.test/")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("the allowed origins are exactly the endpoints in settings", () => {
    expect(allowedOrigins(DEFAULT_SETTINGS).sort()).toEqual(["http://127.0.0.1:8791", "http://127.0.0.1:8792", "https://api.devnet.solana.com"]);
    const withRelay = normaliseSettings({ ...DEFAULT_SETTINGS, ohttp: { enabled: true, relayUrl: "https://relay.example", keyConfig: "00", pinnedKey: "" } });
    expect(allowedOrigins(withRelay)).toContain("https://relay.example");
  });
});

describe("endpoints a user types", () => {
  it("https everywhere, plain http only for this machine", () => {
    expect(checkEndpoint("https://rpc.example.org")).toEqual({ ok: true, url: "https://rpc.example.org", origin: "https://rpc.example.org" });
    expect(checkEndpoint(" https://rpc.example.org/ ")).toMatchObject({ ok: true, url: "https://rpc.example.org" });
    expect(checkEndpoint("https://rpc.example.org/v1?key=abc")).toMatchObject({ ok: true, url: "https://rpc.example.org/v1?key=abc" });
    expect(checkEndpoint("http://127.0.0.1:8899")).toMatchObject({ ok: true });
    expect(checkEndpoint("http://localhost:8787")).toMatchObject({ ok: true });
    expect(checkEndpoint("http://rpc.example.org")).toEqual({ ok: false, problem: "insecure" });
    expect(checkEndpoint("http://evil.localhost")).toEqual({ ok: false, problem: "insecure" });
    expect(checkEndpoint("http://127.0.0.1.evil.example")).toEqual({ ok: false, problem: "insecure" });
  });

  it("says what is wrong", () => {
    expect(checkEndpoint("")).toEqual({ ok: false, problem: "empty" });
    expect(checkEndpoint("rpc.example.org")).toEqual({ ok: false, problem: "not-a-url" });
    expect(checkEndpoint("ftp://rpc.example.org")).toEqual({ ok: false, problem: "scheme" });
    expect(checkEndpoint("javascript:alert(1)")).toEqual({ ok: false, problem: "scheme" });
    expect(checkEndpoint("https://user:pass@rpc.example.org")).toEqual({ ok: false, problem: "credentials" });
    expect(checkEndpoint("https://rpc.example.org/#x")).toEqual({ ok: false, problem: "fragment" });
    for (const problem of ["empty", "not-a-url", "scheme", "insecure", "credentials", "fragment"] as const) expect(endpointProblemText(problem).length).toBeGreaterThan(10);
    expect(isLoopbackHost("127.0.0.1") && isLoopbackHost("localhost") && isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("example.localhost")).toBe(false);
  });

  it("stored settings that are invalid fall back to the defaults", () => {
    const settings = normaliseSettings({ rpcUrl: "http://evil.example", relayerUrl: 5, theme: "neon", maxFeeLamports: "-1", wrapperEnabled: "yes" });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(normaliseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("the interface cannot save an endpoint the checks refuse", async () => {
    const h = createHarness();
    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { rpcUrl: "http://rpc.example.org" } })).toMatchObject({ ok: false });
    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { relayerUrl: "https://relayer.example.org", theme: "night" } })).toMatchObject({ ok: true });
    expect((await h.core.settings()).relayerUrl).toBe("https://relayer.example.org");
    expect((await h.core.settings()).theme).toBe("night");
  });
});

describe("mainnet is refused by default", () => {
  it("knows the clusters by genesis hash", () => {
    expect(clusterOf(GENESIS["mainnet-beta"])).toBe("mainnet-beta");
    expect(clusterOf(GENESIS.devnet)).toBe("devnet");
    expect(clusterOf("anything else")).toBe("localnet");
    expect(() => assertAllowedCluster({ genesisHash: GENESIS["mainnet-beta"], cluster: "mainnet-beta" })).toThrow(MainnetRefusedError);
    expect(() => assertAllowedCluster({ genesisHash: GENESIS.devnet, cluster: "devnet" })).not.toThrow();
  });

  it("asks the endpoint, not the settings, which chain it is", async () => {
    await expect(readCluster({ getGenesisHash: async () => GENESIS["mainnet-beta"] })).resolves.toMatchObject({ cluster: "mainnet-beta" });
  });

  it("no deposit, no spend, no sync and no quote on mainnet; the relayer and the screener are never contacted", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10_000_000_000n);
    h.chain.genesisHash = GENESIS["mainnet-beta"];
    h.requests.length = 0;

    expect(await syncWalletNow(h.core, h.wallet.address)).toEqual({ status: "mainnet" });

    await startDive(h.core, 1_000_000_000n);
    expect((await settle(h)).failure).toMatchObject({ code: "mainnet", moved: "no", retry: false });
    await h.core.clearFlow();

    await startSpend(h.core, "send", { to: (await h.core.snapshot()).shielded!.address, amount: 1n, fee: 2_500_000n });
    expect((await settle(h)).failure).toMatchObject({ code: "mainnet" });
    await h.core.clearFlow();

    await startSpend(h.core, "surface", { to: h.wallet.address, amount: 1_000_000n, fee: 2_500_000n });
    expect((await settle(h)).failure).toMatchObject({ code: "mainnet" });

    expect(await handleUi(h.core, { loch: "ui", type: "quote", want: "spend" })).toMatchObject({ ok: false });
    expect(h.prover.calls).toBe(0);
    expect(h.wallet.prompts.filter((p) => p.kind === "signTransaction")).toEqual([]);
    expect(new Set(h.requests)).toEqual(new Set([RPC]));
    expect(h.requests).not.toContain(RELAYER);
    expect(h.requests).not.toContain(SCREENER);
  });
});
