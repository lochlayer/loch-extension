// The Loch wallet: a Wallet Standard wallet that passes everything on to the user's own wallet
// after two checks.
//
//   the key-derivation guard   a request whose bytes or text carry the Loch key-derivation
//                              message is not passed on. Every feature that signs is covered:
//                              signMessage, signIn, signTransaction, signAndSendTransaction,
//                              and whatever else the wallet offers.
//   the leak warning           a transaction is shown to the extension, which may warn; the
//                              user decides, and only "Cancel" stops the request.
//
// What this is not: a barrier. The real wallet is on the same page, and a site can ask it
// directly without ever touching this object. These checks help on sites that behave. Against a
// site that does not, the real wallet's own prompt is all there is.
//
// What the checks themselves hold against, for a request that does come through here:
//
//   - Each input is read exactly once. Objects and arrays are rebuilt, every byte array is
//     copied, and that copy is both what is checked and what the wallet is given. A value that
//     reads differently the second time (a getter, a proxy) has only its first reading.
//   - Nothing on the decision path calls a method the page could have replaced: the built-ins
//     come from safe.ts, captured before the page ran.
//   - The wallet gets its own account objects back, the same objects (wallets compare them by
//     identity). Everything else it gets is the copy.
//
// A check that cannot be made (the extension does not answer) never blocks a transaction. An
// input that cannot be read (too large, a getter that throws) is not passed on.

import { containsKeyDerivation, textContainsKeyDerivation } from "../shared/guard.js";
import { type Bytes, PromiseCtor, type Snapshot, apply, charCodeAt, keysOf, listOf, own, put, read, snapshot, whenSettled } from "./safe.js";
import type { StandardWallet } from "./standard.js";

/** Transactions looked at in one request. A request with more is passed on unreviewed. */
const MAX_REVIEWED = 8;
/** Addresses reported per request. */
const MAX_ACCOUNTS = 16;

export interface WrapperHooks {
  /** The site asked for the key-derivation signature. Tell the user why it was not passed on. */
  blockedKeyDerivation(): void;
  /** Calls `done` once: true to go on, false when the user cancelled. Called with copies of the transactions. */
  reviewTransactions(account: string, transactions: Bytes[], done: (allow: boolean) => void): void;
  /** Addresses the real wallet gave this page, through the Loch wallet's connect or its account list. */
  accounts(addresses: string[]): void;
}

/** What a site sees when Loch stops a request: the code wallets use for "the user said no". */
export class LochRefusal extends Error {
  readonly code = 4001;
  constructor(message: string) {
    super(message);
    this.name = "WalletSignError";
  }
}

export const BLOCKED_MESSAGE =
  "Loch did not pass this request on. Signing the Loch key derivation message would hand over your shielded balance. Loch never asks for it from a website.";
export const CANCELLED_MESSAGE = "Cancelled in Loch before signing.";
export const UNREADABLE_MESSAGE = "Loch could not read this request, so it did not pass it on.";

type AnyFunction = (...args: unknown[]) => unknown;

function hasPrefix(text: string, prefix: string): boolean {
  if (text.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (charCodeAt(text, i) !== charCodeAt(prefix, i)) return false;
  return true;
}

function carriesKeyDerivation(snap: Snapshot): boolean {
  for (let i = 0; i < snap.bytes.length; i++) {
    const item = snap.bytes[i]!;
    if (containsKeyDerivation(item.bytes, item.length)) return true;
  }
  for (let i = 0; i < snap.strings.length; i++) {
    if (textContainsKeyDerivation(snap.strings[i]!, charCodeAt)) return true;
  }
  return false;
}

/** The transactions of a signTransaction or signAndSendTransaction request, if it has the shape of one. */
function transactionsOf(snap: Snapshot): { account: string; transactions: Bytes[] } | null {
  let account: string | null = null;
  const transactions: Bytes[] = [];
  const count = snap.value.length;
  if (count === 0 || count > MAX_REVIEWED) return null;
  for (let i = 0; i < count; i++) {
    const input = snap.value[i];
    const transaction = own(input, "transaction");
    // The account is the wallet's own object when the site passed that, and a copy otherwise.
    const address = read(own(input, "account"), "address");
    if (typeof address !== "string") return null;
    let bytes: Bytes | null = null;
    for (let j = 0; j < snap.bytes.length; j++) if (snap.bytes[j]!.bytes === transaction) bytes = snap.bytes[j]!;
    if (!bytes) return null;
    account ??= address;
    if (address !== account) return null;
    put(transactions, i, bytes);
  }
  return account === null ? null : { account, transactions };
}

/**
 * Builds the Loch wallet in front of `target`. Every feature the real wallet has is offered,
 * and every method of every feature is called through the checks above.
 */
export function createLochWallet(target: StandardWallet, hooks: WrapperHooks, icon: string): StandardWallet {
  let reported = "";

  /** Tells the extension which addresses the real wallet has given this page. */
  const report = (accounts: unknown): void => {
    const list = listOf(accounts, MAX_ACCOUNTS);
    const addresses: string[] = [];
    let joined = "";
    for (let i = 0; i < list.length; i++) {
      const address = read(list[i], "address");
      if (typeof address !== "string" || address.length < 32 || address.length > 44) continue;
      put(addresses, addresses.length, address);
      joined += `${address},`;
    }
    if (addresses.length === 0 || joined === reported) return;
    reported = joined;
    hooks.accounts(addresses);
  };

  /** The account objects the wallet holds now. They are handed back to it as they are. */
  const walletAccounts = (): unknown[] => listOf(read(target, "accounts"), 64);

  /** Copies the arguments and runs the key-derivation guard. Throws LochRefusal when the request is not to go on. */
  const admit = (inputs: unknown[], strict: boolean): Snapshot => {
    const kept = walletAccounts();
    let snap: Snapshot;
    try {
      snap = snapshot(inputs, inputs.length, kept, kept.length, strict);
    } catch {
      throw new LochRefusal(UNREADABLE_MESSAGE);
    }
    if (carriesKeyDerivation(snap)) {
      hooks.blockedKeyDerivation();
      throw new LochRefusal(BLOCKED_MESSAGE);
    }
    return snap;
  };

  /** A method of a Solana signing feature: asynchronous, its inputs plain data. */
  const signing = (original: object, method: AnyFunction, reviewed: boolean): AnyFunction => {
    return (...inputs: unknown[]) =>
      new PromiseCtor<unknown>((resolve, reject) => {
        let snap: Snapshot;
        try {
          snap = admit(inputs, true);
        } catch (error) {
          reject(error);
          return;
        }
        const call = (): void => {
          try {
            resolve(apply(method, original, snap.value));
          } catch (error) {
            reject(error);
          }
        };
        const found = reviewed ? transactionsOf(snap) : null;
        if (!found) {
          call();
          return;
        }
        // No promise of this script's stands between the verdict and the call: a page that has
        // replaced Promise.prototype.then gets no hold on the decision.
        hooks.reviewTransactions(found.account, found.transactions, (allow) => {
          if (allow) call();
          else reject(new LochRefusal(CANCELLED_MESSAGE));
        });
      });
  };

  /** A method of any other feature: called as the wallet's own would be, after the guard. */
  const guarded = (original: object, method: AnyFunction): AnyFunction => {
    return (...inputs: unknown[]) => apply(method, original, admit(inputs, false).value);
  };

  /** connect: the wallet's answer is what tells the extension which accounts this page was given. */
  const connecting = (original: object, method: AnyFunction): AnyFunction => {
    return (...inputs: unknown[]) => {
      const result = apply(method, original, admit(inputs, false).value);
      whenSettled(
        result,
        () => report(read(target, "accounts")),
        () => undefined,
      );
      return result;
    };
  };

  const wrapFeature = (name: string, feature: unknown): unknown => {
    if (typeof feature !== "object" || feature === null) return feature;
    const wrapped: Record<string, unknown> = {};
    const keys = keysOf(feature);
    const solana = hasPrefix(name, "solana:");
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const value = read(feature, key);
      if (typeof value !== "function") {
        put(wrapped, key, value);
        continue;
      }
      const method = value as AnyFunction;
      if (name === "standard:connect") put(wrapped, key, connecting(feature, method));
      else if (solana) put(wrapped, key, signing(feature, method, name === "solana:signTransaction" || name === "solana:signAndSendTransaction"));
      else put(wrapped, key, guarded(feature, method));
    }
    return wrapped;
  };

  const wrapFeatures = (features: unknown): Record<string, unknown> => {
    const wrapped: Record<string, unknown> = {};
    if (typeof features !== "object" || features === null) return wrapped;
    const names = keysOf(features);
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      if (name === "standard:events") continue;
      put(wrapped, name, wrapFeature(name, read(features, name)));
    }
    const events = read(features, "standard:events");
    const on = read(events, "on");
    if (typeof events === "object" && events !== null && typeof on === "function") {
      const copy: Record<string, unknown> = {};
      const keys = keysOf(events);
      for (let i = 0; i < keys.length; i++) put(copy, keys[i]!, read(events, keys[i]!));
      // Change events carry the wallet's features and accounts. A site must get the wrapped
      // features, and the extension must hear of the accounts.
      put(copy, "on", (event: unknown, listener: unknown) =>
        apply(on as AnyFunction, events, [
          event,
          (properties: unknown) => {
            if (typeof listener !== "function") return;
            const changedFeatures = read(properties, "features");
            const changedAccounts = read(properties, "accounts");
            if (changedAccounts !== undefined) report(changedAccounts);
            if (typeof changedFeatures !== "object" || changedFeatures === null) {
              (listener as AnyFunction)(properties);
              return;
            }
            const next: Record<string, unknown> = {};
            const keysOfChange = keysOf(properties as object);
            for (let i = 0; i < keysOfChange.length; i++) put(next, keysOfChange[i]!, read(properties, keysOfChange[i]!));
            put(next, "features", wrapFeatures(changedFeatures));
            (listener as AnyFunction)(next);
          },
        ]),
      );
      put(wrapped, "standard:events", copy);
    }
    return wrapped;
  };

  return Object.freeze({
    version: "1.0.0" as const,
    name: "Loch",
    icon,
    get chains() {
      return target.chains;
    },
    get accounts() {
      // The real wallet's own account objects: it recognises them when they come back. A wallet
      // lists accounts only for a site the user approved, so listing them here is the same
      // grant as a connect.
      const accounts = target.accounts;
      report(accounts);
      return accounts;
    },
    get features() {
      return wrapFeatures(target.features) as Readonly<Record<string, unknown>>;
    },
  });
}
