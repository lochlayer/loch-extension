// What a deposit costs its sender beyond the amount: two signatures and the rent of two nullifier
// records, at the cluster's rent. Rent is not the same everywhere (mainnet lowered it in 2026), so
// it is read from the cluster, once per endpoint and worker, with the earlier figures as the
// fallback when the endpoint does not answer: they are higher, so a check made with them is safe.

import { DEPOSIT_OVERHEAD, SIGNATURE_FEE, SYSTEM_RENT_MINIMUM } from "../shared/constants.js";
import type { Chain } from "./network.js";

/** Bytes of data in a nullifier record. */
const NULLIFIER_RECORD_SIZE = 9;

export interface DepositCosts {
  /** Two signatures and two nullifier records. */
  overhead: bigint;
  /** What an account without data must hold to exist. */
  minimum: bigint;
}

const known = new Map<string, DepositCosts>();

export async function depositCosts(chain: Chain, rpcUrl: string): Promise<DepositCosts> {
  const cached = known.get(rpcUrl);
  if (cached) return cached;
  try {
    const [record, minimum] = await Promise.all([
      chain.connection.getMinimumBalanceForRentExemption(NULLIFIER_RECORD_SIZE, "confirmed"),
      chain.connection.getMinimumBalanceForRentExemption(0, "confirmed"),
    ]);
    // web3.js answers a failed call with 0; a cluster's rent is never zero.
    if (!(record > 0) || !(minimum > 0)) return { overhead: DEPOSIT_OVERHEAD, minimum: SYSTEM_RENT_MINIMUM };
    const costs = { overhead: 2n * SIGNATURE_FEE + 2n * BigInt(record), minimum: BigInt(minimum) };
    known.set(rpcUrl, costs);
    return costs;
  } catch {
    return { overhead: DEPOSIT_OVERHEAD, minimum: SYSTEM_RENT_MINIMUM };
  }
}
