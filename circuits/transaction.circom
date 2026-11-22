pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "./keypair.circom";
include "./merkleproof.circom";

/*
 * DankSwap Phase 2 shielded pool transaction (spec docs/PHASE2_SPEC.md §4).
 *
 *   commitment = Poseidon(amount, pubKey, blinding, mintField)
 *   signature  = Poseidon(privKey, commitment, pathIndex)
 *   nullifier  = Poseidon(commitment, pathIndex, signature)
 *
 * Public signals, in this exact declaration order (= snarkjs order):
 *   0 root, 1 publicAmount, 2 extDataHash, 3 mintField,
 *   4,5 inputNullifier[2], 6,7 outputCommitment[2],
 *   8 swapMintField, 9 swapAmount, 10 swapCommitment
 *
 * UNAUDITED. Do not use with real funds before an independent audit.
 */
template Transaction(levels, nIns, nOuts) {
    // ---- public (declaration order matters) ----
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input mintField;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];
    signal input swapMintField;
    signal input swapAmount;
    signal input swapCommitment;

    // ---- private ----
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    signal input swapPubkey;
    signal input swapBlinding;

    component inKeypair[nIns];
    component inCommitmentHasher[nIns];
    component inSignature[nIns];
    component inNullifierHasher[nIns];
    component inTree[nIns];
    component inAmountIsZero[nIns];
    component inCheckRoot[nIns];
    component inAmountCheck[nIns];

    var sumIns = 0;

    // 1. Inputs
    for (var tx = 0; tx < nIns; tx++) {
        inKeypair[tx] = Keypair();
        inKeypair[tx].privateKey <== inPrivateKey[tx];

        inCommitmentHasher[tx] = Poseidon(4);
        inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
        inCommitmentHasher[tx].inputs[1] <== inKeypair[tx].publicKey;
        inCommitmentHasher[tx].inputs[2] <== inBlinding[tx];
        inCommitmentHasher[tx].inputs[3] <== mintField;

        inSignature[tx] = Signature();
        inSignature[tx].privateKey <== inPrivateKey[tx];
        inSignature[tx].commitment <== inCommitmentHasher[tx].out;
        inSignature[tx].merklePath <== inPathIndices[tx];

        inNullifierHasher[tx] = Poseidon(3);
        inNullifierHasher[tx].inputs[0] <== inCommitmentHasher[tx].out;
        inNullifierHasher[tx].inputs[1] <== inPathIndices[tx];
        inNullifierHasher[tx].inputs[2] <== inSignature[tx].out;
        inNullifierHasher[tx].out === inputNullifier[tx];

        inTree[tx] = MerkleProof(levels);
        inTree[tx].leaf <== inCommitmentHasher[tx].out;
        inTree[tx].pathIndices <== inPathIndices[tx];
        for (var i = 0; i < levels; i++) {
            inTree[tx].pathElements[i] <== inPathElements[tx][i];
        }

        // Root is checked only for non-zero inputs (dummy inputs allowed).
        inAmountIsZero[tx] = IsZero();
        inAmountIsZero[tx].in <== inAmount[tx];
        inCheckRoot[tx] = ForceEqualIfEnabled();
        inCheckRoot[tx].in[0] <== root;
        inCheckRoot[tx].in[1] <== inTree[tx].root;
        inCheckRoot[tx].enabled <== 1 - inAmountIsZero[tx].out;

        // 64-bit range check on input amounts
        inAmountCheck[tx] = Num2Bits(64);
        inAmountCheck[tx].in <== inAmount[tx];

        sumIns += inAmount[tx];
    }

    // 2. Outputs
    component outCommitmentHasher[nOuts];
    component outAmountCheck[nOuts];
    var sumOuts = 0;

    for (var tx = 0; tx < nOuts; tx++) {
        outCommitmentHasher[tx] = Poseidon(4);
        outCommitmentHasher[tx].inputs[0] <== outAmount[tx];
        outCommitmentHasher[tx].inputs[1] <== outPubkey[tx];
        outCommitmentHasher[tx].inputs[2] <== outBlinding[tx];
        outCommitmentHasher[tx].inputs[3] <== mintField;
        outCommitmentHasher[tx].out === outputCommitment[tx];

        outAmountCheck[tx] = Num2Bits(64);
        outAmountCheck[tx].in <== outAmount[tx];

        sumOuts += outAmount[tx];
    }

    // 3. Pairwise-distinct input nullifiers
    component sameNullifiers[nIns * (nIns - 1) / 2];
    var index = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifiers[index] = IsEqual();
            sameNullifiers[index].in[0] <== inputNullifier[i];
            sameNullifiers[index].in[1] <== inputNullifier[j];
            sameNullifiers[index].out === 0;
            index++;
        }
    }

    // 4. Balance (field arithmetic)
    sumIns + publicAmount === sumOuts;

    // 5. Swap
    component swapIsZero = IsZero();
    swapIsZero.in <== swapAmount;
    signal swapActive;
    swapActive <== 1 - swapIsZero.out;

    // swapAmount == 0  =>  swapCommitment == 0
    swapCommitment * swapIsZero.out === 0;

    // swapAmount != 0  =>  swapCommitment == Poseidon(swapAmount, swapPubkey, swapBlinding, swapMintField)
    component swapHasher = Poseidon(4);
    swapHasher.inputs[0] <== swapAmount;
    swapHasher.inputs[1] <== swapPubkey;
    swapHasher.inputs[2] <== swapBlinding;
    swapHasher.inputs[3] <== swapMintField;
    component swapCheck = ForceEqualIfEnabled();
    swapCheck.in[0] <== swapCommitment;
    swapCheck.in[1] <== swapHasher.out;
    swapCheck.enabled <== swapActive;

    // swapAmount is 64-bit (trivially true when 0)
    component swapAmountCheck = Num2Bits(64);
    swapAmountCheck.in <== swapAmount;

    // swapAmount != 0  =>  swapMintField != mintField
    component swapSameMint = IsEqual();
    swapSameMint.in[0] <== swapMintField;
    swapSameMint.in[1] <== mintField;
    swapSameMint.out * swapActive === 0;

    // 6. Bind extDataHash (Tornado-style dummy square)
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, publicAmount, extDataHash, mintField, inputNullifier, outputCommitment, swapMintField, swapAmount, swapCommitment]} = Transaction(20, 2, 2);
