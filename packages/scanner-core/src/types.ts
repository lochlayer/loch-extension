/** How serious a finding is. */
export type Severity = "high" | "medium" | "low";

/** One transfer into or out of the scanned wallet. */
export type Flow = {
  /** Signature of the transaction that carried the transfer. */
  sig: string;
  /** Block time in unix seconds. 0 when the RPC did not report one. */
  time: number;
  /** "in" when the wallet received, "out" when it sent. */
  dir: "in" | "out";
  /**
   * The other side. A wallet for SOL. For tokens: the destination token
   * account on outgoing transfers, the sending authority on incoming ones.
   */
  counterparty: string;
  /** SOL for SOL. For tokens the UI amount when the instruction carries one, otherwise raw base units. */
  amount: number;
  /** "SOL", a mint address, or "SPL" when the instruction does not name the mint. */
  asset: string;
};

/** Stable identifier for each kind of finding, safe to key UI on. */
export type FindingId =
  // Produced by analyse()
  | "funding-source"
  | "identified-services"
  | "recurring-counterparties"
  | "time-zone"
  | "pass-through"
  | "balance-visible"
  // Produced by assessOutgoingTransfer()
  | "recipient-identified"
  | "amount-pass-through"
  | "new-counterparty"
  | "recurring-counterparty";

/** One thing the wallet's public history gives away. */
export type Finding = {
  id: FindingId;
  severity: Severity;
  /** Short headline. */
  title: string;
  /** One or two plain sentences with the specifics. */
  detail: string;
  /** Points taken off the 100-point privacy score. */
  penalty: number;
};

/** Address to human-readable name, e.g. `{ "<address>": "Exchange deposit (name)" }`. Bring your own source. */
export type Labels = Record<string, string>;

/**
 * Which of the scanner's own bounds a scan ran into. The sizes of what an RPC
 * endpoint returns are the endpoint's to choose, so the scanner reads only so
 * much of it (see `MAX_INSTRUCTIONS_PER_TRANSACTION`, `MAX_FLOWS`). When a
 * bound was hit the report covers less than the endpoint sent, and says so
 * here.
 */
export type ScanLimitsHit = {
  /**
   * Transactions that were not read in full: one had more instructions than
   * `MAX_INSTRUCTIONS_PER_TRANSACTION`, or more token balances than
   * `MAX_TOKEN_BALANCES_PER_TRANSACTION`. Only the first of each were read.
   */
  transactionsCut: number;
  /** True when `MAX_FLOWS` transfers had been found: the transactions after that point were not read. */
  flowsCapped: boolean;
};

/** Result of a scan. Plain JSON-serialisable data. */
export type LeakReport = {
  /** The scanned wallet, base58. */
  address: string;
  /** Successful transactions that were fetched and inspected. */
  scannedTransactions: number;
  /** Transfers found in those transactions (the number of flows). */
  transfers: number;
  /** Privacy score, 0 (everything leaks) to 100 (nothing found). */
  score: number;
  /** Findings, most severe first. */
  findings: Finding[];
  /**
   * Present only when the scan ran into one of the scanner's bounds, which no
   * real wallet's history does: the report is then incomplete. Absent
   * otherwise, so an ordinary report has exactly the five members above.
   */
  limitsHit?: ScanLimitsHit;
};

/**
 * The parts of a `jsonParsed` instruction the scanner reads. Both a
 * `@solana/web3.js` parsed instruction and the raw RPC JSON fit this shape.
 */
export type ParsedInstructionLike = {
  /** Program name as the RPC reports it ("system", "spl-token", ...). Absent when the RPC could not decode the instruction. */
  program?: string;
  /** Decoded instruction, normally `{ type, info }`. Absent when the RPC could not decode the instruction. */
  parsed?: unknown;
  /** Not read; listed so undecoded instructions are assignable. */
  programId?: unknown;
};

/**
 * The parts of a `jsonParsed` transaction the scanner reads. Both
 * `ParsedTransactionWithMeta` from `@solana/web3.js` and the raw result of a
 * `getTransaction` call with `encoding: "jsonParsed"` fit this shape.
 */
export type ParsedTransactionLike = {
  blockTime?: number | null;
  transaction: {
    signatures: readonly string[];
    message: { instructions: readonly ParsedInstructionLike[] };
  };
  meta?: {
    err?: unknown;
    innerInstructions?: readonly { instructions: readonly ParsedInstructionLike[] }[] | null;
    postTokenBalances?: readonly { owner?: string }[] | null;
  } | null;
};
