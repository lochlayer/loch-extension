// Stand-ins for the relayer and the screening service that speak the real wire protocol
// (docs/protocol.md section 14), built on the SDK's own wire helpers. Each is a function from a
// request to a response, so the unit tests call them through a fetch stand-in and the
// end-to-end tests put them behind an HTTP server on 127.0.0.1.

import { ed25519 } from "@noble/curves/ed25519";
import { PROGRAM_ID, type VerificationKey, buildTransactInstruction, buildTransactTransaction, decodeProof, parseProgramError, transactPublicInputs, verifyProof } from "@loch/sdk";
import { WireError, checkRelayRequest, fromRelayRequest, inspectDepositTransaction, parseScreenTransaction, validateRelayRequest, validateScreenRequest } from "@loch/sdk/wire";
import { AddressLookupTableAccount, type Keypair, type PublicKey, type VersionedTransaction } from "@solana/web3.js";

import { clusterOf } from "../../src/shared/constants.js";
import { type MockChain, POOL_LOOKUP_TABLE, RpcFailure } from "./chain.js";

export interface HttpReply {
  status: number;
  body: unknown;
  /** Close the connection without answering, as a relayer that is down would. */
  drop?: boolean;
}

const errorReply = (error: WireError): HttpReply => ({ status: error.status ?? 400, body: error.toBody() });
const notFound: HttpReply = { status: 404, body: { error: { code: "not_found", message: "unknown path" } } };

export interface RelayerOptions {
  chain: MockChain;
  keypair: Keypair;
  feeLamports: bigint;
  minWithdrawalLamports?: bigint;
  verificationKey?: VerificationKey;
}

export class MockRelayer {
  /** How the next calls of POST /v1/relay behave. Shift one off per call; "ok" when empty. */
  readonly script: ("ok" | "drop" | "unavailable" | "not_confirmed" | "relay-then-drop" | "hang" | "relay-then-hang")[] = [];
  /** GET /v1/info fails when set. */
  infoDown = false;
  /**
   * How long a "drop" lasts, in real milliseconds. A browser quietly sends a request again when
   * its connection is reset, so against a real browser the relayer has to stay down for a moment.
   */
  downMs = 0;
  private downUntil = 0;
  feeLamports: bigint;
  readonly requests: { path: string; at: number }[] = [];
  /** Signatures of transactions this relayer sent. */
  readonly sent: string[] = [];

  constructor(readonly options: RelayerOptions) {
    this.feeLamports = options.feeLamports;
  }

  async handle(method: string, path: string, body: unknown): Promise<HttpReply> {
    this.requests.push({ path, at: Date.now() });
    const { chain, keypair } = this.options;
    if (method === "GET" && path === "/v1/info") {
      if (this.infoDown) return { status: 0, body: null, drop: true };
      return {
        status: 200,
        body: {
          version: "0.1.0-mock",
          cluster: clusterOf(chain.genesisHash),
          genesisHash: chain.genesisHash,
          programId: PROGRAM_ID.toBase58(),
          relayer: keypair.publicKey.toBase58(),
          feeLamports: this.feeLamports.toString(),
          minWithdrawalLamports: (this.options.minWithdrawalLamports ?? 1_000_000n).toString(),
          computeUnitLimit: 300_000,
        },
      };
    }
    if (method !== "POST" || path !== "/v1/relay") return notFound;

    if (Date.now() < this.downUntil) return { status: 0, body: null, drop: true };
    const mode = this.script.shift() ?? "ok";
    if (mode === "drop") {
      this.downUntil = Date.now() + this.downMs;
      return { status: 0, body: null, drop: true };
    }
    // A relayer that never answers. The caller is left waiting, as a stopped worker's request is.
    if (mode === "hang") return new Promise<HttpReply>(() => undefined);
    if (mode === "unavailable") return errorReply(new WireError("unavailable", "the relayer is out of funds", 503));

    const shaped = validateRelayRequest(body);
    if (!shaped.ok) return errorReply(shaped.error);
    const checked = checkRelayRequest(fromRelayRequest(shaped.value), {
      relayer: keypair.publicKey,
      feeLamports: this.feeLamports,
      minWithdrawalLamports: this.options.minWithdrawalLamports ?? 1_000_000n,
    });
    if (!checked.ok) return errorReply(checked.error);
    const args = checked.value;
    if (this.options.verificationKey && !(await verifyProof(this.options.verificationKey, decodeProof(args.proof), transactPublicInputs(args)))) {
      return errorReply(new WireError("invalid_proof", "the proof does not verify for these arguments", 400));
    }
    const transaction = buildTransactTransaction({
      instruction: buildTransactInstruction(args, { signer: keypair.publicKey }),
      payer: keypair.publicKey,
      recentBlockhash: chain.newBlockhash().blockhash,
    });
    transaction.sign([keypair]);
    let signature: string;
    try {
      signature = await chain.process(transaction.serialize());
    } catch (error) {
      if (!(error instanceof RpcFailure)) throw error;
      const data = error.data as { err?: unknown; logs?: string[] } | undefined;
      const program = parseProgramError({ err: data?.err, logs: data?.logs ?? [] });
      const kind = program?.kind;
      if (kind === "InvalidProof") return errorReply(new WireError("invalid_proof", "the program rejected the proof", 400));
      if (kind === "UnknownRoot") return errorReply(new WireError("unknown_root", "the root is not in the program's recent history", 409));
      if (kind === "NullifierAlreadySpent") return errorReply(new WireError("nullifier_spent", "an input is already spent", 409));
      if (kind === "InsufficientFundsForRent") return errorReply(new WireError("withdrawal_too_small", "the recipient would end below rent exemption", 400));
      return errorReply(new WireError("transaction_failed", `the transaction would fail: ${kind ?? error.message}`, 422));
    }
    this.sent.push(signature);
    if (mode === "not_confirmed") return errorReply(new WireError("not_confirmed", "sent, but not confirmed in time", 504));
    if (mode === "relay-then-drop") return { status: 0, body: null, drop: true };
    if (mode === "relay-then-hang") return new Promise<HttpReply>(() => undefined);
    return { status: 200, body: { signature } };
  }
}

export interface ScreenerOptions {
  chain: MockChain;
  keypair: Keypair;
}

/** A frozen lookup table of the chain, as the screening service loads it at startup. */
function frozenTable(chain: MockChain, key: PublicKey): AddressLookupTableAccount {
  const addresses = chain.lookupTables.get(key.toBase58()) ?? [];
  return new AddressLookupTableAccount({ key, state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses } });
}

export class MockScreener {
  /** Addresses the policy refuses. */
  readonly denied = new Set<string>();
  down = false;
  readonly requests: string[] = [];
  /** The pool's lookup table, which this service advertises and accepts; null: a service without one, as before 0.1.2. */
  lookupTable: PublicKey | null = POOL_LOOKUP_TABLE;
  /** The transactions it co-signed, as sent. */
  readonly screened: VersionedTransaction[] = [];

  constructor(readonly options: ScreenerOptions) {}

  async handle(method: string, path: string, body: unknown): Promise<HttpReply> {
    this.requests.push(path);
    const { chain, keypair } = this.options;
    if (this.down) return { status: 0, body: null, drop: true };
    if (method === "GET" && path === "/v1/info") {
      return {
        status: 200,
        body: {
          version: "0.1.0-mock",
          cluster: clusterOf(chain.genesisHash),
          programId: PROGRAM_ID.toBase58(),
          screener: keypair.publicKey.toBase58(),
          maxDepositLamports: chain.maxDeposit.toString(),
          policy: "Deposits from sanctioned addresses are refused.",
          ...(this.lookupTable ? { lookupTable: this.lookupTable.toBase58() } : {}),
        },
      };
    }
    if (method !== "POST" || path !== "/v1/screen") return notFound;
    const request = validateScreenRequest(body);
    if (!request.ok) return errorReply(request.error);
    const parsed = parseScreenTransaction(request.value);
    if (!parsed.ok) return errorReply(parsed.error);
    const deposit = inspectDepositTransaction(parsed.value, { screener: keypair.publicKey, lookupTable: this.lookupTable ? frozenTable(chain, this.lookupTable) : null });
    if (!deposit.ok) return errorReply(deposit.error);
    if (chain.paused) return errorReply(new WireError("deposits_paused", "deposits are paused", 409));
    if (deposit.value.amount > chain.maxDeposit) return errorReply(new WireError("too_large", "the deposit exceeds the cap", 400));
    if (this.denied.has(deposit.value.depositor.toBase58())) return errorReply(new WireError("denied", "the screening policy refuses this deposit", 403));
    this.screened.push(parsed.value);
    const signature = ed25519.sign(deposit.value.message, keypair.secretKey.slice(0, 32));
    return { status: 200, body: { signature: Buffer.from(signature).toString("base64"), screener: keypair.publicKey.toBase58() } };
  }
}
