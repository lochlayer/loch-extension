// Payment codes: a shielded address with a secret for one payer (docs/protocol.md, section 4).
//
// A note paid to a code is encrypted under the X25519 exchange and the code's secret together,
// so somebody who breaks the exchange later, which is what a quantum computer would do, still
// cannot read it. Codes follow from the wallet's keys and a counter; the counter is the only
// thing kept, in the wallet state.

import { LochError, decodeRecipient, encodePaymentCode, encodeShieldedAddress, issuePaymentCode, paymentCodeAt, paymentCodeCounts } from "@loch/sdk";

import type { PaymentCodeReply } from "../shared/view.js";
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
