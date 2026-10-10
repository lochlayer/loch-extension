// Keys, notes, commitments and nullifiers, as written in docs/protocol.md:
//
//   pubKey     = Poseidon(privKey)
//   commitment = Poseidon(amount, pubKey, blinding)
//   signature  = Poseidon(privKey, commitment, leafIndex)
//   nullifier  = Poseidon(commitment, leafIndex, signature)

import { poseidon1 } from 'poseidon-lite/poseidon1';
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';

import { randomFieldElement } from './field.mjs';

export { poseidon1, poseidon2, poseidon3 };

export function keypairFromPrivateKey(privKey) {
  const key = BigInt(privKey);
  return { privKey: key, pubKey: poseidon1([key]) };
}

export const randomKeypair = () => keypairFromPrivateKey(randomFieldElement());

/** A note is (amount, pubKey, blinding). */
export function createNote(amount, pubKey, blinding = randomFieldElement()) {
  return { amount: BigInt(amount), pubKey: BigInt(pubKey), blinding: BigInt(blinding) };
}

export function commitmentOf(note) {
  return poseidon3([note.amount, note.pubKey, note.blinding]);
}

export function signatureOf(privKey, commitment, leafIndex) {
  return poseidon3([BigInt(privKey), commitment, BigInt(leafIndex)]);
}

export function nullifierOf(note, leafIndex, privKey) {
  const commitment = commitmentOf(note);
  return poseidon3([commitment, BigInt(leafIndex), signatureOf(privKey, commitment, leafIndex)]);
}
