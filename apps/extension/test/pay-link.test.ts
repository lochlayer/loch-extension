// The pay link: one payment code of the wallet's own after lochlayer.com/pay/, the same each time
// until a new one is asked for, and what is paid to it shown as paid to the link.

import { decodePaymentCode, encodeShieldedAddress, paymentCodeCounts } from "@loch/sdk";
import { describe, expect, it } from "vitest";

import { entriesForReceived } from "../src/background/activity.js";
import { handleUi, parseUiRequest } from "../src/background/router.js";
import { syncWalletNow } from "../src/background/sync.js";
import { PAY_LINK_COPY, activityTitle } from "../src/shared/copy.js";
import type { PayLinkReply, Snapshot } from "../src/shared/view.js";
import { type Harness, createHarness, settle } from "./harness.js";
import { connect, dive, fund, shielded } from "./steps.js";

const SOL = 1_000_000_000n;
const FEE = 2_500_000n;

async function ui<T>(h: Harness, request: Record<string, unknown>): Promise<T> {
  const reply = await handleUi(h.core, { loch: "ui", ...request });
  if (!reply.ok) throw new Error(`${String(request.type)}: ${reply.error.code}`);
  return reply.value as T;
}

const payLink = (h: Harness, action: "show" | "make" | "new") => ui<PayLinkReply | null>(h, { type: "pay-link", action });
const runtime = async (h: Harness) => (await h.core.store.runtime(h.wallet.address))!;

describe("pay link", () => {
  it("is made once and then the same every time, across a restart", async () => {
    const h = createHarness();
    await connect(h);
    expect(await payLink(h, "show")).toBeNull();
    const made = (await payLink(h, "make"))!;
    expect(made.status).toBe("made");
    expect(made.code).toMatch(/^lochpay1[a-z0-9]{160}$/);
    expect(made.link).toBe(`https://lochlayer.com/pay/${made.code}`);
    expect(encodeShieldedAddress(decodePaymentCode(made.code))).toBe((await shielded(h)).address);

    expect(await payLink(h, "show")).toEqual({ ...made, status: "kept" });
    expect(await payLink(h, "make")).toEqual({ ...made, status: "kept" });
    expect(paymentCodeCounts((await runtime(h)).state).issued).toBe(1);

    const again = h.restart();
    expect(await payLink(again, "show")).toEqual({ ...made, status: "kept" });
  });

  it("a new link is a fresh code, and the old one is still counted", async () => {
    const h = createHarness();
    await connect(h);
    const first = (await payLink(h, "make"))!;
    const second = (await payLink(h, "new"))!;
    expect(second.status).toBe("made");
    expect(second.code).not.toBe(first.code);
    expect(await payLink(h, "show")).toEqual({ ...second, status: "kept" });
    expect(paymentCodeCounts((await runtime(h)).state).issued).toBe(2);
  });

  it("after twenty unpaid codes, a new link keeps the one there is", async () => {
    const h = createHarness();
    await connect(h);
    const link = (await payLink(h, "make"))!;
    for (let i = 1; i < 20; i++) await ui(h, { type: "payment-code" });
    expect(await payLink(h, "new")).toEqual({ ...link, status: "limit" });
  });

  it("what someone pays to it arrives and is shown as paid to the pay link", async () => {
    const alice = createHarness();
    await connect(alice);
    fund(alice, 20n * SOL);
    await dive(alice, 2n * SOL);
    const bob = createHarness({ shared: { ...alice, wallet: new (alice.wallet.constructor as new () => typeof alice.wallet)(), tabs: new Map(), held: [], nextTab: { id: 700 } } });
    await connect(bob);

    const { code } = (await payLink(bob, "make"))!;
    const other = await ui<{ code: string }>(bob, { type: "payment-code" });

    for (const to of [code, other.code]) {
      await ui(alice, { type: "send", to, amount: (SOL / 4n).toString(), fee: FEE.toString() });
      expect((await settle(alice)).failure).toBeUndefined();
      await alice.core.clearFlow();
    }

    await syncWalletNow(bob.core, bob.wallet.address);
    const view = await ui<Snapshot>(bob, { type: "state" });
    expect(view.shielded?.balance).toBe((SOL / 2n).toString());
    const received = view.activity.filter((entry) => entry.kind === "receive");
    expect(received).toHaveLength(2);
    expect(received.filter((entry) => entry.via === "pay-link")).toHaveLength(1);
    expect(received.map(activityTitle).sort()).toEqual(["Paid to your pay link", "Received privately"]);
  });

  it("labels only notes paid to the link's own code", () => {
    const note = (source: unknown, leafIndex: number) =>
      ({ amount: SOL, leafIndex, commitment: BigInt(leafIndex), source, publicKey: 1n, blinding: 1n, nullifier: 1n, spent: false }) as never;
    const entries = entriesForReceived({ received: [note({ code: 3 }, 1), note({ code: 4 }, 2), note("address", 3)], ownOutputs: new Set(), firstSync: false, now: 1, payLink: 3 });
    expect(entries.map((entry) => entry.via ?? null)).toEqual(["pay-link", null, null]);
    expect(entriesForReceived({ received: [note({ code: 0 }, 1)], ownOutputs: new Set(), firstSync: false, now: 1, payLink: null })[0]!.via).toBeUndefined();
  });

  it("takes only the three actions, and needs an unlocked wallet", async () => {
    for (const action of ["show", "make", "new"]) expect(parseUiRequest({ loch: "ui", type: "pay-link", action })).toEqual({ loch: "ui", type: "pay-link", action });
    expect(parseUiRequest({ loch: "ui", type: "pay-link" })).toBeNull();
    expect(parseUiRequest({ loch: "ui", type: "pay-link", action: "delete" })).toBeNull();
    const h = createHarness();
    expect(await handleUi(h.core, { loch: "ui", type: "pay-link", action: "make" })).toMatchObject({ ok: false });
  });

  it("says what the link gives away, and nothing about audits", () => {
    const text = Object.values(PAY_LINK_COPY).join(" ");
    expect(text).toMatch(/without Loch/);
    expect(text).toMatch(/same person/);
    expect(text).toMatch(/public/);
    expect(text).not.toMatch(/audit/i);
  });
});
