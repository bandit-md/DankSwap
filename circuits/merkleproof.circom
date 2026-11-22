pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// Computes the root of a binary Poseidon Merkle tree from a leaf, its path
// elements (siblings, bottom-up) and its leaf index (spec §3).
// pathIndices is the leaf index as a number; it is decomposed into `levels`
// bits (LSB = bottom level). Bit 0 => current node is the left child.
// Num2Bits(levels) also enforces pathIndices < 2^levels.
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices;
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== pathIndices;

    component hashers[levels];
    signal left[levels];
    signal right[levels];
    signal cur[levels + 1];
    cur[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // bit is 0/1 (Num2Bits constrains it)
        left[i] <== cur[i] + bits.out[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + bits.out[i] * (cur[i] - pathElements[i]);

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        cur[i + 1] <== hashers[i].out;
    }

    root <== cur[levels];
}
