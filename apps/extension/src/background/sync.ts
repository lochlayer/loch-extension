// Sync: bring one wallet's view of the chain up to date. It asks for what every Loch client
// asks for and nothing else: the genesis hash, the history of the pool's tree address, the
// transactions in it, and the tree account. It never names the wallet's public address (the
// public balance is read elsewhere, only when the user asks: publicBalance.ts), and it never
// blocks the interface: the snapshot keeps showing the last state while this runs.

import { SyncError, createWalletState, fetchTreeAccount, paymentCodeCounts, syncWallet } from "@loch/sdk";

import type { ActivityEntry, SyncView } from "../shared/view.js";
import { addActivity, entriesForReceived, setActivityStatus } from "./activity.js";
import type { Core } from "./core.js";
import { MainnetRefusedError, assertAllowedCluster, describeNetworkError, readCluster } from "./network.js";
import { type ChainRoots, type PendingSpend, chainRootsOf, landedFee, reconcilePending } from "./pending.js";

/** Syncs `address`. Overlapping calls share one run. Never throws: the outcome is the returned view. */
export function syncWalletNow(core: Core, address: string): Promise<SyncView> {
  const running = core.syncing.get(address);
  if (running) return running;
  const abort = new AbortController();
  const run: Promise<SyncView> = runSync(core, address, abort.signal).finally(() => {
    if (core.syncing.get(address) === run) {
      core.syncing.delete(address);
      core.syncAborts.delete(address);
    }
  });
  core.syncing.set(address, run);
  core.syncAborts.set(address, abort);
  return run;
}

/**
 * Stops the sync of `address`, if one is running: it ends at its next request. Whatever it
 * still tries to write is refused by the store once the wallet is forgotten, so this is to
 * stop asking the RPC endpoint, not to protect the disk.
 */
export function stopSync(core: Core, address: string): void {
  core.syncAborts.get(address)?.abort(new DOMException("the wallet is no longer on this device", "AbortError"));
  core.syncAborts.delete(address);
  core.syncing.delete(address);
}

/** The activity entry of a spend that landed without one having been written. */
function entryFor(spend: PendingSpend, at: number): ActivityEntry | null {
  if (!spend.entry || spend.kind === "unlock" || spend.kind === "claim") return null;
  return {
    id: spend.flowId,
    kind: spend.kind,
    status: "confirmed",
    at,
    amount: spend.entry.amount,
    ...(spend.entry.fee !== undefined ? { fee: spend.entry.fee } : {}),
    ...(spend.entry.counterparty !== undefined ? { counterparty: spend.entry.counterparty } : {}),
    ...(spend.entry.claim ? { claim: true as const } : {}),
  };
}

async function runSync(core: Core, address: string, signal: AbortSignal): Promise<SyncView> {
  const before = (await core.view(address)).sync;
  const finish = async (sync: SyncView): Promise<SyncView> => {
    await core.patchView(address, { sync });
    return sync;
  };
  await core.patchView(address, { sync: { ...before, status: "syncing", progress: undefined, detail: undefined } });

  const { settings, chain } = await core.chain();
  try {
    const info = await readCluster(chain.connection);
    await core.patchView(address, { cluster: info.cluster });
    assertAllowedCluster(info);
  } catch (error) {
    if (error instanceof MainnetRefusedError) return finish({ status: "mainnet" });
    return finish({ status: "unreachable", at: before.at, detail: describeNetworkError(settings.rpcUrl, error) });
  }

  const runtime = await core.store.runtime(address).catch(() => null);
  if (!runtime || signal.aborted) return finish({ status: "idle", at: before.at });

  let lastProgress = 0;
  const onProgress = (progress: { fetched: number; total: number }) => {
    const now = core.env.now();
    if (now - lastProgress < 400) return;
    lastProgress = now;
    void core.patchView(address, { sync: { status: "syncing", at: before.at, progress } });
  };

  let result;
  try {
    result = await syncWallet(chain.connection, runtime.state, runtime.keys, { tree: core.store.tree(runtime), onProgress, signal });
  } catch (error) {
    if (signal.aborted) return finish({ status: "idle", at: before.at });
    if (error instanceof SyncError && (error.reason === "mismatch" || error.reason === "state")) {
      // The stored state is not a prefix of this chain (a pool that was reset, another cluster,
      // a fork). Starting again from nothing is always correct; it only costs a full sync.
      try {
        const fresh = createWalletState(runtime.keys);
        result = await syncWallet(chain.connection, fresh, runtime.keys, { onProgress, signal });
      } catch (again) {
        if (signal.aborted) return finish({ status: "idle", at: before.at });
        return finish({ status: failureStatus(again), at: before.at, detail: syncDetail(settings.rpcUrl, again) });
      }
    } else {
      return finish({ status: failureStatus(error), at: before.at, detail: syncDetail(settings.rpcUrl, error) });
    }
  }

  // Spends this device handed to a relayer stay reserved until the chain says what became of
  // them. One thing only the tree account can say: whether the roots their proofs name are
  // still in the program's root history. It is the account every client reads; asking for it
  // names nothing of this wallet.
  let roots: ChainRoots | null = null;
  if (runtime.pending.some((entry) => entry.kind !== "dive" && entry.outcome !== "refused")) {
    try {
      roots = chainRootsOf(await fetchTreeAccount(chain.connection));
    } catch {
      roots = null; // Not known this time: nothing is released for age.
    }
  }
  if (signal.aborted) return finish({ status: "idle", at: before.at });

  const now = core.env.now();
  // A payment code made while this sync was under way was counted in the state the sync did not
  // see. The count must not go back: the same code would be handed to a second payer.
  const codesBefore = paymentCodeCounts(runtime.state);
  const codesAfter = paymentCodeCounts(result.state);
  const synced = codesBefore.issued > codesAfter.issued ? { ...result.state, paymentCodes: { issued: codesBefore.issued, used: codesAfter.used } } : result.state;
  const stateChanged =
    synced.leaves.length !== runtime.state.leaves.length || result.received.length > 0 || result.spent.length > 0 || runtime.neverSynced || codesAfter.used !== codesBefore.used;
  runtime.state = synced;
  runtime.tree = result.tree;

  // Spends this device sent: which landed, which can no longer land.
  const reconciled = reconcilePending(runtime.pending, runtime.state, now, roots);
  let activity = runtime.activity;
  for (const entry of reconciled.landed) {
    // Which of the flow's proofs it was decides the fee that was paid.
    const fee = landedFee(entry, runtime.state);
    if (activity.some((item) => item.id === entry.flowId)) {
      activity = setActivityStatus(activity, entry.flowId, "confirmed").map((item) => (item.id === entry.flowId && fee !== undefined && item.fee !== undefined ? { ...item, fee } : item));
    } else {
      // It landed after its flow was gone (a relayer that sent late). It belongs in the list.
      const late = entryFor(entry, now);
      if (late) activity = addActivity(activity, fee !== undefined && late.fee !== undefined ? { ...late, fee } : late);
    }
  }
  for (const entry of reconciled.released) {
    const known = activity.find((item) => item.id === entry.flowId);
    if (known && known.status !== "confirmed") activity = setActivityStatus(activity, entry.flowId, "failed");
  }
  const pendingChanged = reconciled.remaining.length !== runtime.pending.length;
  runtime.pending = reconciled.remaining;

  // What the sync found that this device did not create.
  for (const entry of entriesForReceived({ received: result.received, ownOutputs: new Set(runtime.ownOutputs), firstSync: runtime.neverSynced, now })) {
    activity = addActivity(activity, entry);
  }
  const activityChanged = activity !== runtime.activity;
  runtime.activity = activity;
  runtime.neverSynced = false;

  if (stateChanged || pendingChanged) await core.store.saveState(runtime);
  if (activityChanged) await core.store.saveActivity(runtime);

  // A flow that stopped with "the relayer says it did not send it" and whose transfer the chain
  // now shows: say so, instead of leaving the failure on screen.
  const flow = await core.flow();
  if (flow && flow.status === "failed" && flow.kind !== "unlock" && flow.kind !== "dive" && flow.address === address && reconciled.landed.some((entry) => entry.flowId === flow.id)) {
    delete flow.failure;
    await core.enter(flow, "done", "done");
  }

  return finish(result.behind > 0 ? { status: "behind", at: now, behind: result.behind } : { status: "synced", at: now });
}

function failureStatus(error: unknown): SyncView["status"] {
  return error instanceof SyncError && error.reason !== "gap" && error.reason !== "unavailable" ? "failed" : "unreachable";
}

function syncDetail(rpcUrl: string, error: unknown): string {
  if (error instanceof SyncError) return `${new URL(rpcUrl).host}: ${error.message.slice(0, 140)}`;
  return describeNetworkError(rpcUrl, error);
}
