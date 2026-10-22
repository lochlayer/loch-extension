// Constants of Loch v2 (docs/v2.md). v1's constants are in ../constants.ts and
// are untouched: v1 and v2 live side by side in the one program.

import { PublicKey } from "@solana/web3.js";

/** Depth of the v2 commitment tree: 2^26 leaves, four per transaction. */
export const TREE_DEPTH_V2 = 26;

/** Leaves every v2 transaction appends: three outputs and a swap leaf (or zero). */
export const LEAVES_PER_TRANSACTION_V2 = 4;

/** Inputs and outputs of the v2 circuit. */
export const INPUTS_V2 = 2;
export const OUTPUTS_V2 = 3;

/** Exact length of an encrypted note v2: 32 (epk) + 55 (plaintext) + 16 (tag). */
export const ENCRYPTED_NOTE_V2_LENGTH = 103;

/** Diversifier length in bytes. */
export const DIVERSIFIER_LENGTH = 16;

/** Labels of the key derivation (`wide(label)` and `sha256(label || seed)`). */
export const SPEND_KEY_LABEL = "Loch spend key v2";
export const NULLIFIER_KEY_LABEL = "Loch nullifier key v2";
export const INCOMING_VIEWING_KEY_LABEL = "Loch incoming viewing key v2";
export const DIVERSIFIER_KEY_LABEL = "Loch diversifier key v2";
export const SELF_NOTE_LABEL_V2 = "Loch self note v2";
export const PAYMENT_CODE_LABEL_V2 = "Loch payment code v2";
export const DIVERSIFIED_BASE_LABEL = "Loch diversified base v2";
export const ASSET_ID_LABEL = "loch-asset-v2";

/** HKDF `info` strings of note encryption v2. */
export const NOTE_KEY_INFO_V2 = "loch-note-v2";
export const KEYED_NOTE_KEY_INFO_V2 = "loch-note-psk-v2";

/** Human-readable parts of the v2 viewing keys. Addresses and payment codes keep v1's prefixes; their length tells the versions apart. */
export const FULL_VIEWING_KEY_PREFIX = "lochfvk";
export const INCOMING_VIEWING_KEY_PREFIX = "lochivk";

/** Order of the ristretto255 group. */
export const RISTRETTO_ORDER = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

/** The native mint: the asset SOL stands for. SOL is held as lamports, never wrapped, except inside a swap. */
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** The SPL Token program, the only token program v2 accepts. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** The associated token account program (swap escrows are ATAs of the swap authority). */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Jupiter v6, the router of the mainnet pool. The program checks the router against its own config. */
export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/** Compute-unit limit of a v2 transact (proof with nine public inputs, four leaves, event CPI). */
export const DEFAULT_COMPUTE_UNIT_LIMIT_V2 = 400_000;

/** Compute-unit limit of a swap: the router's own cost comes on top of a transact's. */
export const DEFAULT_SWAP_COMPUTE_UNIT_LIMIT = 1_400_000;

/** Anchor's event-CPI instruction tag: `sha256("anchor:event")[0..8]`, little-endian u64 0x1d9acb512ea545e4. */
export const EVENT_IX_TAG: Uint8Array = Uint8Array.of(0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d);
