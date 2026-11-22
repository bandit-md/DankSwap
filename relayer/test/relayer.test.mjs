// Relayer tests with a mocked Solana JSON-RPC server. Run: cd relayer && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, parseKeypairSecret } from '../src/config.mjs';
import { Indexer, programDataLines } from '../src/indexer.mjs';
import { Relayer, RelayError, lookupTableAddresses } from '../src/relay.mjs';
import { createHandler, RateLimiter } from '../src/server.mjs';
import { Rpc } from '../../assets/js/pool/client.js';
import { MerkleTree } from '../../assets/js/pool/merkle.js';
import {
  eventDiscriminator, relayRequestBody, transactInstructionData, decodeTransactArgs, argsFromRelay, parseRelayRequest,
} from '../../assets/js/pool/encode.js';
import { associatedTokenAddress, poolPda, nullifierPda, ASSOCIATED_TOKEN_PROGRAM_ID } from '../../assets/js/pool/accounts.js';
import { concatBytes, fieldToBytes, u64LE, pubkeyBytes, bytesToHex } from '../../assets/js/pool/util.js';
import { SANCTIONED_ADDRESSES } from '../../assets/js/pool/sanctions.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');

const PROGRAM_ID = 'FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6';
const WSOL = 'So11111111111111111111111111111111111111112';
const DEV_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const quiet = { info() {}, warn() {}, error() {} };

/* ---------- mock RPC ---------- */
const rpcState = { calls: [], sigs: [], txs: {}, accounts: new Set(), simErr: null, sent: [], tables: {} };
let rpcServer;
let rpcUrl;

before(async () => {
  rpcServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const r = JSON.parse(body);
    rpcState.calls.push(r);
    const ctx = { slot: 100, apiVersion: '2.0.0' };
    let result;
    switch (r.method) {
      case 'getLatestBlockhash': result = { context: ctx, value: { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1000 } }; break;
      case 'getAccountInfo': {
        const key = r.params[0];
        if (rpcState.tables[key]) {
          result = { context: ctx, value: { data: [rpcState.tables[key], 'base64'], executable: false, lamports: 1e7, owner: 'AddressLookupTab1e1111111111111111111111111', rentEpoch: 0, space: 0 } };
          break;
        }
        result = { context: ctx, value: rpcState.accounts.has(key) ? { data: ['', 'base64'], executable: false, lamports: 2039280, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', rentEpoch: 0, space: 165 } : null };
        break;
      }
      case 'simulateTransaction': result = { context: ctx, value: { err: rpcState.simErr, logs: rpcState.simErr ? ['Program log: AnchorError occurred. Error Code: UnknownRoot.', 'Program failed'] : ['Program log: ok'], accounts: null, unitsConsumed: 300000, returnData: null } }; break;
      case 'sendTransaction': rpcState.sent.push(r.params[0]); result = '5j7s1QzqC9JyD3y6k4aYv7w8Wj6b8bKo4SXcN6wsYdqXGe3WkuHJm7Qp3W1F7mQ8u6s2b9k3dPN1r8yB4aE2kL1'; break;
      case 'getSignaturesForAddress': {
        const { before: b, until } = r.params[1] || {};
        let list = rpcState.sigs.slice().reverse(); // newest first
        if (b) list = list.slice(list.findIndex((s) => s.signature === b) + 1);
        if (until) {
          const i = list.findIndex((s) => s.signature === until);
          if (i >= 0) list = list.slice(0, i);
        }
        result = list.slice(0, r.params[1].limit || 1000);
        break;
      }
      case 'getTransaction': result = rpcState.txs[r.params[0]] || null; break;
      default: res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'no ' + r.method } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
  });
  await new Promise((ok) => rpcServer.listen(0, '127.0.0.1', ok));
  rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
});
after(() => rpcServer.close());

function testConfig(extra = {}) {
  return { ...loadConfig({ CLUSTER: 'devnet', RPC_URL: rpcUrl, POOL_MINT_USDT: '' }), ...extra };
}

/* ---------- config ---------- */

test('cluster guard refuses mainnet without RELAYER_ALLOW_MAINNET=1', () => {
  assert.throws(() => loadConfig({ CLUSTER: 'mainnet' }), /Refusing to run on mainnet/);
  assert.equal(loadConfig({ CLUSTER: 'mainnet', RELAYER_ALLOW_MAINNET: '1' }).cluster, 'mainnet');
  assert.throws(() => loadConfig({ CLUSTER: 'testnet' }), /devnet or mainnet/);
  const c = loadConfig({});
  assert.equal(c.cluster, 'devnet');
  assert.equal(c.programId, PROGRAM_ID);
  assert.ok(c.tokens.every((t) => t.mint)); // devnet USDT has no mint by default and is dropped
});

test('RELAYER_KEYPAIR accepts a JSON array or a file path', () => {
  const kp = web3.Keypair.generate();
  const json = JSON.stringify(Array.from(kp.secretKey));
  assert.deepEqual([...parseKeypairSecret(json)], [...kp.secretKey]);
  const dir = mkdtempSync(join(tmpdir(), 'relayer-'));
  writeFileSync(join(dir, 'k.json'), json);
  assert.deepEqual([...parseKeypairSecret(join(dir, 'k.json'))], [...kp.secretKey]);
  assert.throws(() => parseKeypairSecret('[1,2,3]'), /64-byte/);
  assert.throws(() => parseKeypairSecret(''), /required/);
});

/* ---------- indexer ---------- */

async function commitmentEvent(mint, index, commitment, encByte) {
  const disc = await eventDiscriminator('NewCommitment');
  const body = concatBytes(disc, pubkeyBytes(poolPda(web3, PROGRAM_ID, mint).toBase58()), fieldToBytes(commitment), u64LE(index), new Uint8Array(87).fill(encByte));
  return 'Program data: ' + Buffer.from(body).toString('base64');
}

function txWith(logs, err = null) {
  return { slot: 1, blockTime: 0, meta: { err, logMessages: logs, fee: 5000 }, transaction: { signatures: [], message: {} }, version: 0 };
}

test('programDataLines only returns data logged by the pool program', () => {
  const logs = [
    `Program ${PROGRAM_ID} invoke [1]`,
    'Program data: AQID',
    'Program Evil11111111111111111111111111111111111 invoke [2]',
    'Program data: BAUG',
    'Program Evil11111111111111111111111111111111111 success',
    'Program data: BwgJ',
    `Program ${PROGRAM_ID} consumed 1000 of 1400000 compute units`,
    `Program ${PROGRAM_ID} success`,
    'Program data: CgsM',
  ];
  assert.deepEqual(programDataLines(logs, PROGRAM_ID).map((b) => [...b]), [[1, 2, 3], [7, 8, 9]]);
});

test('indexer pages signatures, skips failed and spoofed events, persists and reloads', async () => {
  rpcState.sigs = [];
  rpcState.txs = {};
  const add = (sig, tx, err = null) => {
    rpcState.sigs.push({ signature: sig, slot: rpcState.sigs.length + 1, err, memo: null, blockTime: 0, confirmationStatus: 'confirmed' });
    rpcState.txs[sig] = tx;
  };
  const wrap = (lines) => [`Program ${PROGRAM_ID} invoke [1]`, ...lines, `Program ${PROGRAM_ID} success`];
  add('sig1', txWith(wrap([await commitmentEvent(WSOL, 0, 11n, 1), await commitmentEvent(WSOL, 1, 12n, 2)])));
  // failed transaction: its logs must not count
  add('sigFail', txWith(wrap([await commitmentEvent(WSOL, 2, 999n, 9)]), { InstructionError: [1, { Custom: 6000 }] }), { InstructionError: [1, { Custom: 6000 }] });
  // a different program logging a look-alike event
  add('sigSpoof', txWith(['Program Evil11111111111111111111111111111111111 invoke [1]', await commitmentEvent(WSOL, 2, 666n, 6), 'Program Evil11111111111111111111111111111111111 success']));
  // out of order across pools: USDC leaf 1 arrives before leaf 0
  add('sig2', txWith(wrap([await commitmentEvent(DEV_USDC, 1, 22n, 4)])));
  add('sig3', txWith(wrap([await commitmentEvent(WSOL, 2, 13n, 3), await commitmentEvent(WSOL, 3, 14n, 3), await commitmentEvent(DEV_USDC, 0, 21n, 5)])));

  const dir = mkdtempSync(join(tmpdir(), 'idx-'));
  const file = join(dir, 'index.json');
  const tokens = testConfig().tokens;
  const ix = new Indexer({ rpc: new Rpc([rpcUrl]), web3, programId: PROGRAM_ID, tokens, file, log: quiet });
  assert.equal(await ix.syncOnce(), 6);
  const sol = ix.page(WSOL, 0);
  assert.deepEqual(sol.items.map((i) => i.index), [0, 1, 2, 3]);
  assert.equal(sol.nextIndex, 4);
  assert.equal(sol.items[2].commitment, bytesToHex(fieldToBytes(13n)));
  assert.equal(Buffer.from(sol.items[0].encryptedOutput, 'base64').length, 87);
  assert.equal(sol.root, bytesToHex(fieldToBytes(new MerkleTree(20, [11n, 12n, 13n, 14n]).root())));
  assert.deepEqual(ix.page(WSOL, 3).items.map((i) => i.index), [3]);
  const usdc = ix.page(DEV_USDC, 0);
  assert.deepEqual(usdc.items.map((i) => i.commitment), [bytesToHex(fieldToBytes(21n)), bytesToHex(fieldToBytes(22n))]);
  assert.equal(ix.page('Unknown1111111111111111111111111111111111', 0), null);
  assert.equal(ix.lastSignature, 'sig3');

  // incremental: only new signatures are fetched
  add('sig4', txWith(wrap([await commitmentEvent(WSOL, 4, 15n, 3)])));
  rpcState.calls = [];
  assert.equal(await ix.syncOnce(), 1);
  assert.equal(rpcState.calls.filter((c) => c.method === 'getTransaction').length, 1);
  assert.equal(rpcState.calls.find((c) => c.method === 'getSignaturesForAddress').params[1].until, 'sig3');

  // reload from the JSON file
  const ix2 = new Indexer({ rpc: new Rpc([rpcUrl]), web3, programId: PROGRAM_ID, tokens, file, log: quiet });
  ix2.load();
  assert.equal(ix2.page(WSOL, 0).nextIndex, 5);
  assert.equal(ix2.page(WSOL, 0).root, ix.page(WSOL, 0).root);
  assert.equal(ix2.lastSignature, 'sig4');
});

/* ---------- relay ---------- */

const b = (n, v) => new Uint8Array(n).fill(v);
function relayBody({ relayer, recipient, extAmount, fee, pool = WSOL, recipientOwner }) {
  return JSON.parse(JSON.stringify(relayRequestBody({
    pool,
    args: { proofA: b(64, 1), proofB: b(128, 2), proofC: b(64, 3), root: b(32, 4), inputNullifiers: [b(32, 5), b(32, 6)], outputCommitments: [b(32, 7), b(32, 8)] },
    extData: { recipient, relayer, extAmount, fee, encryptedOutput1: b(87, 9), encryptedOutput2: b(87, 10) },
    recipientOwner,
  })));
}

function makeRelayer(config = testConfig()) {
  const keypair = web3.Keypair.generate();
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  return new Relayer({ web3, connection, keypair, config, log: quiet });
}

test('relay: SOL unshield is rebuilt exactly, simulated, signed and sent', async () => {
  const r = makeRelayer();
  const recipient = web3.Keypair.generate().publicKey.toBase58();
  rpcState.sent = [];
  rpcState.simErr = null;
  rpcState.calls = [];
  const body = relayBody({ relayer: r.address, recipient, extAmount: -1_000_000_000n, fee: 3_000_000n });
  const out = await r.relay(body);
  assert.ok(out.signature);
  assert.ok(rpcState.calls.some((c) => c.method === 'simulateTransaction'));
  assert.equal(rpcState.sent.length, 1);
  const tx = web3.VersionedTransaction.deserialize(Buffer.from(rpcState.sent[0], 'base64'));
  assert.ok(tx.serialize().length <= 1232);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  assert.equal(keys[0], r.address); // fee payer
  const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === PROGRAM_ID);
  const expected = await transactInstructionData(argsFromRelay(parseRelayRequest(body)));
  assert.deepEqual([...ix.data], [...expected]);
  const accts = ix.accountKeyIndexes.map((i) => keys[i]);
  assert.equal(accts[0], r.address);
  assert.equal(accts[2], poolPda(web3, PROGRAM_ID, WSOL).toBase58());
  assert.equal(accts[4], poolPda(web3, PROGRAM_ID, WSOL).toBase58()); // SOL vault = pool PDA
  assert.equal(accts[5], nullifierPda(web3, PROGRAM_ID, b(32, 5)).toBase58());
  assert.equal(accts[7], recipient);
  assert.equal(accts[8], r.address);
  assert.equal(decodeTransactArgs(Uint8Array.from(ix.data)).fee, 3_000_000n);
  assert.ok(tx.signatures[0].some((x) => x !== 0));
});

test('relay: rejects low fee, wrong relayer, deposits, swaps, sanctioned recipients, failed simulation', async () => {
  const r = makeRelayer();
  const recipient = web3.Keypair.generate().publicKey.toBase58();
  const status = async (body) => {
    try {
      await r.relay(body);
      return 200;
    } catch (e) {
      assert.ok(e instanceof RelayError, e.stack);
      return e.status;
    }
  };
  rpcState.simErr = null;
  // fee: max(3_000_000, 0.3% of 10 SOL = 30_000_000)
  assert.equal(await status(relayBody({ relayer: r.address, recipient, extAmount: -10_000_000_000n, fee: 29_999_999n })), 400);
  assert.equal(await status(relayBody({ relayer: r.address, recipient, extAmount: -10_000_000_000n, fee: 30_000_000n })), 200);
  assert.equal(await status(relayBody({ relayer: recipient, recipient, extAmount: -1n, fee: 3_000_000n })), 400);
  assert.equal(await status(relayBody({ relayer: r.address, recipient, extAmount: 5n, fee: 3_000_000n })), 400);
  assert.equal(await status({ ...relayBody({ relayer: r.address, recipient, extAmount: -1n, fee: 3_000_000n }), instruction: 'transact_swap' }), 400);
  assert.equal(await status(relayBody({ relayer: r.address, recipient: SANCTIONED_ADDRESSES[0], extAmount: -1n, fee: 3_000_000n })), 403);
  // private send: recipient must be the fee account, min fee applies
  assert.equal(await status(relayBody({ relayer: r.address, recipient: r.address, extAmount: 0n, fee: 3_000_000n })), 200);
  assert.equal(await status(relayBody({ relayer: r.address, recipient, extAmount: 0n, fee: 3_000_000n })), 400);
  assert.equal(await status({ instruction: 'transact', pool: WSOL }), 400);
  rpcState.simErr = { InstructionError: [2, { Custom: 6001 }] };
  rpcState.sent = [];
  assert.equal(await status(relayBody({ relayer: r.address, recipient, extAmount: -1n, fee: 3_000_000n })), 400);
  assert.equal(rpcState.sent.length, 0);
  rpcState.simErr = null;
});

/** Address lookup table account data (56-byte header + addresses), as the ALT program stores it. */
function altData(addresses, authority) {
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, (1n << 64n) - 1n, true); // not deactivated
  dv.setBigUint64(12, 1n, true);
  meta[21] = 1;
  meta.set(pubkeyBytes(authority), 22);
  return Buffer.from(concatBytes(meta, ...addresses.map(pubkeyBytes))).toString('base64');
}

test('relay: token unshield creates the recipient ATA idempotently (needs the lookup table) and charges for it', async () => {
  const config = testConfig();
  const r = makeRelayer(config);
  const owner = web3.Keypair.generate().publicKey.toBase58();
  const ata = associatedTokenAddress(web3, owner, DEV_USDC).toBase58();
  const feeAcct = associatedTokenAddress(web3, r.address, DEV_USDC).toBase58();
  rpcState.accounts = new Set();
  rpcState.simErr = null;
  const base = { pool: DEV_USDC, relayer: feeAcct, recipient: ata, extAmount: -10_000_000n };
  await assert.rejects(r.relay(relayBody({ ...base, fee: 500_000n, recipientOwner: owner })), /Fee too low/); // +500_000 for the ATA
  await assert.rejects(r.relay(relayBody({ ...base, fee: 1_000_000n })), /recipientOwner/);
  await assert.rejects(r.relay(relayBody({ ...base, fee: 1_000_000n, recipientOwner: web3.Keypair.generate().publicKey.toBase58() })), /associated token account/);
  // Without a lookup table the create-ATA variant does not fit in 1232 bytes: clear refusal, nothing sent.
  rpcState.sent = [];
  await assert.rejects(r.relay(relayBody({ ...base, fee: 1_000_000n, recipientOwner: owner })), /no token account yet/);
  assert.equal(rpcState.sent.length, 0);
  // With the lookup table (scripts/lookup-table.mjs) it fits.
  const table = web3.Keypair.generate().publicKey.toBase58();
  rpcState.tables[table] = altData(lookupTableAddresses(web3, config), r.address);
  const r2 = new Relayer({ web3, connection: r.connection, keypair: r.keypair, config: { ...config, lookupTable: table }, log: quiet });
  await r2.loadLookupTable();
  const feeAcct2 = associatedTokenAddress(web3, r2.address, DEV_USDC).toBase58();
  await r2.relay(relayBody({ ...base, relayer: feeAcct2, fee: 1_000_000n, recipientOwner: owner }));
  const tx = web3.VersionedTransaction.deserialize(Buffer.from(rpcState.sent[0], 'base64'));
  const size = tx.serialize().length;
  assert.ok(size <= 1232, `token unshield tx is ${size} bytes`);
  assert.equal(tx.message.addressTableLookups.length, 1);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const progs = tx.message.compiledInstructions.map((i) => keys[i.programIdIndex]);
  assert.ok(progs.indexOf(ASSOCIATED_TOKEN_PROGRAM_ID) >= 0 && progs.indexOf(ASSOCIATED_TOKEN_PROGRAM_ID) < progs.indexOf(PROGRAM_ID));
  // Existing ATA: base fee is enough, no create instruction, fits without a table.
  rpcState.accounts = new Set([ata]);
  rpcState.sent = [];
  await r.relay(relayBody({ ...base, fee: 500_000n, recipientOwner: owner }));
  const tx2 = web3.VersionedTransaction.deserialize(Buffer.from(rpcState.sent[0], 'base64'));
  const keys2 = tx2.message.staticAccountKeys.map((k) => k.toBase58());
  assert.ok(!keys2.includes(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.ok(tx2.serialize().length <= 1232);
  rpcState.accounts = new Set();
});

/* ---------- HTTP ---------- */

test('HTTP: /info, /commitments, /health, CORS, rate limit, body checks', async () => {
  const config = testConfig({ allowedOrigins: ['https://dankswap.example'], rateLimit: { relayPerMin: 2, readPerMin: 50 } });
  const relayer = makeRelayer(config);
  const indexer = new Indexer({ rpc: new Rpc([rpcUrl]), web3, programId: PROGRAM_ID, tokens: config.tokens, log: quiet });
  const server = http.createServer(createHandler({ config, relayer, indexer, log: quiet }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = { origin: 'https://dankswap.example' };
  try {
    let res = await fetch(base + '/info', { headers: origin });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://dankswap.example');
    const info = await res.json();
    assert.equal(info.relayer, relayer.address);
    assert.equal(info.cluster, 'devnet');
    assert.equal(info.programId, PROGRAM_ID);
    assert.equal(info.feeBps, 30);
    assert.deepEqual(Object.keys(info.minFeeLamports), ['SOL', 'USDC', 'USDT']);

    res = await fetch(base + '/info', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    res = await fetch(base + '/relay', { method: 'OPTIONS', headers: { ...origin, 'access-control-request-method': 'POST' } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);

    res = await fetch(`${base}/commitments?pool=${WSOL}&from=0`);
    const page = await res.json();
    assert.deepEqual(page.items, []);
    assert.equal(page.nextIndex, 0);
    assert.equal(page.root, bytesToHex(fieldToBytes(new MerkleTree(20).root())));
    assert.equal((await fetch(`${base}/commitments?pool=nope&from=0`)).status, 404);
    assert.equal((await fetch(`${base}/commitments?pool=${WSOL}&from=-1`)).status, 400);

    res = await fetch(base + '/health');
    assert.equal((await res.json()).ok, true);

    assert.equal((await fetch(base + '/relay', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
    assert.equal((await fetch(base + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
    assert.equal((await fetch(base + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 429); // 3rd relay in this minute
    assert.equal((await fetch(base + '/nothing')).status, 404);
  } finally {
    server.close();
  }
  const rl = new RateLimiter(2);
  assert.ok(rl.allow('a', 0) && rl.allow('a', 1) && !rl.allow('a', 2) && rl.allow('b', 2) && rl.allow('a', 60_001));
});
