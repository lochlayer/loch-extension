// A stand-in for a Solana cluster with the loch_pool program on it, for the extension's tests.
//
// It speaks JSON-RPC as a node does (the subset the SDK, the scanner and the extension use), and
// it runs `transact` the way programs/loch_pool does: it rebuilds the public inputs from the
// instruction alone, verifies the proof against the real verification key when given one, keeps
// the root history and the nullifier records, moves lamports, and logs Anchor events. Balances
// are real: fees, nullifier rent and the rent-exempt minimum are charged and enforced.
//
// Test code only. Modelled on packages/sdk/test/helpers/fakePool.ts.

import { createHash, randomBytes } from "node:crypto";

import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import {
  FIELD_MODULUS,
  LIGHTHOUSE_PROGRAM_ID,
  MerkleTree,
  NEW_COMMITMENT_DISCRIMINATOR,
  NEW_NULLIFIERS_DISCRIMINATOR,
  PROGRAM_ID,
  type TransactArgs,
  type VerificationKey,
  bytesToField,
  configPda,
  decodeProof,
  decodeTransactInstruction,
  nullifierPda,
  transactAccountsProblem,
  transactPublicInputs,
  treePda,
  vaultPda,
  verifyProof,
} from "@loch/sdk";
import { ComputeBudgetProgram, Keypair, type MessageV0, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";

const ROOT_HISTORY = 64;
const LEVELS = 20;
export const SIGNATURE_FEE = 5_000n;
export const NULLIFIER_RENT = 953_520n;
export const RENT_MINIMUM = 890_880n;
/** Anything that is not mainnet, devnet or testnet reads as "localnet". */
export const LOCALNET_GENESIS = "LochTestGenesis1111111111111111111111111111";

const discriminator = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);
const u64le = (value: bigint) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};
const be32 = (value: bigint) => Buffer.from(value.toString(16).padStart(64, "0"), "hex");

export interface ChainTransaction {
  signature: string;
  slot: number;
  blockTime: number;
  err: unknown;
  logs: string[];
  /** The serialised transaction, as sent. */
  raw: Uint8Array;
  transaction: VersionedTransaction;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  /** Accounts the transaction names, those loaded from lookup tables too, for getSignaturesForAddress. */
  accounts: string[];
  /** The accounts loaded from lookup tables. */
  loaded?: { writable: string[]; readonly: string[] };
  /** Set for history that was written directly (the scanner's fixtures). */
  parsed?: unknown;
}

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** What `simulateTransaction` answers. */
export interface Simulation {
  err: unknown;
  logs: string[];
}

/** The pool's address lookup table on this chain: frozen, holding config, tree, vault and the system program. */
export const POOL_LOOKUP_TABLE = new PublicKey("LochTab1e1111111111111111111111111111111111");

export interface MockChainOptions {
  genesisHash?: string;
  screener: PublicKey;
  maxDeposit?: bigint;
  paused?: boolean;
  /** verification_key.json. Without it every proof is accepted. */
  verificationKey?: VerificationKey;
}

export class MockChain {
  genesisHash: string;
  screener: PublicKey;
  maxDeposit: bigint;
  paused: boolean;
  verificationKey: VerificationKey | undefined;
  /** False until `initialize` has run: the pool's accounts do not exist. */
  initialized = true;

  readonly lamports = new Map<string, bigint>();
  readonly nullifiers = new Set<string>();
  /** Frozen address lookup tables by address. */
  readonly lookupTables = new Map<string, PublicKey[]>([[POOL_LOOKUP_TABLE.toBase58(), [configPda(), treePda(), vaultPda(), SystemProgram.programId]]]);
  readonly transactions: ChainTransaction[] = [];
  readonly blockhashes = new Map<string, number>();
  /** Every JSON-RPC method called, in order. */
  readonly calls: string[] = [];
  /** Set to make every request fail as an unreachable node would. */
  down = false;
  slot = 1000;
  height = 900;
  /** Unix seconds given to the next transaction. Advances by one per transaction. */
  clock = 1_790_000_000;

  private tree = new MerkleTree();
  private roots: bigint[] = new Array<bigint>(ROOT_HISTORY).fill(0n);
  private currentRootIndex = 0;

  constructor(options: MockChainOptions) {
    this.genesisHash = options.genesisHash ?? LOCALNET_GENESIS;
    this.screener = options.screener;
    this.maxDeposit = options.maxDeposit ?? 10_000_000_000n;
    this.paused = options.paused ?? false;
    this.verificationKey = options.verificationKey;
    this.roots[0] = this.tree.root;
    this.lamports.set(vaultPda().toBase58(), RENT_MINIMUM);
  }

  // ---------------------------------------------------------------- balances

  balance(address: PublicKey | string): bigint {
    return this.lamports.get(typeof address === "string" ? address : address.toBase58()) ?? 0n;
  }

  airdrop(address: PublicKey | string, lamports: bigint): void {
    const key = typeof address === "string" ? address : address.toBase58();
    this.lamports.set(key, this.balance(key) + lamports);
  }

  get leafCount(): number {
    return this.tree.size;
  }

  get root(): bigint {
    return this.roots[this.currentRootIndex]!;
  }

  // --------------------------------------------------------------- execution

  /** Runs a transaction as `simulateTransaction` with `sigVerify: false` would: nothing it does is kept. */
  async simulate(raw: Uint8Array): Promise<Simulation> {
    try {
      return await this.process(raw, { simulate: true });
    } catch (error) {
      if (error instanceof RpcFailure && error.data && typeof error.data === "object" && "err" in error.data) return error.data as Simulation;
      throw error;
    }
  }

  /** Runs a transaction as the cluster would. Returns its id, or throws RpcFailure as `sendTransaction` answers. */
  async process(raw: Uint8Array): Promise<string>;
  async process(raw: Uint8Array, options: { simulate: true }): Promise<Simulation>;
  async process(raw: Uint8Array, options: { simulate?: boolean } = {}): Promise<string | Simulation> {
    let transaction: VersionedTransaction;
    try {
      transaction = VersionedTransaction.deserialize(raw);
    } catch {
      throw new RpcFailure(-32602, "failed to deserialize transaction");
    }
    const message = transaction.message as MessageV0;
    // The static keys, then the ones loaded from lookup tables: writable first, then read-only.
    const loaded: { writable: PublicKey[]; readonly: PublicKey[] } = { writable: [], readonly: [] };
    for (const lookup of message.addressTableLookups ?? []) {
      const table = this.lookupTables.get(lookup.accountKey.toBase58());
      const resolve = (index: number) => {
        const key = table?.[index];
        if (!key) throw new RpcFailure(-32602, "Transaction loads an address table account that doesn't exist");
        return key;
      };
      loaded.writable.push(...lookup.writableIndexes.map(resolve));
      loaded.readonly.push(...lookup.readonlyIndexes.map(resolve));
    }
    const keys = [...message.staticAccountKeys, ...loaded.writable, ...loaded.readonly];
    const serialised = message.serialize();
    const signers = keys.slice(0, message.header.numRequiredSignatures);
    for (const [index, signer] of signers.entries()) {
      if (options.simulate) break;
      const signature = transaction.signatures[index];
      if (!signature || !ed25519.verify(signature, serialised, signer.toBytes())) {
        throw new RpcFailure(-32003, "Transaction signature verification failure");
      }
    }
    const signature = base58.encode(transaction.signatures[0]!);
    if (!options.simulate && this.transactions.some((tx) => tx.signature === signature)) {
      throw new RpcFailure(-32002, "Transaction simulation failed: This transaction has already been processed", { err: "AlreadyProcessed", logs: [] });
    }
    const issuedAt = this.blockhashes.get(message.recentBlockhash);
    if (issuedAt === undefined || this.height > issuedAt + 150) {
      throw new RpcFailure(-32002, "Transaction simulation failed: Blockhash not found", { err: "BlockhashNotFound", logs: [] });
    }

    const payer = keys[0]!;
    const fee = SIGNATURE_FEE * BigInt(signers.length);
    if (this.balance(payer) < fee) {
      throw new RpcFailure(-32002, "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.", { err: "AccountNotFound", logs: [] });
    }

    const before = new Map(this.lamports);
    const preBalances = keys.map((key) => Number(this.balance(key)));
    const logs: string[] = [];
    const self = PROGRAM_ID.toBase58();
    let insertedPair = false;
    const createdNullifiers: string[] = [];

    const move = (from: PublicKey, to: PublicKey, amount: bigint) => {
      if (this.balance(from) < amount) throw new ProgramFailure("insufficient lamports", { InstructionError: [message.compiledInstructions.length - 1, { Custom: 1 }] });
      this.lamports.set(from.toBase58(), this.balance(from) - amount);
      this.lamports.set(to.toBase58(), this.balance(to) + amount);
    };
    const anchor = (name: string, number: number): ProgramFailure => {
      logs.push(`Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${number}. Error Message: ${name}.`);
      logs.push(`Program ${self} consumed 50000 of 300000 compute units`);
      logs.push(`Program ${self} failed: custom program error: 0x${number.toString(16)}`);
      return new ProgramFailure(name, { InstructionError: [message.compiledInstructions.length - 1, { Custom: number }] });
    };

    this.lamports.set(payer.toBase58(), this.balance(payer) - fee);
    try {
      for (const instruction of message.compiledInstructions) {
        const program = keys[instruction.programIdIndex]!;
        if (program.equals(ComputeBudgetProgram.programId) || program.equals(LIGHTHOUSE_PROGRAM_ID)) {
          // A wallet's assertions hold here: nothing they check is modelled.
          logs.push(`Program ${program.toBase58()} invoke [1]`, `Program ${program.toBase58()} success`);
          continue;
        }
        if (program.equals(SystemProgram.programId)) {
          // A plain transfer: instruction 2, lamports as u64.
          const data = Buffer.from(instruction.data);
          if (data.length === 12 && data.readUInt32LE(0) === 2) {
            move(keys[instruction.accountKeyIndexes[0]!]!, keys[instruction.accountKeyIndexes[1]!]!, data.readBigUInt64LE(4));
            logs.push(`Program ${program.toBase58()} invoke [1]`, `Program ${program.toBase58()} success`);
            continue;
          }
          throw new ProgramFailure("unsupported system instruction", { InstructionError: [0, "InvalidInstructionData"] });
        }
        if (!program.equals(PROGRAM_ID)) throw new ProgramFailure("unknown program", { InstructionError: [0, "IncorrectProgramId"] });
        if (!this.initialized) throw new ProgramFailure("AccountNotInitialized", { InstructionError: [0, { Custom: 3012 }] });

        logs.push(`Program ${self} invoke [1]`, "Program log: Instruction: Transact");
        const decoded = decodeTransactInstruction(instruction, keys);
        const { args, accounts } = decoded;
        for (const nullifier of args.inputNullifiers) {
          const address = nullifierPda(nullifier).toBase58();
          if (this.nullifiers.has(address)) {
            logs.push("Program 11111111111111111111111111111111 invoke [2]");
            logs.push(`Allocate: account Address { address: ${address}, base: None } already in use`);
            logs.push("Program 11111111111111111111111111111111 failed: custom program error: 0x0");
            logs.push(`Program ${self} failed: custom program error: 0x0`);
            throw new ProgramFailure("NullifierAlreadySpent", { InstructionError: [message.compiledInstructions.length - 1, { Custom: 0 }] });
          }
        }
        if ([args.root, ...args.inputNullifiers, ...args.outputCommitments].some((value) => bytesToField(value) >= FIELD_MODULUS)) throw anchor("NonCanonicalFieldElement", 6011);
        if (transactAccountsProblem(decoded, PROGRAM_ID)) throw anchor("RecipientMismatch", 6003);
        if (!signers.some((key) => key.equals(accounts.signer))) throw new ProgramFailure("missing signer", { InstructionError: [0, "MissingRequiredSignature"] });

        const root = bytesToField(args.root);
        if (root === 0n || !this.roots.includes(root)) throw anchor("UnknownRoot", 6001);
        if ([args.proof.a, args.proof.b, args.proof.c].some((part) => part.every((byte) => byte === 0))) throw anchor("ZeroProofElement", 6012);
        if (this.verificationKey && !(await verifyProof(this.verificationKey, decodeProof(args.proof), transactPublicInputs(args)))) throw anchor("InvalidProof", 6000);

        const ext = args.extData;
        // The signer pays the rent of the two nullifier records.
        for (const nullifier of args.inputNullifiers) {
          const record = nullifierPda(nullifier);
          move(accounts.signer, record, NULLIFIER_RENT);
          createdNullifiers.push(record.toBase58());
        }
        if (ext.extAmount > 0n) {
          if (this.paused) throw anchor("DepositsPaused", 6007);
          if (!accounts.screener || !accounts.screener.equals(this.screener) || !signers.some((key) => key.equals(this.screener))) throw anchor("MissingScreenerSignature", 6005);
          if (ext.extAmount > this.maxDeposit) throw anchor("DepositTooLarge", 6006);
          move(accounts.signer, accounts.vault, ext.extAmount);
        } else if (ext.extAmount < 0n) {
          move(accounts.vault, accounts.recipient, -ext.extAmount);
        }
        if (ext.fee > 0n) move(accounts.vault, accounts.relayer, ext.fee);

        logs.push(...this.insert(args));
        insertedPair = true;
        logs.push(`Program ${self} consumed 175000 of 300000 compute units`, `Program ${self} success`);
      }
      // The runtime checks rent after the program has returned.
      for (const key of keys) {
        const after = this.balance(key);
        const was = before.get(key.toBase58()) ?? 0n;
        if (after !== was && after > 0n && after < RENT_MINIMUM && !createdNullifiers.includes(key.toBase58())) {
          throw new ProgramFailure("InsufficientFundsForRent", { InsufficientFundsForRent: { account_index: keys.indexOf(key) } });
        }
      }
      if (options.simulate) {
        this.lamports.clear();
        for (const [key, value] of before) this.lamports.set(key, value);
        if (insertedPair) this.rollbackLastPair();
        return { err: null, logs };
      }
      for (const record of createdNullifiers) this.nullifiers.add(record);
    } catch (error) {
      if (!(error instanceof ProgramFailure)) throw error;
      // A node simulates before it accepts: a transaction that would fail is refused and leaves
      // no trace, not even the fee.
      this.lamports.clear();
      for (const [key, value] of before) this.lamports.set(key, value);
      if (insertedPair) this.rollbackLastPair();
      throw new RpcFailure(-32002, `Transaction simulation failed: Error processing Instruction: ${JSON.stringify(error.err)}`, { err: error.err, logs });
    }

    this.height++;
    const record: ChainTransaction = {
      signature,
      slot: this.slot++,
      blockTime: this.clock++,
      err: null,
      logs,
      raw,
      transaction,
      fee: Number(fee),
      preBalances,
      postBalances: keys.map((key) => Number(this.balance(key))),
      accounts: keys.map((key) => key.toBase58()),
      loaded: { writable: loaded.writable.map((key) => key.toBase58()), readonly: loaded.readonly.map((key) => key.toBase58()) },
    };
    this.transactions.push(record);
    return signature;
  }

  private insert(args: TransactArgs): string[] {
    const leaves = args.outputCommitments.map((commitment) => bytesToField(commitment));
    const first = this.tree.size;
    this.tree.append(leaves);
    this.currentRootIndex = (this.currentRootIndex + 1) % ROOT_HISTORY;
    this.roots[this.currentRootIndex] = this.tree.root;
    const outputs = [args.extData.encryptedOutput0, args.extData.encryptedOutput1];
    const lines = args.outputCommitments.map((commitment, i) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(outputs[i]!.length);
      const event = Buffer.concat([NEW_COMMITMENT_DISCRIMINATOR, u64le(BigInt(first + i)), commitment, length, outputs[i]!]);
      return `Program data: ${event.toString("base64")}`;
    });
    lines.push(`Program data: ${Buffer.concat([NEW_NULLIFIERS_DISCRIMINATOR, ...args.inputNullifiers]).toString("base64")}`);
    return lines;
  }

  private rollbackLastPair(): void {
    this.tree.truncate(this.tree.size - 2);
    this.roots[this.currentRootIndex] = 0n;
    this.currentRootIndex = (this.currentRootIndex + ROOT_HISTORY - 1) % ROOT_HISTORY;
  }

  /** A blockhash the cluster will accept for the next 150 blocks. */
  newBlockhash(): { blockhash: string; lastValidBlockHeight: number } {
    const blockhash = base58.encode(randomBytes(32));
    this.blockhashes.set(blockhash, this.height);
    return { blockhash, lastValidBlockHeight: this.height + 150 };
  }

  /**
   * Writes public history for the leak scanner: plain SOL transfers into and out of `owner`.
   * Each becomes a `jsonParsed` transaction the node would return.
   */
  seedTransfers(owner: string, transfers: { dir: "in" | "out"; counterparty: string; sol: number; time: number }[]): void {
    for (const transfer of transfers) {
      const signature = base58.encode(randomBytes(64));
      const source = transfer.dir === "out" ? owner : transfer.counterparty;
      const destination = transfer.dir === "out" ? transfer.counterparty : owner;
      const parsed = {
        slot: this.slot,
        blockTime: transfer.time,
        version: "legacy",
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: source, signer: true, writable: true, source: "transaction" },
              { pubkey: destination, signer: false, writable: true, source: "transaction" },
              { pubkey: SystemProgram.programId.toBase58(), signer: false, writable: false, source: "transaction" },
            ],
            recentBlockhash: base58.encode(randomBytes(32)),
            instructions: [
              {
                program: "system",
                programId: SystemProgram.programId.toBase58(),
                parsed: { type: "transfer", info: { source, destination, lamports: Math.round(transfer.sol * 1e9) } },
                stackHeight: null,
              },
            ],
          },
        },
        meta: { err: null, fee: 5000, innerInstructions: [], preBalances: [0, 0, 1], postBalances: [0, 0, 1], logMessages: [], preTokenBalances: [], postTokenBalances: [], rewards: [], status: { Ok: null } },
      };
      this.transactions.push({
        signature,
        slot: this.slot++,
        blockTime: transfer.time,
        err: null,
        logs: [],
        raw: new Uint8Array(),
        transaction: undefined as unknown as VersionedTransaction,
        fee: 5000,
        preBalances: [],
        postBalances: [],
        accounts: [source, destination],
        parsed,
      });
    }
  }

  // ---------------------------------------------------------------- JSON-RPC

  /** Answers one JSON-RPC body (a call or a batch), as an HTTP node would. */
  async handle(body: unknown): Promise<unknown> {
    if (Array.isArray(body)) return Promise.all(body.map((item) => this.one(item)));
    return this.one(body);
  }

  private async one(call: unknown): Promise<unknown> {
    const { id, method, params } = call as { id: unknown; method: string; params?: unknown[] };
    this.calls.push(method);
    try {
      if (this.down) throw new RpcFailure(-32005, "Node is unhealthy");
      return { jsonrpc: "2.0", id, result: await this.dispatch(method, params ?? []) };
    } catch (error) {
      if (error instanceof RpcFailure) return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } };
      return { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "internal error" } };
    }
  }

  private context() {
    return { apiVersion: "2.2.0", slot: this.slot };
  }

  private accountInfo(address: string): unknown {
    const account = (data: Buffer, owner: PublicKey, lamports: bigint) => ({
      data: [data.toString("base64"), "base64"],
      executable: false,
      lamports: Number(lamports),
      owner: owner.toBase58(),
      rentEpoch: 0,
      space: data.length,
    });
    if (this.initialized && address === treePda().toBase58()) return account(this.treeData(), PROGRAM_ID, 10_000_000n);
    if (this.initialized && address === configPda().toBase58()) return account(this.configData(), PROGRAM_ID, 2_000_000n);
    const table = this.lookupTables.get(address);
    if (table) {
      // 56 bytes of metadata (type 1, never deactivated, no authority: frozen), then the addresses.
      const data = Buffer.alloc(56 + 32 * table.length);
      data.writeUInt32LE(1, 0);
      data.writeBigUInt64LE((1n << 64n) - 1n, 4);
      table.forEach((key, index) => key.toBuffer().copy(data, 56 + 32 * index));
      return account(data, new PublicKey("AddressLookupTab1e1111111111111111111111111"), 1_000_000n);
    }
    if (this.nullifiers.has(address)) return account(Buffer.concat([discriminator("account:NullifierRecord"), Buffer.from([255])]), PROGRAM_ID, NULLIFIER_RENT);
    const lamports = this.balance(address);
    return lamports > 0n ? account(Buffer.alloc(0), SystemProgram.programId, lamports) : null;
  }

  private treeData(): Buffer {
    const zeros = Buffer.alloc(LEVELS * 32);
    return Buffer.concat([
      discriminator("account:MerkleTree"),
      u64le(BigInt(this.tree.size)),
      u64le(BigInt(this.currentRootIndex)),
      zeros,
      zeros,
      ...this.roots.map(be32),
    ]);
  }

  private configData(): Buffer {
    return Buffer.concat([
      discriminator("account:PoolConfig"),
      Keypair.generate().publicKey.toBuffer(),
      this.screener.toBuffer(),
      u64le(this.maxDeposit),
      Buffer.from([this.paused ? 1 : 0, 254, 255]),
    ]);
  }

  private jsonTransaction(tx: ChainTransaction, encoding: string): unknown {
    if (tx.parsed) return tx.parsed;
    const message = tx.transaction.message as MessageV0;
    const keys = message.staticAccountKeys.map((key) => key.toBase58());
    const all = [...keys, ...(tx.loaded?.writable ?? []), ...(tx.loaded?.readonly ?? [])];
    const lookups = (message.addressTableLookups ?? []).map((lookup) => ({
      accountKey: lookup.accountKey.toBase58(),
      writableIndexes: lookup.writableIndexes,
      readonlyIndexes: lookup.readonlyIndexes,
    }));
    const meta = {
      err: tx.err,
      fee: tx.fee,
      innerInstructions: [],
      logMessages: tx.logs,
      preBalances: tx.preBalances,
      postBalances: tx.postBalances,
      preTokenBalances: [],
      postTokenBalances: [],
      rewards: [],
      loadedAddresses: tx.loaded ?? { writable: [], readonly: [] },
      status: tx.err === null ? { Ok: null } : { Err: tx.err },
      computeUnitsConsumed: 175000,
    };
    const signatures = tx.transaction.signatures.map((signature) => base58.encode(signature));
    if (encoding === "jsonParsed") {
      const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = message.header;
      return {
        slot: tx.slot,
        blockTime: tx.blockTime,
        version: 0,
        meta,
        transaction: {
          signatures,
          message: {
            accountKeys: [
              ...keys.map((pubkey, index) => ({
                pubkey,
                signer: index < numRequiredSignatures,
                writable: index < numRequiredSignatures ? index < numRequiredSignatures - numReadonlySignedAccounts : index < keys.length - numReadonlyUnsignedAccounts,
                source: "transaction",
              })),
              ...(tx.loaded?.writable ?? []).map((pubkey) => ({ pubkey, signer: false, writable: true, source: "lookupTable" })),
              ...(tx.loaded?.readonly ?? []).map((pubkey) => ({ pubkey, signer: false, writable: false, source: "lookupTable" })),
            ],
            recentBlockhash: message.recentBlockhash,
            addressTableLookups: lookups,
            instructions: message.compiledInstructions.map((instruction) => ({
              programId: all[instruction.programIdIndex],
              accounts: instruction.accountKeyIndexes.map((index) => all[index]),
              data: base58.encode(instruction.data),
              stackHeight: null,
            })),
          },
        },
      };
    }
    return {
      slot: tx.slot,
      blockTime: tx.blockTime,
      version: 0,
      meta,
      transaction: {
        signatures,
        message: {
          accountKeys: keys,
          header: message.header,
          recentBlockhash: message.recentBlockhash,
          addressTableLookups: lookups,
          instructions: message.compiledInstructions.map((instruction) => ({
            programIdIndex: instruction.programIdIndex,
            accounts: instruction.accountKeyIndexes,
            data: base58.encode(instruction.data),
            stackHeight: null,
          })),
        },
      },
    };
  }

  private async dispatch(method: string, params: unknown[]): Promise<unknown> {
    const options = (index: number) => (params[index] ?? {}) as Record<string, unknown>;
    switch (method) {
      case "getGenesisHash":
        return this.genesisHash;
      case "getHealth":
        return "ok";
      case "getVersion":
        return { "solana-core": "2.2.0", "feature-set": 1 };
      case "getSlot":
        return this.slot;
      case "getBlockHeight":
        return this.height;
      case "getBalance":
        return { context: this.context(), value: Number(this.balance(params[0] as string)) };
      case "getLatestBlockhash":
        return { context: this.context(), value: this.newBlockhash() };
      case "getMinimumBalanceForRentExemption":
        return Number((128n + BigInt(params[0] as number)) * 6960n);
      case "getAccountInfo":
        return { context: this.context(), value: this.accountInfo(params[0] as string) };
      case "getMultipleAccounts":
        return { context: this.context(), value: (params[0] as string[]).map((address) => this.accountInfo(address)) };
      case "getTokenAccountsByOwner":
        return { context: this.context(), value: [] };
      case "getSignaturesForAddress": {
        const address = params[0] as string;
        const { limit = 1000, before, until } = options(1) as { limit?: number; before?: string; until?: string };
        let newestFirst = this.transactions.filter((tx) => tx.accounts.includes(address)).reverse();
        if (before) {
          const at = newestFirst.findIndex((tx) => tx.signature === before);
          newestFirst = at < 0 ? [] : newestFirst.slice(at + 1);
        }
        if (until) {
          const at = newestFirst.findIndex((tx) => tx.signature === until);
          if (at >= 0) newestFirst = newestFirst.slice(0, at);
        }
        return newestFirst.slice(0, limit).map((tx) => ({ signature: tx.signature, slot: tx.slot, err: tx.err, memo: null, blockTime: tx.blockTime, confirmationStatus: "finalized" }));
      }
      case "getTransaction": {
        const tx = this.transactions.find((item) => item.signature === params[0]);
        return tx ? this.jsonTransaction(tx, (options(1).encoding as string | undefined) ?? "json") : null;
      }
      case "getSignatureStatuses":
        return {
          context: this.context(),
          value: (params[0] as string[]).map((signature) => {
            const tx = this.transactions.find((item) => item.signature === signature);
            return tx ? { slot: tx.slot, confirmations: null, err: tx.err, status: tx.err === null ? { Ok: null } : { Err: tx.err }, confirmationStatus: "finalized" } : null;
          }),
        };
      case "simulateTransaction": {
        const raw = Buffer.from(params[0] as string, "base64");
        const { err, logs } = await this.simulate(raw);
        return { context: this.context(), value: { err, logs, accounts: null, unitsConsumed: 175000, returnData: null } };
      }
      case "sendTransaction": {
        const encoding = (options(1).encoding as string | undefined) ?? "base58";
        const raw = encoding === "base64" ? Buffer.from(params[0] as string, "base64") : base58.decode(params[0] as string);
        return this.process(raw);
      }
      default:
        throw new RpcFailure(-32601, `Method not found: ${method}`);
    }
  }
}

class ProgramFailure extends Error {
  constructor(
    message: string,
    readonly err: unknown,
  ) {
    super(message);
  }
}
