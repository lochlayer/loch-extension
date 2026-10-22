import { inspect } from "node:util";

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { PROGRAM_ERROR_NAMES } from "../src/errors.js";
import {
  ConsolidationRequiredError,
  FeeTooHighError,
  InsufficientBalanceError,
  LochError,
  NullifierSpentError,
  PROGRAM_ERROR_CODES,
  PROGRAM_ID,
  ProgramError,
  UnknownRootError,
  configPda,
  fieldToBytes,
  nullifierPda,
  parseProgramError,
} from "../src/index.js";

const program = PROGRAM_ID.toBase58();

const anchorLogs = (name: string, number: number, message: string) => [
  "Program ComputeBudget111111111111111111111111111111 invoke [1]",
  "Program ComputeBudget111111111111111111111111111111 success",
  `Program ${program} invoke [1]`,
  "Program log: Instruction: Transact",
  `Program log: AnchorError thrown in programs/loch_pool/src/lib.rs:70. Error Code: ${name}. Error Number: ${number}. Error Message: ${message}.`,
  `Program ${program} consumed 12345 of 300000 compute units`,
  `Program ${program} failed: custom program error: 0x${number.toString(16)}`,
];

describe("parseProgramError", () => {
  it("knows the program's error codes", () => {
    expect(PROGRAM_ERROR_CODES).toEqual({
      InvalidProof: 6000,
      UnknownRoot: 6001,
      TreeFull: 6002,
      RecipientMismatch: 6003,
      RelayerMismatch: 6004,
      MissingScreenerSignature: 6005,
      DepositTooLarge: 6006,
      DepositsPaused: 6007,
      EncryptedOutputTooLarge: 6008,
      AmountOutOfRange: 6009,
      PoseidonError: 6010,
      NonCanonicalFieldElement: 6011,
      ZeroProofElement: 6012,
      InvalidProgramData: 6013,
      NotUpgradeAuthority: 6014,
      TreeNotPairAligned: 6015,
      InvalidDestination: 6016,
      InvalidEncryptedOutputLength: 6017,
      AssetMismatch: 6018,
      MissingAsset: 6019,
      AssetDepositsDisabled: 6020,
      InvalidVault: 6021,
      InvalidTokenProgram: 6022,
      InvalidTokenAccount: 6023,
      InvalidMint: 6024,
      InvalidRouter: 6025,
      InvalidEscrow: 6026,
      SwapInputNotSpent: 6027,
      SwapOutputTooSmall: 6028,
      InvalidSwap: 6029,
    });
  });

  it.each(PROGRAM_ERROR_NAMES.map((name, i) => [name, 6000 + i] as const))("maps %s (%i) from Anchor logs", (name, number) => {
    const error = parseProgramError(anchorLogs(name, number, "whatever the program says"));
    expect(error).toBeInstanceOf(ProgramError);
    expect(error).toBeInstanceOf(LochError);
    expect(error).toMatchObject({ code: "PROGRAM_ERROR", kind: name, number });
    expect(error!.logs).toHaveLength(7);
  });

  it("maps UnknownRoot to its own class, so callers can re-sync and re-prove", () => {
    const error = parseProgramError(anchorLogs("UnknownRoot", 6001, "Merkle root is not in recent history"));
    expect(error).toBeInstanceOf(UnknownRootError);
    expect(error!.message).toMatch(/sync and prove again/);
    expect(parseProgramError(anchorLogs("InvalidProof", 6000, "Proof verification failed"))).not.toBeInstanceOf(UnknownRootError);
  });

  it("reads a transaction error object", () => {
    expect(parseProgramError({ InstructionError: [1, { Custom: 6001 }] })).toBeInstanceOf(UnknownRootError);
    expect(parseProgramError({ err: { InstructionError: [2, { Custom: 6000 }] }, logs: null })).toMatchObject({ kind: "InvalidProof" });
    expect(parseProgramError({ value: { err: { InstructionError: [1, { Custom: 6007 }] }, logs: [] } })).toMatchObject({ kind: "DepositsPaused" });
  });

  it("reads the hex code from an error message", () => {
    const message = "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1771";
    expect(parseProgramError(message)).toBeInstanceOf(UnknownRootError);
    expect(parseProgramError(new Error(message))).toBeInstanceOf(UnknownRootError);
    expect(parseProgramError(new Error("failed to send transaction: custom program error: 0x1776"))).toMatchObject({ kind: "DepositTooLarge", number: 6006 });
  });

  it("reads a SendTransactionError-like object", () => {
    const error = Object.assign(new Error("Simulation failed."), { logs: anchorLogs("RelayerMismatch", 6004, "Relayer does not match ext data") });
    expect(parseProgramError(error)).toMatchObject({ kind: "RelayerMismatch", number: 6004 });
    const nested = { message: "send failed", transactionLogs: anchorLogs("TreeFull", 6002, "Merkle tree is full") };
    expect(parseProgramError(nested)).toMatchObject({ kind: "TreeFull" });
  });

  it("recognises a spent nullifier: the system program's 'already in use'", () => {
    const logs = [
      `Program ${program} invoke [1]`,
      "Program log: Instruction: Transact",
      "Program 11111111111111111111111111111111 invoke [2]",
      "Allocate: account Address { address: 7Vbmv1jt4vyuqBZcpYPpnVhrqVe5e6ZPb6JxDcffRHUM, base: None } already in use",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x0",
      `Program ${program} consumed 9000 of 300000 compute units`,
      `Program ${program} failed: custom program error: 0x0`,
    ];
    const error = parseProgramError({ err: { InstructionError: [1, { Custom: 0 }] }, logs });
    expect(error).toBeInstanceOf(NullifierSpentError);
    expect(error).toMatchObject({ kind: "NullifierAlreadySpent", number: 0 });
    expect(parseProgramError(logs)).toBeInstanceOf(NullifierSpentError);
  });

  describe("'already in use' is a spent nullifier only when the account is a nullifier account", () => {
    const system = "11111111111111111111111111111111";
    const inUse = (account: string, how = "Allocate") => `${how}: account Address { address: ${account}, base: None } already in use`;
    const err = (index: number) => ({ InstructionError: [index, { Custom: 0 }] });
    const nullifiers: [bigint, bigint] = [123_456_789n, 987_654_321n];
    const record = nullifierPda(nullifiers[1]).toBase58();
    /** The logs of a failed loch_pool instruction that asked the system program to create `account`. */
    const poolLogs = (instruction: string, account: string) => [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program ComputeBudget111111111111111111111111111111 success",
      `Program ${program} invoke [1]`,
      `Program log: Instruction: ${instruction}`,
      `Program ${system} invoke [2]`,
      inUse(account),
      `Program ${system} failed: custom program error: 0x0`,
      `Program ${program} consumed 9000 of 300000 compute units`,
      `Program ${program} failed: custom program error: 0x0`,
    ];

    it("a second initialize is not a spent nullifier: the account that exists is the config", () => {
      const logs = poolLogs("Initialize", configPda().toBase58());
      for (const source of [{ err: err(0), logs }, logs, Object.assign(new Error("Simulation failed."), { logs, transactionLogs: logs })]) {
        const error = parseProgramError(source);
        expect(error).toBeInstanceOf(ProgramError);
        expect(error).not.toBeInstanceOf(NullifierSpentError);
        expect(error).toMatchObject({ code: "PROGRAM_ERROR", kind: "AccountAlreadyInUse", number: 0 });
        expect(error!.message).toMatch(/not one of the transaction's nullifier accounts/);
        expect(error!.logs).toEqual(expect.arrayContaining(logs));
      }
      // Any other instruction of the program likewise: only transact creates nullifier records.
      expect(parseProgramError(poolLogs("UpdateConfig", record))).toMatchObject({ kind: "AccountAlreadyInUse" });
    });

    it("under transact it is a nullifier record: the only kind of account transact creates", () => {
      // The first record is created, the second one exists.
      const logs = [...poolLogs("Transact", record).slice(0, 4), `Program ${system} invoke [2]`, `Program ${system} success`, ...poolLogs("Transact", record).slice(4)];
      const error = parseProgramError({ err: err(1), logs });
      expect(error).toBeInstanceOf(NullifierSpentError);
      expect(error).toMatchObject({ kind: "NullifierAlreadySpent", number: 0 });
      // A line the handler logs later does not rename the instruction.
      const renamed = [...logs.slice(0, 4), "Program log: Instruction: Initialize", ...logs.slice(4)];
      expect(parseProgramError(renamed)).toBeInstanceOf(NullifierSpentError);
      // Nor does a program that ran, and finished, before it.
      const earlier = [`Program ${program} invoke [1]`, "Program log: Instruction: Initialize", `Program ${program} success`, ...logs];
      expect(parseProgramError(earlier)).toBeInstanceOf(NullifierSpentError);
    });

    it("a system instruction of the transaction itself is not the pool spending a note", () => {
      const logs = [`Program ${system} invoke [1]`, inUse(record, "Create Account"), `Program ${system} failed: custom program error: 0x0`];
      expect(parseProgramError({ err: err(0), logs })).toMatchObject({ kind: "AccountAlreadyInUse", number: 0 });
    });

    it("given the transaction's nullifiers, the account the log names is compared with their accounts", () => {
      const line = [inUse(record)];
      // No invoke lines at all: the nullifiers decide.
      expect(parseProgramError({ err: err(1), logs: line }, { nullifiers })).toBeInstanceOf(NullifierSpentError);
      expect(parseProgramError({ err: err(1), logs: line }, { nullifiers: nullifiers.map((value) => fieldToBytes(value)) })).toBeInstanceOf(NullifierSpentError);
      expect(parseProgramError({ err: err(1), logs: line }, { nullifiers: [1n, 2n] })).toMatchObject({ kind: "AccountAlreadyInUse" });
      // The nullifier accounts of another deployment are other accounts.
      const elsewhere = PublicKey.unique();
      expect(parseProgramError(line, { nullifiers, programId: elsewhere })).toMatchObject({ kind: "AccountAlreadyInUse" });
      expect(parseProgramError([inUse(nullifierPda(nullifiers[0], elsewhere).toBase58())], { nullifiers, programId: elsewhere })).toBeInstanceOf(NullifierSpentError);
      // They decide against the shape of the logs too: under Transact, but not this transaction's record; under Initialize, but it is.
      expect(parseProgramError(poolLogs("Transact", configPda().toBase58()), { nullifiers })).toMatchObject({ kind: "AccountAlreadyInUse" });
      expect(parseProgramError(poolLogs("Initialize", record), { nullifiers })).toBeInstanceOf(NullifierSpentError);
      // A value that is no nullifier names no account, and does not throw here.
      expect(parseProgramError(line, { nullifiers: [-1n, 1n << 255n] })).toMatchObject({ kind: "AccountAlreadyInUse" });
      // Without an account in the line there is nothing to compare: the logs around it decide, as without the nullifiers.
      expect(parseProgramError(poolLogs("Initialize", "(not shown)"), { nullifiers })).toMatchObject({ kind: "AccountAlreadyInUse" });
      expect(parseProgramError(["Allocate: account already in use"], { nullifiers })).toBeInstanceOf(NullifierSpentError);
    });

    it("says what it always said when nothing shows which account it was", () => {
      for (const logs of [
        ["Allocate: account already in use"],
        ["already in use"],
        [inUse(record)],
        // The system program's own lines without the program that called it.
        [`Program ${system} invoke [2]`, "Allocate: account Address { address: X, base: None } already in use", `Program ${system} failed: custom program error: 0x0`],
        // A caller that is not an Anchor program, or whose first lines are missing.
        [`Program ${program} invoke [1]`, `Program ${system} invoke [2]`, inUse(record), `Program ${system} failed: custom program error: 0x0`],
      ]) {
        const error = parseProgramError({ err: err(1), logs });
        expect(error, logs.join(" | ")).toBeInstanceOf(NullifierSpentError);
        expect(error).toMatchObject({ kind: "NullifierAlreadySpent", number: 0 });
      }
      expect(parseProgramError(new Error("Allocate: account Address { address: X, base: None } already in use"))).toBeInstanceOf(NullifierSpentError);
      // Custom error 0 without the system program's line is still not a known rejection.
      expect(parseProgramError({ err: err(1), logs: [] })).toMatchObject({ kind: "Unknown", number: 0 });
    });
  });

  it("treats codes it does not know gracefully", () => {
    const appended = parseProgramError(anchorLogs("RootTooOld", 6017, "A variant added later"));
    expect(appended).toMatchObject({ kind: "Unknown", number: 6017 });
    expect(appended!.message).toMatch(/RootTooOld: A variant added later/);
    expect(parseProgramError({ InstructionError: [1, { Custom: 6042 }] })).toMatchObject({ kind: "Unknown", number: 6042 });
    // Anchor's own errors (here: the pool was never initialised) are not loch_pool errors.
    const framework = parseProgramError(anchorLogs("AccountNotInitialized", 3012, "The program expected this account to be already initialized"));
    expect(framework).toMatchObject({ kind: "Unknown", number: 3012 });
    expect(framework!.message).toMatch(/AccountNotInitialized/);
    expect(parseProgramError({ InstructionError: [0, { Custom: 0 }] })).toMatchObject({ kind: "Unknown", number: 0 });
  });

  it("does not trust the table when the logs name a different error for a known number", () => {
    // If the program's enum were ever reordered, the logs win over this SDK's table.
    const error = parseProgramError(anchorLogs("SomethingElse", 6001, "Renumbered"));
    expect(error).not.toBeInstanceOf(UnknownRootError);
    expect(error).toMatchObject({ kind: "Unknown", number: 6001 });
  });

  it("returns null for failures that are not program rejections", () => {
    expect(parseProgramError(new Error("fetch failed"))).toBeNull();
    expect(parseProgramError("Blockhash not found")).toBeNull();
    expect(parseProgramError({ err: "BlockhashNotFound", logs: [] })).toBeNull();
    expect(parseProgramError({ InstructionError: [0, "InvalidAccountData"] })).toBeNull();
    expect(parseProgramError(null)).toBeNull();
    expect(parseProgramError(undefined)).toBeNull();
    expect(parseProgramError(42)).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.cause = cyclic;
    expect(parseProgramError(cyclic)).toBeNull();
  });

  it("names the two rejections that come from the runtime and carry no custom code", () => {
    // A withdrawal below the rent-exempt minimum of its destination: the program ran to the end
    // and logged its events and `success`; the runtime's rent check then failed the transaction.
    const rent = parseProgramError({
      err: { InsufficientFundsForRent: { account_index: 5 } },
      logs: [`Program ${program} invoke [1]`, "Program log: Instruction: Transact", "Program data: AAAA", `Program ${program} success`],
    });
    expect(rent).toBeInstanceOf(ProgramError);
    expect(rent).toMatchObject({ kind: "InsufficientFundsForRent", number: null });
    expect(rent!.logs).toHaveLength(4);
    expect(parseProgramError(new Error("Transaction simulation failed: Transaction results in an account (5) with insufficient funds for rent"))).toMatchObject({
      kind: "InsufficientFundsForRent",
    });

    const budget = parseProgramError({
      err: { InstructionError: [1, "ComputationalBudgetExceeded"] },
      logs: [`Program ${program} invoke [1]`, `Program ${program} consumed 180000 of 180000 compute units`, `Program ${program} failed: exceeded CUs meter at BPF instruction`],
    });
    expect(budget).toMatchObject({ kind: "ComputeBudgetExceeded", number: null });
    expect(parseProgramError({ InstructionError: [2, "ComputationalBudgetExceeded"] })).toMatchObject({ kind: "ComputeBudgetExceeded" });
    expect(parseProgramError(["Program log: x", "Program failed: Computational budget exceeded"])).toMatchObject({ kind: "ComputeBudgetExceeded" });
    // A custom code still wins: this is a program error that happens to mention rent in its logs.
    expect(parseProgramError({ err: { InstructionError: [1, { Custom: 6016 }] }, logs: ["insufficient funds for rent"] })).toMatchObject({ kind: "InvalidDestination", number: 6016 });
  });
});

describe("what logging an error shows", () => {
  const shown = (error: Error) => [inspect(error, { depth: 5 }), JSON.stringify(error), JSON.stringify({ ...error }), String(error), Object.keys(error).join(",")].join("\n");

  it("keeps the balance and the amount being sent out of everything that prints an error", () => {
    const required = 123_456_789_123n;
    const available = 45_678_912_345n;
    const largestPair = 31_415_926_535n;
    for (const error of [new InsufficientBalanceError(required, available), new ConsolidationRequiredError(required, available, largestPair)]) {
      const text = shown(error);
      for (const secret of [required, available, largestPair]) expect(text).not.toContain(secret.toString());
      expect(text).not.toMatch(/required|available|largestPair/);
      // Code that handles the error can still read the amounts.
      expect(error.required).toBe(required);
      expect(error.available).toBe(available);
      expect(error.code).toMatch(/INSUFFICIENT_BALANCE|CONSOLIDATION_REQUIRED/);
      expect(() => ((error as { available: bigint }).available = 0n)).toThrow(TypeError);
    }
    expect(new ConsolidationRequiredError(required, available, largestPair).largestPair).toBe(largestPair);
  });

  it("shows the public values of a refused fee", () => {
    const error = new FeeTooHighError(9_990_000_000n, 5_000_000n);
    expect(error).toBeInstanceOf(LochError);
    expect(error).toMatchObject({ name: "FeeTooHighError", code: "FEE_TOO_HIGH", fee: 9_990_000_000n, maxFee: 5_000_000n });
    expect(error.message).toMatch(/9990000000 lamports exceeds the maximum of 5000000/);
  });
});
