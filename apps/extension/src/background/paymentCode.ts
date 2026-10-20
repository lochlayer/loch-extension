// Payment codes: a shielded address with a secret for one payer (docs/protocol.md, section 4).
//
// A note paid to a code is encrypted under the X25519 exchange and the code's secret together,
// so somebody who breaks the exchange later, which is what a quantum computer would do, still
// cannot read it. Codes follow from the wallet's keys and a counter; the counter is the only
// thing kept, in the wallet state.

import { LochError, decodeRecipient, encodePaymentCode, encodeShieldedAddress, issuePaymentCode, paymentCodeAt, paymentCodeCounts } from "@loch/sdk";

import { PAY_PAGE } from "../shared/constants.js";
import type { PayLinkReply, PaymentCodeReply } from "../shared/view.js";
import type { Core } from "./core.js";

/**
 * Makes the active wallet's next payment code and saves the count. When twenty in a row are
 * unpaid, a restored wallet would not look further, so no new one is made: the newest of them
 * is returned to be used again.
 */
export async function makePaymentCode(core: Core): Promise<PaymentCodeReply> {
  const address = await core.store.active();
  const runtime = address ? await core.store.runtime(address) : null;
  if (!runtime) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
  try {
    const issued = issuePaymentCode(runtime.state, runtime.keys);
    // Nothing is awaited between reading the state and replacing it: a sync that ends meanwhile
    // keeps the higher count (sync.ts).
    runtime.state = issued.state;
    if (!(await core.store.saveState(runtime))) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
    return { status: "made", code: encodePaymentCode(issued.code), made: issued.index + 1 };
  } catch (error) {
    if (!(error instanceof LochError) || error.code !== "PAYMENT_CODE_LIMIT") throw error;
    const { issued } = paymentCodeCounts(runtime.state);
    return { status: "limit", code: encodePaymentCode(paymentCodeAt(runtime.keys, issued - 1)), made: issued };
  }
}

/**
 * The active wallet's pay link: a payment code of its own, put after the pay page's address.
 * One code serves every payer of the link; it is the same each time until `new` asks for a fresh
 * one. Codes are counted like any other (makePaymentCode): when twenty in a row are unpaid, no
 * fresh one is made and the link stays the one the wallet had.
 */
export async function payLinkFor(core: Core, action: "show" | "make" | "new"): Promise<PayLinkReply | null> {
  const address = await core.store.active();
  const runtime = address ? await core.store.runtime(address) : null;
  if (!runtime) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
  const reply = (status: PayLinkReply["status"], index: number): PayLinkReply => {
    const code = encodePaymentCode(paymentCodeAt(runtime.keys, index));
    return { status, code, link: `${PAY_PAGE}${code}` };
  };
  if (runtime.payLink !== null && action !== "new") return reply("kept", runtime.payLink);
  if (action === "show") return null;
  let status: PayLinkReply["status"] = "made";
  let index: number;
  try {
    const issued = issuePaymentCode(runtime.state, runtime.keys);
    runtime.state = issued.state;
    index = issued.index;
  } catch (error) {
    if (!(error instanceof LochError) || error.code !== "PAYMENT_CODE_LIMIT") throw error;
    status = "limit";
    index = runtime.payLink ?? paymentCodeCounts(runtime.state).issued - 1;
  }
  runtime.payLink = index;
  if (!(await core.store.saveState(runtime))) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
  return reply(status, index);
}

/**
 * The shielded address a private payment goes to: the text itself, or the address inside a
 * payment code. This is what is shown and remembered about a recipient. The code's secret is
 * needed to make the proof and nowhere after that.
 */
export function payeeOf(to: string): string {
  try {
    return encodeShieldedAddress(decodeRecipient(to));
  } catch {
    return to;
  }
}
