import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as L from '../lib/index.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));

before(async () => { await L.initPoseidon(); });

test('poseidon matches known circomlib vectors', () => {
  assert.equal(L.poseidon([1n, 2n]), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  assert.equal(L.poseidon([1n]), 18586133768512220936620570745912940619677854269274689475585506675881198879027n);
  for (const v of fx('poseidon.json').vectors) assert.equal(L.poseidon(v.inputs.map(BigInt)).toString(), v.output);
});

test('zeros and empty root', () => {
  const z = L.zeros();
  assert.equal(z.length, 21);
  assert.equal(z[0], 0n);
  for (let i = 0; i < 20; i++) assert.equal(z[i + 1], L.poseidon([z[i], z[i]]));
  assert.equal(new L.MerkleTree().root(), z[20]);
  assert.deepEqual(z.map(String), fx('zeros.json').zeros);
});

// naive full recomputation of a depth-d tree
function naiveRoot(leaves, depth) {
  let layer = [...leaves];
  const z = L.zeros(depth);
  for (let lvl = 0; lvl < depth; lvl++) {
    const next = [];
    const n = Math.max(1, Math.ceil(layer.length / 2));
    for (let i = 0; i < n; i++) next.push(L.poseidon([layer[2 * i] ?? z[lvl], layer[2 * i + 1] ?? z[lvl]]));
    layer = next;
  }
  return layer[0];
}

test('incremental Merkle tree equals naive recomputation, paths verify', () => {
  for (const depth of [4, 20]) {
    const t = new L.MerkleTree(depth);
    const leaves = [];
    for (let i = 0; i < 11; i++) {
      const leaf = L.poseidon([BigInt(i), 99n]);
      leaves.push(leaf);
      t.insert(leaf);
      assert.equal(t.root(), naiveRoot(leaves, depth), `depth ${depth} after ${i + 1}`);
    }
    for (let i = 0; i < leaves.length; i++) {
      const p = t.path(i);
      assert.equal(p.pathElements.length, depth);
      assert.equal(L.rootFromPath(leaves[i], p.pathElements, i), t.root());
    }
  }
  const t4 = new L.MerkleTree(2, [1n, 2n, 3n, 4n]);
  assert.throws(() => t4.insert(5n), /full/);
});

test('merkle fixture reproduces', () => {
  const m = fx('merkle.json');
  const t = new L.MerkleTree();
  for (const ins of m.pairInserts) {
    t.insertPair(BigInt(ins.leaves[0]), BigInt(ins.leaves[1]));
    assert.equal(t.root().toString(), ins.rootAfter);
  }
  assert.equal(L.rootFromPath(BigInt(m.path.leaf), m.path.pathElements.map(BigInt), m.path.leafIndex).toString(), m.path.root);
});

test('base58 / mintField', () => {
  for (const m of [L.WSOL_MINT, L.USDC_MINT, L.USDT_MINT, '11111111111111111111111111111111']) {
    const b = L.base58Decode(m);
    assert.equal(b.length, 32);
    assert.equal(L.base58Encode(b), m);
  }
  const b = L.base58Decode(L.USDC_MINT);
  assert.equal(L.toHex(L.toBE32(L.mintField(L.USDC_MINT))), '00' + L.toHex(b.slice(0, 31)));
  assert.equal(L.mintField(L.WSOL_MINT), 0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f000000000n);
  for (const m of fx('mint.json').mints) assert.equal(L.mintField(m.mint).toString(), m.mintField);
});

test('key derivation per spec §2', () => {
  const sig = new Uint8Array(64).fill(7);
  const seed = L.seedFromSignature(sig);
  assert.equal(L.toHex(seed), createHash('sha256').update(sig).digest('hex'));
  const priv = L.privKeyFromSeed(seed);
  const h = BigInt('0x' + createHash('sha256').update(Buffer.concat([seed, Buffer.from([1])])).digest('hex'));
  assert.equal(priv, h % L.P);
  const kp = L.Keypair.fromSeed(seed);
  assert.equal(kp.pubKey, L.poseidon([priv]));
});

test('note commitment / nullifier per spec §2', () => {
  const kp = new L.Keypair(12345n);
  const n = new L.Note({ amount: 5n, keypair: kp, blinding: 77n, mintField: 9n, index: 3 });
  const c = L.poseidon([5n, kp.pubKey, 77n, 9n]);
  assert.equal(n.commitment, c);
  const sig = L.poseidon([12345n, c, 3n]);
  assert.equal(n.nullifier(), L.poseidon([c, 3n, sig]));
  assert.throws(() => new L.Note({ amount: 1n << 64n, keypair: kp, mintField: 1n }));
});

test('extDataHash per spec §5', () => {
  const e = { recipient: L.USDC_MINT, relayer: L.USDT_MINT, extAmount: -5n, fee: 3n,
    encryptedOutput1: 'ab'.repeat(87), encryptedOutput2: 'cd'.repeat(87) };
  const bytes = L.extDataBytes(e);
  assert.equal(bytes.length, 32 + 32 + 8 + 8 + 87 * 3);
  assert.equal(L.toHex(bytes.slice(64, 72)), 'fbffffffffffffff'); // -5 i64 LE
  assert.equal(L.toHex(bytes.slice(72, 80)), '0300000000000000');
  assert.ok(bytes.slice(80 + 174).every((b) => b === 0)); // missing swap blob = zeros
  const d = createHash('sha256').update(bytes).digest();
  d[0] = 0;
  const h = L.extDataHash(e);
  assert.equal(h.hex, d.toString('hex'));
  assert.equal(h.bytes[0], 0);
  assert.ok(h.value < L.P);
  for (const c of fx('extdata.json').cases) {
    const r = L.extDataHash(c.extData);
    assert.equal(r.value.toString(), c.extDataHash);
    assert.equal(r.hex, c.extDataHashHex);
    assert.equal(L.toHex(L.extDataBytes(c.extData)), c.preimageHex);
  }
  assert.throws(() => L.extDataHash({ ...e, extAmount: 1n << 63n }));
  assert.throws(() => L.extDataHash({ ...e, encryptedOutput1: 'ab' }));
});

test('proof / public input encoding per spec §7', () => {
  const proof = {
    pi_a: ['1', '2', '1'],
    pi_b: [['3', '4'], ['5', '6'], ['1', '0']],
    pi_c: ['7', '8', '1'],
  };
  const e = L.encodeProof(proof);
  assert.equal(e.proofA.length, 64);
  assert.equal(e.proofB.length, 128);
  assert.equal(e.proofC.length, 64);
  assert.equal(L.fromBE(e.proofA.slice(0, 32)), 1n);
  assert.equal(L.fromBE(e.proofA.slice(32)), L.Q - 2n);
  assert.deepEqual([0, 1, 2, 3].map((i) => L.fromBE(e.proofB.slice(32 * i, 32 * i + 32))), [4n, 3n, 6n, 5n]);
  assert.deepEqual([L.fromBE(e.proofC.slice(0, 32)), L.fromBE(e.proofC.slice(32))], [7n, 8n]);
  const pi = L.encodePublicInputs(['0', '1', (L.P - 1n).toString()]);
  assert.equal(L.toHex(pi[1]), '00'.repeat(31) + '01');
  assert.throws(() => L.encodePublicInputs([L.P.toString()]));
  assert.equal(L.publicAmount(-10n, 2n), L.P - 12n);
  assert.equal(L.publicAmount(10n, 0n), 10n);
});

test('buildWitnessInput: dummies, balance check, public signal order', () => {
  const mf = L.mintField(L.WSOL_MINT);
  const kp = new L.Keypair(42n);
  const tree = new L.MerkleTree();
  const ext = { recipient: L.USDC_MINT, relayer: L.USDC_MINT, extAmount: 10n, fee: 0n };
  const w = L.buildWitnessInput({ tree, mintField: mf, flow: 'deposit', extData: ext,
    outputs: [new L.Note({ amount: 10n, keypair: kp, mintField: mf })] });
  assert.equal(w.publicSignals.length, 11);
  assert.equal(w.publicSignals[0], tree.root().toString());
  assert.equal(w.publicSignals[1], '10');
  assert.equal(w.publicSignals[3], mf.toString());
  assert.notEqual(w.input.inputNullifier[0], w.input.inputNullifier[1]);
  assert.deepEqual(w.publicSignals.slice(8), ['0', '0', '0']);
  assert.deepEqual(w.input.inAmount, ['0', '0']);
  assert.equal(w.input.outAmount[1], '0');
  assert.throws(() => L.buildWitnessInput({ tree, mintField: mf, extData: { ...ext, extAmount: 11n },
    outputs: [new L.Note({ amount: 10n, keypair: kp, mintField: mf })] }), /unbalanced/);
  assert.throws(() => L.buildWitnessInput({ tree, mintField: mf, flow: 'withdraw', extData: ext,
    outputs: [new L.Note({ amount: 10n, keypair: kp, mintField: mf })] }), /withdraw/);
});
