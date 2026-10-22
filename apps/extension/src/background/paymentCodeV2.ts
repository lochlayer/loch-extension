// Payment codes, pay links and viewing keys of the v2 pool (docs/v2.md sections 1 and 5).
//
// A v2 payment code is an address of its own, unlinkable to the wallet's main address and to
// every other code: two payers given two codes cannot tell they pay one wallet (stealth
// receive). The rules of v1 hold: codes follow from the keys and a counter kept in the state,
// and after twenty unpaid in a row the newest is offered again.

import { LochError } from "@loch/sdk";
import {
  encodeFullViewingKey,
  encodeIncomingViewingKey,
  encodePaymentCodeV2,
  fullViewingKeyOf,
  incomingViewingKeyOf,
  issuePaymentCodeV2,
  paymentCodeAtV2,
  paymentCodeCountsV2,
} from "@loch/sdk/v2";

import { PAY_PAGE } from "../shared/constants.js";
import type { PayLinkReply, PaymentCodeReply, ViewingKeyReply } from "../shared/view.js";
import type { Core } from "./core.js";
import type { WalletRuntime } from "./store.js";

async function active(core: Core): Promise<WalletRuntime> {
  const address = await core.store.active();
  const runtime = address ? await core.store.runtime(address) : null;
  if (!runtime) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
  return runtime;
}

export async function makePaymentCodeV2(core: Core): Promise<PaymentCodeReply> {
  const runtime = await active(core);
  const v2 = runtime.v2;
  try {
    const issued = issuePaymentCodeV2(v2.state, v2.keys);
    v2.state = issued.state;
    if (!(await core.store.saveState(runtime))) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
    return { status: "made", code: encodePaymentCodeV2(issued.code), made: issued.index + 1 };
  } catch (error) {
    if (!(error instanceof LochError) || error.code !== "PAYMENT_CODE_LIMIT") throw error;
    const { issued } = paymentCodeCountsV2(v2.state);
    return { status: "limit", code: encodePaymentCodeV2(paymentCodeAtV2(v2.keys, issued - 1)), made: issued };
  }
}

export async function payLinkForV2(core: Core, action: "show" | "make" | "new"): Promise<PayLinkReply | null> {
  const runtime = await active(core);
  const v2 = runtime.v2;
  const reply = (status: PayLinkReply["status"], index: number): PayLinkReply => {
    const code = encodePaymentCodeV2(paymentCodeAtV2(v2.keys, index));
    return { status, code, link: `${PAY_PAGE}${code}` };
  };
  if (v2.payLink !== null && action !== "new") return reply("kept", v2.payLink);
  if (action === "show") return null;
  let status: PayLinkReply["status"] = "made";
  let index: number;
  try {
    const issued = issuePaymentCodeV2(v2.state, v2.keys);
    v2.state = issued.state;
    index = issued.index;
  } catch (error) {
    if (!(error instanceof LochError) || error.code !== "PAYMENT_CODE_LIMIT") throw error;
    status = "limit";
    index = v2.payLink ?? paymentCodeCountsV2(v2.state).issued - 1;
  }
  v2.payLink = index;
  if (!(await core.store.saveState(runtime))) throw new LochError("INVALID_ARGUMENT", "unlock the wallet first");
  return reply(status, index);
}

/**
 * A v2 viewing key. `full` shows every note and which were spent (balance and history);
 * `incoming` shows what arrives and not what leaves. Neither can spend.
 */
export async function viewingKeyV2For(core: Core, which: "full" | "incoming"): Promise<ViewingKeyReply> {
  const { keys } = (await active(core)).v2;
  return { key: which === "full" ? encodeFullViewingKey(fullViewingKeyOf(keys)) : encodeIncomingViewingKey(incomingViewingKeyOf(keys)) };
}
