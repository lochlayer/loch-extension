// Append-only Poseidon Merkle tree, the same algorithm as
// programs/loch_pool/src/merkle.rs and the circuit's MerkleProof:
// empty leaf 0, zeros[i + 1] = Poseidon(zeros[i], zeros[i]),
// node = Poseidon(left, right), bit i of the leaf index = 0 means the node is
// the LEFT child at level i.

import { poseidon2 } from "poseidon-lite/poseidon2";

import { FIELD_MODULUS, TREE_DEPTH } from "./constants.js";
import { LochError } from "./errors.js";

/** Membership path of one leaf, in the form the circuit takes. */
export interface MerklePath {
  /** Sibling at every level, bottom-up; `depth` entries. */
  pathElements: bigint[];
  /** The leaf index. Its bits, little-endian, are the left/right choices. */
  pathIndices: bigint;
}

/** JSON form of a tree: leaves only. Restoring it rehashes the tree (about 2 hashes per leaf). */
export interface MerkleTreeJSON {
  depth: number;
  /** Leaves in index order, decimal strings. */
  leaves: string[];
}

/**
 * JSON form with every computed node, for a fast restore without hashing
 * (an extension service worker restarts often). `layers[0]` are the leaves.
 */
export interface MerkleTreeSnapshot {
  depth: number;
  /** `layers[level][position]`, decimal strings; `layers[depth]` holds the root. */
  layers: string[][];
}

const zeroCache = new Map<number, readonly bigint[]>();

/** `zeros[i]` is the root of an empty subtree of height i; `depth + 1` entries. */
export function zeroValues(depth: number = TREE_DEPTH): readonly bigint[] {
  let zeros = zeroCache.get(depth);
  if (!zeros) {
    if (!Number.isInteger(depth) || depth < 1 || depth > 32) {
      throw new LochError("INVALID_ARGUMENT", "tree depth must be an integer from 1 to 32");
    }
    const values = [0n];
    for (let i = 0; i < depth; i++) values.push(poseidon2([values[i]!, values[i]!]));
    zeros = Object.freeze(values);
    zeroCache.set(depth, zeros);
  }
  return zeros;
}

/** Recomputes the root from a leaf and its path, the way the circuit does. */
export function merkleRootFromPath(leaf: bigint, index: number | bigint, pathElements: readonly bigint[]): bigint {
  let node = leaf;
  let position = BigInt(index);
  for (const sibling of pathElements) {
    node = (position & 1n) === 0n ? poseidon2([node, sibling]) : poseidon2([sibling, node]);
    position >>= 1n;
  }
  return node;
}

/** Local copy of the pool's commitment tree. Holds every leaf, so any leaf's path can be produced. */
export class MerkleTree {
  /** Number of levels below the root. */
  readonly depth: number;
  private readonly zeros: readonly bigint[];
  /** layers[0] holds the leaves, layers[depth] the root. Dense on the left, missing = zero subtree. */
  private readonly layers: bigint[][];

  constructor(depth: number = TREE_DEPTH) {
    this.zeros = zeroValues(depth);
    this.depth = depth;
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }

  /** Builds a tree from leaves in index order. */
  static fromLeaves(leaves: Iterable<bigint>, depth: number = TREE_DEPTH): MerkleTree {
    const tree = new MerkleTree(depth);
    tree.append([...leaves]);
    return tree;
  }

  /** Restores a tree from {@link MerkleTree.toJSON}. Rehashes every node. */
  static fromJSON(json: MerkleTreeJSON): MerkleTree {
    if (typeof json !== "object" || json === null || !Array.isArray(json.leaves)) {
      throw new LochError("INVALID_ARGUMENT", "not a serialised Merkle tree");
    }
    return MerkleTree.fromLeaves(json.leaves.map(parseNode), json.depth);
  }

  /**
   * Restores a tree from {@link MerkleTree.toSnapshot} without hashing. The
   * shape is validated, the node values are not: a corrupted snapshot gives a
   * wrong root, which sync reports as a mismatch.
   */
  static fromSnapshot(snapshot: MerkleTreeSnapshot): MerkleTree {
    if (typeof snapshot !== "object" || snapshot === null || !Array.isArray(snapshot.layers)) {
      throw new LochError("INVALID_ARGUMENT", "not a Merkle tree snapshot");
    }
    const tree = new MerkleTree(snapshot.depth);
    if (snapshot.layers.length !== tree.depth + 1) {
      throw new LochError("INVALID_ARGUMENT", "Merkle tree snapshot has the wrong number of layers");
    }
    let expected = Array.isArray(snapshot.layers[0]) ? snapshot.layers[0].length : -1;
    if (expected > 2 ** tree.depth) throw new LochError("INVALID_ARGUMENT", "Merkle tree snapshot has too many leaves");
    snapshot.layers.forEach((layer, level) => {
      if (!Array.isArray(layer) || layer.length !== expected) {
        throw new LochError("INVALID_ARGUMENT", "Merkle tree snapshot has an inconsistent shape");
      }
      tree.layers[level] = layer.map(parseNode);
      expected = Math.ceil(expected / 2);
    });
    return tree;
  }

  /**
   * An independent copy: same leaves, same root, no hashing. Changes to one
   * tree never show in the other. Copies every node reference, so it costs
   * memory and time proportional to the number of leaves, but far less than
   * rebuilding the tree.
   */
  clone(): MerkleTree {
    const copy = new MerkleTree(this.depth);
    this.layers.forEach((layer, level) => {
      copy.layers[level] = layer.slice();
    });
    return copy;
  }

  /** Number of leaves, which is also the index the next leaf gets. */
  get size(): number {
    return this.layers[0]!.length;
  }

  /** Leaves the tree can hold: `2^depth`. */
  get capacity(): number {
    return 2 ** this.depth;
  }

  /** Current root. For an empty tree, the documented empty root. */
  get root(): bigint {
    return this.layers[this.depth]![0] ?? this.zeros[this.depth]!;
  }

  /** All leaves in index order. Do not mutate. */
  get leaves(): readonly bigint[] {
    return this.layers[0]!;
  }

  /** Appends one leaf and returns its index. */
  insert(leaf: bigint): number {
    const index = this.size;
    this.append([leaf]);
    return index;
  }

  /**
   * Appends leaves in order and returns the index of the first one. Much
   * cheaper than repeated {@link insert}: shared ancestors are hashed once.
   *
   * @throws LochError `INVALID_ARGUMENT` if a leaf is not a field element or
   *   the tree would overflow. Nothing is appended in that case.
   */
  append(leaves: readonly bigint[]): number {
    const start = this.size;
    if (leaves.length === 0) return start;
    if (start + leaves.length > this.capacity) throw new LochError("INVALID_ARGUMENT", "the Merkle tree is full");
    for (const leaf of leaves) {
      if (typeof leaf !== "bigint" || leaf < 0n || leaf >= FIELD_MODULUS) {
        throw new LochError("INVALID_ARGUMENT", "a Merkle leaf must be a field element");
      }
    }
    const bottom = this.layers[0]!;
    for (const leaf of leaves) bottom.push(leaf);

    let first = start;
    let last = start + leaves.length - 1;
    for (let level = 0; level < this.depth; level++) {
      const layer = this.layers[level]!;
      const above = this.layers[level + 1]!;
      for (let parent = first >> 1; parent <= last >> 1; parent++) {
        above[parent] = poseidon2([layer[2 * parent]!, layer[2 * parent + 1] ?? this.zeros[level]!]);
      }
      first >>= 1;
      last >>= 1;
    }
    return start;
  }

  /**
   * Drops every leaf from index `size` on, restoring the tree to an earlier
   * state (after a failed sync or a fork). About `depth` hashes.
   *
   * @throws LochError `INVALID_ARGUMENT` if `size` is not between 0 and the current size.
   */
  truncate(size: number): void {
    if (!Number.isInteger(size) || size < 0 || size > this.size) {
      throw new LochError("INVALID_ARGUMENT", "cannot truncate to a size outside the tree");
    }
    if (size === this.size) return;
    let count = size;
    for (let level = 0; level <= this.depth; level++) {
      this.layers[level]!.length = count;
      count = Math.ceil(count / 2);
    }
    // Nodes on the right edge may have lost their right child.
    let last = size - 1;
    for (let level = 0; level < this.depth && size > 0; level++) {
      const layer = this.layers[level]!;
      const parent = last >> 1;
      this.layers[level + 1]![parent] = poseidon2([layer[2 * parent]!, layer[2 * parent + 1] ?? this.zeros[level]!]);
      last = parent;
    }
  }

  /** Index of the first leaf equal to `leaf`, or -1. Linear scan. */
  indexOf(leaf: bigint): number {
    return this.layers[0]!.indexOf(leaf);
  }

  /**
   * Sibling path of leaf `index` against the current root.
   *
   * @throws LochError `INVALID_ARGUMENT` if there is no such leaf.
   */
  path(index: number): MerklePath {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new LochError("INVALID_ARGUMENT", "no leaf at that index");
    }
    const pathElements: bigint[] = [];
    let position = index;
    for (let level = 0; level < this.depth; level++) {
      pathElements.push(this.layers[level]![position ^ 1] ?? this.zeros[level]!);
      position >>= 1;
    }
    return { pathElements, pathIndices: BigInt(index) };
  }

  /** Leaves only; `JSON.stringify(tree)` uses this. */
  toJSON(): MerkleTreeJSON {
    return { depth: this.depth, leaves: this.layers[0]!.map(String) };
  }

  /** Every node, for {@link MerkleTree.fromSnapshot}. About twice the size of {@link toJSON}. */
  toSnapshot(): MerkleTreeSnapshot {
    return { depth: this.depth, layers: this.layers.map((layer) => layer.map(String)) };
  }
}

function parseNode(text: unknown): bigint {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new LochError("INVALID_ARGUMENT", "a Merkle node must be a decimal string");
  }
  const value = BigInt(text);
  if (value >= FIELD_MODULUS) throw new LochError("INVALID_ARGUMENT", "a Merkle node must be a field element");
  return value;
}
