import { describe, expect, it } from "vitest";
import { buildReport, scoreReport } from "@loch/scanner-core/analysis";
import type { Flow, LeakReport } from "@loch/scanner-core/analysis";
import {
  byHourSvg,
  byHourText,
  counterpartiesSvg,
  counterpartiesText,
  counterpartyList,
  hourCounts,
  quietWindow,
  statementHtml,
  statementLines,
  statementText,
  steppedBedSvg,
  steppedBedText,
} from "../src/charts/index.js";

const ME = "Fh3qJ5iBgbd24itfu7gbvo8XVHLjnNhA6aNEPnnNTz8K";
const EXCHANGE = "5tzFvgZoiXzNoHthSU8f84Fhx6vEKD3mJ5eg4w7yuAi9";
const PAYEE = "9fRkKDnqdWUjjiQF3wfLNfpjDjUQAXxFf3oeFEPV2mVd";
const T0 = 1_785_542_400; // 2026-08-01T00:00:00Z

/** An hour as the scanner and the figures write it: `04:00`. */
const clock = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

let sig = 0;
const flow = (over: Partial<Flow>): Flow => ({ sig: `s${++sig}`, time: T0, dir: "out", counterparty: PAYEE, amount: 1, asset: "SOL", ...over });

/** A wallet active 08:00 to 20:00 UTC only, funded by a labelled exchange, paying one address often. */
function sample(): { flows: Flow[]; report: LeakReport } {
  const flows: Flow[] = [flow({ dir: "in", counterparty: EXCHANGE, amount: 40, time: T0 + 8 * 3600 })];
  for (let i = 0; i < 12; i++) flows.push(flow({ time: T0 + (i + 1) * 86_400 + (8 + i) * 3600 }));
  for (let i = 0; i < 12; i++) flows.push(flow({ counterparty: `Other${String(i).padStart(2, "0")}`.padEnd(44, "x"), time: T0 + (i + 1) * 86_400 + (9 + i) * 3600, amount: 0.1 + i }));
  const report = buildReport({ address: ME, scannedTransactions: flows.length, flows, solBalance: 41.207, tokenAccountCount: 6, labels: { [EXCHANGE]: "Exchange withdrawal" } });
  return { flows, report };
}

describe("statement", () => {
  it("is the scanner's arithmetic: 100, less each finding, leaves the score", () => {
    const { report } = sample();
    const lines = statementLines(report);
    expect(lines[0]).toMatchObject({ kind: "open", balance: 100 });
    const findings = lines.filter((l) => l.kind === "finding");
    expect(findings).toHaveLength(report.findings.length);
    expect(findings.map((l) => l.less)).toEqual(report.findings.map((f) => f.penalty));
    let balance = 100;
    for (const line of findings) {
      balance -= line.less;
      expect(line.balance).toBe(Math.max(0, balance));
    }
    expect(lines[lines.length - 1]).toMatchObject({ kind: "total", balance: report.score });
    expect(lines[lines.length - 1]!.balance).toBe(scoreReport(report.findings));
  });

  it("clamps at zero exactly as scoreReport does", () => {
    const findings = [
      { id: "a", severity: "high", title: "A", detail: "", penalty: 70 },
      { id: "b", severity: "high", title: "B", detail: "", penalty: 50 },
      { id: "c", severity: "low", title: "C", detail: "", penalty: 5 },
    ] as const;
    const lines = statementLines({ address: ME, score: 0, findings });
    expect(lines.map((l) => l.balance)).toEqual([100, 30, 0, 0, 0]);
    expect(lines.map((l) => l.lost)).toEqual([0, 70, 30, 0, 0]);
    expect(lines[lines.length - 1]!.balance).toBe(scoreReport(findings));
  });

  it("reads as plain text", () => {
    const { report } = sample();
    const text = statementText(report);
    expect(text).toContain(`Privacy score ${report.score} of 100 for Fh3q…Tz8K.`);
    expect(text).toContain("Funding source is public: less 20, leaves 80.");
    expect(statementText({ address: ME, score: 100, findings: [] })).toContain("Nothing was found.");
    expect(steppedBedText(report)).toBe(text);
  });

  it("renders as a list with the opening line, each finding and the total", () => {
    const { report } = sample();
    const html = statementHtml(report, { totalNote: "What helps." });
    expect(html.startsWith('<ol class="statement">')).toBe(true);
    expect(html.match(/<li /g)).toHaveLength(report.findings.length + 2);
    expect(html).toContain('<span class="sev" data-sev="high">High</span>');
    expect(html).toContain(`${report.score}<small>of 100</small>`);
    expect(html).toContain("What helps.");
    expect(statementHtml(report, { severity: false, detail: false })).not.toContain('class="sev"');
  });

  it("escapes whatever the report carries", () => {
    const html = statementHtml({ address: ME, score: 90, findings: [{ id: "x", severity: "low", title: "<img onerror=1>", detail: 'a "quote" & more', penalty: 10 }] });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img onerror=1&gt;");
    expect(html).toContain("a &quot;quote&quot; &amp; more");
  });
});

describe("steppedBedSvg", () => {
  it("is a labelled image whose description is the statement", () => {
    const { report } = sample();
    const svg = steppedBedSvg(report, { width: 640, id: "t" });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-labelledby="t-t t-d"');
    expect(svg).toContain(`<title id="t-t">Privacy score ${report.score} of 100, drawn as a stepped bed</title>`);
    expect(svg).toContain(`<desc id="t-d">${statementText(report).replace(/&/g, "&amp;")}</desc>`);
  });

  it("draws one column per finding after the first, each with its sounding and what it cost", () => {
    const { report } = sample();
    const svg = steppedBedSvg(report, { width: 640 });
    expect(svg.match(/class="lc-col"/g)).toHaveLength(report.findings.length + 1);
    const soundings = [...svg.matchAll(/class="lc-sounding"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
    expect(soundings).toEqual(statementLines(report).slice(0, -1).map((l) => l.balance));
    expect(soundings[soundings.length - 1]).toBe(report.score);
    for (const finding of report.findings) expect(svg).toContain(`>−${finding.penalty}</text>`);
  });

  it("has no script, no external reference and no event handler", () => {
    const { report } = sample();
    const svg = steppedBedSvg(report);
    expect(svg).not.toMatch(/<script|href="http|xlink:href| on[a-z]+=/);
  });

  it("carries its drawn width and the order of its columns as attributes, not as inline styles", () => {
    const { report } = sample();
    const svg = steppedBedSvg(report, { width: 568, id: "x", animate: true });
    expect(svg.startsWith('<svg class="lc lc-bed is-sounding" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 568 ')).toBe(true);
    expect(svg).toContain(' width="568" height="268" data-w="568" role="img"');
    const columns = [...svg.matchAll(/<g class="lc-col" data-i="(\d+)">/g)].map((m) => Number(m[1]));
    expect(columns).toEqual(report.findings.map((_, i) => i).concat(report.findings.length));
    expect([...svg.matchAll(/<text class="lc-sounding" data-i="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(columns);
    expect(svg).not.toContain("style=");
    expect(steppedBedSvg(report, { width: 568, id: "x" }).startsWith('<svg class="lc lc-bed" xmlns=')).toBe(true);
  });

  it("is deterministic and keeps ids unique per chart", () => {
    const { report } = sample();
    expect(steppedBedSvg(report, { width: 348 })).toBe(steppedBedSvg(report, { width: 348 }));
    const a = steppedBedSvg(report, { width: 348 });
    const b = steppedBedSvg(report, { width: 700 });
    expect(/id="([^"]+)-t"/.exec(a)![1]).not.toBe(/id="([^"]+)-t"/.exec(b)![1]);
  });

  it("staggers the column heads when they would collide, and not when they fit", () => {
    const { report } = sample();
    const leaders = (svg: string) => (svg.match(/class="lc-rule" x1="[\d.]+" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" stroke/g) ?? []).length;
    expect(leaders(steppedBedSvg(report, { width: 300 }))).toBeGreaterThan(1);
    expect(leaders(steppedBedSvg(report, { width: 900 }))).toBe(1);
  });

  it("draws a clean wallet and a wallet with nothing left", () => {
    expect(steppedBedSvg({ address: ME, score: 100, findings: [] })).toContain(">100</text>");
    const spent = steppedBedSvg({ address: ME, score: 0, findings: [{ id: "a", severity: "high", title: "A", detail: "", penalty: 120 }] });
    expect(spent).toContain('class="lc-sounding"');
    expect(spent).not.toContain("NaN");
  });
});

describe("by hour", () => {
  it("counts transfers per UTC hour and leaves out untimed ones", () => {
    const hours = hourCounts([flow({ time: T0 }), flow({ time: T0 + 3600 }), flow({ time: T0 + 3600 + 59 }), flow({ time: 0 })]);
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe(1);
    expect(hours[1]).toBe(2);
    expect(hours.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("finds the quiet window the scanner finds", () => {
    const { flows, report } = sample();
    const quiet = quietWindow(hourCounts(flows))!;
    const finding = report.findings.find((f) => f.id === "time-zone");
    expect(finding).toBeDefined();
    expect(quiet.guessable).toBe(true);
    // The scanner writes hours as the design rules do: the 24-hour clock, two digits.
    expect(quiet).toMatchObject({ start: 0, end: 6 });
    expect(finding!.detail).toBe("Almost no activity between 00:00 and 06:00 UTC. That is likely your sleep window.");
    expect(finding!.detail).toContain(`between ${clock(quiet.start)} and ${clock(quiet.end)} UTC`);
    // The figure says the hours the same way, in its label and in its text alternative.
    expect(byHourSvg(flows)).toContain(`>Quiet ${clock(quiet.start)} to ${clock(quiet.end)}</text>`);
    expect(byHourText(flows)).toContain(`Almost nothing from ${clock(quiet.start)} to ${clock(quiet.end)} UTC`);
  });

  it("does not cry wolf on a thin or even history", () => {
    expect(quietWindow(new Array<number>(24).fill(0))).toBeNull();
    expect(quietWindow(new Array<number>(24).fill(5))!.guessable).toBe(false);
    const few = new Array<number>(24).fill(0);
    few[12] = 19;
    expect(quietWindow(few)!.guessable).toBe(false);
  });

  it("draws the shoal in magenta only when it is a leak, and says so in words", () => {
    const { flows } = sample();
    const svg = byHourSvg(flows, { id: "h" });
    expect(svg).toContain('role="img"');
    expect(svg).toContain("Quiet ");
    expect(svg).toContain("url(#h-h)");
    expect(byHourText(flows)).toContain("gives away a time zone");

    const even = Array.from({ length: 48 }, (_, i) => flow({ time: T0 + i * 1800 }));
    expect(byHourSvg(even)).not.toContain("Quiet ");
    expect(byHourText(even)).toContain("Not quiet enough");
    expect(byHourText([])).toBe("No transfers with a known time.");
    expect(byHourSvg([])).toContain("</svg>");
  });
});

describe("by hour: where the caution is lettered", () => {
  /** Three transfers in every hour but the six from `quietStart`, and `extra` more in `peakHour`. */
  const awake = (quietStart: number, peakHour: number, extra = 9): Flow[] => {
    const quiet = new Set(Array.from({ length: 6 }, (_, k) => (quietStart + k) % 24));
    const flows: Flow[] = [];
    for (let h = 0; h < 24; h++) {
      if (quiet.has(h)) continue;
      for (let i = 0; i < 3 + (h === peakHour ? extra : 0); i++) flows.push(flow({ time: T0 + i * 86_400 + h * 3600 + 30 }));
    }
    return flows;
  };
  const read = (svg: string) => {
    const label = /<text class="lc-caution" x="([\d.]+)" y="([\d.]+)" text-anchor="(start|end)"[^>]*>([^<]+)<\/text>/.exec(svg)!;
    const hatched = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="url\(#[\w-]+-h\)"\/>/g)].map((m) => ({ from: Number(m[1]), to: Number(m[1]) + Number(m[2]) }));
    const figure = /<text class="lc-label" x="[\d.]+" y="([\d.]+)"/.exec(svg)!;
    return { x: Number(label[1]), y: Number(label[2]), anchor: label[3], text: label[4], hatched, figureY: Number(figure[1]), height: Number(/ height="([\d.]+)"/.exec(svg)![1]) };
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.02;

  it("starts where the hatching starts", () => {
    for (const width of [240, 420, 568]) {
      const early = read(byHourSvg(awake(0, 12), { width }));
      expect(early.text).toBe("Quiet 00:00 to 06:00");
      expect(early.hatched).toHaveLength(6);
      expect(early).toMatchObject({ anchor: "start", x: 0 });
      // On one line with the busiest hour's figure wherever the two do not meet. At 240 they do.
      expect(early.y).toBe(width === 240 ? early.figureY + 16 : early.figureY);
    }
    const midday = read(byHourSvg(awake(9, 20), { width: 420 }));
    expect(midday.text).toBe("Quiet 09:00 to 15:00");
    expect(midday.anchor).toBe("start");
    expect(near(midday.x, midday.hatched[0]!.from)).toBe(true);
  });

  it("ends where the hatching ends when it would otherwise run off the figure", () => {
    const evening = read(byHourSvg(awake(18, 9), { width: 420 }));
    expect(evening.text).toBe("Quiet 18:00 to 00:00");
    expect(evening).toMatchObject({ anchor: "end", x: 420 });
    expect(near(evening.x, evening.hatched[5]!.to)).toBe(true);
  });

  it("stands under the longer part of a window that wraps past midnight", () => {
    // 22:00 to 04:00: two hours at the end of the day, four at its start.
    const late = read(byHourSvg(awake(22, 12), { width: 420 }));
    expect(late.text).toBe("Quiet 22:00 to 04:00");
    expect(late.hatched).toHaveLength(6);
    expect(late).toMatchObject({ anchor: "start", x: 0 });
    // 20:00 to 02:00: four hours at the end, two at the start.
    const early = read(byHourSvg(awake(20, 12), { width: 420 }));
    expect(early.text).toBe("Quiet 20:00 to 02:00");
    expect(early).toMatchObject({ anchor: "end", x: 420 });
    // 21:00 to 03:00: three and three. The day is read from its start.
    expect(read(byHourSvg(awake(21, 12), { width: 420 }))).toMatchObject({ anchor: "start", x: 0 });
  });

  it("is never set at the far end from the hatching (it was, when the busiest hour was in the same half)", () => {
    // Quiet from 00:00, busiest at 07:00: the old figure put the label at the right-hand end.
    const svg = byHourSvg(awake(0, 7), { width: 420 });
    const label = read(svg);
    expect(label).toMatchObject({ anchor: "start", x: 0 });
    // The busiest hour's figure is in the way on that line, so the caution drops one, and the figure grows by it.
    expect(label.y).toBe(label.figureY + 16);
    expect(label.height).toBe(read(byHourSvg(awake(0, 12), { width: 420 })).height + 16);
  });
});

describe("counterparties", () => {
  it("ranks by transfers and marks the funder, the recurring and the identified", () => {
    const { flows } = sample();
    const list = counterpartyList(flows, { [EXCHANGE]: "Exchange withdrawal" });
    expect(list[0]).toMatchObject({ address: PAYEE, count: 12, outbound: 12, inbound: 0, recurring: true, funder: false });
    const exchange = list.find((c) => c.address === EXCHANGE)!;
    expect(exchange).toMatchObject({ count: 1, funder: true, recurring: false, label: "Exchange withdrawal" });
    expect(list.reduce((a, c) => a + c.count, 0)).toBe(flows.length);
  });

  it("ignores a label that is only an inherited property", () => {
    const flows = [flow({ counterparty: "toString" }), flow({ counterparty: "constructor" })];
    expect(counterpartyList(flows, {}).every((c) => c.label === undefined)).toBe(true);
  });

  it("draws the notable ones, sums the rest, and says the same in words", () => {
    const { flows } = sample();
    const labels = { [EXCHANGE]: "Exchange <withdrawal>" };
    const svg = counterpartiesSvg(flows, { labels, id: "w" });
    expect(svg).toContain('role="img"');
    expect(svg).toContain("9fRk…2mVd");
    expect(svg).toContain("×12");
    expect(svg).toContain("lc-node-caution");
    expect(svg).toContain("Exchange &lt;withdrawal&gt;, funded this wallet");
    expect(svg).toContain("12 others");
    expect(svg).not.toContain("<withdrawal>");
    const text = counterpartiesText(flows, { labels });
    expect(text).toContain("dealt with 14 addresses in 25 transfers");
    expect(text).toContain("9fRk…2mVd: 12 transfers.");
    expect(counterpartiesText([])).toBe("No transfers, so no counterparties.");
    expect(counterpartiesSvg([])).toContain("No transfers found.");
  });
});

describe("types", () => {
  it("accepts the scanner's LeakReport and Flow[] as they are", () => {
    const { flows, report } = sample();
    // Compile-time: no casts between @loch/scanner-core and @loch/design/charts.
    const svg: string = steppedBedSvg(report) + byHourSvg(flows) + counterpartiesSvg(flows);
    expect(svg.length).toBeGreaterThan(0);
  });
});
