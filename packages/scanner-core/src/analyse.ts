import { clockHour, countOf, displaySol, labelFor, shortAddress } from "./format.js";
import type { Finding, Flow, Labels, LeakReport, ScanLimitsHit, Severity } from "./types.js";

/** A counterparty seen this many times or more counts as recurring. */
export const RECURRING_THRESHOLD = 3;
/** An outgoing amount that matches an incoming one within this many seconds is a pass-through. */
export const PASS_THROUGH_WINDOW_SECONDS = 600;
/** Two amounts closer than this are treated as the same amount. */
export const AMOUNT_EPSILON = 1e-9;

/** What `analyse` needs to know besides the flows. Everything is optional. */
export type AnalyseContext = {
  /** Wallet balance in SOL. Default 0. */
  solBalance?: number;
  /** Token accounts the wallet owns, legacy SPL Token and Token-2022 together. Default 0. */
  tokenAccountCount?: number;
  /** Known addresses. Default none. */
  labels?: Labels;
};

/**
 * True when `out` could be the onward leg of `inbound`: same asset, same
 * amount, sent at or after it and less than ten minutes later.
 */
export function isPassThrough(
  inbound: Pick<Flow, "asset" | "amount" | "time">,
  out: Pick<Flow, "asset" | "amount" | "time">,
): boolean {
  const gap = out.time - inbound.time;
  return (
    inbound.asset === out.asset &&
    Math.abs(inbound.amount - out.amount) < AMOUNT_EPSILON &&
    gap >= 0 &&
    gap < PASS_THROUGH_WINDOW_SECONDS
  );
}

/**
 * The outgoing flows that are the onward leg of some incoming one, in the
 * order they appear in `flows`: exactly the flows `o` for which
 * `isPassThrough(i, o)` holds for at least one incoming `i`.
 *
 * Asking that question of every pair takes time proportional to incoming
 * times outgoing, and the number of flows is the RPC endpoint's to choose:
 * 60,000 of each took over half a minute. This answers it in
 * O(n log n) and gives the same answer, comparison for comparison:
 *
 * - Per asset, the incoming flows are sorted by amount. For an outgoing amount
 *   `a` the incoming amounts `x` with `|x - a| < AMOUNT_EPSILON` are one run of
 *   that order, because `x - a`, rounded as the machine rounds it, never
 *   decreases as `x` grows. Taking the outgoing flows in order of amount too,
 *   both ends of the run only ever move forward.
 * - Among the flows in the run, one arrived `0 <= gap < 600` seconds before
 *   the outgoing flow exactly when one has its time in a certain run of the
 *   sorted times, for the same reason. A Fenwick tree over the distinct times
 *   counts the flows currently in the amount run by time, so that question is
 *   two binary searches and two prefix sums.
 *
 * The comparisons are the ones `isPassThrough` makes, on the same values, so
 * NaN and infinite amounts and times fall out the same way.
 */
export function passThroughOutflows<T extends Pick<Flow, "dir" | "asset" | "amount" | "time">>(flows: readonly T[]): T[] {
  // Amounts and times as numbers, as the subtractions in isPassThrough would make them.
  const amount = new Float64Array(flows.length);
  const time = new Float64Array(flows.length);
  // Flow index of every incoming and outgoing flow, per asset.
  const byAsset = new Map<unknown, { ins: number[]; outs: number[] }>();
  for (let index = 0; index < flows.length; index++) {
    const flow = flows[index]!;
    const incoming = flow.dir === "in";
    if (!incoming && flow.dir !== "out") continue;
    // `asset === asset` fails only for NaN, which equals nothing, itself included.
    if (flow.asset !== flow.asset) continue;
    amount[index] = flow.amount;
    time[index] = flow.time;
    // NaN is within epsilon of nothing and no number of seconds from anything: such a flow matches nothing.
    if (amount[index] !== amount[index] || time[index] !== time[index]) continue;
    let group = byAsset.get(flow.asset);
    if (!group) byAsset.set(flow.asset, (group = { ins: [], outs: [] }));
    (incoming ? group.ins : group.outs).push(index);
  }

  const matched = new Uint8Array(flows.length);
  const ascending = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

  for (const { ins, outs } of byAsset.values()) {
    if (ins.length === 0 || outs.length === 0) continue;
    const inbound = ins.sort((a, b) => ascending(amount[a]!, amount[b]!));
    const outbound = outs.sort((a, b) => ascending(amount[a]!, amount[b]!));

    // The distinct times of the incoming flows, sorted, and each incoming flow's place among them.
    const times = Float64Array.from(inbound, (index) => time[index]!).sort();
    let distinct = 0;
    for (let k = 0; k < times.length; k++) {
      if (k === 0 || times[k] !== times[distinct - 1]) times[distinct++] = times[k]!;
    }
    /** First place in `times[0..distinct)` for which `after` holds; `after` is false, then true. */
    const firstWhere = (after: (t: number) => boolean): number => {
      let lo = 0;
      let hi = distinct;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (after(times[mid]!)) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const place = new Map<number, number>();
    for (let k = 0; k < distinct; k++) place.set(times[k]!, k);

    // Fenwick tree: how many flows of the current amount run sit at each time.
    const tree = new Int32Array(distinct + 1);
    const add = (at: number, by: number) => {
      for (let k = at + 1; k <= distinct; k += k & -k) tree[k] = tree[k]! + by;
    };
    /** Flows at places 0 to `upTo - 1`. */
    const countBelow = (upTo: number) => {
      let sum = 0;
      for (let k = upTo; k > 0; k -= k & -k) sum += tree[k]!;
      return sum;
    };

    let from = 0; // inbound[from..to) is the run of amounts within epsilon of the current outgoing amount
    let to = 0;
    for (const out of outbound) {
      const a = amount[out]!;
      // Math.abs(x - a) < AMOUNT_EPSILON is  -AMOUNT_EPSILON < x - a  and  x - a < AMOUNT_EPSILON.
      while (to < inbound.length && amount[inbound[to]!]! - a < AMOUNT_EPSILON) add(place.get(time[inbound[to++]!]!)!, 1);
      while (from < to && !(amount[inbound[from]!]! - a > -AMOUNT_EPSILON)) add(place.get(time[inbound[from++]!]!)!, -1);
      if (from === to) continue;

      // gap = out.time - t must be >= 0 and < PASS_THROUGH_WINDOW_SECONDS. Both fail, then hold, or hold, then fail, as t grows.
      const at = time[out]!;
      const first = firstWhere((t) => at - t < PASS_THROUGH_WINDOW_SECONDS);
      const end = firstWhere((t) => !(at - t >= 0));
      if (first < end && countBelow(end) - countBelow(first) > 0) matched[out] = 1;
    }
  }

  const result: T[] = [];
  for (let index = 0; index < flows.length; index++) if (matched[index] === 1) result.push(flows[index]!);
  return result;
}

/**
 * Runs every leak check over a wallet's flows and returns what it found, in
 * check order. Pure: no network, no clock, inputs are not modified.
 *
 * Checks: funding source, identified (labelled) services, recurring
 * counterparties, guessable time zone, exact-amount pass-through, visible
 * balance.
 */
export function analyse(flows: readonly Flow[], context: AnalyseContext = {}): Finding[] {
  const { solBalance = 0, tokenAccountCount = 0, labels = {} } = context;
  const f: Finding[] = [];

  // 1. Funding source: the first inbound transfer links this wallet to another.
  const firstIn = flows.filter((x) => x.dir === "in").sort((a, b) => a.time - b.time)[0];
  if (firstIn) {
    const label = labelFor(labels, firstIn.counterparty);
    f.push({
      id: "funding-source",
      severity: label ? "high" : "medium",
      title: "Funding source is public",
      detail: `First funds came from ${shortAddress(firstIn.counterparty)}${label ? ` (${label})` : ""}. Anyone can follow this link back.`,
      penalty: label ? 20 : 10,
    });
  }

  // 2. Labelled counterparties (e.g. exchange deposit addresses tie the wallet to a KYC identity).
  const labelled = new Map<string, number>();
  for (const x of flows) {
    if (labelFor(labels, x.counterparty)) labelled.set(x.counterparty, (labelled.get(x.counterparty) ?? 0) + 1);
  }
  if (labelled.size > 0) {
    f.push({
      id: "identified-services",
      severity: "high",
      title: "Linked to identified services",
      detail:
        `This wallet has ${listOf([...labelled].map(([a, n], i) => `${i === 0 ? countOf(n, "transfer") : n} with ${labelFor(labels, a)}`))}. ` +
        `${labelled.size === 1 ? "This service" : "These services"} can tie it to your identity.`,
      penalty: Math.min(25, 10 * labelled.size),
    });
  }

  // 3. Repeated counterparties form a visible social/payment graph.
  const counts = new Map<string, number>();
  for (const x of flows) counts.set(x.counterparty, (counts.get(x.counterparty) ?? 0) + 1);
  const frequent = [...counts].filter(([, n]) => n >= RECURRING_THRESHOLD).sort((a, b) => b[1] - a[1]);
  if (frequent.length > 0) {
    f.push({
      id: "recurring-counterparties",
      severity: frequent.length >= 5 ? "high" : "medium",
      title: "Recurring counterparties",
      detail: `${countOf(frequent.length, "address", "addresses")} ${frequent.length === 1 ? "interacts" : "interact"} with you ${RECURRING_THRESHOLD} or more times (${
        frequent.length > 3 ? "top: " : ""
      }${frequent
        .slice(0, 3)
        .map(([a, n]) => `${shortAddress(a)} ×${n}`)
        .join(", ")}). Regular payments reveal employers, clients or friends.`,
      penalty: Math.min(20, 4 * frequent.length),
    });
  }

  // 4. Activity hours reveal a time zone (and when you sleep).
  const hours = new Array<number>(24).fill(0);
  for (const x of flows) {
    if (!x.time) continue;
    const h = new Date(x.time * 1000).getUTCHours();
    hours[h] = (hours[h] ?? 0) + 1;
  }
  const total = hours.reduce((a, b) => a + b, 0);
  if (total >= 20) {
    let quietStart = 0;
    let quietSum = Infinity;
    for (let h = 0; h < 24; h++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += hours[(h + k) % 24] ?? 0;
      if (s < quietSum) {
        quietSum = s;
        quietStart = h;
      }
    }
    if (quietSum / total < 0.05) {
      f.push({
        id: "time-zone",
        severity: "medium",
        title: "Your time zone is guessable",
        detail: `Almost no activity between ${clockHour(quietStart)} and ${clockHour((quietStart + 6) % 24)} UTC. That is likely your sleep window.`,
        penalty: 10,
      });
    }
  }

  // 5. Pass-through: same amount in then out within 10 minutes links both sides.
  const passThrough = passThroughOutflows(flows);
  if (passThrough.length > 0) {
    f.push({
      id: "pass-through",
      severity: "medium",
      title: "Exact amounts passed straight through",
      detail: `${countOf(passThrough.length, "outgoing transfer")} matched an incoming amount within 10 minutes. This links the sender to the final recipient.`,
      penalty: Math.min(15, 5 * passThrough.length),
    });
  }

  // 6. Wealth exposure.
  if (solBalance > 10 || tokenAccountCount > 10) {
    f.push({
      id: "balance-visible",
      severity: solBalance > 100 ? "high" : "low",
      title: "Balance is visible to everyone",
      detail: `${displaySol(solBalance)} SOL and ${countOf(tokenAccountCount, "token account")} are public. Anyone you pay can look.`,
      penalty: solBalance > 100 ? 15 : 5,
    });
  }

  return f;
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Privacy score: 100 minus every finding's penalty, never below 0. */
export function scoreReport(findings: readonly Pick<Finding, "penalty">[]): number {
  return Math.max(0, 100 - findings.reduce((a, x) => a + x.penalty, 0));
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Returns a copy ordered most severe first. Findings of equal severity keep their order. */
export function sortFindings<T extends Pick<Finding, "severity">>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Input for {@link buildReport}. */
export type BuildReportInput = AnalyseContext & {
  /** The scanned wallet, base58. */
  address: string;
  /** How many transactions the flows were extracted from. */
  scannedTransactions: number;
  /** Flows from {@link extractFlows}. */
  flows: readonly Flow[];
  /** From {@link extractFlowsDetailed}, when a bound was hit. Carried into the report as it is. */
  limitsHit?: ScanLimitsHit;
};

/**
 * Analyses the flows, scores the result and packs it into a report with the
 * findings ordered most severe first. Pure.
 *
 * The report has a `limitsHit` member only when `input.limitsHit` is given.
 */
export function buildReport(input: BuildReportInput): LeakReport {
  const findings = sortFindings(analyse(input.flows, input));
  const report: LeakReport = {
    address: input.address,
    scannedTransactions: input.scannedTransactions,
    transfers: input.flows.length,
    score: scoreReport(findings),
    findings,
  };
  if (input.limitsHit) report.limitsHit = { ...input.limitsHit };
  return report;
}
