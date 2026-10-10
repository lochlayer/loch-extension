// Regression tests for the security review's money findings, in the browser, with REAL Groth16
// proofs made in the extension's offscreen document and verified by the mock relayer and the
// mock chain against the real verification key. Adapted from the reviewer's demonstration
// (extsec-review/browser/money.spec.ts), where the destination received 1,000,000,000 lamports
// for a withdrawal of 500,000,000.
//
//   finding 1   "Try again" spends the same note again, so a relayer that kept both requests
//               can land only one of them
//   finding 4   a relayer that answers with a made-up signature does not get "Surfaced."

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { base58 } from "@scure/base";
import { type BrowserContext, type Page, expect as playwrightExpect } from "@playwright/test";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, test } from "vitest";

import { SHOTS_DIR, SOL, type World, configure, createWorld, openPopup } from "./env.js";

const expect = playwrightExpect.configure({ timeout: 30_000 });

type Relay = { inputNullifiers: string[]; extData: { fee: string; recipient: string; extAmount: string } };
type View = {
  flow: { status: string; step: string; proofKept: boolean; bound: boolean; failure?: { code: string; moved: string; retry: boolean } } | null;
  shielded: { balance: string; settling: number; notes: number; spendable: string };
  activity: { kind: string; status: string; signature?: string; fee?: string }[];
};

let world: World;
let context: BrowserContext;
let popup: Page;
let hostile: Server;

// The hostile relayer's behaviour, set by the tests. It sits in front of the honest mock, which
// stands for "it could submit whenever it likes".
const relayer = {
  mode: "honest" as "honest" | "keep-and-say-unavailable" | "fake-success",
  infoCalls: 0,
  /** Quote one lamport less on this call of GET /v1/info (counted from the last reset). */
  cheaperOnCall: -1,
  kept: [] as Relay[],
  fakeSignature: base58.encode(new Uint8Array(64).fill(9)),
};

const ui = (request: Record<string, unknown>) => popup.evaluate((r) => chrome.runtime.sendMessage(r), request) as Promise<{ ok: boolean; value?: never }>;
const state = async () => (await ui({ loch: "ui", type: "state" })).value as unknown as View;
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const idle = (s: View) => s.flow === null || s.flow.status === "done";

beforeAll(async () => {
  world = await createWorld();
  const fee = world.relayer.feeLamports;
  hostile = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    const path = new URL(request.url ?? "/", "http://x").pathname;
    const send = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (request.method === "GET" && path === "/v1/info") {
      relayer.infoCalls++;
      const info = { ...((await world.relayer.handle("GET", "/v1/info", undefined)).body as Record<string, unknown>) };
      if (relayer.infoCalls === relayer.cheaperOnCall) info.feeLamports = (fee - 1n).toString();
      return void send(200, info);
    }
    if (request.method === "POST" && path === "/v1/relay") {
      if (relayer.mode === "keep-and-say-unavailable") {
        relayer.kept.push(body as Relay);
        return void send(503, { error: { code: "unavailable", message: "try again later" } });
      }
      if (relayer.mode === "fake-success") return void send(200, { signature: relayer.fakeSignature });
      const real = await world.relayer.handle("POST", "/v1/relay", body);
      return void send(real.status, real.body);
    }
    send(404, { error: { code: "not_found", message: "unknown path" } });
  });
  await new Promise<void>((resolve) => hostile.listen(0, "127.0.0.1", () => resolve()));
  const hostileUrl = `http://127.0.0.1:${(hostile.address() as AddressInfo).port}`;

  const launched = await world.launch();
  context = launched.context;
  popup = await openPopup(context, launched.extensionId);
  await configure(popup, { urls: { ...world.urls, relayer: hostileUrl } });
});

afterAll(async () => {
  await world?.close();
  hostile?.closeAllConnections();
  hostile?.close();
});

test("setup: connect, two deposits of 1 SOL (two notes)", async () => {
  await popup.getByRole("button", { name: "Connect wallet" }).click();
  const wallet = popup.getByRole("button", { name: /Test Wallet/ });
  await wallet.waitFor({ timeout: 30_000 });
  await wallet.click();
  await until(state, (s) => s.shielded !== null && idle(s), 60_000);
  await ui({ loch: "ui", type: "flow-dismiss" });
  for (const expected of [SOL, 2n * SOL]) {
    expect((await ui({ loch: "ui", type: "dive", amount: SOL.toString() })).ok).toBe(true);
    await until(state, (s) => s.shielded?.balance === expected.toString() || s.flow?.status === "failed");
    await until(state, idle, 20_000);
    await ui({ loch: "ui", type: "flow-dismiss" });
  }
  expect((await state()).shielded.notes).toBe(2);
});

test("finding 1, with real proofs: 'Try again' proves with the SAME note; the relayer keeps both requests and can land only one", async () => {
  const destination = Keypair.generate().publicKey;
  const fee = world.relayer.feeLamports;

  relayer.mode = "keep-and-say-unavailable";
  relayer.infoCalls = 0;
  // Counted from here: the flow's "checking" (the agreed fee) and then "proving" (one lamport less).
  relayer.cheaperOnCall = 2;
  expect((await ui({ loch: "ui", type: "surface", to: destination.toBase58(), amount: (SOL / 2n).toString(), fee: fee.toString() })).ok).toBe(true);
  const failed = await until(state, (s) => s.flow?.status === "failed");
  expect(failed.flow).toMatchObject({ proofKept: true, bound: true, failure: { code: "relayer-unavailable", moved: "unknown", retry: true } });
  expect(relayer.kept).toHaveLength(1);

  // What the sheet says now: what is known, and that the notes stay reserved.
  const sheet = popup.locator(".sheet");
  await expect(sheet.locator(".failure__title")).toHaveText("The relayer says it cannot send right now");
  await expect(sheet).toContainText("The relayer says it did not send it, and the chain does not show it.");
  await expect(sheet).toContainText("stay reserved");
  await expect(sheet).toContainText("choose another relayer in settings and try again here");
  await expect(sheet).not.toContainText("Nothing was sent");
  expect(await popup.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight])).toEqual([380, 600]);
  // The toast of the dive in the setup sits over the sheet's buttons for a few seconds.
  await expect(popup.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: join(SHOTS_DIR, "e2e-21-relayer-says-not-sent.png") });
  // The balance already counts it, one transfer is "still settling", and the list has it as unknown.
  expect(failed.shielded).toMatchObject({ balance: (2n * SOL - SOL / 2n - (fee - 1n)).toString(), settling: 1, spendable: SOL.toString() });
  expect(failed.activity[0]).toMatchObject({ kind: "surface", status: "unknown" });

  // The user presses "Try again" (the button the sheet offers).
  await sheet.getByRole("button", { name: "Try again" }).click();
  await until(async () => relayer.kept.length, (count) => count >= 2, 120_000);
  const [first, second] = relayer.kept as [Relay, Relay];
  expect([first.extData.fee, second.extData.fee]).toEqual([(fee - 1n).toString(), fee.toString()]);
  expect(first.extData.recipient).toBe(second.extData.recipient);
  // Two different proofs that spend the same note: one nullifier in common. Before the fix: none.
  expect(first.inputNullifiers.filter((nullifier) => second.inputNullifiers.includes(nullifier))).toHaveLength(1);
  await until(state, (s) => s.flow?.status === "failed", 60_000);

  // The relayer sends both. Its own checks (the real verification key) pass both; the chain takes one.
  world.relayer.feeLamports = fee - 1n;
  const r1 = await world.relayer.handle("POST", "/v1/relay", first);
  const r2 = await world.relayer.handle("POST", "/v1/relay", second);
  world.relayer.feeLamports = fee;
  expect(r1.status).toBe(200);
  expect(r2).toMatchObject({ status: 409, body: { error: { code: "nullifier_spent" } } });
  // Before the fix: 1,000,000,000 lamports for a withdrawal of 500,000,000.
  expect(world.chain.balance(destination)).toBe(SOL / 2n);

  relayer.mode = "honest";
  relayer.cheaperOnCall = -1;
  await ui({ loch: "ui", type: "sync" });
  const settled = await until(state, (s) => s.shielded.settling === 0 && idle(s), 60_000);
  // Paid once: the amount and the fee of the proof that landed.
  expect(settled.shielded.balance).toBe((2n * SOL - SOL / 2n - (fee - 1n)).toString());
  expect(settled.activity[0]).toMatchObject({ kind: "surface", status: "confirmed", fee: (fee - 1n).toString() });
  // The sheet that said "not sent" has given way to the toast: the chain showed the transfer.
  await expect(popup.locator(".sheet")).toHaveCount(0);
  await ui({ loch: "ui", type: "flow-dismiss" });
});

test("finding 4: a relayer that answers with a made-up signature gets no 'Surfaced.' and no confirmed row", async () => {
  const before = await until(state, (s) => s.flow === null && s.shielded.settling === 0, 60_000);
  // The toast of the withdrawal above ("Surfaced. 0.500 SOL ...") has to be gone first.
  await expect(popup.locator(".toast")).toHaveCount(0, { timeout: 15_000 });
  const destination = Keypair.generate().publicKey;
  const fee = world.relayer.feeLamports;
  relayer.mode = "fake-success";
  const toasts: string[] = [];
  const poll = setInterval(() => {
    void popup
      .locator(".toast")
      .allInnerTexts()
      .then((texts) => texts.forEach((text) => toasts.includes(text) || toasts.push(text)))
      .catch(() => undefined);
  }, 150);
  expect((await ui({ loch: "ui", type: "surface", to: destination.toBase58(), amount: (SOL / 10n).toString(), fee: fee.toString() })).ok).toBe(true);
  // While the chain is being asked, the sheet says so.
  await expect(popup.locator(".sheet .progress__status")).toContainText("The relayer says it is sent. Looking for it on the chain.", { timeout: 60_000 });
  const failed = await until(state, (s) => s.flow?.status === "failed", 120_000);
  clearInterval(poll);
  // Before the fix: the flow was done, the toast said "Surfaced.", and the row was confirmed with the made-up id.
  expect(failed.flow?.failure).toMatchObject({ code: "relayer-unconfirmed", moved: "unknown", retry: true });
  expect(toasts.filter((text) => text.includes("Surfaced"))).toEqual([]);
  expect(failed.activity[0]).toMatchObject({ kind: "surface", status: "unknown" });
  expect(JSON.stringify(failed.activity)).not.toContain(relayer.fakeSignature);
  expect(world.chain.balance(destination)).toBe(0n);
  // The note stays reserved: the request is out there and is valid.
  expect(failed.shielded.settling).toBe(1);
  expect(BigInt(failed.shielded.balance)).toBe(BigInt(before.shielded.balance) - SOL / 10n - fee);

  const sheet = popup.locator(".sheet");
  await expect(sheet.locator(".failure__title")).toHaveText("The chain does not show the transfer");
  await expect(sheet).toContainText("Loch does not count it as done");
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: join(SHOTS_DIR, "e2e-22-chain-does-not-show-it.png") });
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(popup.locator(".activity__row").first()).toContainText("Surfaced");
  await expect(popup.locator(".activity__row").first()).toContainText("Outcome not known yet");
  await popup.screenshot({ path: join(SHOTS_DIR, "e2e-23-outcome-not-known.png") });
});
