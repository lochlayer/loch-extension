import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  fetchBalances,
  fetchParsedTransactions,
  scanAddress,
  scanAddressDetailed,
} from "../src/index.js";
import type { ScannerConnection } from "../src/index.js";
import { MAX_INSTRUCTIONS_PER_TRANSACTION } from "../src/index.js";
import { RATE_LIMIT_RECOVER_AFTER, RATE_LIMIT_SPACING_MAX_MS, RATE_LIMIT_SPACING_START_MS } from "../src/rpc.js";
import { ALICE, BOB, EXCHANGE, ME, T0, systemTransfer, tx } from "./fixtures.js";

type Call = { method: string; args: unknown[] };

/**
 * An in-memory stand-in for a web3.js Connection: `history` signatures newest
 * first, each resolving to a small parsed transaction. No network.
 */
function fakeConnection(
  history: number,
  over: {
    batch?: (signatures: string[], attempt: number) => unknown;
    single?: (signature: string) => unknown;
    lamports?: number;
    /** Most signatures the RPC returns per call, whatever limit is asked for. */
    pageSize?: number;
    tokenAccounts?: Record<string, number>;
    transaction?: (signature: string) => unknown;
  } = {},
) {
  const calls: Call[] = [];
  const all = Array.from({ length: history }, (_, i) => `sig-${i}`);
  const transaction = over.transaction ?? ((signature: string) => tx([systemTransfer(ME, ALICE, 1_000_000)], { sig: signature }));
  let batchAttempt = 0;
  const connection = {
    async getBalance(...args: unknown[]) {
      calls.push({ method: "getBalance", args });
      return over.lamports ?? 0;
    },
    async getParsedTokenAccountsByOwner(...args: unknown[]) {
      calls.push({ method: "getParsedTokenAccountsByOwner", args });
      const programId = String((args[1] as { programId: { toBase58(): string } }).programId.toBase58());
      return { context: { slot: 1 }, value: new Array(over.tokenAccounts?.[programId] ?? 0).fill({}) };
    },
    async getSignaturesForAddress(...args: unknown[]) {
      calls.push({ method: "getSignaturesForAddress", args });
      const { before, limit } = args[1] as { before?: string; limit: number };
      const start = before ? all.indexOf(before) + 1 : 0;
      return all.slice(start, start + Math.min(limit, over.pageSize ?? limit)).map((signature) => ({ signature }));
    },
    async getParsedTransactions(...args: unknown[]) {
      calls.push({ method: "getParsedTransactions", args });
      const signatures = args[0] as string[];
      if (over.batch) return over.batch(signatures, batchAttempt++);
      return signatures.map(transaction);
    },
    async getParsedTransaction(...args: unknown[]) {
      calls.push({ method: "getParsedTransaction", args });
      const signature = args[0] as string;
      return over.single ? over.single(signature) : transaction(signature);
    },
  };
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  return { connection: connection as unknown as ScannerConnection, calls, count };
}

/** Runs a scan to completion with the pauses and backoffs fast-forwarded. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let failure: unknown;
  const guarded = promise.catch((e: unknown) => {
    failure = e ?? new Error("rejected");
    return undefined as T;
  });
  await vi.runAllTimersAsync();
  const value = await guarded;
  if (failure) throw failure;
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fetchParsedTransactions", () => {
  it("returns nothing for a wallet with no history, without reporting progress", async () => {
    const { connection, count } = fakeConnection(0);
    const onProgress = vi.fn();
    expect(await settle(fetchParsedTransactions(connection, ME, { onProgress }))).toEqual([]);
    expect(count("getSignaturesForAddress")).toBe(1);
    expect(count("getParsedTransactions")).toBe(0);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("fetches in batches of 20 and reports progress after each", async () => {
    const { connection, calls } = fakeConnection(45);
    const progress: unknown[] = [];
    const txs = await settle(fetchParsedTransactions(connection, ME, { onProgress: (p) => progress.push(p) }));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(Array.from({ length: 45 }, (_, i) => `sig-${i}`));
    const batches = calls.filter((c) => c.method === "getParsedTransactions").map((c) => (c.args[0] as string[]).length);
    expect(batches).toEqual([20, 20, 5]);
    expect(progress).toEqual([
      { fetched: 20, total: 45, skipped: 0 },
      { fetched: 40, total: 45, skipped: 0 },
      { fetched: 45, total: 45, skipped: 0 },
    ]);
  });

  it("always asks for maxSupportedTransactionVersion 1, in batches and one at a time", async () => {
    const { connection, calls } = fakeConnection(3, {
      batch: () => {
        throw new Error("batch requests are not supported");
      },
    });
    await settle(fetchParsedTransactions(connection, ME));
    const fetches = calls.filter((c) => c.method === "getParsedTransactions" || c.method === "getParsedTransaction");
    expect(fetches.length).toBeGreaterThan(3);
    for (const call of fetches) expect(call.args[1]).toEqual({ maxSupportedTransactionVersion: 1 });
  });

  it("stops at the limit and defaults to 300", async () => {
    const limited = fakeConnection(500);
    expect(await settle(fetchParsedTransactions(limited.connection, ME, { limit: 15 }))).toHaveLength(15);
    expect(limited.calls[0]?.args[1]).toEqual({ before: undefined, limit: 15 });

    const defaulted = fakeConnection(500);
    expect(await settle(fetchParsedTransactions(defaulted.connection, ME))).toHaveLength(DEFAULT_LIMIT);
  });

  it("clamps the limit to 1000 and pages with `before` when a page comes back short", async () => {
    // An RPC that returns at most 400 signatures per call, as some do.
    const { connection, calls } = fakeConnection(1_500, { pageSize: 400 });
    const txs = await settle(fetchParsedTransactions(connection, ME, { limit: 5_000 }));
    expect(txs).toHaveLength(MAX_LIMIT);
    const pages = calls.filter((c) => c.method === "getSignaturesForAddress").map((c) => c.args[1]);
    expect(pages).toEqual([
      { before: undefined, limit: 1000 },
      { before: "sig-399", limit: 600 },
      { before: "sig-799", limit: 200 },
    ]);
  });

  it("stops paging when the history runs out before the limit", async () => {
    const { connection, count } = fakeConnection(7);
    expect(await settle(fetchParsedTransactions(connection, ME, { limit: 50 }))).toHaveLength(7);
    expect(count("getSignaturesForAddress")).toBe(2);
  });

  it("rejects a limit that is not a non-negative number", async () => {
    const { connection, calls } = fakeConnection(5);
    await expect(fetchParsedTransactions(connection, ME, { limit: Number.NaN })).rejects.toThrow(RangeError);
    await expect(fetchParsedTransactions(connection, ME, { limit: -1 })).rejects.toThrow("limit must be a number from 0 to 1000");
    expect(calls).toEqual([]);
    expect(await settle(fetchParsedTransactions(connection, ME, { limit: 0 }))).toEqual([]);
    expect(await settle(fetchParsedTransactions(connection, ME, { limit: 2.9 }))).toHaveLength(2);
  });

  it("drops failed transactions and ones the RPC could not return", async () => {
    const { connection } = fakeConnection(4, {
      transaction: (signature) => {
        if (signature === "sig-1") return null;
        if (signature === "sig-2") return tx([systemTransfer(ME, ALICE, 1)], { sig: signature, err: { InstructionError: [0, "Custom"] } });
        return tx([systemTransfer(ME, ALICE, 1)], { sig: signature });
      },
    });
    const onProgress = vi.fn();
    const txs = await settle(fetchParsedTransactions(connection, ME, { onProgress }));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(["sig-0", "sig-3"]);
    // The one the RPC had nothing for is skipped; the failed one was read and is left out by design.
    expect(onProgress).toHaveBeenLastCalledWith({ fetched: 4, total: 4, skipped: 1 });
  });

  it("retries a batch that got no answer up to four times before giving up on batching", async () => {
    // No answer at all: the request never left, or the connection failed before a response. As fetch says it
    // in Node, Chromium, Firefox and Safari, as node-fetch and Node's own clients say it, and a timeout.
    const failures: Error[] = [
      new TypeError("fetch failed"),
      new TypeError("Failed to fetch"),
      new TypeError("NetworkError when attempting to fetch resource."),
      new TypeError("Load failed"),
      Object.assign(new Error("request to the endpoint failed, reason: connect ECONNREFUSED"), { name: "FetchError", type: "system", code: "ECONNREFUSED" }),
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
    ];
    for (const failure of failures) {
      const { connection, count } = fakeConnection(2, {
        batch: (signatures, attempt) => {
          if (attempt < 3) throw failure;
          return signatures.map((sig) => tx([systemTransfer(ME, ALICE, 1)], { sig }));
        },
      });
      expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(2);
      expect(count("getParsedTransactions"), failure.message).toBe(4);
      expect(count("getParsedTransaction"), failure.message).toBe(0);
    }
  });

  it("keeps batching after a batch that recovered on retry", async () => {
    const { connection, count } = fakeConnection(45, {
      batch: (signatures, attempt) => {
        if (attempt < 2) throw new Error("fetch failed");
        return signatures.map((sig) => tx([systemTransfer(ME, ALICE, 1)], { sig }));
      },
    });
    expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(45);
    // Two failed attempts, then one call for each of the three batches.
    expect(count("getParsedTransactions")).toBe(5);
    expect(count("getParsedTransaction")).toBe(0);
  });

  it("stops batching for the rest of the scan once a batch has failed and single requests work", async () => {
    const { connection, calls, count } = fakeConnection(45, {
      batch: () => {
        throw new Error("fetch failed");
      },
    });
    const progress: { fetched: number; total: number; skipped: number }[] = [];
    const txs = await settle(fetchParsedTransactions(connection, ME, { onProgress: (p) => progress.push(p) }));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(Array.from({ length: 45 }, (_, i) => `sig-${i}`));
    // The first batch gets its four attempts. The other two batches are never sent.
    expect(count("getParsedTransactions")).toBe(4);
    expect(count("getParsedTransaction")).toBe(45);
    // Every batch attempt comes before the first single request.
    const order = calls.map((c) => c.method).filter((m) => m.startsWith("getParsedTransaction"));
    expect(order.lastIndexOf("getParsedTransactions")).toBeLessThan(order.indexOf("getParsedTransaction"));
    // One at a time, progress is reported after every transaction.
    expect(progress).toEqual(Array.from({ length: 45 }, (_, i) => ({ fetched: i + 1, total: 45, skipped: 0 })));
  });

  it("tries the next batch again while single requests do not work either", async () => {
    // The network is down for the first 20 signatures, batch or single, then comes back.
    const down = (signature: string) => Number(signature.slice(4)) < 20;
    const { connection, calls } = fakeConnection(45, {
      batch: (signatures) => {
        if (signatures.some(down)) throw new TypeError("fetch failed");
        return signatures.map((sig) => tx([systemTransfer(ME, ALICE, 1)], { sig }));
      },
      single: (signature) => {
        if (down(signature)) throw new TypeError("fetch failed");
        return tx([systemTransfer(ME, ALICE, 1)], { sig: signature });
      },
    });
    const onProgress = vi.fn();
    const txs = await settle(fetchParsedTransactions(connection, ME, { onProgress }));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(Array.from({ length: 25 }, (_, i) => `sig-${i + 20}`));
    const batches = calls.filter((c) => c.method === "getParsedTransactions").map((c) => (c.args[0] as string[])[0]);
    // Four attempts at the first batch, then the second and third batches are sent as batches.
    expect(batches).toEqual(["sig-0", "sig-0", "sig-0", "sig-0", "sig-20", "sig-40"]);
    // Four attempts at each of the 20 single requests, none after that.
    expect(calls.filter((c) => c.method === "getParsedTransaction")).toHaveLength(80);
    expect(onProgress).toHaveBeenLastCalledWith({ fetched: 45, total: 45, skipped: 20 });
  });

  it("falls back to one request per transaction when the RPC rejects batches", async () => {
    const { connection, count } = fakeConnection(3, {
      batch: () => {
        throw new Error("batch requests are not supported");
      },
    });
    const onProgress = vi.fn();
    const txs = await settle(fetchParsedTransactions(connection, ME, { onProgress }));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(["sig-0", "sig-1", "sig-2"]);
    // The batch and its one resend. Not four.
    expect(count("getParsedTransactions")).toBe(2);
    expect(count("getParsedTransaction")).toBe(3);
    expect(onProgress).toHaveBeenLastCalledWith({ fetched: 3, total: 3, skipped: 0 });
  });

  it("skips a transaction that cannot be fetched one at a time either", async () => {
    const { connection, count } = fakeConnection(3, {
      batch: () => {
        throw new Error("batch requests are not supported");
      },
      single: (signature) => {
        if (signature === "sig-1") throw new Error("cannot decode transaction");
        return tx([systemTransfer(ME, ALICE, 1)], { sig: signature });
      },
    });
    const progress: unknown[] = [];
    const txs = await settle(fetchParsedTransactions(connection, ME, { onProgress: (p) => progress.push(p) }));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(["sig-0", "sig-2"]);
    // sig-0 once, sig-1 four attempts, sig-2 once.
    expect(count("getParsedTransaction")).toBe(6);
    expect(progress).toEqual([
      { fetched: 1, total: 3, skipped: 0 },
      { fetched: 2, total: 3, skipped: 1 },
      { fetched: 3, total: 3, skipped: 1 },
    ]);
  });

  it("writes nothing to the console or to stderr", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(process.stderr, "write"), vi.spyOn(process.stdout, "write")];
    const { connection } = fakeConnection(25);
    await settle(fetchParsedTransactions(connection, ME, { onProgress: () => {} }));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("rejects with the abort reason and makes no request when already aborted", async () => {
    const { connection, calls } = fakeConnection(10);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchParsedTransactions(connection, ME, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual([]);
  });

  it("stops between batches when aborted mid-scan", async () => {
    const { connection, count } = fakeConnection(100);
    const controller = new AbortController();
    const reason = new Error("user closed the popup");
    const onProgress = vi.fn(({ fetched }: { fetched: number }) => {
      if (fetched === 40) controller.abort(reason);
    });
    await expect(settle(fetchParsedTransactions(connection, ME, { limit: 100, onProgress, signal: controller.signal }))).rejects.toBe(reason);
    expect(count("getParsedTransactions")).toBe(2);
  });

  it("does not swallow an abort inside the retry and fallback paths", async () => {
    const controller = new AbortController();
    const { connection, count } = fakeConnection(5, {
      batch: () => {
        controller.abort();
        throw new Error("network down");
      },
    });
    await expect(settle(fetchParsedTransactions(connection, ME, { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(count("getParsedTransactions")).toBe(1);
    expect(count("getParsedTransaction")).toBe(0);
  });

  it("stops part-way through the one-at-a-time fallback when aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("navigated away");
    const { connection, count } = fakeConnection(10, {
      batch: () => {
        throw new Error("batch requests are not supported");
      },
      single: (signature) => {
        if (signature === "sig-3") controller.abort(reason);
        return tx([systemTransfer(ME, ALICE, 1)], { sig: signature });
      },
    });
    await expect(settle(fetchParsedTransactions(connection, ME, { signal: controller.signal }))).rejects.toBe(reason);
    expect(count("getParsedTransaction")).toBe(4);
  });

  it("rejects an address that is not a public key", async () => {
    const { connection, calls } = fakeConnection(5);
    await expect(fetchParsedTransactions(connection, "not-an-address")).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("fetchBalances", () => {
  it("converts lamports to SOL and adds legacy and Token-2022 accounts together", async () => {
    const { connection, calls } = fakeConnection(0, {
      lamports: 2_500_000_000,
      tokenAccounts: { [TOKEN_PROGRAM_ID]: 4, [TOKEN_2022_PROGRAM_ID]: 3 },
    });
    expect(await fetchBalances(connection, ME)).toEqual({ solBalance: 2.5, tokenAccountCount: 7 });
    const programs = calls
      .filter((c) => c.method === "getParsedTokenAccountsByOwner")
      .map((c) => (c.args[1] as { programId: { toBase58(): string } }).programId.toBase58());
    expect(programs).toEqual([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
  });
});

describe("scanAddress", () => {
  it("produces a full report from one call", async () => {
    const { connection } = fakeConnection(3, {
      lamports: 150_000_000_000,
      transaction: (signature) =>
        signature === "sig-2"
          ? tx([systemTransfer(EXCHANGE, ME, 2_000_000_000)], { sig: signature, blockTime: T0 })
          : tx([systemTransfer(ME, BOB, 2_000_000_000)], { sig: signature, blockTime: T0 + 60 }),
    });
    const report = await settle(scanAddress(connection, ME, { labels: { [EXCHANGE]: "Exchange withdrawal" } }));
    expect(report).toEqual({
      address: ME,
      scannedTransactions: 3,
      transfers: 3,
      score: 45,
      findings: [
        expect.objectContaining({ id: "funding-source", severity: "high", penalty: 20 }),
        expect.objectContaining({ id: "identified-services", severity: "high", penalty: 10 }),
        expect.objectContaining({ id: "balance-visible", severity: "high", penalty: 15 }),
        expect.objectContaining({ id: "pass-through", severity: "medium", penalty: 10 }),
      ],
    });
  });

  it("counts Token-2022 accounts towards the visible-balance finding", async () => {
    const legacyOnly = fakeConnection(0, { tokenAccounts: { [TOKEN_PROGRAM_ID]: 6 } });
    expect((await settle(scanAddress(legacyOnly.connection, ME))).findings).toEqual([]);

    const both = fakeConnection(0, { tokenAccounts: { [TOKEN_PROGRAM_ID]: 6, [TOKEN_2022_PROGRAM_ID]: 5 } });
    const report = await settle(scanAddress(both.connection, ME));
    expect(report.findings).toEqual([
      expect.objectContaining({ id: "balance-visible", detail: "0.000 SOL and 11 token accounts are public. Anyone you pay can look." }),
    ]);
    expect(report.score).toBe(95);
  });

  it("returns the flows alongside the report from scanAddressDetailed", async () => {
    const { connection } = fakeConnection(2);
    const { report, flows, skipped } = await settle(scanAddressDetailed(connection, ME, { limit: 2 }));
    expect(flows).toHaveLength(2);
    expect(flows[0]).toEqual({ sig: "sig-0", time: T0, dir: "out", counterparty: ALICE, amount: 0.001, asset: "SOL" });
    expect(report.transfers).toBe(2);
    expect(skipped).toBe(0);
  });

  it("says how many transactions it had to skip, and leaves the report shape alone", async () => {
    const { connection } = fakeConnection(30, {
      batch: () => {
        throw new Error("429 Too Many Requests");
      },
      single: (signature) => {
        if (signature === "sig-4" || signature === "sig-27") throw new Error("429 Too Many Requests");
        return tx([systemTransfer(ME, ALICE, 1_000_000)], { sig: signature });
      },
    });
    const { report, flows, skipped } = await settle(scanAddressDetailed(connection, ME));
    expect(skipped).toBe(2);
    expect(report.scannedTransactions).toBe(28);
    expect(flows).toHaveLength(28);
    expect(Object.keys(report).sort()).toEqual(["address", "findings", "scannedTransactions", "score", "transfers"]);
  });

  it("reports nothing skipped for a wallet with no history", async () => {
    const { connection } = fakeConnection(0);
    expect((await settle(scanAddressDetailed(connection, ME))).skipped).toBe(0);
  });

  it("passes limit, progress and signal through to the download", async () => {
    const { connection, count } = fakeConnection(100);
    const onProgress = vi.fn();
    const report = await settle(scanAddress(connection, ME, { limit: 25, onProgress }));
    expect(report.scannedTransactions).toBe(25);
    expect(onProgress).toHaveBeenLastCalledWith({ fetched: 25, total: 25, skipped: 0 });

    const controller = new AbortController();
    controller.abort();
    const before = count("getBalance");
    await expect(scanAddress(connection, ME, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(count("getBalance")).toBe(before);
  });

  it("rejects an invalid address or limit before making any request", async () => {
    const { connection, calls } = fakeConnection(5);
    await expect(scanAddress(connection, "definitely not base58 !")).rejects.toThrow();
    await expect(scanAddress(connection, ME, { limit: Number.NaN })).rejects.toThrow("limit must be a number from 0 to 1000");
    expect(calls).toEqual([]);
  });
});

describe("an endpoint that limits requests", () => {
  /** A connection whose transaction calls note when they were made (the clock is the fake one). */
  function timed(history: number, over: { batch?: (attempt: number) => string | undefined; single?: (signature: string, attempt: number) => string | undefined }) {
    const log: { method: "batch" | "single"; at: number; signature: string }[] = [];
    const attempts = new Map<string, number>();
    let batchAttempt = 0;
    const base = fakeConnection(history);
    const connection = {
      ...base.connection,
      async getParsedTransactions(signatures: string[]) {
        log.push({ method: "batch", at: Date.now(), signature: signatures[0] ?? "" });
        const failure = over.batch?.(batchAttempt++);
        if (failure) throw new Error(failure);
        return signatures.map((sig) => tx([systemTransfer(ME, ALICE, 1)], { sig }));
      },
      async getParsedTransaction(signature: string) {
        log.push({ method: "single", at: Date.now(), signature });
        const attempt = attempts.get(signature) ?? 0;
        attempts.set(signature, attempt + 1);
        const failure = over.single?.(signature, attempt);
        if (failure) throw new Error(failure);
        return tx([systemTransfer(ME, ALICE, 1)], { sig: signature });
      },
    } as unknown as ScannerConnection;
    const gaps = (method: "batch" | "single") => {
      const at = log.filter((entry) => entry.method === method).map((entry) => entry.at);
      return at.slice(1).map((time, k) => time - at[k]!);
    };
    return { connection, log, gaps };
  }

  beforeEach(() => {
    vi.setSystemTime(0);
  });

  it("sends a batch answered 429 once more, and then asks one at a time for the rest of the scan", async () => {
    const { connection, log } = timed(45, { batch: () => "429 Too Many Requests: slow down" });
    const txs = await settle(fetchParsedTransactions(connection, ME));
    expect(txs).toHaveLength(45);
    const batches = log.filter((entry) => entry.method === "batch");
    // The first batch twice. Not four times, and the second and third batches are never sent as batches.
    expect(batches.map((entry) => entry.signature)).toEqual(["sig-0", "sig-0"]);
    // It waited before sending it again.
    expect(batches[1]!.at - batches[0]!.at).toBeGreaterThanOrEqual(500);
    expect(log.filter((entry) => entry.method === "single")).toHaveLength(45);
  });

  it("goes on batching when the batch is accepted the second time", async () => {
    const { connection, log } = timed(45, { batch: (attempt) => (attempt === 0 ? "429 Too Many Requests" : undefined) });
    expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(45);
    expect(log.map((entry) => entry.method)).toEqual(["batch", "batch", "batch", "batch"]);
    // And the batches after the refusal are further apart than the usual quarter of a second.
    const at = log.map((entry) => entry.at);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(RATE_LIMIT_SPACING_START_MS);
    expect(at[3]! - at[2]!).toBeGreaterThanOrEqual(RATE_LIMIT_SPACING_START_MS);
  });

  it.each([
    ["403 Forbidden: batch requests are not available on this plan"],
    ["400 Bad Request: {\"error\":{\"code\":-32600,\"message\":\"Batch requests are not supported\"}}"],
    ["502 Bad Gateway: {\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32092,\"message\":\"The upstream answer is too large\"}}"],
    ["503 Service Unavailable: "],
    ["failed to get transactions: Batch requests are not supported"],
    ["Cannot read properties of undefined (reading 'map')"],
  ])("sends a batch the endpoint answered with %j once more, then asks one at a time for the rest of the scan, without slowing down", async (failure) => {
    const { connection, log, gaps } = timed(45, { batch: () => failure });
    expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(45);
    const batches = log.filter((entry) => entry.method === "batch");
    // The first batch twice. Not four times, and the second and third batches are never sent as batches.
    expect(batches.map((entry) => entry.signature)).toEqual(["sig-0", "sig-0"]);
    expect(batches[1]!.at - batches[0]!.at).toBe(500);
    expect(log.filter((entry) => entry.method === "single")).toHaveLength(45);
    // That is not a rate limit: single requests keep their usual pace.
    expect(new Set(gaps("single"))).toEqual(new Set([150]));
  });

  it("takes an error that carries a status, or a JSON-RPC error, for an answer whatever its words", async () => {
    const answers: unknown[] = [
      // web3.js's own error for a JSON-RPC error inside a batch. Its `code` is the endpoint's, and is not read.
      Object.assign(new Error("failed to get transactions: fetch failed"), { name: "SolanaJSONRPCError", code: "ECONNRESET" }),
      Object.assign(new Error("failed to get transactions: Invalid request"), { name: "SolanaJSONRPCError", code: -32600 }),
      // A connection of the caller's own that sets a numeric status.
      Object.assign(new Error("fetch failed"), { status: 403 }),
      Object.assign(new Error("request failed"), { statusCode: 500 }),
      // Not an Error at all.
      "refused",
      undefined,
    ];
    for (const failure of answers) {
      const base = fakeConnection(45);
      let batches = 0;
      const connection = {
        ...base.connection,
        async getParsedTransactions() {
          batches += 1;
          throw failure;
        },
      } as unknown as ScannerConnection;
      expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(45);
      expect(batches, String((failure as Error | undefined)?.message ?? failure)).toBe(2);
      expect(base.count("getParsedTransaction")).toBe(45);
    }
  });

  it("goes on batching when a batch the endpoint refused is accepted the second time, whatever the refusal", async () => {
    for (const failure of ["503 Service Unavailable: ", "400 Bad Request: try again", "failed to get transactions: Node is behind"]) {
      const { connection, log } = timed(45, { batch: (attempt) => (attempt === 0 ? failure : undefined) });
      expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(45);
      expect(log.map((entry) => entry.method), failure).toEqual(["batch", "batch", "batch", "batch"]);
    }
  });

  it("stops batching after an answered refusal even while single requests fail too", async () => {
    // The endpoint is down (it answers 503) for the first 20 signatures, batch or single, then comes back.
    const down = (signature: string) => Number(signature.slice(4)) < 20;
    const { connection, log } = timed(45, {
      batch: (attempt) => (attempt < 2 ? "503 Service Unavailable: " : undefined),
      single: (signature) => (down(signature) ? "503 Service Unavailable: " : undefined),
    });
    const onProgress = vi.fn();
    const txs = await settle(fetchParsedTransactions(connection, ME, { onProgress }));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(Array.from({ length: 25 }, (_, i) => `sig-${i + 20}`));
    // Two attempts at the first batch, and no batch after it: the endpoint said no twice.
    expect(log.filter((entry) => entry.method === "batch").map((entry) => entry.signature)).toEqual(["sig-0", "sig-0"]);
    // Four attempts at each of the first 20, one for each of the other 25.
    expect(log.filter((entry) => entry.method === "single")).toHaveLength(80 + 25);
    expect(onProgress).toHaveBeenLastCalledWith({ fetched: 45, total: 45, skipped: 20 });
  });

  it("counts attempts that got no answer before the refusal: one resend after the endpoint first answers", async () => {
    // Two attempts get no answer, the third is answered 403, the fourth (its one resend) too.
    const outcomes = ["fetch failed", "fetch failed", "403 Forbidden: ", "403 Forbidden: ", undefined];
    const { connection, log } = timed(45, { batch: (attempt) => outcomes[Math.min(attempt, outcomes.length - 1)] });
    expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(45);
    expect(log.filter((entry) => entry.method === "batch")).toHaveLength(4);
    expect(log.filter((entry) => entry.method === "single")).toHaveLength(45);

    // Answered on the first attempt, no answer on the resend: that was the one resend.
    const second = timed(45, { batch: (attempt) => (attempt === 0 ? "400 Bad Request: " : "fetch failed") });
    expect(await settle(fetchParsedTransactions(second.connection, ME))).toHaveLength(45);
    expect(second.log.filter((entry) => entry.method === "batch")).toHaveLength(2);
  });

  it("knows a rate limit by the status at the start of the message, by a status property, or by its name", async () => {
    const failures: unknown[] = [
      new Error("429 Too Many Requests: {\"jsonrpc\":\"2.0\",\"error\":{\"code\":429}}"),
      new Error("429 : "),
      Object.assign(new Error("request failed"), { status: 429 }),
      Object.assign(new Error("request failed"), { statusCode: 429 }),
      new Error("failed to get transactions: Too many requests for a specific RPC call"),
    ];
    for (const failure of failures) {
      const base = fakeConnection(45);
      let batches = 0;
      const connection = {
        ...base.connection,
        async getParsedTransactions() {
          batches += 1;
          throw failure;
        },
      } as unknown as ScannerConnection;
      expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(45);
      expect(batches, String((failure as Error).message)).toBe(2);
    }
    // A number that merely starts with 429, or a 429 further into the endpoint's own text, is not one:
    // the batch is refused all the same, but nothing is slowed down for it.
    for (const failure of ["4290 is not a status", `500 Internal Server Error: ${"x".repeat(300)} 429 Too Many Requests`]) {
      const { connection, gaps } = timed(45, { batch: () => failure });
      await settle(fetchParsedTransactions(connection, ME));
      expect(new Set(gaps("single")), failure.slice(0, 30)).toEqual(new Set([150]));
    }
    // And a rate limit does slow the single requests down, so the check above means something.
    const limited = timed(45, { batch: () => "429 Too Many Requests" });
    await settle(fetchParsedTransactions(limited.connection, ME));
    expect(limited.gaps("single")[0]).toBeGreaterThanOrEqual(RATE_LIMIT_SPACING_START_MS);
  });

  it("spaces single requests out after a 429: wider with each refusal up to the bound, and no wider", async () => {
    // Batches are refused. Then five single requests in a row are refused once each.
    const refusedOnce = new Set(["sig-0", "sig-1", "sig-2", "sig-3", "sig-4"]);
    const { connection, log } = timed(12, {
      batch: () => "429 Too Many Requests",
      single: (signature, attempt) => (refusedOnce.has(signature) && attempt === 0 ? "429 Too Many Requests" : undefined),
    });
    expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(12);
    const singles = log.filter((entry) => entry.method === "single");
    // Seven refusals in all (two batches, five singles): 300, 600, then 1200 and it stays there.
    const firstTry = (signature: string) => singles.find((entry) => entry.signature === signature)!.at;
    const gapsAfterTheLastRefusal = [6, 7, 8, 9, 10].map((n) => firstTry(`sig-${n + 1}`) - firstTry(`sig-${n}`));
    expect(gapsAfterTheLastRefusal).toEqual([1200, 1200, 1200, 1200, 1200]);
    expect(RATE_LIMIT_SPACING_MAX_MS).toBe(1200);
    // A refused single request is asked again, after a wait, and then goes through: nothing is skipped.
    const retried = singles.filter((entry) => entry.signature === "sig-0");
    expect(retried).toHaveLength(2);
    expect(retried[1]!.at - retried[0]!.at).toBeGreaterThanOrEqual(500);
  });

  it("eases off again after a run of requests that went through", async () => {
    // One refusal (the batch, twice), then nothing but success.
    const { connection, log } = timed(80, { batch: () => "429 Too Many Requests" });
    expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(80);
    const at = log.filter((entry) => entry.method === "single").map((entry) => entry.at);
    const gaps = at.slice(1).map((time, k) => time - at[k]!);
    // Two refusals put the spacing at 600 ms. After 20 requests that went through it halves, after 20 more it is gone.
    expect(gaps.slice(0, RATE_LIMIT_RECOVER_AFTER - 1)).toEqual(new Array(RATE_LIMIT_RECOVER_AFTER - 1).fill(600));
    expect(gaps.slice(RATE_LIMIT_RECOVER_AFTER - 1, 2 * RATE_LIMIT_RECOVER_AFTER - 1)).toEqual(new Array(RATE_LIMIT_RECOVER_AFTER).fill(300));
    expect(gaps.slice(2 * RATE_LIMIT_RECOVER_AFTER - 1)).toEqual(new Array(79 - (2 * RATE_LIMIT_RECOVER_AFTER - 1)).fill(150));
  });

  it("does not slow down an endpoint that never refuses, or one that merely fails", async () => {
    const quiet = timed(60, {});
    await settle(fetchParsedTransactions(quiet.connection, ME));
    expect(quiet.gaps("batch")).toEqual([250, 250]);

    const failing = timed(30, { batch: () => "fetch failed" });
    await settle(fetchParsedTransactions(failing.connection, ME));
    expect(new Set(failing.gaps("single"))).toEqual(new Set([150]));
  });

  it("asks a single request that is refused four times in all, then skips it", async () => {
    const { connection, log } = timed(3, {
      batch: () => "429 Too Many Requests",
      single: (signature) => (signature === "sig-1" ? "429 Too Many Requests" : undefined),
    });
    const onProgress = vi.fn();
    const txs = await settle(fetchParsedTransactions(connection, ME, { onProgress }));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(["sig-0", "sig-2"]);
    const attempts = log.filter((entry) => entry.signature === "sig-1" && entry.method === "single").map((entry) => entry.at);
    expect(attempts).toHaveLength(4);
    // Each wait is the backoff or the spacing, whichever is longer.
    expect(attempts.slice(1).map((time, k) => time - attempts[k]!)).toEqual([1200, 1200, 2000]);
    expect(onProgress).toHaveBeenLastCalledWith({ fetched: 3, total: 3, skipped: 1 });
  });

  it("composes with a caller that refuses repeat batches itself, as the website does: one batch reaches the endpoint", async () => {
    // apps/web wraps getParsedTransactions: after one batch the endpoint answered and would not serve, the one
    // resend is rejected without a request. The library must take that for an answer and not insist.
    const { connection, log } = timed(45, { batch: () => "429 Too Many Requests" });
    let refused = false;
    let turnedAway = 0;
    const guarded = {
      ...connection,
      getParsedTransactions: (...args: Parameters<ScannerConnection["getParsedTransactions"]>) => {
        if (refused) {
          turnedAway += 1;
          return Promise.reject(new Error("The endpoint did not accept a batch earlier in this scan."));
        }
        return connection.getParsedTransactions(...args).catch((e: unknown) => {
          refused = true;
          throw e;
        });
      },
    } as ScannerConnection;
    const { skipped, report } = await settle(scanAddressDetailed(guarded, ME));
    expect(skipped).toBe(0);
    expect(report.scannedTransactions).toBe(45);
    expect(log.filter((entry) => entry.method === "batch")).toHaveLength(1);
    // The library tried the batch once more, and only once more; the caller turned that away.
    expect(turnedAway).toBe(1);
    expect(log.filter((entry) => entry.method === "single")).toHaveLength(45);
  });
});

describe("sizes the endpoint chooses", () => {
  it("reads no more signatures than it asked for, however many the endpoint returns", async () => {
    const base = fakeConnection(0);
    const asked: number[] = [];
    const connection = {
      ...base.connection,
      async getSignaturesForAddress(_owner: unknown, options: { before?: string; limit: number }) {
        asked.push(options.limit);
        // Asked for 100, answers with 5000, and would again.
        return Array.from({ length: 5000 }, (_, i) => ({ signature: `${options.before ?? "first"}-${i}` }));
      },
    } as unknown as ScannerConnection;
    const onProgress = vi.fn();
    const txs = await settle(fetchParsedTransactions(connection, ME, { limit: 100, onProgress }));
    expect(asked).toEqual([100]);
    expect(txs).toHaveLength(100);
    expect(base.calls.filter((c) => c.method === "getParsedTransactions").map((c) => (c.args[0] as string[]).length)).toEqual([20, 20, 20, 20, 20]);
    expect(onProgress).toHaveBeenLastCalledWith({ fetched: 100, total: 100, skipped: 0 });
  });

  it("never scans more than MAX_LIMIT transactions, whatever the endpoint returns", async () => {
    const base = fakeConnection(0);
    const connection = {
      ...base.connection,
      async getSignaturesForAddress(_owner: unknown, options: { before?: string; limit: number }) {
        return Array.from({ length: 200_000 }, (_, i) => ({ signature: `${options.before ?? "p"}-${i}` }));
      },
    } as unknown as ScannerConnection;
    const { report } = await settle(scanAddressDetailed(connection, ME, { limit: 1_000_000 }));
    expect(report.scannedTransactions).toBe(MAX_LIMIT);
  });

  it("stops when the endpoint sends the same page again and again", async () => {
    const base = fakeConnection(0);
    let pages = 0;
    const connection = {
      ...base.connection,
      async getSignaturesForAddress() {
        pages += 1;
        return [{ signature: "sig-a" }, { signature: "sig-b" }, { signature: "sig-a" }];
      },
    } as unknown as ScannerConnection;
    const txs = await settle(fetchParsedTransactions(connection, ME, { limit: 500 }));
    expect(pages).toBe(2);
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(["sig-a", "sig-b"]);
  });

  it("does not ask for anything in a history that is not a signature", async () => {
    const base = fakeConnection(0);
    const connection = {
      ...base.connection,
      async getSignaturesForAddress(_owner: unknown, options: { before?: string }) {
        if (options.before) return [];
        return [{ signature: "sig-0" }, { signature: 7 }, null, {}, { signature: "" }, { signature: "x".repeat(100_000) }, { signature: ["sig-9"] }, { signature: "sig-1" }];
      },
    } as unknown as ScannerConnection;
    const txs = await settle(fetchParsedTransactions(connection, ME));
    expect(txs.map((t) => t.transaction.signatures[0])).toEqual(["sig-0", "sig-1"]);
    expect(base.calls.find((c) => c.method === "getParsedTransactions")?.args[0]).toEqual(["sig-0", "sig-1"]);
  });

  it("reads one result for each signature of a batch: no more when more come back, and the missing ones are skipped", async () => {
    const more = fakeConnection(3, {
      batch: (signatures) => [...signatures.map((sig) => tx([systemTransfer(ME, ALICE, 1)], { sig })), ...Array.from({ length: 5000 }, (_, i) => tx([systemTransfer(ME, ALICE, 1)], { sig: `extra-${i}` }))],
    });
    expect((await settle(fetchParsedTransactions(more.connection, ME))).map((t) => t.transaction.signatures[0])).toEqual(["sig-0", "sig-1", "sig-2"]);

    const fewer = fakeConnection(3, { batch: (signatures) => [tx([systemTransfer(ME, ALICE, 1)], { sig: signatures[0] })] });
    const onProgress = vi.fn();
    expect(await settle(fetchParsedTransactions(fewer.connection, ME, { onProgress }))).toHaveLength(1);
    expect(onProgress).toHaveBeenLastCalledWith({ fetched: 3, total: 3, skipped: 2 });
  });

  it("falls back to single requests when a batch is answered with something that is not a list", async () => {
    const { connection, count } = fakeConnection(3, { batch: () => ({ error: "nope" }) });
    expect(await settle(fetchParsedTransactions(connection, ME))).toHaveLength(3);
    expect(count("getParsedTransaction")).toBe(3);
  });

  it("reads a transaction of 120,000 instructions in bounded time, and the report says it was cut", async () => {
    const instructions = Array.from({ length: 120_000 }, (_, k) => (k % 2 === 0 ? systemTransfer(ALICE, ME, k + 1) : systemTransfer(ME, BOB, k)));
    const { connection } = fakeConnection(1, { transaction: (signature) => tx(instructions, { sig: signature }) });
    vi.useRealTimers();
    const started = performance.now();
    const { report, flows } = await scanAddressDetailed(connection, ME, { limit: 1 });
    const took = performance.now() - started;
    expect(flows).toHaveLength(MAX_INSTRUCTIONS_PER_TRANSACTION);
    expect(report.transfers).toBe(MAX_INSTRUCTIONS_PER_TRANSACTION);
    expect(report.limitsHit).toEqual({ transactionsCut: 1, flowsCapped: false });
    // It used to take most of a minute.
    expect(took).toBeLessThan(2_000);
  });

  it("leaves limitsHit out of an ordinary report", async () => {
    const { connection } = fakeConnection(30);
    const { report } = await settle(scanAddressDetailed(connection, ME));
    expect("limitsHit" in report).toBe(false);
    expect(Object.keys(report).sort()).toEqual(["address", "findings", "scannedTransactions", "score", "transfers"]);
  });
});
