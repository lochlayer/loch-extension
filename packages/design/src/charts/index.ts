/**
 * @loch/design/charts: the three figures of the leak report as accessible
 * inline SVG, and the statement of account that is their text equivalent.
 *
 * Plain data in, strings out. No DOM, no dependencies, no network. The same
 * functions run on the website, in the extension and in Node.
 *
 *   import { steppedBedSvg, statementHtml, byHourSvg, counterpartiesSvg } from "@loch/design/charts";
 *
 *   figure.innerHTML = steppedBedSvg(report, { width: figure.clientWidth });
 *   list.innerHTML = statementHtml(report);
 *
 * The SVG is lettered and inked by @loch/design/components.css (class `lc`),
 * so it follows the palette. Draw at the container's width.
 */
export type { FindingLike, FlowLike, LabelsLike, LeakReportLike, Severity } from "./types.js";
export { statementHtml, statementLines, statementText } from "./statement.js";
export type { StatementHtmlOptions, StatementLine } from "./statement.js";
export { FINDING_SHORT_LABELS, steppedBedSvg, steppedBedText } from "./stepped-bed.js";
export type { SteppedBedOptions } from "./stepped-bed.js";
export { byHourSvg, byHourText, hourCounts, quietWindow } from "./by-hour.js";
export type { ByHourOptions, QuietWindow } from "./by-hour.js";
export { counterpartiesSvg, counterpartiesText, counterpartyList } from "./counterparties.js";
export type { CounterpartiesOptions, Counterparty } from "./counterparties.js";
export { FIT_WIDTHS, fitHtml } from "./fit.js";
export type { FitOptions } from "./fit.js";
export { LIMITS } from "./shared.js";
