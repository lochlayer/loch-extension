// Agreement with the reference implementation the circuit tests are built on
// (circuits/test/helpers), and with the two constants fixed by the program.

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { extDataHash as referenceExtDataHash, encodeExtData as referenceEncodeExtData } from "../../../circuits/test/helpers/extdata.mjs";
import { FIELD_SIZE, publicAmount as referencePublicAmount } from "../../../circuits/test/helpers/field.mjs";
import { MerkleTree as ReferenceTree, rootFromPath } from "../../../circuits/test/helpers/merkle.mjs";
import { commitmentOf, keypairFromPrivateKey, nullifierOf } from "../../../circuits/test/helpers/note.mjs";
import { randomBytes } from "../src/bytes.js";
import { BASE_FIELD_MODULUS } from "../src/constants.js";
import {
  FIELD_MODULUS,
  MerkleTree,
  TREE_DEPTH,
  createNote,
  encodeExtData,
  extDataHash,
  merkleRootFromPath,
  noteCommitment,
  noteNullifier,
  publicAmountField,
} from "../src/index.js";
import { publicKeyOf } from "../src/keys.js";
import { zeroValues } from "../src/merkle.js";
import { randomBlinding } from "../src/note.js";

const ZERO_1 = 14744269619966411208579211824598458697587494354926760081771325075741142829156n;
const EMPTY_ROOT = 15019797232609675441998260052101280400536945603062888308240081994073687793470n;

describe("field constants", () => {
  it("uses r for public inputs and q for proof coordinates", () => {
    expect(FIELD_MODULUS).toBe(FIELD_SIZE);
    expect(FIELD_MODULUS).toBe(21888242871839275222246405745257275088548364400416034343698204186575808495617n);
    expect(BASE_FIELD_MODULUS).toBe(21888242871839275222246405745257275088696311157297823662689037894645226208583n);
  });
});

describe("notes agree with the reference", () => {
  const privateKey = 0x1111111111111111111111111111111111111111111111111111111111n;
  const reference = keypairFromPrivateKey(privateKey);

  it("derives the same public key", () => {
    expect(publicKeyOf(privateKey)).toBe(reference.pubKey);
  });

  it("computes the same commitment", () => {
    for (const [amount, blinding] of [[0n, 1n], [2_000_000_000n, 102n], [(1n << 64n) - 1n, (1n << 248n) - 1n]] as const) {
      const note = createNote(amount, reference.pubKey, blinding);
      expect(noteCommitment(note)).toBe(commitmentOf({ amount, pubKey: reference.pubKey, blinding }));
    }
  });

  it("computes the same nullifier, which depends on the leaf index", () => {
    const note = createNote(5n, reference.pubKey, 77n);
    const referenceNote = { amount: 5n, pubKey: reference.pubKey, blinding: 77n };
    for (const index of [0, 1, 7, 2 ** TREE_DEPTH - 1]) {
      expect(noteNullifier(note, index, privateKey)).toBe(nullifierOf(referenceNote, index, privateKey));
    }
    expect(noteNullifier(note, 7, privateKey)).not.toBe(noteNullifier(note, 8, privateKey));
    expect(noteNullifier(note, 7n, privateKey)).toBe(noteNullifier(note, 7, privateKey));
  });

  it("draws blindings below 2^248", () => {
    for (let i = 0; i < 50; i++) expect(randomBlinding() >> 248n).toBe(0n);
  });

  it("rejects out-of-range note fields", () => {
    expect(() => createNote(-1n, 1n)).toThrow(/amount/);
    expect(() => createNote(1n << 64n, 1n)).toThrow(/amount/);
    expect(() => createNote(1n, FIELD_MODULUS)).toThrow(/publicKey/);
    expect(() => createNote(1n, 1n, 1n << 248n)).toThrow(/blinding/);
  });
});

describe("Merkle tree agrees with the reference and the program", () => {
  it("has the documented zero values and empty root", () => {
    const zeros = zeroValues();
    expect(zeros).toHaveLength(TREE_DEPTH + 1);
    expect(zeros[0]).toBe(0n);
    expect(zeros[1]).toBe(ZERO_1);
    expect(zeros[TREE_DEPTH]).toBe(EMPTY_ROOT);
    expect(new MerkleTree().root).toBe(EMPTY_ROOT);
    expect(new MerkleTree().root).toBe(new ReferenceTree().root);
  });

  it("matches the reference root after every insert", () => {
    const ours = new MerkleTree();
    const reference = new ReferenceTree();
    for (let i = 0; i < 37; i++) {
      const leaf = randomBlinding();
      expect(ours.insert(leaf)).toBe(reference.insert(leaf));
      expect(ours.root).toBe(reference.root);
    }
    expect(ours.size).toBe(37);
  });

  it("gives the same root whether leaves are appended one by one or in bulk", () => {
    const leaves = Array.from({ length: 23 }, () => randomBlinding());
    const reference = new ReferenceTree();
    for (const leaf of leaves) reference.insert(leaf);
    expect(MerkleTree.fromLeaves(leaves).root).toBe(reference.root);
    const mixed = new MerkleTree();
    expect(mixed.append(leaves.slice(0, 5))).toBe(0);
    expect(mixed.append(leaves.slice(5, 6))).toBe(5);
    expect(mixed.append([])).toBe(6);
    expect(mixed.append(leaves.slice(6))).toBe(6);
    expect(mixed.root).toBe(reference.root);
  });

  it("returns the reference's paths, and they recompute the root", () => {
    const leaves = Array.from({ length: 11 }, () => randomBlinding());
    const ours = MerkleTree.fromLeaves(leaves);
    const reference = new ReferenceTree();
    for (const leaf of leaves) reference.insert(leaf);
    leaves.forEach((leaf, index) => {
      const path = ours.path(index);
      expect(path.pathElements).toEqual(reference.path(index).pathElements);
      expect(path.pathIndices).toBe(BigInt(index));
      expect(path.pathElements).toHaveLength(TREE_DEPTH);
      expect(merkleRootFromPath(leaf, index, path.pathElements)).toBe(ours.root);
      expect(rootFromPath(leaf, index, path.pathElements)).toBe(ours.root);
    });
  });

  it("puts an even index on the left (bit 0 = left child)", () => {
    const tree = new MerkleTree(2);
    tree.append([10n, 11n, 12n]);
    const reference = new ReferenceTree(2);
    for (const leaf of [10n, 11n, 12n]) reference.insert(leaf);
    expect(tree.root).toBe(reference.root);
    expect(tree.path(0).pathElements[0]).toBe(11n);
    expect(tree.path(1).pathElements[0]).toBe(10n);
    expect(tree.path(2).pathElements[0]).toBe(0n);
  });

  it("round-trips through JSON and through a snapshot", () => {
    const tree = MerkleTree.fromLeaves(Array.from({ length: 9 }, () => randomBlinding()));
    const viaJson = MerkleTree.fromJSON(JSON.parse(JSON.stringify(tree)));
    expect(viaJson.root).toBe(tree.root);
    expect(viaJson.leaves).toEqual(tree.leaves);
    const viaSnapshot = MerkleTree.fromSnapshot(JSON.parse(JSON.stringify(tree.toSnapshot())));
    expect(viaSnapshot.root).toBe(tree.root);
    expect(viaSnapshot.path(4)).toEqual(tree.path(4));
    viaSnapshot.insert(5n);
    tree.insert(5n);
    expect(viaSnapshot.root).toBe(tree.root);
    const empty = MerkleTree.fromSnapshot(new MerkleTree().toSnapshot());
    expect(empty.root).toBe(EMPTY_ROOT);
    expect(() => MerkleTree.fromSnapshot({ depth: 20, layers: [["1"], []] })).toThrow(/layers/);
    expect(() => MerkleTree.fromJSON({ depth: 20, leaves: ["0x12"] })).toThrow(/decimal/);
  });

  it("truncates back to any earlier state", () => {
    const leaves = Array.from({ length: 14 }, () => randomBlinding());
    const tree = MerkleTree.fromLeaves(leaves);
    for (const size of [13, 8, 7, 1, 0]) {
      tree.truncate(size);
      expect(tree.size).toBe(size);
      expect(tree.root).toBe(MerkleTree.fromLeaves(leaves.slice(0, size)).root);
    }
    tree.append(leaves);
    expect(tree.root).toBe(MerkleTree.fromLeaves(leaves).root);
    expect(() => tree.truncate(15)).toThrow();
  });

  it("refuses leaves outside the field, missing indices and overflow", () => {
    const tree = new MerkleTree(2);
    expect(() => tree.insert(FIELD_MODULUS)).toThrow(/field element/);
    expect(tree.size).toBe(0);
    tree.append([1n, 2n, 3n, 4n]);
    expect(() => tree.insert(5n)).toThrow(/full/);
    expect(() => tree.path(4)).toThrow(/no leaf/);
    expect(tree.indexOf(3n)).toBe(2);
    expect(tree.indexOf(9n)).toBe(-1);
  });
});

describe("publicAmount agrees with the reference and field.rs", () => {
  it.each([
    ["deposit", 1_000n, 0n],
    ["deposit with a fee", 500_000_000n, 10_000n],
    ["zero", 0n, 0n],
    ["transfer fee", 0n, 5_000n],
    ["withdrawal with a fee", -1_500_000_000n, 5_000n],
    ["minus one", -1n, 0n],
    ["extremes", -(1n << 63n), (1n << 64n) - 1n],
  ])("%s", (_, extAmount, fee) => {
    expect(publicAmountField(extAmount, fee)).toBe(referencePublicAmount(extAmount, fee));
  });

  it("encodes negatives as r - |x|", () => {
    expect(publicAmountField(1_000n, 0n)).toBe(1_000n);
    expect(publicAmountField(0n, 0n)).toBe(0n);
    expect(publicAmountField(0n, 5_000n)).toBe(FIELD_MODULUS - 5_000n);
    expect(publicAmountField(-1_500_000_000n, 5_000n)).toBe(FIELD_MODULUS - 1_500_005_000n);
  });

  it("rejects values outside i64 / u64", () => {
    expect(() => publicAmountField(1n << 63n, 0n)).toThrow(/extAmount/);
    expect(() => publicAmountField(0n, 1n << 64n)).toThrow(/fee/);
    expect(() => publicAmountField(0n, -1n)).toThrow(/fee/);
  });
});

describe("extDataHash agrees with the reference", () => {
  it.each([
    ["transfer", 0n, 5_000n, 87, 87],
    ["withdrawal", -2n, 3n, 2, 0],
    ["deposit", 1_000_000_000n, 0n, 87, 87],
    ["largest outputs", -(1n << 63n), (1n << 64n) - 1n, 256, 256],
  ])("%s", (_, extAmount, fee, length0, length1) => {
    const recipient = randomBytes(32);
    const relayer = randomBytes(32);
    const encryptedOutput0 = randomBytes(length0);
    const encryptedOutput1 = randomBytes(length1);
    const ours = {
      recipient: new PublicKey(recipient),
      relayer: new PublicKey(relayer),
      extAmount,
      fee,
      encryptedOutput0,
      encryptedOutput1,
    };
    const theirs = { recipient, relayer, extAmount, fee, encryptedOutput0, encryptedOutput1 };
    expect(encodeExtData(ours)).toEqual(referenceEncodeExtData(theirs));
    expect(extDataHash(ours)).toBe(referenceExtDataHash(theirs));
    expect(extDataHash(ours) >> 248n).toBe(0n);
  });

  it("refuses an encrypted output the program would reject", () => {
    const base = { recipient: PublicKey.default, relayer: PublicKey.default, extAmount: 0n, fee: 0n };
    expect(() => extDataHash({ ...base, encryptedOutput0: new Uint8Array(257), encryptedOutput1: new Uint8Array(0) })).toThrow(/256/);
  });
});
