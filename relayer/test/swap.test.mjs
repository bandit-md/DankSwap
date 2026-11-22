// Private swap relaying (transact_swap) with a mocked Solana RPC and a mocked Jupiter Swap API V2
// /build. Run: cd relayer && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

import { loadConfig } from '../src/config.mjs';
import { Relayer, RelayError, lookupTableAddresses } from '../src/relay.mjs';
import { createHandler } from '../src/server.mjs';
import { Indexer } from '../src/indexer.mjs';
import { Rpc } from '../../assets/js/pool/client.js';
import { relayRequestBody, parseRelayRequest, argsFromRelay, transactSwapInstructionData, decodeTransactArgs } from '../../assets/js/pool/encode.js';
import { associatedTokenAddress, poolPda, treePda, vaultPda, configPda, nullifierPda, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../assets/js/pool/accounts.js';
import { mintFieldBytes } from '../../assets/js/pool/note.js';
import { requiredFee } from '../../assets/js/pool/fees.js';
import { concatBytes, pubkeyBytes, readU64LE, bytesToBase64 } from '../../assets/js/pool/util.js';
import {
  swapEscrowAccounts, mockSwapData, mockReserveAuthority, JUPITER_V6_PROGRAM_ID, MOCK_SWAP_PROGRAM_ID, WSOL_MINT,
} from '../../assets/js/pool/swap.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');

const PROGRAM_ID = 'FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6';
const WSOL = WSOL_MINT;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEV_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const quiet = { info() {}, warn() {}, error() {} };

/* ---------- mock RPC ---------- */
const rpc = { calls: [], accounts: new Set(), tables: {}, sent: [], simErr: null };
let rpcServer;
let rpcUrl;

before(async () => {
  rpcServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const r = JSON.parse(body);
    rpc.calls.push(r);
    const ctx = { slot: 100, apiVersion: '2.0.0' };
    const acct = (key) => {
      if (rpc.tables[key]) return { data: [rpc.tables[key], 'base64'], executable: false, lamports: 1e7, owner: 'AddressLookupTab1e1111111111111111111111111', rentEpoch: 0, space: 0 };
      return rpc.accounts.has(key) ? { data: ['', 'base64'], executable: false, lamports: 2039280, owner: TOKEN_PROGRAM_ID, rentEpoch: 0, space: 165 } : null;
    };
    let result;
    switch (r.method) {
      case 'getLatestBlockhash': result = { context: ctx, value: { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1000 } }; break;
      case 'getAccountInfo': result = { context: ctx, value: acct(r.params[0]) }; break;
      case 'getMultipleAccounts': result = { context: ctx, value: r.params[0].map(acct) }; break;
      case 'simulateTransaction': result = { context: ctx, value: { err: rpc.simErr, logs: ['Program log: ok'], accounts: null, unitsConsumed: 600000, returnData: null } }; break;
      case 'sendTransaction': rpc.sent.push(r.params[0]); result = `sig${rpc.sent.length}`.padEnd(88, '1'); break;
      case 'getSignatureStatuses': result = { context: ctx, value: r.params[0].map(() => ({ slot: 99, confirmations: 1, err: null, confirmationStatus: 'confirmed' })) }; break;
      default:
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'no ' + r.method } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
  });
  await new Promise((ok) => rpcServer.listen(0, '127.0.0.1', ok));
  rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
});
after(() => rpcServer.close());

/** Address lookup table account data (56-byte header + addresses), as the ALT program stores it. */
function altData(addresses, authority) {
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, (1n << 64n) - 1n, true);
  dv.setBigUint64(12, 1n, true);
  meta[21] = 1;
  meta.set(pubkeyBytes(authority), 22);
  return Buffer.from(concatBytes(meta, ...addresses.map(pubkeyBytes))).toString('base64');
}
const newKey = () => web3.Keypair.generate().publicKey.toBase58();

/* ---------- mock Jupiter /build ---------- */

/**
 * A realistic Swap API V2 /build response: a Jupiter v6 shared-accounts route through one
 * Whirlpool, setup creating the taker's output ATA, a compute-unit-price instruction, and one
 * Jupiter lookup table holding the route's static accounts.
 */
function jupiterBuild(q, { outAmount, otherAmountThreshold, programId = JUPITER_V6_PROGRAM_ID, extraSigner = null, jupAlt }) {
  const taker = q.get('taker');
  const src = associatedTokenAddress(web3, taker, q.get('inputMint')).toBase58();
  const dst = q.get('destinationTokenAccount');
  const a = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  const accounts = [
    a(TOKEN_PROGRAM_ID, false, false),
    a(jupAlt.programAuthority, false, false),
    a(taker, true, false), // user transfer authority = escrow PDA
    a(src, false, true),
    a(jupAlt.programSource, false, true),
    a(jupAlt.programDestination, false, true),
    a(dst, false, true),
    a(q.get('inputMint'), false, false),
    a(q.get('outputMint'), false, false),
    a(JUPITER_V6_PROGRAM_ID, false, false), // platform fee account: None
    a(JUPITER_V6_PROGRAM_ID, false, false), // token-2022 program: None
    a(jupAlt.eventAuthority, false, false),
    a(JUPITER_V6_PROGRAM_ID, false, false),
    ...jupAlt.amm.map((k, i) => a(k, false, i < 6)),
  ];
  if (extraSigner) accounts.push(a(extraSigner, true, true));
  const data = new Uint8Array(42).fill(7);
  data.set([193, 32, 155, 51, 65, 214, 156, 129]); // shared_accounts_route discriminator
  const out = BigInt(outAmount);
  return {
    inputMint: q.get('inputMint'), outputMint: q.get('outputMint'), inAmount: q.get('amount'), outAmount: out.toString(),
    otherAmountThreshold: String(otherAmountThreshold ?? (out * BigInt(10_000 - Number(q.get('slippageBps')))) / 10_000n),
    swapMode: 'ExactIn', slippageBps: Number(q.get('slippageBps')), priceImpactPct: '0.0004',
    routePlan: [{ swapInfo: { ammKey: jupAlt.amm[0], label: 'Whirlpool', inputMint: q.get('inputMint'), outputMint: q.get('outputMint'), inAmount: q.get('amount'), outAmount: out.toString() }, percent: 100, bps: 10000 }],
    computeBudgetInstructions: [{ programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: 'AxAnAAAAAAAA' }],
    setupInstructions: [{
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      accounts: [a(q.get('payer'), true, true), a(dst, false, true), a(taker, false, false), a(q.get('outputMint'), false, false), a('11111111111111111111111111111111', false, false), a(TOKEN_PROGRAM_ID, false, false)],
      data: 'AQ==',
    }],
    swapInstruction: { programId, accounts, data: bytesToBase64(data) },
    cleanupInstruction: null,
    otherInstructions: [],
    addressesByLookupTableAddress: { [jupAlt.address]: jupAlt.all },
    blockhashWithMetadata: { blockhash: Array(32).fill(1), lastValidBlockHeight: 1000, fetchedAt: { secs_since_epoch: 0, nanos_since_epoch: 0 } },
  };
}

function makeJupAlt() {
  const amm = Array.from({ length: 11 }, newKey);
  const t = { address: newKey(), programAuthority: newKey(), programSource: newKey(), programDestination: newKey(), eventAuthority: newKey(), amm };
  t.all = [t.programAuthority, t.programSource, t.programDestination, t.eventAuthority, JUPITER_V6_PROGRAM_ID, ...amm];
  rpc.tables[t.address] = altData(t.all, newKey());
  return t;
}

function jupiterFetch(opts) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const o = typeof opts === 'function' ? opts(u, calls.length) : opts;
    if (o.status) return { ok: false, status: o.status, json: async () => ({ error: o.error || 'No routes found' }) };
    return { ok: true, status: 200, json: async () => jupiterBuild(u.searchParams, o) };
  };
  f.calls = calls;
  return f;
}

/** Mainnet relayer (Jupiter route) with its own lookup table, as scripts/lookup-table.mjs builds it. */
async function mainnetRelayer(fetchImpl, { withTable = true, env = {} } = {}) {
  const config = loadConfig({ CLUSTER: 'mainnet', RELAYER_ALLOW_MAINNET: '1', RPC_URL: rpcUrl, ...env });
  const keypair = web3.Keypair.generate();
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  let cfg = config;
  if (withTable) {
    const table = newKey();
    rpc.tables[table] = altData(lookupTableAddresses(web3, config, keypair.publicKey.toBase58()), keypair.publicKey.toBase58());
    cfg = { ...config, lookupTable: table };
  }
  const r = new Relayer({ web3, connection, keypair, config: cfg, log: quiet, fetch: fetchImpl });
  r.setupDelayMs = 1;
  if (withTable) await r.loadLookupTable();
  return r;
}

const b = (n, v) => new Uint8Array(n).fill(v);
let nullSeed = 10;
function swapBody({ inputMint, outputMint, recipient, relayer, extAmount, fee, swapAmount, swapMintField }) {
  nullSeed = (nullSeed + 2) % 250;
  const nul = (v) => {
    const x = b(32, v);
    x[0] = 0; // keep it a canonical field element
    return x;
  };
  return JSON.parse(JSON.stringify(relayRequestBody({
    instruction: 'transact_swap',
    pool: inputMint,
    args: {
      proofA: b(64, 1), proofB: b(128, 2), proofC: b(64, 3), root: b(32, 4), inputNullifiers: [nul(nullSeed), nul(nullSeed + 1)], outputCommitments: [b(32, 7), b(32, 8)],
      swapMintField: swapMintField || mintFieldBytes(outputMint), swapAmount, swapCommitment: b(32, 9), outputPool: outputMint,
    },
    extData: { recipient, relayer, extAmount, fee, encryptedOutput1: b(87, 9), encryptedOutput2: b(87, 10), encryptedSwapOutput: b(87, 11) },
  })));
}

function sentTx(i) {
  return web3.VersionedTransaction.deserialize(Buffer.from(rpc.sent[i], 'base64'));
}

/** Resolve a v0 transaction's account keys (static + lookups) with the mocked tables. */
function resolveKeys(tx, relayer) {
  const tables = tx.message.addressTableLookups.map((l) => {
    const addr = l.accountKey.toBase58();
    const data = Buffer.from(rpc.tables[addr], 'base64');
    return new web3.AddressLookupTableAccount({ key: l.accountKey, state: web3.AddressLookupTableAccount.deserialize(data) });
  });
  return tx.message.getAccountKeys({ addressLookupTableAccounts: tables });
}

/* ---------- tests ---------- */

test('swap route config: Jupiter on mainnet, off on devnet, mock-swap as the dev route only', () => {
  const m = loadConfig({ CLUSTER: 'mainnet', RELAYER_ALLOW_MAINNET: '1' });
  assert.equal(m.swap.route, 'jupiter');
  assert.equal(m.swap.program, JUPITER_V6_PROGRAM_ID);
  assert.equal(m.swap.slippageBps, 50);
  assert.equal(m.swap.jupiterApi, 'https://api.jup.ag/swap/v2');
  assert.equal(loadConfig({}).swap.route, '');
  assert.equal(loadConfig({ SWAP_PROGRAM: MOCK_SWAP_PROGRAM_ID }).swap.route, 'mock');
  assert.throws(() => loadConfig({ SWAP_PROGRAM: JUPITER_V6_PROGRAM_ID }), /only exists on mainnet/);
  assert.throws(() => loadConfig({ CLUSTER: 'mainnet', RELAYER_ALLOW_MAINNET: '1', SWAP_PROGRAM: MOCK_SWAP_PROGRAM_ID }), /test-only/);
  assert.throws(() => loadConfig({ SWAP_PROGRAM: newKey() }), /not supported/);
  assert.equal(loadConfig({ CLUSTER: 'mainnet', RELAYER_ALLOW_MAINNET: '1', SWAP_PROGRAM: '' }).swap.route, '');
});

test('GET /swap/quote: Jupiter /build from the escrow, minOut, fee, cache, rate limit, devnet refusal', async () => {
  const jupAlt = makeJupAlt();
  const jf = jupiterFetch({ outAmount: 45_123_456n, jupAlt });
  const relayer = await mainnetRelayer(jf);
  const config = { ...relayer.config, rateLimit: { relayPerMin: 5, readPerMin: 50, quotePerMin: 3 } };
  const indexer = new Indexer({ rpc: new Rpc([rpcUrl]), web3, programId: PROGRAM_ID, tokens: config.tokens, log: quiet });
  const server = http.createServer(createHandler({ config, relayer, indexer, log: quiet }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const info = await (await fetch(base + '/info')).json();
    assert.deepEqual({ enabled: info.swap.enabled, route: info.swap.route, program: info.swap.program, slippageBps: info.swap.slippageBps }, { enabled: true, route: 'jupiter', program: JUPITER_V6_PROGRAM_ID, slippageBps: 50 });
    let res = await fetch(`${base}/swap/quote?inputMint=${WSOL}&outputMint=${USDC}&amount=300000000`);
    assert.equal(res.status, 200);
    const q = await res.json();
    const e = swapEscrowAccounts(web3, PROGRAM_ID, WSOL, USDC);
    assert.equal(jf.calls.length, 1);
    const sp = Object.fromEntries(jf.calls[0].searchParams);
    assert.equal(jf.calls[0].origin + jf.calls[0].pathname, 'https://api.jup.ag/swap/v2/build');
    assert.deepEqual(sp, {
      inputMint: WSOL, outputMint: USDC, amount: '300000000', taker: e.escrow, payer: relayer.address, slippageBps: '50',
      wrapAndUnwrapSol: 'false', destinationTokenAccount: e.escrowOutput, maxAccounts: '20',
    });
    assert.equal(q.outAmount, '45123456');
    assert.equal(q.minOut, ((45_123_456n * 9_950n) / 10_000n).toString());
    assert.equal(q.feeInInputMint, requiredFee(relayer.info(), 'SOL', 300_000_000n).toString());
    assert.equal(q.priceImpactPct, '0.0004');
    assert.equal(q.escrow, e.escrow);
    assert.equal(q.relayerFeeAccount, relayer.address);
    assert.ok(q.expiresAt > Date.now() && q.expiresAt <= Date.now() + 60_000);
    // Cached: the same quote within 10 s does not spend another Jupiter request.
    res = await fetch(`${base}/swap/quote?inputMint=${WSOL}&outputMint=${USDC}&amount=300000000`);
    assert.equal((await res.json()).outAmount, '45123456');
    assert.equal(jf.calls.length, 1);
    assert.equal((await fetch(`${base}/swap/quote?inputMint=${WSOL}&outputMint=${WSOL}&amount=1`)).status, 400);
    assert.equal((await fetch(`${base}/swap/quote?inputMint=${WSOL}&outputMint=${USDC}&amount=-5`)).status, 429); // 4th quote this minute
  } finally {
    server.close();
  }
  // Jupiter refusing (no route) is a clean 400; its rate limit a 429.
  const r2 = await mainnetRelayer(jupiterFetch({ status: 400, error: 'No routes found' }));
  await assert.rejects(r2.quoteSwap({ inputMint: WSOL, outputMint: USDC, amount: '5' }), (err) => err instanceof RelayError && err.status === 400 && /No routes found/.test(err.message));
  const r3 = await mainnetRelayer(jupiterFetch({ status: 429 }));
  await assert.rejects(r3.quoteSwap({ inputMint: WSOL, outputMint: USDC, amount: '5' }), (err) => err.status === 429);
  // Devnet has no Jupiter: a clear "needs mainnet" error.
  const dev = new Relayer({ web3, connection: new web3.Connection(rpcUrl), keypair: web3.Keypair.generate(), config: loadConfig({ RPC_URL: rpcUrl }), log: quiet });
  assert.equal(dev.info().swap.enabled, false);
  await assert.rejects(dev.quoteSwap({ inputMint: WSOL, outputMint: DEV_USDC, amount: '5' }), /only exists on Solana mainnet/);
  const devBody = swapBody({ inputMint: WSOL, outputMint: DEV_USDC, recipient: swapEscrowAccounts(web3, PROGRAM_ID, WSOL, DEV_USDC).escrow, relayer: dev.address, extAmount: -300_000_000n, fee: 3_000_000n, swapAmount: 1n });
  await assert.rejects(dev.relay(devBody), (err) => err.status === 400 && /mainnet/.test(err.message));
});

test('relay transact_swap (Jupiter): route accounts as remaining_accounts in order, escrow ATAs created, fits 1232 bytes with lookup tables', async () => {
  const jupAlt = makeJupAlt();
  const jf = jupiterFetch({ outAmount: 45_500_000n, jupAlt });
  const r = await mainnetRelayer(jf);
  const e = swapEscrowAccounts(web3, PROGRAM_ID, WSOL, USDC);
  const surplus = associatedTokenAddress(web3, r.address, USDC).toBase58();
  // escrow wSOL input account and relayer USDC account exist; the escrow USDC account does not yet.
  rpc.accounts = new Set([e.escrowInput, surplus]);
  rpc.sent = [];
  rpc.simErr = null;
  rpc.calls = [];
  const body = swapBody({ inputMint: WSOL, outputMint: USDC, recipient: e.escrow, relayer: r.address, extAmount: -300_000_000n, fee: 3_000_000n, swapAmount: 45_000_000n });
  const out = await r.relay(body);
  assert.ok(out.signature);
  assert.equal(out.outAmount, '45500000');
  assert.ok(rpc.calls.some((c) => c.method === 'simulateTransaction'));
  const tx = sentTx(rpc.sent.length - 1);
  const size = tx.serialize().length;
  assert.ok(size <= 1232, `swap tx is ${size} bytes`);
  console.log(`# SOL→USDC Jupiter swap tx: ${size} bytes, ${rpc.sent.length} transaction(s)`);
  assert.equal(tx.message.addressTableLookups.length, 2); // relayer table + Jupiter's table
  const keys = resolveKeys(tx);
  const progOf = (ix) => keys.get(ix.programIdIndex).toBase58();
  const ix = tx.message.compiledInstructions.find((i) => progOf(i) === PROGRAM_ID);
  const accts = ix.accountKeyIndexes.map((i) => keys.get(i).toBase58());
  // fixed accounts (programs/README.md)
  assert.equal(accts[0], r.address);
  assert.equal(accts[1], configPda(web3, PROGRAM_ID).toBase58());
  assert.equal(accts[2], poolPda(web3, PROGRAM_ID, WSOL).toBase58());
  assert.equal(accts[3], treePda(web3, PROGRAM_ID, WSOL).toBase58());
  assert.equal(accts[4], vaultPda(web3, PROGRAM_ID, WSOL).toBase58());
  assert.equal(accts[5], nullifierPda(web3, PROGRAM_ID, Buffer.from(body.args.inputNullifiers[0], 'base64')).toBase58());
  assert.equal(accts[7], r.address);
  assert.equal(accts[8], e.escrow);
  assert.equal(accts[9], e.escrowInput);
  assert.equal(accts[10], e.escrowOutput);
  assert.equal(accts[11], poolPda(web3, PROGRAM_ID, USDC).toBase58());
  assert.equal(accts[13], vaultPda(web3, PROGRAM_ID, USDC).toBase58());
  assert.equal(accts[14], surplus);
  assert.equal(accts[15], JUPITER_V6_PROGRAM_ID);
  // remaining accounts: exactly Jupiter's swapInstruction accounts, in order
  const build = jupiterBuild(jf.calls[jf.calls.length - 1].searchParams, { outAmount: 45_500_000n, jupAlt });
  assert.deepEqual(accts.slice(18), build.swapInstruction.accounts.map((a) => a.pubkey));
  // the escrow is not a signer of the outer transaction (the program signs for it in the CPI)
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  assert.deepEqual(signers, [r.address]);
  // writable flags copied from Jupiter for route accounts
  for (let i = 0; i < build.swapInstruction.accounts.length; i++) {
    const a = build.swapInstruction.accounts[i];
    if ([e.escrow, e.escrowInput, e.escrowOutput, USDC, WSOL, TOKEN_PROGRAM_ID].includes(a.pubkey)) continue; // shared with fixed accounts
    assert.equal(tx.message.isAccountWritable(ix.accountKeyIndexes[18 + i]), a.isWritable, `route account ${i}`);
  }
  // instruction data: the proof args + swap args, swap_data = Jupiter's swapInstruction.data
  const expected = await transactSwapInstructionData({ ...argsFromRelay(parseRelayRequest(body)), swapData: Buffer.from(build.swapInstruction.data, 'base64') });
  assert.deepEqual([...ix.data], [...expected]);
  const dec = decodeTransactArgs(Uint8Array.from(ix.data));
  assert.equal(readU64LE(dec.rest, 0), 45_000_000n);
  // the missing escrow USDC account is created idempotently by the relayer before the swap
  const allIxs = rpc.sent.map((_, i) => sentTx(i)).flatMap((t) => {
    const k = resolveKeys(t);
    return t.message.compiledInstructions.map((i) => ({ prog: k.get(i.programIdIndex).toBase58(), accts: i.accountKeyIndexes.map((j) => k.get(j).toBase58()), data: [...i.data] }));
  });
  const creates = allIxs.filter((i) => i.prog === ASSOCIATED_TOKEN_PROGRAM_ID);
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].accts.slice(0, 4), [r.address, e.escrowOutput, e.escrow, USDC]);
  assert.deepEqual(creates[0].data, [1]);
  // compute budget: 1.4M units
  const cb = allIxs.find((i) => i.prog === 'ComputeBudget111111111111111111111111111111' && i.data[0] === 2);
  assert.equal(Buffer.from(cb.data).readUInt32LE(1), 1_400_000);
  rpc.accounts = new Set();
});

test('relay transact_swap: refuses a route below swapAmount, tightens slippage, rejects bad fields and routes', async () => {
  const jupAlt = makeJupAlt();
  const e = swapEscrowAccounts(web3, PROGRAM_ID, WSOL, USDC);
  const base = (r, over = {}) => swapBody({ inputMint: WSOL, outputMint: USDC, recipient: e.escrow, relayer: r.address, extAmount: -300_000_000n, fee: 3_000_000n, swapAmount: 45_000_000n, ...over });
  rpc.simErr = null;

  // outAmount < swapAmount: refused before anything is signed
  let r = await mainnetRelayer(jupiterFetch({ outAmount: 44_999_999n, jupAlt }));
  rpc.sent = [];
  await assert.rejects(r.relay(base(r)), (err) => err.status === 409 && /Price moved/.test(err.message));
  assert.equal(rpc.sent.length, 0);

  // outAmount OK but Jupiter's own minimum (otherAmountThreshold) below swapAmount: re-built with
  // a tighter slippage so the route's on-chain check also guarantees swapAmount.
  const jf = jupiterFetch((u, n) => ({ outAmount: 45_100_000n, otherAmountThreshold: n === 1 ? 44_900_000n : undefined, jupAlt }));
  r = await mainnetRelayer(jf);
  await r.relay(base(r));
  assert.equal(jf.calls.length, 2);
  assert.equal(jf.calls[1].searchParams.get('slippageBps'), String(Math.floor((100_000 * 10_000) / 45_100_000)));
  // threshold still too low after re-building → refused
  r = await mainnetRelayer(jupiterFetch({ outAmount: 45_100_000n, otherAmountThreshold: 44_000_000n, jupAlt }));
  rpc.sent = [];
  await assert.rejects(r.relay(base(r)), (err) => err.status === 409);
  assert.equal(rpc.sent.length, 0);

  r = await mainnetRelayer(jupiterFetch({ outAmount: 46_000_000n, jupAlt }));
  const status = async (body) => {
    try {
      await r.relay(body);
      return 200;
    } catch (err) {
      assert.ok(err instanceof RelayError, err.stack);
      return err.status;
    }
  };
  assert.equal(await status(base(r, { recipient: newKey() })), 400); // not the escrow
  assert.equal(await status(base(r, { relayer: newKey() })), 400); // not the fee account
  assert.equal(await status(base(r, { fee: 899_999n })), 400); // 0.3% of 0.3 SOL = 900_000 < min 3_000_000
  assert.equal(await status(base(r, { swapMintField: mintFieldBytes(WSOL) })), 400);
  assert.equal(await status(base(r, { extAmount: 0n })), 400);
  assert.equal(await status(base(r, { outputMint: WSOL })), 400); // same mint
  assert.equal(await status(base(r)), 200);
  // a route through another program, or needing another signer, is never signed
  r = await mainnetRelayer(jupiterFetch({ outAmount: 46_000_000n, jupAlt, programId: newKey() }));
  assert.equal(await status(base(r)), 502);
  r = await mainnetRelayer(jupiterFetch({ outAmount: 46_000_000n, jupAlt, extraSigner: newKey() }));
  assert.equal(await status(base(r)), 502);
  // failed simulation: nothing sent
  r = await mainnetRelayer(jupiterFetch({ outAmount: 46_000_000n, jupAlt }));
  rpc.simErr = { InstructionError: [2, { Custom: 6020 }] };
  rpc.sent = [];
  assert.equal(await status(base(r)), 400);
  assert.equal(rpc.sent.length, 0);
  rpc.simErr = null;
  // without the relayer's lookup table the swap does not fit: clear refusal (after one smaller-route retry)
  const jf2 = jupiterFetch({ outAmount: 46_000_000n, jupAlt });
  r = await mainnetRelayer(jf2, { withTable: false });
  rpc.sent = [];
  await assert.rejects(r.relay(base(r)), /RELAYER_LOOKUP_TABLE/);
  assert.equal(rpc.sent.length, 0);
  assert.deepEqual(jf2.calls.map((u) => u.searchParams.get('maxAccounts')), ['20', '10']);
});

test('relay transact_swap USDC→SOL: escrow wSOL output account (closed by every swap) is re-created first; SOL surplus to the relayer', async () => {
  const jupAlt = makeJupAlt();
  const r = await mainnetRelayer(jupiterFetch({ outAmount: 2_010_000_000n, jupAlt }));
  const e = swapEscrowAccounts(web3, PROGRAM_ID, USDC, WSOL);
  const feeAcct = associatedTokenAddress(web3, r.address, USDC).toBase58();
  rpc.accounts = new Set([e.escrowInput]); // the wSOL output account does not exist
  rpc.sent = [];
  const body = swapBody({ inputMint: USDC, outputMint: WSOL, recipient: e.escrow, relayer: feeAcct, extAmount: -300_000_000n, fee: 900_000n, swapAmount: 2_000_000_000n });
  const out = await r.relay(body);
  assert.ok(out.signature);
  const txs = rpc.sent.map((_, i) => sentTx(i));
  const ixs = txs.flatMap((t) => {
    const k = resolveKeys(t);
    return t.message.compiledInstructions.map((i) => ({ prog: k.get(i.programIdIndex).toBase58(), accts: i.accountKeyIndexes.map((j) => k.get(j).toBase58()) }));
  });
  const createAt = ixs.findIndex((i) => i.prog === ASSOCIATED_TOKEN_PROGRAM_ID);
  const swapAt = ixs.findIndex((i) => i.prog === PROGRAM_ID);
  assert.ok(createAt >= 0 && createAt < swapAt, 'escrow wSOL account created before the swap');
  assert.deepEqual(ixs[createAt].accts.slice(0, 4), [r.address, e.escrowOutput, e.escrow, WSOL]);
  const swapIx = ixs[swapAt];
  assert.equal(swapIx.accts[7], feeAcct); // fee in the input mint (USDC)
  assert.equal(swapIx.accts[10], e.escrowOutput); // escrow wSOL ATA
  assert.equal(swapIx.accts[13], vaultPda(web3, PROGRAM_ID, WSOL).toBase58()); // SOL vault PDA
  assert.equal(swapIx.accts[14], r.address); // SOL surplus: the relayer's own account
  for (const t of txs) assert.ok(t.serialize().length <= 1232);
  console.log(`# USDC→SOL swap: ${out.setupSignature ? 'separate setup tx' : 'setup inline'}, sizes ${txs.map((t) => t.serialize().length).join(', ')} bytes`);
  if (out.setupSignature) assert.equal(txs.length, 2); // setup sent and confirmed separately when it does not fit inline
  rpc.accounts = new Set();
});

test('relay transact_swap via the mock-swap dev route (devnet, SWAP_PROGRAM override)', async () => {
  const config0 = loadConfig({ RPC_URL: rpcUrl, POOL_MINT_USDT: '', SWAP_PROGRAM: MOCK_SWAP_PROGRAM_ID, SWAP_MOCK_RATES: '{"SOL/USDC":150}' });
  const keypair = web3.Keypair.generate();
  const table = newKey();
  rpc.tables[table] = altData(lookupTableAddresses(web3, config0, keypair.publicKey.toBase58()), keypair.publicKey.toBase58());
  const r = new Relayer({ web3, connection: new web3.Connection(rpcUrl, 'confirmed'), keypair, config: { ...config0, lookupTable: table }, log: quiet, fetch: async () => assert.fail('no Jupiter on the dev route') });
  await r.loadLookupTable();
  assert.deepEqual({ enabled: r.info().swap.enabled, route: r.info().swap.route }, { enabled: true, route: 'mock' });
  const q = await r.quoteSwap({ inputMint: WSOL, outputMint: DEV_USDC, amount: '300000000' });
  assert.equal(q.outAmount, '45000000'); // 0.3 SOL × 150
  assert.equal(q.minOut, '44775000');
  // USDC → SOL uses the inverse rate
  assert.equal((await r.quoteSwap({ inputMint: DEV_USDC, outputMint: WSOL, amount: '150000000' })).outAmount, '1000000000');

  const e = swapEscrowAccounts(web3, PROGRAM_ID, WSOL, DEV_USDC);
  rpc.accounts = new Set([e.escrowInput, e.escrowOutput, associatedTokenAddress(web3, r.address, DEV_USDC).toBase58()]);
  rpc.sent = [];
  const body = swapBody({ inputMint: WSOL, outputMint: DEV_USDC, recipient: e.escrow, relayer: r.address, extAmount: -300_000_000n, fee: 3_000_000n, swapAmount: BigInt(q.minOut) });
  await r.relay(body);
  assert.equal(rpc.sent.length, 1); // nothing to create
  const tx = sentTx(0);
  assert.ok(tx.serialize().length <= 1232, `mock swap tx is ${tx.serialize().length} bytes`);
  const keys = resolveKeys(tx);
  const ix = tx.message.compiledInstructions.find((i) => keys.get(i.programIdIndex).toBase58() === PROGRAM_ID);
  const accts = ix.accountKeyIndexes.map((i) => keys.get(i).toBase58());
  assert.equal(accts[15], MOCK_SWAP_PROGRAM_ID);
  const reserve = mockReserveAuthority(web3).toBase58();
  // programs/mock-swap `Swap` order, as in the LiteSVM transact_swap test
  assert.deepEqual(accts.slice(18), [e.escrow, e.escrowInput, associatedTokenAddress(web3, reserve, WSOL).toBase58(), associatedTokenAddress(web3, reserve, DEV_USDC).toBase58(), e.escrowOutput, reserve, TOKEN_PROGRAM_ID]);
  const dec = decodeTransactArgs(Uint8Array.from(ix.data));
  const swapData = dec.rest.slice(131);
  assert.deepEqual([...swapData], [...(await mockSwapData(300_000_000n, 45_000_000n))]);
  // a guaranteed amount above the mock's fixed output is refused
  await assert.rejects(r.relay(swapBody({ inputMint: WSOL, outputMint: DEV_USDC, recipient: e.escrow, relayer: r.address, extAmount: -300_000_000n, fee: 3_000_000n, swapAmount: 45_000_001n })), (err) => err.status === 409);
  rpc.accounts = new Set();
});
