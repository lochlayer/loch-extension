// Witness generation, proving and verification against the shipped devnet
// artifacts (circuits/artifacts/devnet).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as snarkjs from 'snarkjs';

import { readR1csConstraints } from '../../scripts/lib.mjs';
import { FIELD_SIZE } from './field.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const CIRCUITS_DIR = resolve(here, '..', '..');
export const REPO_ROOT = resolve(CIRCUITS_DIR, '..');
export const ARTIFACTS_DIR = join(CIRCUITS_DIR, 'artifacts', 'devnet');
export const WASM_PATH = join(ARTIFACTS_DIR, 'transaction.wasm');
export const ZKEY_PATH = join(ARTIFACTS_DIR, 'transaction_final.zkey');
export const VKEY_PATH = join(ARTIFACTS_DIR, 'verification_key.json');
export const MANIFEST_PATH = join(ARTIFACTS_DIR, 'manifest.json');
export const R1CS_PATH = join(REPO_ROOT, 'build', 'transaction.r1cs');

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Runs the witness generator. Rejects when any `===` in the circuit fails. */
export async function calculateWitness(input, wasm = WASM_PATH) {
  const wtns = { type: 'mem' };
  await snarkjs.wtns.calculate(input, wasm, wtns);
  return wtns;
}

/** Parses an in-memory .wtns file into an array of bigints (wire 0 is the constant 1). */
export function readWitness(wtns) {
  const data = Buffer.from(wtns.data.buffer, wtns.data.byteOffset, wtns.data.byteLength);
  assert.equal(data.toString('latin1', 0, 4), 'wtns');
  const nSections = data.readUInt32LE(8);
  let pos = 12;
  let n8 = 0;
  let count = 0;
  let values = null;
  for (let s = 0; s < nSections; s++) {
    const id = data.readUInt32LE(pos);
    const size = Number(data.readBigUInt64LE(pos + 4));
    const start = pos + 12;
    if (id === 1) {
      n8 = data.readUInt32LE(start);
      count = data.readUInt32LE(start + 4 + n8);
    } else if (id === 2) {
      values = data.subarray(start, start + size);
    }
    pos = start + size;
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    let v = 0n;
    for (let j = n8 - 1; j >= 0; j--) v = (v << 8n) | BigInt(values[i * n8 + j]);
    out.push(v);
  }
  return out;
}

/** 1-based line number of the first line of a circuit source that contains `text`. */
export function lineOf(file, text) {
  const lines = readFileSync(join(CIRCUITS_DIR, file), 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(text));
  assert.notEqual(index, -1, `"${text}" not found in ${file}`);
  return index + 1;
}

/**
 * Asserts that witness generation fails on one specific constraint.
 *
 * `expected` is the chain circom reports, innermost template first, as
 * [template, line] pairs: the template the failing `===` lives in, then each
 * parent with the line that feeds that sub-component. Matching the whole chain
 * means a test cannot pass because some unrelated check tripped first.
 */
export async function assertWitnessFails(input, expected, wasm = WASM_PATH) {
  let error = null;
  // circom_runtime prints every failed assert to the console before throwing.
  const { log, error: consoleError } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    await calculateWitness(input, wasm);
  } catch (caught) {
    error = caught;
  } finally {
    console.log = log;
    console.error = consoleError;
  }
  assert.ok(error, 'witness generation succeeded, expected a constraint failure');
  const message = String(error.message ?? error);
  assert.match(message, /Assert Failed/, `unexpected error: ${message}`);
  const chain = [...message.matchAll(/Error in template (\w+?)_\d+ line: (\d+)/g)].map((m) => [
    m[1],
    Number(m[2]),
  ]);
  assert.deepEqual(chain, expected, `failed at an unexpected place: ${message}`);
}

/**
 * Returns a copy of a circom wasm witness generator in which a failed `===`
 * no longer aborts. circom compiles every assert to
 *
 *   call $printErrorMessage ; i32.const 4 ; return ; end
 *
 * and this replaces `i32.const 4 ; return` with three nops inside the code
 * section, so the generator keeps going and emits the witness a prover would
 * get by ignoring the checks. Used to test the r1cs itself, not the generator.
 */
export function stripAsserts(wasmBytes) {
  const wasm = new Uint8Array(wasmBytes);
  const leb = (pos) => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = wasm[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return [value, pos];
    }
  };

  // Function index of the imported runtime.printErrorMessage.
  let printErrorMessage = -1;
  let code = null;
  let pos = 8;
  while (pos < wasm.length) {
    const id = wasm[pos];
    const [size, start] = leb(pos + 1);
    if (id === 2) {
      let [count, p] = leb(start);
      let functionIndex = 0;
      for (let i = 0; i < count; i++) {
        const names = [];
        for (let n = 0; n < 2; n++) {
          const [length, q] = leb(p);
          names.push(Buffer.from(wasm.subarray(q, q + length)).toString('latin1'));
          p = q + length;
        }
        const kind = wasm[p++];
        assert.equal(kind, 0, 'unexpected non-function import in a circom wasm');
        [, p] = leb(p);
        if (names[1] === 'printErrorMessage') printErrorMessage = functionIndex;
        functionIndex++;
      }
    } else if (id === 10) {
      code = { start, end: start + size };
    }
    pos = start + size;
  }
  assert.ok(code && printErrorMessage >= 0 && printErrorMessage < 0x80, 'not a circom wasm');

  const pattern = [0x10, printErrorMessage, 0x41, 0x04, 0x0f, 0x0b];
  let patched = 0;
  for (let i = code.start; i + pattern.length <= code.end; i++) {
    if (pattern.every((byte, k) => wasm[i + k] === byte)) {
      wasm[i + 2] = 0x01;
      wasm[i + 3] = 0x01;
      wasm[i + 4] = 0x01;
      patched++;
    }
  }
  return { wasm, patched };
}

export async function prove(input) {
  return snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH);
}

export async function proveWitness(wtns) {
  return snarkjs.groth16.prove(ZKEY_PATH, wtns);
}

export async function verify(publicSignals, proof, vkey = readJson(VKEY_PATH)) {
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/** True when the witness satisfies every constraint of the r1cs. */
export async function witnessSatisfiesR1cs(wtns, r1csPath = R1CS_PATH) {
  const silent = { info() {}, warn() {}, debug() {}, error() {} };
  return snarkjs.wtns.check(r1csPath, wtns, silent);
}

let cachedConstraints = null;

/**
 * Indices of the r1cs constraints a witness violates (A * B - C != 0 mod r).
 * Empty for a valid witness. Unlike snarkjs' check this does not stop at the
 * first failure, so a test can see how targeted a forgery is.
 */
export function r1csViolations(wtns, r1csPath = R1CS_PATH) {
  cachedConstraints ??= readR1csConstraints(r1csPath);
  const witness = readWitness(wtns);
  const evaluate = (terms) => {
    let sum = 0n;
    for (const [wire, coefficient] of terms) sum += coefficient * witness[wire];
    return sum % FIELD_SIZE;
  };
  const violated = [];
  cachedConstraints.forEach(([a, b, c], index) => {
    if ((evaluate(a) * evaluate(b) - evaluate(c)) % FIELD_SIZE !== 0n) violated.push(index);
  });
  return violated;
}

/** snarkjs keeps worker threads alive; without this the test process never exits. */
export async function shutdown() {
  await globalThis.curve_bn128?.terminate();
}

export { snarkjs };
