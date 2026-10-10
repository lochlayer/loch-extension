import type { Flow, ParsedInstructionLike, ParsedTransactionLike, ScanLimitsHit } from "./types.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Most instructions read from one transaction, top-level and inner together.
 * The rest of a longer transaction is not read. The cluster itself allows 64
 * instructions in a transaction's whole trace, and a transaction is at most
 * 1232 bytes, so no real one comes near this; an endpoint that sends more is
 * making it up.
 */
export const MAX_INSTRUCTIONS_PER_TRANSACTION = 512;

/**
 * Most token balances looked at in one transaction to tell whether the wallet
 * holds one. A transaction names at most 256 accounts.
 */
export const MAX_TOKEN_BALANCES_PER_TRANSACTION = 1024;

/**
 * Most transfers kept from one set of transactions. Reading stops there. A
 * full scan is 1000 transactions, and a wallet's transaction carries a handful
 * of transfers; this is fifty for every one of the thousand.
 */
export const MAX_FLOWS = 50_000;

/** What {@link extractFlowsDetailed} returns. */
export type ExtractedFlows = {
  flows: Flow[];
  /** Present only when a bound was hit; see {@link ScanLimitsHit}. */
  limitsHit?: ScanLimitsHit;
};

/**
 * Pulls every SOL and SPL token transfer that touches `ownerAddress` out of a
 * list of `jsonParsed` transactions, including transfers made by inner
 * (cross-program) instructions.
 *
 * Pure: reads plain data, returns plain data, never touches the network.
 *
 * The transactions come from an RPC endpoint, which decides how large they
 * are. No more than {@link MAX_INSTRUCTIONS_PER_TRANSACTION} instructions are
 * read from one transaction and no more than {@link MAX_FLOWS} transfers are
 * returned; use {@link extractFlowsDetailed} to learn whether either bound was
 * hit.
 *
 * @param parsedTransactions Transactions as returned by `getParsedTransactions`
 *   or by raw `getTransaction` with `encoding: "jsonParsed"`.
 * @param ownerAddress The wallet being scanned, base58.
 */
export function extractFlows(parsedTransactions: readonly ParsedTransactionLike[], ownerAddress: string): Flow[] {
  return extractFlowsDetailed(parsedTransactions, ownerAddress).flows;
}

/**
 * {@link extractFlows}, plus which of its bounds were hit. `limitsHit` is
 * absent when none was, which is every real history.
 */
export function extractFlowsDetailed(parsedTransactions: readonly ParsedTransactionLike[], ownerAddress: string): ExtractedFlows {
  const me = ownerAddress;
  const flows: Flow[] = [];
  let transactionsCut = 0;
  let flowsCapped = false;

  /** Keeps one flow. False once the cap is reached: nothing more is to be read. */
  const push = (flow: Flow): boolean => {
    if (flows.length >= MAX_FLOWS) {
      flowsCapped = true;
      return false;
    }
    flows.push(flow);
    return true;
  };

  for (const tx of parsedTransactions) {
    if (flowsCapped) break;
    const time = tx.blockTime ?? 0;
    const sig = tx.transaction.signatures[0] ?? "";
    let cut = false;

    // Whether the wallet holds a token balance in this transaction: asked for every incoming
    // token transfer, answered once.
    let holds: boolean | undefined;
    const holdsTokenBalance = (): boolean => {
      if (holds !== undefined) return holds;
      holds = false;
      const balances = tx.meta?.postTokenBalances;
      if (Array.isArray(balances)) {
        const count = Math.min(balances.length, MAX_TOKEN_BALANCES_PER_TRANSACTION);
        for (let k = 0; k < count; k++) {
          if ((balances[k] as { owner?: unknown } | null | undefined)?.owner === me) {
            holds = true;
            break;
          }
        }
        if (!holds && balances.length > count) cut = true;
      }
      return holds;
    };

    /** Reads one instruction. False when the flow cap was reached. */
    const read = (ix: ParsedInstructionLike | null | undefined): boolean => {
      // Undecoded instructions have no `parsed`; some programs (memo) parse to a bare string.
      const parsed = ix?.parsed;
      if (typeof parsed !== "object" || parsed === null) return true;
      const { type, info: rawInfo } = parsed as { type?: unknown; info?: unknown };
      if (typeof rawInfo !== "object" || rawInfo === null) return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape depends on the program
      const info = rawInfo as Record<string, any>;

      if (ix?.program === "system" && type === "transfer") {
        const amount = info.lamports / LAMPORTS_PER_SOL;
        if (info.source === me && !push({ sig, time, dir: "out", counterparty: String(info.destination), amount, asset: "SOL" })) return false;
        if (info.destination === me && !push({ sig, time, dir: "in", counterparty: String(info.source), amount, asset: "SOL" })) return false;
      }

      if ((ix?.program === "spl-token" || ix?.program === "spl-token-2022") && (type === "transfer" || type === "transferChecked")) {
        const amount = Number(info.tokenAmount?.uiAmount ?? info.amount ?? 0);
        const asset = String(info.mint ?? "SPL");
        // Token transfers name token accounts; the owner is the authority on outbound.
        if (info.authority === me || info.multisigAuthority === me) {
          if (!push({ sig, time, dir: "out", counterparty: String(info.destination), amount, asset })) return false;
        } else if (holdsTokenBalance()) {
          if (!push({ sig, time, dir: "in", counterparty: String(info.authority ?? info.source), amount, asset })) return false;
        }
      }
      return true;
    };

    // Top-level instructions first, then the inner ones group by group, in the order the
    // transaction lists them. `budget` counts down over all of them; an inner group costs one
    // as well, so a transaction of a million empty groups is not walked to its end either.
    let budget = MAX_INSTRUCTIONS_PER_TRANSACTION;
    const readAll = (instructions: unknown): boolean => {
      if (!Array.isArray(instructions)) return true;
      const count = Math.min(instructions.length, budget);
      if (instructions.length > count) cut = true;
      budget -= count;
      for (let k = 0; k < count; k++) {
        if (!read(instructions[k] as ParsedInstructionLike)) return false;
      }
      return true;
    };

    let more = readAll(tx.transaction.message.instructions);
    const groups = tx.meta?.innerInstructions;
    if (more && Array.isArray(groups)) {
      for (let g = 0; g < groups.length; g++) {
        if (budget <= 0) {
          cut = true;
          break;
        }
        budget -= 1;
        more = readAll((groups[g] as { instructions?: unknown } | null | undefined)?.instructions);
        if (!more) break;
      }
    }
    if (cut) transactionsCut += 1;
  }

  return transactionsCut > 0 || flowsCapped ? { flows, limitsHit: { transactionsCut, flowsCapped } } : { flows };
}
