import { MINUS } from "../numerals.js";
import { LIMITS, esc, n, never, readReport, short, text } from "./shared.js";
import type { FindingLike, LeakReportLike } from "./types.js";

/** One line of the score read as a statement of account. */
export type StatementLine = {
  kind: "open" | "finding" | "total";
  title: string;
  detail?: string;
  severity?: FindingLike["severity"];
  /** Points this line takes away. 0 for the opening and total lines. */
  less: number;
  /** What is left after this line. */
  balance: number;
  /** Depth actually lost, after clamping at zero: equals `less` unless the score ran out. */
  lost: number;
  /** The finding's id, on a line that stands for one finding. */
  id?: string;
  /** How many findings the line stands for, on the one line that sums the rest of a very long report. */
  merged?: number;
};

const SEVERITY_WORD = { high: "High", medium: "Medium", low: "Low" } as const;

/**
 * The score as arithmetic: 100, less each finding, leaves the score. The same
 * numbers the stepped bed draws. Clamps at zero exactly as the scanner's
 * `scoreReport` does.
 *
 * The report is read defensively. A penalty is a finite number from 0 to 100
 * (anything else counts as 0), every string is plain text of a bounded
 * length, and a report with more than twelve findings has the first eleven
 * written out and the rest summed in one line, so the arithmetic still ends
 * at the score.
 */
export function statementLines(report: LeakReportLike): StatementLine[] {
  return never(
    () => readLines(report),
    () => [
      { kind: "open", title: "A wallet with no leaks", less: 0, balance: 100, lost: 0 },
      { kind: "total", title: "Privacy score", less: 0, balance: 100, lost: 0 },
    ],
  );
}

function readLines(report: unknown): StatementLine[] {
  const { findings } = readReport(report);
  const lines: StatementLine[] = [{ kind: "open", title: "A wallet with no leaks", less: 0, balance: 100, lost: 0 }];
  const listed = findings.length > LIMITS.findings ? LIMITS.findings - 1 : findings.length;
  let balance = 100;
  for (let i = 0; i < listed; i++) {
    const finding = findings[i]!;
    const next = Math.max(0, balance - finding.penalty);
    const line: StatementLine = { kind: "finding", title: finding.title, detail: finding.detail, less: finding.penalty, balance: next, lost: balance - next, id: finding.id };
    if (finding.severity) line.severity = finding.severity;
    lines.push(line);
    balance = next;
  }
  if (listed < findings.length) {
    // Summed, and held to what a hundred-point score can lose, so no count of findings can write a long number.
    let less = 0;
    for (let i = listed; i < findings.length && less < 100; i++) less = Math.min(100, less + findings[i]!.penalty);
    const next = Math.max(0, balance - less);
    const merged = findings.length - listed;
    lines.push({ kind: "finding", title: `${merged} more findings`, detail: "Too many to write out one by one. Their penalties are summed here.", less, balance: next, lost: balance - next, merged });
    balance = next;
  }
  lines.push({ kind: "total", title: "Privacy score", less: 0, balance, lost: 0 });
  return lines;
}

/**
 * The statement as one paragraph of plain text: the text alternative of the
 * stepped bed, used for its <desc> and wherever a sentence is needed. Plain
 * text, not markup: escape it where it goes into a page.
 */
export function statementText(report: LeakReportLike): string {
  return never(
    () => {
      const lines = statementLines(report);
      const total = lines[lines.length - 1]!;
      const parts = [`Privacy score ${n(total.balance)} of 100 for ${short(readReport(report).address)}.`, "A wallet with no leaks starts at 100."];
      for (const line of lines) {
        if (line.kind !== "finding") continue;
        parts.push(`${line.title}: less ${n(line.less)}, leaves ${n(line.balance)}.`);
      }
      if (lines.length === 2) parts.push("Nothing was found.");
      return parts.join(" ");
    },
    () => "The privacy score could not be read.",
  );
}

export type StatementHtmlOptions = {
  /** Show each finding's severity tag. Default true. */
  severity?: boolean;
  /** Show each finding's detail sentence. Default true. */
  detail?: boolean;
  /** Text under the total, e.g. what helps. */
  totalNote?: string;
};

/**
 * The statement as markup: `<ol class="statement">`, one row per line, styled
 * by components.css. Put it inside an element with class `statement-wrap` (or
 * inside `.report`) so it can widen to three columns.
 *
 * Every word from the report is escaped, a severity that is not one of the
 * three is not written at all, and the list never has more than fourteen rows.
 */
export function statementHtml(report: LeakReportLike, options: StatementHtmlOptions = {}): string {
  return never(
    () => {
      const severity = options?.severity !== false;
      const detail = options?.detail !== false;
      const totalNote = text(options?.totalNote, LIMITS.note);
      const rows = statementLines(report).map((line) => {
        if (line.kind === "open") {
          return (
            `<li class="statement__row statement__row--open">` +
            `<span class="statement__what"><strong>${esc(line.title)}</strong><span>Every scan starts here and loses depth for each thing the public history gives away.</span></span>` +
            `<span class="statement__fig fig">100</span></li>`
          );
        }
        if (line.kind === "total") {
          return (
            `<li class="statement__row statement__row--total">` +
            `<span class="statement__what"><strong>${esc(line.title)}</strong>${totalNote ? `<span>${esc(totalNote)}</span>` : ""}</span>` +
            `<span class="statement__fig">${n(line.balance)}<small>of 100</small></span></li>`
          );
        }
        // The severity is one of three known words by now, never the report's own string.
        const tag = severity && line.severity ? `<span class="sev" data-sev="${line.severity}">${SEVERITY_WORD[line.severity]}</span>` : "";
        return (
          `<li class="statement__row">${tag}` +
          `<span class="statement__what"><strong>${esc(line.title)}</strong>${detail && line.detail ? `<span>${esc(line.detail)}</span>` : ""}</span>` +
          `<span class="statement__fig statement__fig--less fig"><span class="fig-sign">${MINUS}</span>${n(line.less)}</span></li>`
        );
      });
      return `<ol class="statement">${rows.join("")}</ol>`;
    },
    () => `<ol class="statement"></ol>`,
  );
}
