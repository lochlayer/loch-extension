// Loch v2 in the SDK (docs/v2.md): keys and diversified addresses, notes and
// their encryption, the encodings, the ext data and instruction codec, wallet
// state and a real proof against the v2 dev artifacts. The codec is compared
// with the independent reference of the circuit tests
// (circuits/test/helpers/v2.mjs), written from the same specification.

import { RistrettoPoint } from "@noble/curves/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { afterAll, describe, expect, it } from "vitest";

import { bytesToBigIntBE, concatBytes, utf8 } from "../src/bytes.js";
import { AddressError, FIELD_MODULUS, terminateProver, verifyProof } from "../src/index.js";
import { createNodeProverV2 } from "../src/node.js";
import {
  ENCRYPTED_NOTE_V2_LENGTH,
  MAINNET_ASSETS,
  NATIVE_MINT,
  RISTRETTO_ORDER,
  TREE_DEPTH_V2,
  addressAt,
  addressIndexOf,
  applyEventsV2,
  assetId,
  assetTable,
  balancesV2,
  createWalletStateV2,
  decodeAddressV2,
  decodeAnyRecipient,
  decodeFullViewingKey,
  decodeIncomingViewingKey,
  decodePaymentCodeV2,
  decodeTransactV2Event,
  decodeV2Data,
  deriveKeysV2,
  diversifierAt,
  encodeAddressV2,
  encodeExtDataV2,
  encodeFullViewingKey,
  encodeIncomingViewingKey,
  encodePaymentCodeV2,
  encodeSwapV2Data,
  encodeTransactV2Data,
  encryptNoteV2,
  extDataHashV2,
  fullViewingKeyOf,
  incomingViewingKeyOf,
  issuePaymentCodeV2,
  keysV2FromSeed,
  mainAddress,
  noteCommitmentV2,
  openNoteV2,
  ownerOf,
  parseWalletStateV2,
  paymentCodeAtV2,
  prepareTransactV2,
  selectNotesV2,
  EVENT_IX_TAG,
  TRANSACT_V2_EVENT_DISCRIMINATOR,
} from "../src/v2/index.js";
import { MerkleTree } from "../src/merkle.js";
import { deriveKeys } from "../src/keys.js";
import { encodeShieldedAddress } from "../src/address.js";
import { signDerivationMessage, wallet } from "./helpers/fixtures.js";

// The circuit tests' reference (plain JavaScript, no SDK code).
import * as reference from "../../../circuits/test/helpers/v2.mjs";

afterAll(terminateProver);

const alice = deriveKeysV2(signDerivationMessage(wallet("alice")));
const bob = deriveKeysV2(signDerivationMessage(wallet("bob")));
const USDC = MAINNET_ASSETS[1]!.mint;
const assets = assetTable(MAINNET_ASSETS);

describe("keys v2", () => {
  it("follows the specification from the v1 seed", () => {
    const signature = signDerivationMessage(wallet("alice"));
    const seed = sha256(signature);
    const wide = (label: string) => bytesToBigIntBE(sha512(concatBytes(utf8(label), seed)));
    const keys = keysV2FromSeed(seed);
    expect(keys.ask).toBe(wide("Loch spend key v2") % FIELD_MODULUS);
    expect(keys.nk).toBe(wide("Loch nullifier key v2") % FIELD_MODULUS);
    expect(keys.ivk).toBe(wide("Loch incoming viewing key v2") % RISTRETTO_ORDER);
    expect(keys.ak).toBe(poseidon1([keys.ask]));
    expect(keys.ownerRoot).toBe(poseidon2([keys.ak, keys.nk]));
    expect(keys.dk).toEqual(sha256(concatBytes(utf8("Loch diversifier key v2"), seed)));
    expect(keys).toEqual(deriveKeysV2(signature));
  });

  it("separates the keys: the spending key is none of the reading keys, and v1 keys are unrelated", () => {
    const v1 = deriveKeys(signDerivationMessage(wallet("alice")));
    expect(alice.ask).not.toBe(alice.nk);
    expect(alice.ask).not.toBe(v1.privateKey);
    expect(alice.ownerRoot).not.toBe(v1.publicKey);
  });

  it("refuses a signature that does not verify", () => {
    const w = wallet("alice");
    const signature = signDerivationMessage(w);
    expect(() => deriveKeysV2(signature, wallet("bob").publicKey.toBytes())).toThrow(/valid signature/);
    expect(deriveKeysV2(signature, w.publicKey.toBytes()).ownerRoot).toBe(alice.ownerRoot);
  });

  it("gives unlinkable diversified addresses that one ivk opens", () => {
    const a0 = addressAt(alice, 0);
    const a1 = addressAt(alice, 1);
    expect(a0.d).not.toEqual(a1.d);
    expect(a0.owner).not.toBe(a1.owner);
    expect(a0.pk).not.toEqual(a1.pk);
    expect(addressIndexOf(alice.dk, a1.d)).toBe(1);
    expect(addressIndexOf(bob.dk, a1.d)).toBeNull();
    // pk = ivk * G_d, G_d from the documented hash
    const base = RistrettoPoint.hashToCurve(sha512(concatBytes(utf8("Loch diversified base v2"), a1.d)));
    expect(a1.pk).toEqual(base.multiply(alice.ivk).toBytes());
    expect(a1.owner).toBe(ownerOf(alice.ownerRoot, a1.d));
    expect(diversifierAt(alice.dk, 7)).toHaveLength(16);
  });

  it("payment code i is address i + 1 with the documented secret", () => {
    const code = paymentCodeAtV2(alice, 4);
    const address = addressAt(alice, 5);
    expect(code.d).toEqual(address.d);
    expect(code.secret).toEqual(sha256(concatBytes(alice.paymentCodeRoot, Uint8Array.of(0, 0, 0, 4))));
  });
});

describe("encodings v2", () => {
  it("round-trips addresses and payment codes and tells versions apart", () => {
    const text = encodeAddressV2(mainAddress(alice));
    expect(text).toHaveLength(139);
    expect(text.startsWith("loch1")).toBe(true);
    expect(decodeAddressV2(text)).toEqual(mainAddress(alice));
    const code = paymentCodeAtV2(alice, 0);
    const codeText = encodePaymentCodeV2(code);
    expect(codeText).toHaveLength(194);
    expect(decodePaymentCodeV2(codeText)).toEqual(code);
    expect(decodeAnyRecipient(text).version).toBe(2);
    expect(decodeAnyRecipient(codeText).version).toBe(2);
    const v1 = encodeShieldedAddress(deriveKeys(signDerivationMessage(wallet("alice"))));
    expect(decodeAnyRecipient(v1).version).toBe(1);
  });

  it("refuses an address whose key is not a ristretto point", () => {
    const address = { ...mainAddress(alice), pk: new Uint8Array(32).fill(0xff) };
    expect(() => encodeAddressV2(address)).toThrow();
    expect(() => encodeAddressV2({ ...mainAddress(alice), pk: RistrettoPoint.ZERO.toBytes() })).toThrow();
  });

  it("round-trips the viewing keys", () => {
    const fvk = encodeFullViewingKey(fullViewingKeyOf(alice));
    expect(fvk).toHaveLength(322);
    expect(decodeFullViewingKey(fvk)).toEqual(fullViewingKeyOf(alice));
    const ivk = encodeIncomingViewingKey(incomingViewingKeyOf(alice));
    expect(ivk).toHaveLength(270);
    expect(decodeIncomingViewingKey(ivk)).toEqual(incomingViewingKeyOf(alice));
    expect(() => decodeIncomingViewingKey(fvk)).toThrow(AddressError);
  });
});

describe("notes v2", () => {
  const sol = assetId(NATIVE_MINT);

  it("uses the reference's commitment and asset id", () => {
    expect(assetId(NATIVE_MINT)).toBe(reference.assetId(NATIVE_MINT.toBytes()));
    const note = { asset: sol, amount: 5n, owner: 11n, blinding: 13n };
    expect(noteCommitmentV2(note)).toBe(reference.commitmentOf(note));
    expect(noteCommitmentV2(note)).toBe(poseidon3([sol, 5n, poseidon2([11n, 13n])]));
  });

  it("encrypts to an address, to oneself and to a payment code; only the owner opens", () => {
    const to = addressAt(bob, 3);
    const note = { asset: sol, amount: 123n, owner: to.owner, blinding: 99n };
    const commitment = noteCommitmentV2(note);
    const plain = encryptNoteV2(note, to);
    expect(plain).toHaveLength(ENCRYPTED_NOTE_V2_LENGTH);
    expect(openNoteV2(plain, bob, commitment, assets)).toMatchObject({ source: "address", note });
    expect(openNoteV2(plain, alice, commitment, assets)).toBeNull();

    const own = mainAddress(alice);
    const selfNote = { asset: assetId(USDC), amount: 7n, owner: own.owner, blinding: 5n };
    const keyed = encryptNoteV2(selfNote, own, alice.selfNoteKey);
    expect(openNoteV2(keyed, alice, noteCommitmentV2(selfNote), assets)?.source).toBe("self");

    const code = paymentCodeAtV2(bob, 2);
    const paid = { asset: sol, amount: 1n, owner: code.owner, blinding: 3n };
    const viaCode = encryptNoteV2(paid, code, code.secret);
    expect(openNoteV2(viaCode, bob, noteCommitmentV2(paid), assets)).toBeNull(); // code not looked for
    expect(openNoteV2(viaCode, bob, noteCommitmentV2(paid), assets, [{ index: 2, secret: code.secret }])?.source).toEqual({ code: 2 });
  });

  it("a swap note opens with the amount the event gives", () => {
    const to = mainAddress(alice);
    const encrypted = encryptNoteV2({ amount: 100n, blinding: 77n }, to, alice.selfNoteKey);
    const real = { asset: assetId(USDC), amount: 105n, owner: to.owner, blinding: 77n };
    expect(openNoteV2(encrypted, alice, noteCommitmentV2(real), assets, [], 105n)?.note.amount).toBe(105n);
    expect(openNoteV2(encrypted, alice, noteCommitmentV2(real), assets)).toBeNull();
  });
});

describe("codec v2", () => {
  const ext = {
    recipient: new PublicKey(new Uint8Array(32).fill(9)),
    extAmount: -5n,
    asset: USDC,
    encryptedOutputs: [new Uint8Array(103).fill(1), new Uint8Array(0), new Uint8Array(103).fill(3)] as [Uint8Array, Uint8Array, Uint8Array],
    swap: { outputMint: NATIVE_MINT, minAmountOut: 77n, inner: 123456789n, encryptedOutput: new Uint8Array(103).fill(4) },
  };

  it("encodes ExtDataV2 exactly as the reference does", () => {
    const asReference = {
      recipient: ext.recipient.toBytes(),
      extAmount: ext.extAmount,
      asset: ext.asset.toBytes(),
      encryptedOutputs: ext.encryptedOutputs,
      swap: { outputMint: NATIVE_MINT.toBytes(), minAmountOut: 77n, inner: 123456789n, encryptedOutput: ext.swap.encryptedOutput },
    };
    expect(encodeExtDataV2(ext)).toEqual(reference.encodeExtDataV2(asReference));
    expect(extDataHashV2(ext)).toBe(reference.extDataHashV2(asReference));
    expect(encodeExtDataV2({ ...ext, swap: null })).toEqual(reference.encodeExtDataV2({ ...asReference, swap: null }));
  });

  it("round-trips the instruction data and refuses a wrong length", () => {
    const args = {
      proof: { a: new Uint8Array(64).fill(1), b: new Uint8Array(128).fill(2), c: new Uint8Array(64).fill(3) },
      root: new Uint8Array(32).fill(4),
      inputNullifiers: [new Uint8Array(32).fill(5), new Uint8Array(32).fill(6)] as [Uint8Array, Uint8Array],
      outputCommitments: [new Uint8Array(32).fill(7), new Uint8Array(32).fill(8), new Uint8Array(32)] as [Uint8Array, Uint8Array, Uint8Array],
      extData: ext,
    };
    const route = Uint8Array.of(1, 2, 3);
    const swap = decodeV2Data(encodeSwapV2Data(args, route));
    expect(swap.kind).toBe("swap");
    expect(swap.args.extData.swap?.inner).toBe(123456789n);
    expect(swap.kind === "swap" && swap.route).toEqual(route);
    const plain = decodeV2Data(encodeTransactV2Data({ ...args, extData: { ...ext, swap: null } }));
    expect(plain.kind).toBe("transact");
    expect(() => encodeExtDataV2({ ...ext, encryptedOutputs: [new Uint8Array(87), new Uint8Array(0), new Uint8Array(0)] })).toThrow(/103/);
  });

  it("decodes the event", () => {
    const body = concatBytes(
      new Uint8Array([8, 0, 0, 0, 0, 0, 0, 0]),
      ...[1, 2, 3, 0].map((v) => new Uint8Array(32).fill(v)),
      ...[0, 1, 2].map(() => concatBytes(Uint8Array.of(0, 0, 0, 0))),
      new Uint8Array(32).fill(9),
      new Uint8Array(32).fill(10),
      Uint8Array.of(0),
    );
    const event = decodeTransactV2Event(concatBytes(EVENT_IX_TAG, TRANSACT_V2_EVENT_DISCRIMINATOR, body));
    expect(event?.firstIndex).toBe(8);
    expect(event?.commitments[3]).toBe(0n);
    expect(decodeTransactV2Event(Uint8Array.of(1, 2, 3))).toBeNull();
  });
});

describe("wallet state v2 and a real proof", () => {
  it("finds its notes, computes balances, proves a private USDC transfer", async () => {
    const prover = await createNodeProverV2();
    const own = mainAddress(alice);
    const usdc = assetId(USDC);
    // Two deposits' worth of leaves, as events.
    const notes = [
      { asset: usdc, amount: 70n, owner: own.owner, blinding: 1n },
      { asset: usdc, amount: 50n, owner: own.owner, blinding: 2n },
    ];
    const events = notes.map((note, i) => ({
      firstIndex: i * 4,
      commitments: [noteCommitmentV2(note), 0n, 0n, 0n] as [bigint, bigint, bigint, bigint],
      encryptedOutputs: [encryptNoteV2(note, own, alice.selfNoteKey), new Uint8Array(0), new Uint8Array(0)] as [Uint8Array, Uint8Array, Uint8Array],
      nullifiers: [BigInt(i + 1), BigInt(i + 100)] as [bigint, bigint],
      swap: null,
    }));
    const applied = applyEventsV2(createWalletStateV2(alice), events, alice, assets);
    expect(applied.received).toHaveLength(2);
    expect(balancesV2(applied.state).get(USDC.toBase58())).toBe(120n);
    expect(parseWalletStateV2(JSON.parse(JSON.stringify(applied.state)))).toEqual(applied.state);

    const tree = MerkleTree.fromLeaves(applied.state.leaves.map(BigInt), TREE_DEPTH_V2);
    const chosen = selectNotesV2(applied.received, USDC, 100n);
    expect(chosen).toHaveLength(2);
    const to = paymentCodeAtV2(bob, 0);
    const relayer = addressAt(keysV2FromSeed(new Uint8Array(32).fill(7)), 0);
    const prepared = await prepareTransactV2({
      prover,
      root: tree.root,
      mint: USDC,
      spendKeys: alice,
      inputs: chosen.map((n) => ({ note: n, d: n.d, leafIndex: n.leafIndex, pathElements: tree.path(n.leafIndex).pathElements })),
      outputs: [{ amount: 100n, to }, { amount: 16n, to: own }, { amount: 4n, to: relayer }],
      padding: own,
      own: alice,
      extAmount: 0n,
      feeOutput: 2,
    });
    expect(prepared.publicInputs[2]).toBe(0n); // the asset of a transfer is hidden
    expect(prepared.args.extData.asset.equals(PublicKey.default)).toBe(true);
    expect(prepared.feeNote?.amount).toBe(4n);
    expect(await verifyProof(prover.verificationKey, prepared.proof, prepared.publicSignals)).toBe(true);
    // Bob finds his note through the code; the relayer finds its fee with its own key.
    const bobOutput = prepared.outputs.find((o) => o.note.amount === 100n)!;
    expect(openNoteV2(bobOutput.encryptedOutput, bob, bobOutput.commitment, assets, [{ index: 0, secret: to.secret }])?.note.amount).toBe(100n);
    // Issuing a code advances the count.
    const issued = issuePaymentCodeV2(applied.state, alice);
    expect(issued.index).toBe(0);
    expect(issued.state.paymentCodes).toEqual({ issued: 1, used: 0 });
  });
});

void FIELD_MODULUS;
