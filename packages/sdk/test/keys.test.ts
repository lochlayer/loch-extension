import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bech32, bech32m } from "@scure/base";
import { describe, expect, it } from "vitest";

import { bigIntToBytesBE, bytesToBigIntBE, concatBytes, utf8 } from "../src/bytes.js";
import {
  AddressError,
  FIELD_MODULUS,
  KEY_DERIVATION_MESSAGE,
  LochError,
  decodeShieldedAddress,
  deriveKeys,
  encodeShieldedAddress,
  isShieldedAddress,
  keyDerivationMessage,
} from "../src/index.js";
import { publicKeyOf } from "../src/keys.js";
import { lochKeys, signDerivationMessage, wallet } from "./helpers/fixtures.js";

describe("key derivation v1", () => {
  it("signs exactly the UTF-8 bytes of the documented message", () => {
    expect(KEY_DERIVATION_MESSAGE).toBe("Loch key derivation v1");
    expect(new TextDecoder().decode(keyDerivationMessage())).toBe("Loch key derivation v1");
    expect(keyDerivationMessage()).toHaveLength(22);
  });

  it("follows the specification step by step", () => {
    const signature = signDerivationMessage(wallet("alice"));
    const keys = deriveKeys(signature);
    const seed = sha256(signature);
    expect(keys.privateKey).toBe(bytesToBigIntBE(seed) % FIELD_MODULUS);
    expect(keys.publicKey).toBe(publicKeyOf(keys.privateKey));
    expect(keys.encryptionSecret).toEqual(sha256(concatBytes(utf8("Loch note encryption v1"), seed)));
    expect(keys.encryptionPublic).toEqual(x25519.getPublicKey(keys.encryptionSecret));
    expect(keys.privateKey < FIELD_MODULUS).toBe(true);
  });

  it("is deterministic: the same signature gives the same keys", () => {
    const signature = signDerivationMessage(wallet("alice"));
    expect(signDerivationMessage(wallet("alice"))).toEqual(signature);
    expect(deriveKeys(signature)).toEqual(deriveKeys(Uint8Array.from(signature)));
  });

  it("gives unrelated keys to different wallets and to a signature that differs in one bit", () => {
    const alice = lochKeys("alice");
    const bob = lochKeys("bob");
    expect(alice.privateKey).not.toBe(bob.privateKey);
    expect(alice.encryptionPublic).not.toEqual(bob.encryptionPublic);
    const signature = signDerivationMessage(wallet("alice"));
    signature[63]! ^= 1;
    const flipped = deriveKeys(signature);
    expect(flipped.privateKey).not.toBe(alice.privateKey);
    expect(flipped.encryptionSecret).not.toEqual(alice.encryptionSecret);
  });

  it("derives the encryption key under its own label: neither secret is simply the other", () => {
    const keys = lochKeys("alice");
    expect(bytesToBigIntBE(keys.encryptionSecret) % FIELD_MODULUS).not.toBe(keys.privateKey);
    expect(keys.encryptionSecret).not.toEqual(bigIntToBytesBE(keys.privateKey, 32));
    expect(keys.encryptionSecret).not.toEqual(sha256(signDerivationMessage(wallet("alice"))));
  });

  it("keys v1: the spending key determines the encryption key, as docs/protocol.md section 3 states", () => {
    // privateKey = seed mod r and 2^256 / r is about 5.3, so seed is one of at most six
    // values privateKey + k * r. The right one reproduces the public encryption key.
    for (const name of ["alice", "bob", "carol"]) {
      const keys = lochKeys(name);
      const recovered: Uint8Array[] = [];
      for (let k = 0n; k < 6n; k++) {
        const candidate = keys.privateKey + k * FIELD_MODULUS;
        if (candidate >> 256n !== 0n) break;
        const secret = sha256(concatBytes(utf8("Loch note encryption v1"), bigIntToBytesBE(candidate, 32)));
        if (Buffer.from(x25519.getPublicKey(secret)).equals(Buffer.from(keys.encryptionPublic))) recovered.push(secret);
      }
      // If this ever stops holding, the derivation changed: update the statement in the protocol document.
      expect(recovered).toEqual([keys.encryptionSecret]);
    }
  });

  it("rejects anything that is not a 64-byte signature", () => {
    expect(() => deriveKeys(new Uint8Array(63))).toThrow(LochError);
    expect(() => deriveKeys(new Uint8Array(65))).toThrow(/64-byte/);
    expect(() => deriveKeys("00".repeat(64) as unknown as Uint8Array)).toThrow(/64-byte/);
  });

  it("verifies the signature when given the wallet's public key", () => {
    const alice = wallet("alice");
    const signature = signDerivationMessage(alice);
    expect(deriveKeys(signature, alice.publicKey.toBytes())).toEqual(deriveKeys(signature));
    expect(() => deriveKeys(signature, wallet("bob").publicKey.toBytes())).toThrow(/valid signature/);
    // A wallet that returns a constant instead of a signature would give everyone the same keys.
    expect(() => deriveKeys(new Uint8Array(64), alice.publicKey.toBytes())).toThrow(
      expect.objectContaining({ code: "INVALID_SIGNATURE" }),
    );
  });

  it("never puts key material into an error message", () => {
    const alice = wallet("alice");
    const signature = signDerivationMessage(alice);
    try {
      deriveKeys(signature, wallet("bob").publicKey.toBytes());
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toMatch(/[0-9a-f]{16}/i);
      expect(message).not.toMatch(/\d{12}/);
    }
  });
});

describe("shielded address", () => {
  const keys = lochKeys("alice");
  const address = encodeShieldedAddress(keys);

  it("is bech32m with the prefix loch and a 64-byte payload", () => {
    expect(address).toMatch(/^loch1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{109}$/);
    expect(address).toHaveLength(114);
    const payload = bech32m.fromWords(bech32m.decode(address as `${string}1${string}`, 200).words);
    expect(payload).toEqual(concatBytes(bigIntToBytesBE(keys.publicKey, 32), keys.encryptionPublic));
  });

  it("round-trips", () => {
    const decoded = decodeShieldedAddress(address);
    expect(decoded.publicKey).toBe(keys.publicKey);
    expect(decoded.encryptionPublic).toEqual(keys.encryptionPublic);
    expect(encodeShieldedAddress(decoded)).toBe(address);
    expect(isShieldedAddress(address)).toBe(true);
  });

  it("accepts an all-upper-case address and rejects mixed case", () => {
    expect(decodeShieldedAddress(address.toUpperCase()).publicKey).toBe(keys.publicKey);
    const mixed = address.slice(0, 20) + address.slice(20).toUpperCase();
    expect(() => decodeShieldedAddress(mixed)).toThrow(expect.objectContaining({ reason: "encoding" }));
  });

  const reason = (text: string) => {
    try {
      decodeShieldedAddress(text);
    } catch (error) {
      expect(error).toBeInstanceOf(AddressError);
      expect((error as AddressError).code).toBe("INVALID_ADDRESS");
      return (error as AddressError).reason;
    }
    return "accepted";
  };

  it("reports a bad checksum", () => {
    const last = address.at(-1) === "q" ? "p" : "q";
    expect(reason(address.slice(0, -1) + last)).toBe("checksum");
    const middle = address[50] === "q" ? "p" : "q";
    expect(reason(address.slice(0, 50) + middle + address.slice(51))).toBe("checksum");
    expect(isShieldedAddress(address.slice(0, -1) + last)).toBe(false);
  });

  it("reports plain bech32 (not bech32m) as a bad checksum", () => {
    const payload = concatBytes(bigIntToBytesBE(keys.publicKey, 32), keys.encryptionPublic);
    expect(reason(bech32.encode("loch", bech32.toWords(payload), 200))).toBe("checksum");
  });

  it("reports a wrong prefix, even when the checksum is valid", () => {
    const payload = concatBytes(bigIntToBytesBE(keys.publicKey, 32), keys.encryptionPublic);
    expect(reason(bech32m.encode("lock", bech32m.toWords(payload), 200))).toBe("prefix");
    expect(reason(bech32m.encode("bc", bech32m.toWords(payload), 200))).toBe("prefix");
    expect(reason(`sol${address.slice(4)}`)).toBe("prefix");
  });

  it("reports a wrong length", () => {
    for (const length of [0, 32, 63, 65, 96]) {
      const short = bech32m.encode("loch", bech32m.toWords(new Uint8Array(length).fill(1)), 400);
      expect(reason(short)).toBe("length");
    }
  });

  it("reports things that are not bech32 at all", () => {
    expect(reason("")).toBe("encoding");
    expect(reason("loch")).toBe("encoding");
    expect(reason("loch1")).toBe("encoding");
    expect(reason("loch1abc!def")).toBe("encoding");
    expect(reason("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe("encoding");
    expect(reason(42 as unknown as string)).toBe("encoding");
  });

  it("rejects a public key that is not a field element", () => {
    const payload = concatBytes(bigIntToBytesBE(FIELD_MODULUS, 32), keys.encryptionPublic);
    expect(reason(bech32m.encode("loch", bech32m.toWords(payload), 200))).toBe("public_key_range");
    expect(() => encodeShieldedAddress({ publicKey: FIELD_MODULUS, encryptionPublic: keys.encryptionPublic })).toThrow(/field element/);
    expect(() => encodeShieldedAddress({ publicKey: 1n, encryptionPublic: new Uint8Array(31) })).toThrow(/32 bytes/);
  });

  it("rejects an encryption key that is not the canonical encoding of a usable X25519 key", () => {
    const withKey = (encryptionPublic: Uint8Array) =>
      bech32m.encode("loch", bech32m.toWords(concatBytes(bigIntToBytesBE(keys.publicKey, 32), encryptionPublic)), 200);
    const le = (value: bigint) => bigIntToBytesBE(value, 32).reverse();
    const p = (1n << 255n) - 19n;
    const own = bytesToBigIntBE(Uint8Array.from(keys.encryptionPublic).reverse());
    expect(reason(withKey(le(own)))).toBe("accepted");

    // A second encoding of Alice's own key. X25519 ignores bit 255, so a sender would compute the
    // right shared secret, but the raw bytes go into the note key's salt: Alice could never decrypt.
    const bit255 = Uint8Array.from(keys.encryptionPublic);
    bit255[31]! |= 0x80;
    expect(x25519.getSharedSecret(new Uint8Array(32).fill(7), bit255)).toEqual(x25519.getSharedSecret(new Uint8Array(32).fill(7), keys.encryptionPublic));
    expect(reason(withKey(bit255))).toBe("encryption_key");
    // Values from 2^255 - 19 up are second encodings of small values.
    expect(reason(withKey(le(p + 9n)))).toBe("encryption_key");
    expect(reason(withKey(le(p)))).toBe("encryption_key");
    // Points of low order: the shared secret would be all zero.
    const lowOrder = [
      0n,
      1n,
      p - 1n,
      325606250916557431795983626356110631294008115727848805560023387167927233504n,
      39382357235489614581723060781553021112529911719440698176882885853963445705823n,
    ];
    for (const point of lowOrder) {
      expect(reason(withKey(le(point))), point.toString()).toBe("encryption_key");
      expect(isShieldedAddress(withKey(le(point)))).toBe(false);
      expect(() => encodeShieldedAddress({ publicKey: keys.publicKey, encryptionPublic: le(point) })).toThrow(/canonical X25519/);
    }
    expect(() => encodeShieldedAddress({ publicKey: keys.publicKey, encryptionPublic: bit255 })).toThrow(/canonical X25519/);
    // Every address that decodes re-encodes to itself: one recipient, one address.
    expect(encodeShieldedAddress(decodeShieldedAddress(address))).toBe(address);
  });

  it("does not echo the address in error messages", () => {
    const bad = address.slice(0, -1) + (address.at(-1) === "q" ? "p" : "q");
    try {
      decodeShieldedAddress(bad);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(bad.slice(5, 30));
    }
  });
});
