// Claim links: paying someone who has no shielded address yet.
//
// The payer makes up a 32-byte secret, derives a key set from it and pays the
// address of that key set, as it would pay any address. Whoever holds the
// secret holds the note: the payer hands it over as a claim code, and the
// recipient moves the note to an address of their own (or straight out of the
// pool) with an ordinary transfer or withdrawal signed by the claim's keys.
//
// A claim code is a bearer secret. Until the note is moved, the payer can take
// it back and so can anyone who saw the code. docs/protocol.md section 4.

import { bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";

import { type Form, decodePayload } from "./address.js";
import { bigIntToBytesBE, bytesToBigIntBE, concatBytes, copyBytes, randomBytes, utf8 } from "./bytes.js";
import { CLAIM_DOMAIN, CLAIM_PREFIX, MAX_AMOUNT, PROGRAM_ID, TREE_DEPTH } from "./constants.js";
import { LochError } from "./errors.js";
import { type LochKeys, keysFromSeed } from "./keys.js";
import { noteCommitment, noteNullifier } from "./note.js";
import { type OwnedNote, WALLET_STATE_VERSION, type WalletState } from "./wallet.js";

/** What a claim code holds: the secret, and where the note it pays for is. */
export interface Claim {
  /** 32 random bytes. Whoever has them can spend the note. */
  secret: Uint8Array;
  /** Lamports in the note. Collecting it costs one relayer fee out of this. */
  amount: bigint;
  /** The note's blinding. */
  blinding: bigint;
  /** Position of the note's commitment in the tree. */
  leafIndex: number;
}

const SECRET_BYTES = 32;
const BLINDING_BYTES = 31;
const PAYLOAD_LENGTH = SECRET_BYTES + 8 + BLINDING_BYTES + 4;
/** prefix + "1" + ceil(75 * 8 / 5) data characters + 6 checksum characters. */
const CLAIM_LENGTH = CLAIM_PREFIX.length + 1 + 120 + 6;
const CLAIM_FORM: Form = { prefix: CLAIM_PREFIX, payloadLength: PAYLOAD_LENGTH, what: "claim code" };

/** A fresh claim secret: 32 uniformly random bytes. */
export function createClaimSecret(): Uint8Array {
  return randomBytes(SECRET_BYTES);
}

/**
 * The key set of a claim: `keysFromSeed(sha256(utf8("Loch claim v1") || secret))`.
 * Its address is what the payer pays; its spending key is what the recipient
 * collects with.
 *
 * @throws LochError `INVALID_ARGUMENT` if the secret is not 32 bytes.
 */
export function claimKeys(secret: Uint8Array): LochKeys {
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) {
    throw new LochError("INVALID_ARGUMENT", "a claim secret must be 32 bytes");
  }
  return keysFromSeed(sha256(concatBytes(utf8(CLAIM_DOMAIN), secret)));
}

function checked(claim: Claim): Claim {
  const { secret, amount, blinding, leafIndex } = claim;
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) {
    throw new LochError("INVALID_ARGUMENT", "a claim secret must be 32 bytes");
  }
  if (typeof amount !== "bigint" || amount <= 0n || amount > MAX_AMOUNT) {
    throw new LochError("INVALID_ARGUMENT", "a claim amount is between 1 and 2^64 - 1 lamports");
  }
  if (typeof blinding !== "bigint" || blinding < 0n || blinding >> 248n !== 0n) {
    throw new LochError("INVALID_ARGUMENT", "blinding must be a bigint below 2^248");
  }
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= 2 ** TREE_DEPTH) {
    throw new LochError("INVALID_ARGUMENT", "leafIndex is outside the tree");
  }
  return claim;
}

/**
 * Encodes a claim code: bech32m, prefix "lochclaim", payload
 * `secret (32) || amount as u64 big-endian (8) || blinding (31) || leafIndex as u32 big-endian (4)`.
 * Always 136 characters. The result IS the money: treat it like cash in an
 * envelope.
 *
 * @throws LochError `INVALID_ARGUMENT` for a malformed claim.
 */
export function encodeClaim(claim: Claim): string {
  const { secret, amount, blinding, leafIndex } = checked(claim);
  const payload = concatBytes(secret, bigIntToBytesBE(amount, 8), bigIntToBytesBE(blinding, BLINDING_BYTES), bigIntToBytesBE(BigInt(leafIndex), 4));
  return bech32m.encode(CLAIM_PREFIX, bech32m.toWords(payload), CLAIM_LENGTH);
}

/**
 * Decodes a claim code. The same rules as for an address: one case, the
 * prefix "lochclaim", a bech32m checksum, a 75-byte payload.
 *
 * @throws AddressError with `reason` `encoding`, `prefix`, `checksum` or
 *   `length`; LochError `INVALID_ARGUMENT` for an amount of zero or a leaf
 *   index outside the tree.
 */
export function decodeClaim(text: string): Claim {
  const payload = decodePayload(text, CLAIM_FORM);
  return checked({
    secret: copyBytes(payload, 0, 32),
    amount: bytesToBigIntBE(payload.subarray(32, 40)),
    blinding: bytesToBigIntBE(payload.subarray(40, 71)),
    leafIndex: Number(bytesToBigIntBE(payload.subarray(71, 75))),
  });
}

/** True when `text` decodes as a claim code. Never throws. */
export function isClaim(text: string): boolean {
  try {
    decodeClaim(text);
    return true;
  } catch {
    return false;
  }
}

/** The note a claim pays for, as the claim's key set owns it. */
export function claimNote(claim: Claim): OwnedNote {
  const { secret, amount, blinding, leafIndex } = checked(claim);
  const keys = claimKeys(secret);
  const note = { amount, publicKey: keys.publicKey, blinding };
  return { ...note, leafIndex, commitment: noteCommitment(note), nullifier: noteNullifier(note, leafIndex, keys.privateKey), spent: false };
}

/**
 * A wallet state for the claim's key set that holds the claim's one note,
 * over `leaves`: the pool's leaves as any synced wallet state has them
 * (`WalletState.leaves`). With `claimKeys(claim.secret)` it goes into
 * `prepareTransfer` or `prepareWithdrawal` like any other state.
 *
 * Whether the note is still unspent is not known here: the chain says so when
 * the transaction is sent (`nullifier_spent`), or `isNullifierSpent` does, at
 * the price of naming the note to the RPC.
 *
 * @throws LochError `STALE_STATE` if the leaf at the claim's index is not the
 *   claim's note: `leaves` is behind, or belongs to another pool, or the code
 *   is not for a note that exists.
 */
export function claimState(claim: Claim, leaves: readonly string[], programId: PublicKey = PROGRAM_ID): WalletState {
  const note = claimNote(claim);
  if (leaves.length % 2 !== 0) throw new LochError("INVALID_ARGUMENT", "an odd number of leaves (every transaction appends two)");
  if (leaves[note.leafIndex] !== note.commitment.toString()) {
    throw new LochError("STALE_STATE", "the claim's note is not in the tree at its index; sync and try again");
  }
  return {
    version: WALLET_STATE_VERSION,
    programId: programId.toBase58(),
    publicKey: note.publicKey.toString(),
    leaves: [...leaves],
    notes: [
      {
        leafIndex: note.leafIndex,
        amount: note.amount.toString(),
        blinding: note.blinding.toString(),
        commitment: note.commitment.toString(),
        nullifier: note.nullifier.toString(),
        spent: false,
      },
    ],
    lastSignature: null,
  };
}
