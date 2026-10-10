import { type WalletState, balance } from "@loch/sdk";
import { describe, expect, it } from "vitest";

import {
  type ChainRoots,
  DEPOSIT_TTL_MS,
  type PendingSpend,
  hasLanded,
  lockedCommitments,
  onlyNotes,
  proofExpired,
  reconcilePending,
  shieldedTotals,
  spendExpired,
  spendableNotes,
  withLocks,
} from "../src/background/pending.js";

/** A state with notes of the given amounts. The pending logic reads only what is set here. */
function stateOf(amounts: number[], spent: number[] = [], extraLeaves: string[] = []): WalletState {
  return {
    version: 1,
    programId: "Lochn2sJLT2hkqMrx85siFPXa9VUTAAx9EXmkPiJL2j",
    publicKey: "1",
    leaves: [...amounts.map((_, i) => `${1000 + i}`), ...extraLeaves],
    notes: amounts.map((amount, i) => ({
      leafIndex: i,
      amount: String(amount),
      blinding: "5",
      commitment: `${1000 + i}`,
      nullifier: `${2000 + i}`,
      spent: spent.includes(i),
    })),
    lastSignature: null,
  };
}

const spend = (over: Partial<PendingSpend> = {}): PendingSpend => ({
  flowId: "flow-1",
  kind: "send",
  inputs: ["1000"],
  outputs: ["9001", "9002"],
  leaving: "300",
  arriving: "0",
  createdAt: 1_000_000,
  outcome: "unknown",
  proofs: [{ root: "777", leaves: 10 }],
  ...over,
});

/** The tree account as a node reports it: `leaves` leaves, and these roots in its history. */
const chain = (nextIndex: number, roots: string[]): ChainRoots => ({ nextIndex, roots: [...roots, ...new Array<string>(Math.max(0, 64 - roots.length)).fill("0")] });

const HOUR = 60 * 60 * 1000;

describe("spends between handing over and the next sync", () => {
  it("a handed-over spend locks its notes: they are not offered to another transaction", () => {
    const state = stateOf([500, 700, 900]);
    const pending = [spend({ inputs: ["1000", "1002"] })];
    expect([...lockedCommitments(pending)]).toEqual(["1000", "1002"]);
    expect(spendableNotes(state, pending).map((note) => note.amount)).toEqual([700n]);
    // The SDK's own selection sees the locked notes as spent.
    const locked = withLocks(state, pending);
    expect(balance(locked)).toBe(700n);
    // The state that is saved is not changed by taking locks.
    expect(balance(state)).toBe(2100n);
    expect(state.notes.every((note) => !note.spent)).toBe(true);
  });

  it("a flow that proves again is shown only the notes of its first proof", () => {
    const state = stateOf([500, 700, 900]);
    const only = onlyNotes(state, ["1001"]);
    expect(only.notes.filter((note) => !note.spent).map((note) => note.commitment)).toEqual(["1001"]);
    expect(balance(only)).toBe(700n);
    expect(state.notes.every((note) => !note.spent)).toBe(true);
  });

  it("the displayed balance counts what is on its way out, and never shows more than there is", () => {
    const state = stateOf([500, 700, 900]);
    const totals = shieldedTotals(state, [spend({ inputs: ["1000"], leaving: "300" })]);
    expect(totals).toMatchObject({ confirmed: 2100n, expected: 1800n, spendable: 1600n, largestPair: 1600n, settling: 1, notes: 3 });
    // A deposit on its way in is not counted before the chain shows it.
    const incoming = shieldedTotals(state, [spend({ kind: "dive", inputs: [], leaving: "0", arriving: "5000", proofs: undefined })]);
    expect(incoming.expected).toBe(2100n);
    expect(shieldedTotals(state, []).expected).toBe(2100n);
    expect(shieldedTotals(stateOf([100]), [spend({ leaving: "500" })]).expected).toBe(0n);
    // A spend whose notes this state does not hold (another cluster) takes nothing off this balance.
    expect(shieldedTotals(state, [spend({ inputs: ["4242"], leaving: "300" })])).toMatchObject({ expected: 2100n, settling: 0 });
  });

  it("landed: its outputs are leaves of the synced tree and its notes are spent", () => {
    const state = stateOf([500], [0], ["9001", "9002"]);
    const result = reconcilePending([spend()], state, 1_000_001);
    expect(result.landed.map((entry) => entry.flowId)).toEqual(["flow-1"]);
    expect(result.remaining).toEqual([]);
    expect(result.released).toEqual([]);
  });

  it("output commitments in the tree are not enough while the notes are unspent", () => {
    // Anyone who knows a note can put its commitment into the tree with a deposit of their own.
    const state = stateOf([500], [], ["9001"]);
    expect(hasLanded(spend(), state)).toBe(false);
    expect(reconcilePending([spend()], state, 1_000_001).remaining).toHaveLength(1);
  });

  it("a flow that proved twice lands when either proof's outputs appear", () => {
    const both = spend({ outputs: ["9001", "9002", "9003", "9004"], proofs: [{ root: "777", leaves: 10 }, { root: "888", leaves: 12 }] });
    expect(hasLanded(both, stateOf([500], [0], ["9003", "9004"]))).toBe(true);
    expect(hasLanded(both, stateOf([500], [0], ["9001", "9002"]))).toBe(true);
  });

  it("stays reserved however long it takes, while its root is in the program's history", () => {
    for (const age of [3 * 60 * 1000 + 1, HOUR, 72 * HOUR]) {
      const result = reconcilePending([spend()], stateOf([500]), 1_000_000 + age, chain(20, ["555", "777", "999"]));
      expect(result.remaining, `after ${age} ms`).toHaveLength(1);
      expect(result.released).toEqual([]);
    }
  });

  it("stays reserved when the root history could not be read", () => {
    expect(reconcilePending([spend()], stateOf([500]), 1_000_000 + 72 * HOUR, null).remaining).toHaveLength(1);
    expect(spendExpired(spend(), null)).toBe(false);
  });

  it("released once every root its proofs name has left the on-chain history", () => {
    const gone = chain(200, ["111", "222"]);
    expect(reconcilePending([spend()], stateOf([500]), 1_000_001, gone).released).toHaveLength(1);
    // Two proofs: one of them is still in the history, so the notes stay reserved.
    const twice = spend({ proofs: [{ root: "777", leaves: 10 }, { root: "222", leaves: 12 }] });
    expect(reconcilePending([twice], stateOf([500]), 1_000_001, gone).remaining).toHaveLength(1);
    expect(reconcilePending([twice], stateOf([500]), 1_000_001, chain(300, ["333"])).released).toHaveLength(1);
  });

  it("a node that lags behind the proof's state has not dropped the root: it has not seen it yet", () => {
    const proof = { root: "777", leaves: 10 };
    expect(proofExpired(proof, chain(8, ["111"]))).toBe(false);
    expect(proofExpired(proof, chain(10, ["777"]))).toBe(false);
    expect(proofExpired(proof, chain(12, ["777", "888"]))).toBe(false);
    expect(proofExpired(proof, chain(140, ["888"]))).toBe(true);
  });

  it("a spend recorded without its root is held until the history cannot contain it", () => {
    const old = { root: null, leaves: 10 };
    expect(proofExpired(old, chain(10 + 127, ["1"]))).toBe(false);
    expect(proofExpired(old, chain(10 + 128, ["1"]))).toBe(true);
  });

  it("released when it never left this device", () => {
    const result = reconcilePending([spend({ outcome: "refused" })], stateOf([500]), 1_000_001);
    expect(result.released).toHaveLength(1);
    expect(lockedCommitments([spend({ outcome: "refused" })]).size).toBe(0);
  });

  it("released when something else spent its input (another device)", () => {
    const result = reconcilePending([spend()], stateOf([500], [0]), 1_000_001, chain(20, ["777"]));
    expect(result.released).toHaveLength(1);
  });

  it("a deposit is a signed transaction: it is released by the clock, once its blockhash cannot be valid", () => {
    const deposit = spend({ kind: "dive", inputs: [], proofs: undefined });
    expect(reconcilePending([deposit], stateOf([500]), 1_000_000 + DEPOSIT_TTL_MS).remaining).toHaveLength(1);
    expect(reconcilePending([deposit], stateOf([500]), 1_000_000 + DEPOSIT_TTL_MS + 1).released).toHaveLength(1);
    // And lands on its outputs alone: it spends nothing.
    expect(reconcilePending([deposit], stateOf([500], [], ["9001"]), 1_000_001).landed).toHaveLength(1);
  });

  it("landing wins over everything else", () => {
    const state = stateOf([500], [0], ["9002"]);
    const result = reconcilePending([spend({ outcome: "refused", createdAt: 0 })], state, 10 * HOUR, chain(500, ["1"]));
    expect(result.landed).toHaveLength(1);
  });

  it("several pending spends are sorted independently", () => {
    const state = stateOf([500, 700, 900], [0], ["9001"]);
    const result = reconcilePending(
      [
        spend({ flowId: "a" }),
        spend({ flowId: "b", inputs: ["1001"], outputs: ["8001", "8002"], proofs: [{ root: "222", leaves: 10 }] }),
        spend({ flowId: "c", inputs: ["1002"], outputs: ["7001", "7002"], proofs: [{ root: "777", leaves: 10 }] }),
      ],
      state,
      1_000_001,
      chain(200, ["777"]),
    );
    expect(result.landed.map((e) => e.flowId)).toEqual(["a"]);
    expect(result.released.map((e) => e.flowId)).toEqual(["b"]);
    expect(result.remaining.map((e) => e.flowId)).toEqual(["c"]);
  });
});
