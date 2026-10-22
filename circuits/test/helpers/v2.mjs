// Reference implementation of the v2 circuit's arithmetic (docs/v2.md
// sections 1 to 3, 6 and 7), written from the specification and independent of
// the SDK, so the circuit tests check the circuit against the text.
//
//   ak         = Poseidon(ask)
//   ownerRoot  = Poseidon(ak, nk)
//   owner      = Poseidon(ownerRoot, d)
//   inner      = Poseidon(owner, blinding)
//   commitment = Poseidon(asset, amount, inner)
//   nullifier  = Poseidon(nk, commitment, leafIndex)
//
// ExtDataV2, Borsh, in field order:
//   recipient            32 bytes
//   ext_amount           i64 little-endian
//   asset                32 bytes
//   encrypted_outputs    3 x (u32 little-endian length, bytes)
//   swap                 u8 0 (None) | 1 then output_mint (32), min_amount_out
//                        (u64 LE), inner (32 BE), encrypted_output (u32 LE length, bytes)

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';

import { FIELD_SIZE, fromBytesBE, mod, randomFieldElement, toBytesBE } from './field.mjs';
import { MerkleTree } from './merkle.mjs';
import { ARTIFACTS_DIR, REPO_ROOT, readJson, snarkjs } from './prover.mjs';

export const LEVELS = 26;
export const N_INS = 2;
export const N_OUTS = 3;

export const V2_DIR = join(ARTIFACTS_DIR, 'transaction2');
export const WASM2_PATH = join(V2_DIR, 'transaction2.wasm');
export const ZKEY2_PATH = join(V2_DIR, 'transaction2_final.zkey');
export const VKEY2_PATH = join(V2_DIR, 'verification_key.json');
export const R1CS2_PATH = join(REPO_ROOT, 'build', 'transaction2', 'transaction2.r1cs');

export const PUBLIC_SIGNALS = [
  'root',
  'publicAmount',
  'publicAsset',
  'extDataHash',
  'inputNullifier[0]',
  'inputNullifier[1]',
  'outputCommitment[0]',
  'outputCommitment[1]',
  'outputCommitment[2]',
];

/** A tree of the v2 depth. */
export const newTree = () => new MerkleTree(LEVELS);

/** A key set from its two secrets. */
export function keySet(ask = randomFieldElement(), nk = randomFieldElement()) {
  const ak = poseidon1([ask]);
  return { ask, nk, ak, ownerRoot: poseidon2([ak, nk]) };
}

/** A random 128-bit diversifier, as a field element. */
export const randomDiversifier = () => fromBytesBE(randomBytes(16));

export const ownerOf = (keys, d) => poseidon2([keys.ownerRoot, d]);

/** assetId(mint) = sha256("loch-asset-v2" || mint) with byte 0 cleared. */
export function assetId(mint) {
  const digest = createHash('sha256').update(Buffer.from('loch-asset-v2')).update(mint).digest();
  digest[0] = 0;
  return fromBytesBE(digest);
}

export function createNote(asset, amount, owner, blinding = randomFieldElement()) {
  return { asset: BigInt(asset), amount: BigInt(amount), owner: BigInt(owner), blinding: BigInt(blinding) };
}

export const innerOf = (note) => poseidon2([note.owner, note.blinding]);
export const commitmentOf = (note) => poseidon3([note.asset, note.amount, innerOf(note)]);
export const nullifierOf = (nk, commitment, leafIndex) => poseidon3([nk, commitment, BigInt(leafIndex)]);

/** A note owned by `keys` at diversifier `d`. */
export function ownedNote(keys, asset, amount, d = randomDiversifier(), blinding) {
  return { note: createNote(asset, amount, ownerOf(keys, d), blinding), d };
}

/** A real input: an owned note at `leafIndex` of `tree`. */
export function treeInput(tree, owned, leafIndex) {
  const { pathElements } = tree.path(Number(leafIndex));
  return { ...owned, leafIndex: BigInt(leafIndex), pathElements };
}

/** A zero-amount input of `keys` with a fresh diversifier and blinding. */
export function dummyInput(keys, asset) {
  return { ...ownedNote(keys, asset, 0n), leafIndex: 0n, pathElements: Array(LEVELS).fill(0n) };
}

export const dummyOutput = (asset) => createNote(asset, 0n, randomFieldElement());

// ---- ExtDataV2 ----

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const i64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const bytes32 = (value, name) => {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new TypeError(`${name}: expected 32 bytes`);
  return Buffer.from(value);
};
const vec = (value) => Buffer.concat([u32(value.length), Buffer.from(value)]);

export function encodeExtDataV2(ext) {
  const parts = [bytes32(ext.recipient, 'recipient'), i64(ext.extAmount), bytes32(ext.asset, 'asset')];
  if (ext.encryptedOutputs.length !== 3) throw new TypeError('three encrypted outputs');
  for (const output of ext.encryptedOutputs) parts.push(vec(output));
  if (ext.swap) {
    const { outputMint, minAmountOut, inner, encryptedOutput } = ext.swap;
    parts.push(Buffer.of(1), bytes32(outputMint, 'outputMint'), u64(minAmountOut), Buffer.from(toBytesBE(inner)), vec(encryptedOutput));
  } else {
    parts.push(Buffer.of(0));
  }
  return new Uint8Array(Buffer.concat(parts));
}

export function extDataHashV2Bytes(ext) {
  const digest = createHash('sha256').update(encodeExtDataV2(ext)).digest();
  digest[0] = 0;
  return new Uint8Array(digest);
}

export const extDataHashV2 = (ext) => fromBytesBE(extDataHashV2Bytes(ext));

export const ZERO32 = new Uint8Array(32);

export const defaultExtDataV2 = (overrides = {}) => ({
  recipient: ZERO32,
  extAmount: 0n,
  asset: ZERO32,
  encryptedOutputs: [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)],
  swap: null,
  ...overrides,
});

/** publicAmount = ext_amount mod r. */
export const publicAmountV2 = (extAmount) => mod(BigInt(extAmount));

/** publicAsset = asset if publicAmount != 0, else 0. */
export const publicAssetV2 = (asset, extAmount) => (BigInt(extAmount) === 0n ? 0n : BigInt(asset));

/**
 * Assembles the witness input of a v2 transaction.
 *
 *   keys     the spender's key set ({ ask, nk, ownerRoot })
 *   asset    the transaction's asset (field element)
 *   root     Merkle root the real inputs are proven against
 *   inputs   up to 2 of { note, d, leafIndex, pathElements }; padded with dummies
 *   outputs  up to 3 notes; padded with zero-amount notes
 *   extData  ExtDataV2
 */
export function buildTransaction2({ keys, asset, root, inputs = [], outputs = [], extData = defaultExtDataV2() }) {
  if (inputs.length > N_INS || outputs.length > N_OUTS) throw new Error('at most 2 in, 3 out');
  const ins = [...inputs];
  while (ins.length < N_INS) ins.push(dummyInput(keys, asset));
  const outs = [...outputs];
  while (outs.length < N_OUTS) outs.push(dummyOutput(asset));

  const amount = publicAmountV2(extData.extAmount);
  const publicAsset = publicAssetV2(asset, extData.extAmount);
  const hash = extDataHashV2(extData);
  // The commitment the circuit derives for each input: the transaction's asset
  // and key set, the input's own diversifier. For an honest input it is the
  // note's commitment; for an attack it is what the attacker would publish.
  const derived = ins.map((i) => commitmentOf({ asset: BigInt(asset), amount: i.note.amount, owner: ownerOf(keys, i.d), blinding: i.note.blinding }));
  const nullifiers = ins.map((i, k) => nullifierOf(keys.nk, derived[k], i.leafIndex));
  const commitments = outs.map(commitmentOf);

  const input = {
    root: BigInt(root),
    publicAmount: amount,
    publicAsset,
    extDataHash: hash,
    inputNullifier: nullifiers,
    outputCommitment: commitments,

    asset: BigInt(asset),
    spendKey: keys.ask,
    nullifierKey: keys.nk,

    inAmount: ins.map((i) => i.note.amount),
    inBlinding: ins.map((i) => i.note.blinding),
    inDiversifier: ins.map((i) => i.d),
    inPathIndices: ins.map((i) => i.leafIndex),
    inPathElements: ins.map((i) => i.pathElements),

    outAmount: outs.map((o) => o.amount),
    outOwner: outs.map((o) => o.owner),
    outBlinding: outs.map((o) => o.blinding),
  };
  return {
    input,
    publicSignals: [BigInt(root), amount, publicAsset, hash, ...nullifiers, ...commitments],
    inputs: ins,
    outputs: outs,
    extData,
  };
}

export async function prove2(input) {
  return snarkjs.groth16.fullProve(input, WASM2_PATH, ZKEY2_PATH);
}

export async function verify2(publicSignals, proof) {
  return snarkjs.groth16.verify(readJson(VKEY2_PATH), publicSignals, proof);
}

export { FIELD_SIZE, mod, poseidon1, poseidon2, poseidon3, randomFieldElement };
