// Incremental binary Poseidon Merkle tree (spec §3). Depth 20, zero leaf 0.
import { poseidon } from './poseidon.js';

export const DEPTH = 20;

let zerosCache = null;
/** zeros[0] = 0, zeros[i+1] = Poseidon(zeros[i], zeros[i]); returns DEPTH+1 values (zeros[20] = empty root). */
export function zeros(depth = DEPTH) {
  if (!zerosCache || zerosCache.length < depth + 1) {
    const z = [0n];
    for (let i = 0; i < Math.max(depth, DEPTH); i++) z.push(poseidon([z[i], z[i]]));
    zerosCache = z;
  }
  return zerosCache.slice(0, depth + 1);
}

export class MerkleTree {
  constructor(depth = DEPTH, leaves = []) {
    this.depth = depth;
    this.zeros = zeros(depth);
    this.layers = [[]]; // layers[0] = leaves
    for (let i = 1; i <= depth; i++) this.layers.push([]);
    for (const l of leaves) this.insert(l);
  }
  get nextIndex() { return this.layers[0].length; }
  get leaves() { return this.layers[0].slice(); }
  root() {
    return this.layers[this.depth][0] ?? this.zeros[this.depth];
  }
  insert(leaf) {
    if (this.nextIndex >= 2 ** this.depth) throw new Error('tree full');
    let idx = this.nextIndex;
    this.layers[0].push(BigInt(leaf));
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const parent = idx >> 1;
      const left = this.layers[lvl][parent * 2];
      const right = this.layers[lvl][parent * 2 + 1] ?? this.zeros[lvl];
      this.layers[lvl + 1][parent] = poseidon([left, right]);
      idx = parent;
    }
    return this.nextIndex - 1;
  }
  /** Program-style pair insert: two leaves at nextIndex, nextIndex+1. */
  insertPair(a, b) { this.insert(a); this.insert(b); }
  indexOf(leaf) { return this.layers[0].findIndex((x) => x === BigInt(leaf)); }
  /** Path for leaf `index`: { pathElements[depth] (siblings bottom-up), pathIndices (= index), root }. */
  path(index) {
    if (index < 0 || index >= this.nextIndex) throw new Error('index out of range');
    const pathElements = [];
    let idx = index;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const sib = idx ^ 1;
      pathElements.push(this.layers[lvl][sib] ?? this.zeros[lvl]);
      idx >>= 1;
    }
    return { pathElements, pathIndices: index, root: this.root() };
  }
}

/** Recompute a root from a leaf and its path (for tests / clients). */
export function rootFromPath(leaf, pathElements, index) {
  let cur = BigInt(leaf);
  for (let i = 0; i < pathElements.length; i++) {
    cur = (index >> i) & 1 ? poseidon([pathElements[i], cur]) : poseidon([cur, pathElements[i]]);
  }
  return cur;
}
