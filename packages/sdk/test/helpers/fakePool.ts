// An in-memory stand-in for the loch_pool program and for the RPC methods the
// SDK calls. It does what programs/loch_pool/src/lib.rs does with a `transact`
// instruction: recomputes the public inputs from the instruction alone,
// verifies the proof against verification_key.json, enforces root history and
// nullifier uniqueness, inserts the leaves with a port of merkle.rs, and logs
// Anchor events. No network.

import { base58 } from "@scure/base";
import {
  ComputeBudgetProgram,
  Keypair,
  type MessageV0,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import { poseidon2 } from "poseidon-lite/poseidon2";

import { bigIntToBytesBE, bigIntToBytesLE, bytesToBase64, bytesToBigIntBE, concatBytes } from "../../src/bytes.js";
import { MERKLE_TREE_DISCRIMINATOR, POOL_CONFIG_DISCRIMINATOR } from "../../src/constants.js";
import {
  NEW_COMMITMENT_DISCRIMINATOR,
  NEW_NULLIFIERS_DISCRIMINATOR,
  PROGRAM_ID,
  type TransactArgs,
  type VerificationKey,
  configPda,
  decodeProof,
  decodeTransactInstruction,
  nullifierPda,
  transactAccountsProblem,
  transactPublicInputs,
  treePda,
  verifyProof,
} from "../../src/index.js";

const LEVELS = 20;
const ROOT_HISTORY = 64;

/**
 * Port of programs/loch_pool/src/merkle.rs: filled subtrees, a root ring
 * buffer, and leaves appended one pair per transaction with ONE root recorded
 * per pair (`insert_pair`).
 */
export class OnChainTree {
  nextIndex = 0;
  currentRootIndex = 0;
  readonly filledSubtrees: bigint[] = [];
  readonly zeros: bigint[] = [];
  readonly roots: bigint[] = new Array<bigint>(ROOT_HISTORY).fill(0n);

  constructor() {
    let current = 0n;
    for (let i = 0; i < LEVELS; i++) {
      this.zeros.push(current);
      this.filledSubtrees.push(current);
      current = poseidon2([current, current]);
    }
    this.roots[0] = current;
  }

  insertPair(leaf0: bigint, leaf1: bigint): [number, number] {
    const index0 = this.nextIndex;
    if (index0 % 2 !== 0) throw new Error("TreeNotPairAligned");
    if (index0 + 2 > 2 ** LEVELS) throw new Error("TreeFull");
    let current = poseidon2([leaf0, leaf1]);
    this.filledSubtrees[0] = leaf0;
    let currentIndex = index0 / 2;
    for (let i = 1; i < LEVELS; i++) {
      if (currentIndex % 2 === 0) {
        this.filledSubtrees[i] = current;
        current = poseidon2([current, this.zeros[i]!]);
      } else {
        current = poseidon2([this.filledSubtrees[i]!, current]);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }
    this.currentRootIndex = (this.currentRootIndex + 1) % ROOT_HISTORY;
    this.roots[this.currentRootIndex] = current;
    this.nextIndex = index0 + 2;
    return [index0, index0 + 1];
  }

  get root(): bigint {
    return this.roots[this.currentRootIndex]!;
  }

  isKnownRoot(root: bigint): boolean {
    return root !== 0n && this.roots.includes(root);
  }

  /** The account data as the zero-copy MerkleTree lays it out. */
  accountData(): Uint8Array {
    const words = (values: bigint[]) => values.map((v) => bigIntToBytesBE(v, 32));
    return concatBytes(
      MERKLE_TREE_DISCRIMINATOR,
      bigIntToBytesLE(BigInt(this.nextIndex), 8),
      bigIntToBytesLE(BigInt(this.currentRootIndex), 8),
      ...words(this.filledSubtrees),
      ...words(this.zeros),
      ...words(this.roots),
    );
  }
}

export interface FakeTransaction {
  signature: string;
  slot: number;
  err: unknown;
  logs: string[] | null;
  message: MessageV0;
  innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[];
}

export interface FakePoolOptions {
  programId?: PublicKey;
  screener: PublicKey;
  maxDeposit?: bigint;
  paused?: boolean;
  verificationKey?: VerificationKey;
}

export class ProgramRejection extends Error {
  constructor(
    readonly errorName: string,
    readonly logs: string[],
  ) {
    super(errorName);
  }
}

const ERROR_NUMBERS: Record<string, number> = {
  InvalidProof: 6000,
  UnknownRoot: 6001,
  RecipientMismatch: 6003,
  MissingScreenerSignature: 6005,
  DepositTooLarge: 6006,
  DepositsPaused: 6007,
  NonCanonicalFieldElement: 6011,
  ZeroProofElement: 6012,
  InvalidDestination: 6016,
};

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export class FakePool {
  readonly programId: PublicKey;
  tree = new OnChainTree();
  readonly nullifiers = new Set<string>();
  /** Every pair of leaves inserted, with the nullifier records created next to it, for `rollback`. */
  private readonly journal: { leaves: [bigint, bigint]; nullifiers: string[] }[] = [];
  readonly transactions: FakeTransaction[] = [];
  /** Lamports by account, for the transfers the program makes. */
  readonly lamports = new Map<string, bigint>();
  /** Calls made to the RPC methods, by name. */
  readonly calls: Record<string, number> = {};
  screener: PublicKey;
  maxDeposit: bigint;
  paused: boolean;
  /** What getMinimumBalanceForRentExemption(0) returns. */
  rentExemptMinimum = 890_880;
  /** The next N reads of the tree account return an empty tree, to imitate a lagging node. */
  staleTreeReads = 0;
  /** The next N getTransaction calls return null, to imitate a node that lists before it serves. */
  missingTransactionReads = 0;
  /** Set to false to accept any proof bytes (for tests that are not about proofs). */
  verifyProofs = true;
  /**
   * The block time the node reports for a slot, in Unix seconds, or null for
   * a node that does not know it. Default: null, like a node without block
   * times; a test about times sets it.
   */
  blockTimeOf: (slot: number) => number | null = () => null;
  /** Which answers carry the block time: both by default, as a real node's do. */
  blockTimeIn = { listing: true, transaction: true };
  private readonly verificationKey: VerificationKey;
  private slot = 1000;

  constructor(options: FakePoolOptions) {
    this.programId = options.programId ?? PROGRAM_ID;
    this.screener = options.screener;
    this.maxDeposit = options.maxDeposit ?? 10_000_000_000n;
    this.paused = options.paused ?? false;
    this.verificationKey = options.verificationKey ?? {};
    this.verifyProofs = options.verificationKey !== undefined;
  }

  balanceOf(account: PublicKey): bigint {
    return this.lamports.get(account.toBase58()) ?? 0n;
  }

  private credit(account: PublicKey, amount: bigint): void {
    this.lamports.set(account.toBase58(), this.balanceOf(account) + amount);
  }

  /**
   * Executes a transaction the way the cluster and the program would. Returns
   * the signature; throws ProgramRejection (with Anchor-style logs) if the
   * program rejects it. The failed transaction is recorded either way.
   */
  async process(transaction: VersionedTransaction): Promise<string> {
    const message = transaction.message as MessageV0;
    const keys = message.staticAccountKeys;
    // A cluster never records one signature twice (it refuses the second copy as already
    // processed), so a transaction sent again verbatim gets an id of its own here.
    const given = base58.encode(transaction.signatures[0]!);
    const reusable = transaction.signatures[0]!.some((b) => b !== 0) && !this.transactions.some((tx) => tx.signature === given);
    const signature = reusable ? given : base58.encode(crypto.getRandomValues(new Uint8Array(64)));
    const logs: string[] = [];
    const record = (err: unknown) => {
      this.transactions.push({ signature, slot: this.slot++, err, logs, message });
    };
    const self = this.programId.toBase58();
    const reject = (name: string, anchor = true): never => {
      if (anchor) {
        const number = ERROR_NUMBERS[name]!;
        logs.push(`Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${number}. Error Message: ${name}.`);
        logs.push(`Program ${self} consumed 50000 of 300000 compute units`);
        logs.push(`Program ${self} failed: custom program error: 0x${number.toString(16)}`);
        record({ InstructionError: [message.compiledInstructions.length - 1, { Custom: number }] });
      } else {
        logs.push(`Program ${self} failed: custom program error: 0x0`);
        record({ InstructionError: [message.compiledInstructions.length - 1, { Custom: 0 }] });
      }
      throw new ProgramRejection(name, logs);
    };

    for (const instruction of message.compiledInstructions) {
      const program = keys[instruction.programIdIndex]!;
      if (program.equals(ComputeBudgetProgram.programId)) {
        logs.push(`Program ${program.toBase58()} invoke [1]`, `Program ${program.toBase58()} success`);
        continue;
      }
      if (!program.equals(this.programId)) throw new Error("the fake pool only runs loch_pool and compute budget instructions");
      logs.push(`Program ${self} invoke [1]`, "Program log: Instruction: Transact");
      const decoded = decodeTransactInstruction(instruction, keys);
      const { args, accounts } = decoded;
      // `init` on the nullifier accounts runs before the handler: the system program
      // refuses an account that exists.
      for (const nullifier of args.inputNullifiers) {
        const address = PublicKey.findProgramAddressSync([Buffer.from("nullifier"), nullifier], this.programId)[0].toBase58();
        if (this.nullifiers.has(address)) {
          logs.push(`Program 11111111111111111111111111111111 invoke [2]`);
          logs.push(`Allocate: account Address { address: ${address}, base: None } already in use`);
          logs.push(`Program 11111111111111111111111111111111 failed: custom program error: 0x0`);
          return reject("NullifierAlreadySpent", false);
        }
      }
      const values = [args.root, ...args.inputNullifiers, ...args.outputCommitments];
      if (values.some((value) => bytesToBigIntBE(value) >= FIELD_MODULUS)) return reject("NonCanonicalFieldElement");
      const problem = transactAccountsProblem(decoded, this.programId);
      if (problem) return reject("RecipientMismatch");

      // Lamports paid out of the vault may not go to the vault or to an account the program owns.
      const poolOwned = (key: PublicKey) =>
        key.equals(accounts.vault) ||
        key.equals(accounts.tree) ||
        key.equals(accounts.config) ||
        key.equals(accounts.nullifier0) ||
        key.equals(accounts.nullifier1) ||
        this.nullifiers.has(key.toBase58());
      if ((args.extData.extAmount < 0n && poolOwned(accounts.recipient)) || (args.extData.fee > 0n && poolOwned(accounts.relayer))) {
        return reject("InvalidDestination");
      }

      // Signers, as the runtime checks them.
      const signerKeys = keys.slice(0, message.header.numRequiredSignatures);
      const isSigner = (key: PublicKey) => signerKeys.some((k) => k.equals(key));
      if (!isSigner(accounts.signer)) throw new Error("signer account did not sign");

      if (!this.tree.isKnownRoot(bytesToBigIntBE(args.root))) return reject("UnknownRoot");

      // The program rebuilds the public inputs from the instruction alone.
      if ([args.proof.a, args.proof.b, args.proof.c].some((part) => part.every((byte) => byte === 0))) return reject("ZeroProofElement");
      const publicInputs = transactPublicInputs(args);
      const valid = !this.verifyProofs || (await verifyProof(this.verificationKey, decodeProof(args.proof), publicInputs));
      if (!valid) return reject("InvalidProof");

      const ext = args.extData;
      if (ext.extAmount > 0n) {
        if (this.paused) return reject("DepositsPaused");
        if (!accounts.screener || !accounts.screener.equals(this.screener) || !isSigner(accounts.screener)) {
          return reject("MissingScreenerSignature");
        }
        if (ext.extAmount > this.maxDeposit) return reject("DepositTooLarge");
        this.credit(accounts.signer, -ext.extAmount);
        this.credit(accounts.vault, ext.extAmount);
      } else if (ext.extAmount < 0n) {
        this.credit(accounts.vault, ext.extAmount);
        this.credit(accounts.recipient, -ext.extAmount);
      }
      if (ext.fee > 0n) {
        this.credit(accounts.vault, -ext.fee);
        this.credit(accounts.relayer, ext.fee);
      }

      logs.push(...this.insertAndLog(args));
      for (const nullifier of args.inputNullifiers) {
        const record = nullifierPda(nullifier, this.programId).toBase58();
        this.nullifiers.add(record);
        this.journal.at(-1)!.nullifiers.push(record);
      }
      logs.push(`Program ${self} consumed 175000 of 300000 compute units`, `Program ${self} success`);
    }
    record(null);
    return signature;
  }

  /** Inserts both commitments and returns the "Program data:" lines the program emits. */
  private insertAndLog(args: TransactArgs): string[] {
    const outputs = [args.extData.encryptedOutput0, args.extData.encryptedOutput1];
    const leaves: [bigint, bigint] = [bytesToBigIntBE(args.outputCommitments[0]), bytesToBigIntBE(args.outputCommitments[1])];
    const indices = this.tree.insertPair(...leaves);
    this.journal.push({ leaves, nullifiers: [] });
    const lines = args.outputCommitments.map((commitment, i) => {
      const index = indices[i]!;
      const event = concatBytes(
        NEW_COMMITMENT_DISCRIMINATOR,
        bigIntToBytesLE(BigInt(index), 8),
        commitment,
        bigIntToBytesLE(BigInt(outputs[i]!.length), 4),
        outputs[i]!,
      );
      return `Program data: ${bytesToBase64(event)}`;
    });
    lines.push(`Program data: ${bytesToBase64(concatBytes(NEW_NULLIFIERS_DISCRIMINATOR, ...args.inputNullifiers))}`);
    return lines;
  }

  /** Appends leaves as the program would and returns the event log lines, without a transaction. */
  insertLeaves(args: TransactArgs): string[] {
    return this.insertAndLog(args);
  }

  /**
   * Undoes the newest `count` transactions the way a fork that drops them
   * would: their leaves, roots and nullifier records are gone and the history
   * no longer lists them. Only for histories in which each of those
   * transactions is one successful `transact`.
   */
  rollback(count: number): void {
    if (count > this.journal.length || count > this.transactions.length) throw new Error("nothing to roll back");
    this.transactions.splice(this.transactions.length - count, count);
    for (const undone of this.journal.splice(this.journal.length - count, count)) {
      for (const record of undone.nullifiers) this.nullifiers.delete(record);
    }
    this.tree = new OnChainTree();
    for (const entry of this.journal) this.tree.insertPair(...entry.leaves);
  }

  /** Records a transaction built by hand (for CPI, foreign programs, truncated logs). */
  push(tx: Omit<FakeTransaction, "signature" | "slot"> & { signature?: string }): string {
    const signature = tx.signature ?? base58.encode(crypto.getRandomValues(new Uint8Array(64)));
    this.transactions.push({ ...tx, signature, slot: this.slot++ });
    return signature;
  }

  // ---- the RPC surface the SDK uses ----

  private count(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  /** A `Connection` stand-in: cast it where the SDK expects one. */
  get connection(): any {
    return {
      getSignaturesForAddress: async (address: PublicKey, options: { before?: string; until?: string; limit?: number } = {}) => {
        this.count("getSignaturesForAddress");
        if (!address.equals(treePda(this.programId))) return [];
        let newestFirst = [...this.transactions].reverse();
        if (options.before) {
          const at = newestFirst.findIndex((tx) => tx.signature === options.before);
          newestFirst = at < 0 ? [] : newestFirst.slice(at + 1);
        }
        if (options.until) {
          const at = newestFirst.findIndex((tx) => tx.signature === options.until);
          if (at >= 0) newestFirst = newestFirst.slice(0, at);
        }
        return newestFirst
          .slice(0, options.limit ?? 1000)
          .map((tx) => ({ signature: tx.signature, slot: tx.slot, err: tx.err, memo: null, blockTime: this.blockTimeIn.listing ? this.blockTimeOf(tx.slot) : null }));
      },
      getTransaction: async (signature: string, config: { maxSupportedTransactionVersion?: number }) => {
        this.count("getTransaction");
        if (config?.maxSupportedTransactionVersion !== 1) throw new Error("the SDK must request maxSupportedTransactionVersion: 1");
        if (this.missingTransactionReads > 0) {
          this.missingTransactionReads--;
          return null;
        }
        const tx = this.transactions.find((candidate) => candidate.signature === signature);
        if (!tx) return null;
        return {
          slot: tx.slot,
          blockTime: this.blockTimeIn.transaction ? this.blockTimeOf(tx.slot) : null,
          version: 0,
          transaction: { message: tx.message, signatures: [tx.signature] },
          meta: {
            err: tx.err,
            fee: 5000,
            logMessages: tx.logs,
            innerInstructions: tx.innerInstructions ?? [],
            loadedAddresses: { writable: [], readonly: [] },
            preBalances: [],
            postBalances: [],
          },
        };
      },
      getAccountInfo: async (address: PublicKey) => {
        this.count("getAccountInfo");
        if (address.equals(treePda(this.programId))) {
          return { owner: this.programId, lamports: 1, executable: false, data: this.treeAccountData() };
        }
        if (address.equals(configPda(this.programId))) {
          return { owner: this.programId, lamports: 1, executable: false, data: this.configAccountData() };
        }
        const lamports = this.balanceOf(address);
        return lamports > 0n ? { owner: SystemProgram.programId, lamports: Number(lamports), executable: false, data: new Uint8Array(0) } : null;
      },
      getMultipleAccountsInfo: async (addresses: PublicKey[]) => {
        this.count("getMultipleAccountsInfo");
        if (addresses.length > 100) throw new Error("getMultipleAccountsInfo takes at most 100 addresses");
        return addresses.map((address) => {
          if (this.nullifiers.has(address.toBase58())) {
            return { owner: this.programId, lamports: 953_520, executable: false, data: new Uint8Array(9) };
          }
          const lamports = this.balanceOf(address);
          return lamports > 0n ? { owner: SystemProgram.programId, lamports: Number(lamports), executable: false, data: new Uint8Array(0) } : null;
        });
      },
      getMinimumBalanceForRentExemption: async () => this.rentExemptMinimum,
    };
  }

  private treeAccountData(): Uint8Array {
    if (this.staleTreeReads > 0) {
      this.staleTreeReads--;
      const stale = new OnChainTree();
      return stale.accountData();
    }
    return this.tree.accountData();
  }

  configAccountData(): Uint8Array {
    return concatBytes(
      POOL_CONFIG_DISCRIMINATOR,
      Keypair.generate().publicKey.toBytes(),
      this.screener.toBytes(),
      bigIntToBytesLE(this.maxDeposit, 8),
      Uint8Array.of(this.paused ? 1 : 0, 254, 255),
    );
  }
}
