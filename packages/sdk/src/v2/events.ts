// Reading v2 events (docs/v2.md section 8). The program emits `TransactV2`
// through event CPI: an inner instruction to itself whose data is the event,
// signed by its event authority, which only the program itself can sign for.
// So an inner instruction to the program with that data, in a successful
// transaction, is an event the program emitted; a top-level one cannot exist
// in a successful transaction.

import { base58 } from "@scure/base";
import { PublicKey } from "@solana/web3.js";

import { PROGRAM_ID } from "../constants.js";
import type { TransactionLike, TransactionTime } from "../events.js";
import { type TransactV2Event, decodeTransactV2Event } from "./codec.js";

/** A `TransactV2` event with when its transaction happened, as far as the RPC said. */
export type TimedTransactV2Event = TransactV2Event & TransactionTime;

/** The `TransactV2` events of one confirmed, successful transaction, in execution order. */
export function transactV2EventsOf(tx: TransactionLike, programId: PublicKey = PROGRAM_ID): TransactV2Event[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const events: TransactV2Event[] = [];
  const groups = [...(tx.meta.innerInstructions ?? [])].sort((a, b) => a.index - b.index);
  for (const group of groups) {
    for (const nested of group.instructions) {
      if (!keys[nested.programIdIndex]?.equals(programId)) continue;
      let data: Uint8Array;
      try {
        data = base58.decode(nested.data);
      } catch {
        continue;
      }
      let event: TransactV2Event | null;
      try {
        event = decodeTransactV2Event(data);
      } catch {
        // The program never emits a malformed event; skip what is not one.
        continue;
      }
      if (event) events.push(event);
    }
  }
  return events;
}
