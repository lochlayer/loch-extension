import { describe, expect, it } from "vitest";

import {
  ConsolidationRequiredError,
  FIELD_MODULUS,
  InsufficientBalanceError,
  type NewCommitmentEvent,
  type OwnedNote,
  PROGRAM_ID,
  SyncError,
  applyEvents,
  balance,
  createNote,
  createWalletState,
  encryptNote,
  noteCommitment,
  noteNullifier,
  ownedNotes,
  parseWalletState,
  selectNotes,
  treeFromState,
  unspentNotes,
} from "../src/index.js";
import { MerkleTree } from "../src/merkle.js";
import { consolidationCandidates } from "../src/wallet.js";
import { lochKeys } from "./helpers/fixtures.js";

const alice = lochKeys("alice");
const bob = lochKeys("bob");

function owned(amount: bigint, leafIndex: number, spent = false): OwnedNote {
  const note = createNote(amount, alice.publicKey, BigInt(leafIndex + 1));
  return { ...note, leafIndex, commitment: noteCommitment(note), nullifier: noteNullifier(note, leafIndex, alice.privateKey), spent };
}

const amounts = (notes: OwnedNote[]) => notes.map((note) => note.amount);

describe("coin selection", () => {
  const notes = [owned(50n, 0), owned(10n, 1), owned(30n, 2), owned(20n, 3)];

  it("picks the smallest single note that covers the target", () => {
    expect(amounts(selectNotes(notes, 10n))).toEqual([10n]);
    expect(amounts(selectNotes(notes, 11n))).toEqual([20n]);
    expect(amounts(selectNotes(notes, 30n))).toEqual([30n]);
    expect(amounts(selectNotes(notes, 31n))).toEqual([50n]);
    expect(amounts(selectNotes(notes, 50n))).toEqual([50n]);
  });

  it("otherwise picks the pair with the smallest sufficient sum", () => {
    expect(amounts(selectNotes(notes, 51n)).sort()).toEqual([10n, 50n]);
    expect(amounts(selectNotes(notes, 61n)).sort()).toEqual([20n, 50n]);
    expect(amounts(selectNotes(notes, 80n)).sort()).toEqual([30n, 50n]);
    // 30 + 20 would be the tightest pair for 45, but a single note (50) covers it.
    expect(amounts(selectNotes(notes, 45n))).toEqual([50n]);
    const flat = [owned(40n, 0), owned(35n, 1), owned(30n, 2), owned(8n, 3)];
    expect(amounts(selectNotes(flat, 41n)).sort()).toEqual([35n, 8n].sort());
    expect(amounts(selectNotes(flat, 66n)).sort()).toEqual([30n, 40n]);
    expect(amounts(selectNotes(flat, 75n)).sort()).toEqual([35n, 40n]);
  });

  it("returns pairs ordered by leaf index and breaks ties by age", () => {
    const equal = [owned(10n, 5), owned(10n, 2), owned(10n, 9)];
    expect(selectNotes(equal, 10n).map((note) => note.leafIndex)).toEqual([2]);
    expect(selectNotes(equal, 15n).map((note) => note.leafIndex)).toEqual([2, 9]);
  });

  it("ignores spent and zero-amount notes", () => {
    const mixed = [owned(100n, 0, true), owned(0n, 1), owned(7n, 2)];
    expect(amounts(selectNotes(mixed, 7n))).toEqual([7n]);
    expect(() => selectNotes(mixed, 8n)).toThrow(InsufficientBalanceError);
  });

  it("needs nothing for a target of zero", () => {
    expect(selectNotes(notes, 0n)).toEqual([]);
    expect(selectNotes([], 0n)).toEqual([]);
  });

  it("throws InsufficientBalanceError when the balance is too small", () => {
    try {
      selectNotes(notes, 111n);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientBalanceError);
      expect(error).toMatchObject({ code: "INSUFFICIENT_BALANCE", required: 111n, available: 110n });
    }
    expect(() => selectNotes([], 1n)).toThrow(InsufficientBalanceError);
  });

  it("throws ConsolidationRequiredError when the balance suffices but no two notes do", () => {
    try {
      selectNotes(notes, 81n);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConsolidationRequiredError);
      expect(error).toMatchObject({ code: "CONSOLIDATION_REQUIRED", required: 81n, available: 110n, largestPair: 80n });
      expect((error as Error).message).toMatch(/consolidation transfer to self/);
    }
    expect(() => selectNotes(notes, 110n)).toThrow(ConsolidationRequiredError);
    expect(() => selectNotes([owned(5n, 0), owned(5n, 1), owned(5n, 2)], 12n)).toThrow(ConsolidationRequiredError);
  });

  it("offers the two largest notes for consolidation", () => {
    expect(amounts(consolidationCandidates(notes))).toEqual([50n, 30n]);
    expect(consolidationCandidates([owned(5n, 0)])).toEqual([]);
    expect(consolidationCandidates([owned(5n, 0), owned(9n, 1, true)])).toEqual([]);
  });

  it("rejects a target that is not an amount", () => {
    expect(() => selectNotes(notes, -1n)).toThrow(/required/);
    expect(() => selectNotes(notes, 5 as unknown as bigint)).toThrow(/required/);
  });
});

function event(index: number, amount: bigint, to = alice): NewCommitmentEvent {
  const note = createNote(amount, to.publicKey);
  return { index, commitment: noteCommitment(note), encryptedOutput: encryptNote(note, to.encryptionPublic) };
}

describe("wallet state", () => {
  it("starts empty and is plain JSON with a version", () => {
    const state = createWalletState(alice);
    expect(state).toEqual({
      version: 1,
      programId: PROGRAM_ID.toBase58(),
      publicKey: alice.publicKey.toString(),
      leaves: [],
      notes: [],
      lastSignature: null,
    });
    expect(balance(state)).toBe(0n);
    expect(unspentNotes(state)).toEqual([]);
  });

  it("discovers its own notes by trial decryption and ignores everyone else's", () => {
    const events = [event(0, 700n), event(1, 0n), event(2, 5n, bob), event(3, 300n)];
    const { state, received, appended } = applyEvents(createWalletState(alice), events, alice);
    expect(state.leaves).toEqual(events.map((e) => e.commitment.toString()));
    expect(appended).toEqual(events.map((e) => e.commitment));
    expect(received.map((note) => [note.leafIndex, note.amount])).toEqual([[0, 700n], [3, 300n]]);
    expect(balance(state)).toBe(1000n);
    // The zero-amount padding note is hers too, but worthless: it is not recorded.
    expect(state.notes).toHaveLength(2);
    const [first] = unspentNotes(state);
    expect(first).toMatchObject({ amount: 700n, publicKey: alice.publicKey, leafIndex: 0, spent: false });
    expect(first!.commitment).toBe(events[0]!.commitment);
    expect(first!.nullifier).toBe(noteNullifier(first!, 0, alice.privateKey));
    expect(balance(applyEvents(createWalletState(bob), events, bob).state)).toBe(5n);
  });

  it("passes the slot and block time of an event on to the note it delivered, and stores neither", () => {
    const timed = { slot: 314_159, blockTime: 1_750_000_123 };
    const events = [{ ...event(0, 700n), ...timed }, { ...event(1, 0n), ...timed }, { ...event(2, 5n, bob), slot: 314_160 }, event(3, 300n)];
    const { state, received } = applyEvents(createWalletState(alice), events, alice);
    expect(received.map((note) => [note.leafIndex, note.amount, note.slot, note.blockTime])).toEqual([
      [0, 700n, 314_159, 1_750_000_123],
      [3, 300n, undefined, undefined],
    ]);
    // An event without them yields the owned note plus how it was addressed; one with them, the same plus the two.
    expect(received[1]).toEqual({ ...ownedNotes(state)[1], source: "address" });
    expect(Object.keys(received[1]!)).toEqual([...Object.keys(ownedNotes(state)[1]!), "source"]);
    expect(received[0]).toEqual({ ...ownedNotes(state)[0], ...timed, source: "address" });
    // The state is what the same events without any time produce: the layout is unchanged.
    const plain = applyEvents(createWalletState(alice), [event(0, 0n), event(1, 0n), event(2, 0n), event(3, 0n)], alice).state;
    expect(Object.keys(state)).toEqual(Object.keys(plain));
    expect(state.notes.map((note) => Object.keys(note))).toEqual([
      ["leafIndex", "amount", "blinding", "commitment", "nullifier", "spent"],
      ["leafIndex", "amount", "blinding", "commitment", "nullifier", "spent"],
    ]);
    expect(JSON.stringify(state)).not.toMatch(/slot|blockTime|314159|1750000123/);
    expect(parseWalletState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    // Values that are not a slot or a time are dropped, not passed on.
    const odd = applyEvents(createWalletState(alice), [{ ...event(0, 1n), slot: -1, blockTime: 0 }, { ...event(1, 2n), slot: "7" as never, blockTime: 1.5 }], alice);
    expect(odd.received.map((note) => ["slot" in note, "blockTime" in note])).toEqual([[false, false], [false, false]]);
    // A note found spent carries no time: it would be the time it was created, which is not what "spent" asks.
    const nullifier = ownedNotes(state)[0]!.nullifier;
    const spent = applyEvents(state, [{ ...event(4, 1n, bob), ...timed }, { ...event(5, 0n, bob), ...timed }], alice, [nullifier]).spent;
    expect(spent.map((note) => [note.leafIndex, "slot" in note, "blockTime" in note])).toEqual([[0, false, false]]);
  });

  it("survives JSON, with bigints as decimal strings", () => {
    const applied = applyEvents(createWalletState(alice), [event(0, 12_345_678_901_234_567_890n % (1n << 64n)), event(1, 1n)], alice);
    const text = JSON.stringify(applied.state);
    expect(text).not.toMatch(/"0x/);
    const restored = parseWalletState(JSON.parse(text));
    expect(restored).toEqual(applied.state);
    expect(ownedNotes(restored)).toEqual(ownedNotes(applied.state));
    for (const note of restored.notes) {
      for (const value of [note.amount, note.blinding, note.commitment, note.nullifier]) expect(value).toMatch(/^(0|[1-9][0-9]*)$/);
    }
    expect(treeFromState(restored).root).toBe(MerkleTree.fromLeaves(applied.appended).root);
  });

  it("does not modify the state it is given", () => {
    const before = createWalletState(alice);
    const snapshot = JSON.stringify(before);
    applyEvents(before, [event(0, 1n)], alice);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("requires contiguous leaf indices", () => {
    const state = createWalletState(alice);
    expect(() => applyEvents(state, [event(1, 1n)], alice)).toThrow(expect.objectContaining({ code: "SYNC_FAILED", reason: "gap" }));
    expect(() => applyEvents(state, [event(0, 1n), event(2, 1n)], alice)).toThrow(SyncError);
    // Order of arrival does not matter, only the indices.
    expect(applyEvents(state, [event(1, 2n), event(0, 1n)], alice).state.leaves).toHaveLength(2);
  });

  it("accepts a replay of known leaves and rejects a contradiction", () => {
    const first = event(0, 4n);
    const second = event(1, 6n);
    const { state } = applyEvents(createWalletState(alice), [first, second], alice);
    const replayed = applyEvents(state, [first, second, event(2, 1n)], alice);
    expect(replayed.state.leaves).toHaveLength(3);
    expect(replayed.received.map((note) => note.leafIndex)).toEqual([2]);
    expect(balance(replayed.state)).toBe(11n);
    expect(() => applyEvents(state, [event(1, 6n)], alice)).toThrow(expect.objectContaining({ reason: "mismatch" }));
  });

  it("refuses keys that do not own the state", () => {
    expect(() => applyEvents(createWalletState(alice), [event(0, 1n)], bob)).toThrow(expect.objectContaining({ reason: "state" }));
  });

  it("marks the wallet's notes as spent from the nullifiers a batch of transactions spent", () => {
    const first = applyEvents(createWalletState(alice), [event(0, 700n), event(1, 300n)], alice);
    const [big, small] = ownedNotes(first.state);
    expect(first.spent).toEqual([]);

    // Later transactions spend the 700 note (next to a dummy) and pay Alice 50; unrelated nullifiers change nothing.
    const later = applyEvents(first.state, [event(2, 50n), event(3, 0n, bob)], alice, [123n, big!.nullifier, 456n, 789n]);
    expect(later.spent.map((note) => [note.leafIndex, note.amount, note.spent])).toEqual([[0, 700n, true]]);
    expect(later.received.map((note) => [note.leafIndex, note.spent])).toEqual([[2, false]]);
    expect(balance(later.state)).toBe(350n);
    expect(ownedNotes(later.state).map((note) => note.spent)).toEqual([true, false, false]);
    // The input state is untouched, and a note that is already spent is not reported twice.
    expect(balance(first.state)).toBe(1000n);
    expect(applyEvents(later.state, [], alice, [big!.nullifier]).spent).toEqual([]);

    // A note created and spent in the same batch: its nullifier is only computable once the leaf is known.
    const batch = [event(0, 5n), event(1, 0n, bob)];
    const once = applyEvents(createWalletState(alice), batch, alice);
    const nullifier = ownedNotes(once.state)[0]!.nullifier;
    const both = applyEvents(createWalletState(alice), batch, alice, [nullifier, small!.nullifier]);
    expect(both.received.map((note) => note.spent)).toEqual([true]);
    expect(both.spent.map((note) => note.leafIndex)).toEqual([0]);
    expect(balance(both.state)).toBe(0n);
  });

  it("rejects stored state it cannot trust", () => {
    const good = applyEvents(createWalletState(alice), [event(0, 9n), event(1, 4n)], alice).state;
    const reject = (mutate: (state: any) => void, why?: RegExp) => {
      const copy = JSON.parse(JSON.stringify(good));
      mutate(copy);
      let thrown: unknown;
      try {
        parseWalletState(copy);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SyncError);
      expect(thrown).toMatchObject({ code: "SYNC_FAILED", reason: "state" });
      if (why) expect((thrown as Error).message).toMatch(why);
    };
    reject((s) => (s.version = 2));
    reject((s) => delete s.leaves);
    reject((s) => (s.leaves[0] = "0x10"));
    reject((s) => (s.notes[0].leafIndex = 5));
    reject((s) => (s.notes[0].commitment = "1"));
    reject((s) => (s.notes[0].spent = "no"));
    reject((s) => (s.notes = [null]));
    reject((s) => (s.lastSignature = 5));
    expect(() => parseWalletState(null)).toThrow(SyncError);
    expect(() => parseWalletState("{}")).toThrow(SyncError);
    expect(parseWalletState(JSON.parse(JSON.stringify(good)))).toEqual(good);

    // Values the rest of the SDK relies on, which used to pass here and fail later, somewhere else.
    const r = FIELD_MODULUS.toString();
    reject((s) => (s.programId = "not a key"), /programId/);
    reject((s) => (s.programId = "1111"), /programId/);
    reject((s) => (s.publicKey = r), /publicKey/);
    reject((s) => (s.leaves[1] = r), /leaves/);
    reject((s) => (s.leaves[0] = "9".repeat(400)), /leaves/);
    reject((s) => s.leaves.push("7"), /odd number of leaves/);
    reject((s) => (s.notes[0].nullifier = r), /malformed/);
    reject((s) => (s.notes[0].amount = (1n << 64n).toString()), /malformed/);
    reject((s) => (s.notes[0].blinding = (1n << 248n).toString()), /malformed/);
    reject((s) => (s.notes[0].leafIndex = 0.5), /leaf index/);
    // The right shape, the wrong content: an amount that is not the committed one.
    reject((s) => (s.notes[0].amount = "10"), /does not match its commitment/);
    // The same note twice doubles the balance; out of order hides one from coin selection's tie-break.
    reject((s) => s.notes.push(s.notes[0]), /increasing leaf order/);
    reject((s) => s.notes.reverse(), /increasing leaf order/);
    const doubled = JSON.parse(JSON.stringify(good));
    doubled.notes.push(doubled.notes[0]);
    expect(balance(doubled)).toBe(22n); // what balance() would say if such a state got through
    expect(balance(good)).toBe(13n);
  });
});
