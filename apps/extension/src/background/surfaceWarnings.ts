// What surfacing gives away. A withdrawal is public: destination, amount and time. Only the
// link to the deposit behind it is hidden, and three things put that link back:
//
//   same-address   the destination is an address this wallet dived in from
//   same-amount    the amount equals a recent dive-in (or that dive-in less the fee)
//   soon-after     the withdrawal follows a dive-in closely
//
// Pure: no clock, no network. The interface shows each warning and lets the user go on.

export type SurfaceWarningId = "same-address" | "same-amount" | "soon-after";

export interface SurfaceWarning {
  id: SurfaceWarningId;
  /** The deposit the warning points at, when there is one. */
  deposit?: { amount: bigint; at: number; from: string };
}

export interface KnownDeposit {
  amount: bigint;
  /** Milliseconds. */
  at: number;
  /** The public address it came from. */
  from: string;
}

export interface SurfaceWarningInput {
  amount: bigint;
  fee: bigint;
  destination: string;
  /** Milliseconds. */
  now: number;
  deposits: readonly KnownDeposit[];
  /** Public addresses connected on this device. */
  ownAddresses: readonly string[];
}

/** A dive-in this recent makes a withdrawal easy to pair with it. */
export const SOON_AFTER_MS = 24 * 60 * 60 * 1000;
/** How far back an equal amount still stands out. */
export const SAME_AMOUNT_MS = 30 * 24 * 60 * 60 * 1000;

export function surfaceWarnings(input: SurfaceWarningInput): SurfaceWarning[] {
  const { amount, fee, destination, now, deposits, ownAddresses } = input;
  const warnings: SurfaceWarning[] = [];
  const newestFirst = [...deposits].sort((a, b) => b.at - a.at);

  const fromHere = newestFirst.find((deposit) => deposit.from === destination);
  if (fromHere) warnings.push({ id: "same-address", deposit: fromHere });
  else if (ownAddresses.includes(destination)) warnings.push({ id: "same-address" });

  const equal = newestFirst.find(
    (deposit) => now - deposit.at <= SAME_AMOUNT_MS && deposit.at <= now && (deposit.amount === amount || deposit.amount === amount + fee),
  );
  if (equal) warnings.push({ id: "same-amount", deposit: equal });

  const recent = newestFirst.find((deposit) => deposit.at <= now && now - deposit.at <= SOON_AFTER_MS);
  if (recent) warnings.push({ id: "soon-after", deposit: recent });

  return warnings;
}
