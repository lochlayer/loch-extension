// What a viewing key of the v2 pool shows (docs/v2.md section 1), read from the pool's events
// without a wallet state: for the verify page, and anyone shown a key. An incoming viewing key
// opens every note the wallet received; a full viewing key also computes their nullifiers, so
// it tells which were spent and what is left.

import { PAYMENT_CODE_GAP } from "../constants.js";
import type { AssetTable } from "./asset.js";
import type { TimedTransactV2Event } from "./events.js";
import { type FullViewingKey, type IncomingViewingKey, MAX_ADDRESS_INDEX, paymentCodeSecretV2 } from "./keys.js";
import { type NoteSourceV2, type PaymentCodeCandidateV2, noteNullifierV2, openNoteV2 } from "./note.js";

/** A note a viewing key opens. */
export interface ViewedNoteV2 {
  leafIndex: number;
  /** The asset (base58 mint). */
  mint: string;
  /** Base units of the asset. */
  amount: bigint;
  source: NoteSourceV2;
  slot?: number;
  blockTime?: number | null;
  /** Full viewing key only: whether the pool has recorded its nullifier. Absent for an incoming key, which cannot tell. */
  spent?: boolean;
}

const isFull = (key: IncomingViewingKey | FullViewingKey): key is FullViewingKey => "nk" in key && typeof (key as FullViewingKey).nk === "bigint";

/**
 * The notes `key` opens among `events` (all of the pool's, in any order), oldest first. Notes
 * of no value and notes in assets `assets` does not list are left out. Payment codes are
 * looked for as a wallet does: up to {@link PAYMENT_CODE_GAP} past the last one paid.
 */
export function viewNotesV2(events: readonly TimedTransactV2Event[], key: IncomingViewingKey | FullViewingKey, assets: AssetTable): ViewedNoteV2[] {
  const codes: PaymentCodeCandidateV2[] = [];
  let used = 0;
  const lookAhead = () => {
    const end = Math.min(used + PAYMENT_CODE_GAP, MAX_ADDRESS_INDEX);
    for (let index = codes.length; index < end; index++) codes.push({ index, secret: paymentCodeSecretV2(key.paymentCodeRoot, index) });
  };
  lookAhead();
  const nullifiers = new Set<string>();
  const notes: (ViewedNoteV2 & { commitment: bigint })[] = [];
  for (const event of [...events].sort((a, b) => a.firstIndex - b.firstIndex)) {
    for (const nullifier of event.nullifiers) nullifiers.add(nullifier.toString());
    const outputs: { encrypted: Uint8Array; amount?: bigint }[] = event.encryptedOutputs.map((encrypted) => ({ encrypted }));
    if (event.swap) outputs.push({ encrypted: event.swap.encryptedOutput, amount: event.swap.amountOut });
    outputs.forEach((output, position) => {
      const commitment = event.commitments[position];
      if (commitment === undefined) return;
      const opened = openNoteV2(output.encrypted, key, commitment, assets, codes, output.amount);
      if (!opened) return;
      if (typeof opened.source === "object" && opened.source.code >= used) {
        used = opened.source.code + 1;
        lookAhead();
      }
      if (opened.note.amount === 0n) return;
      const asset = assets.byId(opened.note.asset);
      if (!asset) return;
      notes.push({
        leafIndex: event.firstIndex + position,
        mint: asset.mint.toBase58(),
        amount: opened.note.amount,
        source: opened.source,
        slot: event.slot,
        blockTime: event.blockTime,
        commitment,
      });
    });
  }
  return notes.map(({ commitment, ...note }) =>
    isFull(key) ? { ...note, spent: nullifiers.has(noteNullifierV2(key.nk, commitment, note.leafIndex).toString()) } : note,
  );
}
