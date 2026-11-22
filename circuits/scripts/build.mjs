#!/usr/bin/env node
// DankSwap Phase 2 circuit build (DEV / UNSAFE trusted setup).
//
//   1. circom compile  -> build/transaction.r1cs, .sym, transaction_js/transaction.wasm
//   2. DEV Powers of Tau (bn128, 2^POT_POWER, default 16) generated locally:
//        new -> contribute (random entropy) -> prepare phase2
//      Cached in build/pot<power>_final.ptau; pass --fresh-ptau to regenerate.
//   3. groth16 setup -> one dev contribution (random entropy) -> beacon
//   4. export verification_key.json
//   5. copy wasm / zkey / vk to ../assets/zk/ and regenerate the Rust verifying key
//
// THE OUTPUT OF THIS SCRIPT IS NOT SAFE FOR REAL FUNDS. Whoever runs it knows
// the toxic waste (single local contributor). See circuits/README.md for the
// production ceremony.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const build = join(root, 'build');
const assets = resolve(root, '..', 'assets', 'zk');
const args = new Set(process.argv.slice(2));
const POWER = Number(process.env.POT_POWER || 16);

const snarkjsCli = join(root, 'node_modules', 'snarkjs', 'build', 'cli.cjs');
const circomBin = join(root, 'node_modules', 'circom2', 'cli.js');

function run(cmd, argv, opts = {}) {
  const t0 = Date.now();
  console.log(`\n$ ${[cmd, ...argv].map((a) => (a.length > 80 ? a.slice(0, 16) + '…' : a)).join(' ')}`);
  const r = spawnSync(cmd, argv, { cwd: root, stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (r.status !== 0) {
    if (opts.capture) process.stderr.write((r.stdout || '') + (r.stderr || ''));
    throw new Error(`command failed (${r.status}): ${cmd} ${argv[0]}`);
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return r.stdout;
}
const snark = (...a) => run(process.execPath, [snarkjsCli, ...a]);
const entropy = () => randomBytes(64).toString('hex');

mkdirSync(build, { recursive: true });
mkdirSync(assets, { recursive: true });

console.log('================================================================');
console.log(' DankSwap circuits build: DEV trusted setup, UNSAFE FOR REAL FUNDS');
console.log('================================================================');

// 1. compile
if (!args.has('--skip-compile')) {
  const out = run(process.execPath, [circomBin, 'transaction.circom', '--r1cs', '--wasm', '--sym', '--O2', '-o', 'build'], { capture: true });
  process.stdout.write(out);
}
const r1cs = join(build, 'transaction.r1cs');
const info = run(process.execPath, [snarkjsCli, 'r1cs', 'info', r1cs], { capture: true });
process.stdout.write(info);
const nConstraints = Number((/# of Constraints:\s*(\d+)/.exec(info) || [])[1]);
const nPub = Number((/# of Public Inputs:\s*(\d+)/.exec(info) || [])[1]);
const minPower = Math.ceil(Math.log2(nConstraints + nPub + 1));
console.log(`constraints: ${nConstraints}, public inputs: ${nPub}, minimum ptau power: ${minPower}, using: ${POWER}`);
if (POWER < minPower) throw new Error(`POT_POWER=${POWER} too small; need >= ${minPower}`);

// 2. DEV powers of tau
const ptauFinal = join(build, `pot${POWER}_final.ptau`);
if (args.has('--fresh-ptau') || !existsSync(ptauFinal)) {
  const p0 = join(build, `pot${POWER}_0000.ptau`);
  const p1 = join(build, `pot${POWER}_0001.ptau`);
  snark('powersoftau', 'new', 'bn128', String(POWER), p0);
  snark('powersoftau', 'contribute', p0, p1, '--name=DankSwap DEV ptau (UNSAFE)', `-e=${entropy()}`);
  snark('powersoftau', 'prepare', 'phase2', p1, ptauFinal);
} else {
  console.log(`\nreusing cached ${ptauFinal}`);
}

// 3. groth16 phase 2 (single dev contributor + beacon)
const z0 = join(build, 'transaction_0000.zkey');
const z1 = join(build, 'transaction_0001.zkey');
const zFinal = join(build, 'transaction_final.zkey');
snark('groth16', 'setup', r1cs, ptauFinal, z0);
snark('zkey', 'contribute', z0, z1, '--name=DankSwap DEV contributor 1 (UNSAFE)', `-e=${entropy()}`);
// Beacon value is random here (a real ceremony uses a pre-announced public beacon, e.g. a future block hash).
snark('zkey', 'beacon', z1, zFinal, randomBytes(32).toString('hex'), '10', '-n=DankSwap DEV final beacon (UNSAFE)');
if (args.has('--verify')) snark('zkey', 'verify', r1cs, ptauFinal, zFinal);

// 4. verification key
const vk = join(build, 'verification_key.json');
snark('zkey', 'export', 'verificationkey', zFinal, vk);
const vkJson = JSON.parse(readFileSync(vk, 'utf8'));
if (vkJson.nPublic !== 11 || vkJson.IC.length !== 12) throw new Error(`unexpected nPublic ${vkJson.nPublic}`);

// 5. copy outputs
const wasm = join(build, 'transaction_js', 'transaction.wasm');
copyFileSync(wasm, join(assets, 'transaction.wasm'));
copyFileSync(zFinal, join(assets, 'transaction_final.zkey'));
copyFileSync(vk, join(assets, 'verification_key.json'));
run(process.execPath, [join(here, 'vk-to-rust.mjs'), vk]);

console.log('\nartifacts:');
for (const f of ['transaction.wasm', 'transaction_final.zkey', 'verification_key.json']) {
  console.log(`  assets/zk/${f}  ${statSync(join(assets, f)).size} bytes`);
}
console.log('\nDONE. Reminder: this is a DEV setup. Do not deploy to mainnet with it.');
