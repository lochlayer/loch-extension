import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { describe, expect, it } from "vitest";

import { bigIntToBytesBE, bigIntToBytesLE, concatBytes, randomBytes, utf8 } from "../src/bytes.js";
import { ENCRYPTED_NOTE_LENGTH, createNote, encryptNote, fieldToBytes, noteCommitment, tryDecryptNote } from "../src/index.js";
import { lochKeys } from "./helpers/fixtures.js";

const alice = lochKeys("alice");
const bob = lochKeys("bob");

/** Encrypts arbitrary plaintext the way encryptNote does, to build adversarial ciphertexts. */
function seal(plaintext: Uint8Array, recipientPublic: Uint8Array): Uint8Array {
  const ephemeralSecret = randomBytes(32);
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const key = hkdf(
    sha256,
    x25519.getSharedSecret(ephemeralSecret, recipientPublic),
    concatBytes(ephemeralPublic, recipientPublic),
    utf8("loch-note-v1"),
    32,
  );
  return concatBytes(ephemeralPublic, chacha20poly1305(key, new Uint8Array(12)).encrypt(plaintext));
}

describe("note encryption v1", () => {
  const note = createNote(1_234_567_890n, bob.publicKey);
  const commitment = noteCommitment(note);

  it("is exactly 87 bytes for every amount", () => {
    expect(ENCRYPTED_NOTE_LENGTH).toBe(87);
    for (const amount of [0n, 1n, 1_000_000_000n, (1n << 64n) - 1n]) {
      expect(encryptNote(createNote(amount, bob.publicKey), bob.encryptionPublic)).toHaveLength(87);
    }
  });

  it("round-trips: the recipient recovers amount and blinding", () => {
    const encrypted = encryptNote(note, bob.encryptionPublic);
    expect(tryDecryptNote(encrypted, bob, commitment)).toEqual(note);
    // The commitment may be given as the 32 bytes the event carries.
    expect(tryDecryptNote(encrypted, bob, fieldToBytes(commitment))).toEqual(note);
  });

  it("round-trips the extreme values", () => {
    const extreme = createNote((1n << 64n) - 1n, bob.publicKey, (1n << 248n) - 1n);
    expect(tryDecryptNote(encryptNote(extreme, bob.encryptionPublic), bob, noteCommitment(extreme))).toEqual(extreme);
    const zero = createNote(0n, bob.publicKey, 0n);
    expect(tryDecryptNote(encryptNote(zero, bob.encryptionPublic), bob, noteCommitment(zero))).toEqual(zero);
  });

  it("uses the documented construction, so another implementation can decrypt", () => {
    const encrypted = encryptNote(note, bob.encryptionPublic);
    const ephemeralPublic = encrypted.subarray(0, 32);
    const key = hkdf(
      sha256,
      x25519.getSharedSecret(bob.encryptionSecret, ephemeralPublic),
      concatBytes(ephemeralPublic, bob.encryptionPublic),
      utf8("loch-note-v1"),
      32,
    );
    const plaintext = chacha20poly1305(key, new Uint8Array(12)).decrypt(encrypted.subarray(32));
    expect(plaintext).toEqual(concatBytes(bigIntToBytesLE(note.amount, 8), bigIntToBytesBE(note.blinding, 31)));
  });

  it("uses a fresh ephemeral key for every note", () => {
    const first = encryptNote(note, bob.encryptionPublic);
    const second = encryptNote(note, bob.encryptionPublic);
    expect(first.subarray(0, 32)).not.toEqual(second.subarray(0, 32));
    expect(first.subarray(32)).not.toEqual(second.subarray(32));
  });

  it("returns null for the wrong recipient", () => {
    const encrypted = encryptNote(note, bob.encryptionPublic);
    expect(tryDecryptNote(encrypted, alice, commitment)).toBeNull();
  });

  it("returns null for a tampered ciphertext, whichever byte changes", () => {
    const encrypted = encryptNote(note, bob.encryptionPublic);
    for (const position of [0, 31, 32, 50, 70, 71, 86]) {
      const tampered = Uint8Array.from(encrypted);
      tampered[position]! ^= 0x01;
      expect(tryDecryptNote(tampered, bob, commitment)).toBeNull();
    }
  });

  it("returns null for any length other than 87, without throwing", () => {
    const encrypted = encryptNote(note, bob.encryptionPublic);
    for (const candidate of [
      new Uint8Array(0),
      encrypted.subarray(0, 86),
      concatBytes(encrypted, Uint8Array.of(0)),
      new Uint8Array(256),
      randomBytes(87),
    ]) {
      expect(tryDecryptNote(candidate, bob, commitment)).toBeNull();
    }
    expect(tryDecryptNote("not bytes" as unknown as Uint8Array, bob, commitment)).toBeNull();
    expect(tryDecryptNote(new Uint8Array(87), bob, commitment)).toBeNull(); // all-zero ephemeral key
  });

  it("rejects a note that decrypts but does not match the on-chain commitment", () => {
    const encrypted = encryptNote(note, bob.encryptionPublic);
    // The sender published a commitment to something else (another amount, or another owner).
    expect(tryDecryptNote(encrypted, bob, noteCommitment(createNote(note.amount + 1n, bob.publicKey, note.blinding)))).toBeNull();
    expect(tryDecryptNote(encrypted, bob, noteCommitment({ ...note, publicKey: alice.publicKey }))).toBeNull();
    expect(tryDecryptNote(encrypted, bob, commitment + 1n)).toBeNull();
  });

  it("rejects a well-encrypted note addressed to this encryption key but owned by another spending key", () => {
    // Mallory encrypts to Bob's encryption key a note that Alice owns. The AEAD tag is fine;
    // only the commitment check tells Bob the note is not his to spend.
    const alices = createNote(5n, alice.publicKey);
    const encrypted = encryptNote(alices, bob.encryptionPublic);
    expect(tryDecryptNote(encrypted, bob, noteCommitment(alices))).toBeNull();
  });

  it("rejects a valid ciphertext whose plaintext is not 39 bytes", () => {
    const sealed = seal(new Uint8Array(39), bob.encryptionPublic);
    expect(sealed).toHaveLength(87);
    expect(tryDecryptNote(sealed, bob, noteCommitment(createNote(0n, bob.publicKey, 0n)))).not.toBeNull();
    expect(tryDecryptNote(seal(new Uint8Array(38), bob.encryptionPublic), bob, commitment)).toBeNull();
  });

  it("refuses to encrypt to a second encoding of the recipient's key, which the recipient could not decrypt", () => {
    // Bit 255 set: the same point to X25519, different bytes in the salt of the note key.
    const alias = Uint8Array.from(bob.encryptionPublic);
    alias[31]! |= 0x80;
    // What used to happen: the note is created, the commitment is Bob's, and Bob never finds it.
    const stranded = seal(concatBytes(bigIntToBytesLE(note.amount, 8), bigIntToBytesBE(note.blinding, 31)), alias);
    expect(tryDecryptNote(stranded, bob, commitment)).toBeNull();
    // Now the sender is stopped before it creates such a note.
    expect(() => encryptNote(note, alias)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => encryptNote(note, alias)).toThrow(/X25519/);
    expect(tryDecryptNote(encryptNote(note, bob.encryptionPublic), bob, commitment)).toEqual(note);
  });

  it("refuses to encrypt to an invalid key or an invalid note", () => {
    expect(() => encryptNote(note, new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => encryptNote(note, new Uint8Array(32))).toThrow(/X25519/);
    expect(() => encryptNote({ ...note, amount: 1n << 64n }, bob.encryptionPublic)).toThrow(/amount/);
    expect(() => encryptNote({ ...note, blinding: 1n << 248n }, bob.encryptionPublic)).toThrow(/blinding/);
  });
});
