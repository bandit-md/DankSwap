// Private pool browser SDK (assets/js/pool/) checked against the circuit agent's fixtures in
// circuits/fixtures/ and helpers in circuits/lib/. Run: node --test tests/pool.sdk.test.mjs
// Uses @solana/web3.js from relayer/node_modules (cd relayer && npm install) for PDA/transaction checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { poseidon } from '../assets/vendor/poseidon.bundle.js';
import nacl from '../assets/vendor/tweetnacl.min.js';
import * as U from '../assets/js/pool/util.js';
import { deriveKeys, encodeAddress, decodeAddress, UNLOCK_MESSAGE, signUnlockMessage } from '../assets/js/pool/keys.js';
import {
  Note, mintField, mintFieldBytes, encryptOutput, decryptOutput, tryDecryptNote, commitmentHash, nullifierHash, ENCRYPTED_OUTPUT_LENGTH,
} from '../assets/js/pool/note.js';
import { MerkleTree, zeros, rootFromPath } from '../assets/js/pool/merkle.js';
import {
  extDataHash, extDataBytes, publicAmount, encodeProof, encodePublicSignals, transactInstructionData, decodeTransactArgs,
  instructionDiscriminator, eventDiscriminator, decodeNewCommitment, relayRequestBody, parseRelayRequest, argsFromRelay,
} from '../assets/js/pool/encode.js';
import { buildTransaction, instructionArgs, checkPublicSignals } from '../assets/js/pool/transaction.js';
import { selectNotes, PoolClient } from '../assets/js/pool/client.js';
import { requiredFee, maxWithdrawable } from '../assets/js/pool/fees.js';
import { isSanctioned, SANCTIONED_ADDRESSES } from '../assets/js/pool/sanctions.js';
import { POOL_CONFIG, showUnauditedBanner } from '../assets/js/pool/config.js';
import * as A from '../assets/js/pool/accounts.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIX = join(ROOT, 'circuits', 'fixtures');
const require = createRequire(import.meta.url);

// snarkjs caches a bn128 curve with worker threads in Node; terminate it so the run exits.
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

function fixture(name) {
  const p = join(FIX, name);
  if (!existsSync(p)) assert.fail(`fixtures missing: circuits/fixtures/${name} (the circuits workstream generates it)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function circuitsLib(name) {
  const p = join(ROOT, 'circuits', 'lib', name);
  if (!existsSync(p)) return null;
  const pos = await import(join(ROOT, 'circuits', 'lib', 'poseidon.js'));
  if (pos.initPoseidon) await pos.initPoseidon();
  return import(p);
}

function loadWeb3() {
  for (const p of [join(ROOT, 'relayer', 'node_modules', '@solana', 'web3.js')]) {
    if (existsSync(p)) return require(p);
  }
  assert.fail('@solana/web3.js missing: run `cd relayer && npm install`');
}

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PROGRAM_ID = 'FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6';

/* ---------- §1 field, Poseidon, mintField ---------- */

test('Poseidon matches circuits/fixtures/poseidon.json', () => {
  const f = fixture('poseidon.json');
  assert.ok(f.vectors.length >= 4);
  for (const v of f.vectors) {
    if (v.inputs.length > 4) continue; // SDK bundles 1-4 inputs (all the protocol uses)
    assert.equal(poseidon(v.inputs.map(BigInt)).toString(), v.output, `inputs ${v.inputs}`);
    if (v.outputHex) assert.equal(U.bytesToHex(U.fieldToBytes(BigInt(v.output))), v.outputHex);
  }
});

test('mintField matches circuits/fixtures/mint.json', () => {
  const f = fixture('mint.json');
  for (const m of f.mints) {
    assert.equal(mintField(m.mint).toString(), m.mintField, m.symbol);
    assert.equal(U.bytesToHex(mintFieldBytes(m.mint)), m.mintFieldHex, m.symbol);
  }
});

/* ---------- §3 Merkle ---------- */

test('Merkle zeros match circuits/fixtures/zeros.json', () => {
  const f = fixture('zeros.json');
  assert.deepEqual(zeros(20).map(String), f.zeros);
  assert.equal(new MerkleTree(20).root().toString(), f.zeros[20]);
});

test('Merkle roots and paths match circuits/fixtures/merkle.json', () => {
  const f = fixture('merkle.json');
  const tree = new MerkleTree(f.depth);
  assert.equal(tree.root().toString(), f.initialRoot);
  for (const p of f.pairInserts) {
    assert.equal(tree.nextIndex, p.indices[0]);
    tree.bulkInsert(p.leaves.map(BigInt));
    assert.equal(tree.root().toString(), p.rootAfter);
    if (p.rootAfterHex) assert.equal(U.bytesToHex(U.fieldToBytes(tree.root())), p.rootAfterHex);
    assert.equal(tree.nextIndex, p.nextIndex);
  }
  if (f.singleInserts) {
    const t2 = new MerkleTree(f.depth);
    for (const s of f.singleInserts) {
      assert.equal(t2.nextIndex, s.index);
      t2.insert(BigInt(s.leaf));
      assert.equal(t2.root().toString(), s.rootAfter);
    }
  }
  const leaves = f.pairInserts.flatMap((p) => p.leaves.map(BigInt));
  const t3 = new MerkleTree(f.depth, leaves);
  const path = t3.path(f.path.leafIndex);
  assert.equal(String(f.path.leaf), String(leaves[f.path.leafIndex]));
  assert.deepEqual(path.pathElements.map(String), f.path.pathElements.map(String));
  assert.equal(String(path.pathIndices), String(f.path.pathIndices));
  assert.equal(t3.root().toString(), String(f.path.root));
  assert.equal(rootFromPath(leaves[f.path.leafIndex], path.pathElements, f.path.leafIndex), t3.root());
});

test('bulk insert equals one-by-one insert', () => {
  const leaves = Array.from({ length: 37 }, (_, i) => BigInt(i * 7919 + 1));
  const a = new MerkleTree(20);
  for (const l of leaves) a.insert(l);
  const b = new MerkleTree(20);
  b.bulkInsert(leaves.slice(0, 5));
  b.bulkInsert(leaves.slice(5));
  assert.equal(a.root(), b.root());
  for (const i of [0, 5, 36]) assert.equal(rootFromPath(leaves[i], b.path(i).pathElements, i), b.root());
});

/* ---------- §5 extDataHash ---------- */

test('extDataHash matches circuits/fixtures/extdata.json', async () => {
  const f = fixture('extdata.json');
  assert.ok(f.cases.length >= 3);
  for (const c of f.cases) {
    const e = c.extData;
    const ext = {
      recipient: e.recipient, relayer: e.relayer, extAmount: BigInt(e.extAmount), fee: BigInt(e.fee),
      encryptedOutput1: U.hexToBytes(e.encryptedOutput1), encryptedOutput2: U.hexToBytes(e.encryptedOutput2),
      encryptedSwapOutput: e.encryptedSwapOutput ? U.hexToBytes(e.encryptedSwapOutput) : undefined,
    };
    if (c.preimageHex) assert.equal(U.bytesToHex(extDataBytes(ext)), c.preimageHex, c.name);
    assert.equal((await extDataHash(ext)).toString(), c.extDataHash, c.name);
  }
});

test('publicAmount = (extAmount - fee) mod p', () => {
  assert.equal(publicAmount(1000n, 0n), 1000n);
  assert.equal(publicAmount(-500n, 2n), U.FIELD_SIZE - 502n);
  assert.equal(publicAmount(0n, 5n), U.FIELD_SIZE - 5n);
  assert.throws(() => publicAmount(1n << 63n, 0n));
});

/* ---------- §2 keys, §6 encryption ---------- */

test('keys follow §2 and agree with circuits/lib/keys.js', async () => {
  const sig = new Uint8Array(64).map((_, i) => i * 3 + 1);
  const k = await deriveKeys(sig);
  const seed = await U.sha256(sig);
  assert.equal(k.privKey, U.bytesToBigInt(await U.sha256(U.concatBytes(seed, Uint8Array.of(1)))) % U.FIELD_SIZE);
  assert.equal(k.pubKey, poseidon([k.privKey]));
  const encSecret = await U.sha256(U.concatBytes(seed, Uint8Array.of(2)));
  assert.deepEqual([...k.encSecret], [...encSecret]);
  assert.deepEqual([...k.encPublic], [...nacl.box.keyPair.fromSecretKey(encSecret).publicKey]);
  assert.ok(k.address.startsWith('dank'));
  const L = await circuitsLib('keys.js');
  if (L) {
    assert.equal(L.SIGN_MESSAGE, UNLOCK_MESSAGE);
    assert.equal(L.privKeyFromSeed(L.seedFromSignature(sig)), k.privKey);
    assert.equal(L.pubKeyFromPriv(k.privKey), k.pubKey);
  }
});

test('shielded address round-trips and rejects junk', async () => {
  const k = await deriveKeys(new Uint8Array(64).fill(9));
  const d = decodeAddress(k.address);
  assert.equal(d.pubKey, k.pubKey);
  assert.deepEqual([...d.encPublic], [...k.encPublic]);
  assert.equal(encodeAddress(d.pubKey, d.encPublic), k.address);
  assert.equal(decodeAddress('dank123'), null);
  assert.equal(decodeAddress(k.address.replace(/^dank/, 'xank')), null);
  assert.equal(decodeAddress(USDC), null);
  // base58 with every alphabet letter (regression: an alphabet missing "L" breaks some keys)
  const all = U.base58Decode('42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi');
  assert.equal(all.length, 32);
  assert.equal(U.base58Encode(all), '42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi');
  assert.equal(U.base58Encode(new Uint8Array(32)), '11111111111111111111111111111111');
});

test('signUnlockMessage verifies the wallet signature', async () => {
  const kp = nacl.sign.keyPair();
  const account = { address: U.base58Encode(kp.publicKey), publicKey: kp.publicKey };
  const wallet = { features: { 'solana:signMessage': { signMessage: async ({ message }) => [{ signedMessage: message, signature: nacl.sign.detached(message, kp.secretKey) }] } } };
  const sig = await signUnlockMessage(wallet, account);
  assert.equal(sig.length, 64);
  const bad = { features: { 'solana:signMessage': { signMessage: async () => [{ signature: new Uint8Array(64) }] } } };
  await assert.rejects(signUnlockMessage(bad, account), /did not verify/);
  await assert.rejects(signUnlockMessage({ features: {} }, account), /cannot sign messages/);
});

test('encrypted outputs are 87 bytes and decrypt only with the right key', async () => {
  const k = await deriveKeys(new Uint8Array(64).fill(1));
  const other = await deriveKeys(new Uint8Array(64).fill(2));
  const note = new Note({ amount: 123456789n, pubKey: k.pubKey, encPublic: k.encPublic, mint: WSOL });
  const enc = note.encrypt();
  assert.equal(enc.length, ENCRYPTED_OUTPUT_LENGTH);
  const dec = decryptOutput(enc, k.encSecret);
  assert.equal(dec.amount, 123456789n);
  assert.equal(dec.blinding, note.blinding);
  assert.equal(decryptOutput(enc, other.encSecret), null);
  // layout: ephemeral pk ++ box(amount LE ++ blinding BE, zero nonce)
  const plain = nacl.box.open(enc.subarray(32), new Uint8Array(24), enc.subarray(0, 32), k.encSecret);
  assert.deepEqual([...plain.subarray(0, 8)], [...U.u64LE(123456789n)]);
  assert.deepEqual([...plain.subarray(8)], [...U.bigIntToBytes(note.blinding, 31)]);
  // discovery checks the commitment
  const found = tryDecryptNote({ index: 4, commitment: note.commitment, encryptedOutput: enc }, k, WSOL);
  assert.equal(found.amount, 123456789n);
  assert.equal(found.index, 4);
  assert.equal(tryDecryptNote({ index: 4, commitment: note.commitment + 1n, encryptedOutput: enc }, k, WSOL), null);
  assert.equal(tryDecryptNote({ index: 4, commitment: note.commitment, encryptedOutput: enc }, k, USDC), null);
  // zero notes go to a random key
  const zero = new Note({ amount: 0n, pubKey: k.pubKey, encPublic: k.encPublic, mint: WSOL });
  assert.equal(decryptOutput(zero.encrypt(), k.encSecret), null);
  // deterministic ephemeral key for reproducibility
  const eph = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(7));
  assert.deepEqual([...encryptOutput(1n, 2n, k.encPublic, eph)], [...encryptOutput(1n, 2n, k.encPublic, eph)]);
});

test('note hashes agree with circuits/lib/note.js', async () => {
  const L = await circuitsLib('note.js');
  if (!L) assert.fail('fixtures missing: circuits/lib/note.js');
  const mf = mintField(WSOL);
  const c = commitmentHash(5n, 77n, 99n, mf);
  assert.equal(c, L.commitmentHash(5n, 77n, 99n, mf));
  assert.equal(nullifierHash(11n, c, 3), L.nullifierHash(c, 3n, L.signatureHash(11n, c, 3n)));
});

/* ---------- §7 proof encoding, §8 instruction data ---------- */

test('proofs.json: proof bytes, public inputs, extDataHash, roots, PDAs match; proofs verify', { timeout: 120_000 }, async () => {
  const f = fixture('proofs.json');
  const web3 = loadWeb3();
  assert.equal(f.programId, POOL_CONFIG.POOL_PROGRAM_ID);
  assert.equal(A.poolPda(web3, f.programId, WSOL).toBase58(), f.solPool);
  assert.equal(A.escrowPda(web3, f.programId, f.solPool).toBase58(), f.solEscrow);
  const L = await circuitsLib('encode.js');
  const snarkjs = await snarkjsModule();
  const vkPath = join(ROOT, 'assets', 'zk', 'verification_key.json');
  const vk = existsSync(vkPath) ? JSON.parse(readFileSync(vkPath, 'utf8')) : null;
  if (vk && f.verificationKeySha256) assert.equal(U.bytesToHex(await U.sha256(readFileSync(vkPath))), f.verificationKeySha256);
  assert.ok(f.proofs.length >= 4);
  for (const p of f.proofs) {
    const enc = encodeProof(p.snarkjsProof);
    assert.equal(U.bytesToHex(enc.proofA), p.proofA.replace(/^0x/, ''), `${p.name} proofA`);
    assert.equal(U.bytesToHex(enc.proofB), p.proofB.replace(/^0x/, ''), `${p.name} proofB`);
    assert.equal(U.bytesToHex(enc.proofC), p.proofC.replace(/^0x/, ''), `${p.name} proofC`);
    if (L) assert.equal(U.bytesToHex(enc.proofA), U.bytesToHex(L.encodeProof(p.snarkjsProof).proofA));
    assert.deepEqual(encodePublicSignals(p.publicSignals).map(U.bytesToHex), p.publicInputsHex.map((h) => h.replace(/^0x/, '')), `${p.name} public inputs`);
    const e = p.extData;
    const ext = {
      recipient: e.recipient, relayer: e.relayer, extAmount: BigInt(e.extAmount), fee: BigInt(e.fee),
      encryptedOutput1: U.hexToBytes(e.encryptedOutput1), encryptedOutput2: U.hexToBytes(e.encryptedOutput2),
      encryptedSwapOutput: e.encryptedSwapOutput ? U.hexToBytes(e.encryptedSwapOutput) : undefined,
    };
    const edh = await extDataHash(ext);
    assert.equal(edh.toString(), p.extDataHash, `${p.name} extDataHash`);
    assert.equal(p.publicSignals[2], p.extDataHash);
    assert.equal(publicAmount(ext.extAmount, ext.fee).toString(), p.publicAmount);
    assert.equal(p.publicSignals[1], p.publicAmount);
    assert.equal(mintField(p.mint).toString(), p.publicSignals[3]);
    const before = new MerkleTree(20, p.leavesBefore.map(BigInt));
    assert.equal(before.root().toString(), p.root, `${p.name} root`);
    assert.equal(p.publicSignals[0], p.root);
    const after = new MerkleTree(20, p.leavesAfter.map(BigInt));
    assert.equal(after.nextIndex, before.nextIndex + 2);
    assert.deepEqual(p.leavesAfter.slice(-2), [p.publicSignals[6], p.publicSignals[7]]);
    if (p.flow === 'swap') {
      assert.equal(e.recipient, f.solEscrow);
      assert.equal(p.publicSignals[8], mintField(p.swapMint).toString());
    }
    // Instruction data round-trip from the fixture's bytes
    const args = {
      ...enc, root: U.fieldToBytes(BigInt(p.root)),
      inputNullifiers: p.inputNullifiersHex.map(U.hexToBytes), outputCommitments: p.outputCommitmentsHex.map(U.hexToBytes),
      extAmount: ext.extAmount, fee: ext.fee, encryptedOutput1: ext.encryptedOutput1, encryptedOutput2: ext.encryptedOutput2,
    };
    const data = await transactInstructionData(args);
    assert.equal(data.length, 614);
    assert.deepEqual(U.bytesToHex(data.slice(8 + 256, 8 + 288)), p.rootHex.replace(/^0x/, ''));
    if (vk && snarkjs) assert.ok(await snarkjs.groth16.verify(vk, p.publicSignals, p.snarkjsProof), `${p.name} verifies`);
  }
});

test('Anchor discriminators and transact instruction layout', async () => {
  const d = await instructionDiscriminator('transact');
  assert.deepEqual([...d], [...(await U.sha256(U.utf8('global:transact'))).slice(0, 8)]);
  const ev = await eventDiscriminator('NewCommitment');
  assert.deepEqual([...ev], [...(await U.sha256(U.utf8('event:NewCommitment'))).slice(0, 8)]);
  const b = (n, v) => new Uint8Array(n).fill(v);
  const args = {
    proofA: b(64, 1), proofB: b(128, 2), proofC: b(64, 3), root: b(32, 4), inputNullifiers: [b(32, 5), b(32, 6)],
    outputCommitments: [b(32, 7), b(32, 8)], extAmount: -42n, fee: 7n, encryptedOutput1: b(87, 9), encryptedOutput2: b(87, 10),
  };
  const data = await transactInstructionData(args);
  assert.equal(data.length, 8 + 64 + 128 + 64 + 32 + 64 + 64 + 8 + 8 + 87 + 87);
  const back = decodeTransactArgs(data);
  assert.equal(back.extAmount, -42n);
  assert.equal(back.fee, 7n);
  assert.deepEqual([...back.encryptedOutput2], [...args.encryptedOutput2]);
  assert.equal(back.rest.length, 0);
  // NewCommitment event body: pool, commitment, index u64, encrypted_output [u8;87]
  const body = U.concatBytes(U.pubkeyBytes(WSOL), U.fieldToBytes(12345n), U.u64LE(9n), b(87, 3));
  const e = decodeNewCommitment(body);
  assert.equal(e.pool, WSOL);
  assert.equal(e.commitment, 12345n);
  assert.equal(e.index, 9);
});

test('relay request body round-trips', () => {
  const b = (n, v) => new Uint8Array(n).fill(v);
  const args = { proofA: b(64, 1), proofB: b(128, 2), proofC: b(64, 3), root: b(32, 0), inputNullifiers: [b(32, 0), b(32, 0)], outputCommitments: [b(32, 0), b(32, 0)] };
  const extData = { recipient: USDC, relayer: WSOL, extAmount: -5n, fee: 1n, encryptedOutput1: b(87, 4), encryptedOutput2: b(87, 5) };
  const body = relayRequestBody({ pool: WSOL, args, extData });
  const json = JSON.parse(JSON.stringify(body));
  const p = parseRelayRequest(json);
  assert.equal(p.extData.extAmount, -5n);
  assert.equal(p.extData.recipient, USDC);
  const a = argsFromRelay(p);
  assert.deepEqual([...a.encryptedOutput1], [...extData.encryptedOutput1]);
  assert.throws(() => parseRelayRequest({ ...json, instruction: 'drain' }), /instruction/);
  assert.throws(() => parseRelayRequest({ ...json, args: { ...json.args, proofA: 'AAAA' } }), /proofA/);
});

/* ---------- §8 accounts ---------- */

test('PDAs match the program agent (programs/, coordinator note)', () => {
  const web3 = loadWeb3();
  const solPool = A.poolPda(web3, PROGRAM_ID, WSOL).toBase58();
  assert.equal(solPool, '8xALSdCKU2LtuErMb7gHX1LMj7Y1ZJR5PG5EKrjW7SvQ');
  assert.equal(A.escrowPda(web3, PROGRAM_ID, solPool).toBase58(), '5LXAZN9Ja6xmjjh6hWmaPckciMNDGNc12JGXs9tnQHQz');
  assert.equal(A.poolPda(web3, PROGRAM_ID, USDC).toBase58(), '7JXTkdF4UjiFZiNoWe19nJN6CGGbjWKTDinwjz4YDETH');
  assert.equal(POOL_CONFIG.POOL_PROGRAM_ID, PROGRAM_ID);
  assert.equal(A.associatedTokenAddress(web3, solPool, USDC).toBase58(), web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(solPool).toBuffer(), new web3.PublicKey(A.TOKEN_PROGRAM_ID).toBuffer(), new web3.PublicKey(USDC).toBuffer()],
    new web3.PublicKey(A.ASSOCIATED_TOKEN_PROGRAM_ID))[0].toBase58());
});

/* ---------- transaction building (§4) ---------- */

async function scenario() {
  const alice = await deriveKeys(new Uint8Array(64).fill(21));
  const bob = await deriveKeys(new Uint8Array(64).fill(22));
  const mf = mintField(WSOL);
  const tree = new MerkleTree(20);
  const recipient = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  const dep = await buildTransaction({
    tree, mintField: mf, outputs: [new Note({ amount: 1_000_000_000n, pubKey: alice.pubKey, encPublic: alice.encPublic, mint: WSOL })],
    extData: { recipient, relayer: recipient, extAmount: 1_000_000_000n, fee: 0n },
  });
  return { alice, bob, mf, tree, dep, recipient };
}

test('buildTransaction: deposit then withdraw, public signals in §4 order', async () => {
  const { alice, mf, tree, dep, recipient } = await scenario();
  assert.equal(dep.publicSignals.length, 11);
  assert.equal(dep.publicSignals[1], '1000000000');
  assert.equal(dep.publicSignals[3], mf.toString());
  assert.equal(dep.publicSignals[8], '0');
  assert.equal(BigInt(dep.publicSignals[2]), await extDataHash(dep.extData));
  // program appends both outputs
  tree.bulkInsert(dep.commitments);
  const found = tryDecryptNote({ index: 0, commitment: dep.commitments[0], encryptedOutput: dep.extData.encryptedOutput1 }, alice, WSOL);
  assert.equal(found.amount, 1_000_000_000n);
  assert.equal(tryDecryptNote({ index: 1, commitment: dep.commitments[1], encryptedOutput: dep.extData.encryptedOutput2 }, alice, WSOL), null);
  const w = await buildTransaction({
    tree, mintField: mf, inputs: [found],
    outputs: [new Note({ amount: 400_000_000n, pubKey: alice.pubKey, encPublic: alice.encPublic, mint: WSOL })],
    extData: { recipient, relayer: recipient, extAmount: -590_000_000n, fee: 10_000_000n },
  });
  assert.equal(w.publicSignals[0], tree.root().toString());
  assert.equal(BigInt(w.publicSignals[1]), U.FIELD_SIZE - 600_000_000n);
  assert.equal(w.input.inPathIndices[0], '0');
  assert.equal(w.nullifiers[0], found.nullifier(0));
  await assert.rejects(buildTransaction({ tree, mintField: mf, inputs: [found], outputs: [], extData: { recipient, relayer: recipient, extAmount: -1n, fee: 0n } }), /balance/);
  const args = instructionArgs(w, { proofA: new Uint8Array(64), proofB: new Uint8Array(128), proofC: new Uint8Array(64) });
  assert.deepEqual([...args.root], [...U.fieldToBytes(tree.root())]);
  assert.throws(() => checkPublicSignals(w, w.publicSignals.map((s, i) => (i === 2 ? '1' : s))), /Public signal 2/);
});

test('coin selection and fee schedule', () => {
  const n = (a, i) => ({ amount: BigInt(a), index: i });
  assert.deepEqual(selectNotes([n(5, 0), n(10, 1), n(3, 2)], 4).map((x) => x.index), [0]);
  assert.deepEqual(selectNotes([n(5, 0), n(10, 1), n(3, 2)], 12).map((x) => x.index).sort(), [1, 2]); // 13 beats 15
  assert.throws(() => selectNotes([n(5, 0), n(5, 1), n(5, 2)], 12), (e) => e.code === 'FRAGMENTED' && e.maxSingle === 10n);
  assert.throws(() => selectNotes([n(5, 0)], 12), (e) => e.code === 'INSUFFICIENT');
  const info = { feeBps: 30, minFeeLamports: { SOL: 2_500_000, USDC: 500_000 }, createAtaFee: { USDC: 300_000 } };
  assert.equal(requiredFee(info, 'SOL', 0n), 2_500_000n);
  assert.equal(requiredFee(info, 'SOL', 10_000_000_000n), 30_000_000n);
  assert.equal(requiredFee(info, 'USDC', 1_000_000n, true), 800_000n);
  const max = maxWithdrawable(info, 'SOL', 1_000_000_000n);
  assert.ok(max + requiredFee(info, 'SOL', max) <= 1_000_000_000n);
  assert.ok(max + 1n + requiredFee(info, 'SOL', max + 1n) > 1_000_000_000n);
});

test('sanctions list and banner rule', () => {
  assert.ok(SANCTIONED_ADDRESSES.length >= 1);
  for (const a of SANCTIONED_ADDRESSES) assert.ok(U.isSolanaAddress(a), a);
  assert.ok(isSanctioned(SANCTIONED_ADDRESSES[0]));
  assert.ok(!isSanctioned(USDC));
  assert.equal(showUnauditedBanner({ POOL_CLUSTER: 'devnet', POOL_AUDITED: true }), true);
  assert.equal(showUnauditedBanner({ POOL_CLUSTER: 'mainnet', POOL_AUDITED: false }), true);
  assert.equal(showUnauditedBanner({ POOL_CLUSTER: 'mainnet', POOL_AUDITED: true }), false);
});

test('client refuses mainnet unless POOL_AUDITED', async () => {
  const web3 = loadWeb3();
  const c = new PoolClient({ web3, config: { ...POOL_CONFIG, POOL_CLUSTER: 'mainnet', POOL_AUDITED: false }, fetch: async () => { throw new Error('no network'); } });
  assert.throws(() => c.assertClusterAllowed(), /not enabled/);
  await assert.rejects(c.buildSwap(), /not enabled/);
  const d = new PoolClient({ web3, fetch: async () => { throw new Error('no network'); } });
  await assert.rejects(d.buildSwap(), (e) => e.code === 'SWAP_DEVNET');
});

/* ---------- end to end with a mocked relayer + RPC, real proof when the zkey exists ---------- */

function snarkjsModule() {
  for (const p of [join(ROOT, 'circuits', 'node_modules', 'snarkjs'), join(ROOT, 'relayer', 'node_modules', 'snarkjs')]) {
    if (existsSync(p)) return import(join(p, 'build', 'main.cjs')).then((m) => m.default || m);
  }
  return null;
}

test('client shield → scan → unshield against mocked relayer/RPC (real Groth16 proof)', { timeout: 600_000 }, async () => {
  const wasm = join(ROOT, 'assets', 'zk', 'transaction.wasm');
  const zkey = join(ROOT, 'assets', 'zk', 'transaction_final.zkey');
  if (!existsSync(wasm) || !existsSync(zkey)) assert.fail('fixtures missing: assets/zk/transaction.wasm and transaction_final.zkey (circuits workstream)');
  const snarkjs = await snarkjsModule();
  if (!snarkjs) assert.fail('snarkjs missing: run `cd circuits && npm install`');
  const web3 = loadWeb3();
  const { proveInProcess } = await import('../assets/js/pool/prover.js');
  const prover = { prove: (input) => proveInProcess(snarkjs, input, wasm, zkey) };

  const relayerKp = web3.Keypair.generate();
  const owner = web3.Keypair.generate();
  const leaves = []; // { index, commitment(hex), encryptedOutput(b64) }
  const tree = new MerkleTree(20);
  const relayed = [];
  const fetchMock = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (u.hostname === 'relayer.test') {
      if (u.pathname === '/info') return json({ relayer: relayerKp.publicKey.toBase58(), feeBps: 30, minFeeLamports: { SOL: 2_500_000, USDC: 500_000, USDT: 500_000 }, createAtaFee: { USDC: 300_000, USDT: 300_000 }, cluster: 'devnet', programId: PROGRAM_ID });
      if (u.pathname === '/commitments') {
        const from = Number(u.searchParams.get('from'));
        return json({ items: leaves.slice(from), nextIndex: leaves.length, root: U.bytesToHex(U.fieldToBytes(tree.root())) });
      }
      if (u.pathname === '/relay') {
        relayed.push(JSON.parse(opts.body));
        return json({ signature: 'relayedSig' });
      }
    }
    const body = JSON.parse(opts.body);
    const r = (result) => json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'getLatestBlockhash') return r({ context: { slot: 1 }, value: { blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 } });
    if (body.method === 'getMultipleAccounts') return r({ context: { slot: 1 }, value: body.params[0].map(() => null) });
    if (body.method === 'getAccountInfo') return r({ context: { slot: 1 }, value: null });
    throw new Error('unexpected ' + url + ' ' + body.method);
  };
  const config = { ...POOL_CONFIG, RELAYER_URL: 'https://relayer.test', RPC: { devnet: ['https://rpc.test'] } };
  const client = new PoolClient({ web3, config, prover, fetch: fetchMock });
  client.setKeys(await deriveKeys(new Uint8Array(64).fill(33)));

  const t0 = Date.now();
  const shield = await client.buildShield({ symbol: 'SOL', amount: 1_000_000_000n, owner: owner.publicKey.toBase58() });
  const proveMs = Date.now() - t0;
  const vtx = web3.VersionedTransaction.deserialize(shield.bytes);
  assert.ok(shield.bytes.length <= 1232, `tx is ${shield.bytes.length} bytes`);
  const ix = vtx.message.compiledInstructions[1];
  const keys = vtx.message.staticAccountKeys.map((k) => k.toBase58());
  assert.equal(keys[vtx.message.compiledInstructions[1].programIdIndex], PROGRAM_ID);
  const data = Uint8Array.from(ix.data);
  const dec = decodeTransactArgs(data);
  assert.equal(dec.extAmount, 1_000_000_000n);
  assert.equal(dec.fee, 0n);
  // verify the proof with the verification key, from the encoded public inputs
  const vkPath = join(ROOT, 'assets', 'zk', 'verification_key.json');
  if (existsSync(vkPath)) {
    const vk = JSON.parse(readFileSync(vkPath, 'utf8'));
    const pub = shield.tx.publicSignals;
    assert.ok(await snarkjs.groth16.verify(vk, pub, shield.proof));
  }
  console.log(`# node proving time (shield, in-process): ${proveMs} ms`);

  // the program would append both outputs and emit NewCommitment events
  const add = (c, enc) => {
    leaves.push({ index: leaves.length, commitment: U.bytesToHex(U.fieldToBytes(c)), encryptedOutput: U.bytesToBase64(enc) });
    tree.insert(c);
  };
  add(shield.tx.commitments[0], shield.tx.extData.encryptedOutput1);
  add(shield.tx.commitments[1], shield.tx.extData.encryptedOutput2);
  const r = await client.refresh('SOL');
  assert.equal(r.balance, 1_000_000_000n);

  const recipient = web3.Keypair.generate().publicKey.toBase58();
  const un = await client.buildUnshield({ symbol: 'SOL', amount: 500_000_000n, recipientWallet: recipient });
  assert.equal(un.fee, 2_500_000n); // max(min, 0.3% of 0.5 SOL = 1.5M)
  const p = parseRelayRequest(JSON.parse(JSON.stringify(un.body)));
  assert.equal(p.extData.recipient, recipient);
  assert.equal(p.extData.relayer, relayerKp.publicKey.toBase58());
  assert.equal(p.extData.extAmount, -500_000_000n);
  assert.equal(BigInt(un.tx.publicSignals[2]), await extDataHash(p.extData));
  assert.equal(U.bytesToHex(p.args.root), U.bytesToHex(U.fieldToBytes(tree.root())));
  const sig = await client.relay(un);
  assert.equal(sig, 'relayedSig');
  assert.equal(client.balance('SOL'), 0n); // spent input hidden until the change note is indexed
});

/* ---------- private swap (transact_swap) ---------- */

import { transactSwapInstructionData } from '../assets/js/pool/encode.js';
import * as SW from '../assets/js/pool/swap.js';

const DEV_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

test('transact_swap: fixture swap proof → instruction data and account order of programs/README.md; extDataHash as the program computes it', async () => {
  const f = fixture('proofs.json');
  const web3 = loadWeb3();
  const p = f.proofs.find((x) => x.flow === 'swap');
  assert.ok(p, 'swap fixture');
  assert.equal(p.swapMint, USDC);
  const e = p.extData;
  const enc = encodeProof(p.snarkjsProof);
  const swapAmount = BigInt(p.publicSignals[9]);
  assert.equal(swapAmount, 45_000_000n); // 45 USDC
  assert.equal(p.publicSignals[8], mintField(USDC).toString());
  assert.equal(U.bytesToHex(U.fieldToBytes(BigInt(p.publicSignals[10]))), p.swapCommitmentHex);
  const swapData = await SW.mockSwapData(300_000_000n, 46_000_000n);
  const args = {
    ...enc, root: U.hexToBytes(p.rootHex), inputNullifiers: p.inputNullifiersHex.map(U.hexToBytes), outputCommitments: p.outputCommitmentsHex.map(U.hexToBytes),
    extAmount: BigInt(e.extAmount), fee: BigInt(e.fee), encryptedOutput1: U.hexToBytes(e.encryptedOutput1), encryptedOutput2: U.hexToBytes(e.encryptedOutput2),
    swapAmount, swapCommitment: U.hexToBytes(p.swapCommitmentHex), encryptedSwapOutput: U.hexToBytes(e.encryptedSwapOutput), swapData,
  };
  const data = await transactSwapInstructionData(args);
  // discriminator, the 10 transact args (606), swap_amount u64, swap_commitment, encrypted_swap_output, Vec<u8> swap_data
  assert.equal(data.length, 8 + 606 + 8 + 32 + 87 + 4 + swapData.length);
  assert.deepEqual([...data.slice(0, 8)], [...(await U.sha256(U.utf8('global:transact_swap'))).slice(0, 8)]);
  const dec = decodeTransactArgs(data);
  assert.equal(dec.extAmount, -300_000_000n);
  assert.equal(dec.fee, 1_000_000n);
  assert.equal(U.bytesToHex(dec.root), p.rootHex);
  assert.equal(U.bytesToHex(dec.proofA), p.proofA);
  assert.equal(U.readU64LE(dec.rest, 0), swapAmount);
  assert.equal(U.bytesToHex(dec.rest.slice(8, 40)), p.swapCommitmentHex);
  assert.equal(U.bytesToHex(dec.rest.slice(40, 127)), e.encryptedSwapOutput);
  assert.equal(new DataView(dec.rest.buffer, dec.rest.byteOffset + 127, 4).getUint32(0, true), swapData.length);
  assert.deepEqual([...dec.rest.slice(131)], [...swapData]);

  // Accounts, programs/README.md order; escrow = extDataHash recipient (#8), relayer_fee_account = relayer (#7).
  const relayer = e.relayer;
  const surplus = A.associatedTokenAddress(web3, relayer, USDC).toBase58();
  const route = (await SW.mockSwapInstruction(web3, { programId: PROGRAM_ID, inputMint: WSOL, outputMint: USDC, amountIn: 300_000_000n, amountOut: 46_000_000n }));
  const remaining = SW.swapRemainingAccounts(route, { escrow: f.solEscrow, relayer });
  const keys = A.transactSwapAccounts(web3, {
    programId: PROGRAM_ID, mint: WSOL, native: true, outputMint: USDC, outputNative: false, signer: relayer,
    nullifiers: p.inputNullifiersHex.map(U.hexToBytes), relayerFeeAccount: relayer, relayerSurplusAccount: surplus,
    swapProgram: SW.MOCK_SWAP_PROGRAM_ID, remainingAccounts: remaining,
  });
  const k = keys.map((m) => m.pubkey.toBase58());
  const escrowIn = A.associatedTokenAddress(web3, f.solEscrow, WSOL).toBase58();
  const escrowOut = A.associatedTokenAddress(web3, f.solEscrow, USDC).toBase58();
  const expected = [
    relayer, A.configPda(web3, PROGRAM_ID).toBase58(), f.solPool, A.treePda(web3, PROGRAM_ID, WSOL).toBase58(), A.vaultPda(web3, PROGRAM_ID, WSOL).toBase58(),
    A.nullifierPda(web3, PROGRAM_ID, U.hexToBytes(p.inputNullifiersHex[0])).toBase58(), A.nullifierPda(web3, PROGRAM_ID, U.hexToBytes(p.inputNullifiersHex[1])).toBase58(),
    relayer, f.solEscrow, escrowIn, escrowOut, A.poolPda(web3, PROGRAM_ID, USDC).toBase58(), A.treePda(web3, PROGRAM_ID, USDC).toBase58(),
    A.vaultPda(web3, PROGRAM_ID, USDC).toBase58(), surplus, SW.MOCK_SWAP_PROGRAM_ID, A.TOKEN_PROGRAM_ID, A.SYSTEM_PROGRAM_ID,
  ];
  assert.deepEqual(k.slice(0, 18), expected);
  const writable = keys.slice(0, 18).map((m) => m.isWritable);
  assert.deepEqual(writable, [true, false, false, true, true, true, true, true, true, true, true, false, true, true, true, false, false, false]);
  assert.deepEqual(keys.slice(0, 18).map((m) => m.isSigner), [true, ...new Array(17).fill(false)]);
  // remaining accounts = mock-swap `Swap` order (programs/dankswap-pool/tests/litesvm.rs), escrow not a tx signer
  const reserve = SW.mockReserveAuthority(web3).toBase58();
  assert.deepEqual(k.slice(18), [f.solEscrow, escrowIn, A.associatedTokenAddress(web3, reserve, WSOL).toBase58(), A.associatedTokenAddress(web3, reserve, USDC).toBase58(), escrowOut, reserve, A.TOKEN_PROGRAM_ID]);
  assert.ok(keys.every((m) => !m.isSigner || m.pubkey.toBase58() === relayer));
  // extDataHash from the instruction's own accounts and data, exactly as transact_swap computes it
  const edh = await extDataHash({
    recipient: k[8], relayer: k[7], extAmount: dec.extAmount, fee: dec.fee, encryptedOutput1: dec.encryptedOutput1,
    encryptedOutput2: dec.encryptedOutput2, encryptedSwapOutput: dec.rest.slice(40, 127),
  });
  assert.equal(edh.toString(), p.publicSignals[2]);
  // the program's 11 public inputs from instruction data + pools: identical to the fixture's
  const inputs = [
    dec.root, U.fieldToBytes(publicAmount(dec.extAmount, dec.fee)), U.fieldToBytes(edh), mintFieldBytes(WSOL), ...dec.inputNullifiers, ...dec.outputCommitments,
    mintFieldBytes(USDC), U.fieldToBytes(swapAmount), dec.rest.slice(8, 40),
  ].map(U.bytesToHex);
  assert.deepEqual(inputs, p.publicInputsHex);
});

test('swap helpers: minOut, slippage, remaining accounts, setup and lookup tables', async () => {
  const web3 = loadWeb3();
  assert.equal(SW.swapMinOut(46_000_000n, 50, 0), 45_770_000n);
  assert.equal(SW.swapMinOut(1_000_000n, 50, 20), 993_000n);
  assert.throws(() => SW.swapMinOut(1n, 9000, 1000));
  assert.equal(SW.slippageForMinOut(1_000_000n, 990_000n), 100);
  assert.equal(SW.slippageForMinOut(1_000_000n, 1_000_001n), 0);
  const e = SW.swapEscrowAccounts(web3, PROGRAM_ID, WSOL, USDC);
  assert.equal(e.escrow, '5LXAZN9Ja6xmjjh6hWmaPckciMNDGNc12JGXs9tnQHQz');
  const relayer = web3.Keypair.generate().publicKey.toBase58();
  const other = web3.Keypair.generate().publicKey.toBase58();
  const ix = { programId: SW.JUPITER_V6_PROGRAM_ID, data: 'AQI=', accounts: [
    { pubkey: A.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: e.escrow, isSigner: true, isWritable: false },
    { pubkey: e.escrowInput, isSigner: false, isWritable: true },
  ] };
  const r = SW.swapRemainingAccounts(ix, { escrow: e.escrow, relayer });
  assert.deepEqual(r.map((m) => m.pubkey), ix.accounts.map((m) => m.pubkey));
  assert.equal(r[1].isSigner, false);
  assert.equal(r[2].isWritable, true);
  assert.throws(() => SW.swapRemainingAccounts({ ...ix, accounts: [...ix.accounts, { pubkey: other, isSigner: true, isWritable: true }] }, { escrow: e.escrow, relayer }), /signature/);
  assert.deepEqual([...SW.swapInstructionData(ix)], [1, 2]);
  assert.deepEqual(SW.buildLookupTableAddresses({ addressesByLookupTableAddress: { A1: [], B2: [] }, addressLookupTableAddresses: ['B2', 'C3'] }), ['A1', 'B2', 'C3']);
  const ataIx = { programId: A.ASSOCIATED_TOKEN_PROGRAM_ID, data: 'AQ==', accounts: [relayer, e.escrowOutput, e.escrow, USDC, A.SYSTEM_PROGRAM_ID, A.TOKEN_PROGRAM_ID].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })) };
  assert.deepEqual(SW.parseSetupInstructions([ataIx], { escrow: e.escrow, relayer }), [{ ata: e.escrowOutput, owner: e.escrow, mint: USDC }]);
  assert.throws(() => SW.parseSetupInstructions([{ ...ataIx, programId: A.SYSTEM_PROGRAM_ID }], { escrow: e.escrow, relayer }), /Unsupported/);
  const bad = { ...ataIx, accounts: ataIx.accounts.map((a, i) => (i === 2 ? { ...a, pubkey: other } : a)) };
  assert.throws(() => SW.parseSetupInstructions([bad], { escrow: e.escrow, relayer }), /owner/);
});

test('client swap SOL→USDC against mocked relayer: real proof with swap public inputs, swap note discovered in the output pool', { timeout: 600_000 }, async () => {
  const wasm = join(ROOT, 'assets', 'zk', 'transaction.wasm');
  const zkey = join(ROOT, 'assets', 'zk', 'transaction_final.zkey');
  if (!existsSync(wasm) || !existsSync(zkey)) assert.fail('fixtures missing: assets/zk/transaction.wasm and transaction_final.zkey');
  const snarkjs = await snarkjsModule();
  if (!snarkjs) assert.fail('snarkjs missing: run `cd circuits && npm install`');
  const web3 = loadWeb3();
  const { proveInProcess } = await import('../assets/js/pool/prover.js');
  const prover = { prove: (input) => proveInProcess(snarkjs, input, wasm, zkey) };
  const relayerKp = web3.Keypair.generate();
  const keys = await deriveKeys(new Uint8Array(64).fill(44));

  const pools = { [WSOL]: { leaves: [], tree: new MerkleTree(20) }, [DEV_USDC]: { leaves: [], tree: new MerkleTree(20) } };
  const add = (mint, c, enc) => {
    const P = pools[mint];
    P.leaves.push({ index: P.leaves.length, commitment: U.bytesToHex(U.fieldToBytes(c)), encryptedOutput: U.bytesToBase64(enc) });
    P.tree.insert(c);
  };
  // A 1 SOL note for this account already in the SOL pool (as if shielded).
  const dep = await buildTransaction({
    tree: pools[WSOL].tree, mintField: mintField(WSOL), outputs: [new Note({ amount: 1_000_000_000n, pubKey: keys.pubKey, encPublic: keys.encPublic, mint: WSOL })],
    extData: { recipient: relayerKp.publicKey.toBase58(), relayer: relayerKp.publicKey.toBase58(), extAmount: 1_000_000_000n, fee: 0n },
  });
  add(WSOL, dep.commitments[0], dep.extData.encryptedOutput1);
  add(WSOL, dep.commitments[1], dep.extData.encryptedOutput2);

  const quotes = [];
  const relayed = [];
  const info = {
    relayer: relayerKp.publicKey.toBase58(), feeBps: 30, minFeeLamports: { SOL: 3_000_000, USDC: 500_000, USDT: 500_000 }, createAtaFee: { USDC: 500_000, USDT: 500_000 },
    cluster: 'devnet', programId: PROGRAM_ID, swap: { enabled: true, route: 'mock', program: SW.MOCK_SWAP_PROGRAM_ID, slippageBps: 50, swapFeeBps: 0, quoteTtlMs: 60_000 },
  };
  const fetchMock = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (u.pathname === '/info') return json(info);
    if (u.pathname === '/swap/quote') {
      quotes.push(Object.fromEntries(u.searchParams));
      const amount = BigInt(u.searchParams.get('amount'));
      const outAmount = (amount * 150n) / 1000n; // 150 USDC per SOL, 9 → 6 decimals
      return json({ inputMint: u.searchParams.get('inputMint'), outputMint: u.searchParams.get('outputMint'), amount: amount.toString(), outAmount: outAmount.toString(), otherAmountThreshold: outAmount.toString(), minOut: SW.swapMinOut(outAmount, 50).toString(), feeInInputMint: '3000000', slippageBps: 50, swapFeeBps: 0, priceImpactPct: '0.0012', route: 'mock', expiresAt: Date.now() + 60_000 });
    }
    if (u.pathname === '/commitments') {
      const P = pools[u.searchParams.get('pool')];
      const from = Number(u.searchParams.get('from'));
      return json({ items: P.leaves.slice(from), nextIndex: P.leaves.length, root: U.bytesToHex(U.fieldToBytes(P.tree.root())) });
    }
    if (u.pathname === '/relay') {
      relayed.push(JSON.parse(opts.body));
      return json({ signature: 'swapSig', outAmount: '45000000' });
    }
    const body = JSON.parse(opts.body);
    const r = (result) => json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'getMultipleAccounts') return r({ context: { slot: 1 }, value: body.params[0].map(() => null) });
    throw new Error('unexpected ' + url);
  };
  const config = { ...POOL_CONFIG, RELAYER_URL: 'https://relayer.test', RPC: { devnet: ['https://rpc.test'] } };
  const client = new PoolClient({ web3, config, prover, fetch: fetchMock });
  client.setKeys(keys);
  assert.deepEqual(client.swapSupport(null).code, 'SWAP_DEVNET');
  assert.equal(client.swapSupport(info).ok, true);
  assert.equal(client.swapSupport({ ...info, swap: { ...info.swap, route: 'jupiter' } }).ok, false); // Jupiter is not on devnet

  const q = await client.quoteSwap({ fromToken: 'SOL', toToken: 'USDC', amount: 300_000_000n });
  assert.equal(q.outAmount, 45_000_000n);
  assert.equal(q.minOut, 44_775_000n);
  assert.equal(q.fee, 3_000_000n);
  assert.deepEqual(quotes[0], { inputMint: WSOL, outputMint: DEV_USDC, amount: '300000000' });
  await assert.rejects(client.quoteSwap({ fromToken: 'SOL', toToken: 'SOL', amount: 1n }), (e) => e.code === 'SWAP_SAME');

  const { signature, built } = await client.swap({ fromToken: 'SOL', toToken: 'USDC', amount: 300_000_000n, quote: q });
  assert.equal(signature, 'swapSig');
  const body = relayed[0];
  assert.equal(body.instruction, 'transact_swap');
  assert.equal(body.pool, WSOL);
  assert.equal(body.args.outputPool, DEV_USDC);
  assert.equal(body.args.swapAmount, '44775000');
  assert.equal(body.args.swapData, '');
  const escrow = A.escrowPda(web3, PROGRAM_ID, A.poolPda(web3, PROGRAM_ID, WSOL)).toBase58();
  assert.equal(body.extData.recipient, escrow);
  assert.equal(body.extData.relayer, relayerKp.publicKey.toBase58());
  assert.equal(body.extData.extAmount, '-300000000');
  assert.equal(body.extData.fee, '3000000');
  const parsed = parseRelayRequest(JSON.parse(JSON.stringify(body)));
  const ps = built.tx.publicSignals;
  assert.equal(ps[0], pools[WSOL].tree.root().toString());
  assert.equal(ps[1], publicAmount(-300_000_000n, 3_000_000n).toString());
  assert.equal(ps[2], (await extDataHash(parsed.extData)).toString(), 'extDataHash binds escrow, relayer and encryptedSwapOutput');
  assert.equal(ps[3], mintField(WSOL).toString());
  assert.equal(ps[8], mintField(DEV_USDC).toString());
  assert.equal(U.bytesToHex(parsed.args.swapMintField), U.bytesToHex(mintFieldBytes(DEV_USDC)));
  assert.equal(ps[9], '44775000');
  assert.equal(ps[10], U.bytesToBigInt(parsed.args.swapCommitment).toString());
  // the relayer's instruction from this body carries exactly the proven public inputs
  const data = await transactSwapInstructionData({ ...argsFromRelay(parsed), swapData: new Uint8Array(0) });
  const dec = decodeTransactArgs(data);
  assert.equal(U.readU64LE(dec.rest, 0), 44_775_000n);
  assert.equal(U.bytesToHex(dec.rest.slice(8, 40)), U.bytesToHex(U.fieldToBytes(BigInt(ps[10]))));
  const vk = JSON.parse(readFileSync(join(ROOT, 'assets', 'zk', 'verification_key.json'), 'utf8'));
  assert.ok(await snarkjs.groth16.verify(vk, ps, built.proof), 'swap proof verifies');
  assert.equal(client.balance('SOL'), 0n); // the 1 SOL note is pending

  // The program appends the change outputs to the SOL tree and swapCommitment to the USDC tree.
  add(WSOL, BigInt(ps[6]), parsed.extData.encryptedOutput1);
  add(WSOL, BigInt(ps[7]), parsed.extData.encryptedOutput2);
  add(DEV_USDC, BigInt(ps[10]), parsed.extData.encryptedSwapOutput);
  const usdc = await client.refresh('USDC');
  assert.equal(usdc.balance, 44_775_000n);
  assert.equal(usdc.notes[0].index, 0);
  const sol = await client.refresh('SOL');
  assert.equal(sol.balance, 697_000_000n); // change; the spent input stays hidden
});
