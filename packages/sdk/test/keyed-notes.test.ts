// Keyed notes: the notes a wallet sends to itself, and notes paid to a payment
// code. Their key takes the X25519 exchange and a pre-shared key, so somebody
// who can break X25519 (which is what a quantum computer would do to it) still
// cannot read them. docs/protocol.md sections 3, 4 and 6; docs/post-quantum.md.

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { bech32m } from "@scure/base";
import { describe, expect, it } from "vitest";

import { bigIntToBytesBE, bigIntToBytesLE, concatBytes, randomBytes, utf8 } from "../src/bytes.js";
import {
  AddressError,
  ENCRYPTED_NOTE_LENGTH,
  type LochKeys,
  type NewCommitmentEvent,
  type NoteOpeningKeys,
  PAYMENT_CODE_GAP,
  type PaymentCode,
  type PreparedTransact,
  applyEvents,
  balance,
  buildTransactTransaction,
  createNote,
  createWalletState,
  decodePaymentCode,
  decodeRecipient,
  decodeShieldedAddress,
  encodePaymentCode,
  encodeShieldedAddress,
  encryptNote,
  fetchPoolConfig,
  isPaymentCode,
  isShieldedAddress,
  issuePaymentCode,
  noteCommitment,
  openNote,
  parseWalletState,
  paymentCodeAt,
  paymentCodeCounts,
  paymentCodeSecret,
  prepareDeposit,
  prepareTransact,
  prepareTransfer,
  prepareWithdrawal,
  syncWallet,
  tryDecryptNote,
} from "../src/index.js";
import { isValidEncryptionPublicKey } from "../src/keys.js";
import { checkingProver } from "./helpers/checkingProver.js";
import { FakePool } from "./helpers/fakePool.js";
import { SOL, address, lochKeys, signDerivationMessage, wallet } from "./helpers/fixtures.js";

const alice = lochKeys("alice");
const bob = lochKeys("bob");

/**
 * What somebody holds who has broken a wallet's X25519 key: everything the
 * address shows, and the means to redo every exchange. Not the pre-shared keys.
 */
const breakerOf = (keys: LochKeys): NoteOpeningKeys => ({
  publicKey: keys.publicKey,
  encryptionSecret: keys.encryptionSecret,
  encryptionPublic: keys.encryptionPublic,
});

const candidates = (keys: LochKeys, count: number) =>
  Array.from({ length: count }, (_, index) => ({ index, secret: paymentCodeSecret(keys.paymentCodeRoot, index) }));

describe("keys v1: the two symmetric secrets", () => {
  it("follow the specification step by step", () => {
    const seed = sha256(signDerivationMessage(wallet("alice")));
    expect(alice.selfNoteKey).toEqual(sha256(concatBytes(utf8("Loch self note v1"), seed)));
    expect(alice.paymentCodeRoot).toEqual(sha256(concatBytes(utf8("Loch payment code v1"), seed)));
    expect(paymentCodeSecret(alice.paymentCodeRoot, 0)).toEqual(sha256(concatBytes(alice.paymentCodeRoot, Uint8Array.of(0, 0, 0, 0))));
    expect(paymentCodeSecret(alice.paymentCodeRoot, 0x01020304)).toEqual(sha256(concatBytes(alice.paymentCodeRoot, Uint8Array.of(1, 2, 3, 4))));
  });

  it("are four different secrets, per wallet", () => {
    const secrets = [alice.encryptionSecret, alice.selfNoteKey, alice.paymentCodeRoot, bob.selfNoteKey, bob.paymentCodeRoot].map((secret) => Buffer.from(secret).toString("hex"));
    expect(new Set(secrets).size).toBe(secrets.length);
    for (const secret of [alice.selfNoteKey, alice.paymentCodeRoot]) expect(secret).toHaveLength(32);
  });

  it("do not follow from the X25519 key: nothing a broken encryption key gives leads to them", () => {
    // The labels hash the seed, not the encryption secret. Were they derived from encryptionSecret,
    // these would be equal and a keyed note would be no better than an address note.
    for (const label of ["Loch self note v1", "Loch payment code v1"]) {
      const fromEncryptionKey = sha256(concatBytes(utf8(label), alice.encryptionSecret));
      expect(fromEncryptionKey).not.toEqual(alice.selfNoteKey);
      expect(fromEncryptionKey).not.toEqual(alice.paymentCodeRoot);
    }
  });

  it("gives every payment code index its own secret and refuses an index that is not one", () => {
    const secrets = Array.from({ length: 50 }, (_, index) => Buffer.from(paymentCodeSecret(alice.paymentCodeRoot, index)).toString("hex"));
    expect(new Set(secrets).size).toBe(50);
    expect(paymentCodeSecret(alice.paymentCodeRoot, 7)).toEqual(paymentCodeSecret(alice.paymentCodeRoot, 7));
    expect(paymentCodeSecret(alice.paymentCodeRoot, 7)).not.toEqual(paymentCodeSecret(bob.paymentCodeRoot, 7));
    expect(paymentCodeSecret(alice.paymentCodeRoot, 0xffff_ffff)).toHaveLength(32);
    for (const index of [-1, 0.5, 2 ** 32, Number.NaN]) {
      expect(() => paymentCodeSecret(alice.paymentCodeRoot, index)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    }
    expect(() => paymentCodeSecret(new Uint8Array(31), 0)).toThrow(/32 bytes/);
  });
});

describe("payment code", () => {
  const code = paymentCodeAt(alice, 3);
  const text = encodePaymentCode(code);

  it("is the address and a secret: bech32m, prefix lochpay, a 96-byte payload, 168 characters", () => {
    expect(text).toMatch(/^lochpay1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{160}$/);
    expect(text).toHaveLength(168);
    const payload = bech32m.fromWords(bech32m.decode(text as `${string}1${string}`, 200).words);
    expect(payload).toEqual(concatBytes(bigIntToBytesBE(alice.publicKey, 32), alice.encryptionPublic, paymentCodeSecret(alice.paymentCodeRoot, 3)));
    expect(code.publicKey).toBe(alice.publicKey);
    expect(code.encryptionPublic).toEqual(alice.encryptionPublic);
  });

  it("round-trips, in lower and in upper case", () => {
    expect(decodePaymentCode(text)).toEqual(code);
    expect(decodePaymentCode(text.toUpperCase())).toEqual(code);
    expect(isPaymentCode(text)).toBe(true);
    expect(encodePaymentCode(decodePaymentCode(text))).toBe(text);
  });

  it("is not an address and an address is not a payment code: each decoder refuses the other", () => {
    const plain = encodeShieldedAddress(alice);
    expect(() => decodeShieldedAddress(text)).toThrow(expect.objectContaining({ reason: "prefix" }));
    expect(() => decodePaymentCode(plain)).toThrow(expect.objectContaining({ reason: "prefix" }));
    expect(isShieldedAddress(text)).toBe(false);
    expect(isPaymentCode(plain)).toBe(false);
    // The same payload under the other prefix is refused for its length, not accepted with a truncated or missing secret.
    const payload = bech32m.fromWords(bech32m.decode(text as `${string}1${string}`, 200).words);
    expect(() => decodeShieldedAddress(bech32m.encode("loch", bech32m.toWords(payload), 200))).toThrow(expect.objectContaining({ reason: "length" }));
    expect(() => decodePaymentCode(bech32m.encode("lochpay", bech32m.toWords(payload.subarray(0, 64)), 200))).toThrow(expect.objectContaining({ reason: "length" }));
  });

  it("decodeRecipient tells the two apart by prefix, and a payment code by its secret", () => {
    const plain = encodeShieldedAddress(bob);
    expect(decodeRecipient(plain)).toEqual({ publicKey: bob.publicKey, encryptionPublic: bob.encryptionPublic });
    expect("secret" in decodeRecipient(plain)).toBe(false);
    expect(decodeRecipient(text)).toEqual(code);
    expect(decodeRecipient(text.toUpperCase())).toEqual(code);
    expect(() => decodeRecipient("solana1qqqq")).toThrow(AddressError);
    expect(() => decodeRecipient(42 as unknown as string)).toThrow(AddressError);
  });

  it("rejects typos, mixed case and keys that would not make an address", () => {
    const flipped = text.slice(0, 20) + (text[20] === "q" ? "p" : "q") + text.slice(21);
    expect(() => decodePaymentCode(flipped)).toThrow(expect.objectContaining({ reason: "checksum" }));
    expect(() => decodePaymentCode(text.slice(0, 30) + text.slice(30).toUpperCase())).toThrow(expect.objectContaining({ reason: "encoding" }));
    const lowOrder = bech32m.encode("lochpay", bech32m.toWords(concatBytes(bigIntToBytesBE(alice.publicKey, 32), new Uint8Array(32), code.secret)), 200);
    expect(() => decodePaymentCode(lowOrder)).toThrow(expect.objectContaining({ reason: "encryption_key" }));
    expect(() => encodePaymentCode({ ...code, secret: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => encodePaymentCode({ ...code, encryptionPublic: new Uint8Array(32) })).toThrow(/X25519/);
  });

  it("never puts the secret into an error message", () => {
    const hex = Buffer.from(code.secret).toString("hex");
    for (const bad of [text.slice(0, -1), `${text}q`, text.replace("lochpay", "lochpaz")]) {
      try {
        decodePaymentCode(bad);
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).not.toContain(hex);
        expect((error as Error).message).not.toContain(text.slice(8, 40));
      }
    }
  });
});

describe("keyed note encryption", () => {
  const note = createNote(1_234_567_890n, alice.publicKey);
  const commitment = noteCommitment(note);
  const code = paymentCodeAt(alice, 0);

  it("has the layout of every other note: 87 bytes that start with a fresh, valid X25519 public key", () => {
    const first = encryptNote(note, alice.encryptionPublic, alice.selfNoteKey);
    const second = encryptNote(note, alice.encryptionPublic, alice.selfNoteKey);
    for (const encrypted of [first, second, encryptNote(note, alice.encryptionPublic, code.secret), encryptNote(note, alice.encryptionPublic)]) {
      expect(encrypted).toHaveLength(ENCRYPTED_NOTE_LENGTH);
      expect(isValidEncryptionPublicKey(encrypted.subarray(0, 32))).toBe(true);
    }
    expect(first.subarray(0, 32)).not.toEqual(second.subarray(0, 32));
    expect(first.subarray(32)).not.toEqual(second.subarray(32));
  });

  it("uses the documented construction, so another implementation can decrypt", () => {
    for (const psk of [alice.selfNoteKey, code.secret]) {
      const encrypted = encryptNote(note, alice.encryptionPublic, psk);
      const ephemeralPublic = encrypted.subarray(0, 32);
      const key = hkdf(
        sha256,
        concatBytes(x25519.getSharedSecret(alice.encryptionSecret, ephemeralPublic), psk),
        concatBytes(ephemeralPublic, alice.encryptionPublic),
        utf8("loch-note-psk-v1"),
        32,
      );
      const plaintext = chacha20poly1305(key, new Uint8Array(12)).decrypt(encrypted.subarray(32));
      expect(plaintext).toEqual(concatBytes(bigIntToBytesLE(note.amount, 8), bigIntToBytesBE(note.blinding, 31)));
    }
  });

  it("opens for its owner and says how it was addressed", () => {
    expect(openNote(encryptNote(note, alice.encryptionPublic, alice.selfNoteKey), alice, commitment)).toEqual({ note, source: "self" });
    expect(openNote(encryptNote(note, alice.encryptionPublic), alice, commitment)).toEqual({ note, source: "address" });
    const paid = encryptNote(note, alice.encryptionPublic, paymentCodeSecret(alice.paymentCodeRoot, 4));
    expect(openNote(paid, alice, commitment, candidates(alice, 5))).toEqual({ note, source: { code: 4 } });
    // tryDecryptNote is the same without codes and without the source.
    expect(tryDecryptNote(encryptNote(note, alice.encryptionPublic, alice.selfNoteKey), alice, commitment)).toEqual(note);
    expect(tryDecryptNote(paid, alice, commitment)).toBeNull();
  });

  it("does not open for somebody who has broken the X25519 key but holds no pre-shared key", () => {
    const breaker = breakerOf(alice);
    const self = encryptNote(note, alice.encryptionPublic, alice.selfNoteKey);
    const paid = encryptNote(note, alice.encryptionPublic, code.secret);
    // The address note is exactly what such a person reads. The keyed notes are not.
    expect(openNote(encryptNote(note, alice.encryptionPublic), breaker, commitment)).toEqual({ note, source: "address" });
    expect(openNote(self, breaker, commitment)).toBeNull();
    expect(openNote(paid, breaker, commitment)).toBeNull();
    // Nor with the wrong pre-shared key: another wallet's, another code's, or the two swapped.
    expect(openNote(self, { ...breaker, selfNoteKey: bob.selfNoteKey }, commitment, candidates(bob, 8))).toBeNull();
    expect(openNote(self, breaker, commitment, candidates(alice, 8))).toBeNull();
    expect(openNote(paid, { ...breaker, selfNoteKey: alice.selfNoteKey }, commitment, candidates(alice, 8).slice(1))).toBeNull();
    // The exchange alone, under either label, is not the key.
    const ephemeralPublic = self.subarray(0, 32);
    const shared = x25519.getSharedSecret(alice.encryptionSecret, ephemeralPublic);
    for (const info of ["loch-note-v1", "loch-note-psk-v1"]) {
      const key = hkdf(sha256, shared, concatBytes(ephemeralPublic, alice.encryptionPublic), utf8(info), 32);
      expect(() => chacha20poly1305(key, new Uint8Array(12)).decrypt(self.subarray(32))).toThrow();
    }
  });

  it("does not open for somebody who holds the payment code but not the X25519 key", () => {
    // The payer's position, or that of someone the code leaked to: the secret, and no way to redo the exchange.
    const paid = encryptNote(note, alice.encryptionPublic, code.secret);
    const leaked = { publicKey: alice.publicKey, encryptionSecret: bob.encryptionSecret, encryptionPublic: alice.encryptionPublic };
    expect(openNote(paid, leaked, commitment, [{ index: 0, secret: code.secret }])).toBeNull();
    expect(openNote(paid, bob, commitment, [{ index: 0, secret: code.secret }])).toBeNull();
  });

  it("still checks the commitment: a keyed note for another owner or another amount is refused", () => {
    const encrypted = encryptNote(note, alice.encryptionPublic, alice.selfNoteKey);
    expect(openNote(encrypted, alice, commitment + 1n)).toBeNull();
    expect(openNote(encrypted, alice, noteCommitment({ ...note, publicKey: bob.publicKey }))).toBeNull();
    const bobs = createNote(5n, bob.publicKey);
    expect(openNote(encryptNote(bobs, alice.encryptionPublic, code.secret), alice, noteCommitment(bobs), candidates(alice, 1))).toBeNull();
  });

  it("returns null for tampering and for malformed candidates, without throwing", () => {
    const encrypted = encryptNote(note, alice.encryptionPublic, alice.selfNoteKey);
    for (const position of [0, 31, 32, 60, 86]) {
      const tampered = Uint8Array.from(encrypted);
      tampered[position]! ^= 0x01;
      expect(openNote(tampered, alice, commitment, candidates(alice, 3))).toBeNull();
    }
    expect(openNote(randomBytes(87), alice, commitment, candidates(alice, 3))).toBeNull();
    expect(openNote(encrypted, alice, commitment, [{ index: 0, secret: "no" as unknown as Uint8Array }])).toEqual({ note, source: "self" });
    const paid = encryptNote(note, alice.encryptionPublic, code.secret);
    expect(openNote(paid, alice, commitment, [{ index: 0, secret: undefined as unknown as Uint8Array }])).toBeNull();
  });

  it("refuses a pre-shared key that is not 32 bytes", () => {
    for (const psk of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0), "secret" as unknown as Uint8Array]) {
      expect(() => encryptNote(note, alice.encryptionPublic, psk)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    }
  });
});

function event(index: number, amount: bigint, to: LochKeys, psk?: Uint8Array): NewCommitmentEvent {
  const note = createNote(amount, to.publicKey);
  return { index, commitment: noteCommitment(note), encryptedOutput: encryptNote(note, to.encryptionPublic, psk) };
}

describe("wallet state: payment codes", () => {
  const paidTo = (index: number, leaf: number, amount = 10n) => event(leaf, amount, alice, paymentCodeSecret(alice.paymentCodeRoot, index));

  it("finds notes of all three kinds and says which is which", () => {
    const events = [event(0, 700n, alice), event(1, 5n, alice, alice.selfNoteKey), paidTo(2, 2, 40n), event(3, 9n, bob, bob.selfNoteKey)];
    const { state, received } = applyEvents(createWalletState(alice), events, alice);
    expect(received.map((note) => [note.leafIndex, note.amount, note.source])).toEqual([
      [0, 700n, "address"],
      [1, 5n, "self"],
      [2, 40n, { code: 2 }],
    ]);
    expect(balance(state)).toBe(745n);
    expect(balance(applyEvents(createWalletState(bob), events, bob).state)).toBe(9n);
  });

  it("keeps the layout of a state that never met a payment code, and counts once it does", () => {
    const plain = applyEvents(createWalletState(alice), [event(0, 1n, alice), event(1, 2n, alice, alice.selfNoteKey)], alice).state;
    expect(Object.keys(plain)).toEqual(["version", "programId", "publicKey", "leaves", "notes", "lastSignature"]);
    expect(paymentCodeCounts(plain)).toEqual({ issued: 0, used: 0 });
    const paid = applyEvents(plain, [paidTo(6, 2), paidTo(1, 3)], alice).state;
    expect(paid.paymentCodes).toEqual({ issued: 7, used: 7 });
    expect(parseWalletState(JSON.parse(JSON.stringify(paid)))).toEqual(paid);
    // Stored notes say nothing about how they arrived.
    for (const note of paid.notes) expect(Object.keys(note)).toEqual(["leafIndex", "amount", "blinding", "commitment", "nullifier", "spent"]);
  });

  it("hands out codes in order, counts them, and leaves the input state alone", () => {
    const empty = createWalletState(alice);
    const first = issuePaymentCode(empty, alice);
    const second = issuePaymentCode(first.state, alice);
    expect([first.index, second.index]).toEqual([0, 1]);
    expect(first.code).toEqual(paymentCodeAt(alice, 0));
    expect(second.code.secret).toEqual(paymentCodeSecret(alice.paymentCodeRoot, 1));
    expect(second.state.paymentCodes).toEqual({ issued: 2, used: 0 });
    expect(empty.paymentCodes).toBeUndefined();
    expect(() => issuePaymentCode(empty, bob)).toThrow(/different key set/);
  });

  it("stops after 20 codes in a row that nobody paid, and goes on once one is paid", () => {
    expect(PAYMENT_CODE_GAP).toBe(20);
    let state = createWalletState(alice);
    for (let i = 0; i < PAYMENT_CODE_GAP; i++) state = issuePaymentCode(state, alice).state;
    expect(state.paymentCodes).toEqual({ issued: 20, used: 0 });
    expect(() => issuePaymentCode(state, alice)).toThrow(expect.objectContaining({ code: "PAYMENT_CODE_LIMIT" }));
    // Code 4 is paid: five codes are now behind the last used one, so five more may go out.
    state = applyEvents(state, [paidTo(4, 0), event(1, 0n, bob)], alice).state;
    expect(state.paymentCodes).toEqual({ issued: 20, used: 5 });
    for (let i = 0; i < 5; i++) state = issuePaymentCode(state, alice).state;
    expect(state.paymentCodes).toEqual({ issued: 25, used: 5 });
    expect(() => issuePaymentCode(state, alice)).toThrow(expect.objectContaining({ code: "PAYMENT_CODE_LIMIT" }));
  });

  it("looks 20 codes past the last one in use, and no further", () => {
    const fresh = createWalletState(alice);
    expect(applyEvents(fresh, [paidTo(19, 0), event(1, 0n, bob)], alice).received).toHaveLength(1);
    expect(applyEvents(fresh, [paidTo(20, 0), event(1, 0n, bob)], alice).received).toHaveLength(0);
    // A state that handed out more looks further, and a note on a code moves the range within one batch.
    expect(applyEvents({ ...fresh, paymentCodes: { issued: 5, used: 0 } }, [paidTo(24, 0), event(1, 0n, bob)], alice).received).toHaveLength(1);
    const chained = applyEvents(fresh, [paidTo(19, 0), paidTo(39, 1), paidTo(59, 2), event(3, 0n, bob)], alice);
    expect(chained.received.map((note) => note.source)).toEqual([{ code: 19 }, { code: 39 }, { code: 59 }]);
    expect(chained.state.paymentCodes).toEqual({ issued: 60, used: 60 });
  });

  it("counts a zero-amount note on a code as use of the code, without recording the note", () => {
    const { state, received } = applyEvents(createWalletState(alice), [paidTo(12, 0, 0n), paidTo(30, 1, 3n)], alice);
    expect(received.map((note) => note.source)).toEqual([{ code: 30 }]);
    expect(state.notes).toHaveLength(1);
    expect(state.paymentCodes).toEqual({ issued: 31, used: 31 });
  });

  it("a wallet restored from nothing finds every note its codes were paid, whatever was handed out and paid in between", () => {
    // The device that hands out codes: as many as it is allowed, each time; some get paid, in any order.
    let device = createWalletState(alice);
    const chain: NewCommitmentEvent[] = [];
    const outstanding: number[] = [];
    let expected = 0n;
    const push = (make: (leaf: number) => NewCommitmentEvent) => {
      const pair = [make(chain.length), event(chain.length + 1, 0n, bob)];
      chain.push(...pair);
      device = applyEvents(device, pair, alice).state;
    };
    for (let round = 0; round < 12; round++) {
      for (;;) {
        try {
          const issued = issuePaymentCode(device, alice);
          device = issued.state;
          outstanding.push(issued.index);
        } catch {
          break;
        }
      }
      // Pay the newest code handed out, the hardest one for a restored wallet to reach, and an old one again.
      const newest = outstanding[outstanding.length - 1]!;
      push((leaf) => paidTo(newest, leaf, 100n));
      push((leaf) => paidTo(outstanding[round]!, leaf, 1n));
      expected += 101n;
    }
    expect(outstanding.length).toBeGreaterThan(200);
    expect(balance(device)).toBe(expected);

    // Restored: no counts, the same chain, fed in batches of any size.
    for (const batch of [chain.length, 2, 8]) {
      let restored = createWalletState(alice);
      for (let start = 0; start < chain.length; start += batch) restored = applyEvents(restored, chain.slice(start, start + batch), alice).state;
      expect(balance(restored)).toBe(expected);
      expect(restored.notes).toEqual(device.notes);
      expect(restored.paymentCodes!.used).toBe(device.paymentCodes!.used);
    }
  });

  it("parseWalletState accepts a state without counts and refuses malformed ones", () => {
    const base = createWalletState(alice);
    expect(parseWalletState(JSON.parse(JSON.stringify(base)))).toEqual(base);
    expect(parseWalletState({ ...base, paymentCodes: { issued: 3, used: 1 } }).paymentCodes).toEqual({ issued: 3, used: 1 });
    for (const paymentCodes of [null, 3, {}, { issued: 1 }, { issued: -1, used: 0 }, { issued: 1.5, used: 0 }, { issued: "1", used: 0 }, { issued: 2 ** 32, used: 0 }]) {
      expect(() => parseWalletState({ ...base, paymentCodes })).toThrow(/payment code counts/);
    }
  });
});

describe("transactions: who can read which output", () => {
  const aliceWallet = wallet("alice");
  const screener = wallet("screener");
  const relayer = wallet("relayer");
  const FEE = 5_000n;
  const newPool = () => new FakePool({ screener: screener.publicKey, maxDeposit: 10n * SOL });
  const submit = (pool: FakePool, prepared: PreparedTransact, payer = relayer) =>
    pool.process(buildTransactTransaction({ instruction: prepared.instruction, payer: payer.publicKey, recentBlockhash: "11111111111111111111111111111111" }));

  async function funded() {
    const pool = newPool();
    const prepared = await prepareDeposit({
      prover: checkingProver(),
      keys: alice,
      root: pool.tree.root,
      amount: SOL,
      depositor: aliceWallet.publicKey,
      config: await fetchPoolConfig(pool.connection),
    });
    await submit(pool, prepared, aliceWallet);
    const synced = await syncWallet(pool.connection, createWalletState(alice), alice);
    const context = { prover: checkingProver(), keys: alice, state: synced.state, tree: synced.tree, relayer: relayer.publicKey, fee: FEE, maxFee: FEE };
    return { pool, prepared, synced, context };
  }

  it("a deposit: both notes are the depositor's own, and breaking her X25519 key reads neither", async () => {
    const { prepared, synced } = await funded();
    for (const output of prepared.outputs) {
      expect(openNote(output.encryptedOutput, alice, output.commitment)).toEqual({ note: output.note, source: "self" });
      expect(openNote(output.encryptedOutput, breakerOf(alice), output.commitment)).toBeNull();
      expect(output.encryptedOutput).toHaveLength(ENCRYPTED_NOTE_LENGTH);
    }
    expect(synced.received.map((note) => [note.amount, note.source])).toEqual([[SOL, "self"]]);
  });

  it("a transfer to an address: the change is keyed, the recipient's note is an address note", async () => {
    const { pool, context } = await funded();
    const prepared = await prepareTransfer({ ...context, to: encodeShieldedAddress(bob), amount: 300_000_000n });
    const toBob = prepared.outputs.find((output) => output.note.publicKey === bob.publicKey)!;
    const change = prepared.outputs.find((output) => output.note.publicKey === alice.publicKey)!;
    expect(openNote(change.encryptedOutput, alice, change.commitment)).toEqual({ note: change.note, source: "self" });
    expect(openNote(change.encryptedOutput, breakerOf(alice), change.commitment)).toBeNull();
    expect(openNote(toBob.encryptedOutput, bob, toBob.commitment)).toEqual({ note: toBob.note, source: "address" });
    // This is the note that stays readable to whoever breaks Bob's X25519 key.
    expect(openNote(toBob.encryptedOutput, breakerOf(bob), toBob.commitment)).toEqual({ note: toBob.note, source: "address" });
    await submit(pool, prepared);
    expect(balance((await syncWallet(pool.connection, createWalletState(bob), bob)).state)).toBe(300_000_000n);
  });

  it("a transfer to a payment code: the recipient finds it, and breaking his X25519 key does not read it", async () => {
    const { pool, context } = await funded();
    const issued = issuePaymentCode(createWalletState(bob), bob);
    const prepared = await prepareTransfer({ ...context, to: encodePaymentCode(issued.code), amount: 300_000_000n });
    const toBob = prepared.outputs.find((output) => output.note.publicKey === bob.publicKey)!;
    expect(openNote(toBob.encryptedOutput, breakerOf(bob), toBob.commitment)).toBeNull();
    expect(openNote(toBob.encryptedOutput, bob, toBob.commitment)).toBeNull();
    expect(openNote(toBob.encryptedOutput, bob, toBob.commitment, [{ index: 0, secret: issued.code.secret }])).toEqual({ note: toBob.note, source: { code: 0 } });
    // Alice, who holds the code, cannot read it back either: she has no part of Bob's X25519 key.
    expect(openNote(toBob.encryptedOutput, alice, toBob.commitment, [{ index: 0, secret: issued.code.secret }])).toBeNull();

    await submit(pool, prepared);
    const bobSynced = await syncWallet(pool.connection, issued.state, bob);
    expect(bobSynced.received.map((note) => [note.amount, note.source])).toEqual([[300_000_000n, { code: 0 }]]);
    expect(bobSynced.state.paymentCodes).toEqual({ issued: 1, used: 1 });
    // A Bob restored from nothing but his keys finds it as well.
    expect(balance((await syncWallet(pool.connection, createWalletState(bob), bob)).state)).toBe(300_000_000n);
    // And the same code can be paid again: a fresh ephemeral key, a fresh note key.
    const aliceAgain = await syncWallet(pool.connection, context.state, alice, { tree: context.tree });
    const second = await prepareTransfer({ ...context, state: aliceAgain.state, tree: aliceAgain.tree, to: issued.code, amount: 1_000n });
    await submit(pool, second);
    expect(balance((await syncWallet(pool.connection, createWalletState(bob), bob)).state)).toBe(300_001_000n);
  });

  it("a withdrawal and its change: the change is keyed", async () => {
    const { pool, context } = await funded();
    const prepared = await prepareWithdrawal({ ...context, recipient: address("somewhere public"), amount: 400_000_000n });
    for (const output of prepared.outputs) {
      expect(openNote(output.encryptedOutput, alice, output.commitment)?.source).toBe("self");
      expect(openNote(output.encryptedOutput, breakerOf(alice), output.commitment)).toBeNull();
    }
    await submit(pool, prepared);
    expect(balance((await syncWallet(pool.connection, createWalletState(alice), alice)).state)).toBe(SOL - 400_000_000n - FEE);
  });

  it("an address that pairs the sender's public key with somebody else's encryption key cannot hide her own money from her", async () => {
    const { pool, context } = await funded();
    const crafted = encodeShieldedAddress({ publicKey: alice.publicKey, encryptionPublic: bob.encryptionPublic });
    const prepared = await prepareTransfer({ ...context, to: crafted, amount: 300_000_000n });
    for (const output of prepared.outputs) {
      expect(openNote(output.encryptedOutput, alice, output.commitment)?.source).toBe("self");
      expect(tryDecryptNote(output.encryptedOutput, bob, output.commitment)).toBeNull();
    }
    await submit(pool, prepared);
    expect(balance((await syncWallet(pool.connection, createWalletState(alice), alice)).state)).toBe(SOL - FEE);
  });

  it("prepareTransact without the sender's keys still works, with address notes; a payment code with a bad secret is refused", async () => {
    const pool = newPool();
    const base = {
      prover: checkingProver(),
      root: pool.tree.root,
      inputs: [],
      padding: alice,
      extAmount: SOL,
      fee: 0n,
      recipient: aliceWallet.publicKey,
      relayer: aliceWallet.publicKey,
      signer: aliceWallet.publicKey,
      screener: screener.publicKey,
    };
    const plain = await prepareTransact({ ...base, outputs: [{ amount: SOL, to: { publicKey: alice.publicKey, encryptionPublic: alice.encryptionPublic } }] });
    for (const output of plain.outputs) expect(openNote(output.encryptedOutput, alice, output.commitment)?.source).toBe("address");
    const code: PaymentCode = paymentCodeAt(bob, 0);
    for (const secret of [new Uint8Array(31), undefined as unknown as Uint8Array]) {
      await expect(prepareTransact({ ...base, own: alice, outputs: [{ amount: SOL, to: { ...code, secret } }] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });
});
