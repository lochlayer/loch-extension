import { describe, expect, it } from "vitest";

import { assessOutgoingTransfer } from "../src/index.js";
import type { Finding, FindingId, Flow, OutgoingTransfer } from "../src/index.js";
import { ALICE, BOB, CAROL, EXCHANGE, T0, THEIR_USDC_ACCOUNT, USDC, flow, flows } from "./fixtures.js";

const NOW = T0 + 10_000;
const find = (findings: Finding[], id: FindingId) => findings.find((x) => x.id === id);
const ids = (findings: Finding[]) => findings.map((x) => x.id);
const send = (over: Partial<OutgoingTransfer> = {}): OutgoingTransfer => ({ to: BOB, amount: 1, asset: "SOL", time: NOW, ...over });
/** One earlier transfer with BOB, long ago: enough history that no counterparty warning fires. */
const knownBob = (): Flow[] => [flow({ counterparty: BOB, amount: 0.123, time: T0 })];

describe("assessOutgoingTransfer", () => {
  it("has nothing to say about a second transfer to a known, unlabelled recipient", () => {
    expect(assessOutgoingTransfer({ flows: knownBob(), transfer: send() })).toEqual([]);
  });

  describe("labelled recipient", () => {
    it("warns that the service can tie the wallet to an identity", () => {
      const findings = assessOutgoingTransfer({
        flows: [flow({ counterparty: EXCHANGE, time: T0 })],
        labels: { [EXCHANGE]: "Exchange deposit (Kraken)" },
        transfer: send({ to: EXCHANGE }),
      });
      expect(findings).toEqual([
        {
          id: "recipient-identified",
          severity: "high",
          title: "Recipient is an identified service",
          detail: "Sysv…1111 is labelled Exchange deposit (Kraken). Sending from this wallet lets that service tie it to your identity.",
          penalty: 10,
        },
      ]);
    });

    it("also recognises the wallet behind a destination token account", () => {
      const findings = assessOutgoingTransfer({
        flows: [],
        labels: { [ALICE]: "Payroll provider" },
        transfer: send({ to: THEIR_USDC_ACCOUNT, toOwner: ALICE, asset: USDC, amount: 50 }),
      });
      expect(find(findings, "recipient-identified")?.detail).toBe(
        "Vote…1111 is labelled Payroll provider. Sending from this wallet lets that service tie it to your identity.",
      );
    });

    it("stays silent for unlabelled recipients and prototype keys", () => {
      const labels = { [EXCHANGE]: "Exchange deposit" };
      expect(find(assessOutgoingTransfer({ flows: [], labels, transfer: send({ to: BOB }) }), "recipient-identified")).toBeUndefined();
      expect(find(assessOutgoingTransfer({ flows: [], labels: {}, transfer: send({ to: "constructor" }) }), "recipient-identified")).toBeUndefined();
      expect(find(assessOutgoingTransfer({ flows: [], transfer: send({ to: EXCHANGE }) }), "recipient-identified")).toBeUndefined();
    });
  });

  describe("pass-through amount", () => {
    const received = (secondsAgo: number, over: Partial<Flow> = {}) =>
      flow({ dir: "in", counterparty: ALICE, amount: 2.5, time: NOW - secondsAgo, ...over });
    const assess = (history: Flow[], over: Partial<OutgoingTransfer> = {}) =>
      find(assessOutgoingTransfer({ flows: [...knownBob(), ...history], transfer: send({ amount: 2.5, ...over }) }), "amount-pass-through");

    it("warns when the amount equals one received minutes ago, naming the sender", () => {
      expect(assess([received(240)])).toEqual({
        id: "amount-pass-through",
        severity: "medium",
        title: "Exact amount would pass straight through",
        detail: "2.500 SOL arrived from Vote…1111 4 minutes ago. Sending the same amount on now links that sender to this recipient.",
        penalty: 5,
      });
    });

    it("warns just inside ten minutes (599 s) and in the same second", () => {
      expect(assess([received(599)])?.detail).toContain("9 minutes ago");
      expect(assess([received(0)])?.detail).toContain("less than a minute ago");
      expect(assess([received(60)])?.detail).toContain("1 minute ago");
    });

    it("stays silent at exactly ten minutes (600 s) or more", () => {
      expect(assess([received(600)])).toBeUndefined();
      expect(assess([received(86_400)])).toBeUndefined();
    });

    it("stays silent when the matching amount arrives after the send time", () => {
      expect(assess([received(-1)])).toBeUndefined();
    });

    it("uses the same 1e-9 tolerance as the scan", () => {
      expect(assess([received(60)], { amount: 2.5 + 4e-10 })).toBeDefined();
      expect(assess([received(60)], { amount: 2.5 + 2e-9 })).toBeUndefined();
      expect(assess([received(60)], { amount: 2.4 })).toBeUndefined();
    });

    it("needs the same asset and an inbound transfer", () => {
      expect(assess([received(60, { asset: USDC })])).toBeUndefined();
      expect(assess([received(60, { dir: "out" })])).toBeUndefined();
    });

    it("describes token amounts by mint and refers to the most recent match", () => {
      const history = [
        received(500, { asset: USDC, amount: 40, counterparty: CAROL }),
        received(130, { asset: USDC, amount: 40, counterparty: ALICE }),
      ];
      expect(assess(history, { asset: USDC, amount: 40 })?.detail).toBe(
        "40 tokens (mint EPjF…Dt1v) arrived from Vote…1111 2 minutes ago. Sending the same amount on now links that sender to this recipient.",
      );
    });
  });

  describe("counterparty history", () => {
    const counterparty = (history: Flow[], over: Partial<OutgoingTransfer> = {}) =>
      assessOutgoingTransfer({ flows: history, transfer: send(over) }).filter((x) => x.id === "new-counterparty" || x.id === "recurring-counterparty");

    it("flags a first-ever transfer as a new public link, even with no history at all", () => {
      const expected = [
        {
          id: "new-counterparty",
          severity: "low",
          title: "Creates a new public link",
          detail: "The scanned history has no earlier transfer with Stak…1111. Sending this ties your wallet to that address where anyone can see it, and the link is permanent.",
          penalty: 2,
        },
      ];
      expect(counterparty([])).toEqual(expected);
      expect(counterparty(flows(4, { counterparty: ALICE }))).toEqual(expected);
    });

    it("does not call it new when the recipient has paid this wallet before", () => {
      expect(counterparty([flow({ dir: "in", counterparty: BOB })])).toEqual([]);
    });

    it("says nothing after one earlier transfer", () => {
      expect(counterparty(flows(1, { counterparty: BOB }))).toEqual([]);
    });

    it("warns when this transfer would make the recipient recurring (third transfer)", () => {
      expect(counterparty(flows(2, { counterparty: BOB }))).toEqual([
        {
          id: "recurring-counterparty",
          severity: "medium",
          title: "Recipient becomes a recurring counterparty",
          detail: "This would be transfer number 3 with Stak…1111. Regular payments reveal employers, clients or friends.",
          penalty: 4,
        },
      ]);
    });

    it("warns when the recipient is already recurring, counting both directions", () => {
      const history = [...flows(3, { counterparty: BOB }), ...flows(2, { counterparty: BOB, dir: "in" }), flow({ counterparty: ALICE })];
      expect(counterparty(history)).toEqual([
        {
          id: "recurring-counterparty",
          severity: "medium",
          title: "Recipient is a recurring counterparty",
          detail: "Stak…1111 already appears in 5 of your transfers. One more strengthens a pattern that reveals employers, clients or friends.",
          penalty: 4,
        },
      ]);
      expect(counterparty(flows(3, { counterparty: BOB }))[0]?.title).toBe("Recipient is a recurring counterparty");
    });

    it("matches history on either the token account or its owner, and shows the owner", () => {
      const history = [
        flow({ counterparty: THEIR_USDC_ACCOUNT, asset: USDC }),
        flow({ counterparty: THEIR_USDC_ACCOUNT, asset: USDC }),
        flow({ counterparty: ALICE, asset: USDC, dir: "in" }),
      ];
      const [finding] = counterparty(history, { to: THEIR_USDC_ACCOUNT, toOwner: ALICE, asset: USDC });
      expect(finding).toMatchObject({ id: "recurring-counterparty", title: "Recipient is a recurring counterparty" });
      expect(finding?.detail).toContain("Vote…1111 already appears in 3 of your transfers");
    });
  });

  it("returns every warning that applies, most severe first", () => {
    const history = [
      ...flows(3, { counterparty: EXCHANGE, time: T0 }),
      flow({ dir: "in", counterparty: ALICE, amount: 7, time: NOW - 30 }),
    ];
    const findings = assessOutgoingTransfer({
      flows: history,
      labels: { [EXCHANGE]: "Exchange deposit" },
      transfer: send({ to: EXCHANGE, amount: 7 }),
    });
    expect(ids(findings)).toEqual(["recipient-identified", "amount-pass-through", "recurring-counterparty"]);
    expect(findings.map((x) => x.severity)).toEqual(["high", "medium", "medium"]);
  });

  it("puts a new-link warning after more serious ones", () => {
    const findings = assessOutgoingTransfer({
      flows: [flow({ dir: "in", counterparty: ALICE, amount: 7, time: NOW - 30 })],
      labels: { [EXCHANGE]: "Exchange deposit" },
      transfer: send({ to: EXCHANGE, amount: 7 }),
    });
    expect(ids(findings)).toEqual(["recipient-identified", "amount-pass-through", "new-counterparty"]);
  });

  it("refuses a send time in milliseconds rather than silently missing pass-throughs", () => {
    const history = [flow({ dir: "in", counterparty: ALICE, amount: 7, time: NOW - 30 })];
    expect(() => assessOutgoingTransfer({ flows: history, transfer: send({ amount: 7, time: NOW * 1000 }) })).toThrow(RangeError);
    expect(() => assessOutgoingTransfer({ flows: history, transfer: send({ amount: 7, time: Number.NaN }) })).toThrow("transfer.time must be unix seconds");
    expect(() => assessOutgoingTransfer({ flows: history, transfer: send({ amount: 7, time: Date.now() }) })).toThrow(RangeError);
    expect(() => assessOutgoingTransfer({ flows: history, transfer: send({ amount: 7, time: Math.floor(Date.now() / 1000) }) })).not.toThrow();
  });

  it("does not modify its input", () => {
    const input = {
      flows: [flow({ dir: "in", counterparty: ALICE, amount: 7, time: NOW - 30 }), ...flows(3, { counterparty: BOB })],
      labels: { [BOB]: "Landlord" },
      transfer: send({ amount: 7 }),
    };
    const snapshot = JSON.stringify(input);
    assessOutgoingTransfer(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
