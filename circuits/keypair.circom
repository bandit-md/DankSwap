pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

// pubKey = Poseidon(privKey)  (spec §2)
template Keypair() {
    signal input privateKey;
    signal output publicKey;

    component hasher = Poseidon(1);
    hasher.inputs[0] <== privateKey;
    publicKey <== hasher.out;
}

// signature = Poseidon(privKey, commitment, pathIndex)  (spec §2)
template Signature() {
    signal input privateKey;
    signal input commitment;
    signal input merklePath;
    signal output out;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== privateKey;
    hasher.inputs[1] <== commitment;
    hasher.inputs[2] <== merklePath;
    out <== hasher.out;
}
