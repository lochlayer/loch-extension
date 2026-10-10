// Byte-for-byte agreement with circuits/artifacts/devnet/test_vector.json: one
// real proof in snarkjs form and in the exact bytes the program expects.

import { PublicKey } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes } from "../src/bytes.js";
import {
  type ExtData,
  type TransactArgs,
  decodeProof,
  decodeTransactArgs,
  encodeExtData,
  encodeProof,
  encodeTransactArgs,
  extDataHash,
  fieldToBytes,
  proofEncodingProblem,
  publicAmountField,
  terminateProver,
  transactPublicInputs,
  verifyProof,
} from "../src/index.js";
import { BASE_FIELD_MODULUS } from "../src/constants.js";
import { loadVerificationKey } from "../src/node.js";
import { VECTOR_PATH, readJson } from "./helpers/fixtures.js";

const vector = readJson(VECTOR_PATH);

const extData: ExtData = {
  recipient: new PublicKey(hexToBytes(vector.extData.recipient)),
  relayer: new PublicKey(hexToBytes(vector.extData.relayer)),
  extAmount: BigInt(vector.extData.extAmount),
  fee: BigInt(vector.extData.fee),
  encryptedOutput0: hexToBytes(vector.extData.encryptedOutput0),
  encryptedOutput1: hexToBytes(vector.extData.encryptedOutput1),
};

const args: TransactArgs = {
  proof: {
    a: hexToBytes(vector.program.proofA),
    b: hexToBytes(vector.program.proofB),
    c: hexToBytes(vector.program.proofC),
  },
  root: hexToBytes(vector.program.root),
  inputNullifiers: [hexToBytes(vector.program.inputNullifiers[0]), hexToBytes(vector.program.inputNullifiers[1])],
  outputCommitments: [hexToBytes(vector.program.outputCommitments[0]), hexToBytes(vector.program.outputCommitments[1])],
  extData,
};

afterAll(terminateProver);

describe("devnet test vector", () => {
  it("encodes the snarkjs proof to the program's exact bytes", () => {
    const encoded = encodeProof(vector.snarkjs.proof);
    expect(bytesToHex(encoded.a)).toBe(vector.program.proofA);
    expect(bytesToHex(encoded.b)).toBe(vector.program.proofB);
    expect(bytesToHex(encoded.c)).toBe(vector.program.proofC);
    expect(encoded.a).toHaveLength(64);
    expect(encoded.b).toHaveLength(128);
    expect(encoded.c).toHaveLength(64);
  });

  it("decodes the program bytes back to the snarkjs proof", () => {
    expect(decodeProof(args.proof)).toEqual(vector.snarkjs.proof);
  });

  it("encodes every public signal as the program's 32-byte big-endian input", () => {
    const encoded = (vector.snarkjs.publicSignals as string[]).map((signal) => bytesToHex(fieldToBytes(BigInt(signal))));
    expect(encoded).toEqual(vector.program.publicInputs);
  });

  it("lays ext data out as Borsh and hashes it like the program", () => {
    expect(bytesToHex(encodeExtData(extData))).toBe(vector.extData.borsh);
    expect(bytesToHex(fieldToBytes(extDataHash(extData)))).toBe(vector.extData.hash);
    expect(extDataHash(extData).toString()).toBe(vector.snarkjs.publicSignals[2]);
  });

  it("computes the publicAmount of the vector (a withdrawal with a fee)", () => {
    expect(publicAmountField(extData.extAmount, extData.fee).toString()).toBe(vector.snarkjs.publicSignals[1]);
  });

  it("rebuilds all seven public inputs from the encoded arguments, in circuit order", () => {
    expect(vector.publicSignalOrder).toHaveLength(7);
    expect(transactPublicInputs(args).map(String)).toEqual(vector.snarkjs.publicSignals);
  });

  it("survives a round trip through the instruction data", () => {
    const data = encodeTransactArgs(args);
    expect(bytesToHex(data.subarray(8, 8 + 64))).toBe(vector.program.proofA);
    expect(bytesToHex(data.subarray(8 + 256, 8 + 288))).toBe(vector.program.root);
    expect(bytesToHex(data.subarray(8 + 416))).toBe(vector.extData.borsh);
    expect(transactPublicInputs(decodeTransactArgs(data)).map(String)).toEqual(vector.snarkjs.publicSignals);
  });

  it("verifies against verification_key.json, from the program bytes alone", async () => {
    const verificationKey = await loadVerificationKey();
    expect(await verifyProof(verificationKey, decodeProof(args.proof), transactPublicInputs(args))).toBe(true);
  });

  it("a coordinate written as x + q verifies off chain when decoded leniently, so decodeProof refuses it", async () => {
    // The program's verifier (alt_bn128 syscalls) rejects any coordinate of q or more. snarkjs
    // reduces coordinates mod q. A relayer that pre-checks with snarkjs and then sends would pay
    // the fee of a transaction that cannot succeed, as often as somebody likes to ask.
    const verificationKey = await loadVerificationKey();
    const publicInputs = transactPublicInputs(args);
    const q = BASE_FIELD_MODULUS;
    const decimal = (part: Uint8Array, word: number) => BigInt(`0x${bytesToHex(part.subarray(word * 32, word * 32 + 32))}`);
    // What decodeProof did before it checked ranges: big-endian words to decimals, A negated back mod q.
    const lenient = (proof: TransactArgs["proof"]) => ({
      pi_a: [decimal(proof.a, 0).toString(), (((q - decimal(proof.a, 1)) % q) + q).toString(), "1"].map((v, i) => (i === 1 ? (BigInt(v) % q).toString() : v)),
      pi_b: [
        [decimal(proof.b, 1).toString(), decimal(proof.b, 0).toString()],
        [decimal(proof.b, 3).toString(), decimal(proof.b, 2).toString()],
        ["1", "0"],
      ],
      pi_c: [decimal(proof.c, 0).toString(), decimal(proof.c, 1).toString(), "1"],
      protocol: "groth16",
      curve: "bn128",
    });
    expect(await verifyProof(verificationKey, lenient(args.proof), publicInputs)).toBe(true);

    const variants: [string, "a" | "b" | "c", number, bigint][] = [
      ["a.x + q", "a", 0, 1n],
      ["a.y + q", "a", 1, 1n],
      ["b word 0 + q", "b", 0, 1n],
      ["b word 3 + q", "b", 3, 1n],
      ["c.x + q", "c", 0, 1n],
      ["c.y + 2q", "c", 1, 2n],
    ];
    for (const [name, part, word, times] of variants) {
      const bytes = Uint8Array.from(args.proof[part]);
      const value = decimal(bytes, word) + times * q;
      expect(value >> 256n, name).toBe(0n);
      bytes.set(hexToBytes(value.toString(16).padStart(64, "0")), word * 32);
      const aliased = { ...args.proof, [part]: bytes };
      // The discrepancy itself. If a later snarkjs stops reducing, this line can go; the two below stay.
      expect(await verifyProof(verificationKey, lenient(aliased), publicInputs), name).toBe(true);
      expect(proofEncodingProblem(aliased), name).toMatch(/not below the base field modulus/);
      expect(() => decodeProof(aliased), name).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    }
    expect(await verifyProof(verificationKey, decodeProof(args.proof), publicInputs)).toBe(true);
  });

  it("does not verify once any public input changes", async () => {
    const verificationKey = await loadVerificationKey();
    const tampered = { ...args, extData: { ...extData, fee: extData.fee + 1n } };
    expect(await verifyProof(verificationKey, decodeProof(args.proof), transactPublicInputs(tampered))).toBe(false);
  });
});
