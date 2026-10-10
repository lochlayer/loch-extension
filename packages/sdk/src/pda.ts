// Program-derived addresses of loch_pool.

import { PublicKey } from "@solana/web3.js";

import { utf8 } from "./bytes.js";
import { PROGRAM_ID } from "./constants.js";
import { type FieldLike, fieldToBytes, toField } from "./field.js";

const cache = new Map<string, PublicKey>();

function singleton(seed: string, programId: PublicKey): PublicKey {
  const key = `${seed}:${programId.toBase58()}`;
  let address = cache.get(key);
  if (!address) {
    address = PublicKey.findProgramAddressSync([utf8(seed)], programId)[0];
    cache.set(key, address);
  }
  return address;
}

/** The `PoolConfig` account: seeds `["config"]`. */
export function configPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return singleton("config", programId);
}

/** The `MerkleTree` account: seeds `["tree"]`. Every `transact` writes to it. */
export function treePda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return singleton("tree", programId);
}

/** The system-owned account holding the pooled lamports: seeds `["vault"]`. */
export function vaultPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return singleton("vault", programId);
}

/**
 * The record created when `nullifier` is spent: seeds
 * `["nullifier", nullifier as 32 bytes big-endian]`.
 *
 * @throws LochError `INVALID_ARGUMENT` if the nullifier is not a field element.
 */
export function nullifierPda(nullifier: FieldLike, programId: PublicKey = PROGRAM_ID): PublicKey {
  const seed = fieldToBytes(toField(nullifier));
  return PublicKey.findProgramAddressSync([utf8("nullifier"), seed], programId)[0];
}
