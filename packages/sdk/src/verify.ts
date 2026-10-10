/**
 * `@loch/sdk/verify`: what it takes to check a disclosure somebody was handed,
 * and nothing that makes one. A payment receipt, a source-of-funds report, a
 * viewing key, and reading a claim code. No keys of a wallet, no prover: a
 * page that only checks does not load the proving code.
 */

export { LochError } from "./errors.js";
export { PROGRAM_ID } from "./constants.js";
export { decodeReceipt, decodeSourceReport, verifyReceipt, verifySourceReport } from "./disclosure.js";
export type { DisclosureConnection, FundsOrigin, PaymentReceipt, Rejected, SourceReport, VerifiedReceipt, VerifiedSource, VerifyOptions } from "./disclosure.js";
export { decodeViewingKey, isViewingKey, viewNotes } from "./viewing.js";
export type { ViewedNote, ViewingKey } from "./viewing.js";
export { decodeClaim, isClaim } from "./claim.js";
export type { Claim } from "./claim.js";
export { fetchEvents } from "./sync.js";
export type { FetchEventsOptions, FetchedEvents } from "./sync.js";
