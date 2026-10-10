import {
  type GatewayKey,
  KEM_X25519_HKDF_SHA256,
  KEM_X_WING,
  bytesToHex,
  decapsulateRequest,
  decodeRequest,
  encodeKeyConfigList,
  encodeResponse,
  gatewayKeyConfig,
  generateGatewaySecretKey,
  importGatewayKey,
  keyFingerprint,
} from "@loch/rpc-client/protocol";
import { describe, expect, it } from "vitest";

import { checkOhttp } from "../src/background/ohttp.js";
import { handleUi } from "../src/background/router.js";
import { syncWalletNow } from "../src/background/sync.js";
import { RELAYER, RPC, SCREENER, createHarness } from "./harness.js";
import { connect, dive, fund, shielded } from "./steps.js";

const RELAY = "https://relay.test";

/**
 * A real Oblivious HTTP gateway in front of the mock chain, reached through a "relay" that only
 * passes bytes on. It has an X25519 key (identifier 1) and, with `hybrid`, an X-Wing key as well
 * (identifier 2), advertised first, as the Loch RPC proxy does after `keygen`.
 */
async function withGateway(h: ReturnType<typeof createHarness>, hybrid = false) {
  const key = await importGatewayKey(1, generateGatewaySecretKey());
  const xWing = hybrid ? await importGatewayKey(2, generateGatewaySecretKey(), undefined, KEM_X_WING) : null;
  const keys = new Map<number, GatewayKey>([[1, key], ...(xWing ? [[2, xWing] as const] : [])]);
  const keyConfig = bytesToHex(encodeKeyConfigList([...(xWing ? [gatewayKeyConfig(xWing)] : []), gatewayKeyConfig(key)]));
  const publicKey = bytesToHex(key.publicKey);
  const direct = h.transport;
  const seenByGateway: string[] = [];
  /** The KEM identifier in the header of every request the relay passed on. */
  const kems: number[] = [];
  h.transport = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== RELAY) return direct(input, init);
    h.requests.push(url.origin);
    // The relay sees ciphertext and nothing else.
    const sealed = new Uint8Array(init.body as ArrayBuffer);
    expect(Buffer.from(sealed).toString("latin1")).not.toContain("getGenesisHash");
    kems.push((sealed[1]! << 8) | sealed[2]!);
    const request = await decapsulateRequest((id) => keys.get(id), sealed);
    const inner = decodeRequest(request.request);
    seenByGateway.push(`${inner.scheme}://${inner.authority}${inner.path}`);
    const answer = await h.chain.handle(JSON.parse(new TextDecoder().decode(inner.content)));
    const response = encodeResponse({ status: 200, headers: [["content-type", "application/json"]], content: new TextEncoder().encode(JSON.stringify(answer)) });
    return new Response((await request.sealResponse(response)) as BodyInit, { status: 200, headers: { "content-type": "message/ohttp-res" } });
  };
  return { keyConfig, publicKey, seenByGateway, kems, fingerprint: keyFingerprint(key), xWingFingerprint: xWing ? keyFingerprint(xWing) : "" };
}

describe("Oblivious HTTP for the RPC endpoint", () => {
  it("every RPC request goes to the relay, encrypted; the RPC endpoint itself is never contacted", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10_000_000_000n);
    const gateway = await withGateway(h);
    const saved = await handleUi(h.core, { loch: "ui", type: "settings", patch: { ohttp: { relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey: gateway.publicKey, enabled: true } } });
    expect(saved).toMatchObject({ ok: true });
    h.requests.length = 0;

    expect((await syncWalletNow(h.core, h.wallet.address)).status).toBe("synced");
    await dive(h, 2_000_000_000n);
    expect((await shielded(h)).balance).toBe(2_000_000_000n);

    expect(h.requests).not.toContain(RPC);
    expect(new Set(h.requests)).toEqual(new Set([RELAY, SCREENER]));
    // Inside the envelope the gateway is asked for the RPC endpoint.
    expect(new Set(gateway.seenByGateway)).toEqual(new Set(["https://rpc.test/"]));
    expect(h.chain.calls).toContain("sendTransaction");
    expect(h.requests).not.toContain(RELAYER);
  });

  it("refuses a key configuration that does not carry the pinned key, and one that is not a key configuration", async () => {
    const h = createHarness();
    const gateway = await withGateway(h);
    const other = bytesToHex((await importGatewayKey(2, generateGatewaySecretKey())).publicKey);
    expect(checkOhttp({ enabled: true, relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey: gateway.publicKey }, RPC)).toEqual({ ok: true, publicKeys: [gateway.publicKey], kem: "X25519" });
    // The key configuration is pasted, never fetched, so a pin is a second check and stays optional.
    expect(checkOhttp({ enabled: true, relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey: "" }, RPC)).toMatchObject({ ok: true });
    expect(checkOhttp({ enabled: true, relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey: other }, RPC)).toEqual({ ok: false, problem: "pin" });
    expect(checkOhttp({ enabled: true, relayUrl: RELAY, keyConfig: "not a key configuration", pinnedKey: "" }, RPC)).toEqual({ ok: false, problem: "key-config" });
    expect(checkOhttp({ enabled: true, relayUrl: "", keyConfig: gateway.keyConfig, pinnedKey: "" }, RPC)).toEqual({ ok: false, problem: "relay" });

    const refused = await handleUi(h.core, { loch: "ui", type: "settings", patch: { ohttp: { relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey: other, enabled: true } } });
    expect(refused).toMatchObject({ ok: false, error: { message: "ohttp.pinnedKey:pin" } });
    expect((await h.core.settings()).ohttp.enabled).toBe(false);
  });

  it("takes the key configuration's content and never an address to fetch it from", async () => {
    const h = createHarness();
    const gateway = await withGateway(h);
    // What the client library is being tightened against: a configuration served by the relay
    // itself, or by anyone, without a pin. The extension has no such setting at all.
    for (const address of [`${RELAY}/ohttp-keys`, "https://gateway.test/ohttp-keys", " http://127.0.0.1:8080/ohttp-keys"]) {
      expect(checkOhttp({ enabled: true, relayUrl: RELAY, keyConfig: address, pinnedKey: "" }, RPC), address).toEqual({ ok: false, problem: "key-config-url" });
      expect(checkOhttp({ enabled: true, relayUrl: RELAY, keyConfig: address, pinnedKey: gateway.publicKey }, RPC), address).toEqual({ ok: false, problem: "key-config-url" });
    }
    const refused = await handleUi(h.core, { loch: "ui", type: "settings", patch: { ohttp: { relayUrl: RELAY, keyConfig: `${RELAY}/ohttp-keys`, pinnedKey: "", enabled: true } } });
    expect(refused).toMatchObject({ ok: false, error: { message: "ohttp.keyConfig:key-config-url" } });
    h.requests.length = 0;
    expect(h.requests).toEqual([]); // nothing was fetched to find that out
    // No option of the settings can carry an address for it.
    expect(Object.keys((await h.core.settings()).ohttp).sort()).toEqual(["enabled", "keyConfig", "pinnedKey", "relayUrl"]);
  });

  it("refuses a relay on the RPC endpoint's own origin: one party would see who asks and what is asked", async () => {
    const h = createHarness();
    const gateway = await withGateway(h);
    expect(checkOhttp({ enabled: true, relayUrl: `${RPC}/relay`, keyConfig: gateway.keyConfig, pinnedKey: "" }, RPC)).toEqual({ ok: false, problem: "same-origin" });
    const refused = await handleUi(h.core, { loch: "ui", type: "settings", patch: { ohttp: { relayUrl: `${RPC}/relay`, keyConfig: gateway.keyConfig, pinnedKey: "", enabled: true } } });
    expect(refused).toMatchObject({ ok: false, error: { message: "ohttp.relayUrl:same-origin" } });
    // And moving the RPC endpoint onto the relay's origin while it is on is refused the same way.
    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { ohttp: { relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey: "", enabled: true } } })).toMatchObject({ ok: true });
    expect(await handleUi(h.core, { loch: "ui", type: "settings", patch: { rpcUrl: `${RELAY}/rpc` } })).toMatchObject({ ok: false, error: { message: "ohttp.relayUrl:same-origin" } });
  });

  it("a gateway with an X-Wing key: every request uses it, pinned by fingerprint or not pinned, and the settings say so", async () => {
    const h = createHarness();
    await connect(h);
    fund(h, 10_000_000_000n);
    const gateway = await withGateway(h, true);
    expect(gateway.keyConfig.length).toBeLessThan(8192); // what the settings accept
    for (const pinnedKey of [gateway.xWingFingerprint, ""]) {
      const saved = await handleUi(h.core, { loch: "ui", type: "settings", patch: { ohttp: { relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey, enabled: true } } });
      expect(saved).toMatchObject({ ok: true });
      gateway.kems.length = 0;
      h.requests.length = 0;
      expect((await syncWalletNow(h.core, h.wallet.address)).status).toBe("synced");
      expect(gateway.kems.length).toBeGreaterThan(0);
      expect(new Set(gateway.kems)).toEqual(new Set([KEM_X_WING]));
      expect((await h.core.snapshot()).settings.ohttp).toMatchObject({ enabled: true, kem: "X-Wing" });
    }
    await dive(h, 2_000_000_000n);
    expect((await shielded(h)).balance).toBe(2_000_000_000n);
    expect(h.requests).not.toContain(RPC);
  });

  it("a pin on the X25519 key keeps requests on X25519, and the settings say that too", async () => {
    const h = createHarness();
    await connect(h);
    const gateway = await withGateway(h, true);
    for (const pinnedKey of [gateway.publicKey, gateway.fingerprint]) {
      expect(checkOhttp({ enabled: true, relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey }, RPC)).toMatchObject({ ok: true, kem: "X25519" });
    }
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { ohttp: { relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey: gateway.publicKey, enabled: true } } });
    gateway.kems.length = 0;
    expect((await syncWalletNow(h.core, h.wallet.address)).status).toBe("synced");
    expect(new Set(gateway.kems)).toEqual(new Set([KEM_X25519_HKDF_SHA256]));
    expect((await h.core.snapshot()).settings.ohttp).toMatchObject({ enabled: true, kem: "X25519" });
    // A fingerprint that belongs to neither key is refused like any other wrong pin.
    expect(checkOhttp({ enabled: true, relayUrl: RELAY, keyConfig: gateway.keyConfig, pinnedKey: `sha256:${"0".repeat(64)}` }, RPC)).toEqual({ ok: false, problem: "pin" });
  });

  it("off by default: requests go straight to the RPC endpoint", async () => {
    const h = createHarness();
    await connect(h);
    expect(h.requests).toContain(RPC);
    expect((await h.core.snapshot()).settings.ohttp).toMatchObject({ enabled: false, available: true });
    expect((await h.core.snapshot()).settings.ohttp).not.toHaveProperty("kem");
  });
});
