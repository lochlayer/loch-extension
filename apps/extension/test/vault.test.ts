import { describe, expect, it } from "vitest";

import { VaultError, deriveVaultKey, isSealedRecord, newVaultSalt, open, seal } from "../src/background/vault.js";
import { fromBase64, toBase64 } from "../src/shared/bytes.js";

const ADDRESS = "Fh3qJ5iBgbd2x9vVqk1mF7yq8a3xgWzJYQeU1cTz8KTz";
const signature = (fill: number) => new Uint8Array(64).fill(fill);

describe("the vault", () => {
  it("round-trips a value under the key derived from the wallet signature", async () => {
    const salt = newVaultSalt();
    const key = await deriveVaultKey(signature(7), salt, ADDRESS);
    const value = { leaves: ["1", "2"], notes: [{ amount: "12480000000", blinding: "99" }], nested: { ok: true } };
    const sealed = await seal(key, ADDRESS, "state", value);
    expect(isSealedRecord(sealed)).toBe(true);
    // The same signature and salt, derived again (a new browser session), opens it.
    const again = await deriveVaultKey(signature(7), salt, ADDRESS);
    expect(await open(again, ADDRESS, "state", sealed)).toEqual(value);
  });

  it("does not open with a key from another signature", async () => {
    const salt = newVaultSalt();
    const sealed = await seal(await deriveVaultKey(signature(7), salt, ADDRESS), ADDRESS, "state", { balance: "5" });
    const wrong = await deriveVaultKey(signature(8), salt, ADDRESS);
    await expect(open(wrong, ADDRESS, "state", sealed)).rejects.toMatchObject({ name: "VaultError", reason: "wrong-key" });
  });

  it("does not open with another salt, another address or under another record name", async () => {
    const salt = newVaultSalt();
    const key = await deriveVaultKey(signature(7), salt, ADDRESS);
    const sealed = await seal(key, ADDRESS, "state", { balance: "5" });
    await expect(open(await deriveVaultKey(signature(7), newVaultSalt(), ADDRESS), ADDRESS, "state", sealed)).rejects.toBeInstanceOf(VaultError);
    await expect(open(await deriveVaultKey(signature(7), salt, "9fRk7Xw2mVd"), "9fRk7Xw2mVd", "state", sealed)).rejects.toBeInstanceOf(VaultError);
    // The key is right, the slot is not: a record cannot be moved to another name or wallet.
    await expect(open(key, ADDRESS, "activity", sealed)).rejects.toMatchObject({ reason: "wrong-key" });
    await expect(open(key, "9fRk7Xw2mVd", "state", sealed)).rejects.toMatchObject({ reason: "wrong-key" });
  });

  it("detects a changed ciphertext", async () => {
    const key = await deriveVaultKey(signature(7), newVaultSalt(), ADDRESS);
    const sealed = await seal(key, ADDRESS, "state", { balance: "5" });
    const bytes = fromBase64(sealed.ct);
    bytes[3] = bytes[3]! ^ 1;
    await expect(open(key, ADDRESS, "state", { ...sealed, ct: toBase64(bytes) })).rejects.toMatchObject({ reason: "wrong-key" });
  });

  it("uses a fresh nonce for every write", async () => {
    const key = await deriveVaultKey(signature(7), newVaultSalt(), ADDRESS);
    const sealed = await Promise.all(Array.from({ length: 50 }, () => seal(key, ADDRESS, "state", { same: "value" })));
    expect(new Set(sealed.map((record) => record.iv)).size).toBe(50);
    expect(new Set(sealed.map((record) => record.ct)).size).toBe(50);
  });

  it("stores nothing readable", async () => {
    const key = await deriveVaultKey(signature(7), newVaultSalt(), ADDRESS);
    const sealed = await seal(key, ADDRESS, "state", { secretMarker: "12480000000-blinding-nullifier" });
    const stored = JSON.stringify(sealed);
    expect(stored).not.toContain("secretMarker");
    expect(Buffer.from(sealed.ct, "base64").toString("latin1")).not.toContain("12480000000");
  });

  it("refuses values that are not sealed records, and bad key material", async () => {
    const key = await deriveVaultKey(signature(7), newVaultSalt(), ADDRESS);
    for (const value of [null, {}, { v: 2, iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" }, { v: 1, iv: "short", ct: "AAAA" }, "text"]) {
      await expect(open(key, ADDRESS, "state", value)).rejects.toMatchObject({ reason: "malformed" });
    }
    await expect(deriveVaultKey(new Uint8Array(63), newVaultSalt(), ADDRESS)).rejects.toMatchObject({ reason: "malformed" });
    await expect(deriveVaultKey(signature(1), toBase64(new Uint8Array(8)), ADDRESS)).rejects.toMatchObject({ reason: "malformed" });
  });

  it("the key cannot be exported", async () => {
    const key = await deriveVaultKey(signature(7), newVaultSalt(), ADDRESS);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
  });
});
