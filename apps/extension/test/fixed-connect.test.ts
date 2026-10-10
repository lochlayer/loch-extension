// A release build compiles the connect page in (scripts/build.mjs --connect-url). This file
// stands in for such a build: the build's facts are set before the worker's modules load.

import { beforeAll, describe, expect, it } from "vitest";

const FIXED = "https://connect.loch.example/";

beforeAll(() => {
  (globalThis as { __LOCH_BUILD__?: unknown }).__LOCH_BUILD__ = { version: "0.0.0-test", artifacts: {}, network: "devnet", setup: "test", circuit: "test", connectUrl: FIXED };
});

describe("a build with the connect page compiled in (finding 2)", () => {
  it("uses the compiled address whatever is stored, shows it as fixed, and takes no change", async () => {
    const { normaliseSettings } = await import("../src/background/settings.js");
    const { handleUi } = await import("../src/background/router.js");
    const { startUnlock } = await import("../src/background/flows.js");
    const { memoryKV } = await import("../src/background/kv.js");
    const { createHarness, settle } = await import("./harness.js");

    expect(normaliseSettings({ connectUrl: "https://evil.example/connect.html" }).connectUrl).toBe(FIXED);
    expect(normaliseSettings({}).connectUrl).toBe(FIXED);

    // Settings on disk that name another page (written by an older build, or by anything else).
    const local = memoryKV({ settings: { rpcUrl: "https://rpc.test", relayerUrl: "https://relayer.test", screenerUrl: "https://screener.test", connectUrl: "https://evil.example/connect.html" } });
    const h = createHarness({ local });
    const state = await handleUi(h.core, { loch: "ui", type: "state" });
    expect(state).toMatchObject({ ok: true, value: { settings: { connectUrl: FIXED, connectFixed: true } } });

    const evil = "https://evil.example/connect.html";
    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { connectUrl: evil, confirmConnectUrl: evil } })).toMatchObject({ ok: false, error: { message: "connectUrl:fixed" } });
    expect((await h.core.settings()).connectUrl).toBe(FIXED);
    // Other settings still save.
    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { theme: "night" } })).toMatchObject({ ok: true, value: { connectUrl: FIXED } });

    const opened: string[] = [];
    const create = h.env.tabs.create;
    h.env.tabs.create = async (options) => {
      opened.push(options.url);
      return create(options);
    };
    await startUnlock(h.core, null);
    await settle(h);
    expect(opened).toEqual([FIXED]);
  });
});
