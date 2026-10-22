// Shared helpers for the circuit build scripts. Node built-ins only.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const CIRCUITS_DIR = resolve(here, '..');
export const REPO_ROOT = resolve(CIRCUITS_DIR, '..');
export const BUILD_DIR = join(REPO_ROOT, 'build');
export const ARTIFACTS_DIR = join(CIRCUITS_DIR, 'artifacts', 'devnet');
export const VERIFYING_KEY_RS = join(REPO_ROOT, 'programs', 'loch_pool', 'src', 'verifying_key.rs');

export function readToolchain() {
  return JSON.parse(readFileSync(join(CIRCUITS_DIR, 'toolchain.json'), 'utf8'));
}

export function hashFile(path, algorithm = 'sha256') {
  return createHash(algorithm).update(readFileSync(path)).digest('hex');
}

export function fileEntry(path) {
  return { sha256: hashFile(path), bytes: statSync(path).size };
}

/**
 * Reads the header and counts the constraints of a binary .r1cs file
 * (format: https://github.com/iden3/r1csfile/blob/master/doc/r1cs_bin_format.md).
 *
 * A constraint is A * B = C over linear combinations. It is counted as
 * non-linear when both A and B are non-empty, which is how circom reports it.
 */
export function readR1csSummary(path) {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'r1cs') throw new Error(`${path}: not an r1cs file`);
  const version = buf.readUInt32LE(4);
  if (version !== 1) throw new Error(`${path}: unsupported r1cs version ${version}`);
  const nSections = buf.readUInt32LE(8);

  const sections = new Map();
  let pos = 12;
  for (let i = 0; i < nSections; i++) {
    const type = buf.readUInt32LE(pos);
    const size = Number(buf.readBigUInt64LE(pos + 4));
    sections.set(type, { start: pos + 12, size });
    pos += 12 + size;
  }

  const header = sections.get(1);
  const constraints = sections.get(2);
  if (!header || !constraints) throw new Error(`${path}: missing header or constraint section`);

  let p = header.start;
  const fieldSize = buf.readUInt32LE(p);
  p += 4;
  let prime = 0n;
  for (let i = fieldSize - 1; i >= 0; i--) prime = (prime << 8n) | BigInt(buf[p + i]);
  p += fieldSize;
  const wires = buf.readUInt32LE(p);
  const publicOutputs = buf.readUInt32LE(p + 4);
  const publicInputs = buf.readUInt32LE(p + 8);
  const privateInputs = buf.readUInt32LE(p + 12);
  const labels = Number(buf.readBigUInt64LE(p + 16));
  const total = buf.readUInt32LE(p + 24);

  let nonLinear = 0;
  let q = constraints.start;
  const termSize = 4 + fieldSize;
  for (let i = 0; i < total; i++) {
    const nA = buf.readUInt32LE(q);
    q += 4 + nA * termSize;
    const nB = buf.readUInt32LE(q);
    q += 4 + nB * termSize;
    const nC = buf.readUInt32LE(q);
    q += 4 + nC * termSize;
    if (nA > 0 && nB > 0) nonLinear++;
  }
  if (q !== constraints.start + constraints.size) {
    throw new Error(`${path}: constraint section size mismatch`);
  }

  return {
    prime: prime.toString(),
    nonLinear,
    linear: total - nonLinear,
    total,
    wires,
    publicInputs,
    publicOutputs,
    privateInputs,
    labels,
  };
}

/**
 * Loads every constraint of a binary .r1cs file as [A, B, C], each a list of
 * [wire, coefficient] terms. Meant for tests that evaluate a witness against
 * the constraints one by one.
 */
export function readR1csConstraints(path) {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'r1cs') throw new Error(`${path}: not an r1cs file`);
  const nSections = buf.readUInt32LE(8);
  let header = -1;
  let body = -1;
  let pos = 12;
  for (let i = 0; i < nSections; i++) {
    const type = buf.readUInt32LE(pos);
    const size = Number(buf.readBigUInt64LE(pos + 4));
    if (type === 1) header = pos + 12;
    if (type === 2) body = pos + 12;
    pos += 12 + size;
  }
  if (header < 0 || body < 0) throw new Error(`${path}: missing header or constraint section`);
  const fieldSize = buf.readUInt32LE(header);
  const total = buf.readUInt32LE(header + 4 + fieldSize + 24);

  let q = body;
  const combination = () => {
    const count = buf.readUInt32LE(q);
    q += 4;
    const terms = [];
    for (let i = 0; i < count; i++) {
      const wire = buf.readUInt32LE(q);
      let coefficient = 0n;
      for (let j = fieldSize - 1; j >= 0; j--) {
        coefficient = (coefficient << 8n) | BigInt(buf[q + 4 + j]);
      }
      q += 4 + fieldSize;
      terms.push([wire, coefficient]);
    }
    return terms;
  };
  const constraints = [];
  for (let i = 0; i < total; i++) constraints.push([combination(), combination(), combination()]);
  return constraints;
}

/** Smallest Groth16 domain exponent snarkjs will accept for this r1cs. */
export function requiredPtauPower(summary) {
  const needed = summary.total + summary.publicInputs + summary.publicOutputs + 1;
  let power = 0;
  while (2 ** power < needed) power++;
  return power;
}
