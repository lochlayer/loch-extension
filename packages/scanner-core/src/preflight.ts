import { isPassThrough, RECURRING_THRESHOLD, sortFindings } from "./analyse.js";
import { describeAmount, labelFor, shortAddress } from "./format.js";
import type { Finding, Flow, Labels } from "./types.js";

/** A public transfer the user is about to sign. */
export type OutgoingTransfer = {
  /**
   * Destination exactly as the instruction names it: the recipient wallet for
   * SOL, the destination token account for a token transfer. This is what
   * {@link Flow.counterparty} holds for earlier outgoing transfers.
   */
  to: string;
  /**
   * Wallet that owns the destination token account, when the caller knows it.
   * Labels and history are checked against it as well as `to`. Leave unset for SOL.
   */
  toOwner?: string;
  /** Amount in the same unit {@link Flow.amount} uses for this asset. */
  amount: number;
  /** "SOL" or the token mint address, as in {@link Flow.asset}. */
  asset: string;
  /** When the transfer would be sent, in unix SECONDS (not milliseconds), as in {@link Flow.time}. */
  time: number;
};

/** Unix seconds for the year 5138. Anything at or above it is a millisecond timestamp passed by mistake. */
const MAX_PLAUSIBLE_SECONDS = 1e11;

/** Input for {@link assessOutgoingTransfer}. */
export type AssessOutgoingTransferInput = {
  /** The wallet's known history, from {@link extractFlows}. */
  flows: readonly Flow[];
  /** Known addresses. Default none. */
  labels?: Labels;
  transfer: OutgoingTransfer;
};

/**
 * Pre-flight check for a public transfer, meant to run before the user signs.
 * Returns what sending it would give away, most severe first; an empty array
 * means nothing stood out. Pure: no network, no clock, inputs are not modified.
 *
 * Warnings:
 * - `recipient-identified` (high): the recipient is a labelled service.
 * - `amount-pass-through` (medium): the amount equals one received less than
 *   ten minutes earlier (same rule as the scan's pass-through finding).
 * - `recurring-counterparty` (medium): the recipient already is, or with this
 *   transfer becomes, a counterparty seen three or more times.
 * - `new-counterparty` (low): no earlier transfer with the recipient, so this
 *   one creates a link that did not exist.
 *
 * `penalty` here is an indicative weight on the same scale the scan uses
 * (10 per identified service, 5 per pass-through, 4 per recurring
 * counterparty). It is not a promise of how far a re-scan would move.
 *
 * The answer is only as good as `flows`: with an empty history every recipient
 * looks new and no pass-through can be seen, so scan the wallet first.
 *
 * @throws RangeError if `transfer.time` looks like milliseconds. The
 *   pass-through check would otherwise never fire, silently.
 */
export function assessOutgoingTransfer(input: AssessOutgoingTransferInput): Finding[] {
  const { flows, labels = {}, transfer } = input;
  if (!(transfer.time < MAX_PLAUSIBLE_SECONDS)) {
    throw new RangeError("transfer.time must be unix seconds, e.g. Math.floor(Date.now() / 1000)");
  }
  const f: Finding[] = [];

  const recipients = transfer.toOwner && transfer.toOwner !== transfer.to ? [transfer.toOwner, transfer.to] : [transfer.to];
  // The address the user would recognise: the wallet when we know it.
  const shown = shortAddress(recipients[0] ?? transfer.to);

  // 1. Labelled recipient: the service on the other end knows who it is dealing with.
  for (const address of recipients) {
    const label = labelFor(labels, address);
    if (!label) continue;
    f.push({
      id: "recipient-identified",
      severity: "high",
      title: "Recipient is an identified service",
      detail: `${shortAddress(address)} is labelled ${label}. Sending from this wallet lets that service tie it to your identity.`,
      penalty: 10,
    });
    break;
  }

  // 2. Pass-through: forwarding an amount that just arrived links its sender to this recipient.
  const matches = flows.filter((i) => i.dir === "in" && isPassThrough(i, transfer));
  if (matches.length > 0) {
    const latest = matches.reduce((a, b) => (b.time > a.time ? b : a));
    f.push({
      id: "amount-pass-through",
      severity: "medium",
      title: "Exact amount would pass straight through",
      detail: `${describeAmount(latest.amount, latest.asset)} arrived from ${shortAddress(latest.counterparty)} ${ago(transfer.time - latest.time)}. Sending the same amount on now links that sender to this recipient.`,
      penalty: 5,
    });
  }

  // 3. Counterparty history: a first transfer draws a new link, a repeated one draws a pattern.
  const earlier = flows.filter((x) => recipients.includes(x.counterparty)).length;
  if (earlier === 0) {
    f.push({
      id: "new-counterparty",
      severity: "low",
      title: "Creates a new public link",
      detail: `The scanned history has no earlier transfer with ${shown}. Sending this ties your wallet to that address where anyone can see it, and the link is permanent.`,
      penalty: 2,
    });
  } else if (earlier >= RECURRING_THRESHOLD) {
    f.push({
      id: "recurring-counterparty",
      severity: "medium",
      title: "Recipient is a recurring counterparty",
      detail: `${shown} already appears in ${earlier} of your transfers. One more strengthens a pattern that reveals employers, clients or friends.`,
      penalty: 4,
    });
  } else if (earlier + 1 >= RECURRING_THRESHOLD) {
    f.push({
      id: "recurring-counterparty",
      severity: "medium",
      title: "Recipient becomes a recurring counterparty",
      detail: `This would be transfer number ${earlier + 1} with ${shown}. Regular payments reveal employers, clients or friends.`,
      penalty: 4,
    });
  }

  return sortFindings(f);
}

/** "less than a minute ago", "1 minute ago", "9 minutes ago". */
function ago(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "less than a minute ago";
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}
