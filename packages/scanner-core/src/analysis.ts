/**
 * The pure half of the scanner: types and analysis only. This entry point has
 * no runtime imports at all, so it can be loaded where pulling in
 * `@solana/web3.js` is unwanted (content scripts, light pages).
 *
 *   import { analyse, assessOutgoingTransfer } from "@loch/scanner-core/analysis";
 */
export type {
  Finding,
  FindingId,
  Flow,
  Labels,
  LeakReport,
  ParsedInstructionLike,
  ParsedTransactionLike,
  ScanLimitsHit,
  Severity,
} from "./types.js";
export { MAX_FLOWS, MAX_INSTRUCTIONS_PER_TRANSACTION, MAX_TOKEN_BALANCES_PER_TRANSACTION, extractFlows, extractFlowsDetailed } from "./flows.js";
export type { ExtractedFlows } from "./flows.js";
export {
  AMOUNT_EPSILON,
  PASS_THROUGH_WINDOW_SECONDS,
  RECURRING_THRESHOLD,
  analyse,
  buildReport,
  scoreReport,
  sortFindings,
} from "./analyse.js";
export type { AnalyseContext, BuildReportInput } from "./analyse.js";
export { assessOutgoingTransfer } from "./preflight.js";
export type { AssessOutgoingTransferInput, OutgoingTransfer } from "./preflight.js";
export { shortAddress } from "./format.js";
