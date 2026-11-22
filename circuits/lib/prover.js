// snarkjs proving / verification helpers (Node).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pick = (...c) => c.find((p) => existsSync(p)) ?? c[0];
export const WASM = pick(join(root, 'build', 'transaction_js', 'transaction.wasm'), resolve(root, '..', 'assets', 'zk', 'transaction.wasm'));
export const ZKEY = pick(join(root, 'build', 'transaction_final.zkey'), resolve(root, '..', 'assets', 'zk', 'transaction_final.zkey'));
export const VK = pick(join(root, 'build', 'verification_key.json'), resolve(root, '..', 'assets', 'zk', 'verification_key.json'));

export const loadVk = (p = VK) => JSON.parse(readFileSync(p, 'utf8'));

export async function prove(input, { wasm = WASM, zkey = ZKEY } = {}) {
  return snarkjs.groth16.fullProve(input, wasm, zkey);
}

export async function verify(publicSignals, proof, vk = loadVk()) {
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

/** Witness generation only (throws on a failed constraint assert). */
export async function calculateWitness(input, wasm = WASM) {
  const wtns = { type: 'mem' };
  await snarkjs.wtns.calculate(input, wasm, wtns);
  return wtns;
}

/** Release snarkjs worker threads so `node` can exit. */
export async function terminate() {
  if (globalThis.curve_bn128) { await globalThis.curve_bn128.terminate(); globalThis.curve_bn128 = null; }
}
