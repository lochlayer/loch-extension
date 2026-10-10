// Keys v1: everything is derived from one wallet signature, so there is no new
// seed phrase. Whoever holds that signature holds the shielded funds.
//
// The two secrets are NOT independent. `privateKey` is `seed mod r`, so `seed`
// is one of at most six values `privateKey + k * r`, and the right one is
// recognised by deriving `encryptionPublic` from it. Whoever holds the
// spending key therefore also holds the decryption key (the reverse does not
// hold). docs/protocol.md section 3 says so; changing it means a new key
// version, which is a decision for the team.
//
// `selfNoteKey` and `paymentCodeRoot` are symmetric secrets with labels of
// their own. They come from `seed`, not from `encryptionSecret`, on purpose:
// `encryptionPublic` is in every address, and a quantum computer turns it into
// a key that does everything `encryptionSecret` does, so anything derived from
// that key would fall with it. `seed` is a hash of a signature that is never
// published; docs/post-quantum.md has the argument.

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { poseidon1 } from "poseidon-lite/poseidon1";

import { bytesToBigIntBE, concatBytes, utf8 } from "./bytes.js";
import { KEY_DERIVATION_MESSAGE, NOTE_ENCRYPTION_DOMAIN, PAYMENT_CODE_DOMAIN, SELF_NOTE_DOMAIN } from "./constants.js";
import { LochError } from "./errors.js";
import { mod } from "./field.js";

/**
 * A Loch key set. Everything but `publicKey` and `encryptionPublic` is secret;
 * never log or transmit it.
 */
export interface LochKeys {
  /**
   * Spending key: a BN254 scalar. Secret. In keys v1 it also determines
   * `encryptionSecret`, so handing it to anyone (a remote prover, for
   * example) gives them the whole wallet, past and future notes included.
   */
  privateKey: bigint;
  /** `Poseidon(privateKey)`. Owner field of every note this key can spend. */
  publicKey: bigint;
  /** X25519 private key for note decryption (32 bytes). Secret. */
  encryptionSecret: Uint8Array;
  /** X25519 public key senders encrypt notes to (32 bytes). */
  encryptionPublic: Uint8Array;
  /**
   * Pre-shared key of the notes the wallet sends to itself: change, deposits
   * and padding (32 bytes). Secret. It is in no address, so those notes stay
   * unreadable to someone who can break X25519.
   */
  selfNoteKey: Uint8Array;
  /** Root of the wallet's payment codes (32 bytes). Secret. See {@link paymentCodeSecret}. */
  paymentCodeRoot: Uint8Array;
}

/**
 * The exact bytes to pass to `wallet.signMessage`: UTF-8 of
 * {@link KEY_DERIVATION_MESSAGE}.
 */
export function keyDerivationMessage(): Uint8Array {
  return utf8(KEY_DERIVATION_MESSAGE);
}

/**
 * Derives the Loch key set from the wallet's Ed25519 signature of
 * {@link keyDerivationMessage}.
 *
 *   seed             = sha256(signature)
 *   privateKey       = BigInt(seed, big-endian) mod r
 *   publicKey        = Poseidon(privateKey)
 *   encryptionSecret = sha256(utf8("Loch note encryption v1") || seed)
 *   encryptionPublic = X25519 base-point multiplication
 *   selfNoteKey      = sha256(utf8("Loch self note v1") || seed)
 *   paymentCodeRoot  = sha256(utf8("Loch payment code v1") || seed)
 *
 * Pass the wallet's 32-byte Ed25519 public key as `walletPublicKey` and the
 * signature is verified first: a wallet that returns anything other than a
 * real signature of the message would otherwise yield guessable keys.
 *
 * @throws LochError `INVALID_ARGUMENT` if the signature is not 64 bytes,
 *   `INVALID_SIGNATURE` if verification was requested and fails.
 */
export function deriveKeys(signature: Uint8Array, walletPublicKey?: Uint8Array): LochKeys {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new LochError("INVALID_ARGUMENT", "expected the 64-byte Ed25519 signature of the key derivation message");
  }
  if (walletPublicKey !== undefined) {
    let valid = false;
    try {
      valid = walletPublicKey.length === 32 && ed25519.verify(signature, keyDerivationMessage(), walletPublicKey);
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new LochError("INVALID_SIGNATURE", "the wallet did not return a valid signature of the key derivation message");
    }
  }
  const seed = sha256(signature);
  const privateKey = mod(bytesToBigIntBE(seed));
  const encryptionSecret = sha256(concatBytes(utf8(NOTE_ENCRYPTION_DOMAIN), seed));
  return {
    privateKey,
    publicKey: poseidon1([privateKey]),
    encryptionSecret,
    encryptionPublic: x25519.getPublicKey(encryptionSecret),
    selfNoteKey: sha256(concatBytes(utf8(SELF_NOTE_DOMAIN), seed)),
    paymentCodeRoot: sha256(concatBytes(utf8(PAYMENT_CODE_DOMAIN), seed)),
  };
}

/** Largest payment code index: indices are encoded in four bytes. */
export const MAX_PAYMENT_CODE_INDEX = 0xffff_ffff;

/**
 * The secret of the wallet's payment code number `index`:
 * `sha256(paymentCodeRoot || index as u32 big-endian)`. Deterministic, so a wallet restored from its signature can look for notes
 * paid to every code it ever handed out.
 *
 * @throws LochError `INVALID_ARGUMENT` if the root is not 32 bytes or the
 *   index is not an integer from 0 to 2^32 - 1.
 */
export function paymentCodeSecret(paymentCodeRoot: Uint8Array, index: number): Uint8Array {
  if (!(paymentCodeRoot instanceof Uint8Array) || paymentCodeRoot.length !== 32) {
    throw new LochError("INVALID_ARGUMENT", "the payment code root must be 32 bytes");
  }
  if (!Number.isInteger(index) || index < 0 || index > MAX_PAYMENT_CODE_INDEX) {
    throw new LochError("INVALID_ARGUMENT", "a payment code index is an integer from 0 to 2^32 - 1");
  }
  return sha256(concatBytes(paymentCodeRoot, Uint8Array.of(index >>> 24, (index >>> 16) & 0xff, (index >>> 8) & 0xff, index & 0xff)));
}

/** 2^255 - 19, the field X25519 works in. A canonical public key is below it. */
const X25519_PRIME = (1n << 255n) - 19n;
/** Any fixed scalar works for the low-order test; X25519 clamps it to a multiple of 8. */
const PROBE_SCALAR = new Uint8Array(32).fill(0x42);

/**
 * True when `key` is a usable X25519 public key in its one canonical
 * encoding: 32 bytes, little-endian value below 2^255 - 19 (so bit 255 is
 * clear), and not a point of low order.
 *
 * Canonical matters because the raw bytes of the recipient key go into the
 * HKDF salt of note encryption. X25519 itself ignores bit 255 and reduces the
 * value, so a non-canonical encoding of somebody's key gives the same shared
 * secret but a different note key: the sender would create a note the
 * recipient owns and can never find. A low-order point gives an all-zero
 * shared secret that anyone could decrypt.
 */
export function isValidEncryptionPublicKey(key: unknown): key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) return false;
  let value = 0n;
  for (let i = 31; i >= 0; i--) value = (value << 8n) | BigInt(key[i]!);
  if (value >= X25519_PRIME) return false;
  try {
    // noble throws when the result is all zero, which is what a low-order point produces.
    x25519.getSharedSecret(PROBE_SCALAR, key);
    return true;
  } catch {
    return false;
  }
}

/** `Poseidon(privateKey)`: the public key that owns notes spendable with `privateKey`. */
export function publicKeyOf(privateKey: bigint): bigint {
  return poseidon1([privateKey]);
}
