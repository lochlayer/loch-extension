// The leak scan of the public wallet: what its history gives away. It reads the wallet's own
// transactions from the RPC endpoint, which therefore learns which address was scanned. The
// result is cached in the vault, and the wrapper uses its transfers to warn before a public
// transfer is signed.

import type { Core } from "./core.js";
import { MainnetRefusedError, assertAllowedCluster, describeNetworkError, readCluster } from "./network.js";

/** Most recent transactions looked at. The scanner's own default. */
export const SCAN_LIMIT = 300;

export async function startScan(core: Core): Promise<void> {
  const address = await core.store.active();
  const runtime = address ? await core.store.runtime(address) : null;
  if (!address || !runtime) throw new Error("unlock the wallet first");
  if (core.scanAbort) return;
  const abort = new AbortController();
  core.scanAbort = abort;
  core.scanAddress = address;
  await core.setScanRun(address, { status: "running", startedAt: core.env.now(), progress: { fetched: 0, total: 0, skipped: 0 } });
  void (async () => {
    const { settings, chain } = await core.chain();
    try {
      assertAllowedCluster(await readCluster(chain.connection));
      let last = 0;
      const result = await core.env.scan(chain.connection, address, {
        limit: SCAN_LIMIT,
        signal: abort.signal,
        onProgress: (progress) => {
          const now = core.env.now();
          if (now - last < 300 && progress.fetched < progress.total) return;
          last = now;
          // Each write also tells the browser the worker is still busy.
          void core.setScanRun(address, { status: "running", startedAt: now, progress });
        },
      });
      runtime.scan = { report: result.report, flows: result.flows, skipped: result.skipped, scannedAt: core.env.now() };
      await core.store.saveScan(runtime);
      await core.setScanRun(address, { status: "done" });
    } catch (error) {
      if (abort.signal.aborted) await core.setScanRun(address, { status: "cancelled" });
      else if (error instanceof MainnetRefusedError) await core.setScanRun(address, { status: "failed", error: "mainnet" });
      else await core.setScanRun(address, { status: "failed", error: describeNetworkError(settings.rpcUrl, error) });
    } finally {
      core.scanAbort = null;
      core.scanAddress = null;
    }
  })();
}

export async function cancelScan(core: Core): Promise<void> {
  core.scanAbort?.abort(new DOMException("the scan was cancelled", "AbortError"));
  const address = await core.store.active();
  if (address && !core.scanAbort && (await core.scanRun(address)).status === "running") {
    await core.setScanRun(address, { status: "cancelled" });
  }
}

/** A scan cannot outlive the worker that ran it. After a restart, say so instead of showing progress forever. */
export async function resumeScan(core: Core): Promise<void> {
  for (const key of await core.env.session.keys("scan:")) {
    const run = await core.env.session.get<{ status: string }>(key);
    if (run?.status === "running" && !core.scanAbort) await core.env.session.set(key, { status: "failed", error: "interrupted" });
  }
}
