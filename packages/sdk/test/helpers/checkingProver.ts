// A stand-in prover for tests that are not about Groth16: it checks every
// constraint of circuits/transaction.circom with the circuit package's own
// reference implementation and returns a placeholder proof. Tests that need a
// real proof use the devnet artifacts (e2e.test.ts).

import { rootFromPath } from "../../../../circuits/test/helpers/merkle.mjs";
import { commitmentOf, keypairFromPrivateKey, nullifierOf } from "../../../../circuits/test/helpers/note.mjs";
import { type CircuitInput, FIELD_MODULUS, type Groth16Proof, type Prover } from "../../src/index.js";
import { VECTOR_PATH, readJson } from "./fixtures.js";

const placeholder: Groth16Proof = readJson(VECTOR_PATH).snarkjs.proof;

export class ConstraintViolation extends Error {}

/** Throws ConstraintViolation unless `input` satisfies the transaction circuit. */
export function checkCircuit(input: CircuitInput): void {
  const fail = (what: string): never => {
    throw new ConstraintViolation(what);
  };
  let sumIn = 0n;
  for (const i of [0, 1] as const) {
    const amount = input.inAmount[i];
    const index = input.inPathIndices[i];
    const note = { amount, pubKey: keypairFromPrivateKey(input.inPrivateKey[i]).pubKey, blinding: input.inBlinding[i] };
    if (nullifierOf(note, index, input.inPrivateKey[i]) !== input.inputNullifier[i]) fail(`nullifier ${i}`);
    if (index < 0n || index >= 1n << 20n) fail(`path index ${i}`);
    if (input.inPathElements[i].length !== 20) fail(`path length ${i}`);
    if (amount !== 0n && rootFromPath(commitmentOf(note), index, input.inPathElements[i]) !== input.root) fail(`membership ${i}`);
    sumIn += amount;
  }
  let sumOut = 0n;
  for (const i of [0, 1] as const) {
    const note = { amount: input.outAmount[i], pubKey: input.outPubkey[i], blinding: input.outBlinding[i] };
    if (commitmentOf(note) !== input.outputCommitment[i]) fail(`commitment ${i}`);
    if (input.outAmount[i] >> 248n !== 0n) fail(`output range ${i}`);
    sumOut += input.outAmount[i];
  }
  if (input.inputNullifier[0] === input.inputNullifier[1]) fail("equal nullifiers");
  if ((sumIn + input.publicAmount) % FIELD_MODULUS !== sumOut % FIELD_MODULUS) fail("value conservation");
}

/** A prover that enforces the circuit's constraints and records what it was asked to prove. */
export function checkingProver(): Prover & { inputs: CircuitInput[] } {
  const inputs: CircuitInput[] = [];
  return {
    inputs,
    async prove(input) {
      checkCircuit(input);
      inputs.push(input);
      return {
        proof: placeholder,
        publicSignals: [input.root, input.publicAmount, input.extDataHash, ...input.inputNullifier, ...input.outputCommitment].map(String),
      };
    },
  };
}
