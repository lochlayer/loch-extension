// Append-only Poseidon Merkle tree, the same algorithm as
// programs/loch_pool/src/merkle.rs: empty leaf 0,
// zeros[i + 1] = Poseidon(zeros[i], zeros[i]), node = Poseidon(left, right).

import { poseidon2 } from 'poseidon-lite/poseidon2';

export const TREE_LEVELS = 20;

export class MerkleTree {
  constructor(levels = TREE_LEVELS) {
    this.levels = levels;
    this.zeros = [0n];
    for (let i = 0; i < levels; i++) this.zeros.push(poseidon2([this.zeros[i], this.zeros[i]]));
    // layers[0] holds the leaves, layers[levels] the root. Sparse: missing = zero subtree.
    this.layers = Array.from({ length: levels + 1 }, () => []);
  }

  get size() {
    return this.layers[0].length;
  }

  get root() {
    return this.layers[this.levels][0] ?? this.zeros[this.levels];
  }

  /** Appends a leaf and returns its index. */
  insert(leaf) {
    const index = this.size;
    if (index >= 2 ** this.levels) throw new Error('tree is full');
    this.layers[0].push(BigInt(leaf));
    let position = index;
    for (let level = 0; level < this.levels; level++) {
      const node = this.layers[level][position];
      const sibling = this.layers[level][position ^ 1] ?? this.zeros[level];
      const parent = position % 2 === 0 ? poseidon2([node, sibling]) : poseidon2([sibling, node]);
      position >>= 1;
      this.layers[level + 1][position] = parent;
    }
    return index;
  }

  /** Sibling path of leaf `index`, bottom-up. pathIndices is the leaf index itself. */
  path(index) {
    if (index < 0 || index >= this.size) throw new Error(`no leaf at index ${index}`);
    const pathElements = [];
    let position = index;
    for (let level = 0; level < this.levels; level++) {
      pathElements.push(this.layers[level][position ^ 1] ?? this.zeros[level]);
      position >>= 1;
    }
    return { pathElements, pathIndices: BigInt(index) };
  }
}

/** Recomputes the root from a leaf and its path, the way the circuit does. */
export function rootFromPath(leaf, index, pathElements) {
  let node = BigInt(leaf);
  let position = BigInt(index);
  for (const sibling of pathElements) {
    node = position % 2n === 0n ? poseidon2([node, sibling]) : poseidon2([sibling, node]);
    position >>= 1n;
  }
  return node;
}
