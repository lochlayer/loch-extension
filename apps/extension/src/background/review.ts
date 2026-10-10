// The wrapper's second check: before a site's transaction with a plain transfer from the user's
// wallet is handed to the real wallet, say what sending it would give away.
//
// The transaction is only read. Whatever this returns, the bytes the wallet is given are the
// bytes the site passed in.
//
// A review is made only for an address the asking site was already given by the wallet
// (sites.ts). Whether a dialog appears is visible to the site, so reviewing an address the site
// merely names would tell it whether that address is this browser's Loch wallet.

import { assessOutgoingTransfer } from "@loch/scanner-core/analysis";
import { formatSol, shortAddress } from "@loch/design/numerals";

import { fromBase64 } from "../shared/bytes.js";
import type { ReviewReply, ReviewTransfer, ReviewWarning } from "../shared/messages.js";
import type { Core } from "./core.js";
import { siteHasAccount } from "./sites.js";
import { type DecodedTransfer, transfersFrom } from "./txdecode.js";

function describe(transfer: DecodedTransfer): ReviewTransfer {
  if (transfer.program === "system") {
    return { to: transfer.destination, amount: `${formatSol(transfer.amount, { exact: true }).text} SOL` };
  }
  if (transfer.mint !== undefined && transfer.decimals !== undefined) {
    return { to: transfer.destination, amount: `${tokenAmount(transfer.amount, transfer.decimals)} of token ${shortAddress(transfer.mint)}` };
  }
  return { to: transfer.destination, amount: `${transfer.amount.toString()} base units of a token` };
}

/** A token amount with its decimals, exact, trailing zeros dropped. */
export function tokenAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const text = amount.toString().padStart(decimals + 1, "0");
  const whole = text.slice(0, -decimals);
  const frac = text.slice(-decimals).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/**
 * Looks at the transactions the site at `origin` wants signed for `account`. "pass" when there
 * is nothing to say: the wrapper is off, the site was never given that account, the wallet is
 * locked or was never scanned, no transaction could be read, none holds a plain transfer from
 * the wallet, or nothing stood out that is worth interrupting for.
 *
 * What interrupts: a finding of medium severity or higher. A first-time recipient is a low one,
 * and nearly every payment has it; it interrupts only when the user asked for that in settings.
 */
export async function reviewTransactions(core: Core, origin: string | null, account: string, transactions: readonly string[]): Promise<ReviewReply> {
  const pass: ReviewReply = { action: "pass" };
  const settings = await core.settings();
  if (!settings.wrapperEnabled) return pass;
  // Before anything that depends on whose wallet this is: an address the site was not given
  // gets the same answer, as quickly, as an address that is nobody's.
  if (!(await siteHasAccount(core, origin, account))) return pass;
  if (!(await core.store.wallet(account))) return pass;
  const runtime = await core.store.runtime(account).catch(() => null);
  if (!runtime?.scan) return pass;

  const transfers: DecodedTransfer[] = [];
  for (const encoded of transactions) {
    let found: DecodedTransfer[] | null = null;
    try {
      found = transfersFrom(fromBase64(encoded), account);
    } catch {
      found = null;
    }
    if (found) transfers.push(...found);
  }
  if (transfers.length === 0) return pass;

  const time = Math.floor(core.env.now() / 1000);
  const warnings = new Map<string, ReviewWarning>();
  for (const transfer of transfers) {
    const sol = transfer.program === "system";
    const amount = sol
      ? Number(transfer.amount) / 1e9
      : transfer.decimals !== undefined
        ? Number(transfer.amount) / 10 ** transfer.decimals
        : Number(transfer.amount);
    const findings = assessOutgoingTransfer({
      flows: runtime.scan.flows,
      transfer: { to: transfer.destination, amount, asset: sol ? "SOL" : (transfer.mint ?? "SPL"), time },
    });
    for (const finding of findings) {
      if (finding.severity === "low" && !settings.warnFirstRecipients) continue;
      warnings.set(`${finding.id}:${transfer.destination}`, { id: finding.id, severity: finding.severity, title: finding.title, detail: finding.detail });
    }
  }
  if (warnings.size === 0) return pass;
  return { action: "warn", warnings: [...warnings.values()].slice(0, 8), transfers: transfers.slice(0, 8).map(describe) };
}
