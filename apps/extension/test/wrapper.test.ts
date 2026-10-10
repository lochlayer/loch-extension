import { ed25519 } from "@noble/curves/ed25519";
import { base58, base64, hex } from "@scure/base";
import { Keypair, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { reviewTransactions } from "../src/background/review.js";
import { tokenAmount } from "../src/background/review.js";
import { handleContent, handleUi } from "../src/background/router.js";
import { answerBridgeRequest } from "../src/inpage/bridge.js";
import { type StandardWallet, isSolanaWallet, registerWallet, watchWallets } from "../src/inpage/standard.js";
import { BLOCKED_MESSAGE, CANCELLED_MESSAGE, LochRefusal, UNREADABLE_MESSAGE, type WrapperHooks, createLochWallet } from "../src/inpage/wrapper.js";
import { toBase64, utf8 } from "../src/shared/bytes.js";
import { KEY_DERIVATION_TEXT } from "../src/shared/constants.js";
import { ENCODED_MESSAGE, containsKeyDerivation, textContainsKeyDerivation } from "../src/shared/guard.js";
import { createHarness } from "./harness.js";
import { connect } from "./steps.js";

/** UTF-8 bytes made without anything a test below replaces (TextEncoder is not among them). */
const utf8Raw = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------- a real wallet

/** A Wallet Standard wallet as an extension would register it, with a real key, recording what it is given. */
function realWallet() {
  const keypair = Keypair.generate();
  const account = Object.freeze({
    address: keypair.publicKey.toBase58(),
    publicKey: keypair.publicKey.toBytes(),
    chains: ["solana:devnet"],
    features: ["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"],
  });
  const calls: { method: string; inputs: unknown[] }[] = [];
  const listeners: ((properties: unknown) => void)[] = [];
  let connected = false;
  const features = {
    "standard:connect": {
      version: "1.0.0",
      connect: async (input?: unknown) => {
        calls.push({ method: "connect", inputs: [input] });
        connected = true;
        return { accounts: [account] };
      },
    },
    "standard:disconnect": { version: "1.0.0", disconnect: async () => void (connected = false) },
    "standard:events": {
      version: "1.0.0",
      on: (_event: string, listener: (properties: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
    "solana:signMessage": {
      version: "1.1.0",
      signMessage: async (...inputs: { account: unknown; message: Uint8Array }[]) => {
        calls.push({ method: "signMessage", inputs });
        return inputs.map((input) => {
          if (input.account !== account) throw new Error("invalid account");
          return { signedMessage: input.message, signature: ed25519.sign(input.message, keypair.secretKey.slice(0, 32)) };
        });
      },
    },
    "solana:signTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: { account: unknown; transaction: Uint8Array }[]) => {
        calls.push({ method: "signTransaction", inputs });
        return inputs.map((input) => {
          if (input.account !== account) throw new Error("invalid account");
          return { signedTransaction: input.transaction };
        });
      },
    },
    "solana:signAndSendTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signAndSendTransaction: async (...inputs: unknown[]) => {
        calls.push({ method: "signAndSendTransaction", inputs });
        return inputs.map(() => ({ signature: new Uint8Array(64) }));
      },
    },
    "solana:signIn": {
      version: "1.0.0",
      signIn: async (...inputs: unknown[]) => {
        calls.push({ method: "signIn", inputs });
        return [];
      },
    },
    "phantom:custom": { version: "1.0.0", anything: () => "passes through" },
  };
  const wallet: StandardWallet = {
    version: "1.0.0",
    name: "Phantom",
    icon: "data:image/svg+xml;base64,AAAA",
    chains: ["solana:mainnet", "solana:devnet"],
    features,
    get accounts() {
      return connected ? [account] : [];
    },
  };
  return { wallet, keypair, account, calls, features, emit: (properties: unknown) => listeners.forEach((listener) => listener(properties)) };
}

type Signer = { signMessage: (...inputs: unknown[]) => Promise<unknown[]> };
type TxSigner = { signTransaction: (...inputs: unknown[]) => Promise<{ signedTransaction: Uint8Array }[]>; supportedTransactionVersions: unknown };
type Connect = { connect: (input?: unknown) => Promise<unknown> };

function wrapped(decision: boolean | "never" = true) {
  const real = realWallet();
  const events = { blocked: 0, reviewed: [] as { account: string; transactions: Uint8Array[] }[], accounts: [] as string[][] };
  const hooks: WrapperHooks = {
    blockedKeyDerivation: () => void events.blocked++,
    reviewTransactions: (account, transactions, done) => {
      // Written so that a test which replaces Array.prototype.push still sees what was reviewed.
      events.reviewed = [...events.reviewed, { account, transactions: transactions.map((item) => item.bytes) }];
      // The extension answers later, as it does in the browser. "never": the user has not decided.
      if (decision !== "never") setTimeout(() => done(decision), 0);
    },
    accounts: (addresses) => void (events.accounts = [...events.accounts, addresses]),
  };
  const loch = createLochWallet(real.wallet, hooks, "data:image/svg+xml;base64,TG9jaA==");
  return { real, loch, events };
}

const connectLoch = (loch: StandardWallet) => (loch.features["standard:connect"] as Connect).connect();
const lastInput = <T,>(real: ReturnType<typeof realWallet>, method: string) => real.calls.filter((call) => call.method === method).at(-1)?.inputs[0] as T;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function transferBytes(from: Keypair, lamports = 1_250_000_000): Uint8Array {
  const message = new TransactionMessage({
    payerKey: from.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: Keypair.generate().publicKey, lamports })],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}

// ------------------------------------------------------- the key-derivation guard

describe("the key-derivation guard", () => {
  it("recognises the message, alone or inside another, in any letter case", () => {
    expect(containsKeyDerivation(utf8(KEY_DERIVATION_TEXT))).toBe(true);
    expect(containsKeyDerivation(utf8(`Sign in to Example.\n\n${KEY_DERIVATION_TEXT}\nNonce: 1`))).toBe(true);
    expect(containsKeyDerivation(utf8("LOCH KEY DERIVATION V1"))).toBe(true);
    expect(containsKeyDerivation(utf8("loch key derivation v1"))).toBe(true);
    expect(containsKeyDerivation(Uint8Array.of(0xff, ...utf8(KEY_DERIVATION_TEXT), 0x00))).toBe(true);
    expect(textContainsKeyDerivation(`Please confirm: ${KEY_DERIVATION_TEXT}`)).toBe(true);
  });

  it("recognises the exact message handed over as hex, base64 or base58 text", () => {
    const bytes = utf8(KEY_DERIVATION_TEXT);
    expect(ENCODED_MESSAGE.hex).toBe(hex.encode(bytes));
    expect(ENCODED_MESSAGE.base58).toBe(base58.encode(bytes));
    expect(base64.encode(bytes).startsWith(ENCODED_MESSAGE.base64)).toBe(true);
    for (const text of [hex.encode(bytes), hex.encode(bytes).toUpperCase(), `0x${hex.encode(bytes)}`, base64.encode(bytes), base58.encode(bytes), `{"message":"${base58.encode(bytes)}"}`]) {
      expect(textContainsKeyDerivation(text), text).toBe(true);
    }
  });

  it("leaves other messages alone", () => {
    for (const text of ["", "Sign in to Example", "Loch key derivation v", "Loch key derivation v2", "Loch  key derivation v1", "key derivation"]) {
      expect(containsKeyDerivation(utf8(text)), text).toBe(false);
      expect(textContainsKeyDerivation(text), text).toBe(false);
    }
    expect(textContainsKeyDerivation("Łoch key derivation v1")).toBe(false);
  });

  it("the Loch wallet does not pass the message on, and the real wallet never sees it", async () => {
    const { real, loch, events } = wrapped();
    await connectLoch(loch);
    const signer = loch.features["solana:signMessage"] as Signer;
    const attempt = signer.signMessage({ account: loch.accounts[0], message: utf8(KEY_DERIVATION_TEXT) });
    await expect(attempt).rejects.toBeInstanceOf(LochRefusal);
    await expect(attempt).rejects.toMatchObject({ message: BLOCKED_MESSAGE, code: 4001 });
    expect(events.blocked).toBe(1);
    expect(real.calls.filter((call) => call.method === "signMessage")).toEqual([]);
  });

  it("refuses a batch if any message in it is the key-derivation message", async () => {
    const { real, loch } = wrapped();
    await connectLoch(loch);
    const signer = loch.features["solana:signMessage"] as Signer;
    await expect(
      signer.signMessage({ account: loch.accounts[0], message: utf8("hello") }, { account: loch.accounts[0], message: utf8(`x ${KEY_DERIVATION_TEXT}`) }),
    ).rejects.toBeInstanceOf(LochRefusal);
    expect(real.calls.filter((call) => call.method === "signMessage")).toEqual([]);
  });

  it("refuses a sign-in that carries the message, in any field, at any depth", async () => {
    const { real, loch, events } = wrapped();
    const signIn = loch.features["solana:signIn"] as { signIn: (...inputs: unknown[]) => Promise<unknown> };
    await expect(signIn.signIn({ domain: "example.org", statement: KEY_DERIVATION_TEXT })).rejects.toBeInstanceOf(LochRefusal);
    await expect(signIn.signIn({ domain: "example.org", resources: ["https://example.org", `urn:${KEY_DERIVATION_TEXT.toUpperCase()}`] })).rejects.toBeInstanceOf(LochRefusal);
    expect(events.blocked).toBe(2);
    await signIn.signIn({ domain: "example.org", statement: "Welcome back" });
    expect(real.calls.filter((call) => call.method === "signIn")).toHaveLength(1);
  });

  it("refuses a transaction whose bytes carry the message", async () => {
    const { real, loch, events } = wrapped();
    await connectLoch(loch);
    const bytes = Uint8Array.of(1, 2, 3, ...utf8(KEY_DERIVATION_TEXT), 4, 5);
    for (const [feature, method] of [
      ["solana:signTransaction", "signTransaction"],
      ["solana:signAndSendTransaction", "signAndSendTransaction"],
    ] as const) {
      const call = (loch.features[feature] as Record<string, (...inputs: unknown[]) => Promise<unknown>>)[method]!;
      await expect(call({ account: loch.accounts[0], transaction: bytes, chain: "solana:devnet" })).rejects.toMatchObject({ message: BLOCKED_MESSAGE });
      // The exact message as the whole "transaction", too.
      await expect(call({ account: loch.accounts[0], transaction: utf8(KEY_DERIVATION_TEXT) })).rejects.toMatchObject({ message: BLOCKED_MESSAGE });
    }
    expect(events.blocked).toBe(4);
    expect(events.reviewed).toEqual([]);
    expect(real.calls.filter((call) => call.method !== "connect")).toEqual([]);
  });

  it("covers a feature it has never heard of: whatever is handed to the wallet is looked at first", async () => {
    const { real, loch, events } = wrapped();
    const seen: unknown[][] = [];
    (real.features as Record<string, unknown>)["vendor:signRaw"] = { version: "1.0.0", signRaw: (...inputs: unknown[]) => (seen.push(inputs), "signed") };
    const vendor = () => (loch.features["vendor:signRaw"] as { signRaw: (...inputs: unknown[]) => unknown }).signRaw;
    expect(() => vendor()({ payload: utf8(KEY_DERIVATION_TEXT) })).toThrow(LochRefusal);
    expect(() => vendor()([{ nested: { deep: [KEY_DERIVATION_TEXT] } }])).toThrow(LochRefusal);
    expect(() => vendor()(hex.encode(utf8(KEY_DERIVATION_TEXT)))).toThrow(LochRefusal);
    expect(() => vendor()(utf8(KEY_DERIVATION_TEXT).buffer)).toThrow(LochRefusal);
    expect(() => vendor()(new DataView(utf8(`..${KEY_DERIVATION_TEXT}`).buffer))).toThrow(LochRefusal);
    expect(seen).toEqual([]);
    expect(events.blocked).toBe(5);
    // Anything else goes through, synchronously, with what the method returns.
    expect(vendor()({ payload: utf8("hello"), note: "hi" })).toBe("signed");
    expect(seen).toHaveLength(1);
  });

  it("passes every other message through, byte for byte, and returns the wallet's own answer", async () => {
    const { real, loch, events } = wrapped();
    await connectLoch(loch);
    const message = utf8("Sign in to Example");
    const input = { account: loch.accounts[0], message };
    const [output] = (await (loch.features["solana:signMessage"] as Signer).signMessage(input)) as { signature: Uint8Array }[];
    const given = lastInput<{ account: unknown; message: Uint8Array }>(real, "signMessage");
    // The wallet's own account object, and a copy of the bytes: not the site's objects.
    expect(given.account).toBe(real.account);
    expect(given).not.toBe(input);
    expect(given.message).not.toBe(message);
    expect(same(given.message, message)).toBe(true);
    expect(ed25519.verify(output!.signature, message, real.keypair.publicKey.toBytes())).toBe(true);
    expect(events.blocked).toBe(0);
  });
});

// ---------------------------------------------- finding 5: a page that tries to get past it

describe("finding 5: what the guard holds against, for a request that comes through the Loch wallet", () => {
  it("a message that reads differently the second time: it is read once, and the wallet gets what was checked", async () => {
    const { real, loch, events } = wrapped();
    await connectLoch(loch);
    const account = loch.accounts[0];
    let reads = 0;
    const twoFaced = {
      account,
      get message() {
        return reads++ === 0 ? utf8("hello") : utf8(KEY_DERIVATION_TEXT);
      },
    };
    await (loch.features["solana:signMessage"] as Signer).signMessage(twoFaced);
    // Before the fix: the guard saw "hello" and the wallet signed the key-derivation message.
    expect(reads).toBe(1);
    expect(same(lastInput<{ message: Uint8Array }>(real, "signMessage").message, utf8("hello"))).toBe(true);

    // And the other way round: if the first reading is the key-derivation message, nothing is signed.
    let again = 0;
    const reversed = {
      account,
      get message() {
        return again++ === 0 ? utf8(KEY_DERIVATION_TEXT) : utf8("hello");
      },
    };
    await expect((loch.features["solana:signMessage"] as Signer).signMessage(reversed)).rejects.toMatchObject({ message: BLOCKED_MESSAGE });
    expect(real.calls.filter((call) => call.method === "signMessage")).toHaveLength(1);
    expect(events.blocked).toBe(1);
  });

  it("a proxy, an array that changes, bytes that change after the call: only the first reading counts", async () => {
    const { real, loch } = wrapped();
    await connectLoch(loch);
    const account = loch.accounts[0];
    const signer = loch.features["solana:signMessage"] as Signer;
    // A proxy that answers "message" once with something harmless.
    let asked = 0;
    const proxy = new Proxy({ account, message: utf8("hello") }, { get: (target, key) => (key === "message" && asked++ > 0 ? utf8(KEY_DERIVATION_TEXT) : Reflect.get(target, key)) });
    await signer.signMessage(proxy);
    expect(same(lastInput<{ message: Uint8Array }>(real, "signMessage").message, utf8("hello"))).toBe(true);

    // Bytes the site rewrites right after the call returns, before the wallet reads them.
    const mutable = utf8("hello, this is a harmless text");
    const pending = signer.signMessage({ account, message: mutable });
    mutable.set(utf8(KEY_DERIVATION_TEXT));
    await pending;
    expect(same(lastInput<{ message: Uint8Array }>(real, "signMessage").message, utf8("hello, this is a harmless text"))).toBe(true);

    // The inputs array itself, with a getter on its element.
    const inputs: unknown[] = [];
    let element = 0;
    Object.defineProperty(inputs, 0, { enumerable: true, get: () => ({ account, message: element++ === 0 ? utf8("fine") : utf8(KEY_DERIVATION_TEXT) }) });
    await (signer.signMessage as (...args: unknown[]) => Promise<unknown>)(inputs[0]);
    expect(same(lastInput<{ message: Uint8Array }>(real, "signMessage").message, utf8("fine"))).toBe(true);
  });

  it("replacing ArrayBuffer.isView, typed-array getters, array methods and Promise.prototype.then changes nothing", async () => {
    const { real, loch, events } = wrapped(false);
    await connectLoch(loch);
    const account = loch.accounts[0];
    // Everything the page needs is made before it starts replacing things.
    const derivation = utf8(KEY_DERIVATION_TEXT);
    const transfer = transferBytes(real.keypair);
    const signMessage = (loch.features["solana:signMessage"] as Signer).signMessage;
    const signIn = (loch.features["solana:signIn"] as { signIn: (input: unknown) => Promise<unknown> }).signIn;
    const signTransaction = (loch.features["solana:signTransaction"] as TxSigner).signTransaction;
    const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
    const saved = {
      isView: ArrayBuffer.isView,
      length: Object.getOwnPropertyDescriptor(typed, "length")!,
      byteLength: Object.getOwnPropertyDescriptor(typed, "byteLength")!,
      push: Array.prototype.push,
      then: Promise.prototype.then,
      constructor: Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")!,
      charCodeAt: String.prototype.charCodeAt,
      keys: Object.keys,
      includes: Array.prototype.includes,
    };
    /** What became of a promise, observed through the real `then`. */
    const outcome = (promise: Promise<unknown>) => {
      const result: { settled: string | null; message?: string } = { settled: null };
      saved.then.call(
        promise,
        () => void (result.settled = "resolved"),
        (error: Error) => void Object.assign(result, { settled: "rejected", message: error.message }),
      );
      return result;
    };
    let forged = 0;
    let outcomes: ReturnType<typeof outcome>[] = [];
    try {
      ArrayBuffer.isView = (() => false) as unknown as typeof ArrayBuffer.isView; // "that is not bytes, nothing to check"
      Object.defineProperty(typed, "length", { configurable: true, get: () => 0 }); // "an empty message"
      Object.defineProperty(typed, "byteLength", { configurable: true, get: () => 0 });
      Array.prototype.push = function () {
        return 0;
      };
      String.prototype.charCodeAt = () => 0;
      Object.keys = () => [];
      Array.prototype.includes = () => false;
      // A page that answers every promise reaction itself with "allowed". With the constructor
      // changed as well, even an `await` of a native promise goes through this `then`.
      Object.defineProperty(Promise.prototype, "constructor", { configurable: true, writable: true, value: function NotPromise() {} });
      Promise.prototype.then = function (this: Promise<unknown>, onFulfilled) {
        forged++;
        return saved.then.call(this, () => (onFulfilled as ((value: unknown) => unknown) | undefined)?.(true), undefined);
      } as typeof Promise.prototype.then;

      outcomes = [
        // The key-derivation message is still recognised, as bytes and as text.
        outcome(signMessage({ account, message: derivation })),
        outcome(signIn({ statement: KEY_DERIVATION_TEXT })),
        // And a transaction whose review will say "Cancel" is not passed on because a reaction was forged.
        outcome(signTransaction({ account, transaction: transfer })),
      ];
    } finally {
      ArrayBuffer.isView = saved.isView;
      Object.defineProperty(typed, "length", saved.length);
      Object.defineProperty(typed, "byteLength", saved.byteLength);
      Array.prototype.push = saved.push;
      Promise.prototype.then = saved.then;
      Object.defineProperty(Promise.prototype, "constructor", saved.constructor);
      String.prototype.charCodeAt = saved.charCodeAt;
      Object.keys = saved.keys;
      Array.prototype.includes = saved.includes;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(outcomes).toEqual([
      { settled: "rejected", message: BLOCKED_MESSAGE },
      { settled: "rejected", message: BLOCKED_MESSAGE },
      { settled: "rejected", message: CANCELLED_MESSAGE },
    ]);
    expect(real.calls.filter((call) => call.method !== "connect")).toEqual([]);
    expect(events.blocked).toBe(2);
    expect(events.reviewed).toHaveLength(1);
    expect(forged).toBeGreaterThanOrEqual(0);
  });

  it("a property planted on Object.prototype or Array.prototype does not reach the wallet or the check", async () => {
    const { real, loch, events } = wrapped();
    await connectLoch(loch);
    const account = loch.accounts[0];
    // A wallet that only notes what it was handed (its own code must survive the planting too).
    let handed: { account?: unknown; message?: Uint8Array } | null = null;
    let calls = 0;
    (real.features["solana:signMessage"] as { signMessage: unknown }).signMessage = async (input: { account?: unknown; message?: Uint8Array }) => {
      calls++;
      handed = input;
      return [];
    };
    const signMessage = (loch.features["solana:signMessage"] as Signer).signMessage;
    const derivation = utf8(KEY_DERIVATION_TEXT);
    const hello = utf8("hello");
    const inherited = utf8("inherited");
    let blocked: Promise<unknown>;
    let passed: Promise<unknown>;
    try {
      // An index setter that swallows what a careless wrapper collects, and a transaction and
      // an address that every object "has".
      Object.defineProperty(Array.prototype, 0, { configurable: true, set: () => undefined, get: () => undefined });
      Object.defineProperty(Object.prototype, "transaction", { configurable: true, get: () => inherited });
      Object.defineProperty(Object.prototype, "address", { configurable: true, get: () => "inherited" });
      blocked = signMessage({ account, message: derivation });
      passed = signMessage({ account, message: hello });
    } finally {
      delete (Array.prototype as unknown as Record<number, unknown>)[0];
      delete (Object.prototype as unknown as Record<string, unknown>).transaction;
      delete (Object.prototype as unknown as Record<string, unknown>).address;
    }
    await expect(blocked).rejects.toMatchObject({ message: BLOCKED_MESSAGE });
    await passed;
    expect(events.blocked).toBe(1);
    expect(calls).toBe(1);
    // The wallet got the one message that was passed, and nothing that was merely inherited.
    const given = handed as unknown as { account: unknown; message: Uint8Array };
    expect(given.account).toBe(real.account);
    expect(same(given.message, hello)).toBe(true);
    expect(Object.keys(given).sort()).toEqual(["account", "message"]);
  });

  it("a transaction that reads differently the second time: the extension is shown what the wallet is given", async () => {
    const { real, loch, events } = wrapped(true);
    await connectLoch(loch);
    const account = loch.accounts[0];
    const harmless = transferBytes(real.keypair, 1);
    const other = transferBytes(real.keypair, 9_000_000_000);
    let reads = 0;
    const swapped = {
      account,
      chain: "solana:devnet",
      get transaction() {
        return reads++ === 0 ? harmless : other;
      },
    };
    await (loch.features["solana:signTransaction"] as TxSigner).signTransaction(swapped);
    expect(reads).toBe(1);
    const given = lastInput<{ transaction: Uint8Array; chain: string }>(real, "signTransaction");
    // Before the fix: Loch reviewed `harmless` and the wallet was handed `other`.
    expect(same(given.transaction, harmless)).toBe(true);
    expect(given.chain).toBe("solana:devnet");
    expect(events.reviewed).toHaveLength(1);
    expect(events.reviewed[0]!.transactions[0]).toBe(given.transaction);
  });

  it("bytes from another frame, a view over a larger buffer, and a subclass are all copied by what they hold", async () => {
    const { real, loch } = wrapped();
    await connectLoch(loch);
    const account = loch.accounts[0];
    const signer = loch.features["solana:signMessage"] as Signer;
    // A typed array with a lying own `length`, `buffer` and `byteLength`.
    const lying = utf8(KEY_DERIVATION_TEXT);
    Object.defineProperty(lying, "length", { value: 0 });
    Object.defineProperty(lying, "byteLength", { value: 0 });
    Object.defineProperty(lying, "buffer", { value: new ArrayBuffer(0) });
    await expect(signer.signMessage({ account, message: lying })).rejects.toMatchObject({ message: BLOCKED_MESSAGE });
    // A view into the middle of a buffer: only the viewed bytes go on.
    const backing = utf8("____hello____");
    await signer.signMessage({ account, message: backing.subarray(4, 9) });
    expect(same(lastInput<{ message: Uint8Array }>(real, "signMessage").message, utf8("hello"))).toBe(true);
    // A Buffer (a subclass of Uint8Array).
    await expect(signer.signMessage({ account, message: Buffer.from(KEY_DERIVATION_TEXT) })).rejects.toMatchObject({ message: BLOCKED_MESSAGE });
  });

  it("an input that cannot be read is not passed on", async () => {
    const { real, loch } = wrapped();
    await connectLoch(loch);
    const account = loch.accounts[0];
    const signer = loch.features["solana:signMessage"] as Signer;
    const throwing = {
      account,
      get message(): Uint8Array {
        throw new Error("no");
      },
    };
    await expect(signer.signMessage(throwing)).rejects.toMatchObject({ message: UNREADABLE_MESSAGE, code: 4001 });
    const cyclic: Record<string, unknown> = { account };
    cyclic.self = cyclic;
    await expect(signer.signMessage(cyclic)).rejects.toMatchObject({ message: UNREADABLE_MESSAGE });
    expect(real.calls.filter((call) => call.method === "signMessage")).toEqual([]);
  });
});

// -------------------------------------------------------------- the Loch wallet

describe("the Loch wallet stands in front of the real one", () => {
  it("offers what the real wallet offers, under the name Loch", () => {
    const { real, loch } = wrapped();
    expect(loch.name).toBe("Loch");
    expect(loch.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(loch.chains).toBe(real.wallet.chains);
    expect(Object.keys(loch.features).sort()).toEqual(Object.keys(real.wallet.features).sort());
    expect((loch.features["solana:signTransaction"] as TxSigner).supportedTransactionVersions).toEqual(["legacy", 0]);
    expect((loch.features["standard:connect"] as { version: string }).version).toBe("1.0.0");
    // Every method of every feature goes through the wrapper. None is the wallet's own function.
    expect((loch.features["standard:connect"] as Connect).connect).not.toBe((real.features["standard:connect"] as Connect).connect);
    const custom = loch.features["phantom:custom"] as { anything: () => string; version: string };
    expect(custom.anything()).toBe("passes through");
    expect(custom.version).toBe("1.0.0");
  });

  it("hands out the real wallet's account objects, so the wallet recognises them", async () => {
    const { real, loch } = wrapped();
    expect(loch.accounts).toEqual([]);
    await connectLoch(loch);
    expect(loch.accounts[0]).toBe(real.account);
  });

  it("tells the extension which addresses the wallet gave the page: after a connect, and when the list is read", async () => {
    const { real, loch, events } = wrapped();
    expect(events.accounts).toEqual([]);
    await connectLoch(loch);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.accounts).toEqual([[real.account.address]]);
    // Reading the list again reports nothing new.
    void loch.accounts;
    void loch.accounts;
    expect(events.accounts).toHaveLength(1);
    // A wallet that lists its accounts without a connect (a site it already trusts).
    const trusted = wrapped();
    await (trusted.real.features["standard:connect"] as Connect).connect();
    expect(trusted.events.accounts).toEqual([]);
    expect(trusted.loch.accounts).toHaveLength(1);
    expect(trusted.events.accounts).toEqual([[trusted.real.account.address]]);
  });

  it("gives the wallet exactly the bytes the site passed in, as a copy, and the extension is shown that same copy", async () => {
    const { real, loch, events } = wrapped(true);
    await connectLoch(loch);
    const transaction = transferBytes(real.keypair);
    const original = Uint8Array.from(transaction);
    const input = { account: loch.accounts[0], transaction, chain: "solana:devnet", options: { preflightCommitment: "confirmed" } };
    const [output] = await (loch.features["solana:signTransaction"] as TxSigner).signTransaction(input);
    const given = lastInput<{ account: unknown; transaction: Uint8Array; chain: string; options: { preflightCommitment: string } }>(real, "signTransaction");
    expect(given.account).toBe(real.account);
    expect(given.transaction).not.toBe(transaction);
    expect(same(given.transaction, original)).toBe(true);
    expect(given.transaction).toBeInstanceOf(Uint8Array);
    expect(given.chain).toBe("solana:devnet");
    expect(given.options).toEqual({ preflightCommitment: "confirmed" });
    // The site's own array was not touched.
    expect(same(transaction, original)).toBe(true);
    expect(same(output!.signedTransaction, original)).toBe(true);
    // The extension was shown the very array the wallet was given.
    expect(events.reviewed).toHaveLength(1);
    expect(events.reviewed[0]!.account).toBe(real.account.address);
    expect(events.reviewed[0]!.transactions[0]).toBe(given.transaction);
  });

  it("\"Cancel\" stops the request before the wallet is asked; the site gets a rejection", async () => {
    const { real, loch } = wrapped(false);
    await connectLoch(loch);
    const attempt = (loch.features["solana:signTransaction"] as TxSigner).signTransaction({ account: loch.accounts[0], transaction: transferBytes(real.keypair) });
    await expect(attempt).rejects.toMatchObject({ message: CANCELLED_MESSAGE, code: 4001 });
    expect(real.calls.filter((call) => call.method === "signTransaction")).toEqual([]);
  });

  it("while the user has not decided, the wallet is not asked", async () => {
    const { real, loch, events } = wrapped("never");
    await connectLoch(loch);
    let settled = false;
    void (loch.features["solana:signTransaction"] as TxSigner).signTransaction({ account: loch.accounts[0], transaction: transferBytes(real.keypair) }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.reviewed).toHaveLength(1);
    expect(settled).toBe(false);
    expect(real.calls.filter((call) => call.method === "signTransaction")).toEqual([]);
  });

  it("signAndSendTransaction is reviewed the same way", async () => {
    const { real, loch, events } = wrapped(true);
    await connectLoch(loch);
    const send = loch.features["solana:signAndSendTransaction"] as { signAndSendTransaction: (...inputs: unknown[]) => Promise<unknown> };
    const transaction = transferBytes(real.keypair);
    await send.signAndSendTransaction({ account: loch.accounts[0], transaction, chain: "solana:devnet" });
    expect(events.reviewed).toHaveLength(1);
    expect(real.calls.at(-1)).toMatchObject({ method: "signAndSendTransaction" });
    expect(same(lastInput<{ transaction: Uint8Array }>(real, "signAndSendTransaction").transaction, transaction)).toBe(true);
  });

  it("inputs that are not transactions are not reviewed; the wallet gets a copy and judges them", async () => {
    const { real, loch, events } = wrapped(false);
    const signer = loch.features["solana:signTransaction"] as TxSigner;
    const odd = { account: { address: 5 }, transaction: "not bytes" };
    await signer.signTransaction(odd).catch(() => undefined);
    expect(events.reviewed).toEqual([]);
    expect(lastInput(real, "signTransaction")).toEqual(odd);
    // More transactions than are looked at in one request: passed on unreviewed.
    await connectLoch(loch);
    const many = Array.from({ length: 9 }, () => ({ account: loch.accounts[0], transaction: transferBytes(real.keypair, 1) }));
    await signer.signTransaction(...many);
    expect(events.reviewed).toEqual([]);
    expect(real.calls.at(-1)!.inputs).toHaveLength(9);
  });

  it("change events carry the wrapped features, not the wallet's own", async () => {
    const { real, loch, events } = wrapped();
    const seen: { features?: Record<string, unknown>; accounts?: unknown }[] = [];
    (loch.features["standard:events"] as { on: (event: string, listener: (p: never) => void) => void }).on("change", (properties) => seen.push(properties));
    real.emit({ accounts: [real.account] });
    real.emit({ features: real.wallet.features });
    expect(seen[0]).toEqual({ accounts: [real.account] });
    // An account that arrives in a change event is one the wallet gave the page.
    expect(events.accounts).toEqual([[real.account.address]]);
    expect(seen[1]!.features!["solana:signMessage"]).not.toBe(real.features["solana:signMessage"]);
    const signer = seen[1]!.features!["solana:signMessage"] as Signer;
    await expect(signer.signMessage({ account: real.account, message: utf8(KEY_DERIVATION_TEXT) })).rejects.toBeInstanceOf(LochRefusal);
  });
});

// ----------------------------------------------------------- finding wallets

describe("the Wallet Standard on a page", () => {
  it("finds wallets registered before and after it starts, and registers the Loch wallet for apps", () => {
    const page = new EventTarget();
    const early = realWallet().wallet;
    registerWallet(page, early);
    const registry = watchWallets(page, (wallet) => wallet.name === "Loch");
    expect(registry.list()).toEqual([early]);

    const late = { ...realWallet().wallet, name: "Solflare" };
    registerWallet(page, late);
    expect(registry.list().map((wallet) => wallet.name)).toEqual(["Phantom", "Solflare"]);

    const seenByApp: string[] = [];
    watchWallets(page, () => false).onWallet((wallet) => seenByApp.push(wallet.name));
    const loch = createLochWallet(early, { blockedKeyDerivation: () => undefined, reviewTransactions: (_account, _transactions, done) => done(true), accounts: () => undefined }, "data:image/svg+xml;base64,TG9jaA==");
    registerWallet(page, loch);
    expect(seenByApp).toEqual(["Phantom", "Solflare", "Loch"]);
    // The Loch wallet does not find itself.
    expect(registry.list().map((wallet) => wallet.name)).toEqual(["Phantom", "Solflare"]);
    expect(isSolanaWallet(early)).toBe(true);
    expect(isSolanaWallet({ ...early, chains: ["eip155:1"] })).toBe(false);
  });

  it("the bridge's page half asks the wallet and reports back, and never throws", async () => {
    const real = realWallet();
    expect(await answerBridgeRequest({ kind: "wallets" }, [real.wallet])).toMatchObject({ ok: true, value: { kind: "wallets", wallets: [{ name: "Phantom" }] } });
    expect(await answerBridgeRequest({ kind: "connect", wallet: "Backpack", silent: false }, [real.wallet])).toMatchObject({ ok: false, error: { code: "no-wallet" } });
    const address = real.account.address;
    // Asked for an address the wallet does not hold: it connects, and still has no such account.
    expect(await answerBridgeRequest({ kind: "signMessage", wallet: "Phantom", address: "11111111111111111111111111111111", message: toBase64(utf8("x")) }, [realWallet().wallet])).toMatchObject({
      ok: false,
      error: { code: "no-account" },
    });
    // A page that has just loaded is not connected: signing connects first, quietly and then with a prompt.
    const fresh = realWallet();
    const quiet = await answerBridgeRequest({ kind: "signMessage", wallet: "Phantom", address: fresh.account.address, message: toBase64(utf8("x")) }, [fresh.wallet]);
    expect(quiet.ok).toBe(true);
    expect(fresh.calls.map((call) => call.method)).toEqual(["connect", "signMessage"]);

    const connected = await answerBridgeRequest({ kind: "connect", wallet: "Phantom", silent: false }, [real.wallet]);
    expect(connected).toEqual({ ok: true, value: { kind: "connect", accounts: [{ address, publicKey: toBase64(real.account.publicKey) }] } });

    const message = utf8(KEY_DERIVATION_TEXT);
    const signed = await answerBridgeRequest({ kind: "signMessage", wallet: "Phantom", address, message: toBase64(message) }, [real.wallet]);
    expect(signed.ok && signed.value.kind === "signMessage" && ed25519.verify(Buffer.from(signed.value.signature, "base64"), message, real.account.publicKey)).toBe(true);

    const refusing = { ...real.wallet, features: { ...real.features, "solana:signMessage": { signMessage: async () => Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 })) } } };
    expect(await answerBridgeRequest({ kind: "signMessage", wallet: "Phantom", address, message: "AAAA" }, [refusing])).toEqual({
      ok: false,
      error: { code: "rejected", message: "User rejected the request." },
    });
    const broken = { ...real.wallet, features: { ...real.features, "solana:signTransaction": undefined } };
    expect(await answerBridgeRequest({ kind: "signTransaction", wallet: "Phantom", address, transaction: "AAAA", chain: "solana:devnet" }, [broken as never])).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });
});

// ------------------------------------------------- warnings before a public transfer

describe("leak warnings before a public transfer", () => {
  const NOW_S = 1_790_000_000;

  async function scanned() {
    const h = createHarness();
    await connect(h);
    const regular = Keypair.generate().publicKey.toBase58();
    const funder = Keypair.generate().publicKey.toBase58();
    h.chain.seedTransfers(h.wallet.address, [
      { dir: "in", counterparty: funder, sol: 3, time: NOW_S - 86_400 },
      { dir: "out", counterparty: regular, sol: 0.5, time: NOW_S - 80_000 },
      { dir: "out", counterparty: regular, sol: 0.5, time: NOW_S - 70_000 },
      { dir: "in", counterparty: funder, sol: 1.25, time: NOW_S - 120 },
    ]);
    await handleUi(h.core, { loch: "ui", type: "scan-start" });
    for (const deadline = Date.now() + 20_000; Date.now() < deadline && (await h.core.snapshot()).scan.status !== "done"; ) await new Promise((resolve) => setImmediate(resolve));
    const snapshot = await h.core.snapshot();
    expect(snapshot.scan.status).toBe("done");
    expect(snapshot.scan.report?.transfers).toBe(4);
    return { h, regular, funder };
  }

  const b64 = (bytes: Uint8Array) => toBase64(bytes);
  const transferTo = (from: Keypair, to: string, sol: number): string => {
    const tx = new Transaction({ feePayer: from.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(
      SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new (from.publicKey.constructor as typeof import("@solana/web3.js").PublicKey)(to), lamports: Math.round(sol * 1e9) }),
    );
    return b64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  };

  const DAPP = "https://dapp.example";
  /** The wallet gave the site this account (the Loch wallet reports it when that happens). */
  const given = async (h: Awaited<ReturnType<typeof scanned>>["h"]) => {
    h.tabs.set(9, `${DAPP}/`);
    await handleContent(h.core, h.sender(9, `${DAPP}/`), { loch: "content", type: "accounts", accounts: [h.wallet.address] });
  };

  it("warns when the transfer gives something away: a recurring recipient, an amount passed straight through", async () => {
    const { h, regular } = await scanned();
    await given(h);
    const stranger = Keypair.generate().publicKey.toBase58();

    // A first-time recipient alone is a low finding: it does not interrupt (item 12).
    expect(await reviewTransactions(h.core, DAPP, h.wallet.address, [transferTo(h.wallet.keypair, stranger, 0.2)])).toEqual({ action: "pass" });

    const recurring = await reviewTransactions(h.core, DAPP, h.wallet.address, [transferTo(h.wallet.keypair, regular, 0.2)]);
    expect(recurring).toMatchObject({ action: "warn", transfers: [{ to: regular, amount: "0.200 SOL" }] });
    expect(recurring.action === "warn" && recurring.warnings.map((warning) => warning.id)).toEqual(["recurring-counterparty"]);

    const passThrough = await reviewTransactions(h.core, DAPP, h.wallet.address, [transferTo(h.wallet.keypair, regular, 1.25)]);
    expect(passThrough.action === "warn" && passThrough.warnings.map((warning) => warning.id).sort()).toEqual(["amount-pass-through", "recurring-counterparty"]);
    expect(passThrough.action === "warn" && passThrough.warnings.every((warning) => warning.title.length > 0 && warning.detail.length > 0)).toBe(true);
  });

  it("the content script reaches it through the one message it may send", async () => {
    const { h, regular } = await scanned();
    await given(h);
    const reply = await handleContent(h.core, h.sender(9, `${DAPP}/`), {
      loch: "content",
      type: "review",
      account: h.wallet.address,
      transactions: [transferTo(h.wallet.keypair, regular, 0.2)],
    });
    expect(reply).toMatchObject({ action: "warn" });
    // What goes to the page's process: the warning and the transfer the page itself supplied. No balance, no note, no history.
    expect(Object.keys(reply).sort()).toEqual(["action", "transfers", "warnings"]);
  });

  it("passes without a word when there is nothing to say", async () => {
    const { h } = await scanned();
    await given(h);
    const me = h.wallet.keypair;
    const stranger = Keypair.generate();
    const pass = { action: "pass" };
    // Undecodable bytes.
    expect(await reviewTransactions(h.core, DAPP, h.wallet.address, [b64(crypto.getRandomValues(new Uint8Array(200)))])).toEqual(pass);
    expect(await reviewTransactions(h.core, DAPP, h.wallet.address, ["AAAA"])).toEqual(pass);
    // A transaction with no plain transfer.
    const none = new Transaction({ feePayer: me.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(
      SystemProgram.createAccount({ fromPubkey: me.publicKey, newAccountPubkey: stranger.publicKey, lamports: 1_000_000, space: 0, programId: SystemProgram.programId }),
    );
    expect(await reviewTransactions(h.core, DAPP, h.wallet.address, [b64(none.serialize({ requireAllSignatures: false, verifySignatures: false }))])).toEqual(pass);
    // A transfer someone else pays for.
    expect(await reviewTransactions(h.core, DAPP, h.wallet.address, [transferTo(stranger, me.publicKey.toBase58(), 1)])).toEqual(pass);
    // An address this device does not know, and a site that is not a site.
    expect(await reviewTransactions(h.core, DAPP, stranger.publicKey.toBase58(), [transferTo(stranger, me.publicKey.toBase58(), 1)])).toEqual(pass);
    expect(await reviewTransactions(h.core, null, h.wallet.address, [transferTo(me, stranger.publicKey.toBase58(), 1)])).toEqual(pass);
  });

  it("passes when the wrapper is off, the wallet is locked or was never scanned", async () => {
    const { h, regular } = await scanned();
    await given(h);
    const tx = [transferTo(h.wallet.keypair, regular, 0.2)];
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { wrapperEnabled: false } });
    expect(await reviewTransactions(h.core, DAPP, h.wallet.address, tx)).toEqual({ action: "pass" });
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { wrapperEnabled: true } });
    expect(await reviewTransactions(h.core, DAPP, h.wallet.address, tx)).toMatchObject({ action: "warn" });
    await handleUi(h.core, { loch: "ui", type: "lock" });
    expect(await reviewTransactions(h.core, DAPP, h.wallet.address, tx)).toEqual({ action: "pass" });

    const unscanned = createHarness();
    await connect(unscanned);
    unscanned.tabs.set(9, `${DAPP}/`);
    await handleContent(unscanned.core, unscanned.sender(9, `${DAPP}/`), { loch: "content", type: "accounts", accounts: [unscanned.wallet.address] });
    expect(await reviewTransactions(unscanned.core, DAPP, unscanned.wallet.address, [transferTo(unscanned.wallet.keypair, Keypair.generate().publicKey.toBase58(), 0.2)])).toEqual({ action: "pass" });
  });

  it("the page is told whether the wrapper is on and which wallet to stand in front of, and nothing else; with the wrapper off, not even the wallet's name", async () => {
    const { h } = await scanned();
    h.tabs.set(9, `${DAPP}/`);
    const config = () => handleContent(h.core, h.sender(9, `${DAPP}/`), { loch: "content", type: "config" });
    expect(await config()).toEqual({ enabled: true, wallet: "Phantom", bridge: false });
    await handleUi(h.core, { loch: "ui", type: "settings", patch: { wrapperEnabled: false } });
    expect(await config()).toEqual({ enabled: false, wallet: null, bridge: false });
  });

  it("writes token amounts with their decimals", () => {
    expect(tokenAmount(1_500_000n, 6)).toBe("1.5");
    expect(tokenAmount(25n, 0)).toBe("25");
    expect(tokenAmount(1n, 9)).toBe("0.000000001");
    expect(tokenAmount(2_000_000n, 6)).toBe("2");
  });
});
