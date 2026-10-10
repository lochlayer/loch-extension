import { describe, expect, it } from "vitest";

import { SAME_AMOUNT_MS, SOON_AFTER_MS, surfaceWarnings } from "../src/background/surfaceWarnings.js";

const NOW = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;
const WALLET = "Fh3qJ5iBgbd2x9vVqk1mF7yq8a3xgWzJYQeU1cTz8KTz";
const FRESH = "9fRkQ2mVdQ2mVdQ2mVdQ2mVdQ2mVdQ2mVdQ2mVd2mVd";
const SOL = 1_000_000_000n;
const base = { amount: 2n * SOL, fee: 2_500_000n, destination: FRESH, now: NOW, deposits: [], ownAddresses: [WALLET] };
const ids = (input: Parameters<typeof surfaceWarnings>[0]) => surfaceWarnings(input).map((warning) => warning.id);

describe("what surfacing gives away", () => {
  it("nothing stands out: an old deposit of another amount, to a fresh address", () => {
    expect(ids({ ...base, deposits: [{ amount: 5n * SOL, at: NOW - 3 * SOON_AFTER_MS, from: WALLET }] })).toEqual([]);
    expect(ids(base)).toEqual([]);
  });

  it("the same amount as a recent dive-in", () => {
    const deposit = { amount: 2n * SOL, at: NOW - 5 * 24 * HOUR, from: WALLET };
    const warnings = surfaceWarnings({ ...base, deposits: [deposit] });
    expect(warnings).toEqual([{ id: "same-amount", deposit }]);
  });

  it("the same amount less the fee is the same amount: surfacing everything that was put in", () => {
    expect(ids({ ...base, amount: 5n * SOL - 2_500_000n, deposits: [{ amount: 5n * SOL, at: NOW - 5 * 24 * HOUR, from: WALLET }] })).toEqual(["same-amount"]);
  });

  it("an equal amount from long ago no longer stands out", () => {
    expect(ids({ ...base, deposits: [{ amount: 2n * SOL, at: NOW - SAME_AMOUNT_MS - 1, from: WALLET }] })).toEqual([]);
  });

  it("shortly after diving in", () => {
    expect(ids({ ...base, deposits: [{ amount: 5n * SOL, at: NOW - HOUR, from: WALLET }] })).toEqual(["soon-after"]);
    expect(ids({ ...base, deposits: [{ amount: 5n * SOL, at: NOW - SOON_AFTER_MS, from: WALLET }] })).toEqual(["soon-after"]);
    expect(ids({ ...base, deposits: [{ amount: 5n * SOL, at: NOW - SOON_AFTER_MS - 1, from: WALLET }] })).toEqual([]);
  });

  it("to the address the deposit came from", () => {
    const deposit = { amount: 5n * SOL, at: NOW - 10 * 24 * HOUR, from: WALLET };
    expect(surfaceWarnings({ ...base, destination: WALLET, deposits: [deposit] })).toEqual([{ id: "same-address", deposit }]);
  });

  it("to another address connected on this device, even without a recorded deposit", () => {
    expect(surfaceWarnings({ ...base, destination: WALLET })).toEqual([{ id: "same-address" }]);
  });

  it("all three at once, most telling first, pointing at the newest deposit", () => {
    const old = { amount: 2n * SOL, at: NOW - 3 * 24 * HOUR, from: WALLET };
    const recent = { amount: 2n * SOL, at: NOW - HOUR, from: WALLET };
    const warnings = surfaceWarnings({ ...base, destination: WALLET, deposits: [old, recent] });
    expect(warnings.map((warning) => warning.id)).toEqual(["same-address", "same-amount", "soon-after"]);
    expect(warnings.every((warning) => warning.deposit === recent)).toBe(true);
  });

  it("a deposit dated in the future (a wrong clock) is not 'soon after'", () => {
    expect(ids({ ...base, deposits: [{ amount: 9n * SOL, at: NOW + HOUR, from: WALLET }] })).toEqual([]);
  });
});
