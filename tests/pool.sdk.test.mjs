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
