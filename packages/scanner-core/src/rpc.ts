import { PublicKey } from "@solana/web3.js";
import type { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";

import { buildReport } from "./analyse.js";
import { extractFlowsDetailed } from "./flows.js";
import type { Flow, Labels, LeakReport } from "./types.js";

/** Legacy SPL Token program. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Token-2022 (Token Extensions) program. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Signatures scanned when no limit is given. */
export const DEFAULT_LIMIT = 300;
/** Hard ceiling on signatures per scan. Larger limits are clamped to this. */
export const MAX_LIMIT = 1000;

const LAMPORTS_PER_SOL = 1_000_000_000;
const BATCH_SIZE = 20;
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const BATCH_PAUSE_MS = 250;
const SINGLE_PAUSE_MS = 150;
/** A base58 signature is at most 88 characters. Anything longer in a history is not a signature and is not asked for. */
const MAX_SIGNATURE_LENGTH = 128;

/**
 * Once the endpoint has answered "too many requests" (HTTP 429), requests are
 * spaced at least this far apart. Each further refusal doubles the spacing, up
 * to {@link RATE_LIMIT_SPACING_MAX_MS}.
 */
export const RATE_LIMIT_SPACING_START_MS = 300;
/** The widest the spacing gets. A little over a second: Solana's public devnet endpoint was measured to allow one method about one call a second. */
export const RATE_LIMIT_SPACING_MAX_MS = 1_200;
/** Requests in a row that have to go through at the current spacing before it is halved again. Below the start it is dropped. */
export const RATE_LIMIT_RECOVER_AFTER = 20;
// Solana mainnet returns version-1 transactions; anything lower makes the RPC reject them.
const TRANSACTION_CONFIG = { maxSupportedTransactionVersion: 1 } as const;

/**
 * The five `Connection` methods the scanner calls. A `@solana/web3.js`
 * `Connection` satisfies it; so does any object with these methods.
 */
export type ScannerConnection = Pick<
  Connection,
  "getBalance" | "getParsedTokenAccountsByOwner" | "getSignaturesForAddress" | "getParsedTransactions" | "getParsedTransaction"
>;

/** Progress of the transaction download. */
export type FetchProgress = {
  /** Signatures processed so far (fetched or skipped). */
  fetched: number;
  /** Signatures that will be processed in total. */
  total: number;
  /**
   * Of `fetched`, how many were skipped: the transaction could not be fetched
   * or decoded after retries, or the RPC returned nothing for it. Failed
   * transactions are not counted; they are read and left out by design.
   */
  skipped: number;
};

/** Options for {@link fetchParsedTransactions}. */
export type FetchOptions = {
  /** Most recent signatures to look at. Default {@link DEFAULT_LIMIT}, clamped to {@link MAX_LIMIT}. */
  limit?: number;
  /**
   * Called after each batch of transactions, or after each transaction once
   * the scan has fallen back to single requests. Nothing is written anywhere else.
   */
  onProgress?: (progress: FetchProgress) => void;
  /** Stops the scan between requests; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
};

/** Options for {@link scanAddress}. */
export type ScanOptions = FetchOptions & {
  /** Known addresses. Default none. */
  labels?: Labels;
};

/** A report together with the flows it was derived from. */
export type ScanResult = {
  report: LeakReport;
  /** Keep these to run {@link assessOutgoingTransfer} later without re-scanning. */
  flows: Flow[];
  /**
   * Signatures the scan had to leave out because the RPC would not return the
   * transaction (see {@link FetchProgress.skipped}). The report covers
   * `report.scannedTransactions`; when this is not 0 it is incomplete.
   */
  skipped: number;
};

/** SOL balance and token account count of a wallet. */
export type Balances = {
  /** Balance in SOL. */
  solBalance: number;
  /** Token accounts owned, legacy SPL Token and Token-2022 together. */
  tokenAccountCount: number;
};

function toPublicKey(address: PublicKey | string): PublicKey {
  return typeof address === "string" ? new PublicKey(address) : address;
}

function normaliseLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 0) throw new RangeError(`limit must be a number from 0 to ${MAX_LIMIT}`);
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * True when an error thrown by the connection says the endpoint is limiting
 * requests. `@solana/web3.js` reports an HTTP error as
 * `"<status> <status text>: <body>"`; other connections may set a numeric
 * `status`. Only the start of the message is looked at: the rest is the
 * endpoint's text and can be as long as it likes.
 */
function isRateLimited(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const error = e as { message?: unknown; status?: unknown; statusCode?: unknown };
  if (error.status === 429 || error.statusCode === 429) return true;
  const head = typeof error.message === "string" ? error.message.slice(0, 200) : "";
  return /^429(?!\d)/.test(head) || /too many requests/i.test(head);
}

/** Names an error has when the platform gave up on a request itself: an abort, a timeout, a failed connection. */
const NO_ANSWER_NAMES = new Set(["AbortError", "TimeoutError", "NetworkError", "FetchError"]);
/** How `fetch` says that no response came back, in Node and in the browsers. Only the start of the message is looked at. */
const NO_ANSWER_MESSAGE = /^(?:TypeError: )?(?:failed to fetch|fetch failed|load failed|networkerror|network error|network request failed)/i;
/** A system error code as Node's HTTP clients set it: `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_SOCKET`. */
const SYSTEM_CODE = /^(?:E[A-Z]|UND_ERR_)[A-Z_]{1,38}$/;

/**
 * True when an error thrown by the connection means that no answer came back
 * at all: the request never left, or the connection failed before a response.
 * `fetch` reports that as "Failed to fetch", "fetch failed", "Load failed" or
 * "NetworkError when attempting to fetch resource."; Node's HTTP clients as an
 * error with a system code; a timeout or an abort as an error of that name.
 *
 * Everything else is taken for an answer: an HTTP status (`@solana/web3.js`
 * writes `"<status> <status text>: <body>"`, other connections may set a
 * numeric `status`), a JSON-RPC error, or a body that was not what was asked
 * for. An error this function does not know is therefore treated as an
 * answer, which costs a batch request less, not more. The `code` of a
 * JSON-RPC error is the endpoint's own and is not read.
 */
function gotNoAnswer(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const error = e as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof error.status === "number" || typeof error.statusCode === "number") return false;
  const name = typeof error.name === "string" ? error.name : "";
  if (name === "SolanaJSONRPCError") return false;
  if (NO_ANSWER_NAMES.has(name)) return true;
  if (typeof error.code === "string" && SYSTEM_CODE.test(error.code)) return true;
  const head = typeof error.message === "string" ? error.message.slice(0, 200) : "";
  return NO_ANSWER_MESSAGE.test(head);
}

/**
 * How far apart requests are kept once the endpoint has said it is limiting
 * them. 0 until then. Doubles with each refusal up to the bound, and comes
 * back down, a step at a time, after a run of requests that went through.
 */
class Pace {
  spacingMs = 0;
  private streak = 0;

  refused(): void {
    this.spacingMs = this.spacingMs === 0 ? RATE_LIMIT_SPACING_START_MS : Math.min(this.spacingMs * 2, RATE_LIMIT_SPACING_MAX_MS);
    this.streak = 0;
  }

  answered(): void {
    if (this.spacingMs === 0) return;
    this.streak += 1;
    if (this.streak < RATE_LIMIT_RECOVER_AFTER) return;
    this.streak = 0;
    this.spacingMs = this.spacingMs > RATE_LIMIT_SPACING_START_MS ? this.spacingMs / 2 : 0;
  }
}

/**
 * Downloads the wallet's most recent successful transactions in `jsonParsed`
 * form.
 *
 * Signatures are paged newest first up to `limit`, then fetched in batches of
 * 20. An RPC that will not serve a batch is handled by falling back to one
 * request per transaction; once that works the scan stops batching
 * altogether. A transaction that still cannot be fetched or decoded is
 * skipped rather than failing the scan, and counted in `onProgress`'s
 * `skipped`. Failed transactions are dropped. Every request asks for
 * `maxSupportedTransactionVersion: 1`.
 *
 * A batch the endpoint answered and did not serve (HTTP 400, 403, 429 or 5xx,
 * a JSON-RPC error, a body that is not a list) is sent once more at most, and
 * if that is refused too no batch is sent again in the scan: an endpoint that
 * refuses a batch refuses the same batch again, and every call inside it can
 * count against the endpoint's limit. Only a batch that got no answer at all
 * (the network failed) keeps the longer retry: four attempts, 0.5 s, 1 s and
 * 2 s apart.
 *
 * An endpoint that limits requests is asked more slowly. After an HTTP 429
 * requests are spaced out (0.3 s, doubling with each further 429 up to 1.2 s,
 * and easing off again after 20 requests in a row that went through). A
 * single request that fails is asked again up to three times, 0.5 s, 1 s and
 * 2 s apart (or the spacing, if that is longer), before the transaction is
 * skipped.
 *
 * Nothing the endpoint returns makes the scan larger than it was asked to be:
 * signatures beyond `limit`, repeated signatures and results beyond the batch
 * that was asked for are not read.
 *
 * Privacy: the RPC behind `connection` learns which address is being scanned.
 * Nothing is sent anywhere else and nothing is logged; progress is reported
 * only through `onProgress`.
 */
export async function fetchParsedTransactions(
  connection: Pick<ScannerConnection, "getSignaturesForAddress" | "getParsedTransactions" | "getParsedTransaction">,
  owner: PublicKey | string,
  options: FetchOptions = {},
): Promise<ParsedTransactionWithMeta[]> {
  return (await download(connection, owner, options)).transactions;
}

/** {@link fetchParsedTransactions}, plus how many signatures had to be skipped. */
async function download(
  connection: Pick<ScannerConnection, "getSignaturesForAddress" | "getParsedTransactions" | "getParsedTransaction">,
  owner: PublicKey | string,
  options: FetchOptions,
): Promise<{ transactions: ParsedTransactionWithMeta[]; skipped: number }> {
  const { onProgress, signal } = options;
  const limit = normaliseLimit(options.limit);
  const ownerKey = toPublicKey(owner);

  const sigs: string[] = [];
  const known = new Set<string>();
  let before: string | undefined;
  while (sigs.length < limit) {
    signal?.throwIfAborted();
    const asked = Math.min(1000, limit - sigs.length);
    const page = await connection.getSignaturesForAddress(ownerKey, { before, limit: asked });
    if (!Array.isArray(page)) break;
    // The endpoint was asked for `asked` signatures. Whatever it sent beyond that is not read,
    // and neither is anything that is not a signature or that it has already sent.
    const count = Math.min(page.length, asked);
    let last: string | undefined;
    let added = 0;
    for (let k = 0; k < count; k++) {
      const signature: unknown = (page[k] as { signature?: unknown } | null | undefined)?.signature;
      if (typeof signature !== "string" || signature === "" || signature.length > MAX_SIGNATURE_LENGTH) continue;
      last = signature;
      if (known.has(signature)) continue;
      known.add(signature);
      sigs.push(signature);
      added += 1;
    }
    // Nothing new: the history has run out, or the endpoint is going round in circles.
    if (added === 0 || last === undefined) break;
    before = last;
  }

  const transactions: ParsedTransactionWithMeta[] = [];
  let skipped = 0;
  let fetched = 0;
  // Until a batch is refused, or fails and single requests are seen to work.
  let batching = true;
  const pace = new Pace();

  const keep = (t: ParsedTransactionWithMeta | null | undefined) => {
    if (!t) skipped++;
    else if (!t.meta?.err) transactions.push(t);
  };
  const report = () => onProgress?.({ fetched, total: sigs.length, skipped });

  /**
   * One batch: its transactions, or undefined when it could not be fetched as
   * a batch. A batch that got no answer gets four attempts. Once the endpoint
   * has answered and not served it, whatever the answer, it gets one more
   * attempt, and if that fails too no batch is sent after it.
   */
  const fetchBatch = async (batch: string[]): Promise<(ParsedTransactionWithMeta | null)[] | undefined> => {
    let attempts = RETRY_ATTEMPTS;
    let refused = false;
    for (let i = 0; ; i++) {
      signal?.throwIfAborted();
      try {
        const res = await connection.getParsedTransactions(batch, TRANSACTION_CONFIG);
        if (!Array.isArray(res)) throw new TypeError("the batch was not answered with a list");
        pace.answered();
        return res;
      } catch (e) {
        if (isRateLimited(e)) pace.refused();
        if (!refused && !gotNoAnswer(e)) {
          // The endpoint answered and would not serve the batch. It will answer the same batch the
          // same way, and every call in it may count against its limit: one more attempt, not three.
          refused = true;
          attempts = Math.min(attempts, i + 2);
        }
        if (i >= attempts - 1) {
          signal?.throwIfAborted();
          // Refused, and not accepted when sent again: this endpoint is not asked for a batch again.
          if (refused) batching = false;
          return undefined;
        }
        await sleep(Math.max(RETRY_BASE_MS * 2 ** i, pace.spacingMs), signal);
      }
    }
  };

  /** One transaction by itself, asked up to four times. `worked` is false when every attempt failed: the transaction is skipped. */
  const fetchSingle = async (signature: string): Promise<{ worked: boolean; value: ParsedTransactionWithMeta | null }> => {
    for (let i = 0; ; i++) {
      signal?.throwIfAborted();
      try {
        const value = await connection.getParsedTransaction(signature, TRANSACTION_CONFIG);
        pace.answered();
        return { worked: true, value };
      } catch (e) {
        if (isRateLimited(e)) pace.refused();
        if (i >= RETRY_ATTEMPTS - 1) {
          if (signal?.aborted) throw e;
          // Skip transactions this client cannot fetch or decode rather than aborting the scan.
          return { worked: false, value: null };
        }
        await sleep(Math.max(RETRY_BASE_MS * 2 ** i, pace.spacingMs), signal);
      }
    }
  };

  for (let i = 0; i < sigs.length; i += BATCH_SIZE) {
    const batch = sigs.slice(i, i + BATCH_SIZE);

    // Some public RPCs reject batch calls; fall back to one at a time.
    const res = batching ? await fetchBatch(batch) : undefined;

    if (res) {
      // One result for each signature asked for, and no more, whatever came back.
      for (let k = 0; k < batch.length; k++) keep(res[k]);
      fetched = Math.min(i + BATCH_SIZE, sigs.length);
      report();
      // Be gentle with public RPCs.
      if (fetched < sigs.length) await sleep(Math.max(BATCH_PAUSE_MS, pace.spacingMs), signal);
      continue;
    }

    let singlesWork = false;
    for (const s of batch) {
      const { worked, value } = await fetchSingle(s);
      if (worked) singlesWork = true;
      keep(value);
      fetched++;
      report();
      await sleep(Math.max(SINGLE_PAUSE_MS, pace.spacingMs), signal);
    }
    // The RPC answers single requests but not batches: do not try another batch in this scan.
    if (singlesWork) batching = false;
  }
  return { transactions, skipped };
}

/**
 * Reads the wallet's SOL balance and counts its token accounts under both the
 * legacy SPL Token program and Token-2022.
 */
export async function fetchBalances(
  connection: Pick<ScannerConnection, "getBalance" | "getParsedTokenAccountsByOwner">,
  owner: PublicKey | string,
): Promise<Balances> {
  const ownerKey = toPublicKey(owner);
  const [lamports, legacy, token2022] = await Promise.all([
    connection.getBalance(ownerKey),
    connection.getParsedTokenAccountsByOwner(ownerKey, { programId: new PublicKey(TOKEN_PROGRAM_ID) }),
    connection.getParsedTokenAccountsByOwner(ownerKey, { programId: new PublicKey(TOKEN_2022_PROGRAM_ID) }),
  ]);
  return {
    solBalance: lamports / LAMPORTS_PER_SOL,
    tokenAccountCount: legacy.value.length + token2022.value.length,
  };
}

/**
 * Scans a wallet and returns the report plus the flows behind it. Use this
 * instead of {@link scanAddress} when the flows are needed afterwards, for
 * example to chart activity or to feed {@link assessOutgoingTransfer}.
 *
 * A scan does not fail because single transactions could not be read: they
 * are left out and counted in `skipped`, so check it before trusting a score.
 * A scan that ran into one of the scanner's own bounds on what it will read
 * from an endpoint says so in `report.limitsHit`, which is otherwise absent.
 *
 * @throws If `address` is not a valid base58 public key or `limit` is not a
 *   number from 0 up, if the RPC fails on the balance or signature requests,
 *   or with the signal's reason on abort.
 */
export async function scanAddressDetailed(
  connection: ScannerConnection,
  address: PublicKey | string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  // Reject bad input before the RPC learns anything.
  const owner = toPublicKey(address);
  const me = owner.toBase58();
  normaliseLimit(options.limit);
  options.signal?.throwIfAborted();
  const balances = await fetchBalances(connection, owner);
  const { transactions: txs, skipped } = await download(connection, owner, options);
  const { flows, limitsHit } = extractFlowsDetailed(txs, me);
  const report = buildReport({
    address: me,
    scannedTransactions: txs.length,
    flows,
    solBalance: balances.solBalance,
    tokenAccountCount: balances.tokenAccountCount,
    labels: options.labels,
    limitsHit,
  });
  return { report, flows, skipped };
}

/**
 * The whole scan in one call: balances, recent transactions, flows, findings
 * and score.
 *
 * Privacy: the RPC behind `connection` learns which address was scanned. Use
 * your own node or a no-log RPC. Nothing is sent anywhere else.
 *
 * @throws See {@link scanAddressDetailed}.
 */
export async function scanAddress(
  connection: ScannerConnection,
  address: PublicKey | string,
  options: ScanOptions = {},
): Promise<LeakReport> {
  return (await scanAddressDetailed(connection, address, options)).report;
}
