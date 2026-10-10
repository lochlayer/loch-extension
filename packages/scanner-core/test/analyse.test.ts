import { describe, expect, it } from "vitest";

import { analyse, buildReport, scoreReport, sortFindings } from "../src/index.js";
import type { Finding, FindingId, Flow } from "../src/index.js";
import { ALICE, BOB, CAROL, DAVE, ERIN, EXCHANGE, FRANK, ME, T0, USDC, at, flow, flows } from "./fixtures.js";

const find = (findings: Finding[], id: FindingId) => findings.find((x) => x.id === id);
const ids = (findings: Finding[]) => findings.map((x) => x.id);

describe("analyse", () => {
  it("finds nothing in an empty history", () => {
    expect(analyse([])).toEqual([]);
    expect(analyse([], { solBalance: 0, tokenAccountCount: 0, labels: {} })).toEqual([]);
  });

  it("finds nothing in a single outgoing transfer", () => {
    expect(analyse([flow()])).toEqual([]);
  });

  describe("funding source", () => {
    it("reports the earliest inbound transfer, medium when unlabelled", () => {
      const history = [
        flow({ dir: "in", counterparty: BOB, time: T0 + 500 }),
        flow({ dir: "out", counterparty: CAROL, time: T0 }),
        flow({ dir: "in", counterparty: ALICE, time: T0 + 100 }),
      ];
      expect(find(analyse(history), "funding-source")).toEqual({
        id: "funding-source",
        severity: "medium",
        title: "Funding source is public",
        detail: "First funds came from Vote…1111. Anyone can follow this link back.",
        penalty: 10,
      });
    });

    it("is high and names the label when the funder is labelled", () => {
      const finding = find(analyse([flow({ dir: "in", counterparty: ALICE })], { labels: { [ALICE]: "Exchange hot wallet" } }), "funding-source");
      expect(finding).toMatchObject({
        severity: "high",
        penalty: 20,
        detail: "First funds came from Vote…1111 (Exchange hot wallet). Anyone can follow this link back.",
      });
    });

    it("is absent when the wallet never received anything", () => {
      expect(find(analyse(flows(2, { dir: "out" })), "funding-source")).toBeUndefined();
    });
  });

  describe("identified services", () => {
    it("counts transfers per labelled counterparty", () => {
      const history = [...flows(2, { counterparty: EXCHANGE }), flow({ counterparty: ALICE }), flow({ counterparty: BOB })];
      const finding = find(analyse(history, { labels: { [EXCHANGE]: "Exchange deposit", [ALICE]: "Payroll" } }), "identified-services");
      expect(finding).toEqual({
        id: "identified-services",
        severity: "high",
        title: "Linked to identified services",
        detail: "This wallet has 2 transfers with Exchange deposit and 1 with Payroll. These services can tie it to your identity.",
        penalty: 20,
      });
    });

    it("says \"this service\" for one and lists three or more with a final \"and\"", () => {
      const detail = (who: string[], labels: Record<string, string>) =>
        find(analyse(who.map((counterparty) => flow({ counterparty })), { labels }), "identified-services")?.detail;
      expect(detail([EXCHANGE], { [EXCHANGE]: "Exchange deposit" })).toBe(
        "This wallet has 1 transfer with Exchange deposit. This service can tie it to your identity.",
      );
      expect(detail([ALICE, ALICE, BOB, CAROL], { [ALICE]: "A", [BOB]: "B", [CAROL]: "C" })).toBe(
        "This wallet has 2 transfers with A, 1 with B and 1 with C. These services can tie it to your identity.",
      );
    });

    it("charges 10 per service and caps the penalty at 25", () => {
      const labels = { [ALICE]: "A", [BOB]: "B", [CAROL]: "C", [DAVE]: "D" };
      const penalty = (who: string[]) => find(analyse(who.map((counterparty) => flow({ counterparty })), { labels }), "identified-services")?.penalty;
      expect(penalty([ALICE])).toBe(10);
      expect(penalty([ALICE, BOB])).toBe(20);
      expect(penalty([ALICE, BOB, CAROL])).toBe(25);
      expect(penalty([ALICE, BOB, CAROL, DAVE])).toBe(25);
    });

    it("is absent without labels, and ignores labels for addresses never seen", () => {
      expect(find(analyse([flow()]), "identified-services")).toBeUndefined();
      expect(find(analyse([flow({ counterparty: ALICE })], { labels: { [BOB]: "B" } }), "identified-services")).toBeUndefined();
    });

    it("never treats an Object.prototype key as a label", () => {
      const history = [flow({ counterparty: "constructor" }), flow({ counterparty: "toString", dir: "in" })];
      const findings = analyse(history, { labels: {} });
      expect(find(findings, "identified-services")).toBeUndefined();
      expect(find(findings, "funding-source")?.severity).toBe("medium");
    });
  });

  describe("recurring counterparties", () => {
    it("needs three transfers with the same counterparty", () => {
      expect(find(analyse(flows(2, { counterparty: ALICE })), "recurring-counterparties")).toBeUndefined();
      expect(find(analyse(flows(3, { counterparty: ALICE })), "recurring-counterparties")).toMatchObject({ severity: "medium", penalty: 4 });
    });

    it("counts both directions and lists the top three, busiest first", () => {
      const history = [
        ...flows(3, { counterparty: ALICE }),
        ...flows(3, { counterparty: BOB, dir: "in" }),
        ...flows(2, { counterparty: BOB }),
        ...flows(4, { counterparty: CAROL }),
        ...flows(3, { counterparty: DAVE }),
      ];
      expect(find(analyse(history), "recurring-counterparties")).toMatchObject({
        severity: "medium",
        penalty: 16,
        detail:
          "4 addresses interact with you 3 or more times (top: Stak…1111 ×5, Conf…1111 ×4, Vote…1111 ×3). Regular payments reveal employers, clients or friends.",
      });
    });

    it("writes one address in the singular and says \"top\" only when it leaves some out", () => {
      const detail = (who: string[]) => find(analyse(who.flatMap((counterparty) => flows(3, { counterparty }))), "recurring-counterparties")?.detail;
      expect(detail([BOB])).toBe("1 address interacts with you 3 or more times (Stak…1111 ×3). Regular payments reveal employers, clients or friends.");
      expect(detail([ALICE, BOB, CAROL])).toBe(
        "3 addresses interact with you 3 or more times (Vote…1111 ×3, Stak…1111 ×3, Conf…1111 ×3). Regular payments reveal employers, clients or friends.",
      );
    });

    it("turns high at five recurring counterparties and caps the penalty at 20", () => {
      const recurring = (who: string[]) =>
        find(analyse(who.flatMap((counterparty) => flows(3, { counterparty }))), "recurring-counterparties");
      expect(recurring([ALICE, BOB, CAROL, DAVE])).toMatchObject({ severity: "medium", penalty: 16 });
      expect(recurring([ALICE, BOB, CAROL, DAVE, ERIN])).toMatchObject({ severity: "high", penalty: 20 });
      expect(recurring([ALICE, BOB, CAROL, DAVE, ERIN, FRANK])).toMatchObject({ severity: "high", penalty: 20 });
    });
  });

  describe("time zone", () => {
    // Distinct counterparties and amounts so no other check fires.
    const spread = (hours: number[]): Flow[] =>
      hours.map((hour, i) => flow({ time: at(hour, i), counterparty: `wallet-${i}`, amount: i + 1 }));
    const repeat = (hour: number, n: number) => Array.from({ length: n }, () => hour);

    it("stays silent below 20 timed transfers", () => {
      expect(analyse(spread(repeat(12, 19)))).toEqual([]);
    });

    it("fires at exactly 20 transfers when a six-hour window is empty", () => {
      const findings = analyse(spread([...repeat(12, 10), ...repeat(20, 10)]));
      expect(ids(findings)).toEqual(["time-zone"]);
      // First emptiest window: 21:00 through 02:59 holds nothing; so does every start up to 06:00,
      // and the earliest start (00:00) wins.
      expect(findings[0]).toEqual({
        id: "time-zone",
        severity: "medium",
        title: "Your time zone is guessable",
        detail: "Almost no activity between 00:00 and 06:00 UTC. That is likely your sleep window.",
        penalty: 10,
      });
    });

    it("wraps the quiet window past midnight", () => {
      // Activity 04:00 to 21:59 every hour; the only empty six-hour window is 22:00 to 03:59.
      const busy = Array.from({ length: 18 }, (_, i) => i + 4);
      const finding = find(analyse(spread([...busy, 12, 13])), "time-zone");
      expect(finding?.detail).toBe("Almost no activity between 22:00 and 04:00 UTC. That is likely your sleep window.");
    });

    it("does not count transfers without a block time towards the 20", () => {
      const history = spread(repeat(12, 20));
      history[0] = { ...history[0]!, time: 0 };
      expect(find(analyse(history), "time-zone")).toBeUndefined();
    });

    it("stays silent when the quietest window holds exactly 5 percent of activity", () => {
      // One transfer at 0, 6, 12 and 18 puts exactly one in every six-hour window.
      // 16 more at 12:00 make it 1 of 20 = 5%, which is not below the threshold.
      const history = spread([0, 6, 12, 18, ...repeat(12, 16)]);
      expect(history).toHaveLength(20);
      expect(find(analyse(history), "time-zone")).toBeUndefined();
    });

    it("fires when the quietest window drops just below 5 percent", () => {
      // Same shape with one more transfer: 1 of 21 = 4.76%.
      const history = spread([0, 6, 12, 18, ...repeat(12, 17)]);
      expect(history).toHaveLength(21);
      expect(find(analyse(history), "time-zone")).toMatchObject({ penalty: 10 });
    });

    it("stays silent when activity is spread around the clock", () => {
      const history = spread(Array.from({ length: 48 }, (_, i) => i % 24));
      expect(find(analyse(history), "time-zone")).toBeUndefined();
    });
  });

  describe("pass-through", () => {
    const pair = (gapSeconds: number, out: Partial<Flow> = {}) => [
      flow({ dir: "in", counterparty: ALICE, amount: 2.5, time: T0 }),
      flow({ dir: "out", counterparty: BOB, amount: 2.5, time: T0 + gapSeconds, ...out }),
    ];

    it("matches an equal amount sent on in the same second", () => {
      expect(find(analyse(pair(0)), "pass-through")).toEqual({
        id: "pass-through",
        severity: "medium",
        title: "Exact amounts passed straight through",
        detail: "1 outgoing transfer matched an incoming amount within 10 minutes. This links the sender to the final recipient.",
        penalty: 5,
      });
    });

    it("matches just inside ten minutes (599 s)", () => {
      expect(find(analyse(pair(599)), "pass-through")).toBeDefined();
    });

    it("does not match at exactly ten minutes (600 s) or later", () => {
      expect(find(analyse(pair(600)), "pass-through")).toBeUndefined();
      expect(find(analyse(pair(601)), "pass-through")).toBeUndefined();
    });

    it("does not match when the outgoing transfer came first", () => {
      expect(find(analyse(pair(-1)), "pass-through")).toBeUndefined();
    });

    it("needs the same asset", () => {
      expect(find(analyse(pair(60, { asset: USDC })), "pass-through")).toBeUndefined();
    });

    it("treats amounts closer than 1e-9 as equal and anything further apart as different", () => {
      expect(find(analyse(pair(60, { amount: 2.5 + 4e-10 })), "pass-through")).toBeDefined();
      expect(find(analyse(pair(60, { amount: 2.5 + 2e-9 })), "pass-through")).toBeUndefined();
      expect(find(analyse(pair(60, { amount: 2.49 })), "pass-through")).toBeUndefined();
    });

    it("charges 5 per matched outgoing transfer and caps the penalty at 15", () => {
      const pairs = (n: number) =>
        Array.from({ length: n }, (_, i) => [
          flow({ dir: "in", counterparty: `sender-${i}`, amount: 10 + i, time: T0 + i * 3_600 }),
          flow({ dir: "out", counterparty: `recipient-${i}`, amount: 10 + i, time: T0 + i * 3_600 + 30 }),
        ]).flat();
      const result = (n: number) => find(analyse(pairs(n)), "pass-through");
      expect(result(2)).toMatchObject({ penalty: 10 });
      expect(result(3)).toMatchObject({ penalty: 15 });
      expect(result(4)).toMatchObject({
        penalty: 15,
        detail: "4 outgoing transfers matched an incoming amount within 10 minutes. This links the sender to the final recipient.",
      });
    });
  });

  describe("visible balance", () => {
    const balance = (solBalance: number, tokenAccountCount = 0) => find(analyse([], { solBalance, tokenAccountCount }), "balance-visible");

    it("stays silent at 10 SOL and 10 token accounts or fewer", () => {
      expect(balance(10, 10)).toBeUndefined();
      expect(balance(0, 0)).toBeUndefined();
    });

    it("is low above 10 SOL", () => {
      expect(balance(10.01)).toEqual({
        id: "balance-visible",
        severity: "low",
        title: "Balance is visible to everyone",
        detail: "10.010 SOL and 0 token accounts are public. Anyone you pay can look.",
        penalty: 5,
      });
    });

    it("is low for more than 10 token accounts even with no SOL", () => {
      expect(balance(0, 11)).toMatchObject({
        severity: "low",
        penalty: 5,
        detail: "0.000 SOL and 11 token accounts are public. Anyone you pay can look.",
      });
    });

    it("writes the balance as the numerals rules do: cut at three decimals, never rounded up", () => {
      expect(balance(41.2079)?.detail).toBe("41.207 SOL and 0 token accounts are public. Anyone you pay can look.");
      expect(balance(12_480.7399, 1)?.detail).toBe("12\u2009480.739 SOL and 1 token account are public. Anyone you pay can look.");
      expect(balance(0.0004, 11)?.detail).toBe("<0.001 SOL and 11 token accounts are public. Anyone you pay can look.");
    });

    it("turns high above 100 SOL, not at exactly 100", () => {
      expect(balance(100)).toMatchObject({ severity: "low", penalty: 5 });
      expect(balance(100.5)).toMatchObject({ severity: "high", penalty: 15 });
    });
  });

  it("returns findings in check order and leaves its input untouched", () => {
    const history = [
      flow({ dir: "in", counterparty: ALICE, amount: 5, time: T0 + 100 }),
      flow({ dir: "out", counterparty: BOB, amount: 5, time: T0 + 160 }),
      ...flows(3, { counterparty: EXCHANGE, time: T0 - 50 }),
    ];
    const snapshot = JSON.stringify(history);
    const findings = analyse(history, { solBalance: 250, tokenAccountCount: 3, labels: { [EXCHANGE]: "Exchange deposit" } });
    expect(ids(findings)).toEqual(["funding-source", "identified-services", "recurring-counterparties", "pass-through", "balance-visible"]);
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});

describe("the wording of every finding", () => {
  // DESIGN.md, Voice: full sentences, no spaced dashes, no "(s)", no "3+", 24-hour times with two digits.
  const everything = () => {
    const hours = Array.from({ length: 18 }, (_, i) => i + 4);
    const timed = [...hours, 12, 13].map((hour, i) => flow({ time: at(hour, i), counterparty: `wallet-${i}`, amount: 100 + i }));
    return analyse(
      [
        ...timed,
        flow({ dir: "in", counterparty: EXCHANGE, amount: 5, time: at(9, 30) }),
        flow({ dir: "out", counterparty: BOB, amount: 5, time: at(9, 30, 4) }),
        ...flows(3, { counterparty: CAROL, time: at(10, 31) }),
      ],
      { solBalance: 250, tokenAccountCount: 12, labels: { [EXCHANGE]: "Exchange withdrawal" } },
    );
  };

  it("covers all six checks", () => {
    expect(ids(everything()).sort()).toEqual(
      ["balance-visible", "funding-source", "identified-services", "pass-through", "recurring-counterparties", "time-zone"].sort(),
    );
  });

  it.each(everything().map((x) => [x.id, x] as const))("%s is written in plain full sentences", (_id, finding) => {
    for (const text of [finding.title, finding.detail]) {
      expect(text).not.toMatch(/\s[—–-]\s/);
      expect(text).not.toContain("(s)");
      expect(text).not.toMatch(/\d\+/);
      expect(text).not.toMatch(/(?<![\d:])\d:\d\d/);
      expect(text).not.toContain("!");
    }
    expect(finding.detail).toMatch(/\.$/);
    expect(finding.title).not.toMatch(/\.$/);
    expect(finding.detail).not.toContain("make you a target");
  });
});

describe("scoreReport", () => {
  const withPenalties = (...penalties: number[]) => penalties.map((penalty) => ({ penalty }));

  it("is 100 when nothing was found", () => {
    expect(scoreReport([])).toBe(100);
  });

  it("subtracts every penalty from 100", () => {
    expect(scoreReport(withPenalties(10, 25, 4))).toBe(61);
  });

  it("never goes below 0", () => {
    expect(scoreReport(withPenalties(20, 25, 20, 10, 15, 15))).toBe(0);
    expect(scoreReport(withPenalties(100))).toBe(0);
    expect(scoreReport(withPenalties(60, 60))).toBe(0);
  });

  it("gives the worst case of all six checks a score of 0, never negative", () => {
    // Labelled funder (20) + 3 services (25) + 6 recurring (20) + time zone (10) + 3 pass-throughs (15) + 100+ SOL (15) = 105.
    const worst = withPenalties(20, 25, 20, 10, 15, 15);
    expect(worst.reduce((a, x) => a + x.penalty, 0)).toBe(105);
    expect(scoreReport(worst)).toBe(0);
  });
});

describe("sortFindings", () => {
  it("orders by severity, keeps check order within a severity and copies the array", () => {
    const input = [
      { id: "a", severity: "low" },
      { id: "b", severity: "medium" },
      { id: "c", severity: "high" },
      { id: "d", severity: "medium" },
    ] as const;
    const sorted = sortFindings(input);
    expect(sorted.map((x) => x.id)).toEqual(["c", "b", "d", "a"]);
    expect(input.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("buildReport", () => {
  it("reports a clean wallet as 100 with no findings", () => {
    expect(buildReport({ address: ME, scannedTransactions: 0, flows: [] })).toEqual({
      address: ME,
      scannedTransactions: 0,
      transfers: 0,
      score: 100,
      findings: [],
    });
  });

  it("counts transfers, scores the findings and lists them most severe first", () => {
    const history = [
      flow({ dir: "in", counterparty: ALICE, amount: 5, time: T0 + 100 }),
      flow({ dir: "out", counterparty: BOB, amount: 5, time: T0 + 160 }),
      flow({ dir: "out", counterparty: EXCHANGE, amount: 1, time: T0 + 5_000 }),
    ];
    const report = buildReport({
      address: ME,
      scannedTransactions: 2,
      flows: history,
      solBalance: 12,
      tokenAccountCount: 1,
      labels: { [EXCHANGE]: "Exchange deposit" },
    });
    expect(report.address).toBe(ME);
    expect(report.scannedTransactions).toBe(2);
    expect(report.transfers).toBe(3);
    expect(report.findings.map((x) => [x.id, x.severity, x.penalty])).toEqual([
      ["identified-services", "high", 10],
      ["funding-source", "medium", 10],
      ["pass-through", "medium", 5],
      ["balance-visible", "low", 5],
    ]);
    expect(report.score).toBe(70);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
