// A whole service worker without a browser: the Core with in-memory storage, a clock the test
// moves, the mock cluster and services behind the real clients, a prover that does not prove,
// and a stand-in for the connect tab with a wallet that signs with a real Ed25519 key.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { ed25519 } from "@noble/curves/ed25519";
import { type CircuitInput, type DepthCircuitInput, type Groth16Proof, LIGHTHOUSE_PROGRAM_ID, type Prover, deserializeTransaction } from "@loch/sdk";
import { createNodeDepthProver } from "@loch/sdk/node";
import { RelayerClient, ScreenerClient } from "@loch/sdk/wire";
import { type CircuitInputV2, RelayerClientV2 } from "@loch/sdk/v2";
import { scanAddressDetailed } from "@loch/scanner-core";
import { Keypair, type MessageV0 } from "@solana/web3.js";

import { MockChain, type MockChainOptions } from "../e2e/mock/chain.js";
import { type HttpReply, MockRelayer, MockScreener } from "../e2e/mock/services.js";
import { Core, type Env } from "../src/background/core.js";
import { type KV, memoryKV } from "../src/background/kv.js";
import { type FetchLike, createChain } from "../src/background/network.js";
import { checkOhttp, rpcTransport } from "../src/background/ohttp.js";
import { handleContent } from "../src/background/router.js";
import { DEFAULT_SETTINGS } from "../src/background/settings.js";
import { fromBase64, toBase64 } from "../src/shared/bytes.js";
import type { BridgeAnswer, BridgeRequest, SenderLike } from "../src/shared/messages.js";

const VECTOR = JSON.parse(readFileSync(new URL("../../../circuits/artifacts/devnet/test_vector.json", import.meta.url), "utf8")) as {
  snarkjs: { proof: Groth16Proof };
};

// Depth proofs are real proofs: the verifier is the SDK, as it would be for a stranger. The
// artifacts are read once per test file, when the first depth proof is asked for.
let depthProverLoaded: Promise<Prover<DepthCircuitInput>> | null = null;
const depthProver: Prover<DepthCircuitInput> = {
  prove: async (input) => (await (depthProverLoaded ??= createNodeDepthProver({ singleThread: true }))).prove(input),
};

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const RPC = "https://rpc.test";
export const RELAYER = "https://relayer.test";
export const SCREENER = "https://screener.test";
export const CONNECT = "https://connect.test/connect.html";

/**
 * A valid Ed25519 signature that differs each time it is made: the nonce is random instead of
 * derived from the key and the message. A wallet may sign like this, and Loch must notice.
 */
export function randomisedSignature(message: Uint8Array, secret: Uint8Array): Uint8Array {
  const order = ed25519.CURVE.n;
  const le = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`);
  const toLe = (value: bigint) => Buffer.from(value.toString(16).padStart(64, "0"), "hex").reverse();
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(secret);
  const r = le(randomBytes(64)) % order;
  const R = ed25519.ExtendedPoint.BASE.multiply(r).toRawBytes();
  const h = le(createHash("sha512").update(R).update(pointBytes).update(message).digest()) % order;
  return Uint8Array.from(Buffer.concat([R, toLe((r + h * scalar) % order)]));
}

/**
 * Appends a Lighthouse assertion on the fee payer to a compiled message, as a wallet does: the
 * program becomes the last static key (read-only, unsigned), so the accounts loaded from lookup
 * tables move up by one.
 */
function addAssertion(message: MessageV0): void {
  const added = message.staticAccountKeys.length;
  for (const instruction of message.compiledInstructions) {
    if (instruction.programIdIndex >= added) instruction.programIdIndex++;
    instruction.accountKeyIndexes = instruction.accountKeyIndexes.map((index) => (index >= added ? index + 1 : index));
  }
  message.staticAccountKeys.push(LIGHTHOUSE_PROGRAM_ID);
  message.header.numReadonlyUnsignedAccounts++;
  message.compiledInstructions.push({ programIdIndex: added, accountKeyIndexes: [0], data: Uint8Array.of(15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) });
}

/** A wallet as the page script sees it, signing with a real key. */
export class TestWallet {
  readonly keypair = Keypair.generate();
  name = "Phantom";
  features = ["standard:connect", "solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"];
  /** What the user does with the next prompts. "approve" when empty. */
  readonly decisions: ("approve" | "reject")[] = [];
  /** Sign with random bytes mixed in, as a wallet that is not deterministic would. */
  randomised = false;
  /** Return a transaction other than the one asked for. */
  tamper = false;
  /** Add a Lighthouse assertion on the fee payer before signing, as Phantom does. */
  lighthouse = false;
  /** Change the deposit's own instruction data before signing: a wallet that rewrites what it was given. */
  rewrite = false;
  /** Signs version 0 only: the bridge answers "unsupported-version" for v1 without asking it. */
  legacyOnly = false;
  readonly prompts: BridgeRequest[] = [];

  get address(): string {
    return this.keypair.publicKey.toBase58();
  }

  answer(request: BridgeRequest): BridgeAnswer {
    if (request.kind === "wallets") {
      return { ok: true, value: { kind: "wallets", wallets: [{ name: this.name, features: this.features, chains: ["solana:devnet"] }] } };
    }
    if (request.kind === "signTransaction" && this.legacyOnly && fromBase64(request.transaction)[0] === 129) {
      return { ok: false, error: { code: "unsupported-version", message: "the wallet does not sign version 1 transactions" } };
    }
    this.prompts.push(request);
    if ((this.decisions.shift() ?? "approve") === "reject") return { ok: false, error: { code: "rejected", message: "User rejected the request." } };
    const secret = this.keypair.secretKey.slice(0, 32);
    switch (request.kind) {
      case "connect":
        return { ok: true, value: { kind: "connect", accounts: [{ address: this.address, publicKey: toBase64(this.keypair.publicKey.toBytes()) }] } };
      case "signMessage": {
        const message = fromBase64(request.message);
        const signature = this.randomised ? randomisedSignature(message, secret) : ed25519.sign(message, secret);
        return { ok: true, value: { kind: "signMessage", signature: toBase64(signature) } };
      }
      case "signTransaction": {
        const transaction = deserializeTransaction(fromBase64(request.transaction));
        if (this.tamper) (transaction.message as { recentBlockhash: string }).recentBlockhash = Keypair.generate().publicKey.toBase58();
        if (this.lighthouse) addAssertion(transaction.message as unknown as MessageV0);
        if (this.rewrite) {
          const transact = transaction.message.compiledInstructions.find((instruction) => instruction.data.length > 100)!;
          transact.data = Uint8Array.from(transact.data);
          transact.data[transact.data.length - 1]! ^= 1;
        }
        transaction.sign([this.keypair]);
        return { ok: true, value: { kind: "signTransaction", signedTransaction: toBase64(transaction.serialize()) } };
      }
    }
  }
}

export interface Harness {
  core: Core;
  env: Env;
  local: ReturnType<typeof memoryKV>;
  session: ReturnType<typeof memoryKV>;
  chain: MockChain;
  relayer: MockRelayer;
  screener: MockScreener;
  wallet: TestWallet;
  clock: { now: number };
  /** Every request the worker made, by origin. */
  requests: string[];
  /** The network: what answers a request. A test may replace it to add a host. */
  transport: FetchLike;
  notifications: { count: number };
  /** Open tabs: id to URL. */
  tabs: Map<number, string>;
  /** Bridge requests the page has been sent and not answered. With `holdWallet` they stay here until released. */
  held: { tabId: number; nonce: string; request: BridgeRequest }[];
  holdWallet: boolean;
  /** Answers every held request as the wallet would. */
  releaseWallet(): Promise<void>;
  /** A new worker over the same storage: what the browser does when it restarts the service worker. */
  restart(): Harness;
  sender(tabId: number, url?: string): SenderLike;
  prover: { calls: number; hang: boolean };
}

export interface HarnessOptions {
  local?: ReturnType<typeof memoryKV>;
  session?: ReturnType<typeof memoryKV>;
  shared?: Pick<Harness, "chain" | "relayer" | "screener" | "wallet" | "clock" | "requests" | "tabs" | "held"> & { nextTab: { id: number } };
  /** The v2 pool on the mock cluster (SOL registered, plus these assets); without it there is none. */
  v2?: MockChainOptions["v2"];
  /** The relayer's v2 fee per asset, by mint. */
  feesV2?: Map<string, bigint>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const local = options.local ?? memoryKV({ settings: { ...DEFAULT_SETTINGS, rpcUrl: RPC, relayerUrl: RELAYER, screenerUrl: SCREENER, connectUrl: CONNECT } });
  const session = options.session ?? memoryKV();
  const screenerKey = Keypair.generate();
  const shared = options.shared ?? {
    chain: new MockChain({ screener: screenerKey.publicKey, ...(options.v2 ? { v2: options.v2 } : {}) }),
    relayer: undefined as unknown as MockRelayer,
    screener: undefined as unknown as MockScreener,
    wallet: new TestWallet(),
    clock: { now: 1_790_000_000_000 },
    requests: [] as string[],
    tabs: new Map<number, string>(),
    held: [] as Harness["held"],
    nextTab: { id: 100 },
  };
  if (!options.shared) {
    const relayerKey = Keypair.generate();
    shared.chain.airdrop(relayerKey.publicKey, 10_000_000_000n);
    shared.relayer = new MockRelayer({ chain: shared.chain, keypair: relayerKey, feeLamports: 2_500_000n, ...(options.feesV2 ? { feesV2: options.feesV2 } : {}) });
    shared.screener = new MockScreener({ chain: shared.chain, keypair: screenerKey });
  }
  const { chain, relayer, screener, wallet, clock, requests, tabs, held } = shared;

  const reply = (result: HttpReply): Response => {
    if (result.drop) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };
  const transport: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push(url.origin);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.origin === RPC) {
      if (chain.down) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(await chain.handle(body)), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.origin === RELAYER) return reply(await relayer.handle(init.method ?? "GET", url.pathname, body));
    if (url.origin === SCREENER) return reply(await screener.handle(init.method ?? "GET", url.pathname, body));
    throw new TypeError(`no such host: ${url.origin}`);
  };

  const proverState = { calls: 0, hang: false };
  const prover: Prover = {
    async prove(input: CircuitInput) {
      proverState.calls++;
      if (proverState.hang) await new Promise(() => undefined);
      return {
        proof: VECTOR.snarkjs.proof,
        publicSignals: [input.root, input.publicAmount, input.extDataHash, ...input.inputNullifier, ...input.outputCommitment].map(String),
      };
    },
  };

  // v2: the same stand-in, with the nine public signals of the v2 circuit.
  const proverV2: Prover<CircuitInputV2> = {
    async prove(input: CircuitInputV2) {
      proverState.calls++;
      if (proverState.hang) await new Promise(() => undefined);
      return {
        proof: VECTOR.snarkjs.proof,
        publicSignals: [input.root, input.publicAmount, input.publicAsset, input.extDataHash, ...input.inputNullifier, ...input.outputCommitment].map(String),
      };
    },
  };

  const notifications = { count: 0 };
  const harness = {} as Harness;
  const sender = (tabId: number, url = tabs.get(tabId) ?? CONNECT): SenderLike => ({
    id: EXTENSION_ID,
    url,
    origin: new URL(url).origin,
    frameId: 0,
    tab: { id: tabId },
    documentLifecycle: "active",
  });

  const answerHeld = async (entry: Harness["held"][number]) => {
    const answer = wallet.answer(entry.request);
    await handleContent(harness.core, sender(entry.tabId), { loch: "content", type: "bridge-answer", nonce: entry.nonce, answer });
  };

  const env: Env = {
    local: local as KV,
    session: session as KV,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    chain: (settings) => createChain(settings, { transport: (input, init) => harness.transport(input, init), rpcTransport }),
    relayer: (settings, c) => new RelayerClient(settings.relayerUrl, { fetch: (url, init) => c.fetch(url, init), relayTimeoutMs: 0, timeoutMs: 0 }),
    relayerV2: (settings, c) => new RelayerClientV2(settings.relayerUrl, { fetch: (url, init) => c.fetch(url, init), relayTimeoutMs: 0, timeoutMs: 0 }),
    screener: (settings, c) => new ScreenerClient(settings.screenerUrl, { fetch: (url, init) => c.fetch(url, init), timeoutMs: 0 }),
    prover,
    proverV2,
    depthProver,
    tabs: {
      create: async ({ url }) => {
        const id = shared.nextTab.id++;
        tabs.set(id, url);
        // The page loads; its content script announces itself.
        setImmediate(() => void handleContent(harness.core, sender(id, url), { loch: "content", type: "config" }));
        return { id };
      },
      remove: async (id) => {
        tabs.delete(id);
      },
      sendMessage: async (tabId, message) => {
        const url = tabs.get(tabId);
        if (!url) throw new Error("Could not establish connection. Receiving end does not exist.");
        const m = message as { type: string; nonce?: string; request?: BridgeRequest };
        if (m.type === "status") return { ok: true, url };
        if (m.type === "bridge-request" && m.nonce && m.request) {
          const entry = { tabId, nonce: m.nonce, request: m.request };
          if (harness.holdWallet && m.request.kind !== "wallets") held.push(entry);
          else setImmediate(() => void answerHeld(entry));
          return { accepted: true };
        }
        return undefined;
      },
    },
    notify: () => {
      notifications.count++;
    },
    scan: (connection, address, scanOptions) => scanAddressDetailed(connection, address, scanOptions),
    checkOhttp,
    dialogAssets: async () => ({ css: "", fonts: { normal: "", italic: "" } }),
  };

  Object.assign(harness, {
    core: new Core(env),
    env,
    local,
    session,
    chain,
    relayer,
    screener,
    wallet,
    clock,
    requests,
    notifications,
    tabs,
    held,
    holdWallet: false,
    prover: proverState,
    sender,
    transport,
    releaseWallet: async () => {
      for (const entry of held.splice(0)) await answerHeld(entry);
    },
    restart: () => createHarness({ local, session, shared }),
  } satisfies Harness);
  return harness;
}

/** Waits until the current flow is no longer running, or until it is in `step`. */
export async function settle(h: Harness, until?: (flow: NonNullable<Awaited<ReturnType<Core["flow"]>>>) => boolean): Promise<NonNullable<Awaited<ReturnType<Core["flow"]>>>> {
  // By the clock, not by a count of turns: real cryptography (the vault, Oblivious HTTP) takes
  // as long as it takes on a busy machine.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    const flow = await h.core.flow();
    if (!flow) throw new Error("there is no flow");
    if (until ? until(flow) : flow.status === "done" || flow.status === "failed") return flow;
    if (!until && flow.status === "waiting" && h.holdWallet && h.held.length > 0) return flow;
    if (!until && flow.status === "waiting" && flow.step === "choosing") return flow;
  }
  const flow = await h.core.flow();
  throw new Error(`the flow did not settle: ${flow?.kind} ${flow?.step} ${flow?.status}`);
}
