// Assemble Transaction(20, 2, 2) circuit inputs (spec §4) for deposit / transfer /
// withdraw / swap, including dummy inputs (amount 0, random key and blinding)
// and dummy outputs (amount 0).
import { P, mod } from './field.js';
import { Keypair } from './keys.js';
import { Note, randomBlinding, commitmentHash } from './note.js';
import { extDataHash } from './extdata.js';
import { publicAmount as calcPublicAmount } from './encode.js';
import { DEPTH } from './merkle.js';

export const N_INS = 2;
export const N_OUTS = 2;

const randomField = () => mod(randomBlinding() * 2n ** 8n + randomBlinding()); // ~2^256 mod p

/** A fresh zero-amount input note owned by a random throwaway key. */
export const dummyInput = (mintField) =>
  new Note({ amount: 0n, keypair: new Keypair(randomField()), mintField, index: 0 });

/** A zero-amount output note (to the given pubkey, or a random one). */
export const dummyOutput = (mintField, pubKey) =>
  new Note({ amount: 0n, pubKey: pubKey ?? new Keypair(randomField()).pubKey, mintField });

/**
 * @param {object} o
 * @param {import('./merkle.js').MerkleTree} o.tree   tree the real inputs live in (its current root is used)
 * @param {bigint} o.mintField                          pool mint field
 * @param {Note[]} [o.inputs]                           0..2 spendable notes (with keypair and index)
 * @param {Note[]} [o.outputs]                          0..2 output notes
 * @param {object} o.extData                            §5 extData (recipient, relayer, extAmount, fee, blobs)
 * @param {{mintField: bigint, amount: bigint, pubKey: bigint, blinding?: bigint}} [o.swap]
 * @param {'deposit'|'transfer'|'withdraw'|'swap'} [o.flow]  optional sanity check of extData shape
 * @param {boolean} [o.unchecked]                       skip JS-side balance/sanity checks (negative tests)
 * @param {bigint} [o.root]                             override root (negative tests)
 * @returns {{ input: object, publicSignals: string[], inputs: Note[], outputs: Note[],
 *             swapNote: Note|null, extDataHash: bigint, root: bigint, publicAmount: bigint }}
 */
export function buildWitnessInput(o) {
  const { tree, mintField, extData, swap = null, flow, unchecked = false } = o;
  const mf = BigInt(mintField);
  const inputs = [...(o.inputs || [])];
  const outputs = [...(o.outputs || [])];
  if (inputs.length > N_INS || outputs.length > N_OUTS) throw new Error('too many inputs/outputs');
  while (inputs.length < N_INS) inputs.push(dummyInput(mf));
  while (outputs.length < N_OUTS) outputs.push(dummyOutput(mf));

  const extAmount = BigInt(extData.extAmount);
  const fee = BigInt(extData.fee);
  const swapAmount = swap ? BigInt(swap.amount) : 0n;

  if (!unchecked) {
    for (const n of [...inputs, ...outputs]) if (n.mintField !== mf) throw new Error('note mint != pool mint');
    const sumIn = inputs.reduce((s, n) => s + n.amount, 0n);
    const sumOut = outputs.reduce((s, n) => s + n.amount, 0n);
    if (sumIn + extAmount - fee !== sumOut) throw new Error(`unbalanced: in ${sumIn} + ext ${extAmount} - fee ${fee} != out ${sumOut}`);
    if (flow === 'deposit' && !(extAmount > 0n && fee === 0n)) throw new Error('deposit needs extAmount > 0, fee 0');
    if (flow === 'transfer' && extAmount !== 0n) throw new Error('transfer needs extAmount 0');
    if (flow === 'withdraw' && !(extAmount < 0n)) throw new Error('withdraw needs extAmount < 0');
    if (flow === 'swap' && !(extAmount < 0n && swapAmount > 0n)) throw new Error('swap needs extAmount < 0 and swapAmount > 0');
    if (swap && BigInt(swap.mintField) === mf) throw new Error('swap mint must differ from pool mint');
    if (swapAmount >= 1n << 64n) throw new Error('swapAmount must be u64');
  }

  const root = o.root !== undefined ? BigInt(o.root) : tree.root();
  const inPathElements = [];
  const inPathIndices = [];
  for (const n of inputs) {
    if (n.amount === 0n && (n.index === null || n.index >= tree.nextIndex || tree.layers[0][n.index] !== n.commitment)) {
      // dummy input: path is not checked by the circuit
      inPathElements.push(new Array(tree.depth ?? DEPTH).fill(0n));
      inPathIndices.push(BigInt(n.index ?? 0));
    } else {
      if (n.index === null) throw new Error('input note has no index');
      const p = tree.path(n.index);
      inPathElements.push(p.pathElements);
      inPathIndices.push(BigInt(n.index));
    }
  }

  const ext = { ...extData, encryptedSwapOutput: extData.encryptedSwapOutput ?? null };
  const edh = extDataHash(ext).value;
  const pubAmount = calcPublicAmount(extAmount, fee);

  let swapNote = null;
  let swapCommitment = 0n;
  if (swap) {
    swapNote = new Note({ amount: swapAmount, pubKey: swap.pubKey, blinding: swap.blinding, mintField: swap.mintField });
    swapCommitment = swap.commitment !== undefined ? BigInt(swap.commitment) : swapNote.commitment;
  }

  const nullifiers = inputs.map((n, i) => n.nullifier(Number(inPathIndices[i])));
  const commitments = outputs.map((n) => commitmentHash(n.amount, n.pubKey, n.blinding, n.mintField));

  const S = (x) => BigInt(x).toString();
  const input = {
    root: S(root),
    publicAmount: S(pubAmount),
    extDataHash: S(edh),
    mintField: S(mf),
    inputNullifier: nullifiers.map(S),
    outputCommitment: commitments.map(S),
    swapMintField: S(swap ? swap.mintField : 0n),
    swapAmount: S(swapAmount),
    swapCommitment: S(swapCommitment),
    inAmount: inputs.map((n) => S(n.amount)),
    inPrivateKey: inputs.map((n) => S(n.keypair.privKey)),
    inBlinding: inputs.map((n) => S(n.blinding)),
    inPathIndices: inPathIndices.map(S),
    inPathElements: inPathElements.map((pe) => pe.map(S)),
    outAmount: outputs.map((n) => S(n.amount)),
    outPubkey: outputs.map((n) => S(n.pubKey)),
    outBlinding: outputs.map((n) => S(n.blinding)),
    swapPubkey: S(swap ? swap.pubKey : 0n),
    swapBlinding: S(swap ? (swapNote.blinding) : 0n),
  };
  const publicSignals = [
    input.root, input.publicAmount, input.extDataHash, input.mintField,
    ...input.inputNullifier, ...input.outputCommitment,
    input.swapMintField, input.swapAmount, input.swapCommitment,
  ];
  for (const s of publicSignals) if (BigInt(s) >= P) throw new Error('public signal >= p');
  return { input, publicSignals, inputs, outputs, swapNote, extDataHash: edh, root, publicAmount: pubAmount };
}
