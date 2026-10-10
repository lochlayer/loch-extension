import { PublicKey } from "@solana/web3.js";

/**
 * The `loch_pool` program on devnet and localnet. Every function that talks to
 * the program takes a `programId` argument or option that defaults to this.
 */
export const PROGRAM_ID = new PublicKey("Lochn2sJLT2hkqMrx85siFPXa9VUTAAx9EXmkPiJL2j");

/** BN254 scalar field modulus r: the circuit's field. Every public input is below it. */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** BN254 base field modulus q: coordinates of proof points. Used to negate `proof.a`. */
export const BASE_FIELD_MODULUS = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** Depth of the commitment tree: 2^20 leaves, two per transaction. */
export const TREE_DEPTH = 20;

/** The message a wallet signs to derive Loch keys (keys v1). UTF-8, no terminator. */
export const KEY_DERIVATION_MESSAGE = "Loch key derivation v1";

/** Domain separator of the note-encryption key: `sha256(utf8(this) || seed)`. */
export const NOTE_ENCRYPTION_DOMAIN = "Loch note encryption v1";

/** Domain separator of the self-note key: `sha256(utf8(this) || seed)`. */
export const SELF_NOTE_DOMAIN = "Loch self note v1";

/** Domain separator of the payment-code root: `sha256(utf8(this) || seed)`. */
export const PAYMENT_CODE_DOMAIN = "Loch payment code v1";

/** HKDF `info` of the per-note symmetric key. */
export const NOTE_KEY_INFO = "loch-note-v1";

/** HKDF `info` of the per-note symmetric key of a keyed note: one whose key also depends on a pre-shared key. */
export const KEYED_NOTE_KEY_INFO = "loch-note-psk-v1";

/** Human-readable part of a shielded address (bech32m). */
export const ADDRESS_PREFIX = "loch";

/** Human-readable part of a payment code (bech32m). */
export const PAYMENT_CODE_PREFIX = "lochpay";

/**
 * How many payment codes in a row may be handed out without one of them being
 * paid, and how far past the last code known to be in use a wallet looks for
 * notes. The two are one number on purpose: a wallet restored from nothing
 * then finds every note paid to a code (docs/protocol.md section 6).
 */
export const PAYMENT_CODE_GAP = 20;

/** Exact length of an encrypted note v1: 32 (ephemeral key) + 39 (ciphertext) + 16 (tag). */
export const ENCRYPTED_NOTE_LENGTH = 87;

/** Largest encrypted output the program accepts (`MAX_ENCRYPTED_OUTPUT`). */
export const MAX_ENCRYPTED_OUTPUT_LENGTH = 256;

/** Lamport amounts are unsigned 64-bit: `0 <= amount <= MAX_AMOUNT`. */
export const MAX_AMOUNT = (1n << 64n) - 1n;

/**
 * Compute-unit limit set on transactions unless the caller overrides it. A
 * `transact` was measured at 159k to 176k (docs/benchmarks.md); the runtime's
 * default of 200k is too tight.
 */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 300_000;

/**
 * Commitment level every RPC read of the SDK uses unless the caller passes
 * another one. `finalized` (what a `Connection` without a commitment uses) is
 * about 13 seconds behind and makes a transaction that just confirmed look as
 * if it never landed; `processed` can show state that is later dropped.
 */
export const DEFAULT_COMMITMENT = "confirmed";

/**
 * Rent-exempt minimum of a system account without data, in lamports. A
 * withdrawal to an account that does not exist yet must be at least this much
 * or the runtime rejects the transaction. It follows from the cluster's rent
 * parameters (3,480 lamports per byte-year, two years, 128 bytes of account
 * overhead), which have never changed on any public cluster; read
 * `getMinimumBalanceForRentExemption(0)` to be certain.
 */
export const SYSTEM_ACCOUNT_RENT_EXEMPT_MINIMUM = 890_880n;

/** Largest serialised transaction a Solana node accepts, in bytes. */
export const MAX_TRANSACTION_SIZE = 1232;

/** Anchor discriminator of `transact`: `sha256("global:transact")[0..8]`. */
export const TRANSACT_DISCRIMINATOR: Uint8Array = Uint8Array.of(217, 149, 130, 143, 221, 52, 252, 119);

/** Anchor discriminator of the `NewCommitment` event: `sha256("event:NewCommitment")[0..8]`. */
export const NEW_COMMITMENT_DISCRIMINATOR: Uint8Array = Uint8Array.of(78, 21, 75, 243, 5, 132, 204, 67);

/** Anchor discriminator of the `NewNullifiers` event: `sha256("event:NewNullifiers")[0..8]`. */
export const NEW_NULLIFIERS_DISCRIMINATOR: Uint8Array = Uint8Array.of(74, 254, 10, 38, 98, 254, 216, 119);

/** Anchor discriminator of the `PoolConfig` account: `sha256("account:PoolConfig")[0..8]`. */
export const POOL_CONFIG_DISCRIMINATOR: Uint8Array = Uint8Array.of(26, 108, 14, 123, 116, 230, 129, 43);

/** Anchor discriminator of the `MerkleTree` account: `sha256("account:MerkleTree")[0..8]`. */
export const MERKLE_TREE_DISCRIMINATOR: Uint8Array = Uint8Array.of(98, 51, 51, 226, 162, 20, 73, 212);

/** Anchor discriminator of the `NullifierRecord` account: `sha256("account:NullifierRecord")[0..8]`. */
export const NULLIFIER_RECORD_DISCRIMINATOR: Uint8Array = Uint8Array.of(56, 18, 57, 175, 69, 202, 189, 70);
