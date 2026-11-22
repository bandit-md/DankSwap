// Incremental binary Poseidon Merkle tree, depth 20 (docs/PHASE2_SPEC.md §3).
// zeros[0] = 0, zeros[i+1] = Poseidon(zeros[i], zeros[i]). Leaves are appended in order.
import { poseidon } from '../../vendor/poseidon.bundle.js';

export const DEFAULT_LEVELS = 20;

const zeroCache = new Map();
/** zeros[0..levels] (zeros[levels] is the root of an empty tree). */
export function zeros(levels = DEFAULT_LEVELS) {
  if (!zeroCache.has(levels)) {
    const z = [0n];
    for (let i = 0; i < levels; i++) z.push(poseidon([z[i], z[i]]));
    zeroCache.set(levels, z);
  }
  return zeroCache.get(levels);
}

export const hashPair = (left, right) => poseidon([BigInt(left), BigInt(right)]);

export class MerkleTree {
  constructor(levels = DEFAULT_LEVELS, leaves = []) {
    this.levels = levels;
    this.capacity = 2 ** levels;
    this.zeros = zeros(levels);
    // layers[0] = leaves, layers[levels] = [root]; missing nodes are zeros[level].
    this.layers = Array.from({ length: levels + 1 }, () => []);
    if (leaves.length) this.bulkInsert(leaves);
  }

  get nextIndex() {
    return this.layers[0].length;
  }

  get leaves() {
    return this.layers[0].slice();
  }

  root() {
    return this.layers[this.levels].length ? this.layers[this.levels][0] : this.zeros[this.levels];
  }

  insert(leaf) {
    this.bulkInsert([leaf]);
  }

  /** Append leaves and recompute only the affected nodes (about one hash per new leaf). */
  bulkInsert(leaves) {
    if (!leaves.length) return;
    if (this.nextIndex + leaves.length > this.capacity) throw new Error('Merkle tree is full');
    let start = this.nextIndex;
    for (const l of leaves) this.layers[0].push(BigInt(l));
    for (let level = 1; level <= this.levels; level++) {
      const below = this.layers[level - 1];
      const layer = this.layers[level];
      const from = start >> 1;
      const to = (below.length - 1) >> 1;
      for (let i = from; i <= to; i++) {
        const left = below[2 * i];
        const right = 2 * i + 1 < below.length ? below[2 * i + 1] : this.zeros[level - 1];
        layer[i] = hashPair(left, right);
      }
      start = from;
    }
  }

  /** Merkle path for the leaf at `index`: pathElements (siblings, bottom-up) and pathIndices (the index). */
  path(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.nextIndex) throw new Error(`Leaf ${index} is not in the tree`);
    const pathElements = [];
    let i = index;
    for (let level = 0; level < this.levels; level++) {
      const sib = i ^ 1;
      const layer = this.layers[level];
      pathElements.push(sib < layer.length ? layer[sib] : this.zeros[level]);
      i >>= 1;
    }
    return { pathElements, pathIndices: index, root: this.root() };
  }

  indexOf(leaf) {
    return this.layers[0].indexOf(BigInt(leaf));
  }
}

/** Recompute a root from a leaf and its path (used to check paths before proving). */
export function rootFromPath(leaf, pathElements, pathIndex) {
  let node = BigInt(leaf);
  let idx = BigInt(pathIndex);
  for (const sib of pathElements) {
    node = (idx & 1n) === 0n ? hashPair(node, sib) : hashPair(sib, node);
    idx >>= 1n;
  }
  return node;
}

/** Tree with zero-path dummy proofs (for zero-amount inputs, the root check is disabled). */
export function dummyPath(levels = DEFAULT_LEVELS) {
  return { pathElements: new Array(levels).fill(0n), pathIndices: 0 };
}
