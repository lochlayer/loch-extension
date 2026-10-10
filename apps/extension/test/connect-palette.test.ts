// The connect page has no script of its own, so it cannot follow the palette chosen in Loch.
// The extension's content script sets data-theme="night" on its root element when the service
// worker tells it to, and the service worker tells the bridge page and no other.

import { describe, expect, it } from "vitest";

import { handleContent, handleUi } from "../src/background/router.js";
import type { ContentConfig } from "../src/shared/messages.js";
import { type Harness, createHarness } from "./harness.js";
import { connect } from "./steps.js";

const config = (h: Harness, tabId: number, url: string) => handleContent(h.core, h.sender(tabId, url), { loch: "content", type: "config" }) as Promise<ContentConfig>;
const setTheme = async (h: Harness, theme: "dusk" | "night") => expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { theme } })).toMatchObject({ ok: true });

/** What the content script in each tab the extension opens is told, asked again right after the page announced itself. */
function watchBridgeTabs(h: Harness): { url: string; told: ContentConfig }[] {
  const seen: { url: string; told: ContentConfig }[] = [];
  const create = h.env.tabs.create;
  h.env.tabs.create = async (options) => {
    const tab = await create(options);
    setImmediate(() => void config(h, tab.id, options.url).then((told) => seen.push({ url: options.url, told })));
    return tab;
  };
  return seen;
}

describe("the connect page follows the palette chosen in Loch", () => {
  it("the bridge page is told night when the palette is night", async () => {
    const h = createHarness();
    await setTheme(h, "night");
    const seen = watchBridgeTabs(h);
    await connect(h);
    expect(seen.length).toBeGreaterThan(0);
    for (const { url, told } of seen) {
      expect(url).toBe((await h.core.settings()).connectUrl);
      expect(told).toMatchObject({ bridge: true, night: true });
    }
  });

  it("and is told nothing about a palette in dusk, the default", async () => {
    const h = createHarness();
    const seen = watchBridgeTabs(h);
    await connect(h);
    expect(seen.length).toBeGreaterThan(0);
    for (const { told } of seen) {
      expect(told.bridge).toBe(true);
      expect("night" in told).toBe(false);
    }
  });

  it("no other page is told, whatever the palette: not a website, not the connect page in a tab the user opened, not another page of its origin", async () => {
    const h = createHarness();
    await setTheme(h, "night");
    const connectUrl = (await h.core.settings()).connectUrl;
    const pages: [number, string][] = [
      [31, "https://dapp.example/"],
      [32, connectUrl],
      [33, new URL("/other.html", connectUrl).href],
      [34, `${connectUrl}?theme=night`],
    ];
    for (const [tabId, url] of pages) {
      h.tabs.set(tabId, url);
      const told = await config(h, tabId, url);
      expect(told.bridge, url).toBe(false);
      expect("night" in told, url).toBe(false);
    }
  });

  it("with the wrapper off the bridge page is still told", async () => {
    const h = createHarness();
    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { theme: "night", wrapperEnabled: false } })).toMatchObject({ ok: true });
    const seen = watchBridgeTabs(h);
    await connect(h);
    expect(seen.length).toBeGreaterThan(0);
    for (const { told } of seen) expect(told).toEqual({ enabled: false, wallet: null, bridge: true, night: true });
  });
});
