#!/usr/bin/env node
// Phase 2 (circuit-specific) multi-party trusted setup for the Transaction circuit.
//
// The dev setup made by `npm run build` has ONE contributor and is unsafe for real funds: whoever
// ran it could forge proofs. A production setup needs many independent contributors; it is secure
// as long as at least one of them destroyed their secret. This script runs that ceremony and keeps
// a public transcript (ceremony/transcript.json) so anyone can re-verify every step.
//
//   node scripts/ceremony.mjs init <public.ptau>            coordinator: start from a public Powers of Tau
//   node scripts/ceremony.mjs contribute "<name>"           each participant, one after another
//   node scripts/ceremony.mjs verify                        anyone, any time: checks the whole chain
//   node scripts/ceremony.mjs finalize <beaconHex> "<src>"  coordinator: pre-announced public beacon
//   node scripts/ceremony.mjs install                       copy final zkey/vk into the app + Rust VK
//
// Use a PUBLIC Powers of Tau (e.g. Polygon Hermez powersOfTau28_hez_final_14.ptau or larger, or
// the Perpetual Powers of Tau), checked against its published hash. Do not use build/pot16_*.ptau:
// that is the dev ptau with a single contributor.
//
// Contributors should run `contribute` on their own machine, from a fresh checkout, then delete
// the machine's copy of the entropy (the script never writes it to disk) and publish the printed
// contribution hash themselves (e.g. a signed post), so the transcript can be cross-checked.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as snarkjs from 'snarkjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// CEREMONY_TEST=1 (tests only): allow the dev ptau, skip its slow re-verification, and work in
// CEREMONY_DIR. Never use it for a real ceremony.
const TEST = process.env.CEREMONY_TEST === '1';
const dir = resolve(process.env.CEREMONY_DIR || join(root, 'ceremony'));
const transcriptPath = join(dir, 'transcript.json');
const r1cs = join(root, 'build', 'transaction.r1cs');
const quiet = { info() {}, debug() {}, warn: console.warn, error: console.error };

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const loadT = () => JSON.parse(readFileSync(transcriptPath, 'utf8'));
const saveT = (t) => writeFileSync(transcriptPath, JSON.stringify(t, null, 2) + '\n');
const zkeyName = (i) => `transaction_${String(i).padStart(4, '0')}.zkey`;
const die = (m) => {
  console.error(m);
  process.exit(1);
};

async function init(ptauArg) {
  if (!ptauArg) die('usage: ceremony.mjs init <public.ptau>');
  if (!existsSync(r1cs)) die('Missing build/transaction.r1cs: run `npm run build` first (it compiles the circuit).');
  if (existsSync(transcriptPath)) die('ceremony/ already has a transcript. Move it away to start over.');
  const ptau = resolve(ptauArg);
  if (/pot16_/.test(ptau) && !TEST) die('Refusing the dev ptau (single contributor). Use a public Powers of Tau.');
  mkdirSync(dir, { recursive: true });
  if (!TEST) {
    console.log('Verifying the Powers of Tau file (this takes a while)…');
    if (!(await snarkjs.powersTau.verify(ptau, quiet))) die('Powers of Tau verification failed.');
  }
  const z0 = join(dir, zkeyName(0));
  await snarkjs.zKey.newZKey(r1cs, ptau, z0, quiet);
  const t = {
    circuit: 'Transaction(20, 2, 2)',
    ...(TEST ? { TEST_ONLY_NOT_FOR_REAL_FUNDS: true } : {}),
    r1csSha256: sha256File(r1cs),
    ptau: { file: ptau.split('/').pop(), sha256: sha256File(ptau) },
    steps: [{ n: 0, file: zkeyName(0), sha256: sha256File(z0), by: 'initial (no contribution)' }],
  };
  saveT(t);
  console.log(`Ceremony started: ${z0}\nPublish ceremony/transcript.json and ${zkeyName(0)}; contributors go next.`);
}

async function contribute(name) {
  if (!name) die('usage: ceremony.mjs contribute "<your name or handle>"');
  const t = loadT();
  if (t.beacon) die('The ceremony is finalized.');
  const last = t.steps[t.steps.length - 1];
  const prev = join(dir, last.file);
  if (sha256File(prev) !== last.sha256) die(`${last.file} does not match the transcript. Download the right file.`);
  const n = last.n + 1;
  const next = join(dir, zkeyName(n));
  // Entropy from the OS CSPRNG plus anything the contributor types; never written to disk.
  const extra = process.env.EXTRA_ENTROPY || '';
  const entropy = randomBytes(64).toString('hex') + extra;
  const hash = await snarkjs.zKey.contribute(prev, next, name, entropy, quiet);
  const hashHex = Buffer.from(hash).toString('hex');
  t.steps.push({ n, file: zkeyName(n), sha256: sha256File(next), by: name, contributionHash: hashHex, at: new Date().toISOString() });
  saveT(t);
  console.log(`Contribution #${n} by ${name}\nContribution hash (publish this yourself):\n${hashHex.match(/.{1,32}/g).join('\n')}\nSend ${zkeyName(n)} and the updated transcript to the coordinator.`);
}

async function verify() {
  const t = loadT();
  if (sha256File(r1cs) !== t.r1csSha256) die('build/transaction.r1cs differs from the ceremony circuit.');
  const ptau = resolve(process.env.PTAU || join(dir, '..', 'ptau', t.ptau.file));
  if (!existsSync(ptau)) die(`Put the public ptau at ${ptau} (or set PTAU=/path/to/${t.ptau.file}).`);
  if (sha256File(ptau) !== t.ptau.sha256) die('The ptau file differs from the one the ceremony used.');
  for (const s of t.steps) {
    const f = join(dir, s.file);
    if (!existsSync(f)) die(`missing ${s.file}`);
    if (sha256File(f) !== s.sha256) die(`${s.file} differs from the transcript`);
  }
  const lastFile = join(dir, t.final ? t.final.file : t.steps[t.steps.length - 1].file);
  console.log(`Verifying ${lastFile} against the circuit and ptau (checks every contribution in the chain)…`);
  const ok = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, lastFile, console);
  if (!ok) die('VERIFICATION FAILED');
  const contributors = t.steps.filter((s) => s.n > 0).length;
  console.log(`OK: ${contributors} contribution(s)${t.final ? ' + final beacon' : ''}.`);
  if (contributors < 3) console.warn('Fewer than 3 independent contributors: not recommended for real funds.');
}

async function finalize(beaconHex, source) {
  if (!/^[0-9a-fA-F]{64}$/.test(beaconHex || '') || !source) die('usage: ceremony.mjs finalize <32-byte beacon hex> "<public source, e.g. drand round 1234567>"');
  const t = loadT();
  if (t.final) die('Already finalized.');
  const contributors = t.steps.filter((s) => s.n > 0).length;
  if (contributors < 1) die('No contributions yet.');
  const last = join(dir, t.steps[t.steps.length - 1].file);
  const final = join(dir, 'transaction_final.zkey');
  await snarkjs.zKey.beacon(last, final, 'Final beacon', beaconHex, 10, quiet);
  const vk = await snarkjs.zKey.exportVerificationKey(final);
  writeFileSync(join(dir, 'verification_key.json'), JSON.stringify(vk, null, 1) + '\n');
  t.beacon = { hex: beaconHex.toLowerCase(), source, iterationsExp: 10 };
  t.final = { file: 'transaction_final.zkey', sha256: sha256File(final), verificationKeySha256: sha256File(join(dir, 'verification_key.json')) };
  saveT(t);
  console.log('Finalized. Run `verify`, publish the transcript and files, then `install`.');
}

function install() {
  const t = loadT();
  if (!t.final) die('Finalize first.');
  if (t.TEST_ONLY_NOT_FOR_REAL_FUNDS) die('This is a test ceremony (CEREMONY_TEST): refusing to install its keys.');
  const assets = resolve(root, '..', 'assets', 'zk');
  copyFileSync(join(dir, 'transaction_final.zkey'), join(assets, 'transaction_final.zkey'));
  copyFileSync(join(dir, 'verification_key.json'), join(assets, 'verification_key.json'));
  const wasm = join(root, 'build', 'transaction_js', 'transaction.wasm');
  if (existsSync(wasm)) copyFileSync(wasm, join(assets, 'transaction.wasm'));
  execFileSync(process.execPath, [join(here, 'vk-to-rust.mjs'), join(dir, 'verification_key.json')], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(here, 'gen-fixtures.mjs')], { stdio: 'inherit', cwd: root });
  console.log('Installed the ceremony keys into assets/zk/ and programs/dankswap-pool/src/verifying_key.rs, and regenerated fixtures.\nRebuild and redeploy the program, and set POOL_AUDITED only after the audits.');
}

const [cmd, ...args] = process.argv.slice(2);
const cmds = { init, contribute, verify, finalize, install };
if (!cmds[cmd]) die('commands: init <ptau> | contribute "<name>" | verify | finalize <beaconHex> "<source>" | install');
await cmds[cmd](...args);
process.exit(0);
