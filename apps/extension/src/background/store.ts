// Where things are kept.
//
//   chrome.storage.local (disk)
//     settings                     endpoints and choices, in the clear
//     wallets                      [{ address, walletName, addedAt, salt, check }], in the clear
//     active                       the address the interface shows
//     vault:<address>:state        the SDK wallet state (leaves, notes), the
//                                  spends sent but not yet seen on chain, and
//                                  the notes shown in a depth proof            ENCRYPTED
//     vault:<address>:activity     the activity log                            ENCRYPTED
//     vault:<address>:records      the wallet's own transactions, opened: what
//                                  receipts, reports and claim links are made
//                                  from (records.ts)                           ENCRYPTED
//     vault:<address>:scan         the last leak scan (report and transfers)   ENCRYPTED
//
//   chrome.storage.session (memory; gone when the browser closes)
//     secret:<address>             the wallet's key-derivation signature
//     flow:<address>               the flow in progress, if any
//     view:<address>               public balance, sync status
//     bridge:*                     the connect tab and the requests it has been sent
//
// Unlocking means asking the wallet for its signature again; locking means dropping
// secret:<address>. "Forget this wallet" removes every key above that names the address, and
// from that moment nothing that was already running for it (a sync, a scan, a flow) can write
// one back: every write goes through `live` or `holds` below.

import { type LochKeys, type MerkleTree, type WalletState, createWalletState, deriveKeys, encodeShieldedAddress, parseWalletState, treeFromState } from "@loch/sdk";
import { PublicKey } from "@solana/web3.js";

import { fromBase64, toBase64 } from "../shared/bytes.js";
import { isBase58Address, isBase64, isNonEmptyString, isRecord, isSafeInteger } from "../shared/guards.js";
import type { ActivityEntry, ScanView } from "../shared/view.js";
import type { KV } from "./kv.js";
import type { PendingSpend } from "./pending.js";
import { type TxRecord, parseRecords } from "./records.js";
import { type SealedRecord, VaultError, deriveVaultKey, isSealedRecord, newVaultSalt, open, seal } from "./vault.js";

export interface WalletRecord {
  address: string;
  /** The Wallet Standard name of the wallet that holds this address, e.g. "Phantom". */
  walletName: string;
  addedAt: number;
  /** Salt of the vault key, base64. Not secret. */
  salt: string;
  /** A sealed constant: opening it proves a signature is the one the vault was made with. */
  check: SealedRecord;
}

/** What an unlocked wallet has in memory. */
export interface WalletRuntime {
  address: string;
  walletName: string;
  keys: LochKeys;
  shieldedAddress: string;
  vaultKey: CryptoKey;
  state: WalletState;
  /** Built on first use and replaced by each sync. */
  tree: MerkleTree | null;
  activity: ActivityEntry[];
  scan: StoredScan | null;
  /** True until the first sync of this wallet on this device has finished. */
  neverSynced: boolean;
  /** Spends sent from this device that the synced state does not show yet. Saved with the state. */
  pending: PendingSpend[];
  /** Commitments (decimal) of notes this device created itself, newest last. Saved with the state. */
  ownOutputs: string[];
  /** This device's own transactions, opened (records.ts), oldest first. */
  records: TxRecord[];
  /**
   * Commitments (decimal) of unspent notes this device has shown in a depth proof. Whoever was
   * given the proof can see when they are spent. Saved with the state; a note leaves the list
   * once it is spent.
   */
  shown: string[];
}

/** How many of its own output commitments a wallet remembers. */
const MAX_OWN_OUTPUTS = 400;

export type StoredScan = Required<Pick<ScanView, "report" | "flows" | "skipped" | "scannedAt">>;

interface StoredState {
  state: unknown;
  neverSynced: boolean;
  pending?: unknown;
  ownOutputs?: unknown;
  shown?: unknown;
}

const CHECK_VALUE = "loch";

function parseWalletRecord(value: unknown): WalletRecord | null {
  if (!isRecord(value)) return null;
  if (!isBase58Address(value.address) || !isNonEmptyString(value.walletName, 64) || !isSafeInteger(value.addedAt)) return null;
  if (!isBase64(value.salt, 64) || !isSealedRecord(value.check)) return null;
  return { address: value.address, walletName: value.walletName, addedAt: value.addedAt, salt: value.salt, check: value.check };
}

export class Store {
  private readonly runtimes = new Map<string, WalletRuntime>();
  /** Addresses being forgotten right now. Checked, without waiting, right before every write. */
  private readonly forgotten = new Set<string>();

  constructor(
    readonly local: KV,
    readonly session: KV,
  ) {}

  // ------------------------------------------------------------- wallets index

  async wallets(): Promise<WalletRecord[]> {
    const stored = await this.local.get<unknown>("wallets");
    if (!Array.isArray(stored)) return [];
    return stored.map(parseWalletRecord).filter((record): record is WalletRecord => record !== null);
  }

  async wallet(address: string): Promise<WalletRecord | null> {
    return (await this.wallets()).find((record) => record.address === address) ?? null;
  }

  async active(): Promise<string | null> {
    const wallets = await this.wallets();
    const stored = await this.local.get<unknown>("active");
    if (typeof stored === "string" && wallets.some((record) => record.address === stored)) return stored;
    return wallets[0]?.address ?? null;
  }

  async setActive(address: string): Promise<void> {
    await this.local.set("active", address);
  }

  /** Whether this device holds a wallet record for `address` and has not begun to forget it. */
  async holds(address: string): Promise<boolean> {
    const record = await this.wallet(address);
    // Looked at after the read: a forget that began while it was under way must win.
    return record !== null && !this.forgotten.has(address);
  }

  /**
   * Whether `runtime` is still the unlocked wallet of its address. A sync or a scan that was
   * under way when the wallet was locked or forgotten holds a runtime that no longer is, and
   * what it would write is dropped.
   */
  private live(runtime: WalletRuntime): boolean {
    return this.runtimes.get(runtime.address) === runtime && !this.forgotten.has(runtime.address);
  }

  // ------------------------------------------------------------ lock and unlock

  async isUnlocked(address: string): Promise<boolean> {
    return this.runtimes.has(address) || (await this.session.get<string>(`secret:${address}`)) !== undefined;
  }

  /**
   * Makes the vault of a wallet that is new to this device and unlocks it. `signature` is the
   * wallet's signature of the key-derivation message; it is verified against the address.
   */
  async create(address: string, walletName: string, signature: Uint8Array, now: number): Promise<WalletRuntime> {
    const keys = deriveKeys(signature, new PublicKey(address).toBytes());
    const salt = newVaultSalt();
    const vaultKey = await deriveVaultKey(signature, salt, address);
    const record: WalletRecord = { address, walletName, addedAt: now, salt, check: await seal(vaultKey, address, "check", CHECK_VALUE) };
    this.forgotten.delete(address);
    const wallets = (await this.wallets()).filter((item) => item.address !== address);
    await this.local.set("wallets", [...wallets, record]);
    await this.session.set(`secret:${address}`, toBase64(signature));
    const runtime: WalletRuntime = {
      address,
      walletName,
      keys,
      shieldedAddress: encodeShieldedAddress(keys),
      vaultKey,
      state: createWalletState(keys),
      tree: null,
      activity: [],
      scan: null,
      neverSynced: true,
      pending: [],
      ownOutputs: [],
      records: [],
      shown: [],
    };
    this.runtimes.set(address, runtime);
    await this.saveState(runtime);
    return runtime;
  }

  /**
   * Unlocks a wallet this device already knows. Throws VaultError "wrong-key" when the
   * signature is not the one the vault was made with (the wallet signs differently now, or it
   * is another wallet); nothing is changed in that case.
   */
  async unlock(address: string, signature: Uint8Array, walletName?: string): Promise<WalletRuntime> {
    const record = await this.wallet(address);
    if (!record) throw new VaultError("malformed", "this device has no vault for that address");
    const vaultKey = await deriveVaultKey(signature, record.salt, address);
    const check = await open<string>(vaultKey, address, "check", record.check);
    if (check !== CHECK_VALUE) throw new VaultError("wrong-key", "the key does not open this vault");
    await this.session.set(`secret:${address}`, toBase64(signature));
    if (walletName && walletName !== record.walletName) {
      const wallets = await this.wallets();
      await this.local.set(
        "wallets",
        wallets.map((item) => (item.address === address ? { ...item, walletName } : item)),
      );
    }
    this.runtimes.delete(address);
    const runtime = await this.runtime(address);
    if (!runtime) throw new VaultError("malformed", "the vault could not be read after unlocking");
    return runtime;
  }

  /** The unlocked wallet, from memory or rebuilt from the session secret. Null when locked. */
  async runtime(address: string): Promise<WalletRuntime | null> {
    const cached = this.runtimes.get(address);
    if (cached) return cached;
    const secret = await this.session.get<string>(`secret:${address}`);
    const record = await this.wallet(address);
    if (secret === undefined || !record) return null;
    const signature = fromBase64(secret);
    const keys = deriveKeys(signature, new PublicKey(address).toBytes());
    const vaultKey = await deriveVaultKey(signature, record.salt, address);

    let state = createWalletState(keys);
    let neverSynced = true;
    let pending: PendingSpend[] = [];
    let ownOutputs: string[] = [];
    let shown: string[] = [];
    const storedState = await this.local.get<unknown>(`vault:${address}:state`);
    if (storedState !== undefined) {
      // A state that does not open or does not parse is not kept: a full sync restores it.
      try {
        const opened = await open<StoredState>(vaultKey, address, "state", storedState);
        state = parseWalletState(opened.state);
        if (state.publicKey !== keys.publicKey.toString()) throw new Error("state of another key");
        neverSynced = opened.neverSynced === true;
        if (Array.isArray(opened.pending)) {
          pending = (opened.pending as PendingSpend[]).map((entry) =>
            // A spend stored before roots were kept: hold it until the root history cannot contain
            // anything made before now (pending.ts, proofExpired).
            entry.kind !== "dive" && !Array.isArray(entry.proofs) ? { ...entry, proofs: [{ root: null, leaves: state.leaves.length }] } : entry,
          );
        }
        if (Array.isArray(opened.ownOutputs)) ownOutputs = opened.ownOutputs.filter((item): item is string => typeof item === "string");
        if (Array.isArray(opened.shown)) shown = opened.shown.filter((item): item is string => typeof item === "string");
      } catch (error) {
        if (error instanceof VaultError && error.reason === "wrong-key") throw error;
        state = createWalletState(keys);
      }
    }
    const activity = await this.openOr<ActivityEntry[]>(vaultKey, address, "activity", []);
    const scan = await this.openOr<StoredScan | null>(vaultKey, address, "scan", null);
    const records = parseRecords(await this.openOr<unknown>(vaultKey, address, "records", []));
    const runtime: WalletRuntime = {
      address,
      walletName: record.walletName,
      keys,
      shieldedAddress: encodeShieldedAddress(keys),
      vaultKey,
      state,
      tree: null,
      activity: Array.isArray(activity) ? activity : [],
      scan,
      neverSynced,
      pending,
      ownOutputs,
      records,
      shown,
    };
    // Forgotten while this was being read: there is no such wallet any more.
    if (this.forgotten.has(address)) return null;
    this.runtimes.set(address, runtime);
    return runtime;
  }

  private async openOr<T>(key: CryptoKey, address: string, record: string, fallback: T): Promise<T> {
    const stored = await this.local.get<unknown>(`vault:${address}:${record}`);
    if (stored === undefined) return fallback;
    try {
      return await open<T>(key, address, record, stored);
    } catch {
      return fallback;
    }
  }

  /** The tree of a wallet's state, built once and then kept. */
  tree(runtime: WalletRuntime): MerkleTree {
    runtime.tree ??= treeFromState(runtime.state);
    return runtime.tree;
  }

  /**
   * Writes one sealed record of an unlocked wallet. Returns false, and writes nothing, when the
   * wallet was locked or forgotten in the meantime. The check comes after the sealing and right
   * before the write, with nothing awaited in between.
   */
  private async write(runtime: WalletRuntime, record: string, value: unknown): Promise<boolean> {
    if (!this.live(runtime)) return false;
    const sealed = await seal(runtime.vaultKey, runtime.address, record, value);
    if (!this.live(runtime)) return false;
    await this.local.set(`vault:${runtime.address}:${record}`, sealed);
    return true;
  }

  async saveState(runtime: WalletRuntime): Promise<boolean> {
    if (runtime.ownOutputs.length > MAX_OWN_OUTPUTS) runtime.ownOutputs = runtime.ownOutputs.slice(-MAX_OWN_OUTPUTS);
    // A shown note that has been spent has nothing left to give away.
    const unspent = new Set(runtime.state.notes.filter((note) => !note.spent).map((note) => note.commitment));
    runtime.shown = runtime.shown.filter((commitment) => unspent.has(commitment));
    const stored: StoredState = { state: runtime.state, neverSynced: runtime.neverSynced, pending: runtime.pending, ownOutputs: runtime.ownOutputs, shown: runtime.shown };
    return this.write(runtime, "state", stored);
  }

  async saveActivity(runtime: WalletRuntime): Promise<boolean> {
    return this.write(runtime, "activity", runtime.activity);
  }

  async saveRecords(runtime: WalletRuntime): Promise<boolean> {
    return this.write(runtime, "records", runtime.records);
  }

  async saveScan(runtime: WalletRuntime): Promise<boolean> {
    return this.write(runtime, "scan", runtime.scan);
  }

  /** Drops the secrets of one wallet, or of all of them. What is on disk stays, encrypted. */
  async lock(address?: string): Promise<void> {
    const addresses = address ? [address] : (await this.wallets()).map((record) => record.address);
    for (const item of addresses) {
      this.runtimes.delete(item);
      await this.session.remove([`secret:${item}`, `flow:${item}`]);
    }
  }

  /**
   * Removes everything this device holds about `address`. Nothing on chain changes.
   *
   * The address is marked first, before anything is awaited: from then on `live` and `holds`
   * refuse every write for it, whoever is still running. The caller stops what it can (the
   * router aborts the sync and the scan); this does not depend on that having worked.
   */
  async forget(address: string): Promise<void> {
    this.forgotten.add(address);
    this.runtimes.delete(address);
    const wallets = (await this.wallets()).filter((record) => record.address !== address);
    await this.local.set("wallets", wallets);
    const active = await this.local.get<string>("active");
    if (active === address) {
      if (wallets[0]) await this.local.set("active", wallets[0].address);
      else await this.local.remove("active");
    }
    await this.sweep(address);
    // Once more, after everything queued before the mark has had its turn.
    await this.sweep(address);
    // The wallet record is gone, which is what `holds` and `live` go by from here on. The mark
    // is lifted so that the same wallet can be connected again.
    this.forgotten.delete(address);
  }

  private async sweep(address: string): Promise<void> {
    const session = (await this.session.keys("")).filter((key) => key.includes(address));
    if (session.length > 0) await this.session.remove(session);
    const local = (await this.local.keys("")).filter((key) => key.includes(address));
    if (local.length > 0) await this.local.remove(local);
  }

  /** Forgets what is in memory, as a service worker restart does. For tests. */
  dropMemory(): void {
    this.runtimes.clear();
  }
}
