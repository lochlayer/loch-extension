// Stand-ins for the relayer and the screening service that speak the real wire protocol
// (docs/protocol.md section 14), built on the SDK's own wire helpers. Each is a function from a
// request to a response, so the unit tests call them through a fetch stand-in and the
// end-to-end tests put them behind an HTTP server on 127.0.0.1.

import { ed25519 } from "@noble/curves/ed25519";
import {
  type AnyTransaction,
  PROGRAM_ID,
  type VerificationKey,
  buildTransactInstruction,
  buildTransactTransaction,
  buildTransactionV1,
  bytesToField,
  decodeProof,
  deserializeTransaction,
  keyDerivationMessage,
  parseProgramError,
  transactPublicInputs,
  verifyProof,
} from "@loch/sdk";
import {
  NATIVE_MINT,
  assetId,
  assetTable,
  associatedTokenAddress,
  buildSwapV2Instruction,
  buildTransactV2Instruction,
  createAssociatedTokenAccountIdempotent,
  decodeTransactArgsV2,
  deriveKeysV2,
  encodeAddressV2,
  feeNoteOf,
  inspectDepositTransactionV2,
  inspectMoveTransaction,
  isMoveTransaction,
  isTransactV2Data,
  mainAddress,
  noteCommitmentV2,
  openNoteV2,
  validateMoveRequestV2,
  validateQuoteRequestV2,
  validateRelayRequestV2,
} from "@loch/sdk/v2";
import { WireError, checkRelayRequest, fromRelayRequest, inspectDepositTransaction, parseScreenTransaction, validateRelayRequest, validateScreenRequest } from "@loch/sdk/wire";
import { AddressLookupTableAccount, type Keypair, PublicKey } from "@solana/web3.js";

import { clusterOf } from "../../src/shared/constants.js";
import { type MockChain, POOL_LOOKUP_TABLE, POOL_LOOKUP_TABLE_V2, RpcFailure } from "./chain.js";

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
  /** The v2 routes' smallest fee per asset, by mint; omitted: SOL at `feeLamports` only. */
  feesV2?: Map<string, bigint>;
  /** Whether `/v2/quote` answers and swaps are relayed (at the chain's `swapRates`). */
  swaps?: boolean;
}

/** The rent of the two nullifier records a move's deposit creates, which the relayer refunds. */
export const MOVE_REFUND = 1_907_040n;
/** The smallest move the mock relayer pays for. */
export const MOVE_MIN = 10_000_000n;
const MOVE_COMPUTE_UNIT_LIMIT = 700_000;

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
  /** The v2 fee per asset, by mint (base58). */
  readonly feesV2: Map<string, bigint>;
  swaps: boolean;
  /** Whether `/v2/move` is served and `/v2/info` offers it. */
  moves = true;
  readonly requests: { path: string; at: number }[] = [];
  /** Signatures of transactions this relayer sent. */
  readonly sent: string[] = [];

  constructor(readonly options: RelayerOptions) {
    this.feeLamports = options.feeLamports;
    this.feesV2 = new Map(options.feesV2 ?? [[NATIVE_MINT.toBase58(), options.feeLamports]]);
    this.swaps = options.swaps ?? true;
  }

  /** The v2 keys this relayer is paid to, derived from its signing key as the real relayer does. */
  get keysV2() {
    const { keypair } = this.options;
    return deriveKeysV2(ed25519.sign(keyDerivationMessage(), keypair.secretKey.subarray(0, 32)), keypair.publicKey.toBytes());
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
    if (path.startsWith("/v2/")) return this.handleV2(method, path, body);
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
    return this.send(transaction.serialize(), mode);
  }

  /** Sends a built transaction and answers as the relayer does. */
  private async send(raw: Uint8Array, mode: string): Promise<HttpReply> {
    let signature: string;
    try {
      signature = await this.options.chain.process(raw);
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

  /** `/v2/move`, as services/relayer/src/move.ts answers it: a move the wallet and the screener signed, signed last as fee payer. */
  private async handleMove(body: unknown, screener: PublicKey): Promise<HttpReply> {
    if (!this.moves) return errorReply(new WireError("move_unavailable", "this relayer does not pay for moves", 422));
    if (Date.now() < this.downUntil) return { status: 0, body: null, drop: true };
    const mode = this.script.shift() ?? "ok";
    if (mode === "drop") {
      this.downUntil = Date.now() + this.downMs;
      return { status: 0, body: null, drop: true };
    }
    if (mode === "hang") return new Promise<HttpReply>(() => undefined);
    if (mode === "unavailable") return errorReply(new WireError("unavailable", "the relayer is out of funds", 503));
    const shaped = validateMoveRequestV2(body);
    if (!shaped.ok) return errorReply(shaped.error);
    const invalid = (message: string) => errorReply(new WireError("invalid_request", message, 400));
    let transaction: AnyTransaction;
    try {
      transaction = deserializeTransaction(Buffer.from(shaped.value.transaction, "base64"));
    } catch {
      return invalid("transaction is not a Solana transaction");
    }
    const { keypair } = this.options;
    const move = inspectMoveTransaction(transaction, { screener, relayer: keypair.publicKey });
    if (!move.ok) return invalid(move.error.message);
    if (move.value.refundLamports !== MOVE_REFUND) return invalid("the refund is not this relayer's");
    if ((move.value.priorityFeeLamports ?? 0n) > 100_000n) return invalid("the priority fee is above what this relayer pays");
    if (move.value.amount < MOVE_MIN) return errorReply(new WireError("withdrawal_too_small", "below the smallest move", 400));
    const message = transaction.message.serialize();
    for (const index of [1, 2]) {
      if (!ed25519.verify(transaction.signatures[index]!, message, transaction.message.staticAccountKeys[index]!.toBytes())) return invalid("the wallet and the screening authority sign first");
    }
    transaction.sign([keypair]);
    return this.send(transaction.serialize(), mode);
  }

  /** `/v2/info`, `/v2/quote` and `/v2/relay`, as services/relayer/src/v2.ts answers them (the proof is not checked). */
  private async handleV2(method: string, path: string, body: unknown): Promise<HttpReply> {
    const { chain, keypair } = this.options;
    const pool = chain.poolV2;
    if (!pool) return notFound;
    if (method === "GET" && path === "/v2/info") {
      if (this.infoDown) return { status: 0, body: null, drop: true };
      return {
        status: 200,
        body: {
          version: "0.2.0-mock",
          cluster: clusterOf(chain.genesisHash),
          genesisHash: chain.genesisHash,
          programId: PROGRAM_ID.toBase58(),
          relayer: keypair.publicKey.toBase58(),
          address: encodeAddressV2(mainAddress(this.keysV2)),
          fees: Object.fromEntries([...this.feesV2].map(([mint, fee]) => [mint, fee.toString()])),
          minWithdrawalLamports: (this.options.minWithdrawalLamports ?? 1_000_000n).toString(),
          swaps: this.swaps,
          computeUnitLimit: 450_000,
          ...(this.moves
            ? { move: { refundLamports: MOVE_REFUND.toString(), minLamports: MOVE_MIN.toString(), computeUnitLimit: MOVE_COMPUTE_UNIT_LIMIT, priorityFeeLamports: "0" } }
            : {}),
        },
      };
    }
    if (method === "POST" && path === "/v2/move") return this.handleMove(body, pool.screener);
    if (method === "POST" && path === "/v2/quote") {
      const request = validateQuoteRequestV2(body);
      if (!request.ok) return errorReply(request.error);
      const rate = this.swaps ? pool.swapRates.get(`${request.value.inputMint}:${request.value.outputMint}`) : undefined;
      if (!rate) return errorReply(new WireError("swap_unavailable", "no route between these assets", 422));
      return { status: 200, body: { amountOut: ((BigInt(request.value.amountIn) * rate[0]) / rate[1]).toString() } };
    }
    if (method !== "POST" || path !== "/v2/relay") return notFound;

    if (Date.now() < this.downUntil) return { status: 0, body: null, drop: true };
    const mode = this.script.shift() ?? "ok";
    if (mode === "drop") {
      this.downUntil = Date.now() + this.downMs;
      return { status: 0, body: null, drop: true };
    }
    if (mode === "hang") return new Promise<HttpReply>(() => undefined);
    if (mode === "unavailable") return errorReply(new WireError("unavailable", "the relayer is out of funds", 503));

    const shaped = validateRelayRequestV2(body);
    if (!shaped.ok) return errorReply(shaped.error);
    const invalid = (message: string) => errorReply(new WireError("invalid_request", message, 400));
    let args;
    try {
      args = decodeTransactArgsV2(Buffer.from(shaped.value.args, "base64"));
    } catch {
      return invalid("args is not a TransactArgsV2");
    }
    const { extAmount, swap, asset } = args.extData;
    if (extAmount > 0n) return invalid("a deposit is not relayed");
    // The fee note: an asset this relayer takes, at least its fee, that note to its address at the named position.
    const fee = feeNoteOf(shaped.value);
    const feeNote = (message: string) => errorReply(new WireError("fee_note_invalid", message, 400));
    const asked = this.feesV2.get(fee.mint.toBase58());
    if (asked === undefined) return feeNote(`this relayer does not take fees in ${fee.mint.toBase58()}`);
    if (fee.amount < asked) return feeNote(`the fee note pays ${fee.amount}, this relayer asks ${asked}`);
    if (extAmount !== 0n && !asset.equals(fee.mint)) return feeNote("the fee note is not in the transaction's asset");
    const keys = this.keysV2;
    const expected = noteCommitmentV2({ asset: assetId(fee.mint), amount: fee.amount, owner: mainAddress(keys).owner, blinding: fee.blinding });
    if (bytesToField(args.outputCommitments[fee.position]) !== expected) return feeNote("the output at the named position is not that note to this relayer's address");
    const opened = openNoteV2(args.extData.encryptedOutputs[fee.position], keys, expected, assetTable([{ mint: fee.mint, symbol: "", decimals: 0 }]));
    if (!opened || opened.source !== "address") return feeNote("the encrypted output does not open to the fee note with this relayer's key");
    if (extAmount < 0n && !swap && asset.equals(NATIVE_MINT) && -extAmount < (this.options.minWithdrawalLamports ?? 1_000_000n)) {
      return errorReply(new WireError("withdrawal_too_small", "below the smallest withdrawal", 400));
    }
    let createFor: PublicKey | null = null;
    if (shaped.value.recipientOwner !== undefined) {
      createFor = new PublicKey(shaped.value.recipientOwner);
      if (extAmount >= 0n || swap || asset.equals(NATIVE_MINT)) return invalid("recipientOwner is for a token withdrawal only");
      if (!associatedTokenAddress(createFor, asset).equals(args.extData.recipient)) return invalid("the recipient is not the associated token account of recipientOwner");
    }
    if (swap) {
      // The relayer asks its router before it sends, as services/relayer/src/router.ts does.
      const rate = this.swaps ? pool.swapRates.get(`${asset.toBase58()}:${swap.outputMint.toBase58()}`) : undefined;
      if (!rate) return errorReply(new WireError("swap_unavailable", "this relayer does not swap these assets", 422));
      if ((-extAmount * rate[0]) / rate[1] < swap.minAmountOut) {
        return errorReply(new WireError("swap_unavailable", "the market moved: the swap would now return less than its minimum; quote again", 422));
      }
    }
    const instruction = swap
      ? buildSwapV2Instruction(args, Uint8Array.of(0), { signer: keypair.publicKey, router: pool.router, routeAccounts: [] })
      : buildTransactV2Instruction(args, { signer: keypair.publicKey });
    const transaction = buildTransactionV1({
      instructions: createFor ? [createAssociatedTokenAccountIdempotent(keypair.publicKey, createFor, asset), instruction] : [instruction],
      payer: keypair.publicKey,
      recentBlockhash: chain.newBlockhash().blockhash,
      computeUnitLimit: swap ? 1_200_000 : 450_000,
    });
    transaction.sign([keypair]);
    return this.send(transaction.serialize(), mode);
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
  /** The v2 pool's table, advertised once the chain has the v2 pool; null: version-0 v2 deposits are refused. */
  lookupTableV2: PublicKey | null = POOL_LOOKUP_TABLE_V2;
  /** The transactions it co-signed, as sent. */
  readonly screened: AnyTransaction[] = [];

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
          ...(this.lookupTableV2 && chain.poolV2 ? { lookupTableV2: this.lookupTableV2.toBase58() } : {}),
        },
      };
    }
    if (method !== "POST" || path !== "/v1/screen") return notFound;
    const request = validateScreenRequest(body);
    if (!request.ok) return errorReply(request.error);
    const parsed = parseScreenTransaction(request.value);
    if (!parsed.ok) return errorReply(parsed.error);
    const { message } = parsed.value;
    if (isMoveTransaction(parsed.value)) {
      // A move: the wallet deposits what the earlier pool paid it, and is screened as any depositor.
      const pool = chain.poolV2;
      if (!pool) return errorReply(new WireError("invalid_transaction", "there is no new pool", 400));
      const move = inspectMoveTransaction(parsed.value, { screener: keypair.publicKey });
      if (!move.ok) return errorReply(move.error);
      const asset = pool.assets.get(NATIVE_MINT.toBase58());
      if (!asset || pool.paused || !asset.depositsEnabled) return errorReply(new WireError("deposits_paused", "deposits are paused", 409));
      if (move.value.amount > asset.maxDeposit) return errorReply(new WireError("too_large", "the deposit exceeds the cap", 400));
      if (this.denied.has(move.value.wallet.toBase58())) return errorReply(new WireError("denied", "the screening policy refuses this deposit", 403));
      this.screened.push(parsed.value);
      const signature = ed25519.sign(message.serialize(), keypair.secretKey.slice(0, 32));
      return { status: 200, body: { signature: Buffer.from(signature).toString("base64"), screener: keypair.publicKey.toBase58() } };
    }
    const v2 = message.compiledInstructions.some((instruction) => message.staticAccountKeys[instruction.programIdIndex]?.equals(PROGRAM_ID) && isTransactV2Data(instruction.data));
    if (v2) {
      const pool = chain.poolV2;
      const deposit = inspectDepositTransactionV2(parsed.value, { screener: keypair.publicKey, lookupTable: this.lookupTableV2 ? frozenTable(chain, this.lookupTableV2) : null });
      if (!deposit.ok) return errorReply(deposit.error);
      const asset = pool?.assets.get(deposit.value.mint.toBase58());
      if (!pool || !asset) return errorReply(new WireError("invalid_transaction", "the asset is not registered", 400));
      if (pool.paused || !asset.depositsEnabled) return errorReply(new WireError("deposits_paused", "deposits are paused", 409));
      if (deposit.value.amount > asset.maxDeposit) return errorReply(new WireError("too_large", "the deposit exceeds the cap", 400));
      if (this.denied.has(deposit.value.depositor.toBase58())) return errorReply(new WireError("denied", "the screening policy refuses this deposit", 403));
      this.screened.push(parsed.value);
      const signature = ed25519.sign(deposit.value.message, keypair.secretKey.slice(0, 32));
      return { status: 200, body: { signature: Buffer.from(signature).toString("base64"), screener: keypair.publicKey.toBase58() } };
    }
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
