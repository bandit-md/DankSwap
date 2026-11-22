// End-to-end circuit tests: real Groth16 proofs for all four flows, and
// soundness checks that witness generation (or verification) fails for
// malicious inputs. Requires `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../lib/index.js';
import { buildScenario, detField } from '../lib/scenario.js';
import { prove, verify, calculateWitness, loadVk, terminate } from '../lib/prover.js';

let sc, vk;
const S = (x) => BigInt(x).toString();

before(async () => {
  await L.initPoseidon();
  sc = buildScenario();
  vk = loadVk();
});
after(async () => { await terminate(); });

const stepBy = (name) => sc.steps.find((s) => s.name === name);

async function rejects(input, label) {
  await assert.rejects(calculateWitness(input), /Assert Failed|Error in template|constraint/i, `${label}: witness must fail`);
}

for (const name of ['deposit', 'transfer', 'withdraw', 'swap']) {
  test(`valid ${name} proof verifies`, async () => {
    const st = stepBy(name);
    const t0 = Date.now();
    const { proof, publicSignals } = await prove(st.witness.input);
    const ms = Date.now() - t0;
    assert.deepEqual(publicSignals, st.witness.publicSignals);
    assert.equal(await verify(publicSignals, proof, vk), true);
    // tampering with any public input breaks verification
    for (const i of [0, 1, 2, 3, 4, 7, 10]) {
      const bad = [...publicSignals];
      bad[i] = S((BigInt(bad[i]) + 1n) % L.P);
      assert.equal(await verify(bad, proof, vk), false, `tampered public[${i}]`);
    }
    console.log(`# ${name}: proving ${ms} ms`);
  });
}

test('flow shapes match the spec', () => {
  const [dep, tr, wd, sw] = ['deposit', 'transfer', 'withdraw', 'swap'].map(stepBy);
  assert.deepEqual(dep.witness.input.inAmount, ['0', '0']);
  assert.ok(BigInt(dep.extData.extAmount) > 0n && BigInt(dep.extData.fee) === 0n);
  assert.ok(tr.witness.input.inAmount.every((a) => a !== '0'));
  assert.ok(BigInt(tr.extData.fee) > 0n && BigInt(tr.extData.extAmount) === 0n);
  assert.ok(BigInt(wd.extData.extAmount) < 0n && BigInt(wd.extData.fee) > 0n);
  assert.ok(BigInt(sw.extData.extAmount) < 0n);
  assert.deepEqual(sw.witness.publicSignals.slice(8, 10), [S(sc.usdcMintField), '45000000']);
  assert.notEqual(sw.witness.publicSignals[10], '0');
});

test('dummy zero-amount input skips the root check', async () => {
  const st = stepBy('deposit');
  await calculateWitness({ ...st.witness.input, root: S(12345n) });
});

// ---------------- soundness: these must all fail ----------------

test('inflation: outputs > inputs + publicAmount', async () => {
  const mf = sc.mintField;
  const ext = { recipient: sc.wallets.alice, relayer: sc.wallets.alice, extAmount: 100n, fee: 0n };
  const w = L.buildWitnessInput({ tree: sc.tree, mintField: mf, extData: ext, unchecked: true,
    outputs: [new L.Note({ amount: 101n, keypair: sc.alice, mintField: mf })] });
  await rejects(w.input, 'inflation');
  // also: spend a real note and output more than it holds
  const tr = stepBy('transfer');
  const input = { ...tr.witness.input };
  const outs = tr.witness.outputs;
  const bumped = outs[0].amount + 1n;
  input.outAmount = [S(bumped), input.outAmount[1]];
  input.outputCommitment = [S(L.commitmentHash(bumped, outs[0].pubKey, outs[0].blinding, mf)), input.outputCommitment[1]];
  await rejects(input, 'inflation (transfer)');
});

test('wrong mint in an output note', async () => {
  const mf = sc.mintField;
  const ext = { recipient: sc.wallets.alice, relayer: sc.wallets.alice, extAmount: 100n, fee: 0n };
  const w = L.buildWitnessInput({ tree: sc.tree, mintField: mf, extData: ext, unchecked: true,
    outputs: [new L.Note({ amount: 100n, keypair: sc.alice, mintField: sc.usdcMintField })] });
  await rejects(w.input, 'wrong output mint');
  // and a real input note of a different mint cannot be spent in this pool
  const w2 = L.buildWitnessInput({ tree: sc.tree, mintField: sc.usdcMintField, extData: { ...ext, extAmount: 0n }, unchecked: true,
    root: sc.steps[1].root,
    inputs: [stepBy('deposit').witness.outputs[0]],
    outputs: [new L.Note({ amount: 700_000_000n, keypair: sc.alice, mintField: sc.usdcMintField })] });
  await rejects(w2.input, 'input from another mint');
});

test('same nullifier twice (duplicate input)', async () => {
  const mf = sc.mintField;
  const note = stepBy('deposit').witness.outputs[0]; // index 0, 0.7 SOL
  const tree = new L.MerkleTree(20, stepBy('transfer').leavesBefore);
  const ext = { recipient: sc.wallets.relayer, relayer: sc.wallets.relayer, extAmount: 0n, fee: 0n };
  const w = L.buildWitnessInput({ tree, mintField: mf, extData: ext, unchecked: true,
    inputs: [note, note],
    outputs: [new L.Note({ amount: 2n * note.amount, keypair: sc.alice, mintField: mf })] });
  assert.equal(w.input.inputNullifier[0], w.input.inputNullifier[1]);
  await rejects(w.input, 'duplicate nullifier');
});

test('non-zero input with wrong root', async () => {
  const st = stepBy('transfer');
  await rejects({ ...st.witness.input, root: S(L.zeros()[20]) }, 'wrong root (empty root)');
  await rejects({ ...st.witness.input, root: stepBy('withdraw').witness.input.root }, 'wrong root (later root)');
  // tampered path element
  const pe = st.witness.input.inPathElements.map((a) => [...a]);
  pe[0][0] = S(BigInt(pe[0][0]) + 1n);
  await rejects({ ...st.witness.input, inPathElements: pe }, 'wrong path');
});

test('nullifier must match the note (wrong path index / wrong key)', async () => {
  const st = stepBy('transfer');
  await rejects({ ...st.witness.input, inPathIndices: ['1', st.witness.input.inPathIndices[1]] }, 'wrong index');
  await rejects({ ...st.witness.input, inPrivateKey: [S(sc.bob.privKey), st.witness.input.inPrivateKey[1]] }, 'wrong key');
});

test('swapCommitment not matching swapAmount', async () => {
  const sw = stepBy('swap');
  const i = sw.witness.input;
  // commitment for 45 USDC, but claim a larger swapAmount
  await rejects({ ...i, swapAmount: '46000000' }, 'swapAmount mismatch');
  // commitment computed over a different amount
  const other = L.commitmentHash(44_000_000n, BigInt(i.swapPubkey), BigInt(i.swapBlinding), sc.usdcMintField);
  await rejects({ ...i, swapCommitment: S(other) }, 'swapCommitment mismatch');
  // commitment for the right amount but the pool's own mint
  const same = L.commitmentHash(45_000_000n, BigInt(i.swapPubkey), BigInt(i.swapBlinding), sc.mintField);
  await rejects({ ...i, swapMintField: S(sc.mintField), swapCommitment: S(same) }, 'swapMintField == mintField');
});

test('swapAmount = 0 with non-zero swapCommitment', async () => {
  const wd = stepBy('withdraw');
  await rejects({ ...wd.witness.input, swapCommitment: S(detField('junk')) }, 'zero swap amount, junk commitment');
  const sw = stepBy('swap');
  await rejects({ ...sw.witness.input, swapAmount: '0' }, 'zero swap amount, real commitment');
});

test('65-bit amounts are rejected', async () => {
  const mf = sc.mintField;
  const ext = { recipient: sc.wallets.alice, relayer: sc.wallets.alice, extAmount: 0n, fee: 0n };
  const base = L.buildWitnessInput({ tree: sc.tree, mintField: mf, extData: ext });
  const big = 1n << 64n;
  // output of 2^64 balanced by publicAmount = 2^64 (only the range check can fail)
  const out = base.outputs[0];
  const input = { ...base.input, publicAmount: S(big),
    outAmount: [S(big), base.input.outAmount[1]],
    outputCommitment: [S(L.commitmentHash(big, out.pubKey, out.blinding, mf)), base.input.outputCommitment[1]] };
  await rejects(input, '2^64 output');
  // field-wrap inflation: out0 = 2^64 + 1000, out1 = p - 2^64 (sum = 1000)
  const o1 = base.outputs[1];
  const a0 = big + 1000n, a1 = L.P - big;
  const input2 = { ...base.input, publicAmount: '1000', outAmount: [S(a0), S(a1)],
    outputCommitment: [S(L.commitmentHash(a0, out.pubKey, out.blinding, mf)), S(L.commitmentHash(a1, o1.pubKey, o1.blinding, mf))] };
  await rejects(input2, 'wrapped outputs');
  // 65-bit swap amount
  const sw = stepBy('swap').witness.input;
  const c = L.commitmentHash(big, BigInt(sw.swapPubkey), BigInt(sw.swapBlinding), sc.usdcMintField);
  await rejects({ ...sw, swapAmount: S(big), swapCommitment: S(c) }, '2^64 swap amount');
});

test('JS-side builder rejects bad flows before proving', () => {
  const mf = sc.mintField;
  assert.throws(() => L.buildWitnessInput({ tree: sc.tree, mintField: mf, flow: 'swap',
    extData: { recipient: sc.wallets.escrow, relayer: sc.wallets.relayer, extAmount: -1n, fee: 0n },
    outputs: [], unchecked: false }), /balanced|swap/);
});
