// The public balance: the one thing the interface shows that is read by naming the wallet's
// public address to the RPC endpoint (`getBalance`).
//
// A sync asks only for what every Loch client asks for. If the balance were read in the same
// burst, the endpoint could put the address next to whatever this client does then, and around
// a private spend that is the one link the pool exists to hide. So:
//
//   - it is read only when the user asks: the dive-in form opens, or the refresh control is
//     pressed. A dive-in reads it too, as part of the deposit, which is public and comes from
//     that address anyway;
//   - never by a sync, and never by the periodic refresh;
//   - not while a private spend (send privately, surface, combine notes) is in progress, and not
//     for a while after one was handed to a relayer or finished. The request is refused and the
//     interface says when it can be made.
//
// What this cannot do is look ahead: a balance read moments before the user decides to spend
// has already happened.

import { PublicKey } from "@solana/web3.js";

import type { PublicBalanceReply } from "../shared/view.js";
import type { Core } from "./core.js";
import { assertAllowedCluster, describeNetworkError, readCluster } from "./network.js";

/** How long after a private spend the public address is not named to the RPC endpoint. */
export const QUIET_AFTER_SPEND_MS = 10 * 60 * 1000;

const lastSpendKey = (address: string) => `spend:last:${address}`;

/** A spend of `address` is with a relayer now, or just ended. */
export async function noteSpend(core: Core, address: string): Promise<void> {
  if (!(await core.store.holds(address))) return;
  await core.env.session.set(lastSpendKey(address), core.env.now());
}

/** Records a balance that was just read. */
export async function storePublicBalance(core: Core, address: string, lamports: bigint): Promise<void> {
  await core.patchView(address, { publicBalance: lamports.toString(), publicBalanceAt: core.env.now() });
}

/** When the public balance of `address` may next be read, or null when it may be read now. */
export async function publicBalanceHeldUntil(core: Core, address: string): Promise<number | null> {
  const now = core.env.now();
  const flow = await core.flow();
  const spending = flow !== null && flow.address === address && flow.kind !== "unlock" && flow.kind !== "dive" && (flow.status === "running" || flow.status === "waiting");
  if (spending) return now + QUIET_AFTER_SPEND_MS;
  const last = await core.env.session.get<number>(lastSpendKey(address));
  if (typeof last === "number" && now - last < QUIET_AFTER_SPEND_MS) return last + QUIET_AFTER_SPEND_MS;
  return null;
}

/** Reads the public balance of the active wallet because the user asked for it. */
export async function readPublicBalance(core: Core): Promise<PublicBalanceReply> {
  const address = await core.store.active();
  if (!address) throw new Error("no wallet");
  const until = await publicBalanceHeldUntil(core, address);
  if (until !== null) return { status: "held", until };
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
