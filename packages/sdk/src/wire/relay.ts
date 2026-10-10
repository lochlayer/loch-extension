// The checks a relayer makes on a request before it spends anything on it.

import { type PublicKey, SystemProgram } from "@solana/web3.js";

import { type TransactArgs, proofEncodingProblem } from "../codec.js";
import { PROGRAM_ID } from "../constants.js";
import { configPda, nullifierPda, treePda, vaultPda } from "../pda.js";
import { WireError, type WireResult } from "./types.js";

/** A relayer's own terms, as it publishes them in `GET /v1/info`. */
export interface RelayPolicy {
  /** The relayer's own public key: the only `extData.relayer` it serves. */
  relayer: PublicKey;
  /** Smallest `extData.fee` accepted, in lamports (`RelayerInfo.feeLamports`). */
  feeLamports: bigint;
  /**
   * Smallest withdrawal accepted, in lamports (`RelayerInfo.minWithdrawalLamports`).
   * Keep it at or above the rent-exempt minimum of a new account (890,880) so
   * that a withdrawal to an address that does not exist yet cannot fail for rent.
   */
  minWithdrawalLamports?: bigint;
  /** Defaults to the devnet program id. */
  programId?: PublicKey;
}

/**
 * The static checks of the relayer procedure (docs/protocol.md section 14.1,
 * step 2), on arguments that came through `validateRelayRequest` and
 * `fromRelayRequest`. Needs no network. In this order:
 *
 * - `deposit_not_relayed`: `extAmount > 0`;
 * - `wrong_relayer`: `extData.relayer` is not this relayer, or a transfer's
 *   `extData.recipient` is not;
 * - `fee_too_low`: `extData.fee` is below `feeLamports`;
 * - `withdrawal_too_small`: a withdrawal below `minWithdrawalLamports`;
 * - `invalid_request`: a withdrawal whose recipient cannot be paid (one of
 *   the pool's accounts, a nullifier record this very transaction creates,
 *   the pool program or the system program), or a proof in an encoding the
 *   program refuses.
 *
 * Passing is NOT enough to send the transaction. Whether the root is known,
 * the nullifiers are unspent, the proof verifies and the recipient can
 * receive the amount depends on chain state: the relayer must simulate the
 * exact transaction it is about to send and refuse on any error.
 */
export function checkRelayRequest(args: TransactArgs, policy: RelayPolicy): WireResult<TransactArgs> {
  const fail = (code: "deposit_not_relayed" | "wrong_relayer" | "fee_too_low" | "withdrawal_too_small" | "invalid_request", message: string) =>
    ({ ok: false, error: new WireError(code, message, 400) }) as const;
  const programId = policy.programId ?? PROGRAM_ID;
  const { extData } = args;

  if (extData.extAmount > 0n) return fail("deposit_not_relayed", "deposits are signed by the depositor and are not relayed");
  if (!extData.relayer.equals(policy.relayer)) return fail("wrong_relayer", "extData.relayer is not this relayer");
  if (extData.extAmount === 0n && !extData.recipient.equals(policy.relayer)) {
    return fail("wrong_relayer", "a transfer names the relayer as extData.recipient");
  }
  if (extData.fee < policy.feeLamports) return fail("fee_too_low", `extData.fee is below this relayer's fee of ${policy.feeLamports} lamports`);

  if (extData.extAmount < 0n) {
    const amount = -extData.extAmount;
    if (policy.minWithdrawalLamports !== undefined && amount < policy.minWithdrawalLamports) {
      return fail("withdrawal_too_small", `the withdrawal is below this relayer's minimum of ${policy.minWithdrawalLamports} lamports`);
    }
    let unpayable: PublicKey[];
    try {
      unpayable = [
        vaultPda(programId),
        treePda(programId),
        configPda(programId),
        nullifierPda(args.inputNullifiers[0], programId),
        nullifierPda(args.inputNullifiers[1], programId),
        programId,
        SystemProgram.programId,
      ];
    } catch {
      return fail("invalid_request", "an input nullifier is not below the field modulus");
    }
    if (unpayable.some((account) => account.equals(extData.recipient))) {
      return fail("invalid_request", "extData.recipient is an account a withdrawal cannot be paid to");
    }
  }

  const problem = proofEncodingProblem(args.proof);
  if (problem) return fail("invalid_request", problem);
  return { ok: true, value: args };
}
