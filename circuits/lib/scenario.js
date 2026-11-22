// Deterministic end-to-end scenario on the SOL (wSOL mintField) pool, used by
// the fixture generator and the tests:
//   1. deposit  : Alice shields 1 SOL as two notes (0.7 + 0.3), 2 dummy inputs
//   2. transfer : Alice spends both notes -> Bob 0.6, Alice change 0.395, fee 0.005
//   3. withdraw : Bob spends his 0.6 note -> 0.5 to recipient, fee 0.002, change 0.098
//   4. swap     : Alice spends 0.395 -> 0.3 to swap escrow, fee 0.001, change 0.094,
//                 swap note of 45 USDC (6 dp) in the USDC pool
// All keys/blindings/blobs are derived from labels so the leaves are reproducible
// (the Groth16 proofs themselves are randomized).
import { createHash } from 'node:crypto';
import { P, fromBE, base58Encode, toHex } from './field.js';
import { Keypair, mintField, privKeyFromSeed, WSOL_MINT, USDC_MINT } from './keys.js';
import { Note } from './note.js';
import { MerkleTree } from './merkle.js';
import { buildWitnessInput } from './witness.js';
import { ENC_LEN } from './extdata.js';

const H = (label) => new Uint8Array(createHash('sha256').update('dankswap-fixture:' + label).digest());
export const detField = (label) => fromBE(H(label).slice(0, 31));
export const detPubkey = (label) => base58Encode(H('pk:' + label));
export const detBlob = (label) => {
  const out = new Uint8Array(ENC_LEN);
  for (let i = 0; i * 32 < ENC_LEN; i++) out.set(H(`${label}:${i}`).slice(0, Math.min(32, ENC_LEN - i * 32)), i * 32);
  return toHex(out);
};
const ZERO_BLOB = '00'.repeat(ENC_LEN);

export function buildScenario() {
  const mint = WSOL_MINT;
  const mf = mintField(mint);
  const usdcMf = mintField(USDC_MINT);
  const alice = Keypair.fromSeed(H('alice-seed'));
  const bob = Keypair.fromSeed(H('bob-seed'));
  const wallets = { alice: detPubkey('alice-wallet'), bob: detPubkey('bob-wallet'), relayer: detPubkey('relayer'),
    recipient: detPubkey('withdraw-recipient'), escrow: detPubkey('swap-escrow-placeholder') };
  const dummyIn = (l) => new Note({ amount: 0n, keypair: new Keypair(privKeyFromSeed(H('dummy-in:' + l))), blinding: detField('dummy-in-b:' + l), mintField: mf, index: 0 });
  const tree = new MerkleTree();
  const steps = [];

  const step = (name, flow, args) => {
    const leavesBefore = tree.leaves;
    const w = buildWitnessInput({ tree, mintField: mf, flow, ...args });
    const s = { name, flow, mint, witness: w, extData: args.extData, leavesBefore, root: w.root, swapMint: args.swap ? USDC_MINT : null };
    // program behaviour: append both output commitments
    tree.insertPair(w.outputs[0].commitment, w.outputs[1].commitment);
    w.outputs.forEach((n, i) => { n.index = leavesBefore.length + i; });
    s.leavesAfter = tree.leaves;
    steps.push(s);
    return w;
  };

  // 1. deposit
  const dep = step('deposit', 'deposit', {
    inputs: [dummyIn('d0'), dummyIn('d1')],
    outputs: [
      new Note({ amount: 700_000_000n, keypair: alice, blinding: detField('n0'), mintField: mf }),
      new Note({ amount: 300_000_000n, keypair: alice, blinding: detField('n1'), mintField: mf }),
    ],
    extData: { recipient: wallets.alice, relayer: wallets.alice, extAmount: 1_000_000_000n, fee: 0n,
      encryptedOutput1: detBlob('e0'), encryptedOutput2: detBlob('e1'), encryptedSwapOutput: ZERO_BLOB },
  });

  // 2. private transfer (both real inputs, fee to relayer)
  const tr = step('transfer', 'transfer', {
    inputs: dep.outputs,
    outputs: [
      new Note({ amount: 600_000_000n, pubKey: bob.pubKey, keypair: bob, blinding: detField('n2'), mintField: mf }),
      new Note({ amount: 395_000_000n, keypair: alice, blinding: detField('n3'), mintField: mf }),
    ],
    extData: { recipient: wallets.relayer, relayer: wallets.relayer, extAmount: 0n, fee: 5_000_000n,
      encryptedOutput1: detBlob('e2'), encryptedOutput2: detBlob('e3'), encryptedSwapOutput: ZERO_BLOB },
  });

  // 3. withdraw (Bob)
  step('withdraw', 'withdraw', {
    inputs: [tr.outputs[0], dummyIn('w1')],
    outputs: [
      new Note({ amount: 98_000_000n, keypair: bob, blinding: detField('n4'), mintField: mf }),
      new Note({ amount: 0n, keypair: bob, blinding: detField('n5'), mintField: mf }),
    ],
    extData: { recipient: wallets.recipient, relayer: wallets.relayer, extAmount: -500_000_000n, fee: 2_000_000n,
      encryptedOutput1: detBlob('e4'), encryptedOutput2: detBlob('e5'), encryptedSwapOutput: ZERO_BLOB },
  });

  // 4. private swap SOL -> USDC
  step('swap', 'swap', {
    inputs: [tr.outputs[1], dummyIn('s1')],
    outputs: [
      new Note({ amount: 94_000_000n, keypair: alice, blinding: detField('n6'), mintField: mf }),
      new Note({ amount: 0n, keypair: alice, blinding: detField('n7'), mintField: mf }),
    ],
    swap: { mintField: usdcMf, amount: 45_000_000n, pubKey: alice.pubKey, blinding: detField('swap-b') },
    extData: { recipient: wallets.escrow, relayer: wallets.relayer, extAmount: -300_000_000n, fee: 1_000_000n,
      encryptedOutput1: detBlob('e6'), encryptedOutput2: detBlob('e7'), encryptedSwapOutput: detBlob('e8') },
  });

  return { mint, mintField: mf, usdcMintField: usdcMf, alice, bob, wallets, tree, steps, dummyIn };
}
