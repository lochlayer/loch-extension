import type { Flow, ParsedInstructionLike, ParsedTransactionLike } from "../src/index.js";

// Real, valid base58 public keys so the same fixtures work with PublicKey.
export const ME = "So11111111111111111111111111111111111111112";
export const ALICE = "Vote111111111111111111111111111111111111111";
export const BOB = "Stake11111111111111111111111111111111111111";
export const CAROL = "Config1111111111111111111111111111111111111";
export const DAVE = "SysvarC1ock11111111111111111111111111111111";
export const ERIN = "SysvarRent111111111111111111111111111111111";
export const FRANK = "SysvarS1otHashes111111111111111111111111111";
export const EXCHANGE = "SysvarRecentB1ockHashes11111111111111111111";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MY_USDC_ACCOUNT = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const THEIR_USDC_ACCOUNT = "ComputeBudget111111111111111111111111111111";

/** 2024-01-01T00:00:00Z. */
export const T0 = 1_704_067_200;
/** Unix seconds for the given UTC hour on day `day` after T0. */
export const at = (hour: number, day = 0, minute = 0) => T0 + day * 86_400 + hour * 3_600 + minute * 60;

let counter = 0;
const nextSig = () => `sig${++counter}`;

/** Builds a flow with sensible defaults. */
export function flow(over: Partial<Flow> = {}): Flow {
  return { sig: nextSig(), time: T0, dir: "out", counterparty: ALICE, amount: 1, asset: "SOL", ...over };
}

/** `n` flows that share everything in `over`. */
export function flows(n: number, over: Partial<Flow> = {}): Flow[] {
  return Array.from({ length: n }, () => flow(over));
}

export function systemTransfer(source: string, destination: string, lamports: number): ParsedInstructionLike {
  return { program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source, destination, lamports } } };
}

export function tokenTransfer(info: Record<string, unknown>, program = "spl-token"): ParsedInstructionLike {
  return { program, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", parsed: { type: "transfer", info } };
}

export function tokenTransferChecked(info: Record<string, unknown>, program = "spl-token"): ParsedInstructionLike {
  return { program, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", parsed: { type: "transferChecked", info } };
}

/** Builds a parsed transaction around the given top-level instructions. */
export function tx(
  instructions: ParsedInstructionLike[],
  over: {
    sig?: string;
    blockTime?: number | null;
    inner?: ParsedInstructionLike[];
    tokenOwners?: string[];
    err?: unknown;
  } = {},
): ParsedTransactionLike {
  return {
    blockTime: over.blockTime === undefined ? T0 : over.blockTime,
    transaction: { signatures: [over.sig ?? nextSig()], message: { instructions } },
    meta: {
      err: over.err ?? null,
      innerInstructions: over.inner ? [{ instructions: over.inner }] : [],
      postTokenBalances: (over.tokenOwners ?? []).map((owner) => ({ owner })),
    },
  };
}
