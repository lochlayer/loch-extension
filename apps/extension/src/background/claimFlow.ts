// Collecting a claim link (docs/protocol.md, section 4).
//
// A claim code holds a secret and says where one note is. The keys that follow from the secret
// own that note; this flow spends it with them, in one private transfer through the relayer,
// to the active wallet's own shielded address. The relayer's fee comes out of the note.
//
// It is a spend like the others, with less to keep track of. There is one note, so every proof
// the flow makes spends that note and at most one of them can land. And nothing of the wallet's
// own balance is at stake: until the chain shows the transfer, the wallet has what it had.
//
// The code is the money. It lives in the flow record (session storage, memory only) for as long
// as the flow does, and is never part of what the interface is shown.

import {
  LochError,
  PROGRAM_ID,
  WireError,
  claimKeys,
  claimNote,
  claimState,
  decodeClaim,
  isNullifierSpent,
  prepareTransfer,
  toRelayRequest,
} from "@loch/sdk";
import { PublicKey } from "@solana/web3.js";

import type { ClaimCheck } from "../shared/view.js";
import { addActivity } from "./activity.js";
import { type ClaimRecord, type Core, fail } from "./core.js";
import { base, begin, synced, unlocked, wireDetail, wireReason } from "./flows.js";
import { assertAllowedCluster, readCluster } from "./network.js";
import { addRecord, recordOf } from "./records.js";
import type { WalletRuntime } from "./store.js";
import { syncWalletNow } from "./sync.js";

const MAX_REPROVES = 2;
const CONFIRM_MS = 30_000;
const POLL_MS = 1_500;

/** What a code is worth, without asking anyone. */
export async function checkClaim(core: Core, raw: string): Promise<ClaimCheck> {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  // A link carries the code after the "#": take what follows it.
  const code = text.slice(text.lastIndexOf("#") + 1).toLowerCase();
  let claim;
  try {
    claim = decodeClaim(code);
  } catch (error) {
    return { ok: false, reason: error instanceof LochError && "reason" in error && error.reason === "checksum" ? "checksum" : "not-a-code" };
  }
  const active = await core.store.active();
  const runtime = active ? await core.store.runtime(active).catch(() => null) : null;
  const commitment = claimNote(claim).commitment.toString();
  return { ok: true, amount: claim.amount.toString(), own: runtime?.records.some((record) => record.paid?.commitment === commitment) ?? false };
}

export async function startClaim(core: Core, raw: string, fee: bigint): Promise<void> {
  const runtime = await unlocked(core);
  const code = raw.trim().slice(raw.trim().lastIndexOf("#") + 1).toLowerCase();
  const claim = decodeClaim(code);
  const cap = BigInt((await core.settings()).maxFeeLamports);
  if (fee > cap) throw new LochError("INVALID_ARGUMENT", "fee:above-limit");
  const flow: ClaimRecord = {
    ...base(core, "claim", runtime.address, "checking"),
    kind: "claim",
    address: runtime.address,
    code,
    amount: claim.amount.toString(),
    fee: fee.toString(),
    reproved: 0,
  };
  await begin(core, flow);
}

/** The chain, as the synced state has it, shows one of the flow's proofs: its outputs are leaves. */
function landed(runtime: WalletRuntime, flow: ClaimRecord): boolean {
  return flow.outputs !== undefined && flow.outputs.some((commitment) => runtime.state.leaves.lastIndexOf(commitment) >= 0);
}

async function succeed(core: Core, runtime: WalletRuntime, flow: ClaimRecord): Promise<void> {
  const fee = BigInt(flow.request?.extData.fee ?? flow.fee);
  runtime.activity = addActivity(runtime.activity, {
    id: flow.id,
    kind: "claim",
    status: "confirmed",
    at: core.env.now(),
    amount: (BigInt(flow.amount) - fee).toString(),
    fee: fee.toString(),
    ...(flow.signature ? { signature: flow.signature } : {}),
  });
  await core.store.saveActivity(runtime);
  await core.enter(flow, "done", "done");
}

export async function stepClaim(core: Core, flow: ClaimRecord): Promise<void> {
  const { settings, chain } = await core.chain();
  const runtime = await core.store.runtime(flow.address);
  if (!runtime) throw fail("locked");
  const claim = decodeClaim(flow.code);
  const agreed = BigInt(flow.fee);
  const cap = BigInt(settings.maxFeeLamports);
  const relayer = core.env.relayer(settings, chain);

  switch (flow.step) {
    case "checking": {
      const cluster = await readCluster(chain.connection);
      assertAllowedCluster(cluster);
      const sync = await syncWalletNow(core, flow.address);
      if (!synced(sync)) throw fail(sync.status === "mainnet" ? "mainnet" : "sync-failed", { retry: true, detail: sync.detail });
      if (landed(runtime, flow)) {
        await succeed(core, runtime, flow);
        return;
      }
      try {
        claimState(claim, runtime.state.leaves);
      } catch {
        // Not in this pool, or not yet: the payer's transfer may still be on its way.
        throw fail("claim-missing", { retry: true });
      }
      // The one question about a note that is asked of the endpoint by name. Without it a code
      // that was already collected would only fail after a proof was made and sent.
      if (await isNullifierSpent(chain.connection, claimNote(claim).nullifier)) throw fail("claim-taken");

      let info;
      try {
        info = await relayer.info();
      } catch (error) {
        throw fail("relayer-unreachable", { retry: true, detail: wireDetail(settings.relayerUrl, error), ...wireReason(error) });
      }
      if (info.programId !== PROGRAM_ID.toBase58() || info.genesisHash !== cluster.genesisHash || info.cluster !== cluster.cluster) throw fail("relayer-mismatch");
      const fee = BigInt(info.feeLamports);
      if (fee > cap || agreed > cap) throw fail("fee-above-limit", { amount: (fee > cap ? fee : agreed).toString(), limit: cap.toString() });
      if (fee > agreed) throw fail("fee-changed", { amount: fee.toString(), limit: agreed.toString() });
      if (claim.amount <= fee) throw fail("claim-too-small", { amount: claim.amount.toString(), limit: fee.toString() });
      if (flow.request && flow.request.extData.relayer === info.relayer && BigInt(flow.request.extData.fee) >= fee && BigInt(flow.request.extData.fee) <= agreed) {
        flow.relayer = info.relayer;
        await core.enter(flow, "sending");
        return;
      }
      delete flow.request;
      flow.relayer = info.relayer;
      await core.enter(flow, "proving");
      return;
    }
    case "proving": {
      if (!flow.relayer) throw fail("internal");
      const info = await relayer.info().catch((error: unknown) => {
        throw fail("relayer-unreachable", { retry: true, detail: wireDetail(settings.relayerUrl, error), ...wireReason(error) });
      });
      if (info.relayer !== flow.relayer) {
        await core.enter(flow, "checking");
        return;
      }
      const fee = BigInt(info.feeLamports);
      const keys = claimKeys(claim.secret);
      const prepared = await prepareTransfer({
        prover: core.env.prover,
        keys,
        state: claimState(claim, runtime.state.leaves),
        tree: core.store.tree(runtime),
        relayer: new PublicKey(flow.relayer),
        fee,
        maxFee: agreed < cap ? agreed : cap,
        // The wallet's own address: an ordinary incoming payment, as far as the chain and the next sync can tell.
        to: runtime.keys,
        amount: claim.amount - fee,
      });
      const outputs = prepared.outputs.map((output) => output.commitment.toString());
      flow.request = toRelayRequest(prepared.args);
      flow.outputs = [...(flow.outputs ?? []), ...outputs];
      // This device made the note it is about to receive: the activity list gets one entry for it, from here.
      runtime.ownOutputs.push(...outputs);
      await core.store.saveState(runtime);
      // The claim's note opened, for a report on a later withdrawal: its trail ends at this note.
      runtime.records = addRecord(runtime.records, recordOf(flow.id, prepared, keys.publicKey, core.env.now()), runtime.state, core.env.now());
      await core.store.saveRecords(runtime);
      await core.enter(flow, "sending");
      return;
    }
    case "sending": {
      if (!flow.request) throw fail("internal");
      if (!flow.handed) {
        flow.handed = true;
        await core.saveFlow(flow);
      }
      let response;
      try {
        response = await relayer.relay(flow.request);
      } catch (error) {
        await relayFailed(core, runtime, flow, error);
        return;
      }
      flow.signature = response.signature;
      await core.enter(flow, "confirming");
      return;
    }
    case "confirming": {
      const deadline = flow.stepStartedAt + CONFIRM_MS;
      for (;;) {
        await syncWalletNow(core, flow.address);
        if (landed(runtime, flow)) {
          await succeed(core, runtime, flow);
          return;
        }
        if (core.env.now() >= deadline) {
          const claimed = flow.signature;
          delete flow.signature;
          throw fail("relayer-unconfirmed", { moved: "unknown", retry: true, detail: `${new URL(settings.relayerUrl).host} answered with transaction ${claimed ? `${claimed.slice(0, 8)}…` : "(none)"}` });
        }
        await core.saveFlow(flow);
        await core.env.sleep(POLL_MS);
      }
    }
    default:
      throw fail("internal");
  }
}

/** The relayer answered with an error, or did not answer. The chain is asked before anything is said. */
async function relayFailed(core: Core, runtime: WalletRuntime, flow: ClaimRecord, error: unknown): Promise<void> {
  const settings = await core.settings();
  const code = error instanceof WireError ? error.code : "network_error";
  const detail = wireDetail(settings.relayerUrl, error);
  await syncWalletNow(core, flow.address);
  if (landed(runtime, flow)) {
    await succeed(core, runtime, flow);
    return;
  }
  // Nothing of this wallet's is reserved by a claim, so every failure can simply be tried again:
  // the next attempt starts by asking the chain whether the note is still there.
  switch (code) {
    case "unknown_root":
      delete flow.request;
      if (flow.reproved < MAX_REPROVES) {
        flow.reproved++;
        await core.enter(flow, "checking");
        return;
      }
      throw fail("stale-root", { retry: true, detail });
    case "nullifier_spent":
      // Somebody collected it first, or an earlier request of this flow is landing: the next check tells which.
      delete flow.request;
      throw fail("claim-taken", { moved: "unknown", retry: true, detail });
    case "network_error":
      throw fail("relayer-unreachable", { moved: "unknown", retry: true, detail, ...wireReason(error) });
    case "not_confirmed":
      throw fail("not-confirmed", { moved: "unknown", retry: true, detail });
    case "fee_too_low": {
      delete flow.request;
      const { chain } = await core.chain();
      const info = await core.env.relayer(settings, chain).info().catch(() => null);
      throw fail("fee-changed", { amount: info?.feeLamports, limit: flow.fee, detail });
    }
    case "invalid_proof":
      delete flow.request;
      throw fail("proof-failed", { retry: true, detail });
    case "wrong_relayer":
      delete flow.request;
      throw fail("relayer-mismatch", { retry: true, detail });
    case "bad_response":
    case "internal":
    case "unavailable":
    case "rate_limited":
      throw fail("relayer-unavailable", { moved: "unknown", retry: true, detail });
    default:
      throw fail("relayer-refused", { retry: true, detail: error instanceof WireError ? `${detail}: ${error.message.slice(0, 120)}` : detail });
  }
}

/**
 * The worker restarted while this flow was running. Returns true when the caller should drive
 * the flow on, false when it was brought to an end here.
 */
export async function resumeClaim(core: Core, flow: ClaimRecord): Promise<boolean> {
  if (flow.step === "checking" || flow.step === "proving") {
    flow.step = "checking";
    return true;
  }
  if (flow.step === "sending") {
    // A request was in flight and nobody is left to hear its answer. The check asks the chain.
    flow.handed = true;
    flow.step = "checking";
    return true;
  }
  // confirming: the chain is asked again.
  return true;
}
