// What surfacing gives away. A withdrawal is public: destination, amount and time. Only the
// link to the deposit behind it is hidden, and three things put that link back:
//
//   same-address   the destination is an address this wallet dived in from
//   same-amount    the amount equals a recent dive-in (or that dive-in less the fee)
//   soon-after     the withdrawal follows a dive-in closely
//
// A fourth ties the withdrawal to the wallet itself, for one reader:
//
//   shown          it spends a note this wallet showed in a depth proof; whoever was given the
//                  proof knows that note's nullifier, so they see it spent here and learn where
//                  the wallet surfaced. A send to the wallet's own address first cuts that: the
//                  new notes' nullifiers are in no proof.
//
// Pure: no clock, no network. The interface shows each warning and lets the user go on.

export type SurfaceWarningId = "same-address" | "same-amount" | "soon-after" | "shown";

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
  /** Commitments of the notes the withdrawal would spend. */
  spends?: readonly string[];
  /** Commitments of unspent notes shown in a depth proof. */
  shown?: readonly string[];
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

  const shown = new Set(input.shown ?? []);
  if ((input.spends ?? []).some((commitment) => shown.has(commitment))) warnings.push({ id: "shown" });

  return warnings;
}
