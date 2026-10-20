// Depth proofs from the worker: made from the synced notes with the real depth circuit, checked
// here the way a stranger would check them (the SDK against the chain), and remembered, so that
// surfacing from a shown note is warned of until the note has moved.

import { type Groth16Verify, decodeDepthProof, verifyDepthProof, verifyProof } from "@loch/sdk";
import { describe, expect, it } from "vitest";

import { depthCluster } from "../src/background/disclose.js";
import { readCluster } from "../src/background/network.js";
import { handleUi, parseUiRequest } from "../src/background/router.js";
import { surfaceWarnings } from "../src/background/surfaceWarnings.js";
import { DEPTH_COPY, depthErrorText, plainText } from "../src/shared/copy.js";
import type { DepthProofReply, SurfaceWarningView, UiReply, UiRequest } from "../src/shared/view.js";
import { type Harness, createHarness, settle } from "./harness.js";
import { connect, dive, fund, shielded } from "./steps.js";

const SOL = 1_000_000_000n;
const FEE = 2_500_000n;
const CHALLENGE = "OTC desk 2026-10-20 #7f3a";

const groth16: Groth16Verify = (key, signals, proof) => verifyProof(key, proof, signals);

async function ui<T>(h: Harness, request: UiRequest): Promise<T> {
  const reply = await handleUi(h.core, request);
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.value as T;
}

const prove = (h: Harness, threshold: bigint, challenge = CHALLENGE) => handleUi(h.core, { loch: "ui", type: "depth-proof", threshold: threshold.toString(), challenge }) as Promise<UiReply<DepthProofReply>>;

async function ready(h: Harness, deposits: bigint[]): Promise<void> {
  await connect(h);
  fund(h, 20n * SOL);
  for (const amount of deposits) await dive(h, amount);
}

const runtime = async (h: Harness) => (await h.core.store.runtime((await h.core.store.active())!))!;
const warningIds = async (h: Harness, amount: bigint) =>
  (await ui<SurfaceWarningView[]>(h, { loch: "ui", type: "surface-warnings", to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: amount.toString(), fee: FEE.toString() })).map((warning) => warning.id);

describe("depth proof", () => {
  it("proves at least an amount, and a stranger checks it against the chain", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL, 3n * SOL]);
    const reply = await prove(h, 4n * SOL);
    if (!reply.ok) throw new Error(reply.error.message);
    const { code, link, threshold, notes } = reply.value;
    expect(link).toBe(`https://lochlayer.com/verify#${code}`);
    expect(threshold).toBe((4n * SOL).toString());
    expect(notes).toBe(2);

    const depth = decodeDepthProof(code);
    const { chain } = await h.core.chain();
    expect(depth.cluster).toBe(depthCluster((await readCluster(chain.connection)).cluster));
    expect(await verifyDepthProof(chain.connection, depth, groth16, { challenge: CHALLENGE })).toMatchObject({ ok: true, threshold: 4n * SOL, challenge: CHALLENGE });
    // The proof is public; nothing secret of the wallet is in it, and the snapshot does not keep it.
    expect(JSON.stringify(await h.core.snapshot())).not.toContain(code);
  });

  it("remembers the shown notes, warns before surfacing from them, and forgets them once they move", async () => {
    const h = createHarness();
    await ready(h, [2n * SOL]);
    expect(await warningIds(h, SOL)).not.toContain("shown");
    expect((await prove(h, SOL)).ok).toBe(true);
    expect((await runtime(h)).shown).toHaveLength(1);
    expect(await warningIds(h, SOL)).toContain("shown");

    // A send to the wallet's own address moves the shown note to fresh ones that no proof names.
    const own = (await runtime(h)).shieldedAddress;
    await ui(h, { loch: "ui", type: "send", to: own, amount: SOL.toString(), fee: FEE.toString() });
    const flow = await settle(h);
    expect(flow.failure).toBeUndefined();
    await h.core.clearFlow();
    expect((await shielded(h)).balance).toBe(2n * SOL - FEE);
    expect((await runtime(h)).shown).toEqual([]);
    expect(await warningIds(h, SOL)).not.toContain("shown");

    // It survives the service worker restarting: the list is saved with the state.
    expect((await prove(h, SOL)).ok).toBe(true);
    const restarted = h.restart();
    expect((await runtime(restarted)).shown).toHaveLength(1);
  });

  it("says why when it cannot make one", async () => {
    const h = createHarness();
    await ready(h, [SOL]);
    const short = await prove(h, 2n * SOL);
    expect(short).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_BALANCE" } });
    expect((await prove(h, SOL, "   ")).ok).toBe(false);
    expect((await prove(h, SOL, "x".repeat(129))).ok).toBe(false);
    expect((await runtime(h)).shown).toEqual([]);

    await h.core.store.lock();
    expect(await prove(h, SOL)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  it("takes only a decimal threshold and a bounded challenge", () => {
    const base = { loch: "ui", type: "depth-proof", threshold: "1000", challenge: "hi" };
    expect(parseUiRequest(base)).toEqual(base);
    expect(parseUiRequest({ ...base, threshold: "1.5" })).toBeNull();
    expect(parseUiRequest({ ...base, threshold: 1000 })).toBeNull();
    expect(parseUiRequest({ ...base, challenge: 7 })).toBeNull();
    expect(parseUiRequest({ ...base, challenge: "x".repeat(513) })).toBeNull();
  });
});

describe("the shown warning", () => {
  const base = { amount: SOL, fee: FEE, destination: "dest", now: 1_790_000_000_000, deposits: [], ownAddresses: [] };

  it("is given when the withdrawal spends a shown note, and only then", () => {
    expect(surfaceWarnings({ ...base, spends: ["1", "2"], shown: ["2"] })).toEqual([{ id: "shown" }]);
    expect(surfaceWarnings({ ...base, spends: ["1"], shown: ["2"] })).toEqual([]);
    expect(surfaceWarnings({ ...base, shown: ["2"] })).toEqual([]);
  });
});

describe("copy", () => {
  it("states what the proof shows and costs, with the amount upright", () => {
    const line = DEPTH_COPY.result("4.5");
    expect(plainText(line)).toBe("Shows you hold at least 4.5 SOL in the Loch, and nothing else. Whoever checks it can later see when these notes move, and where if you surface from them; send them to yourself first.");
    expect(line).toContain("⟦p:4.5⟧");
    for (const code of ["INSUFFICIENT_BALANCE", "CONSOLIDATION_REQUIRED", "STALE_STATE", "SYNC_FAILED", "PROOF_FAILED", "INVALID_ARGUMENT", "other"]) {
      expect(depthErrorText(code)).toMatch(/^[A-Z].*\.$/);
    }
    // Cautions about the software live on the website, not in the extension.
    expect(JSON.stringify(DEPTH_COPY)).not.toMatch(/audit/i);
  });
});
