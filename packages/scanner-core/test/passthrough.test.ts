/**
 * The pass-through check is answered without comparing every outgoing flow
 * with every incoming one. These tests hold the fast answer to the slow one,
 * which stays in test/reference.ts as the definition, and hold its running
 * time to something an endpoint cannot stretch.
 */
import { describe, expect, it } from "vitest";

import { analyse } from "../src/index.js";
import type { Flow } from "../src/index.js";
import { AMOUNT_EPSILON, PASS_THROUGH_WINDOW_SECONDS, passThroughOutflows } from "../src/analyse.js";
import { ALICE, T0, USDC } from "./fixtures.js";
import { passThroughOutflowsReference } from "./reference.js";

/** A small seeded generator (mulberry32): the same cases on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(next: () => number, from: readonly T[]): T => from[Math.floor(next() * from.length)]!;

/** One ulp at 5,000,000: 9.3e-10, just under the tolerance. Two of them are just over it. */
const ULP_AT_5M = 2 ** -30;

/** Amounts that sit on, just inside and just outside the 1e-9 tolerance of each other, and the values arithmetic is odd for. */
function amountNear(next: () => number): number {
  const base = pick(next, [0, 0.001, 1, 2.5, 10, 1234.56789, 5_000_000, 1e12]);
  const kind = next();
  if (kind < 0.03) return pick(next, [Number.NaN, Infinity, -Infinity, -0, -1, -2.5, 1e300, -1e300, Number.MIN_VALUE, Number.MAX_VALUE]);
  if (kind < 0.35) return base;
  if (base === 5_000_000) return base + ULP_AT_5M * Math.floor(next() * 7 - 3);
  // Steps of a quarter of the tolerance, up to twice it either way.
  return base + (AMOUNT_EPSILON / 4) * Math.floor(next() * 17 - 8);
}

/** Times on, just inside and just outside the ten-minute window, and the ones a missing or absurd block time gives. */
function timeNear(next: () => number): number {
  const kind = next();
  if (kind < 0.03) return pick(next, [Number.NaN, Infinity, -Infinity, 0, -0, 1e300, -1e300, 8.64e15, 0.5]);
  const base = pick(next, [T0, T0, T0 + 3_600, 0]);
  return base + pick(next, [0, 0, 1, -1, 30, PASS_THROUGH_WINDOW_SECONDS - 1, PASS_THROUGH_WINDOW_SECONDS, PASS_THROUGH_WINDOW_SECONDS + 1, -PASS_THROUGH_WINDOW_SECONDS, 0.25, 599.999, 600.001, 1_200]);
}

function randomFlows(next: () => number, size: number): Flow[] {
  return Array.from({ length: size }, (_, i) => ({
    sig: `s${i}`,
    time: timeNear(next),
    dir: (next() < 0.02 ? "sideways" : next() < 0.5 ? "in" : "out") as Flow["dir"],
    counterparty: ALICE,
    amount: amountNear(next),
    asset: next() < 0.02 ? (Number.NaN as unknown as string) : pick(next, ["SOL", "SOL", USDC, "SPL"]),
  }));
}

/** Positions, so that "the same flows in the same order" is checked by identity, not by looks. */
const positions = (all: readonly Flow[], some: readonly Flow[]) => some.map((flow) => all.indexOf(flow));

describe("the pass-through check, fast against slow", () => {
  it("agrees with the pair-by-pair check on 4000 random histories built around its edges", () => {
    const next = random(0x10c4);
    let matchedSomething = 0;
    for (let round = 0; round < 4000; round++) {
      const history = randomFlows(next, Math.floor(next() * 40));
      const expected = passThroughOutflowsReference(history);
      const actual = passThroughOutflows(history);
      if (expected.length > 0) matchedSomething += 1;
      expect(positions(history, actual), `round ${round}: ${JSON.stringify(history)}`).toEqual(positions(history, expected));
    }
    // The cases are not vacuous: about a quarter of them have pass-throughs to find.
    expect(matchedSomething).toBeGreaterThan(500);
  });

  it("agrees on larger histories, where the runs of equal amounts and times are long", () => {
    const next = random(0xbeef);
    for (let round = 0; round < 40; round++) {
      const history = randomFlows(next, 300 + Math.floor(next() * 400));
      expect(positions(history, passThroughOutflows(history))).toEqual(positions(history, passThroughOutflowsReference(history)));
    }
  });

  it("gives analyse() the finding the pair-by-pair check would give it", () => {
    const next = random(7);
    for (let round = 0; round < 300; round++) {
      const history = randomFlows(next, Math.floor(next() * 30));
      const expected = passThroughOutflowsReference(history).length;
      const finding = analyse(history).find((x) => x.id === "pass-through");
      if (expected === 0) expect(finding, `round ${round}`).toBeUndefined();
      else {
        expect(finding?.penalty, `round ${round}`).toBe(Math.min(15, 5 * expected));
        expect(finding?.detail, `round ${round}`).toContain(`${expected} outgoing transfer${expected === 1 ? " " : "s "}matched`);
      }
    }
  });

  it("keeps to the tolerance and the window exactly, at their edges", () => {
    const leg = (dir: "in" | "out", amount: number, time: number): Flow => ({ sig: "s", time, dir, counterparty: ALICE, amount, asset: "SOL" });
    const matches = (inAmount: number, outAmount: number, gap: number) => passThroughOutflows([leg("in", inAmount, T0), leg("out", outAmount, T0 + gap)]).length === 1;
    expect(matches(2.5, 2.5, 0)).toBe(true);
    expect(matches(2.5, 2.5, 599)).toBe(true);
    expect(matches(2.5, 2.5, 599.999)).toBe(true);
    expect(matches(2.5, 2.5, 600)).toBe(false);
    expect(matches(2.5, 2.5, -1)).toBe(false);
    expect(matches(2.5, 2.5 + 4e-10, 60)).toBe(true);
    expect(matches(2.5 + 4e-10, 2.5, 60)).toBe(true);
    expect(matches(2.5, 2.5 + 2e-9, 60)).toBe(false);
    expect(matches(2.5 + 2e-9, 2.5, 60)).toBe(false);
    // Neighbouring doubles at five million are 9.3e-10 apart: one step is inside the tolerance, two are not.
    expect(matches(5_000_000, 5_000_000 + ULP_AT_5M, 60)).toBe(true);
    expect(matches(5_000_000, 5_000_000 + 2 * ULP_AT_5M, 60)).toBe(false);
    // Nothing equals NaN, and infinity is not within anything of infinity.
    expect(matches(Number.NaN, Number.NaN, 0)).toBe(false);
    expect(matches(Infinity, Infinity, 0)).toBe(false);
    expect(passThroughOutflows([leg("in", 1, Infinity), leg("out", 1, Infinity)])).toEqual([]);
    expect(passThroughOutflows([leg("in", 1, Number.NaN), leg("out", 1, T0)])).toEqual([]);
    // No block time on either leg is time 0 on both, which is zero seconds apart: a match, as before.
    expect(passThroughOutflows([leg("in", 1, 0), leg("out", 1, 0)])).toHaveLength(1);
  });

  it("returns the matched outgoing flows themselves, in the order they came, and does not touch its input", () => {
    const a: Flow = { sig: "a", time: T0 + 10, dir: "out", counterparty: ALICE, amount: 3, asset: "SOL" };
    const b: Flow = { sig: "b", time: T0, dir: "in", counterparty: ALICE, amount: 3, asset: "SOL" };
    const c: Flow = { sig: "c", time: T0 + 5, dir: "out", counterparty: ALICE, amount: 7, asset: "SOL" };
    const d: Flow = { sig: "d", time: T0 + 20, dir: "out", counterparty: ALICE, amount: 3, asset: "SOL" };
    const history = [a, b, c, d];
    const snapshot = JSON.stringify(history);
    const matched = passThroughOutflows(history);
    expect(matched).toHaveLength(2);
    expect(matched[0]).toBe(a);
    expect(matched[1]).toBe(d);
    expect(JSON.stringify(history)).toBe(snapshot);
    expect(history).toEqual([a, b, c, d]);
  });
});

describe("the pass-through check on histories an endpoint sized", () => {
  const timed = (history: Flow[]) => {
    const started = performance.now();
    const findings = analyse(history);
    return { ms: performance.now() - started, finding: findings.find((x) => x.id === "pass-through") };
  };
  const leg = (dir: "in" | "out", amount: number, time: number, asset = "SOL"): Flow => ({ sig: "s", time, dir, counterparty: "A", amount, asset });
  /** Generous: the old check took 37 s for the first of these. A slow machine still passes; a quadratic check cannot. */
  const BOUND_MS = 3_000;

  it("60,000 incoming and 60,000 outgoing flows with nothing in common", () => {
    const history: Flow[] = [];
    for (let k = 0; k < 60_000; k++) history.push(leg("in", k + 1, 1_785_542_400), leg("out", -k - 1, 1_785_542_400));
    const { ms, finding } = timed(history);
    expect(finding).toBeUndefined();
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("60,000 of each with the same amount, where only the times tell them apart", () => {
    const history: Flow[] = [];
    // Every outgoing flow comes before every incoming one: equal amounts, and still no pass-through.
    for (let k = 0; k < 60_000; k++) history.push(leg("in", 1, T0 + 1_000_000 + k), leg("out", 1, T0 + k));
    const { ms, finding } = timed(history);
    expect(finding).toBeUndefined();
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("60,000 of each that all match", () => {
    const history: Flow[] = [];
    for (let k = 0; k < 60_000; k++) history.push(leg("in", 1, T0), leg("out", 1, T0 + 30));
    const { ms, finding } = timed(history);
    expect(finding?.detail).toContain("60000 outgoing transfers matched");
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("50,000 assets with one pair each", () => {
    const history: Flow[] = [];
    for (let k = 0; k < 50_000; k++) history.push(leg("in", 2, T0, `mint-${k}`), leg("out", 2, T0 + 1, `mint-${k}`));
    const { ms, finding } = timed(history);
    expect(finding?.detail).toContain("50000 outgoing transfers matched");
    expect(ms).toBeLessThan(BOUND_MS);
  });
});
