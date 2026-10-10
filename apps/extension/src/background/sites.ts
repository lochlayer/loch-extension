// Which public addresses a website has been given by the user's wallet, through the Loch wallet.
//
// The leak warning looks at a transaction a site wants signed and may show a dialog. Whether a
// dialog appears is something the site can see. If the worker reviewed a transaction for any
// address a site cares to name, a site could name addresses until one drew a dialog and so
// learn which public address this browser's Loch wallet belongs to, without ever being
// connected to anything.
//
// So a review is made only for an address the site already has: one the real wallet gave it
// (in the answer to a connect made through the Loch wallet, or in the account list a wallet
// shows only to a site the user approved). For every other address the answer is "pass", at
// once, exactly as for an address that is not a Loch wallet at all.
//
// Kept per origin, in session storage (memory, gone when the browser closes), a few addresses
// each. The report comes from the page script, which runs in the page's world: a site that
// replaces the wallet objects can make it report addresses of its choosing. That buys such a
// site at most MAX_SITE_ACCOUNTS guesses per browser session, each needing a click (the content
// script forwards a review only during a user gesture). See README, "What the wrapper cannot do".

import { MAX_SITE_ACCOUNTS } from "../shared/messages.js";
import type { Core } from "./core.js";

const KEY = "sites";
/** Origins remembered. The oldest is dropped beyond this. */
const MAX_SITES = 200;

type Sites = Record<string, string[]>;

async function load(core: Core): Promise<Sites> {
  const stored = await core.env.session.get<Sites>(KEY);
  return stored && typeof stored === "object" ? stored : {};
}

/**
 * Remembers that `origin` was given `accounts`. The first MAX_SITE_ACCOUNTS addresses of an
 * origin are kept and later ones are ignored, so a site cannot rotate through candidates.
 */
export async function noteSiteAccounts(core: Core, origin: string, accounts: readonly string[]): Promise<void> {
  const sites = await load(core);
  const known = sites[origin] ?? [];
  const next = [...known];
  for (const account of accounts) {
    if (next.length >= MAX_SITE_ACCOUNTS) break;
    if (!next.includes(account)) next.push(account);
  }
  if (next.length === known.length) return;
  // Re-inserted last, so the origin counts as the most recently used.
  delete sites[origin];
  sites[origin] = next;
  const origins = Object.keys(sites);
  for (const stale of origins.slice(0, Math.max(0, origins.length - MAX_SITES))) delete sites[stale];
  await core.env.session.set(KEY, sites);
}

export async function siteHasAccount(core: Core, origin: string | null, account: string): Promise<boolean> {
  if (origin === null) return false;
  return (await load(core))[origin]?.includes(account) === true;
}

/** Drops `address` from every site's list ("forget this wallet"). */
export async function forgetSiteAccount(core: Core, address: string): Promise<void> {
  const sites = await load(core);
  let changed = false;
  for (const origin of Object.keys(sites)) {
    const kept = sites[origin]!.filter((account) => account !== address);
    if (kept.length === sites[origin]!.length) continue;
    changed = true;
    if (kept.length > 0) sites[origin] = kept;
    else delete sites[origin];
  }
  if (changed) await core.env.session.set(KEY, sites);
}
