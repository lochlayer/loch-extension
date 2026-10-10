// Sync against an in-memory pool and RPC. Proofs are not checked here (see
// e2e.test.ts); this is about events, ordering, completeness and the root check.

import { base58 } from "@scure/base";
import { type MessageV0, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { bigIntToBytesLE, bytesToBase64, concatBytes, randomBytes } from "../src/bytes.js";
import { NEW_NULLIFIERS_DISCRIMINATOR } from "../src/constants.js";
import {
  DEFAULT_COMMITMENT,
  FIELD_MODULUS,
  type LochKeys,
  MerkleTree,
  NEW_COMMITMENT_DISCRIMINATOR,
  PROGRAM_ID,
  SyncError,
  type TransactArgs,
  areNullifiersSpent,
  balance,
  buildTransactInstruction,
  buildTransactTransaction,
  createNote,
  createWalletState,
  decodePoolConfig,
  decodeTreeAccount,
  encodeTransactArgs,
  encryptNote,
  fetchEvents,
  fetchPoolConfig,
  fetchRecipientRent,
  fetchTreeAccount,
  fieldToBytes,
  isKnownRoot,
  isNullifierSpent,
  noteCommitment,
  nullifierPda,
  ownedNotes,
  parseEventLogs,
  parseWalletState,
  syncWallet,
  unspentNotes,
} from "../src/index.js";
import { commitmentsOf, effectsOf, transactCallsOf } from "../src/events.js";
import { zeroValues } from "../src/merkle.js";
import { randomBlinding } from "../src/note.js";
import { FakePool } from "./helpers/fakePool.js";
import { address, lochKeys } from "./helpers/fixtures.js";

const alice = lochKeys("alice");
const bob = lochKeys("bob");
const relayer = address("relayer");
const BLOCKHASH = "11111111111111111111111111111111";
const EMPTY_ROOT = zeroValues()[20]!;

/**
 * Arguments with real commitments and encrypted notes; the proof is not looked at in this file.
 * `spends` are the nullifiers of the notes the transaction spends; missing ones are random, as a dummy's is.
 */
function transactArgs(outputs: [{ amount: bigint; to: LochKeys }, { amount: bigint; to: LochKeys }], root: bigint, spends: bigint[] = []): TransactArgs {
  const notes = outputs.map(({ amount, to }) => ({ note: createNote(amount, to.publicKey), to }));
  return {
    proof: { a: randomBytes(64), b: randomBytes(128), c: randomBytes(64) },
    root: fieldToBytes(root),
    inputNullifiers: [fieldToBytes(spends[0] ?? randomBlinding()), fieldToBytes(spends[1] ?? randomBlinding())],
    outputCommitments: [fieldToBytes(noteCommitment(notes[0]!.note)), fieldToBytes(noteCommitment(notes[1]!.note))],
    extData: {
      recipient: relayer,
      relayer,
      extAmount: 0n,
      fee: 0n,
      encryptedOutput0: encryptNote(notes[0]!.note, notes[0]!.to.encryptionPublic),
      encryptedOutput1: encryptNote(notes[1]!.note, notes[1]!.to.encryptionPublic),
    },
  };
}

function transaction(args: TransactArgs) {
  return buildTransactTransaction({ instruction: buildTransactInstruction(args, { signer: relayer }), payer: relayer, recentBlockhash: BLOCKHASH });
}

/** Sends `amount` to `to` (plus a zero note to Bob) through the fake pool, spending the notes with the nullifiers `spends`. */
async function pay(pool: FakePool, to: LochKeys, amount: bigint, spends: bigint[] = []): Promise<{ signature: string; args: TransactArgs }> {
  const args = transactArgs([{ amount, to }, { amount: 0n, to: bob }], pool.tree.root, spends);
  return { signature: await pool.process(transaction(args)), args };
}

/** A connection that fails the test if sync asks about any account other than the pool's tree. */
function watched(pool: FakePool) {
  const asked: string[] = [];
  const connection = pool.connection;
  return {
    asked,
    connection: {
      ...connection,
      getAccountInfo: async (key: PublicKey, ...rest: unknown[]) => {
        asked.push(key.toBase58());
        return connection.getAccountInfo(key, ...rest);
      },
      getMultipleAccountsInfo: async () => {
        throw new Error("sync must not ask the RPC about accounts chosen by the wallet");
      },
    },
  };
}

const newPool = () => new FakePool({ screener: address("screener") });

describe("account decoding", () => {
  it("reads the tree account as the program lays it out", async () => {
    const pool = newPool();
    const empty = await fetchTreeAccount(pool.connection);
    expect(empty).toMatchObject({ nextIndex: 0, currentRootIndex: 0, root: EMPTY_ROOT });
    expect(empty.zeros).toEqual(zeroValues().slice(0, 20));
    expect(empty.roots).toHaveLength(64);
    expect(isKnownRoot(empty, EMPTY_ROOT)).toBe(true);
    expect(isKnownRoot(empty, 0n)).toBe(false);

    const { args } = await pay(pool, alice, 5n);
    const after = await fetchTreeAccount(pool.connection);
    expect(after.nextIndex).toBe(2);
    expect(after.currentRootIndex).toBe(1); // one root per transaction
    const local = MerkleTree.fromLeaves(args.outputCommitments.map((c) => BigInt(`0x${Buffer.from(c).toString("hex")}`)));
    expect(after.root).toBe(local.root);
    expect(isKnownRoot(after, EMPTY_ROOT)).toBe(true);
    expect(isKnownRoot(after, 12345n)).toBe(false);
    expect(decodeTreeAccount(pool.tree.accountData()).root).toBe(local.root);
  });

  it("forgets a root once 64 later transactions have landed", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    const early = pool.tree.root;
    for (let i = 0; i < 63; i++) await pay(pool, bob, 1n);
    expect(isKnownRoot(await fetchTreeAccount(pool.connection), early)).toBe(true);
    await pay(pool, bob, 1n);
    expect(isKnownRoot(await fetchTreeAccount(pool.connection), early)).toBe(false);
  });

  it("reads the pool configuration", async () => {
    const pool = newPool();
    pool.maxDeposit = 2_500_000_000n;
    pool.paused = true;
    const config = await fetchPoolConfig(pool.connection);
    expect(config.screener.equals(address("screener"))).toBe(true);
    expect(config).toMatchObject({ maxDeposit: 2_500_000_000n, paused: true, bump: 254, vaultBump: 255 });
    expect(decodePoolConfig(pool.configAccountData()).paused).toBe(true);
  });

  it("rejects accounts of the wrong type, size or owner", async () => {
    const pool = newPool();
    expect(() => decodePoolConfig(pool.tree.accountData())).toThrow(expect.objectContaining({ code: "DECODE_FAILED" }));
    expect(() => decodeTreeAccount(pool.configAccountData())).toThrow(/not a MerkleTree/);
    expect(() => decodeTreeAccount(pool.tree.accountData().subarray(0, 600))).toThrow(/layout/);
    expect(() => decodePoolConfig(pool.configAccountData().subarray(0, 40))).toThrow(/too short/);
    const missing = { getAccountInfo: async () => null };
    await expect(fetchPoolConfig(missing as never)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    const foreign = { getAccountInfo: async () => ({ owner: SystemProgram.programId, data: pool.tree.accountData() }) };
    await expect(fetchTreeAccount(foreign as never)).rejects.toThrow(/not owned by the program/);
  });

  it("reads what a withdrawal's rent check needs", async () => {
    const pool = newPool();
    expect(await fetchRecipientRent(pool.connection, address("nobody"))).toEqual({ lamports: 0n, rentExemptMinimum: 890_880n });
    pool.lamports.set(address("somebody").toBase58(), 5_000_000n);
    expect(await fetchRecipientRent(pool.connection, address("somebody"))).toEqual({ lamports: 5_000_000n, rentExemptMinimum: 890_880n });
  });
});

describe("commitment level of RPC reads", () => {
  /** The fake pool's RPC, recording the commitment every call was made with. */
  function recording(pool: FakePool) {
    const seen: Record<string, unknown[]> = {};
    const note = (method: string, commitment: unknown) => {
      (seen[method] ??= []).push(commitment);
    };
    const inner = pool.connection;
    return {
      seen,
      connection: {
        getAccountInfo: (key: PublicKey, commitment?: unknown) => {
          note("getAccountInfo", commitment);
          return inner.getAccountInfo(key);
        },
        getMultipleAccountsInfo: (keys: PublicKey[], commitment?: unknown) => {
          note("getMultipleAccountsInfo", commitment);
          return inner.getMultipleAccountsInfo(keys);
        },
        getMinimumBalanceForRentExemption: (size: number, commitment?: unknown) => {
          note("getMinimumBalanceForRentExemption", commitment);
          return inner.getMinimumBalanceForRentExemption(size);
        },
        getSignaturesForAddress: (key: PublicKey, options: unknown, commitment?: unknown) => {
          note("getSignaturesForAddress", commitment);
          return inner.getSignaturesForAddress(key, options);
        },
        getTransaction: (signature: string, config?: { commitment?: unknown }) => {
          note("getTransaction", config?.commitment);
          return inner.getTransaction(signature, config);
        },
      },
    };
  }

  async function everyRead(connection: ReturnType<typeof recording>["connection"], commitment?: "finalized") {
    await fetchTreeAccount(connection, undefined, commitment);
    await fetchPoolConfig(connection, undefined, commitment);
    await areNullifiersSpent(connection, [1n, 2n], undefined, commitment);
    await isNullifierSpent(connection, 3n, undefined, commitment);
    await fetchRecipientRent(connection, address("nobody"), commitment);
    await fetchEvents(connection, commitment ? { commitment } : {});
    await syncWallet(connection, createWalletState(alice), alice, commitment ? { commitment } : {});
  }

  const METHODS = ["getAccountInfo", "getMinimumBalanceForRentExemption", "getMultipleAccountsInfo", "getSignaturesForAddress", "getTransaction"];

  it("is `confirmed` for every helper and for sync when the caller says nothing: the connection's own default is never used", async () => {
    // A `Connection` created without a commitment reads at `finalized` (a transaction that just
    // confirmed looks as if it never landed), one created with `processed` reads state that can
    // still be dropped. A helper that passed `undefined` through would inherit either.
    const pool = newPool();
    await pay(pool, alice, 3n);
    const { connection, seen } = recording(pool);
    await everyRead(connection);
    expect(DEFAULT_COMMITMENT).toBe("confirmed");
    expect(Object.keys(seen).sort()).toEqual(METHODS);
    for (const method of METHODS) expect(seen[method], method).toEqual(seen[method]!.map(() => "confirmed"));
  });

  it("is the caller's choice when one is given", async () => {
    const pool = newPool();
    await pay(pool, alice, 3n);
    const { connection, seen } = recording(pool);
    await everyRead(connection, "finalized");
    expect(Object.keys(seen).sort()).toEqual(METHODS);
    for (const method of METHODS) expect(seen[method], method).toEqual(seen[method]!.map(() => "finalized"));
  });
});

describe("event parsing", () => {
  const program = PROGRAM_ID.toBase58();
  const eventLine = (index: number, commitment: bigint, output = new Uint8Array(87)) =>
    `Program data: ${bytesToBase64(
      concatBytes(NEW_COMMITMENT_DISCRIMINATOR, bigIntToBytesLE(BigInt(index), 8), fieldToBytes(commitment), bigIntToBytesLE(BigInt(output.length), 4), output),
    )}`;

  it("reads NewCommitment and NewNullifiers events from the program's logs", async () => {
    const pool = newPool();
    const { args } = await pay(pool, alice, 5n);
    const parsed = parseEventLogs(pool.transactions[0]!.logs);
    expect(parsed.truncated).toBe(false);
    expect(parsed.commitments.map((event) => event.index)).toEqual([0, 1]);
    expect(parsed.commitments[0]!.encryptedOutput).toEqual(args.extData.encryptedOutput0);
    expect(fieldToBytes(parsed.commitments[1]!.commitment)).toEqual(args.outputCommitments[1]);
    expect(parsed.nullifiers).toHaveLength(1);
    expect(fieldToBytes(parsed.nullifiers[0]!.nullifiers[0])).toEqual(args.inputNullifiers[0]);
  });

  it("ignores look-alike data logged by any other program", () => {
    const evil = address("evil program").toBase58();
    const logs = [
      `Program ${evil} invoke [1]`,
      eventLine(0, 111n),
      `Program log: Program ${program} invoke [1]`, // a msg! cannot open a frame
      eventLine(1, 222n),
      `Program ${evil} success`,
      eventLine(2, 333n), // outside any frame
      `Program ${program} invoke [1]`,
      `Program ${evil} invoke [2]`,
      eventLine(3, 444n), // a program we called is logging
      `Program ${evil} success`,
      eventLine(7, 555n),
      `Program ${program} success`,
    ];
    expect(parseEventLogs(logs).commitments.map((event) => [event.index, event.commitment])).toEqual([[7, 555n]]);
  });

  it("reads events when the program is called through CPI", () => {
    const wrapper = address("wrapper program").toBase58();
    const logs = [`Program ${wrapper} invoke [1]`, `Program ${program} invoke [2]`, eventLine(4, 9n), `Program ${program} success`, `Program ${wrapper} success`];
    expect(parseEventLogs(logs).commitments.map((event) => event.index)).toEqual([4]);
  });

  it("flags truncated logs and tolerates garbage", () => {
    const logs = [`Program ${program} invoke [1]`, "Program data: !!!not base64!!!", "Program data: AAAA", eventLine(0, 1n), "Log truncated"];
    const parsed = parseEventLogs(logs);
    expect(parsed.truncated).toBe(true);
    expect(parsed.commitments).toHaveLength(1);
    expect(parseEventLogs(null)).toEqual({ commitments: [], nullifiers: [], truncated: false });
    // An index beyond the tree, or trailing bytes, is not one of our events.
    expect(parseEventLogs([`Program ${program} invoke [1]`, eventLine(2 ** 20, 1n)]).commitments).toEqual([]);
  });

  it("uses another program id when given one", () => {
    const other = address("another deployment");
    const logs = [`Program ${other.toBase58()} invoke [1]`, eventLine(0, 1n), `Program ${other.toBase58()} success`];
    expect(parseEventLogs(logs).commitments).toHaveLength(0);
    expect(parseEventLogs(logs, other).commitments).toHaveLength(1);
  });
});

describe("fetchEvents", () => {
  it("returns nothing for a pool without transactions", async () => {
    const pool = newPool();
    expect(await fetchEvents(pool.connection)).toEqual({ events: [], nullifiers: [], lastSignature: null, transactions: 0 });
    expect(await fetchEvents(pool.connection, { until: "abc" })).toMatchObject({ lastSignature: "abc" });
  });

  it("returns every commitment in leaf order and the newest signature", async () => {
    const pool = newPool();
    const signatures: string[] = [];
    for (let i = 0; i < 5; i++) signatures.push((await pay(pool, alice, BigInt(i + 1))).signature);
    const { events, nullifiers, lastSignature, transactions } = await fetchEvents(pool.connection);
    expect(events.map((event) => event.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(lastSignature).toBe(signatures[4]);
    expect(transactions).toBe(5);
    expect(MerkleTree.fromLeaves(events.map((event) => event.commitment)).root).toBe(pool.tree.root);
    // Two nullifiers per transaction, and every one of them has a record on chain.
    expect(nullifiers).toHaveLength(10);
    expect(await areNullifiersSpent(pool.connection, nullifiers)).toEqual(new Array(10).fill(true));
  });

  it("gives every event the slot and the block time of its transaction, without a request of its own", async () => {
    const pool = newPool();
    pool.blockTimeOf = (slot) => 1_750_000_000 + 2 * slot;
    for (let i = 0; i < 3; i++) await pay(pool, alice, BigInt(i + 1));
    const slots = pool.transactions.map((tx) => tx.slot);
    expect(new Set(slots).size).toBe(3);
    pool.calls.getTransaction = 0;
    pool.calls.getSignaturesForAddress = 0;
    const { events } = await fetchEvents(pool.connection);
    // Two leaves per transaction, both with that transaction's slot and time.
    expect(events.map((event) => [event.index, event.slot, event.blockTime])).toEqual(
      slots.flatMap((slot, i) => [[2 * i, slot, 1_750_000_000 + 2 * slot], [2 * i + 1, slot, 1_750_000_000 + 2 * slot]]),
    );
    // Nothing was asked for that was not asked for before: one listing, one request per transaction.
    expect(pool.calls).toEqual({ getSignaturesForAddress: 1, getTransaction: 3 });

    // A node that returns the transaction without a block time: the listing's is used.
    pool.blockTimeIn = { listing: true, transaction: false };
    expect((await fetchEvents(pool.connection)).events.map((event) => event.blockTime)).toEqual(slots.flatMap((slot) => [1_750_000_000 + 2 * slot, 1_750_000_000 + 2 * slot]));
    // A node that does not know block times at all: the property is absent, the slot still there.
    pool.blockTimeIn = { listing: false, transaction: false };
    const untimed = (await fetchEvents(pool.connection)).events;
    expect(untimed.map((event) => event.slot)).toEqual(slots.flatMap((slot) => [slot, slot]));
    expect(untimed.every((event) => !("blockTime" in event))).toBe(true);

    // A connection that reports neither (or nonsense): the events are what they were before these fields existed.
    const connection = pool.connection;
    for (const junk of [undefined, null, "1750000000", -5, 1.5, Number.NaN, 2 ** 60]) {
      const bare = {
        getSignaturesForAddress: async (...args: unknown[]) => (await connection.getSignaturesForAddress(...args)).map((entry: object) => ({ ...entry, slot: junk, blockTime: junk })),
        getTransaction: async (...args: unknown[]) => ({ ...(await connection.getTransaction(...args)), slot: junk, blockTime: junk }),
      };
      const plain = (await fetchEvents(bare as never)).events;
      expect(plain.map((event) => Object.keys(event).sort())).toEqual(new Array(6).fill(["commitment", "encryptedOutput", "index"]));
    }
    // Events read from logs alone never have them.
    expect(parseEventLogs(pool.transactions[0]!.logs).commitments.map((event) => Object.keys(event).sort())).toEqual([
      ["commitment", "encryptedOutput", "index"],
      ["commitment", "encryptedOutput", "index"],
    ]);
  });

  it("takes the time from the instruction data's transaction too, when the logs are of no use", async () => {
    const pool = newPool();
    pool.blockTimeOf = (slot) => 1_750_000_000 + slot;
    await pay(pool, alice, 1n);
    // A transaction whose logs were cut off: its leaves come from the instruction data, its time from the transaction all the same.
    const args = transactArgs([{ amount: 9n, to: alice }, { amount: 0n, to: bob }], pool.tree.root);
    pool.insertLeaves(args);
    pool.push({ err: null, logs: ["Log truncated"], message: transaction(args).message as MessageV0 });
    const { events } = await fetchEvents(pool.connection);
    const cut = pool.transactions[1]!.slot;
    expect(events.slice(2).map((event) => [event.index, event.slot, event.blockTime])).toEqual([[2, cut, 1_750_000_000 + cut], [3, cut, 1_750_000_000 + cut]]);
  });

  it("fetches a signature once when the RPC lists it twice", async () => {
    const pool = newPool();
    for (let i = 0; i < 3; i++) await pay(pool, alice, 1n);
    const connection = pool.connection;
    // A page boundary on load-balanced nodes: the newest entry comes back a second time.
    const duplicating = {
      ...connection,
      getSignaturesForAddress: async (...args: unknown[]) => {
        const page = await connection.getSignaturesForAddress(...args);
        return page.length > 0 ? [page[0], ...page] : page;
      },
    };
    pool.calls.getTransaction = 0;
    const { events, nullifiers, transactions } = await fetchEvents(duplicating);
    expect(events.map((event) => event.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(nullifiers).toHaveLength(6);
    expect(transactions).toBe(3);
    expect(pool.calls.getTransaction).toBe(3);
    // The same through pages that overlap by one entry.
    const overlapping = {
      ...connection,
      getSignaturesForAddress: async (address: PublicKey, options: { before?: string; until?: string; limit?: number }) => {
        const all = await connection.getSignaturesForAddress(address, { until: options.until });
        const from = options.before ? all.findIndex((entry: { signature: string }) => entry.signature === options.before) : 0;
        return all.slice(from, from + (options.limit ?? 1000));
      },
    };
    expect((await fetchEvents(overlapping, { pageSize: 2 })).events.map((event) => event.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("stops with an error when the listing does not advance, instead of paging forever", async () => {
    const pool = newPool();
    for (let i = 0; i < 4; i++) await pay(pool, alice, 1n);
    const connection = pool.connection;
    let calls = 0;
    // An RPC that ignores `before` and returns the newest full page every time.
    const stuck = {
      ...connection,
      getSignaturesForAddress: async (address: PublicKey, options: { limit?: number }) => {
        calls++;
        if (calls > 50) throw new Error("fetchEvents is still paging");
        return connection.getSignaturesForAddress(address, { limit: options.limit });
      },
    };
    await expect(fetchEvents(stuck, { pageSize: 2 })).rejects.toMatchObject({ code: "SYNC_FAILED", reason: "unavailable" });
    expect(calls).toBe(2);
  });

  it("pages through the signature list and stops at the last-seen signature", async () => {
    const pool = newPool();
    const signatures: string[] = [];
    for (let i = 0; i < 7; i++) signatures.push((await pay(pool, alice, 1n)).signature);
    const progress: number[] = [];
    const all = await fetchEvents(pool.connection, { pageSize: 3, onProgress: (p) => progress.push(p.fetched) });
    expect(all.events).toHaveLength(14);
    expect(pool.calls.getSignaturesForAddress).toBe(3); // 3 + 3 + 1
    expect(progress.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    pool.calls.getTransaction = 0;
    const tail = await fetchEvents(pool.connection, { until: signatures[4], pageSize: 3 });
    expect(tail.events.map((event) => event.index)).toEqual([10, 11, 12, 13]);
    expect(tail.lastSignature).toBe(signatures[6]);
    expect(pool.calls.getTransaction).toBe(2);
  });

  it("skips failed transactions but moves past them", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    const stale = transactArgs([{ amount: 1n, to: alice }, { amount: 0n, to: bob }], 999n);
    await expect(pool.process(transaction(stale))).rejects.toThrow("UnknownRoot");
    const failedSignature = pool.transactions[1]!.signature;
    pool.calls.getTransaction = 0;
    const { events, lastSignature } = await fetchEvents(pool.connection);
    expect(events).toHaveLength(2);
    expect(lastSignature).toBe(failedSignature);
    expect(pool.calls.getTransaction).toBe(1); // the failed one is never downloaded
  });

  it("always asks for maxSupportedTransactionVersion: 1", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    const seen: unknown[] = [];
    const connection = {
      ...pool.connection,
      getTransaction: (signature: string, config: unknown) => {
        seen.push(config);
        return pool.connection.getTransaction(signature, config);
      },
    };
    await fetchEvents(connection, { commitment: "finalized" });
    expect(seen).toEqual([{ commitment: "finalized", maxSupportedTransactionVersion: 1 }]);
  });

  it("retries a transaction the node lists but does not serve yet", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    pool.missingTransactionReads = 1;
    expect((await fetchEvents(pool.connection)).events).toHaveLength(2);
  });

  it("fails, and skips nothing, when a listed transaction never arrives", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    pool.missingTransactionReads = 100;
    await expect(fetchEvents(pool.connection)).rejects.toMatchObject({ code: "SYNC_FAILED", reason: "unavailable" });
  });

  it("fails on a gap in the leaf indices", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    await pay(pool, alice, 1n);
    await pay(pool, alice, 1n);
    pool.transactions.splice(1, 1); // the RPC lost a transaction
    await expect(fetchEvents(pool.connection)).rejects.toMatchObject({ reason: "gap" });
  });

  it("orders by leaf index even if the RPC returns same-slot transactions out of order", async () => {
    const pool = newPool();
    for (let i = 0; i < 4; i++) await pay(pool, alice, 1n);
    [pool.transactions[1], pool.transactions[2]] = [pool.transactions[2]!, pool.transactions[1]!];
    const { events } = await fetchEvents(pool.connection);
    expect(events.map((event) => event.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("stops when aborted", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    const controller = new AbortController();
    controller.abort(new Error("stopped by the user"));
    await expect(fetchEvents(pool.connection, { signal: controller.signal })).rejects.toThrow("stopped by the user");
  });

  it("ignores transactions that only mention the tree account", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    const evil = address("evil program");
    const fake = concatBytes(NEW_COMMITMENT_DISCRIMINATOR, bigIntToBytesLE(2n, 8), fieldToBytes(777n), bigIntToBytesLE(0n, 4));
    const message = new TransactionMessage({
      payerKey: relayer,
      recentBlockhash: BLOCKHASH,
      instructions: [new TransactionInstruction({ programId: evil, keys: [{ pubkey: PublicKey.findProgramAddressSync([Buffer.from("tree")], PROGRAM_ID)[0], isSigner: false, isWritable: false }], data: Buffer.from("hi") })],
    }).compileToV0Message();
    pool.push({
      err: null,
      message,
      logs: [`Program ${evil.toBase58()} invoke [1]`, `Program data: ${bytesToBase64(fake)}`, `Program ${evil.toBase58()} success`],
    });
    const { events } = await fetchEvents(pool.connection);
    expect(events.map((event) => event.index)).toEqual([0, 1]);
  });
});

/** A transaction in which a wrapper program calls transact through CPI, with unusable logs. */
function cpiTransaction(pool: FakePool, args: TransactArgs, logs: string[] | null) {
  const wrapper = address("wrapper program");
  const inner = buildTransactInstruction(args, { signer: relayer });
  const message: MessageV0 = new TransactionMessage({
    payerKey: relayer,
    recentBlockhash: BLOCKHASH,
    instructions: [
      new TransactionInstruction({
        programId: wrapper,
        keys: [...inner.keys, { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }],
        data: Buffer.from("spam the log, then call transact"),
      }),
    ],
  }).compileToV0Message();
  const keys = message.staticAccountKeys;
  const indexOf = (key: PublicKey) => keys.findIndex((candidate) => candidate.equals(key));
  pool.insertLeaves(args);
  return pool.push({
    err: null,
    logs,
    message,
    innerInstructions: [
      {
        index: 0,
        instructions: [
          { programIdIndex: indexOf(SystemProgram.programId), accounts: [], data: base58.encode(randomBytes(12)) },
          { programIdIndex: indexOf(PROGRAM_ID), accounts: inner.keys.map((key) => indexOf(key.pubkey)), data: base58.encode(concatBytes(encodeTransactArgs(args), Uint8Array.of(1, 2, 3))) },
        ],
      },
    ],
  });
}

describe("logs that cannot be trusted to be complete", () => {
  it("falls back to the instruction data when the logs are truncated", async () => {
    const pool = newPool();
    await pay(pool, bob, 1n);
    const args = transactArgs([{ amount: 42n, to: alice }, { amount: 0n, to: alice }], pool.tree.root);
    // A wrapper program fills the log buffer before calling transact: the events never appear.
    cpiTransaction(pool, args, [`Program ${address("wrapper program").toBase58()} invoke [1]`, "Program log: spam", "Log truncated"]);
    await pay(pool, bob, 1n);

    const { events } = await fetchEvents(pool.connection);
    expect(events.map((event) => event.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(MerkleTree.fromLeaves(events.map((event) => event.commitment)).root).toBe(pool.tree.root);
    expect(fieldToBytes(events[2]!.commitment)).toEqual(args.outputCommitments[0]);

    const synced = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(balance(synced.state)).toBe(42n);
    expect(synced.received.map((note) => note.leafIndex)).toEqual([2]);
  });

  it("falls back when the node returns no logs at all, using the expected next index", async () => {
    const pool = newPool();
    const first = await pay(pool, bob, 1n);
    const args = transactArgs([{ amount: 9n, to: alice }, { amount: 0n, to: alice }], pool.tree.root);
    cpiTransaction(pool, args, null);
    const { events } = await fetchEvents(pool.connection, { until: first.signature, nextIndex: 2 });
    expect(events.map((event) => event.index)).toEqual([2, 3]);
  });

  it("finds transact calls at the top level and inside CPI, tolerating trailing bytes", async () => {
    const pool = newPool();
    const { args } = await pay(pool, alice, 1n);
    const top = (await pool.connection.getTransaction(pool.transactions[0]!.signature, { maxSupportedTransactionVersion: 1 }))!;
    expect(transactCallsOf(top)).toEqual([args]);
    expect(commitmentsOf(top).map((c) => c.index)).toEqual([0, 1]);

    const nested = transactArgs([{ amount: 1n, to: alice }, { amount: 1n, to: bob }], pool.tree.root);
    const signature = cpiTransaction(pool, nested, ["Log truncated"]);
    const cpi = (await pool.connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 }))!;
    expect(transactCallsOf(cpi)).toEqual([nested]);
    expect(commitmentsOf(cpi).map((c) => c.index)).toEqual([null, null]);
    expect(transactCallsOf(cpi, address("another deployment"))).toEqual([]);
    expect(commitmentsOf({ ...cpi, meta: { ...cpi.meta, err: { InstructionError: [0, "Custom"] } } })).toEqual([]);
  });
});

describe("syncWallet", () => {
  it("syncs an empty pool to the documented empty root", async () => {
    const pool = newPool();
    const result = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(result.state.leaves).toEqual([]);
    expect(result.state.lastSignature).toBeNull();
    expect(result.tree.root).toBe(EMPTY_ROOT);
    expect(result).toMatchObject({ received: [], spent: [], newLeaves: 0 });
  });

  it("is state in, state out: discovers notes, resumes from the last signature", async () => {
    const pool = newPool();
    await pay(pool, alice, 100n);
    await pay(pool, bob, 7n);
    const before = createWalletState(alice);
    const first = await syncWallet(pool.connection, before, alice);
    expect(before.leaves).toEqual([]); // the input is untouched
    expect(first.newLeaves).toBe(4);
    expect(balance(first.state)).toBe(100n);
    expect(first.tree.root).toBe(pool.tree.root);
    expect(first.state.lastSignature).toBe(pool.transactions[1]!.signature);

    await pay(pool, alice, 50n);
    pool.calls.getTransaction = 0;
    const restored = JSON.parse(JSON.stringify(first.state));
    const second = await syncWallet(pool.connection, restored, alice, { tree: first.tree });
    expect(pool.calls.getTransaction).toBe(1); // only the new transaction
    // The cached tree is not touched: the result carries a new one.
    expect(second.tree).not.toBe(first.tree);
    expect(first.tree.size).toBe(4);
    expect(first.tree.root).toBe(MerkleTree.fromLeaves(first.state.leaves.map(BigInt)).root);
    expect(second.behind).toBe(0);
    expect(second.newLeaves).toBe(2);
    expect(second.received.map((note) => note.amount)).toEqual([50n]);
    expect(balance(second.state)).toBe(150n);
    expect(second.tree.root).toBe(pool.tree.root);

    // Nothing new: one signature page, one account read, no transactions, and nothing else.
    pool.calls.getTransaction = 0;
    pool.calls.getSignaturesForAddress = 0;
    pool.calls.getAccountInfo = 0;
    const third = await syncWallet(pool.connection, second.state, alice, { tree: second.tree });
    expect(pool.calls).toMatchObject({ getTransaction: 0, getSignaturesForAddress: 1, getAccountInfo: 1 });
    expect(pool.calls.getMultipleAccountsInfo).toBeUndefined();
    expect(third.state).toEqual(second.state);
  });

  it("reports when each received note was created, and keeps the stored state as it was", async () => {
    const pool = newPool();
    pool.blockTimeOf = (slot) => 1_750_000_000 + 60 * slot;
    await pay(pool, alice, 100n);
    await pay(pool, bob, 7n);
    await pay(pool, alice, 50n);
    const [first, , third] = pool.transactions.map((tx) => tx.slot);
    const result = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(result.received.map((note) => [note.amount, note.slot, note.blockTime])).toEqual([
      [100n, first, 1_750_000_000 + 60 * first!],
      [50n, third, 1_750_000_000 + 60 * third!],
    ]);
    // Apart from when and how it arrived, a received note is the owned note of the state.
    expect(result.received.map(({ slot: _slot, blockTime: _blockTime, source: _source, ...note }) => note)).toEqual(ownedNotes(result.state));

    // The stored layout has no place for them, and did not get one.
    for (const note of result.state.notes) expect(Object.keys(note)).toEqual(["leafIndex", "amount", "blinding", "commitment", "nullifier", "spent"]);
    expect(Object.keys(result.state)).toEqual(["version", "programId", "publicKey", "leaves", "notes", "lastSignature"]);
    expect(JSON.stringify(result.state)).not.toMatch(/slot|blockTime|17500/);
    expect(parseWalletState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state);
    // So it is the same state a sync without any times reaches, and the notes read back from it carry none.
    pool.blockTimeOf = () => null;
    const untimed = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(untimed.state).toEqual(result.state);
    expect(untimed.received.map((note) => [note.slot, "blockTime" in note])).toEqual([[first, false], [third, false]]);
    expect(ownedNotes(result.state).some((note) => "slot" in note || "blockTime" in note)).toBe(false);
    // Notes found spent are reported as before: when a note was spent is not part of this.
    pool.blockTimeOf = (slot) => 1_750_000_000 + 60 * slot;
    await pay(pool, bob, 1n, [unspentNotes(result.state)[0]!.nullifier]);
    const later = await syncWallet(pool.connection, result.state, alice, { tree: result.tree });
    expect(later.received).toEqual([]);
    expect(later.spent.map((note) => [note.amount, "slot" in note, "blockTime" in note])).toEqual([[100n, false, false]]);
  });

  it("keeps the time of a note received in an earlier round of the same sync", async () => {
    const pool = newPool();
    pool.blockTimeOf = (slot) => 1_750_000_000 + slot;
    await pay(pool, alice, 5n);
    const connection = pool.connection;
    let landed = false;
    // A transaction lands between the listing and the read of the tree account: sync goes round again.
    const moving = {
      ...connection,
      getAccountInfo: async (...args: unknown[]) => {
        if (!landed) {
          landed = true;
          await pay(pool, alice, 6n);
        }
        return connection.getAccountInfo(...args);
      },
    };
    const result = await syncWallet(moving, createWalletState(alice), alice);
    const [early, late] = pool.transactions.map((tx) => tx.slot);
    expect(result.behind).toBe(0);
    expect(result.received.map((note) => [note.amount, note.slot, note.blockTime])).toEqual([
      [5n, early, 1_750_000_000 + early!],
      [6n, late, 1_750_000_000 + late!],
    ]);
  });

  it("finds spent notes in the pool's history, without asking the RPC about a single nullifier", async () => {
    const pool = newPool();
    await pay(pool, alice, 100n);
    await pay(pool, alice, 30n);
    const { connection, asked } = watched(pool);
    const first = await syncWallet(connection, createWalletState(alice), alice);
    const [big, small] = unspentNotes(first.state);
    expect(first.spent).toEqual([]);

    // Somebody spends Alice's 100 note (in reality Alice, on another device) next to a dummy.
    await pay(pool, bob, 1n, [big!.nullifier]);
    const second = await syncWallet(connection, first.state, alice, { tree: first.tree });
    expect(second.spent.map((note) => [note.amount, note.spent])).toEqual([[100n, true]]);
    expect(balance(second.state)).toBe(30n);
    expect(unspentNotes(second.state).map((note) => note.amount)).toEqual([30n]);
    // A spent note stays spent and is not reported again.
    const third = await syncWallet(connection, second.state, alice, { tree: second.tree });
    expect(third.spent).toEqual([]);
    expect(balance(third.state)).toBe(30n);
    // A sync from scratch reaches the same state.
    expect((await syncWallet(connection, createWalletState(alice), alice)).state).toEqual(third.state);

    // The only account sync ever read is the pool's tree, which every client reads.
    expect(new Set(asked)).toEqual(new Set([PublicKey.findProgramAddressSync([Buffer.from("tree")], PROGRAM_ID)[0].toBase58()]));
    // The explicit helper agrees with what sync found.
    expect(await areNullifiersSpent(pool.connection, [big!.nullifier, small!.nullifier])).toEqual([true, false]);
  });

  it("finds a note that was received and spent between two syncs, and both spends of one transaction", async () => {
    const pool = newPool();
    await pay(pool, alice, 10n);
    const { connection } = watched(pool);
    const first = await syncWallet(connection, createWalletState(alice), alice);
    const [old] = unspentNotes(first.state);

    // While the wallet is closed: a new note arrives, then one transaction spends it together with the old one.
    const arrived = await pay(pool, alice, 25n);
    const midway = await syncWallet(pool.connection, first.state, alice);
    const fresh = unspentNotes(midway.state).find((note) => note.amount === 25n)!;
    expect(fresh.commitment.toString()).toBe(BigInt(`0x${Buffer.from(arrived.args.outputCommitments[0]).toString("hex")}`).toString());
    await pay(pool, alice, 34n, [old!.nullifier, fresh.nullifier]);

    const result = await syncWallet(connection, first.state, alice, { tree: first.tree });
    expect(result.received.map((note) => [note.amount, note.spent])).toEqual([[25n, true], [34n, false]]);
    expect(result.spent.map((note) => note.amount)).toEqual([10n, 25n]);
    expect(ownedNotes(result.state).map((note) => [note.amount, note.spent])).toEqual([[10n, true], [25n, true], [34n, false]]);
    expect(balance(result.state)).toBe(34n);
  });

  it("reads the spent nullifiers from the instruction data when the logs are truncated", async () => {
    const pool = newPool();
    await pay(pool, alice, 100n);
    const first = await syncWallet(pool.connection, createWalletState(alice), alice);
    const [note] = unspentNotes(first.state);
    // A wrapper program fills the log buffer and then spends Alice's note through CPI: no event survives.
    const args = transactArgs([{ amount: 60n, to: alice }, { amount: 0n, to: bob }], pool.tree.root, [note!.nullifier]);
    const signature = cpiTransaction(pool, args, [`Program ${address("wrapper program").toBase58()} invoke [1]`, "Log truncated"]);
    const fetched = (await pool.connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 }))!;
    expect(effectsOf(fetched).nullifiers).toEqual(args.inputNullifiers.map((bytes) => BigInt(`0x${Buffer.from(bytes).toString("hex")}`)));

    const { connection } = watched(pool);
    const second = await syncWallet(connection, first.state, alice, { tree: first.tree });
    expect(second.spent.map((note) => note.amount)).toEqual([100n]);
    expect(balance(second.state)).toBe(60n);
  });

  it("is not fooled by a NewNullifiers event that another program logs, or by a failed transaction", async () => {
    const pool = newPool();
    await pay(pool, alice, 100n);
    const first = await syncWallet(pool.connection, createWalletState(alice), alice);
    const [note] = unspentNotes(first.state);
    const forged = `Program data: ${bytesToBase64(concatBytes(NEW_NULLIFIERS_DISCRIMINATOR, fieldToBytes(note!.nullifier), fieldToBytes(1n)))}`;
    const evil = address("evil program");
    const mention = new TransactionMessage({
      payerKey: relayer,
      recentBlockhash: BLOCKHASH,
      instructions: [new TransactionInstruction({ programId: evil, keys: [{ pubkey: PublicKey.findProgramAddressSync([Buffer.from("tree")], PROGRAM_ID)[0], isSigner: false, isWritable: false }], data: Buffer.from("hi") })],
    }).compileToV0Message();
    // Logged by a program that is not loch_pool.
    pool.push({ err: null, message: mention, logs: [`Program ${evil.toBase58()} invoke [1]`, forged, `Program ${evil.toBase58()} success`] });
    // Logged by loch_pool itself, with a success line, in a transaction the runtime then rejected
    // (a withdrawal that left its destination below the rent-exempt minimum does exactly this).
    const doomed = transactArgs([{ amount: 5n, to: alice }, { amount: 0n, to: bob }], pool.tree.root, [note!.nullifier]);
    const program = PROGRAM_ID.toBase58();
    pool.push({
      err: { InsufficientFundsForRent: { account_index: 5 } },
      message: transaction(doomed).message as MessageV0,
      logs: [`Program ${program} invoke [1]`, "Program data: AAAA", forged, `Program ${program} success`],
    });

    const second = await syncWallet(pool.connection, first.state, alice, { tree: first.tree });
    expect(second.spent).toEqual([]);
    expect(second.newLeaves).toBe(0);
    expect(balance(second.state)).toBe(100n);
    expect(parseEventLogs([`Program ${program} invoke [1]`, forged, `Program ${program} success`]).nullifiers).toHaveLength(1);
  });

  it("areNullifiersSpent: a record counts only when the program owns it", async () => {
    const pool = newPool();
    const [spent, funded, untouched] = [randomBlinding(), randomBlinding(), randomBlinding()];
    await pay(pool, alice, 1n, [spent]);
    // Someone sends lamports to the address a nullifier record would have: the account exists, the note is not spent.
    pool.lamports.set(nullifierPda(funded).toBase58(), 1_000_000n);
    expect(await areNullifiersSpent(pool.connection, [spent, funded, untouched])).toEqual([true, false, false]);
    expect(await isNullifierSpent(pool.connection, fieldToBytes(spent))).toBe(true);
    expect(await isNullifierSpent(pool.connection, funded)).toBe(false);
  });

  it("asks about nullifiers 100 at a time", async () => {
    const pool = newPool();
    const nullifiers = Array.from({ length: 205 }, () => randomBlinding());
    pool.nullifiers.add(nullifierPda(nullifiers[150]!).toBase58());
    const spent = await areNullifiersSpent(pool.connection, nullifiers);
    expect(pool.calls.getMultipleAccountsInfo).toBe(3);
    expect(spent.filter(Boolean)).toHaveLength(1);
    expect(spent[150]).toBe(true);
  });

  it("fails loudly when the local root differs from the chain", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    const good = await syncWallet(pool.connection, createWalletState(alice), alice);
    // A corrupted (or forked-away) leaf in the stored state.
    const corrupted = { ...good.state, leaves: [good.state.leaves[0]!, "12345"], notes: [] };
    await pay(pool, alice, 1n);
    const error = await syncWallet(pool.connection, corrupted, alice).catch((e) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(error).toMatchObject({ code: "SYNC_FAILED", reason: "mismatch" });
    expect(error.message).toMatch(/sync from an empty one/);
  });

  it("leaves the caller's tree untouched when it fails", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    const good = await syncWallet(pool.connection, createWalletState(alice), alice);
    const rootBefore = good.tree.root;
    await pay(pool, alice, 1n);
    pool.staleTreeReads = 100; // the account never catches up
    await expect(syncWallet(pool.connection, good.state, alice, { tree: good.tree, maxRounds: 2 })).rejects.toMatchObject({ reason: "unavailable" });
    expect(good.tree.size).toBe(2);
    expect(good.tree.root).toBe(rootBefore);
    pool.staleTreeReads = 0;
    const retry = await syncWallet(pool.connection, good.state, alice, { tree: good.tree });
    expect(retry.tree.root).toBe(pool.tree.root);
  });

  it("goes another round when the account read lags behind the signatures", async () => {
    const pool = newPool();
    await pay(pool, alice, 3n);
    pool.staleTreeReads = 1;
    const result = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(result.tree.root).toBe(pool.tree.root);
    expect(balance(result.state)).toBe(3n);
  });

  it("goes another round when a transaction lands between the two reads", async () => {
    const pool = newPool();
    await pay(pool, alice, 3n);
    const connection = pool.connection;
    let injected = false;
    const racing = {
      ...connection,
      getAccountInfo: async (key: PublicKey) => {
        if (!injected) {
          injected = true;
          await pay(pool, alice, 4n); // lands after the signature list was read
        }
        return connection.getAccountInfo(key);
      },
    };
    const result = await syncWallet(racing, createWalletState(alice), alice);
    expect(result.newLeaves).toBe(4);
    expect(balance(result.state)).toBe(7n);
    expect(result.tree.root).toBe(pool.tree.root);
  });

  it("settles for a verified recent state when the pool never stands still", async () => {
    const pool = newPool();
    for (let i = 0; i < 3; i++) await pay(pool, alice, 1n);
    const connection = pool.connection;
    // One transaction lands between the signature list and the account read, in every round.
    const busy = {
      ...connection,
      getAccountInfo: async (key: PublicKey) => {
        await pay(pool, bob, 1n);
        return connection.getAccountInfo(key);
      },
    };
    const started = Date.now();
    const result = await syncWallet(busy, createWalletState(alice), alice);
    // Five rounds without waiting, each one transaction short of the chain; the last one is accepted.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.behind).toBe(1);
    expect(result.state.leaves).toHaveLength(pool.tree.nextIndex - 2);
    expect(balance(result.state)).toBe(3n);
    // Its root is one the program still accepts, so the wallet can spend right away.
    const onChain = await fetchTreeAccount(pool.connection);
    expect(result.tree.root).not.toBe(onChain.root);
    expect(isKnownRoot(onChain, result.tree.root)).toBe(true);
    // And it is a correct prefix: on a quiet pool the next sync continues from it.
    const quiet = await syncWallet(pool.connection, result.state, alice, { tree: result.tree });
    expect(quiet).toMatchObject({ behind: 0, newLeaves: 2 });
    expect(quiet.tree.root).toBe(pool.tree.root);
    expect(quiet.state).toEqual((await syncWallet(pool.connection, createWalletState(alice), alice)).state);

    // With maxRounds: 1 the first verified state is taken.
    const before = pool.tree.nextIndex;
    const once = await syncWallet(busy, createWalletState(alice), alice, { maxRounds: 1 });
    expect(once.behind).toBe(1);
    expect(once.state.leaves).toHaveLength(before);
  });

  it("a state that is behind the chain is still checked: a wrong leaf is a mismatch, not a retry", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    await pay(pool, alice, 1n);
    const good = await syncWallet(pool.connection, createWalletState(alice), alice);
    const corrupted = { ...good.state, leaves: [good.state.leaves[0]!, "12345", ...good.state.leaves.slice(2)], notes: [] };
    const connection = pool.connection;
    const busy = {
      ...connection,
      getAccountInfo: async (key: PublicKey) => {
        await pay(pool, bob, 1n);
        return connection.getAccountInfo(key);
      },
    };
    const error = await syncWallet(busy, corrupted, alice, { maxRounds: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(error.reason).toBe("mismatch");
    expect(error.message).toMatch(/not the root the chain had/);
  });

  it("cannot vouch for a state the root history no longer covers: 64 transactions behind is 'try again'", async () => {
    const pool = newPool();
    await pay(pool, alice, 2n);
    const connection = pool.connection;
    let burst = true;
    const flooded = {
      ...connection,
      getAccountInfo: async (key: PublicKey) => {
        if (burst) for (let i = 0; i < 64; i++) await pay(pool, bob, 1n);
        burst = false;
        return connection.getAccountInfo(key);
      },
    };
    await expect(syncWallet(flooded, createWalletState(alice), alice, { maxRounds: 1 })).rejects.toMatchObject({ reason: "unavailable" });
    // With another round it simply fetches the rest.
    const result = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(result).toMatchObject({ behind: 0, newLeaves: 130 });
  });

  it("reports a rollback as a mismatch, so that the client starts over instead of retrying forever", async () => {
    const pool = newPool();
    for (let i = 0; i < 3; i++) await pay(pool, alice, 5n);
    const synced = await syncWallet(pool.connection, createWalletState(alice), alice);
    expect(balance(synced.state)).toBe(15n);

    // The last transaction is dropped by a fork and nothing replaces it: the chain is a strict prefix of the state.
    pool.rollback(1);
    expect(pool.tree.nextIndex).toBe(4);
    const error = await syncWallet(pool.connection, synced.state, alice, { tree: synced.tree, maxRounds: 2 }).catch((e) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(error.reason).toBe("mismatch");
    expect(error.message).toMatch(/rolled back or the pool was reset/);
    expect(error.message).toMatch(/sync from an empty one/);
    // The caller's tree and state are as they were; starting over gives the true balance.
    expect(synced.tree.size).toBe(6);
    expect(balance((await syncWallet(pool.connection, createWalletState(alice), alice)).state)).toBe(10n);
  });

  it("reports a pool that was reset as a mismatch, empty or not", async () => {
    const old = newPool();
    for (let i = 0; i < 2; i++) await pay(old, alice, 5n);
    const synced = await syncWallet(old.connection, createWalletState(alice), alice);

    const empty = newPool();
    const first = await syncWallet(empty.connection, synced.state, alice, { maxRounds: 1 }).catch((e) => e);
    expect(first).toMatchObject({ reason: "mismatch" });
    expect(first.message).toMatch(/rolled back or the pool was reset/);

    const reused = newPool();
    await pay(reused, bob, 1n);
    await expect(syncWallet(reused.connection, synced.state, alice, { maxRounds: 1 })).rejects.toMatchObject({ reason: "mismatch" });
  });

  it("a node that merely serves an older tree is 'try again', and is not confused with a rollback", async () => {
    const pool = newPool();
    await pay(pool, alice, 5n);
    await pay(pool, alice, 5n);
    const synced = await syncWallet(pool.connection, createWalletState(alice), alice);
    // The node knows the last synced transaction but its account data is one transaction old.
    const connection = pool.connection;
    const lagging = new FakePool({ screener: address("screener") });
    await lagging.process(transaction(transactArgs([{ amount: 0n, to: bob }, { amount: 0n, to: bob }], lagging.tree.root)));
    const behind = {
      ...connection,
      getAccountInfo: async () => ({ owner: PROGRAM_ID, lamports: 1, executable: false, data: lagging.tree.accountData() }),
    };
    // That older tree is not a prefix of the state: this is a different chain, hence a mismatch.
    await expect(syncWallet(behind, synced.state, alice, { maxRounds: 1 })).rejects.toMatchObject({ reason: "mismatch" });

    // A true prefix (the tree after the first of Alice's two transactions) is only a lag.
    const prefix = new FakePool({ screener: address("screener") });
    prefix.tree.insertPair(BigInt(synced.state.leaves[0]!), BigInt(synced.state.leaves[1]!));
    const stale = {
      ...connection,
      getAccountInfo: async () => ({ owner: PROGRAM_ID, lamports: 1, executable: false, data: prefix.tree.accountData() }),
    };
    const error = await syncWallet(stale, synced.state, alice, { maxRounds: 1 }).catch((e) => e);
    expect(error).toMatchObject({ reason: "unavailable" });
    expect(error.message).toMatch(/older tree/);
  });

  it("two syncs that overlap and share one cached tree do not disturb each other", async () => {
    const pool = newPool();
    await pay(pool, alice, 5n);
    await pay(pool, bob, 1n);
    const first = await syncWallet(pool.connection, createWalletState(alice), alice);
    const rootBefore = first.tree.root;
    await pay(pool, alice, 7n);

    // The popup and a background alarm sync at the same moment, both with the tree they kept.
    const outcomes = await Promise.allSettled([
      syncWallet(pool.connection, first.state, alice, { tree: first.tree }),
      syncWallet(pool.connection, first.state, alice, { tree: first.tree }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    const [a, b] = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof syncWallet>>>).value);
    expect(a!.state).toEqual(b!.state);
    expect(a!.tree.root).toBe(pool.tree.root);
    expect(b!.tree.root).toBe(pool.tree.root);
    expect(a!.tree).not.toBe(b!.tree);
    expect(balance(a!.state)).toBe(12n);
    // The tree they were given is exactly as it was.
    expect(first.tree.size).toBe(4);
    expect(first.tree.root).toBe(rootBefore);
  });

  it("reports a malformed state as SyncError 'state', whichever way it is malformed", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    const good = await syncWallet(pool.connection, createWalletState(alice), alice);
    const tooLarge = (FIELD_MODULUS + 1n).toString();
    const badLeaf = { ...good.state, leaves: [good.state.leaves[0]!, tooLarge], notes: [] };
    const error = await syncWallet(pool.connection, badLeaf, alice).catch((e) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(error.reason).toBe("state");
  });

  it("recovers when the last-seen signature no longer exists by re-walking and re-checking history", async () => {
    const pool = newPool();
    await pay(pool, alice, 3n);
    const first = await syncWallet(pool.connection, createWalletState(alice), alice);
    await pay(pool, alice, 4n);
    const lost = { ...first.state, lastSignature: base58.encode(randomBytes(64)) };
    const result = await syncWallet(pool.connection, lost, alice);
    expect(result.newLeaves).toBe(2);
    expect(balance(result.state)).toBe(7n);
    expect(result.state.notes).toHaveLength(2);
  });

  it("refuses a state that belongs to other keys, another program, or a mismatched tree", async () => {
    const pool = newPool();
    await pay(pool, alice, 1n);
    await expect(syncWallet(pool.connection, createWalletState(alice), bob)).rejects.toMatchObject({ reason: "state" });
    await expect(syncWallet(pool.connection, { ...createWalletState(alice), programId: "not a key" }, alice)).rejects.toMatchObject({ reason: "state" });
    await expect(syncWallet(pool.connection, createWalletState(alice), alice, { tree: MerkleTree.fromLeaves([1n]) })).rejects.toThrow(/does not belong/);
  });

  it("syncs another deployment when the state says so", async () => {
    const programId = address("another deployment");
    const pool = new FakePool({ screener: address("screener"), programId });
    const args = transactArgs([{ amount: 11n, to: alice }, { amount: 0n, to: alice }], pool.tree.root);
    await pool.process(
      buildTransactTransaction({ instruction: buildTransactInstruction(args, { signer: relayer, programId }), payer: relayer, recentBlockhash: BLOCKHASH }),
    );
    const result = await syncWallet(pool.connection, createWalletState(alice, programId), alice);
    expect(balance(result.state)).toBe(11n);
    expect(result.state.programId).toBe(programId.toBase58());
    // The default program's tree is a different account: nothing there.
    const elsewhere = await fetchEvents(pool.connection);
    expect(elsewhere.events).toEqual([]);
  });
});
