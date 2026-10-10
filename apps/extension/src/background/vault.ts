// The vault: what is kept on disk about a wallet, encrypted.
//
// The key comes from the same wallet signature that derives the shielded keys, under a label of
// its own, so the two never coincide:
//
//   vaultKey = HKDF-SHA256(ikm = signature, salt = 32 random bytes kept beside the data,
//                          info = "Loch extension vault v1" || 0x00 || address) -> AES-256-GCM
//
// Each record is compressed, then sealed with a fresh 96-bit random nonce. The associated data
// names the wallet and the record, so a record cannot be moved to another slot or another wallet
// and still open. Someone with the disk and without the signature learns the wallet's public
// address, how many bytes each record has and when it was written. Nothing else.
//
// The key is not extractable and lives only in memory. The signature it is derived from is kept
// in chrome.storage.session (memory-backed) so a restarted service worker can derive it again.

import { concatBytes, fromBase64, toBase64, utf8 } from "../shared/bytes.js";
import { isBase64, isRecord } from "../shared/guards.js";

export const VAULT_VERSION = 1;
const INFO_LABEL = "Loch extension vault v1";
const SALT_BYTES = 32;
const NONCE_BYTES = 12;

export interface SealedRecord {
  v: typeof VAULT_VERSION;
  /** 96-bit nonce, base64. Fresh for every write. */
  iv: string;
  /** Ciphertext and tag, base64. */
  ct: string;
}

export type VaultErrorReason = "wrong-key" | "malformed";

export class VaultError extends Error {
  constructor(
    readonly reason: VaultErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export function newVaultSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/** Derives the vault key of `address` from the wallet's key-derivation signature. */
export async function deriveVaultKey(signature: Uint8Array, saltBase64: string, address: string): Promise<CryptoKey> {
  if (signature.length !== 64) throw new VaultError("malformed", "a wallet signature is 64 bytes");
  const salt = fromBase64(saltBase64);
  if (salt.length !== SALT_BYTES) throw new VaultError("malformed", "the vault salt is not 32 bytes");
  const material = await crypto.subtle.importKey("raw", signature as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: concatBytes(utf8(INFO_LABEL), Uint8Array.of(0), utf8(address)) as BufferSource },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function associatedData(address: string, record: string): Uint8Array {
  return utf8(`loch-vault|${VAULT_VERSION}|${address}|${record}`);
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as BufferSource).then(
    () => writer.close(),
    () => undefined,
  );
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** Encrypts `value` (anything JSON can hold) as the record `record` of `address`. */
export async function seal(key: CryptoKey, address: string, record: string, value: unknown): Promise<SealedRecord> {
  const plain = await pipe(utf8(JSON.stringify(value)), new CompressionStream("deflate-raw"));
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: associatedData(address, record) as BufferSource },
    key,
    plain as BufferSource,
  );
  return { v: VAULT_VERSION, iv: toBase64(iv), ct: toBase64(new Uint8Array(sealed)) };
}

export function isSealedRecord(value: unknown): value is SealedRecord {
  return isRecord(value) && value.v === VAULT_VERSION && isBase64(value.iv, 16) && value.iv.length === 16 && isBase64(value.ct, 64 * 1024 * 1024);
}

/**
 * Decrypts a record. Throws VaultError "wrong-key" when the key does not open it (another
 * signature, another wallet, another record name, or a changed ciphertext: AES-GCM cannot tell
 * these apart, and neither should the caller), "malformed" when the stored value is not a
 * sealed record at all.
 */
export async function open<T>(key: CryptoKey, address: string, record: string, sealed: unknown): Promise<T> {
  if (!isSealedRecord(sealed)) throw new VaultError("malformed", `the stored ${record} record is not readable`);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(sealed.iv) as BufferSource, additionalData: associatedData(address, record) as BufferSource },
      key,
      fromBase64(sealed.ct) as BufferSource,
    );
  } catch {
    throw new VaultError("wrong-key", `the key does not open the stored ${record} record`);
  }
  try {
    const bytes = await pipe(new Uint8Array(plain), new DecompressionStream("deflate-raw"));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new VaultError("malformed", `the stored ${record} record does not decode`);
  }
}
