// Build Transaction(20, 2, 2) circuit inputs and the matching extData (docs/PHASE2_SPEC.md §4, §5).
// Pure: no network. client.js adds coin selection, proving and submission on top.
import { poseidon } from '../../vendor/poseidon.bundle.js';
import { Note, encryptToRandom, randomBlinding } from './note.js';
import { extDataHash, publicAmount, ZERO_ENCRYPTED_OUTPUT } from './encode.js';
import { dummyPath, rootFromPath } from './merkle.js';
import { FIELD_SIZE, bytesToBigInt, fieldToBytes, randomBytes } from './util.js';

export const N_INS = 2;
export const N_OUTS = 2;

/** Zero-amount input owned by a random throwaway key (the circuit skips its Merkle check). */
export function dummyInput(mintFieldValue) {
  const privKey = bytesToBigInt(randomBytes(32)) % FIELD_SIZE;
  return new Note({ amount: 0n, pubKey: poseidon([privKey]), privKey, mintFieldValue, index: 0 });
}

/** Zero-amount output to a random key; its encrypted output goes to a random key too (§6). */
export function dummyOutput(mintFieldValue) {
  const privKey = bytesToBigInt(randomBytes(32)) % FIELD_SIZE;
  return new Note({ amount: 0n, pubKey: poseidon([privKey]), mintFieldValue });
}

/**
 * @param {object} o
 * @param {import('./merkle.js').MerkleTree} o.tree  pool tree; its current root is proven against
 * @param {bigint} o.mintField
 * @param {Note[]} o.inputs    0-2 spendable notes (privKey + index)
 * @param {Note[]} o.outputs   0-2 output notes (encPublic set for real recipients)
 * @param {{recipient, relayer, extAmount, fee}} o.extData  addresses as base58 strings
 * @param {{mintField, amount, pubKey, encPublic, blinding?}} [o.swap]
 * @returns {Promise<{ input, publicSignals: string[], extData, inputs, outputs, swapNote, nullifiers: bigint[],
 *   commitments: bigint[], root: bigint, extDataHash: bigint, publicAmount: bigint }>}
 */
export async function buildTransaction(o) {
  const mf = BigInt(o.mintField);
  const inputs = [...(o.inputs || [])];
  const outputs = [...(o.outputs || [])];
  if (inputs.length > N_INS || outputs.length > N_OUTS) throw new Error('At most 2 inputs and 2 outputs');
  while (inputs.length < N_INS) inputs.push(dummyInput(mf));
  while (outputs.length < N_OUTS) outputs.push(dummyOutput(mf));

  const extAmount = BigInt(o.extData.extAmount);
  const fee = BigInt(o.extData.fee);
  const sumIn = inputs.reduce((s, n) => s + n.amount, 0n);
  const sumOut = outputs.reduce((s, n) => s + n.amount, 0n);
  if (sumIn + extAmount - fee !== sumOut) throw new Error('Transaction does not balance');
  for (const n of [...inputs, ...outputs]) if (n.mintField !== mf) throw new Error('Note belongs to another pool');

  const root = o.tree.root();
  const inPathElements = [];
  const inPathIndices = [];
  for (const n of inputs) {
    if (n.amount === 0n) {
      const d = dummyPath(o.tree.levels);
      inPathElements.push(d.pathElements);
      inPathIndices.push(BigInt(n.index ?? 0));
      continue;
    }
    if (n.index === null || n.index === undefined) throw new Error('Input note is not in the tree yet');
    const p = o.tree.path(n.index);
    if (rootFromPath(n.commitment, p.pathElements, n.index) !== root) throw new Error('Input note does not match the tree');
    inPathElements.push(p.pathElements);
    inPathIndices.push(BigInt(n.index));
  }

  let swapNote = null;
  if (o.swap) {
    swapNote = new Note({ amount: o.swap.amount, pubKey: o.swap.pubKey, blinding: o.swap.blinding ?? randomBlinding(), mintFieldValue: o.swap.mintField, encPublic: o.swap.encPublic });
    if (swapNote.amount === 0n) throw new Error('Swap amount must be positive');
    if (swapNote.mintField === mf) throw new Error('Swap output mint must differ from the pool mint');
  }

  const extData = {
    recipient: String(o.extData.recipient),
    relayer: String(o.extData.relayer),
    extAmount,
    fee,
    encryptedOutput1: outputs[0].encrypt(),
    encryptedOutput2: outputs[1].encrypt(),
    encryptedSwapOutput: swapNote ? (swapNote.encPublic ? swapNote.encrypt() : encryptToRandom(swapNote.amount, swapNote.blinding)) : ZERO_ENCRYPTED_OUTPUT,
  };
  const edh = await extDataHash(extData);
  const pubAmount = publicAmount(extAmount, fee);
  const nullifiers = inputs.map((n, i) => n.nullifier(Number(inPathIndices[i])));
  if (nullifiers[0] === nullifiers[1]) throw new Error('Inputs must be different notes');
  const commitments = outputs.map((n) => n.commitment);

  const S = (x) => BigInt(x).toString();
  const input = {
    root: S(root),
    publicAmount: S(pubAmount),
    extDataHash: S(edh),
    mintField: S(mf),
    inputNullifier: nullifiers.map(S),
    outputCommitment: commitments.map(S),
    swapMintField: S(swapNote ? swapNote.mintField : 0n),
    swapAmount: S(swapNote ? swapNote.amount : 0n),
    swapCommitment: S(swapNote ? swapNote.commitment : 0n),
    inAmount: inputs.map((n) => S(n.amount)),
    inPrivateKey: inputs.map((n) => S(n.privKey)),
    inBlinding: inputs.map((n) => S(n.blinding)),
    inPathIndices: inPathIndices.map(S),
    inPathElements: inPathElements.map((pe) => pe.map(S)),
    outAmount: outputs.map((n) => S(n.amount)),
    outPubkey: outputs.map((n) => S(n.pubKey)),
    outBlinding: outputs.map((n) => S(n.blinding)),
    swapPubkey: S(swapNote ? swapNote.pubKey : 0n),
    swapBlinding: S(swapNote ? swapNote.blinding : 0n),
  };
  const publicSignals = [
    input.root, input.publicAmount, input.extDataHash, input.mintField,
    ...input.inputNullifier, ...input.outputCommitment,
    input.swapMintField, input.swapAmount, input.swapCommitment,
  ];
  return { input, publicSignals, extData, inputs, outputs, swapNote, nullifiers, commitments, root, extDataHash: edh, publicAmount: pubAmount };
}

/** Instruction args (bytes) from a built transaction and its encoded proof. */
export function instructionArgs(tx, encodedProof) {
  return {
    ...encodedProof,
    root: fieldToBytes(tx.root),
    inputNullifiers: tx.nullifiers.map(fieldToBytes),
    outputCommitments: tx.commitments.map(fieldToBytes),
    extAmount: tx.extData.extAmount,
    fee: tx.extData.fee,
    encryptedOutput1: tx.extData.encryptedOutput1,
    encryptedOutput2: tx.extData.encryptedOutput2,
    ...(tx.swapNote ? {
      swapMintField: fieldToBytes(tx.swapNote.mintField),
      swapAmount: tx.swapNote.amount,
      swapCommitment: fieldToBytes(tx.swapNote.commitment),
      encryptedSwapOutput: tx.extData.encryptedSwapOutput,
    } : {}),
  };
}

/** Check that snarkjs's public signals are exactly what we built (guards against a stale circuit). */
export function checkPublicSignals(tx, publicSignals) {
  if (publicSignals.length !== tx.publicSignals.length) throw new Error('Unexpected number of public signals');
  for (let i = 0; i < publicSignals.length; i++) {
    if (BigInt(publicSignals[i]) !== BigInt(tx.publicSignals[i])) throw new Error(`Public signal ${i} does not match`);
  }
}
