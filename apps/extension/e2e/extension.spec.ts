// End to end: the built extension, loaded into Chromium, against mock services that speak the
// real protocols. The proofs are real: they are generated inside the extension's offscreen
// document with the bundled artifacts, and the mock relayer and the mock chain both verify them
// against the real verification key.

import { join } from "node:path";

import { vaultPda } from "@loch/sdk";
import { type BrowserContext, type Page, expect as playwrightExpect } from "@playwright/test";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, test } from "vitest";

import { SHOTS_DIR, SOL, type World, configure, createWorld, openPopup } from "./env.js";

// Playwright's assertions, which wait and retry, under vitest as the runner.
const expect = playwrightExpect.configure({ timeout: 30_000 });

let world: World;
let context: BrowserContext;
let extensionId: string;
let popup: Page;
const pageErrors: string[] = [];

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS_DIR, `e2e-${name}.png`) });
const balance = (page: Page) => page.locator(".balance--shielded .sounding");
const sheet = (page: Page) => page.locator(".sheet");
const action = (page: Page, name: string) => page.locator(".popup__actions").getByRole("button", { name });
const submit = (page: Page) => page.locator(".sheet__foot .btn--primary");

async function open(): Promise<Page> {
  const page = await openPopup(context, extensionId);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  return page;
}

beforeAll(async () => {
  world = await createWorld();
  ({ context, extensionId } = await world.launch());
  popup = await open();
  await configure(popup, world);
});

afterAll(async () => {
  await world?.close();
});

test("connect and unlock: one wallet, the same signature twice, the connect page closes itself", async () => {
  await expect(popup.getByText("Your wallet is public.")).toBeVisible();
  await expect(popup.locator(".caution-band")).toContainText("Test SOL only");
  await shot(popup, "01-welcome");

  await popup.getByRole("button", { name: "Connect wallet" }).click();
  const wallet = popup.getByRole("button", { name: /Test Wallet/ });
  await expect(wallet).toBeVisible();
  await expect(sheet(popup)).toContainText("Never sign this message for a website");
  // The sheet says where the wallet will be asked: the connect page, host and path.
  await expect(sheet(popup).locator(".connect-place")).toHaveText(new URL(world.urls.connect).host + "/connect.html");
  await shot(popup, "02-connect-choose");
  await wallet.click();

  // The wallet connects and signs twice on the connect page; then the first sync runs.
  await expect(balance(popup)).toHaveAttribute("aria-label", "0.000", { timeout: 45_000 });
  await expect(popup.locator(".address-chip")).toContainText("Test Wallet");
  // The connect tab was opened in the background and is gone again.
  for (let i = 0; i < 100 && context.pages().some((page) => page.url().startsWith(world.urls.connect)); i++) await popup.waitForTimeout(100);
  expect(context.pages().filter((page) => page.url().startsWith(world.urls.connect))).toEqual([]);
});

test("home after sync: the public balance is read live, shielded balance as a sounding, the empty state", async () => {
  // The open popup reads the public balance by itself, and again when the control is pressed.
  await expect(popup.locator(".balance--public .figure")).toHaveText("12.000");
  await expect(popup.locator(".balance--public .link--quiet")).toContainText(/^at \d\d:\d\d$/);
  const reads = () => world.chain.calls.filter((method) => method === "getBalance").length;
  const before = reads();
  expect(before).toBeGreaterThan(0);
  await popup.locator(".balance--public .link--quiet").click();
  await expect.poll(reads).toBeGreaterThan(before);
  await expect(popup.locator(".balance--shielded .link--quiet").first()).toContainText("Synced");
  await expect(popup.getByText("Nothing in the Loch yet.")).toBeVisible();
  await expect(popup.getByText("No activity yet")).toBeVisible();
  await expect(action(popup, "Send privately")).toBeDisabled();
  // Since 0.1.4 the home view has no legend; the full activity list keeps one.
  await expect(popup.locator(".legend")).toHaveCount(0);
  // The popup is exactly 380 x 600 and nothing overflows it.
  expect(await popup.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight])).toEqual([380, 600]);
  // The body is set in the design system's sans at the popup's size. (Chrome gives extension
  // pages a stylesheet of its own, a system font at 75%; the design system holds its font against it.)
  const body = await popup.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { family: style.fontFamily, size: style.fontSize };
  });
  expect(body.family).toContain("Libre Franklin");
  expect(body.size).toBe("14px");
  await shot(popup, "03-home-empty");
});

test("keyboard: every control is reachable, shows the focus ring, and Escape closes a sheet", async () => {
  const focused = () => popup.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? "");
  const seen: string[] = [];
  await popup.locator("body").click({ position: { x: 190, y: 580 } });
  for (let i = 0; i < 12; i++) {
    await popup.keyboard.press("Tab");
    seen.push(await focused());
  }
  // The wallet chip, settings, the public balance's own control, the leak report, sync, the first action: in reading order.
  expect(seen.join(" | ")).toMatch(/Test Wallet.*at \d\d:\d\d.*Scan.*Synced.*Dive in/s);
  while ((await focused()) !== "Dive in") await popup.keyboard.press("Tab");
  // The focus ring: 2px, drawn outside the control.
  const ring = await popup.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return [style.outlineStyle, style.outlineWidth, style.outlineOffset];
  });
  expect(ring).toEqual(["solid", "2px", "2px"]);
  await popup.keyboard.press("Enter");
  await expect(sheet(popup)).toBeVisible();
  // The amount field gets the focus (once the sheet has arrived), and the focus stays inside the sheet.
  await expect(popup.locator("#dive-amount")).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await popup.keyboard.press("Tab");
    expect(await popup.evaluate(() => document.activeElement?.closest(".sheet") !== null)).toBe(true);
  }
  await popup.keyboard.press("Escape");
  await expect(sheet(popup)).not.toBeVisible();
});

test("dive in: proof, screening, the wallet's signature, confirmation", async () => {
  await action(popup, "Dive in").click();
  await popup.locator("#dive-amount").fill("2");
  await expect(sheet(popup)).toContainText("An observer sees");
  await expect(sheet(popup)).toContainText("The pool takes at most");
  await expect(submit(popup)).not.toHaveAttribute("aria-disabled", "true");
  await shot(popup, "04-dive-form");
  await submit(popup).click();
  await expect(sheet(popup).locator(".progress")).toBeVisible();
  await expect(sheet(popup)).toContainText("Diving in");
  await shot(popup, "05-dive-progress");

  await expect(popup.locator(".toast")).toContainText("Dived in. 2.000 SOL is in the Loch.", { timeout: 90_000 });
  await expect(balance(popup)).toHaveAttribute("aria-label", "2.000");
  await expect(popup.locator(".activity__row").first()).toContainText("Dived in");
  await expect(popup.locator(".activity__row").first()).toHaveClass(/is-public/);
  // On the mock chain: the vault holds its rent and the deposit, to the lamport.
  expect(world.chain.balance(vaultPda())).toBe(890_880n + 2n * SOL);
  expect(world.screener.requests).toContain("/v1/screen");
  await shot(popup, "06-home-after-dive");
});

test("send privately: a real proof made inside the extension, relayed, confirmed", async () => {
  await action(popup, "Send privately").click();
  await popup.locator("#send-to").fill("not an address");
  await expect(popup.locator("#send-to-error")).toContainText("This is not a shielded address");
  await popup.locator("#send-to").fill(world.friend);
  await popup.locator("#send-amount").fill("0.5");
  await expect(sheet(popup)).toContainText("Fee");
  await expect(sheet(popup)).toContainText("0.0025");
  await expect(submit(popup)).not.toHaveAttribute("aria-disabled", "true");
  await shot(popup, "07-send-form");
  await submit(popup).click();

  await expect(sheet(popup)).toContainText("Sending privately");
  await expect(sheet(popup).locator(".progress__stages [aria-current='step']")).toHaveText("Proving", { timeout: 20_000 });
  await shot(popup, "08-send-proving");
  await expect(popup.locator(".toast")).toContainText("Sent privately.", { timeout: 90_000 });

  // 2 - 0.5 - 0.0025 = 1.4975, shown cut, never rounded up.
  await expect(balance(popup)).toHaveAttribute("aria-label", "1.497");
  const row = popup.locator(".activity__row").first();
  await expect(row).toContainText("Sent privately");
  await expect(row).toHaveClass(/is-shielded/);
  // The relayer verified the proof against the real verification key before sending, and so did the chain.
  expect(world.relayer.sent).toHaveLength(1);
  const relayed = world.chain.transactions.at(-1)!;
  expect(relayed.accounts).not.toContain(world.wallet.publicKey.toBase58());
});

test("a send that fails: the relayer does not answer, the notes stay reserved, the proof is kept, try again works", async () => {
  world.relayer.downMs = 2_000;
  world.relayer.script.push("drop");
  await action(popup, "Send privately").click();
  await popup.locator("#send-to").fill(world.friend);
  await popup.locator("#send-amount").fill("0.25");
  await expect(submit(popup)).not.toHaveAttribute("aria-disabled", "true");
  await submit(popup).click();

  // The request had left when the connection broke: the sheet does not claim that nothing was sent.
  await expect(sheet(popup).locator(".failure__title")).toHaveText(/The relayer (could not be reached|did not answer)/, { timeout: 60_000 });
  await expect(sheet(popup)).toContainText("Loch cannot tell whether the request arrived");
  await expect(sheet(popup)).toContainText("stay reserved");
  await expect(sheet(popup)).toContainText("the same notes are spent, so it cannot be paid twice");
  await expect(sheet(popup)).toContainText("The proof is kept, so it will not take as long.");
  await expect(sheet(popup)).not.toContainText("Nothing was sent");
  await expect(sheet(popup).locator(".progress")).toHaveAttribute("data-state", "failed");
  expect(world.relayer.sent).toHaveLength(1);
  // Nothing overflows the popup with the longer explanation.
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBe(380);
  await shot(popup, "09-send-failed");

  await popup.waitForTimeout(2_000);
  const proofsBefore = world.relayer.requests.filter((request) => request.path === "/v1/relay").length;
  await sheet(popup).getByRole("button", { name: "Try again" }).click();
  await expect(popup.locator(".toast")).toContainText("Sent privately.", { timeout: 60_000 });
  // The same proof was sent again: one more relay request, and the relayer verified and sent it.
  expect(world.relayer.requests.filter((request) => request.path === "/v1/relay").length).toBe(proofsBefore + 1);
  expect(world.relayer.sent).toHaveLength(2);
  // 1.4975 - 0.25 - 0.0025 = 1.245
  await expect(balance(popup)).toHaveAttribute("aria-label", "1.245");
  // One row for it, confirmed.
  await expect(popup.locator(".activity__row").first()).toContainText("Sent privately");
  await expect(popup.locator(".activity__row").first()).not.toContainText("Outcome not known yet");
});

test("surface: warnings that it points back at the deposit, then the withdrawal", async () => {
  const destination = Keypair.generate().publicKey;
  await action(popup, "Surface").click();
  await popup.locator("#surface-to").fill(world.friend);
  await expect(popup.locator("#surface-to-error")).toContainText("That is a shielded address");
  await popup.locator("#surface-to").fill(destination.toBase58());
  await popup.locator("#surface-amount").fill("0.0001");
  await expect(popup.locator("#surface-amount-error")).toContainText("Surface at least");
  await popup.locator("#surface-amount").fill("0.3");
  // The dive-in was minutes ago: surfacing now points back at it.
  await expect(sheet(popup)).toContainText("This points back at your deposit");
  await expect(sheet(popup)).toContainText("It comes soon after it");
  await expect(submit(popup)).toHaveText("Surface anyway");
  await shot(popup, "10-surface-form");
  await submit(popup).click();
  await expect(popup.locator(".toast")).toContainText("Surfaced.", { timeout: 90_000 });

  expect(world.chain.balance(destination)).toBe((3n * SOL) / 10n);
  // 1.245 - 0.3 - 0.0025 = 0.9425
  await expect(balance(popup)).toHaveAttribute("aria-label", "0.942");
  const row = popup.locator(".activity__row").first();
  await expect(row).toContainText("Surfaced");
  await expect(row).toHaveClass(/is-public/);
  await shot(popup, "11-home-after-surface");

  await popup.getByRole("link", { name: "All activity" }).click();
  await popup.locator(".activity--full button").first().click();
  await expect(popup.locator(".activity__detail")).toContainText("An observer sees the destination");
  await shot(popup, "12-activity");
  await popup.getByRole("link", { name: "Close" }).click();
});

test("leak report: scan with progress, score, stepped bed, statement, cached", async () => {
  const now = Math.floor(Date.now() / 1000);
  const funder = Keypair.generate().publicKey.toBase58();
  // The address the fixture site will ask to pay: the wallet has paid it five times before.
  const regular = world.fixture.recipient;
  world.chain.seedTransfers(world.wallet.publicKey.toBase58(), [
    { dir: "in", counterparty: funder, sol: 12, time: now - 9 * 86_400 },
    ...Array.from({ length: 5 }, (_, i) => ({ dir: "out" as const, counterparty: regular, sol: 0.1 + i / 100, time: now - (8 - i) * 86_400 })),
    ...Array.from({ length: 6 }, (_, i) => ({ dir: "out" as const, counterparty: Keypair.generate().publicKey.toBase58(), sol: 0.05, time: now - i * 3600 - 7200 })),
  ]);

  await popup.locator("a.score").click();
  await expect(popup.getByText("No scan yet")).toBeVisible();
  await expect(popup.locator(".popup__view")).toContainText("learns which address you looked at");
  await popup.getByRole("button", { name: "Scan this wallet" }).click();
  await expect(popup.locator("svg.lc-bed")).toBeVisible({ timeout: 60_000 });
  await expect(popup.locator(".statement__row--total")).toContainText("of 100");
  await expect(popup.locator(".statement")).toContainText("Funding source is public");
  await expect(popup.locator(".statement")).toContainText("Recurring counterparties");
  const score = await popup.locator(".statement__row--total .statement__fig").innerText();
  await shot(popup, "13-leak-report");
  await popup.getByRole("link", { name: "Close" }).click();
  // The score is on land now: it is public.
  await expect(popup.locator(".score .figure")).toHaveText(score.match(/\d+/)![0]);
});

test("the wrapper on a website: the key-derivation guard and the leak warnings", async () => {
  const site = await context.newPage();
  await site.setViewportSize({ width: 1000, height: 720 });
  // The site has a strict Content-Security-Policy (e2e/env.ts). Everything it reports is kept.
  const siteProblems: string[] = [];
  site.on("console", (message) => {
    if (message.type() === "error") siteProblems.push(message.text());
  });
  await site.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  await site.goto(`${world.urls.dapp}?wallet=Loch`);
  await expect(site.locator("#wallets")).toContainText("Loch");
  await expect(site.locator("#wallets")).toContainText("Test Wallet");
  const result = async (count: number) => {
    await expect(site.locator("body")).toHaveAttribute("data-done", String(count), { timeout: 20_000 });
    return site.evaluate(() => (window as unknown as { __results: { label: string; ok: boolean; error?: string; value?: unknown; code?: number }[] }).__results.at(-1)!);
  };
  const log = () => site.evaluate(() => window.__mockWallet.log);
  const dialog = site.locator("loch-dialog");

  await site.locator("#connect").click();
  expect(await result(1)).toMatchObject({ ok: true, value: [world.wallet.publicKey.toBase58()] });

  // 1. The key-derivation message is not passed on, and the real wallet never sees it.
  await site.locator("#sign-derivation").click();
  expect(await result(2)).toMatchObject({ ok: false, code: 4001 });
  expect((await result(2)).error).toContain("Loch did not pass this request on");
  await expect(dialog).toBeAttached();
  await shot(site, "14-wrapper-blocked");
  await site.keyboard.press("Enter");
  await expect(dialog).not.toBeAttached();
  await site.locator("#sign-hidden").click();
  expect((await result(3)).error).toContain("Loch did not pass this request on");
  await expect(dialog).toBeAttached();
  await site.keyboard.press("Escape");
  await expect(dialog).not.toBeAttached();
  expect((await log()).filter((entry) => entry.method === "signMessage")).toEqual([]);

  // Any other message goes to the wallet, byte for byte.
  await site.locator("#sign-hello").click();
  expect(await result(4)).toMatchObject({ ok: true });
  expect((await log()).at(-1)).toEqual({ method: "signMessage", payload: Buffer.from("hello").toString("base64") });
  await expect(dialog).not.toBeAttached();

  // 2. A plain transfer to an address the wallet pays again and again: a warning, with a choice.
  await site.locator("#sign-transfer").click();
  await expect(dialog).toBeAttached({ timeout: 15_000 });
  await shot(site, "15-wrapper-warning");
  await site.keyboard.press("Escape");
  expect(await result(5)).toMatchObject({ ok: false, error: "Cancelled in Loch before signing.", code: 4001 });
  expect((await log()).filter((entry) => entry.method === "signTransaction")).toEqual([]);

  // "Send anyway" hands the wallet exactly the bytes the site passed in.
  await site.locator("#sign-transfer").click();
  await expect(dialog).toBeAttached({ timeout: 15_000 });
  await site.keyboard.press("Shift+Tab");
  await site.keyboard.press("Enter");
  expect(await result(6)).toMatchObject({ ok: true });
  expect((await log()).at(-1)).toEqual({ method: "signTransaction", payload: world.fixture.transfer });

  // A transaction with no transfer, and bytes that are no transaction at all: straight through, no dialog.
  await site.locator("#sign-memo").click();
  expect(await result(7)).toMatchObject({ ok: true });
  expect((await log()).at(-1)).toEqual({ method: "signTransaction", payload: world.fixture.memo });
  await site.locator("#sign-garbage").click();
  await result(8);
  expect((await log()).at(-1)).toEqual({ method: "signTransaction", payload: world.fixture.garbage });
  await expect(dialog).not.toBeAttached();

  // 3. A first payment to a new address does not interrupt: that is nearly every payment.
  await site.locator("#sign-transfer-new").click();
  expect(await result(9)).toMatchObject({ ok: true });
  expect((await log()).at(-1)).toEqual({ method: "signTransaction", payload: world.fixture.transferNew });
  await expect(dialog).not.toBeAttached();
  // Unless the user asked to be warned about those too.
  await popup.evaluate(() => chrome.runtime.sendMessage({ loch: "ui", type: "settings", patch: { warnFirstRecipients: true } }));
  await site.locator("#sign-transfer-new").click();
  await expect(dialog).toBeAttached({ timeout: 15_000 });
  await shot(site, "15a-wrapper-warning-first-recipient");
  await site.keyboard.press("Escape");
  expect(await result(10)).toMatchObject({ ok: false, error: "Cancelled in Loch before signing." });
  await popup.evaluate(() => chrome.runtime.sendMessage({ loch: "ui", type: "settings", patch: { warnFirstRecipients: false } }));

  // The page cannot reach the extension's state: nothing of it is in the page's world.
  expect(await site.evaluate(() => typeof (globalThis as { chrome?: { storage?: unknown } }).chrome?.storage)).toBe("undefined");
  // Both dialogs were drawn on a page that forbids inline styles: no violation, and they were styled
  // (the screenshots above show them).
  expect(await site.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
  expect(siteProblems).toEqual([]);
  await site.close();
});

test("with the wrapper off, no wallet named Loch is registered", async () => {
  await popup.evaluate(() => chrome.runtime.sendMessage({ loch: "ui", type: "settings", patch: { wrapperEnabled: false } }));
  const site = await context.newPage();
  await site.goto(`${world.urls.dapp}?wallet=Loch`);
  await expect(site.locator("#wallets")).toContainText("Test Wallet");
  await site.waitForTimeout(500);
  await expect(site.locator("#wallets")).not.toContainText("Loch");
  await site.close();
  await popup.evaluate(() => chrome.runtime.sendMessage({ loch: "ui", type: "settings", patch: { wrapperEnabled: true } }));
});

test("the expanded view: the same app in a tab, both columns under one waterline", async () => {
  const tab = await context.newPage();
  // Console errors of the expanded view count too: a Content-Security-Policy violation is one.
  tab.on("pageerror", (error) => pageErrors.push(error.message));
  tab.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await tab.setViewportSize({ width: 1280, height: 800 });
  await tab.goto(`chrome-extension://${extensionId}/app.html`);
  await expect(tab.locator(".wide")).toBeVisible();
  await expect(tab.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await expect(tab.locator(".wide__panel .activity--full")).toBeVisible();
  await expect(tab.locator(".wide__column .receive__address")).toContainText("loch1");
  await shot(tab, "16-expanded");
  await tab.getByRole("tab", { name: "Leak report" }).click();
  await expect(tab.locator(".wide__panel svg.lc-bed")).toBeVisible();
  await shot(tab, "17-expanded-report");
  await tab.close();
});

test("the night palette, from settings", async () => {
  await popup.getByRole("button", { name: "Settings", exact: true }).click();
  await popup.getByRole("radio", { name: "Night" }).click();
  await expect(popup.locator("html")).toHaveAttribute("data-theme", "night");
  await popup.getByRole("link", { name: "Close" }).click();
  await shot(popup, "18-home-night");
  await popup.evaluate(() => chrome.runtime.sendMessage({ loch: "ui", type: "settings", patch: { theme: "dusk" } }));
});

test("a new browser session: locked, then unlocked with the one signature, the encrypted state restored", async () => {
  const onDisk = await popup.evaluate(() => chrome.storage.local.get(null));
  // What is on disk: settings, the wallet's address, and sealed records.
  const text = JSON.stringify(onDisk);
  expect(text).not.toContain(world.friend);
  expect(text).not.toContain('"kind"');
  expect(Object.keys(onDisk).filter((key) => key.startsWith("vault:")).map((key) => key.split(":")[2]).sort()).toEqual(["activity", "records", "scan", "state"]);

  await context.close();
  ({ context, extensionId } = await world.launch());
  popup = await open();
  await expect(popup.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(popup.getByText("Locked. One signature from Test Wallet unlocks it.")).toBeVisible();
  expect(Object.keys(await popup.evaluate(() => chrome.storage.session.get(null))).filter((key) => key.startsWith("secret:"))).toEqual([]);
  await shot(popup, "19-locked");

  // The connect page has no script of its own. With the night palette chosen in Loch, the
  // extension's content script sets data-theme="night" on that page's root, while the tab is open.
  await popup.evaluate(() => chrome.runtime.sendMessage({ loch: "ui", type: "settings", patch: { theme: "night" } }));
  const connectTab = context.waitForEvent("page", { predicate: (page) => page.url().startsWith(world.urls.connect) || page.url() === "about:blank", timeout: 30_000 });
  await popup.getByRole("button", { name: "Unlock" }).click();
  const connectPage = await connectTab;
  await connectPage.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "night", null, { timeout: 15_000 });
  expect(connectPage.url()).toBe(world.urls.connect);
  await expect(balance(popup)).toHaveAttribute("aria-label", "0.942", { timeout: 45_000 });
  await popup.evaluate(() => chrome.runtime.sendMessage({ loch: "ui", type: "settings", patch: { theme: "dusk" } }));
  const titles = await popup.locator(".activity__title").allInnerTexts();
  expect(titles).toEqual(["Surfaced", "Sent privately", "Sent privately", "Dived in"]);
  // The cached leak report came back with it.
  await expect(popup.locator(".score .figure")).toBeVisible();
});

test("forget this wallet on this device: everything about it is wiped", async () => {
  const address = world.wallet.publicKey.toBase58();
  await popup.getByRole("button", { name: "Settings", exact: true }).click();
  await popup.getByRole("button", { name: /^Advanced/ }).click();
  await popup.getByRole("button", { name: "Forget this wallet on this device" }).click();
  await expect(popup.getByText(/Forget .* on this device\?/)).toBeVisible();
  await popup.getByRole("button", { name: "Forget this wallet", exact: true }).click();
  await expect(popup.getByText("Your wallet is public.")).toBeVisible();
  const stored = await popup.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  expect(JSON.stringify(stored)).not.toContain(address);
  expect(Object.keys(stored.local).sort()).toEqual(["settings", "wallets"]);
  expect(stored.local.wallets).toEqual([]);
});

test("zero telemetry: the extension asked for nothing but the configured endpoints", async () => {
  const origins = [world.urls.rpc, world.urls.relayer, world.urls.screener].map((url) => new URL(url).origin);
  // 1. What the extension's service worker and pages requested, as the browser reported it.
  const outside = world.extensionRequests.filter((url) => !url.startsWith("chrome-extension://") && !url.startsWith("data:"));
  expect(outside.length).toBeGreaterThan(0);
  expect([...new Set(outside.map((url) => new URL(url).origin))].sort()).toEqual([...origins].sort());

  // 2. What left the browser at all, through the proxy every request was forced through. Apart
  //    from this machine, only Chromium's own services appear (update checks, sign-in), which it
  //    contacts with or without the extension; the proxy refused them all.
  const fixtures = [world.urls.connect, world.urls.dapp].map((url) => new URL(url).host);
  const allowed = new Set([...origins.map((origin) => new URL(origin).host), ...fixtures]);
  const others = [...new Set(world.hosts)].filter((host) => !allowed.has(host));
  const browserOwn = /^(clients\d*|accounts|www|update|android\.clients|optimizationguide-pa|safebrowsing|content-autofill)\.(google|googleapis)\.com(:443)?$/;
  expect(others.filter((host) => !browserOwn.test(host))).toEqual([]);
  expect(pageErrors).toEqual([]);
});
