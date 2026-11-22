// Re-implements the groth16-solana 0.2 verifier equation on the exact bytes the
// program will see: proofA/B/C + publicInputsHex from fixtures/proofs.json and
// the VK bytes parsed out of programs/dankswap-pool/src/verifying_key.rs.
//   e(proofA, proofB) * e(prepared, gamma) * e(proofC, delta) * e(alpha, beta) == 1
// with prepared = IC[0] + sum(IC[i+1] * input[i]) and proofA already negated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBn128 } from 'ffjavascript';
import { fromBE, fromHex, P } from '../lib/field.js';

let curve;
const proofs = JSON.parse(readFileSync(new URL('../fixtures/proofs.json', import.meta.url), 'utf8'));
const rs = readFileSync(new URL('../../programs/dankswap-pool/src/verifying_key.rs', import.meta.url), 'utf8');

function rustArray(name) {
  const m = new RegExp(`${name}:\\s*\\[([^\\]]*)\\]`).exec(rs);
  return Uint8Array.from(m[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number));
}
function rustIC() {
  const body = /vk_ic:\s*&\[([\s\S]*)\],\s*\};/.exec(rs)[1];
  return [...body.matchAll(/\[([^\]]*)\]/g)].map((m) => Uint8Array.from(m[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number)));
}
const be = (b, i) => fromBE(b.slice(32 * i, 32 * i + 32));
const g1 = (b) => curve.G1.fromObject([be(b, 0), be(b, 1), 1n]);
// bytes: x.c1 x.c0 y.c1 y.c0
const g2 = (b) => curve.G2.fromObject([[be(b, 1), be(b, 0)], [be(b, 3), be(b, 2)], [1n, 0n]]);

before(async () => { curve = await buildBn128(); });
after(async () => { await curve.terminate(); });

async function solanaVerify(p, vk) {
  const inputs = p.publicInputsHex.map(fromHex);
  assert.equal(inputs.length, 11);
  let acc = g1(vk.ic[0]);
  inputs.forEach((inp, i) => {
    assert.ok(fromBE(inp) < P);
    acc = curve.G1.add(acc, curve.G1.timesScalar(g1(vk.ic[i + 1]), inp.slice().reverse())); // timesScalar wants LE
  });
  return await curve.pairingEq(
    g1(fromHex(p.proofA)), g2(fromHex(p.proofB)),
    acc, g2(vk.gamma),
    g1(fromHex(p.proofC)), g2(vk.delta),
    g1(vk.alpha), g2(vk.beta),
  );
}

test('verifying_key.rs is well-formed for groth16-solana 0.2', () => {
  assert.match(rs, /use groth16_solana::groth16::Groth16Verifyingkey;/);
  assert.match(rs, /pub const VERIFYINGKEY: Groth16Verifyingkey = Groth16Verifyingkey \{/);
  assert.match(rs, /nr_pubinputs: 11,/);
  assert.equal(rustArray('vk_alpha_g1').length, 64);
  for (const n of ['vk_beta_g2', 'vk_gamme_g2', 'vk_delta_g2']) assert.equal(rustArray(n).length, 128);
  const ic = rustIC();
  assert.equal(ic.length, 12);
  for (const p of ic) assert.equal(p.length, 64);
});

test('fixture proofs pass the groth16-solana pairing equation with verifying_key.rs bytes', async () => {
  const vk = { alpha: rustArray('vk_alpha_g1'), beta: rustArray('vk_beta_g2'), gamma: rustArray('vk_gamme_g2'),
    delta: rustArray('vk_delta_g2'), ic: rustIC() };
  assert.equal(proofs.proofs.length, 4);
  for (const p of proofs.proofs) {
    assert.equal(await solanaVerify(p, vk), true, p.name);
    // a non-negated proofA must fail (guards against double/no negation)
    const a = fromHex(p.proofA);
    const y = fromBE(a.slice(32));
    const q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
    const flipped = Buffer.from(a); Buffer.from((q - y).toString(16).padStart(64, '0'), 'hex').copy(flipped, 32);
    assert.equal(await solanaVerify({ ...p, proofA: flipped.toString('hex') }, vk), false, p.name + ' un-negated');
    // wrong public input must fail
    const bad = [...p.publicInputsHex]; bad[2] = '00'.repeat(31) + '01';
    assert.equal(await solanaVerify({ ...p, publicInputsHex: bad }, vk), false, p.name + ' bad input');
  }
});
