// Payment codes in the extension: making one, paying one, and where its secret may and may
// not go. The cryptography is tested in the SDK (packages/sdk/test/keyed-notes.test.ts).

import { decodePaymentCode, encodeShieldedAddress, openNote, paymentCodeCounts, parseEventLogs } from "@loch/sdk";
import { describe, expect, it } from "vitest";

import type { SpendRecord } from "../src/background/core.js";
import { handleUi } from "../src/background/router.js";
import { syncWalletNow } from "../src/background/sync.js";
import type { AddressCheck, PaymentCodeReply, Snapshot } from "../src/shared/view.js";
import { type Harness, createHarness, settle } from "./harness.js";
import { connect, dive, fund, shielded } from "./steps.js";

const SOL = 1_000_000_000n;
const FEE = 2_500_000n;

async function ui<T>(h: Harness, request: Record<string, unknown>): Promise<T> {
  const reply = await handleUi(h.core, { loch: "ui", ...request });
  if (!reply.ok) throw new Error(`${String(request.type)}: ${reply.error.code}`);
  return reply.value as T;
}

const makeCode = (h: Harness) => ui<PaymentCodeReply>(h, { type: "payment-code" });
const check = (h: Harness, kind: "shielded" | "public", text: string) => ui<AddressCheck>(h, { type: "check-address", kind, text });

/** Alice with a balance, and Bob on the same chain with nothing. */
async function pair(): Promise<{ alice: Harness; bob: Harness }> {
  const alice = createHarness();
  await connect(alice);
  fund(alice, 20n * SOL);
  await dive(alice, 2n * SOL);
  const bob = createHarness({ shared: { ...alice, wallet: new (alice.wallet.constructor as new () => typeof alice.wallet)(), tabs: new Map(), held: [], nextTab: { id: 700 } } });
  await connect(bob);
  return { alice, bob };
}

describe("payment code", () => {
  it("is the wallet's address with a secret, and each one made is new and counted", async () => {
    const h = createHarness();
    await connect(h);
    const address = (await shielded(h)).address;
    const first = await makeCode(h);
    const second = await makeCode(h);
    expect(first).toMatchObject({ status: "made", made: 1 });
    expect(second).toMatchObject({ status: "made", made: 2 });
    for (const reply of [first, second]) {
      expect(reply.code).toMatch(/^lochpay1[a-z0-9]{160}$/);
      expect(encodeShieldedAddress(decodePaymentCode(reply.code))).toBe(address);
    }
    expect(decodePaymentCode(first.code).secret).not.toEqual(decodePaymentCode(second.code).secret);
    const runtime = (await h.core.store.runtime(h.wallet.address))!;
    expect(paymentCodeCounts(runtime.state)).toEqual({ issued: 2, used: 0 });
  });

  it("the count is saved: a restarted worker goes on where the last one stopped", async () => {
    const h = createHarness();
    await connect(h);
    const first = await makeCode(h);
    const again = h.restart();
    const second = await makeCode(again);
    expect(second).toMatchObject({ status: "made", made: 2 });
    expect(second.code).not.toBe(first.code);
  });

  it("a sync that ends after a code was made does not take the count back", async () => {
    const { bob } = await pair();
    const syncing = syncWalletNow(bob.core, bob.wallet.address);
    const first = await makeCode(bob);
    await syncing;
    await syncWalletNow(bob.core, bob.wallet.address);
    const second = await makeCode(bob);
    expect([first.made, second.made]).toEqual([1, 2]);
    expect(second.code).not.toBe(first.code);
  });

  it("after twenty that nobody paid, no new one is made and the newest is offered again", async () => {
    const h = createHarness();
    await connect(h);
    let last = await makeCode(h);
    for (let i = 1; i < 20; i++) last = await makeCode(h);
    expect(last).toMatchObject({ status: "made", made: 20 });
    const refused = await makeCode(h);
    expect(refused).toEqual({ status: "limit", code: last.code, made: 20 });
    expect(await makeCode(h)).toEqual(refused);
  });

  it("needs an unlocked wallet", async () => {
    const h = createHarness();
    expect(await handleUi(h.core, { loch: "ui", type: "payment-code" })).toMatchObject({ ok: false });
    await connect(h);
    await handleUi(h.core, { loch: "ui", type: "lock" });
    expect(await handleUi(h.core, { loch: "ui", type: "payment-code" })).toMatchObject({ ok: false });
    expect(await handleUi(h.core, { loch: "ui", type: "payment-code", extra: 1 })).toMatchObject({ ok: false });
  });

  it("the send form takes a code, says whose it is, and surfacing refuses one", async () => {
    const { alice, bob } = await pair();
    const bobAddress = (await shielded(bob)).address;
    const { code } = await makeCode(bob);
    expect(await check(alice, "shielded", code)).toEqual({ ok: true, address: code, own: false, code: true, payee: bobAddress });
    expect(await check(alice, "shielded", code.toUpperCase())).toMatchObject({ ok: true, address: code, code: true });
    expect(await check(alice, "shielded", bobAddress)).toEqual({ ok: true, address: bobAddress, own: false });
    expect(await check(bob, "shielded", code)).toMatchObject({ ok: true, own: true, code: true });
    expect(await check(alice, "shielded", `${code.slice(0, -1)}${code.endsWith("q") ? "p" : "q"}`)).toEqual({ ok: false, reason: "checksum" });
    expect(await check(alice, "shielded", code.slice(0, 120))).toMatchObject({ ok: false });
    expect(await check(alice, "public", code)).toEqual({ ok: false, reason: "shielded-address" });
  });

  it("paid to a code: the recipient finds it, and only the address in the code is shown or remembered", async () => {
    const { alice, bob } = await pair();
    const bobAddress = (await shielded(bob)).address;
    const { code } = await makeCode(bob);
    const secret = Buffer.from(decodePaymentCode(code).secret).toString("hex");

    await ui(alice, { type: "send", to: code, amount: (SOL / 2n).toString(), fee: FEE.toString() });
    // While it runs and when it is done, the interface is told the address, not the code.
    const running = (await ui<Snapshot>(alice, { type: "state" })).flow;
    expect(running?.to).toBe(bobAddress);
    const flow = (await settle(alice)) as SpendRecord;
    expect(flow).toMatchObject({ status: "done", kind: "send", to: code, payee: bobAddress });
    const view = await ui<Snapshot>(alice, { type: "state" });
    expect(view.flow?.to).toBe(bobAddress);
    expect(view.activity[0]).toMatchObject({ kind: "send", status: "confirmed", amount: (SOL / 2n).toString(), counterparty: bobAddress });
    expect(JSON.stringify(view)).not.toContain("lochpay1");
    expect(JSON.stringify((await alice.core.store.runtime(alice.wallet.address))!.activity)).not.toContain("lochpay1");
    // Nothing that went to the relayer or onto the chain holds the secret.
    expect(JSON.stringify(flow.request)).not.toContain(secret);

    await syncWalletNow(bob.core, bob.wallet.address);
    const bobView = await ui<Snapshot>(bob, { type: "state" });
    expect(bobView.shielded?.balance).toBe((SOL / 2n).toString());
    expect(bobView.activity).toMatchObject([{ kind: "receive", status: "confirmed", amount: (SOL / 2n).toString() }]);
    const bobRuntime = (await bob.core.store.runtime(bob.wallet.address))!;
    expect(paymentCodeCounts(bobRuntime.state)).toEqual({ issued: 1, used: 1 });

    // What is on chain: one of the two notes opens with Bob's keys and the code, and not with
    // his X25519 key alone, which is all that breaking it would give.
    const { commitments } = parseEventLogs(alice.chain.transactions.at(-1)!.logs);
    const { keys } = bobRuntime;
    const x25519Only = { publicKey: keys.publicKey, encryptionSecret: keys.encryptionSecret, encryptionPublic: keys.encryptionPublic };
    const candidates = [{ index: 0, secret: decodePaymentCode(code).secret }];
    const opened = commitments.map((event) => openNote(event.encryptedOutput, keys, event.commitment, candidates)).filter((note) => note !== null);
    expect(opened).toMatchObject([{ source: { code: 0 }, note: { amount: SOL / 2n } }]);
    for (const event of commitments) expect(openNote(event.encryptedOutput, x25519Only, event.commitment)).toBeNull();
  });

  it("a restored recipient finds what its codes were paid", async () => {
    const { alice, bob } = await pair();
    await makeCode(bob);
    await makeCode(bob);
    const { code } = await makeCode(bob);
    await ui(alice, { type: "send", to: code, amount: (SOL / 4n).toString(), fee: FEE.toString() });
    expect((await settle(alice)).status).toBe("done");

    // The same wallet on a device that never made a code.
    const restored = createHarness({ shared: { ...alice, wallet: bob.wallet, tabs: new Map(), held: [], nextTab: { id: 900 } } });
    await connect(restored);
    expect((await shielded(restored)).balance).toBe(SOL / 4n);
    const runtime = (await restored.core.store.runtime(restored.wallet.address))!;
    expect(paymentCodeCounts(runtime.state)).toEqual({ issued: 3, used: 3 });
    // So the next code it makes is a new one, not one the first device already handed out.
    expect((await makeCode(restored)).made).toBe(4);
  });
});
