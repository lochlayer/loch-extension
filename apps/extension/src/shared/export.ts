// The activity list as a CSV file, for the user's own books. Made in the page from the snapshot
// it already has, and saved by the browser: nothing is sent anywhere.

import { inputSol } from "./amounts.js";
import { activityDelta, activityStatusText, activityTitle } from "./copy.js";
import type { ActivityEntry } from "./view.js";

const HEADER = ["date_utc", "action", "status", "amount_sol", "relayer_fee_sol", "counterparty", "transaction"];

/** One field: quoted when it must be, and never a formula a spreadsheet would run. */
function field(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^[+-]?[0-9.]+$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * The entries as CSV (RFC 4180, CRLF), oldest first. `amount_sol` is signed: what the shielded
 * balance gained or lost, without the fee, which has a column of its own.
 */
export function activityCsv(entries: readonly ActivityEntry[]): string {
  const rows = [...entries]
    .sort((a, b) => a.at - b.at)
    .map((entry) => {
      const delta = activityDelta(entry);
      return [
        new Date(entry.at).toISOString(),
        activityTitle(entry),
        activityStatusText(entry) ?? "Confirmed",
        `${delta < 0n ? "-" : ""}${inputSol(delta < 0n ? -delta : delta)}`,
        entry.fee ? inputSol(BigInt(entry.fee)) : "",
        entry.counterparty ?? "",
        entry.signature ?? "",
      ];
    });
  return [HEADER, ...rows].map((row) => row.map(field).join(",")).join("\r\n") + "\r\n";
}
