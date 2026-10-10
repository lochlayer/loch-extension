/**
 * The shapes the chart helpers read. They are structural copies of the
 * scanner's types (packages/scanner-core/src/types.ts), kept here so this
 * package has no dependencies: a `LeakReport` and a `Flow[]` from
 * @loch/scanner-core are assignable as they are.
 */

export type Severity = "high" | "medium" | "low";

export type FindingLike = {
  /** Stable identifier, e.g. "funding-source". Unknown ids are drawn too. */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Points taken off the 100-point score. */
  penalty: number;
};

export type LeakReportLike = {
  address: string;
  scannedTransactions?: number;
  transfers?: number;
  /** 0 to 100. `max(0, 100 - sum of penalties)`. */
  score: number;
  /** In the order they should be read: the scanner sorts most severe first. */
  findings: readonly FindingLike[];
};

export type FlowLike = {
  /** Block time in unix seconds. 0 when unknown. */
  time: number;
  dir: "in" | "out";
  counterparty: string;
  amount?: number;
  asset?: string;
};

/** Address to name. */
export type LabelsLike = Record<string, string>;
