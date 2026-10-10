import { describe, expect, it } from "vitest";

import { MAX_FLOWS, MAX_INSTRUCTIONS_PER_TRANSACTION, MAX_TOKEN_BALANCES_PER_TRANSACTION, buildReport, extractFlows, extractFlowsDetailed } from "../src/index.js";
import type { ParsedTransactionLike } from "../src/index.js";
import {
  ALICE,
  BOB,
  ME,
  MY_USDC_ACCOUNT,
  T0,
  THEIR_USDC_ACCOUNT,
  USDC,
  systemTransfer,
  tokenTransfer,
  tokenTransferChecked,
  tx,
} from "./fixtures.js";

describe("extractFlows", () => {
  it("returns nothing for no transactions", () => {
    expect(extractFlows([], ME)).toEqual([]);
  });

  it("reads an outgoing SOL transfer, converting lamports to SOL", () => {
    const flows = extractFlows([tx([systemTransfer(ME, ALICE, 1_500_000_000)], { sig: "s1" })], ME);
    expect(flows).toEqual([{ sig: "s1", time: T0, dir: "out", counterparty: ALICE, amount: 1.5, asset: "SOL" }]);
  });

  it("reads an incoming SOL transfer", () => {
    const flows = extractFlows([tx([systemTransfer(ALICE, ME, 250_000_000)], { sig: "s2" })], ME);
    expect(flows).toEqual([{ sig: "s2", time: T0, dir: "in", counterparty: ALICE, amount: 0.25, asset: "SOL" }]);
  });

  it("ignores SOL transfers between other wallets", () => {
    expect(extractFlows([tx([systemTransfer(ALICE, BOB, 1)])], ME)).toEqual([]);
  });

  it("records a transfer to self as both an outflow and an inflow", () => {
    const flows = extractFlows([tx([systemTransfer(ME, ME, 1_000_000_000)])], ME);
    expect(flows.map((f) => f.dir)).toEqual(["out", "in"]);
  });

  it("includes transfers made by inner instructions", () => {
    const flows = extractFlows([tx([], { inner: [systemTransfer(ME, BOB, 2_000_000_000)] })], ME);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ dir: "out", counterparty: BOB, amount: 2 });
  });

  it("uses time 0 when the RPC reports no block time", () => {
    const flows = extractFlows([tx([systemTransfer(ME, ALICE, 1)], { blockTime: null })], ME);
    expect(flows[0]?.time).toBe(0);
  });

  it("skips undecoded instructions, string-parsed instructions and other system instructions", () => {
    const flows = extractFlows(
      [
        tx([
          { programId: "SomeProgram", accounts: [], data: "3Bxs" } as never,
          { program: "spl-memo", parsed: "hello" },
          { program: "system", parsed: null },
          { program: "system", parsed: { type: "transfer" } },
          { program: "system", parsed: { type: "createAccount", info: { source: ME, newAccount: ALICE, lamports: 5 } } },
          { program: "stake", parsed: { type: "transfer", info: { source: ME, destination: ALICE, lamports: 5 } } },
        ]),
      ],
      ME,
    );
    expect(flows).toEqual([]);
  });

  it("reads an outgoing token transfer signed by the owner, naming the destination token account", () => {
    const ix = tokenTransferChecked({
      authority: ME,
      source: MY_USDC_ACCOUNT,
      destination: THEIR_USDC_ACCOUNT,
      mint: USDC,
      tokenAmount: { amount: "25000000", decimals: 6, uiAmount: 25 },
    });
    const flows = extractFlows([tx([ix], { sig: "t1", tokenOwners: [ME, ALICE] })], ME);
    expect(flows).toEqual([{ sig: "t1", time: T0, dir: "out", counterparty: THEIR_USDC_ACCOUNT, amount: 25, asset: USDC }]);
  });

  it("treats a multisig authority as the owner sending", () => {
    const ix = tokenTransfer({ multisigAuthority: ME, source: MY_USDC_ACCOUNT, destination: THEIR_USDC_ACCOUNT, amount: "7" });
    expect(extractFlows([tx([ix])], ME)[0]).toMatchObject({ dir: "out", counterparty: THEIR_USDC_ACCOUNT });
  });

  it("falls back to the raw amount and the asset 'SPL' for an unchecked transfer", () => {
    const ix = tokenTransfer({ authority: ME, source: MY_USDC_ACCOUNT, destination: THEIR_USDC_ACCOUNT, amount: "1234" });
    expect(extractFlows([tx([ix])], ME)[0]).toMatchObject({ amount: 1234, asset: "SPL" });
  });

  it("reads an incoming token transfer when the owner holds a token balance in the transaction", () => {
    const ix = tokenTransferChecked({
      authority: ALICE,
      source: THEIR_USDC_ACCOUNT,
      destination: MY_USDC_ACCOUNT,
      mint: USDC,
      tokenAmount: { uiAmount: 3.5 },
    });
    const flows = extractFlows([tx([ix], { sig: "t2", tokenOwners: [ALICE, ME] })], ME);
    expect(flows).toEqual([{ sig: "t2", time: T0, dir: "in", counterparty: ALICE, amount: 3.5, asset: USDC }]);
  });

  it("names the source token account when an incoming transfer has no single authority", () => {
    const ix = tokenTransfer({ multisigAuthority: ALICE, source: THEIR_USDC_ACCOUNT, destination: MY_USDC_ACCOUNT, amount: "9" });
    expect(extractFlows([tx([ix], { tokenOwners: [ME] })], ME)[0]).toMatchObject({ dir: "in", counterparty: THEIR_USDC_ACCOUNT });
  });

  it("ignores token transfers in transactions where the owner holds no token balance", () => {
    const ix = tokenTransfer({ authority: ALICE, source: THEIR_USDC_ACCOUNT, destination: MY_USDC_ACCOUNT, amount: "9" });
    expect(extractFlows([tx([ix], { tokenOwners: [ALICE, BOB] })], ME)).toEqual([]);
  });

  it("handles Token-2022 transfers the same way", () => {
    const ix = tokenTransferChecked(
      { authority: ME, source: MY_USDC_ACCOUNT, destination: THEIR_USDC_ACCOUNT, mint: USDC, tokenAmount: { uiAmount: 2 } },
      "spl-token-2022",
    );
    expect(extractFlows([tx([ix])], ME)).toHaveLength(1);
  });

  it("treats a zero or missing token amount as 0", () => {
    const ix = tokenTransferChecked({ authority: ME, destination: THEIR_USDC_ACCOUNT, mint: USDC, tokenAmount: { uiAmount: null } });
    expect(extractFlows([tx([ix])], ME)[0]?.amount).toBe(0);
  });

  it("keeps every flow of a transaction under its first signature, in instruction order", () => {
    const parsed = tx([systemTransfer(ALICE, ME, 1_000_000_000), systemTransfer(ME, BOB, 1_000_000_000)], { sig: "multi" });
    const flows = extractFlows([parsed], ME);
    expect(flows.map((f) => [f.sig, f.dir, f.counterparty])).toEqual([
      ["multi", "in", ALICE],
      ["multi", "out", BOB],
    ]);
  });

  it("does not modify its input", () => {
    const input = [tx([systemTransfer(ME, ALICE, 1)])];
    const before = JSON.stringify(input);
    extractFlows(input, ME);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("extractFlows on transactions an endpoint sized", () => {
  const out = (k: number) => systemTransfer(ME, ALICE, k + 1);

  it("says nothing about limits for ordinary transactions", () => {
    const result = extractFlowsDetailed([tx([out(0), out(1)], { inner: [out(2)] })], ME);
    expect(result.flows).toHaveLength(3);
    expect("limitsHit" in result).toBe(false);
  });

  it("reads a transaction with exactly the most instructions in full", () => {
    const top = Array.from({ length: MAX_INSTRUCTIONS_PER_TRANSACTION }, (_, k) => out(k));
    const result = extractFlowsDetailed([tx(top)], ME);
    expect(result.flows).toHaveLength(MAX_INSTRUCTIONS_PER_TRANSACTION);
    expect(result.limitsHit).toBeUndefined();
  });

  it("reads only the first instructions of a longer one, in order, and says the transaction was cut", () => {
    const top = Array.from({ length: MAX_INSTRUCTIONS_PER_TRANSACTION + 300 }, (_, k) => out(k));
    const transactions = [tx(top), tx([out(7)])];
    const result = extractFlowsDetailed(transactions, ME);
    // The long transaction is cut; the one after it is read as usual.
    expect(result.flows).toHaveLength(MAX_INSTRUCTIONS_PER_TRANSACTION + 1);
    expect(result.flows[0]?.amount).toBe(1e-9);
    expect(result.flows[MAX_INSTRUCTIONS_PER_TRANSACTION - 1]?.amount).toBe(MAX_INSTRUCTIONS_PER_TRANSACTION * 1e-9);
    expect(result.limitsHit).toEqual({ transactionsCut: 1, flowsCapped: false });
    expect(extractFlows(transactions, ME)).toEqual(result.flows);
  });

  it("counts inner instructions towards the same bound, top-level ones first", () => {
    const top = Array.from({ length: 10 }, (_, k) => out(k));
    const parsed: ParsedTransactionLike = {
      ...tx(top),
      meta: {
        err: null,
        // Three groups of 300: the bound falls in the second.
        innerInstructions: [0, 1, 2].map((g) => ({ instructions: Array.from({ length: 300 }, (_, k) => out(1_000 * (g + 1) + k)) })),
        postTokenBalances: [],
      },
    };
    const result = extractFlowsDetailed([parsed], ME);
    // 10 top-level, then 300 (and one for the group), then what is left of the 512: 512 - 10 - 1 - 300 - 1 = 200.
    expect(result.flows).toHaveLength(10 + 300 + 200);
    expect(result.limitsHit).toEqual({ transactionsCut: 1, flowsCapped: false });
  });

  it("does not walk a transaction of a million empty inner groups to its end", () => {
    const parsed: ParsedTransactionLike = { ...tx([out(0)]), meta: { err: null, innerInstructions: new Array(1_000_000).fill({ instructions: [] }), postTokenBalances: [] } };
    const started = performance.now();
    const result = extractFlowsDetailed(new Array<ParsedTransactionLike>(1_000).fill(parsed), ME);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.flows).toHaveLength(1_000);
    expect(result.limitsHit).toEqual({ transactionsCut: 1_000, flowsCapped: false });
  });

  it("stops at the most flows it keeps, mid-transaction if need be, and says so", () => {
    // 120 transactions of 500 transfers each: 60,000 transfers, 10,000 more than are kept.
    const each = Array.from({ length: 500 }, (_, k) => out(k));
    const transactions = Array.from({ length: 120 }, (_, n) => tx(each, { sig: `t${n}` }));
    const result = extractFlowsDetailed(transactions, ME);
    expect(result.flows).toHaveLength(MAX_FLOWS);
    expect(result.flows[MAX_FLOWS - 1]?.sig).toBe("t99");
    expect(result.limitsHit).toEqual({ transactionsCut: 0, flowsCapped: true });

    // A transfer to oneself is two flows; the cap can fall between them.
    const self = Array.from({ length: 501 }, () => systemTransfer(ME, ME, 5));
    const odd = extractFlowsDetailed([tx([out(0)]), ...Array.from({ length: 60 }, () => tx(self))], ME);
    expect(odd.flows).toHaveLength(MAX_FLOWS);
    expect(odd.limitsHit?.flowsCapped).toBe(true);
  });

  it("looks at the token balances of a transaction once, not once per instruction, and only at so many", () => {
    const incoming = tokenTransfer({ authority: ALICE, source: THEIR_USDC_ACCOUNT, destination: MY_USDC_ACCOUNT, amount: "5" });
    // The wallet's balance is the last of 100,000; 500 incoming transfers each ask whether it has one.
    const balances = [...new Array(99_999).fill({ owner: BOB }), { owner: ME }];
    const parsed: ParsedTransactionLike = { ...tx(new Array(500).fill(incoming)), meta: { err: null, innerInstructions: [], postTokenBalances: balances } };
    const started = performance.now();
    const result = extractFlowsDetailed(new Array<ParsedTransactionLike>(200).fill(parsed), ME);
    // 200 x 500 x 100,000 comparisons is ten thousand million. This is 200 x 1024.
    expect(performance.now() - started).toBeLessThan(1_000);
    // The balance lies beyond the bound, so the transfers are not seen as incoming, and the report says the transactions were cut.
    expect(result.flows).toEqual([]);
    expect(result.limitsHit).toEqual({ transactionsCut: 200, flowsCapped: false });

    // Within the bound it is found, wherever it is.
    const near = [...new Array(MAX_TOKEN_BALANCES_PER_TRANSACTION - 1).fill({ owner: BOB }), { owner: ME }];
    const found = extractFlowsDetailed([{ ...tx([incoming]), meta: { err: null, innerInstructions: [], postTokenBalances: near } }], ME);
    expect(found.flows).toHaveLength(1);
    expect(found.limitsHit).toBeUndefined();
  });

  it("does not fail on a transaction whose lists are not lists", () => {
    const odd = [
      { blockTime: T0, transaction: { signatures: ["a"], message: { instructions: null } }, meta: { innerInstructions: "x", postTokenBalances: 7 } },
      { blockTime: T0, transaction: { signatures: ["b"], message: { instructions: [null, 3, "x", out(0)] } }, meta: { innerInstructions: [null, { instructions: null }, { instructions: [out(1)] }] } },
    ] as unknown as ParsedTransactionLike[];
    expect(extractFlows(odd, ME).map((f) => f.sig)).toEqual(["b", "b"]);
  });

  it("carries the limits into the report only when one was hit", () => {
    const top = Array.from({ length: MAX_INSTRUCTIONS_PER_TRANSACTION + 1 }, (_, k) => out(k));
    const { flows, limitsHit } = extractFlowsDetailed([tx(top)], ME);
    const cut = buildReport({ address: ME, scannedTransactions: 1, flows, limitsHit });
    expect(cut.limitsHit).toEqual({ transactionsCut: 1, flowsCapped: false });
    expect(cut.transfers).toBe(MAX_INSTRUCTIONS_PER_TRANSACTION);

    const whole = buildReport({ address: ME, scannedTransactions: 1, flows: extractFlows([tx([out(0)])], ME) });
    expect(Object.keys(whole).sort()).toEqual(["address", "findings", "scannedTransactions", "score", "transfers"]);
  });
});
