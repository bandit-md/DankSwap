// End-to-end test of private.html in Chromium: mock Wallet Standard wallet (with signMessage),
// mocked relayer and devnet RPC, and REAL Groth16 proofs generated in the browser's Web Worker
// from assets/zk/. Run: NODE_PATH=$(npm root -g) node tests/pool.e2e.mjs   (needs `playwright`,
// and `cd relayer && npm install` for @solana/web3.js). Set SCREENSHOTS=dir to save screenshots.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import nacl from '../assets/vendor/tweetnacl.min.js';
import { UNLOCK_MESSAGE } from '../assets/js/pool/keys.js';
import { base58Encode, bytesToHex, fieldToBytes, base64ToBytes, bytesToBase64, utf8, FIELD_SIZE } from '../assets/js/pool/util.js';
import { MerkleTree } from '../assets/js/pool/merkle.js';
import { decodeTransactArgs, encodeProof, extDataHash, parseRelayRequest, publicAmount } from '../assets/js/pool/encode.js';
import { configPda, poolPda, escrowPda, nullifierPda } from '../assets/js/pool/accounts.js';
import { mintField, mintFieldBytes, decryptOutput, commitmentHash } from '../assets/js/pool/note.js';
import { deriveKeys } from '../assets/js/pool/keys.js';
import { requiredFee } from '../assets/js/pool/fees.js';
import { swapMinOut, MOCK_SWAP_PROGRAM_ID } from '../assets/js/pool/swap.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const web3 = require(join(ROOT, 'relayer', 'node_modules', '@solana', 'web3.js'));
const shots = process.env.SCREENSHOTS;
const step = (msg) => { if (process.env.DEBUG) console.log('step:', msg); };

const PROGRAM_ID = 'FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6';
const WSOL = 'So11111111111111111111111111111111111111112';
const DEV_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const RELAYER = web3.Keypair.generate().publicKey.toBase58();
const RECIPIENT = web3.Keypair.generate().publicKey.toBase58();
const ZK = ['transaction.wasm', 'transaction_final.zkey', 'verification_key.json'].map((f) => join(ROOT, 'assets', 'zk', f));
const REAL = ZK.every(existsSync);

// Wallet key: the unlock signature is deterministic (ed25519), so it is computed here.
const walletKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
const OWNER = base58Encode(walletKp.publicKey);
const UNLOCK_SIG = Array.from(nacl.sign.detached(utf8(UNLOCK_MESSAGE), walletKp.secretKey));

const mockWallet = `
(() => {
  const account = { address: '${OWNER}', publicKey: new Uint8Array(${JSON.stringify(Array.from(walletKp.publicKey))}), chains: ['solana:devnet', 'solana:mainnet'], features: ['solana:signTransaction', 'solana:signMessage'] };
  window.__signed = [];
  window.__signedChains = [];
  window.__messages = 0;
  const wallet = {
    version: '1.0.0', name: 'Mock Wallet',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#f0f"/></svg>'),
    chains: ['solana:mainnet', 'solana:devnet'], accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { wallet.accounts = [account]; return { accounts: [account] }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => inputs.map((i) => {
        window.__messages++;
        return { signedMessage: i.message, signature: new Uint8Array(${JSON.stringify(UNLOCK_SIG)}) };
      }) },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => inputs.map((i) => {
        window.__signed.push(Array.from(i.transaction));
        window.__signedChains.push(i.chain);
        return { signedTransaction: i.transaction };
      }) },
    },
  };
  const cb = ({ register }) => register(wallet);
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb })); } catch (e) {}
  window.addEventListener('wallet-standard:app-ready', (e) => cb(e.detail));
})();
`;

async function main() {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const leaves = []; // relayer index (SOL pool)
  const tree = new MerkleTree(20);
  const usdcLeaves = []; // relayer index (USDC pool)
  const usdcTree = new MerkleTree(20);
  const spentPdas = new Set(); // nullifier accounts the program would have created
  const markSpent = (b) => b.args.inputNullifiers.forEach((n) => spentPdas.add(nullifierPda(web3, PROGRAM_ID, base64ToBytes(n)).toBase58()));
  let swapOn = false; // relayer advertises the dev swap route (mock-swap)
  const quotes = [];
  const relayed = [];
  const sent = [];
  const configKey = configPda(web3, PROGRAM_ID).toBase58();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  // Point the page at the mocked relayer and RPC (the shipped config has no relayer URL).
  await ctx.route('**/assets/js/pool/config.js', async (r) => {
    const src = readFileSync(join(ROOT, 'assets', 'js', 'pool', 'config.js'), 'utf8')
      .replace("RELAYER_URL: '',", "RELAYER_URL: 'https://relayer.test',")
      .replace("devnet: ['https://api.devnet.solana.com'],", "devnet: ['https://rpc.test'],");
    await r.fulfill({ body: src, contentType: 'text/javascript; charset=utf-8' });
  });
  await ctx.route('https://relayer.test/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    if (u.pathname === '/info') {
      const info = { relayer: RELAYER, feeBps: 30, minFeeLamports: { SOL: 3_000_000, USDC: 500_000, USDT: 500_000 }, createAtaFee: { USDC: 500_000, USDT: 500_000 }, cluster: 'devnet', programId: PROGRAM_ID };
      if (swapOn) info.swap = { enabled: true, route: 'mock', program: MOCK_SWAP_PROGRAM_ID, slippageBps: 50, swapFeeBps: 0, quoteTtlMs: 60_000, reason: '' };
      return r.fulfill({ headers: cors, json: info });
    }
    if (u.pathname === '/swap/quote') {
      const q = Object.fromEntries(u.searchParams);
      quotes.push(q);
      const amount = BigInt(q.amount);
      const outAmount = (amount * 150n) / 1000n; // 150 USDC per SOL
      return r.fulfill({ headers: cors, json: {
        inputMint: q.inputMint, outputMint: q.outputMint, amount: q.amount, outAmount: outAmount.toString(), otherAmountThreshold: outAmount.toString(),
        minOut: swapMinOut(outAmount, 50).toString(), feeInInputMint: '3000000', slippageBps: 50, swapFeeBps: 0, priceImpactPct: '0.0021', route: 'mock', expiresAt: Date.now() + 60_000,
      } });
    }
    if (u.pathname === '/commitments') {
      const from = Number(u.searchParams.get('from'));
      const pool = u.searchParams.get('pool');
      const [L, T] = pool === WSOL ? [leaves, tree] : pool === DEV_USDC ? [usdcLeaves, usdcTree] : [[], new MerkleTree(20)];
      return r.fulfill({ headers: cors, json: { items: L.slice(from), nextIndex: L.length, root: bytesToHex(fieldToBytes(T.root())) } });
    }
    if (u.pathname === '/relay') {
      relayed.push(JSON.parse(req.postData()));
      return r.fulfill({ headers: cors, json: { signature: '4relayedSignature' } });
    }
    return r.fulfill({ status: 404, headers: cors, json: { error: 'nope' } });
  });
  await ctx.route('https://rpc.test/**', async (r) => {
    const body = JSON.parse(r.request().postData());
    const ok = (result) => r.fulfill({ headers: cors, json: { jsonrpc: '2.0', id: body.id, result } });
    const ctxSlot = { slot: 1 };
    switch (body.method) {
      case 'getAccountInfo': return ok({ context: ctxSlot, value: body.params[0] === configKey ? { data: ['', 'base64'], executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0 } : null });
      case 'getBalance': return ok({ context: ctxSlot, value: 2_000_000_000 });
      case 'getTokenAccountsByOwner': return ok({ context: ctxSlot, value: [] });
      case 'getMultipleAccounts': return ok({ context: ctxSlot, value: body.params[0].map((k) => (spentPdas.has(k) ? { data: ['', 'base64'], executable: false, lamports: 946_560, owner: PROGRAM_ID, rentEpoch: 0 } : null)) });
      case 'getLatestBlockhash': return ok({ context: ctxSlot, value: { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 1000 } });
      case 'sendTransaction': sent.push(body.params[0]); return ok('5shieldSignature');
      case 'getSignatureStatuses': return ok({ context: ctxSlot, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
      case 'getBlockHeight': return ok(10);
      default: return r.fulfill({ headers: cors, json: { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: body.method } } });
    }
  });

  await ctx.addInitScript(mockWallet);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.DEBUG) page.on('console', (m) => console.log('page:', m.type(), m.text()));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts|ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  const cta = page.locator('#cta');
  const ctaText = () => page.evaluate(() => document.querySelector('#cta').textContent);

  // 1. Page loads: banner, devnet tag, pool detected as deployed
  step('1. Page loads: banner, devnet tag, pool det');
  await page.goto(base + '/private.html');
  assert.equal(await page.isVisible('#pvBanner'), true);
  assert.match(await page.textContent('#pvBanner'), /Unaudited devnet preview/);
  await page.waitForFunction(() => window.__pool && window.__pool.state.deployed === true);
  assert.equal(await page.isHidden('#poolNotice'), true);
  assert.equal(await ctaText(), 'Connect wallet');

  // 2. Connect
  step('2. Connect');
  await page.click('#unlockBtn');
  await page.waitForSelector('#walletModal.open');
  await page.click('#walletList .list-item');
  await page.waitForFunction((o) => document.querySelector('#walletBtn').textContent.includes(o.slice(0, 4)), OWNER);
  await page.waitForFunction(() => document.querySelector('#availText').textContent === 'Wallet 1.99');

  // 3. Unlock (signMessage), empty balance discovered from the relayer index
  step('3. Unlock (signMessage), empty balance disc');
  await page.click('#unlockBtn');
  await page.waitForFunction(() => window.__pool.state.unlocked);
  assert.equal(await page.evaluate(() => window.__messages), 1);
  assert.match(await page.textContent('#shieldedAddr'), /^dank[1-9A-HJ-NP-Za-km-z]{80,}$/);
  await page.waitForFunction(() => document.querySelector('#balList li[data-symbol="SOL"] .v').textContent === '0 SOL');
  assert.match(await page.textContent('#balList li[data-symbol="USDT"]'), /No pool on devnet/);

  // 4. Tabs: Swap disabled on devnet; keyboard navigation
  step('4. Tabs: Swap disabled on devnet; keyboard ');
  await page.click('#tab-swap');
  assert.equal(await ctaText(), 'Swap: mainnet only');
  assert.equal(await cta.isDisabled(), true);
  await page.focus('#tab-swap');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => window.__pool.state.tab), 'shield');

  // 5. Shield 0.5 SOL: real proof in the browser worker
  step('5. Shield 0.5 SOL: real proof in the browse');
  await page.fill('#amountInput', '0.5');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Shield 0.5 SOL');
  assert.match(await page.textContent('#dFee'), /SOL/);
  if (!REAL) throw new Error('fixtures missing: assets/zk/transaction.wasm, transaction_final.zkey, verification_key.json');
  const t0 = Date.now();
  await cta.click();
  await page.waitForSelector('#progress:not([hidden])');
  await page.waitForSelector('.toast.ok >> text=Shielded', { timeout: 300_000 });
  const shieldMs = Date.now() - t0;
  const shieldLast = await page.evaluate(() => window.__pool.last);
  assert.equal(sent.length, 1);
  assert.deepEqual(await page.evaluate(() => window.__signedChains), ['solana:devnet']);

  // Check the transaction the wallet signed and the page sent, against the SDK and the vk.
  const snarkjs = require(join(ROOT, 'circuits', 'node_modules', 'snarkjs'));
  const vk = JSON.parse(readFileSync(ZK[2], 'utf8'));
  const vtx = web3.VersionedTransaction.deserialize(base64ToBytes(sent[0]));
  const keys = vtx.message.staticAccountKeys.map((k) => k.toBase58());
  assert.equal(keys[0], OWNER);
  const ix = vtx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === PROGRAM_ID);
  const accts = ix.accountKeyIndexes.map((i) => keys[i]);
  assert.equal(accts[2], poolPda(web3, PROGRAM_ID, WSOL).toBase58());
  assert.equal(accts[7], OWNER);
  assert.equal(accts[8], OWNER);
  assert.equal(accts[9], PROGRAM_ID); // optional signer_token_account = None for SOL
  const args = decodeTransactArgs(Uint8Array.from(ix.data));
  assert.equal(args.extAmount, 500_000_000n);
  assert.equal(args.fee, 0n);
  const ps = shieldLast.publicSignals;
  assert.equal(ps[0], new MerkleTree(20).root().toString());
  assert.equal(ps[1], publicAmount(500_000_000n, 0n).toString());
  assert.equal(ps[3], mintField(WSOL).toString());
  const edh = await extDataHash({ recipient: accts[7], relayer: accts[8], extAmount: args.extAmount, fee: args.fee, encryptedOutput1: args.encryptedOutput1, encryptedOutput2: args.encryptedOutput2 });
  assert.equal(ps[2], edh.toString(), 'extDataHash from the sent instruction matches the proof');
  assert.equal(bytesToHex(args.inputNullifiers[0]), bytesToHex(fieldToBytes(BigInt(ps[4]))));
  assert.equal(bytesToHex(args.outputCommitments[1]), bytesToHex(fieldToBytes(BigInt(ps[7]))));
  const enc = encodeProof(shieldLast.proof);
  assert.equal(bytesToHex(args.proofA), bytesToHex(enc.proofA));
  assert.equal(bytesToHex(args.proofB), bytesToHex(enc.proofB));
  assert.ok(await snarkjs.groth16.verify(vk, ps, shieldLast.proof), 'browser proof verifies');
  if (shots) await page.screenshot({ path: `${shots}/private-shield.png` });

  // 6. The program would append both commitments: the index serves them, the page finds the note.
  step('6. The program would append both commitment');
  for (let i = 0; i < 2; i++) {
    const c = BigInt(ps[6 + i]);
    leaves.push({ index: leaves.length, commitment: bytesToHex(fieldToBytes(c)), encryptedOutput: bytesToBase64(i === 0 ? args.encryptedOutput1 : args.encryptedOutput2) });
    tree.insert(c);
  }
  await page.click('#refreshBtn');
  await page.waitForFunction(() => document.querySelector('#balList li[data-symbol="SOL"] .v').textContent === '0.5 SOL');

  // 7. Unshield 0.1 SOL to another address: relay request with the right fields, real proof
  step('7. Unshield 0.1 SOL to another address: rel');
  await page.click('#tab-unshield');
  await page.fill('#toInput', 'not-an-address');
  await page.fill('#amountInput', '0.1');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Enter a valid Solana address');
  await page.fill('#toInput', RECIPIENT);
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Unshield 0.1 SOL');
  assert.equal(await page.textContent('#dFee'), '0.003 SOL');
  assert.equal(await page.textContent('#dTotal'), '0.103 SOL');
  const t1 = Date.now();
  await cta.click();
  await page.waitForSelector('.toast.ok >> text=Unshielded', { timeout: 300_000 });
  const unshieldMs = Date.now() - t1;
  assert.equal(relayed.length, 1);
  const body = relayed[0];
  assert.equal(body.instruction, 'transact');
  assert.equal(body.pool, WSOL);
  assert.equal(body.extData.recipient, RECIPIENT);
  assert.equal(body.extData.relayer, RELAYER);
  assert.equal(body.extData.extAmount, '-100000000');
  assert.equal(body.extData.fee, '3000000');
  const p = parseRelayRequest(body);
  const unLast = await page.evaluate(() => window.__pool.last);
  assert.equal(bytesToHex(p.args.root), bytesToHex(fieldToBytes(tree.root())));
  assert.equal(unLast.publicSignals[0], tree.root().toString());
  assert.equal(unLast.publicSignals[1], (FIELD_SIZE - 103_000_000n).toString());
  assert.equal(unLast.publicSignals[2], (await extDataHash(p.extData)).toString());
  assert.equal(bytesToHex(p.args.proofA), bytesToHex(encodeProof(unLast.proof).proofA));
  assert.ok(await snarkjs.groth16.verify(vk, unLast.publicSignals, unLast.proof), 'unshield proof verifies');
  // the spent note is hidden right away
  await page.waitForFunction(() => document.querySelector('#balList li[data-symbol="SOL"] .v').textContent === '0 SOL');

  // 8. Send privately validates dank addresses
  step('8. Send privately validates dank addresses');
  await page.click('#tab-send');
  await page.fill('#toInput', RECIPIENT);
  await page.fill('#amountInput', '0.01');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Enter a valid dank… address');

  // The program appended the unshield's outputs (the 0.397 SOL change note) and created its nullifiers.
  markSpent(body);
  for (let i = 0; i < 2; i++) {
    const c = BigInt(unLast.publicSignals[6 + i]);
    leaves.push({ index: leaves.length, commitment: bytesToHex(fieldToBytes(c)), encryptedOutput: i === 0 ? body.extData.encryptedOutput1 : body.extData.encryptedOutput2 });
    tree.insert(c);
  }

  // 9. Private swap through a relayer that offers the dev swap route: SOL → USDC, real proof with swap fields.
  step('9. Private swap SOL → USDC');
  swapOn = true;
  await page.reload();
  await page.waitForFunction(() => window.__pool && window.__pool.state.deployed === true);
  await page.waitForFunction((o) => document.querySelector('#walletBtn').textContent.includes(o.slice(0, 4)), OWNER); // silent reconnect
  await page.click('#unlockBtn');
  await page.waitForFunction(() => window.__pool.state.unlocked);
  await page.waitForFunction(() => document.querySelector('#balList li[data-symbol="SOL"] .v').textContent === '0.397 SOL');
  await page.click('#tab-swap');
  await page.waitForFunction(() => window.__pool.state.swap === true);
  assert.equal(await page.isVisible('#formFields'), true);
  assert.equal(await page.isVisible('#toTokenSeg'), true);
  assert.equal(await page.isHidden('#toWrap'), true);
  assert.match(await page.textContent('#swapText'), /dev route/);
  assert.equal(await page.evaluate(() => window.__pool.state.toToken), 'USDC');
  assert.equal(await page.isDisabled('#toTokenSeg [data-symbol="SOL"]'), true); // cannot swap SOL to SOL
  await page.click('#tokenSeg [role="radio"]:has-text("SOL")');
  await page.fill('#amountInput', '0.1');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Swap 0.1 SOL → USDC', null, { timeout: 15_000 });
  assert.deepEqual(quotes[quotes.length - 1], { inputMint: WSOL, outputMint: DEV_USDC, amount: '100000000' });
  assert.equal(await page.textContent('#dOut'), '≈ 15 USDC');
  assert.equal(await page.textContent('#dMin'), '14.925 USDC');
  assert.equal(await page.textContent('#dImpact'), '0.21%');
  assert.equal(await page.textContent('#dFee'), '0.003 SOL');
  assert.equal(await page.textContent('#dTotal'), '0.103 SOL');
  if (shots) await page.screenshot({ path: `${shots}/private-swap.png` });
  const t2 = Date.now();
  await cta.click();
  await page.waitForSelector('.toast.ok >> text=Swapped privately', { timeout: 300_000 });
  const swapMs = Date.now() - t2;
  assert.equal(relayed.length, 2);
  const sb = relayed[1];
  const swLast = await page.evaluate(() => window.__pool.last);
  const escrow = escrowPda(web3, PROGRAM_ID, poolPda(web3, PROGRAM_ID, WSOL)).toBase58();
  assert.equal(sb.instruction, 'transact_swap');
  assert.equal(sb.pool, WSOL);
  assert.equal(sb.args.outputPool, DEV_USDC);
  assert.equal(sb.args.swapAmount, '14925000');
  assert.equal(sb.args.swapData, '');
  assert.equal(sb.extData.recipient, escrow);
  assert.equal(sb.extData.relayer, RELAYER);
  assert.equal(sb.extData.extAmount, '-100000000');
  assert.equal(sb.extData.fee, requiredFee({ feeBps: 30, minFeeLamports: { SOL: 3_000_000 } }, 'SOL', 100_000_000n).toString());
  const sp = parseRelayRequest(sb);
  assert.equal(bytesToHex(sp.args.swapMintField), bytesToHex(mintFieldBytes(DEV_USDC)));
  const sps = swLast.publicSignals;
  assert.equal(sps[0], tree.root().toString());
  assert.equal(sps[1], (FIELD_SIZE - 103_000_000n).toString());
  assert.equal(sps[2], (await extDataHash(sp.extData)).toString(), 'extDataHash binds escrow, relayer and the encrypted swap output');
  assert.equal(sps[3], mintField(WSOL).toString());
  assert.equal(sps[8], mintField(DEV_USDC).toString());
  assert.equal(sps[9], '14925000');
  assert.equal(sps[10], BigInt('0x' + bytesToHex(sp.args.swapCommitment)).toString());
  assert.equal(bytesToHex(sp.args.proofA), bytesToHex(encodeProof(swLast.proof).proofA));
  assert.ok(await snarkjs.groth16.verify(vk, sps, swLast.proof), 'swap proof (generated in the browser) verifies');
  // the swap note is encrypted to the user's own key and matches swapCommitment
  const userKeys = await deriveKeys(Uint8Array.from(UNLOCK_SIG));
  const dec = decryptOutput(sp.extData.encryptedSwapOutput, userKeys.encSecret);
  assert.equal(dec.amount, 14_925_000n);
  assert.equal(commitmentHash(dec.amount, userKeys.pubKey, dec.blinding, mintField(DEV_USDC)).toString(), sps[10]);
  await page.waitForFunction(() => document.querySelector('#balList li[data-symbol="SOL"] .v').textContent === '0 SOL');
  // the program appends swapCommitment to the USDC tree; the page finds the new note there
  usdcLeaves.push({ index: 0, commitment: bytesToHex(fieldToBytes(BigInt(sps[10]))), encryptedOutput: sb.extData.encryptedSwapOutput });
  usdcTree.insert(BigInt(sps[10]));
  await page.click('#refreshBtn');
  await page.waitForFunction(() => document.querySelector('#balList li[data-symbol="USDC"] .v').textContent === '14.925 USDC');

  // 9b. Unshield without a relayer: the wallet signs and pays, fee 0, the relayer is not contacted.
  step('9b. Self-relay unshield 5 USDC');
  const signedBefore = await page.evaluate(() => window.__signed.length);
  await page.click('#tab-unshield');
  await page.click('#tokenSeg [role="radio"]:has-text("USDC")');
  await page.check('#selfRelay');
  assert.equal(await page.isVisible('#selfRelayHint'), true);
  assert.match(await page.textContent('#selfRelayHint'), /linking it to the destination/);
  await page.fill('#toInput', RECIPIENT);
  await page.fill('#amountInput', '5');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Unshield 5 USDC');
  assert.equal(await page.textContent('#dFeeLabel'), 'Paid by your wallet');
  assert.equal(await page.textContent('#dTotal'), '5 USDC');
  await cta.click();
  await page.waitForSelector('.toast.ok >> text=Your wallet paid the network fee', { timeout: 300_000 });
  assert.equal(relayed.length, 2, 'self-relay must not call the relayer');
  const signedNow = await page.evaluate(() => window.__signed);
  assert.ok(signedNow.length - signedBefore >= 1);
  const selfTx = web3.VersionedTransaction.deserialize(Uint8Array.from(signedNow[signedNow.length - 1]));
  const selfKeys = selfTx.message.staticAccountKeys.map((k) => k.toBase58());
  assert.equal(selfKeys[0], OWNER, 'the connected wallet pays');
  assert.ok(!selfKeys.includes(RELAYER), 'no relayer account involved');
  const selfLast = await page.evaluate(() => window.__pool.last);
  assert.equal(selfLast.publicSignals[1], (FIELD_SIZE - 5_000_000n).toString(), 'publicAmount = -5 USDC, fee 0');
  assert.equal(selfLast.publicSignals[3], mintField(DEV_USDC).toString());
  assert.ok(await snarkjs.groth16.verify(vk, selfLast.publicSignals, selfLast.proof), 'self-relay proof verifies');
  await page.uncheck('#selfRelay');

  // 10. Phone layout: no sideways scroll, 16px inputs, banner visible
  step('10. Phone layout: no sideways scroll, 16px i');
  const m = await browser.newContext({ ...devices['iPhone 13'] });
  await m.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await m.route('https://api.devnet.solana.com/**', (r) => r.fulfill({ status: 503, body: 'offline' }));
  const mp = await m.newPage();
  mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
  await mp.goto(base + '/private.html');
  for (const tab of ['shield', 'send', 'unshield', 'swap']) {
    await mp.click(`#tab-${tab}`);
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `private.html (${tab}) overflows by ${overflow}px`);
  }
  await mp.click('#tab-unshield');
  assert.equal(await mp.evaluate(() => getComputedStyle(document.querySelector('#toInput')).fontSize), '16px');
  assert.ok(await mp.isVisible('#pvBanner'));
  await mp.click('#walletBtn');
  await mp.waitForSelector('#walletModal.open');
  assert.match(await mp.textContent('#walletList'), /Open in Phantom/);
  if (shots) await mp.screenshot({ path: `${shots}/private-mobile.png` });
  await m.close();

  assert.deepEqual(errors, [], 'console errors: ' + errors.join('\n'));
  await browser.close();
  server.close();
  // snarkjs keeps a bn128 worker pool alive in Node after verify(); release it.
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  console.log(`pool e2e: all checks passed. In-browser proving (incl. first download of the 8.8 MB zkey): shield ${shieldMs} ms (end to end), unshield ${unshieldMs} ms, swap ${swapMs} ms; worker-reported proof time ${shieldLast.proveMs} ms / ${unLast.proveMs} ms / ${swLast.proveMs} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
