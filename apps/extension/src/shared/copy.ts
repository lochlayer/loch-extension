// The words. Everything the interface says about a flow is written here, in the design
// system's voice (docs/design/DESIGN.md section 8): plain verbs, full sentences, what happened,
// whether funds moved, what to do next. No apology, no hype, no exclamation mark.

import { shortAddress as designShortAddress } from "@loch/design/numerals";

import { displaySol, exactSol } from "./amounts.js";
import type { ActivityEntry, Failure, FlowKind, FlowView, StageView } from "./view.js";

/** The first and last four characters, as the design system writes them. A shielded address keeps "loch1" whole. */
export function shortAddress(address: string): string {
  return designShortAddress(address);
}

/**
 * Figures inside a sentence keep the lettering rule: a public figure is upright, a shielded
 * one italic. A sentence marks them with pub() or shd() and the interface sets them.
 */
const OPEN = "⟦";
const CLOSE = "⟧";
export const pub = (text: string): string => `${OPEN}p:${text}${CLOSE}`;
export const shd = (text: string): string => `${OPEN}s:${text}${CLOSE}`;

export type RichPart = { text: string; role: "plain" | "public" | "shielded" };

export function richParts(line: string): RichPart[] {
  const parts: RichPart[] = [];
  const pattern = new RegExp(`${OPEN}([ps]):([^${CLOSE}]*)${CLOSE}`, "g");
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: line.slice(last, match.index), role: "plain" });
    parts.push({ text: match[2] ?? "", role: match[1] === "s" ? "shielded" : "public" });
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), role: "plain" });
  return parts;
}

/** The same sentence without the marks, for places that only take text. */
export function plainText(line: string): string {
  return richParts(line)
    .map((part) => part.text)
    .join("");
}

// --------------------------------------------------------------------- names

export const ACTION_NAME: Record<FlowKind, string> = {
  unlock: "Unlock",
  dive: "Dive in",
  send: "Send privately",
  surface: "Surface",
  consolidate: "Combine notes",
};

export const ACTION_RUNNING: Record<FlowKind, string> = {
  unlock: "Unlocking",
  dive: "Diving in",
  send: "Sending privately",
  surface: "Surfacing",
  consolidate: "Combining notes",
};

const ACTION_BUSY: Record<FlowKind, string> = {
  unlock: "Unlocking",
  dive: "Diving in",
  send: "Sending",
  surface: "Surfacing",
  consolidate: "Combining",
};

export function busyLabel(kind: FlowKind, firstTime = false): string {
  return kind === "unlock" && firstTime ? "Connecting" : ACTION_BUSY[kind];
}

/** What anyone watching the chain sees of an action. */
export const OBSERVER: Record<Exclude<FlowKind, "unlock">, string> = {
  dive: "your address, the amount, and that it went into the Loch.",
  send: "a proof and the relayer’s fee. No sender, no recipient, no amount.",
  surface: "the destination, the amount, and that it came out of the Loch. Not which deposit paid for it.",
  consolidate: "a proof and the relayer’s fee. No sender, no recipient, no amount.",
};

// -------------------------------------------------------------------- stages

const STAGES: Record<FlowKind, { steps: string[]; now: string; done: string }[]> = {
  unlock: [
    { steps: ["opening", "discovering", "choosing", "connecting"], now: "Connecting", done: "Connected" },
    { steps: ["signing", "signing-again"], now: "Signing", done: "Signed" },
    { steps: ["syncing"], now: "Syncing", done: "Synced" },
  ],
  dive: [
    { steps: ["checking"], now: "Checking", done: "Checked" },
    { steps: ["proving"], now: "Proving", done: "Proved" },
    { steps: ["screening"], now: "Screening", done: "Screened" },
    { steps: ["signing"], now: "Signing", done: "Signed" },
    { steps: ["sending", "confirming"], now: "Confirming", done: "Confirmed" },
  ],
  send: [
    { steps: ["checking"], now: "Checking", done: "Checked" },
    { steps: ["proving"], now: "Proving", done: "Proved" },
    { steps: ["sending"], now: "Sending", done: "Sent" },
    { steps: ["confirming"], now: "Confirming", done: "Confirmed" },
  ],
  surface: [],
  consolidate: [],
};
STAGES.surface = STAGES.send;
STAGES.consolidate = STAGES.send;

export interface StageLine {
  stages: StageView[];
  /** 0 to 1: how far along the line the tick stands. */
  progress: number;
}

/**
 * The stages of a flow and where it stands. The last stage is named for the goal while it lies
 * ahead and once it is reached. While the flow is in it, it says what is being done: "Confirmed"
 * may not be read off the line before the chain has confirmed anything.
 */
export function stageLine(flow: Pick<FlowView, "kind" | "step" | "status">): StageLine {
  const list = STAGES[flow.kind];
  const done = flow.status === "done" || flow.step === "done";
  const current = done ? list.length : Math.max(0, list.findIndex((stage) => stage.steps.includes(flow.step)));
  const last = list.length - 1;
  const stages = list.map((stage, index): StageView => {
    const state = index < current ? "done" : index === current ? "now" : "todo";
    const label = state === "done" || (index === last && state === "todo") ? stage.done : stage.now;
    return { label, state };
  });
  return { stages, progress: done ? 1 : Math.min(1, (current + 0.85) / list.length) };
}

/** One plain sentence saying what is happening now. */
export function statusSentence(flow: Pick<FlowView, "kind" | "step" | "walletName" | "firstTime">): string {
  const wallet = flow.walletName ?? "Your wallet";
  if (flow.kind === "unlock") {
    switch (flow.step) {
      case "opening":
        return "Opening the connect page to reach your wallet.";
      case "discovering":
        return "Looking for your wallet on the connect page.";
      case "choosing":
        return "Choose the wallet to connect.";
      case "connecting":
        return `${wallet} is asking whether to connect. Answer it in the wallet’s window.`;
      case "signing":
        return `${wallet} is asking for the signature. Answer it in the wallet’s window.`;
      case "signing-again":
        return `${wallet} is asking for the same signature once more. Answer it in the wallet’s window.`;
      case "syncing":
        return "Reading the pool’s history to find your notes.";
      default:
        return "Unlocked.";
    }
  }
  if (flow.kind === "dive") {
    switch (flow.step) {
      case "checking":
        return "Checking the network, the pool and your public balance.";
      case "proving":
        return "Generating the proof on this device. It takes a few seconds.";
      case "screening":
        return "The screening service is checking the deposit.";
      case "signing":
        return `${wallet} is asking you to approve the deposit. Answer it in the wallet’s window.`;
      case "sending":
        return "Sending the deposit to the network.";
      case "confirming":
        return "Waiting for the network to confirm the deposit.";
      default:
        return "Dived in.";
    }
  }
  switch (flow.step) {
    case "checking":
      return "Checking the network, the relayer and your notes.";
    case "proving":
      return "Generating the proof on this device. It takes a few seconds.";
    case "sending":
      return "The relayer has the request. It answers once it has seen the transaction confirmed.";
    case "confirming":
      return "The relayer says it is sent. Looking for it on the chain.";
    default:
      return flow.kind === "send" ? "Sent privately." : flow.kind === "surface" ? "Surfaced." : "Notes combined.";
  }
}

/** The toast when a flow has finished. The action keeps its name. */
export function doneSentence(flow: Pick<FlowView, "kind" | "amount" | "to">): string {
  const amount = flow.amount ? displaySol(BigInt(flow.amount)) : "";
  switch (flow.kind) {
    case "unlock":
      return "Unlocked. Your shielded balance is readable on this device.";
    case "dive":
      return `Dived in. ${amount} SOL is in the Loch.`;
    case "send":
      return `Sent privately. ${amount} SOL is on its way to ${shortAddress(flow.to ?? "")}.`;
    case "surface":
      return `Surfaced. ${amount} SOL went to ${shortAddress(flow.to ?? "")}.`;
    case "consolidate":
      return "Notes combined. You can send larger amounts in one transfer now.";
  }
}

// ------------------------------------------------------------------ failures

export interface FailureCopy {
  title: string;
  /** Sentences, in order: what happened and whether funds moved, then what to do. */
  lines: string[];
  /** Offer a way into settings. */
  settings: boolean;
  /** Offer "Forget this wallet on this device". */
  forget?: boolean;
}

export interface FailureContext {
  kind: FlowKind;
  /** Lamports: the shielded balance as it stands. */
  shielded?: string;
  walletName?: string;
  address?: string;
  connectUrl?: string;
  proofKept?: boolean;
}

const figure = (lamports: string | undefined, exact = true): string => (lamports === undefined ? "?" : exact ? exactSol(BigInt(lamports)) : displaySol(BigInt(lamports)));
/** A public amount in a sentence (fees, limits, public balances). */
const sol = (lamports: string | undefined, exact = true): string => pub(figure(lamports, exact));
/** A shielded amount in a sentence. */
const hid = (lamports: string | undefined, exact = true): string => shd(figure(lamports, exact));

export function failureCopy(failure: Failure, context: FailureContext): FailureCopy {
  const wallet = context.walletName ?? "the wallet";
  const kept = context.proofKept ? " The proof is kept, so it will not take as long." : "";
  const spend = context.kind !== "dive" && context.kind !== "unlock";
  // A spend whose request is, or may be, with a relayer. A proof stays valid until its root
  // leaves the pool's root history, whatever the relayer answered, so nothing here may say
  // "nothing was sent": what is known is what the relayer says and what the chain shows.
  const open = spend && failure.moved === "unknown";
  const hold = "The notes it spends stay reserved, and your balance counts it as sent, until the chain shows what happened or its proof is too old to be accepted.";
  const earlier = "An earlier attempt of this payment is with a relayer and could still land. Its notes stay reserved until the chain shows what happened or its proof is too old to be accepted.";
  const once = "Trying again spends the same notes, so it cannot be paid twice.";
  const claim = "The relayer says it did not send it, and the chain does not show it. It has the request, though, and could send it later.";
  const nothing = open ? earlier : spend ? "Nothing was sent." : context.kind === "dive" ? "Nothing moved. Your public balance is unchanged." : "Nothing was signed and nothing moved.";
  const still = !open && spend && context.shielded !== undefined ? `Nothing was sent. Your shielded balance is still ${hid(context.shielded, false)} SOL.` : nothing;

  switch (failure.code) {
    case "mainnet":
      return {
        title: "This endpoint is Solana mainnet",
        lines: [`${nothing}`, "Loch v0.1 works on devnet only and is unaudited. Set a devnet RPC endpoint in settings."],
        settings: true,
      };
    case "rpc-unreachable":
      return {
        title: "The RPC endpoint did not answer",
        lines: [
          open ? `Loch could not look at the chain. ${earlier}` : failure.moved === "unknown" ? "The deposit may have reached the network. Loch will know after the next sync." : nothing,
          `Check your connection, or choose another endpoint in settings, then try again.${kept}`,
        ],
        settings: true,
      };
    case "cancelled":
      return open
        ? { title: "Cancelled", lines: ["This attempt was stopped before anything new was sent.", earlier, once], settings: false }
        : { title: "Cancelled", lines: [nothing], settings: false };
    case "interrupted":
      return {
        title: "Loch was stopped while sending",
        lines: ["The browser stopped the extension before the relayer answered. The chain does not show the transfer so far; it may still land.", hold, "Trying again sends the same proof, so it cannot be paid twice."],
        settings: false,
      };
    case "locked":
      return { title: "The wallet is locked", lines: ["Unlock it and start again.", nothing], settings: false };
    case "internal":
      return { title: "Loch could not finish this", lines: [nothing, "Try again. If it happens again, report it with the line below."], settings: false };

    case "connect-page":
      return {
        title: "The connect page did not open",
        lines: [
          `Loch reaches your wallet through a web page${context.connectUrl ? `, ${context.connectUrl}` : ""}. It did not load, or it was closed.`,
          "Nothing was signed. Check the connect page address in settings, then try again.",
        ],
        settings: true,
      };
    case "no-wallet":
      return {
        title: "No Solana wallet was found",
        lines: ["The connect page found no wallet that can sign a message and a transaction.", "Install Phantom, Solflare or Backpack in this browser profile, then try again."],
        settings: false,
      };
    case "wallet-missing":
      return {
        title: `${context.walletName ?? "The wallet"} was not found`,
        lines: [`This address was connected with ${wallet}, and the connect page cannot find it now.`, "Turn the wallet extension on, then try again."],
        settings: false,
      };
    case "wallet-rejected":
      return { title: "You declined in the wallet", lines: [`${nothing}${kept}`], settings: false };
    case "wallet-failed":
      return { title: "The wallet did not complete the request", lines: [nothing, "Try again. The line below is what the wallet reported."], settings: false };
    case "wallet-timeout":
      return {
        title: "The wallet did not answer",
        lines: [`Its prompt stayed open for more than five minutes, so Loch stopped waiting. ${nothing}`, `Try again and answer in the wallet’s window.${kept}`],
        settings: false,
      };
    case "wallet-unsupported":
      return {
        title: "This wallet cannot do that",
        lines: ["Loch needs a wallet that can sign a message and sign a transaction without sending it.", "Phantom, Solflare and Backpack can."],
        settings: false,
      };
    case "wrong-account":
      return {
        title: "The wallet is on another account",
        lines: [`Loch asked for ${context.address ? pub(shortAddress(context.address)) : "your address"} and the wallet offered a different one.`, "Switch to that account in the wallet, then try again."],
        settings: false,
      };
    case "bad-signature":
      return {
        title: "The signature does not match the message",
        lines: [
          "The wallet signed something other than the message as it is. Some hardware wallets wrap messages before signing.",
          "Keys derived from it could not be derived again, so nothing was created. Use a wallet that signs the message unchanged.",
        ],
        settings: false,
      };
    case "not-deterministic":
      return {
        title: "This wallet signs differently each time",
        lines: [
          "Loch asked for the same signature twice and got two different ones. Keys derived from it would be different next time, and funds sent to them would look lost.",
          "Nothing was created. Use a wallet that gives the same signature every time.",
        ],
        settings: false,
      };
    case "signature-changed":
      return {
        title: "This signature does not open the stored data",
        lines: [
          "The wallet signed, but not with the signature this device’s data was encrypted with. It may be another wallet holding the same address.",
          "Try again with the wallet you first connected. Or forget this wallet on this device and connect again: your shielded balance is on chain, not on this device.",
        ],
        settings: false,
        forget: true,
      };
    case "wallet-changed-transaction":
      return {
        title: "The wallet changed the transaction",
        lines: ["What came back is not the deposit Loch built, so Loch did not send it. Nothing moved.", `Some wallets add instructions of their own. Turn that off in the wallet if you can, then try again.${kept}`],
        settings: false,
      };

    case "pool-missing":
      return { title: "The Loch is not on this network", lines: ["The RPC endpoint knows no Loch pool. Nothing moved.", "Check the pool's RPC endpoint in settings."], settings: true };
    case "deposits-paused":
      return { title: "Deposits are paused", lines: ["The pool’s operator has paused diving in. Nothing moved.", "Sending privately and surfacing still work. Try diving in later."], settings: false };
    case "above-max":
      return {
        title: "Above the largest deposit",
        lines: [`The pool takes at most ${failure.limit ? sol(failure.limit) : "a set amount of"} SOL in one deposit. Nothing moved.`, "Enter a smaller amount."],
        settings: false,
      };
    case "insufficient-public":
      return {
        title: "Not enough public balance",
        lines: [
          `This deposit needs ${sol(failure.limit)} SOL: the amount, ${pub("0.00191704")} SOL for the network fee and rent, and ${pub("0.00089088")} SOL that must stay in the wallet. The wallet has ${sol(failure.amount)} SOL.`,
          "Nothing moved. Enter a smaller amount, or add test SOL to the wallet.",
        ],
        settings: false,
      };
    case "screening-denied":
      return { title: "The screening service declined this deposit", lines: ["Nothing moved. Your public balance is unchanged."], settings: false };
    case "screener-unreachable":
      return {
        title: failure.reason === "timeout" ? "The screening service did not answer in time" : failure.reason === "unreachable" ? "The screening service could not be reached" : "The screening service did not answer",
        lines: ["A deposit needs its signature. Nothing moved.", `Try again, or choose another screening service in settings.${kept}`],
        settings: true,
      };
    case "screener-mismatch":
      return {
        title: "The screening service is not this pool’s",
        lines: ["It signs for another pool or network, and the pool would refuse its signature. Nothing moved.", "Check the screening service address in settings."],
        settings: true,
      };
    case "screener-refused":
      return { title: "The screening service refused the request", lines: ["Nothing moved.", `Try again.${kept}`], settings: true };
    case "expired":
      return {
        title: "The transaction expired",
        lines: ["It waited too long for the wallet, and the network no longer accepts it. Nothing moved.", `Try again and approve it promptly.${kept}`],
        settings: false,
      };
    case "transaction-failed":
      return { title: "The network rejected the deposit", lines: ["Nothing moved.", "Try again. The line below is what the network reported."], settings: false };
    case "not-confirmed":
      return spend
        ? {
            title: "Sent, but not confirmed yet",
            lines: ["The relayer says it sent the transaction and did not see it confirmed in time. The chain does not show it so far; it may still land.", hold, once],
            settings: false,
          }
        : {
            title: "Sent, but not confirmed yet",
            lines: ["The deposit was sent and the network has not confirmed it. It may still land.", "Loch keeps looking. Do not dive in again until the activity list shows what happened."],
            settings: false,
          };

    case "relayer-unreachable": {
      const another = `Try again, or choose another relayer in settings and try again here. Either way the same notes are spent, so it cannot be paid twice.${kept}`;
      if (!open) {
        return {
          title: failure.reason === "timeout" ? "The relayer did not answer in time" : failure.reason === "unreachable" ? "The relayer could not be reached" : "The relayer did not answer",
          lines: [still, `Try again, or choose another relayer in settings.${kept}`],
          settings: true,
        };
      }
      // The request had left. No answer is not the same as "not received".
      return failure.reason === "timeout"
        ? { title: "The relayer did not answer in time", lines: ["It may have received the request. The chain does not show the transfer so far.", hold, another], settings: true }
        : {
            title: failure.reason === "unreachable" ? "The relayer could not be reached" : "The relayer did not answer",
            lines: ["No answer came back, so Loch cannot tell whether the request arrived. The chain does not show the transfer so far.", hold, another],
            settings: true,
          };
    }
    case "relayer-timeout":
    case "relayer-unavailable":
      return {
        title: "The relayer says it cannot send right now",
        lines: open
          ? [
              claim,
              hold,
              `A relayer that has just started waits about a minute before it sends anything. Try again in a moment, or choose another relayer in settings and try again here. Either way the same notes are spent, so it cannot be paid twice.${kept}`,
            ]
          : [still, `A relayer that has just started waits about a minute before it sends anything. Try again in a moment, or choose another relayer in settings.${kept}`],
        settings: true,
      };
    case "relayer-unconfirmed":
      return {
        title: "The chain does not show the transfer",
        lines: [
          "The relayer answered that it sent the transaction. Your RPC endpoint shows neither the transfer nor its notes as spent, so Loch does not count it as done.",
          hold,
          once,
        ],
        settings: true,
      };
    case "reserved-short":
      return {
        title: "The reserved notes do not fit this fee",
        lines: [
          "An earlier attempt of this payment is with a relayer and could still land. A new attempt must spend exactly the same notes, so that only one of the two can ever land.",
          failure.limit && failure.amount
            ? `Those notes hold ${hid(failure.amount)} SOL, and with the fee asked now this needs ${hid(failure.limit)} SOL. Nothing new was sent.`
            : "At the fee asked now those notes do not fit. Nothing new was sent.",
          "Try again with the relayer you used before, or wait: the notes are released once the chain shows what happened to the earlier attempt or its proof is too old to be accepted.",
        ],
        settings: true,
      };
    case "relayer-mismatch":
      return {
        title: "The relayer serves another network",
        lines: open
          ? ["It works for a different pool or cluster than the RPC endpoint, or says the request was not made for it.", earlier, "Check the relayer address in settings, then try again here."]
          : ["It works for a different pool or cluster than the RPC endpoint. Nothing was sent.", "Check the relayer address in settings."],
        settings: true,
      };
    case "relayer-refused":
      return {
        title: "The relayer refused the transaction",
        lines: open ? [claim, hold, `The line below is what it reported. ${once}`] : [still, "The line below is what it reported."],
        settings: true,
      };
    case "fee-above-limit":
      return {
        title: "The relayer’s fee is above your limit",
        lines: open
          ? [`The relayer asks ${sol(failure.amount)} SOL. Your limit is ${sol(failure.limit)} SOL. Nothing new was proven or sent.`, earlier, "Choose another relayer or raise the limit in settings, then try again here."]
          : [`The relayer asks ${sol(failure.amount)} SOL. Your limit is ${sol(failure.limit)} SOL. Nothing was proven or sent.`, "Choose another relayer, or raise the limit in settings."],
        settings: true,
      };
    case "fee-changed": {
      const asks = failure.amount !== undefined ? `It now asks ${sol(failure.amount)} SOL.` : "It now asks more.";
      return {
        title: "The relayer’s fee changed",
        lines: open
          ? [`${asks} You agreed to ${sol(failure.limit)} SOL, and Loch never pays more than you agreed to.`, earlier, "Agree to the new fee here to try again with the same notes. It cannot be paid twice."]
          : [`${asks} You agreed to ${sol(failure.limit)} SOL, and Loch never pays more than you agreed to. Nothing was sent.`, "Agree to the new fee to go on, or close this."],
        settings: false,
      };
    }
    case "insufficient-shielded":
      return {
        title: "Not enough in the Loch",
        lines: [failure.limit ? `This needs ${hid(failure.limit)} SOL with the fee, and ${hid(failure.amount)} SOL can be spent.` : "There is not enough to cover the amount and the fee.", "Nothing was sent."],
        settings: false,
      };
    case "notes-busy":
      return {
        title: "An earlier transfer is still settling",
        lines: [
          "The notes this needs are reserved for an earlier transfer whose outcome is not known yet. Nothing was sent.",
          "They are released when the chain shows what happened to it, or when its proof is too old to be accepted. On a quiet pool that can take long. Use a smaller amount, or try again later.",
        ],
        settings: false,
      };
    case "consolidation-needed":
      return {
        title: "Combine notes first",
        lines: [
          "Your balance is spread over several notes, and one transaction can spend two. This amount needs more than two.",
          "Combining merges your two largest notes into one. It is a private transfer to yourself and costs one relayer fee. Nothing was sent.",
        ],
        settings: false,
      };
    case "below-minimum":
      return {
        title: "Below the smallest withdrawal",
        lines: open
          ? [`The relayer says the amount is below what it sends, or below the ${pub("0.00089088")} SOL a new address must receive.`, earlier, "Choose another relayer in settings and try again here, or wait for the notes to be released and enter a larger amount."]
          : [`A new address must receive at least ${failure.limit ? sol(failure.limit) : pub("0.00089088")} SOL, or the network will not create it. Nothing was sent.`, "Enter a larger amount."],
        settings: open,
      };
    case "nullifier-spent":
      return {
        title: "A note was already spent",
        lines: [
          "The chain shows that a note this payment spends was spent by another transaction, perhaps from another device. This payment did not go through, and none of its attempts can land any more.",
          "Loch has synced. Try again and it will use other notes.",
        ],
        settings: false,
      };
    case "stale-root":
      return {
        title: "The pool moved on while proving",
        lines: open
          ? ["The relayer says the proof refers to a state of the pool that is too old.", earlier, "Try again: Loch will sync and prove against the current state, with the same notes."]
          : ["The proof referred to a state of the pool that is too old now. Nothing was sent.", "Try again: Loch will sync and prove against the current state."],
        settings: false,
      };
    case "proof-failed":
      return {
        title: open ? "The proof was not accepted" : "The proof could not be made",
        lines: [nothing, open ? `Try again: Loch proves again with the same notes. ${once} If it keeps failing, report it with the line below.` : "Try again. If it keeps failing, report it with the line below."],
        settings: false,
      };
    case "sync-failed":
      return {
        title: "Could not sync with the chain",
        lines: [`Loch must be up to date before it proves. ${nothing}`, "Check the RPC endpoint in settings, then try again."],
        settings: true,
      };
  }
}

// ------------------------------------------------------------------ activity

export function activityTitle(entry: Pick<ActivityEntry, "kind">): string {
  switch (entry.kind) {
    case "dive":
      return "Dived in";
    case "send":
      return "Sent privately";
    case "receive":
      return "Received privately";
    case "surface":
      return "Surfaced";
    case "consolidate":
      return "Combined notes";
    case "restored":
      return "Found in the Loch";
  }
}

/** Dive in and surface cross the waterline in plain sight. Everything else stays under it. */
export function isPublicActivity(entry: Pick<ActivityEntry, "kind">): boolean {
  return entry.kind === "dive" || entry.kind === "surface";
}

/** The signed amount a row shows: what the shielded balance gained or lost by it, without the fee. */
export function activityDelta(entry: Pick<ActivityEntry, "kind" | "amount" | "fee">): bigint {
  const amount = BigInt(entry.amount);
  switch (entry.kind) {
    case "dive":
    case "receive":
    case "restored":
      return amount;
    case "consolidate":
      return -BigInt(entry.fee ?? "0");
    default:
      return -amount;
  }
}

export function activityStatusText(entry: Pick<ActivityEntry, "status">): string | null {
  switch (entry.status) {
    case "submitted":
      return "Sent, waiting for the network";
    case "unknown":
      return "Outcome not known yet";
    case "failed":
      return "Did not happen";
    default:
      return null;
  }
}

/** What an observer of the chain could see of an entry. */
export function activityObserver(entry: Pick<ActivityEntry, "kind" | "counterparty" | "amount">): string {
  const amount = `${exactSol(BigInt(entry.amount))} SOL`;
  switch (entry.kind) {
    case "dive":
      return `An observer sees your address${entry.counterparty ? ` ${shortAddress(entry.counterparty)}` : ""}, ${amount}, and that it went into the Loch.`;
    case "surface":
      return `An observer sees the destination${entry.counterparty ? ` ${shortAddress(entry.counterparty)}` : ""}, ${amount}, and that it came out of the Loch. Not which deposit paid for it.`;
    case "send":
      return "An observer sees a proof and the relayer’s fee. No sender, no recipient, no amount.";
    case "receive":
      return "An observer sees a proof and a fee. Nothing in it points to you.";
    case "consolidate":
      return "An observer sees a proof and the relayer’s fee. Not that both notes were yours.";
    case "restored":
      return "These notes were already in the Loch when this device first looked. An observer sees the transactions that made them, not that they are yours.";
  }
}

// ---------------------------------------------------------------------- scan

/** One sentence under the score. The same words as the website's report. */
export function verdict(score: number): string {
  if (score >= 80) return "Deep water. The transactions read give away little.";
  if (score >= 50) return "Mid water. Parts of this wallet’s story can be read from the surface.";
  return "Shallow water. Most of this wallet’s story can be read from the surface.";
}

// --------------------------------------------------------------------- dates

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");

/** "today 14:02", "Yesterday 19:40", "28 Sep", "28 Sep 2025". Local time, 24 hours. */
export function whenText(at: number, now: number, capital = false): string {
  const then = new Date(at);
  const today = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(then)) / 86_400_000);
  const time = `${two(then.getHours())}:${two(then.getMinutes())}`;
  if (days === 0) return `${capital ? "Today" : "today"} ${time}`;
  if (days === 1) return `${capital ? "Yesterday" : "yesterday"} ${time}`;
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return then.getFullYear() === today.getFullYear() ? date : `${date} ${then.getFullYear()}`;
}

export function clockText(at: number): string {
  const then = new Date(at);
  return `${two(then.getHours())}:${two(then.getMinutes())}`;
}

/** Elapsed time as m:ss. */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${two(seconds % 60)}`;
}

/** The meta line of an activity row. */
export function activityMeta(entry: ActivityEntry, now: number): string {
  const status = activityStatusText(entry);
  if (status) return status;
  switch (entry.kind) {
    case "dive":
      return `From ${shortAddress(entry.counterparty ?? "")}, ${whenText(entry.at, now)}`;
    case "surface":
      return `To ${shortAddress(entry.counterparty ?? "")}, ${whenText(entry.at, now)}`;
    case "restored":
      return `${entry.count ?? 1} ${entry.count === 1 ? "note" : "notes"}, ${whenText(entry.at, now)}`;
    default:
      return whenText(entry.at, now, true);
  }
}
