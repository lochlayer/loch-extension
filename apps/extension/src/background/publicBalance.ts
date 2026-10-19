// The public balance: the one thing the interface shows that is read by naming the wallet's
// public address to the RPC endpoint (`getBalance`).
//
// A sync asks only for what every Loch client asks for and never reads it. The interface reads
// it while it is open (on opening, every few seconds, and when the refresh control is pressed),
// and a dive-in reads it as part of the deposit. By the owner's decision (2026-10-19) it is read
// next to a private spend as well, so the endpoint can put the address next to the spend by
// time. The website's privacy page says so.

import { PublicKey } from "@solana/web3.js";

import type { PublicBalanceReply } from "../shared/view.js";
import type { Core } from "./core.js";
import { assertAllowedCluster, describeNetworkError, readCluster } from "./network.js";

/** Records a balance that was just read. */
export async function storePublicBalance(core: Core, address: string, lamports: bigint): Promise<void> {
  await core.patchView(address, { publicBalance: lamports.toString(), publicBalanceAt: core.env.now() });
}

/** Reads the public balance of the active wallet, for the interface. */
export async function readPublicBalance(core: Core): Promise<PublicBalanceReply> {
  const address = await core.store.active();
  if (!address) throw new Error("no wallet");
  const { settings, chain } = await core.chain();
  try {
    const cluster = await readCluster(chain.connection);
    await core.patchView(address, { cluster: cluster.cluster });
    assertAllowedCluster(cluster);
    const lamports = BigInt(await chain.connection.getBalance(new PublicKey(address), "confirmed"));
    await storePublicBalance(core, address, lamports);
    return { status: "read", lamports: lamports.toString(), at: core.env.now() };
  } catch (error) {
    return { status: "unreachable", detail: describeNetworkError(settings.rpcUrl, error) };
  }
}
