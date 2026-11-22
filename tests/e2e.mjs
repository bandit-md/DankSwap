// End-to-end test of the swap app in Chromium with a mock Wallet Standard wallet and mocked
// Jupiter + RPC responses. Run: node tests/e2e.mjs   (needs the `playwright` package).
// Set SCREENSHOTS=dir to save screenshots.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const OWNER = 'GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ';
const RECIPIENT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const shots = process.env.SCREENSHOTS;

const mockWallet = `
(() => {
  const account = { address: '${OWNER}', publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
  window.__signed = [];
  window.__reject = false;
  const listeners = {};
  const wallet = {
    version: '1.0.0',
    name: 'Mock Wallet',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#f0f"/></svg>'),
    chains: ['solana:mainnet', 'solana:devnet'],
    accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async (opts) => {
        if (opts && opts.silent && !localStorage.getItem('mock.authorised')) return { accounts: [] };
        localStorage.setItem('mock.authorised', '1');
        wallet.accounts = [account];
        return { accounts: [account] };
      } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; localStorage.removeItem('mock.authorised'); } },
      'standard:events': { version: '1.0.0', on: (ev, cb) => { (listeners[ev] ||= []).push(cb); return () => {}; } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => {
        if (window.__reject) { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
        return inputs.map((i) => { window.__signed.push(Array.from(i.transaction)); const out = new Uint8Array(i.transaction.length + 1); out.set(i.transaction); out[out.length - 1] = 99; return { signedTransaction: out }; });
      } },
    },
  };
  const cb = ({ register }) => register(wallet);
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb })); } catch (e) {}
  window.addEventListener('wallet-standard:app-ready', (e) => cb(e.detail));
})();
`;

function orderResponse(params) {
  const amount = BigInt(params.get('amount'));
  const inSol = params.get('inputMint') === SOL;
  // 1 SOL = 150 USDC
  const out = inSol ? (amount * 150n) / 1000n : (amount * 1000n) / 150n;
  const severe = amount === 1_500_000_000n;
  const taker = params.get('taker');
  return {
    mode: 'ultra',
    inputMint: params.get('inputMint'),
    outputMint: params.get('outputMint'),
    inAmount: amount.toString(),
    outAmount: out.toString(),
    otherAmountThreshold: ((out * 995n) / 1000n).toString(),
    inUsdValue: inSol ? Number(amount) / 1e9 * 150 : Number(amount) / 1e6,
    outUsdValue: inSol ? Number(out) / 1e6 : Number(out) / 1e9 * 150,
    swapUsdValue: inSol ? Number(amount) / 1e9 * 150 : Number(amount) / 1e6,
    priceImpact: severe ? -8.2 : -0.02,
    slippageBps: params.get('slippageBps') ? Number(params.get('slippageBps')) : 30,
    feeBps: 10,
    routePlan: [{ percent: 100, bps: 10000, swapInfo: { label: 'Meteora DLMM', ammKey: 'x', inputMint: '', outputMint: '', inAmount: '', outAmount: '' } }],
    router: 'metis',
    gasless: false,
    signatureFeeLamports: 5000,
    signatureFeePayer: taker,
    prioritizationFeeLamports: 20000,
    prioritizationFeePayer: taker,
    rentFeeLamports: 0,
    transaction: taker ? Buffer.from([1, 2, 3, 4, 5]).toString('base64') : null,
    requestId: 'req-' + amount.toString(),
  };
}

async function main() {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const orders = [];
  const executes = [];

  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.route('https://api.jup.ag/swap/v2/order**', async (r) => {
    const u = new URL(r.request().url());
    orders.push(Object.fromEntries(u.searchParams));
    await r.fulfill({ json: orderResponse(u.searchParams), headers: { 'access-control-allow-origin': '*' } });
  });
  await ctx.route('https://api.jup.ag/swap/v2/execute', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const body = JSON.parse(r.request().postData());
    executes.push(body);
    await r.fulfill({
      json: { status: 'Success', signature: '5sigMock', code: 0, totalInputAmount: body.requestId.slice(4), totalOutputAmount: '150000000' },
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await ctx.route('https://api.mainnet-beta.solana.com/**', async (r) => {
    const req = JSON.parse(r.request().postData());
    let result;
    if (req.method === 'getBalance') result = { context: { slot: 1 }, value: 2_000_000_000 };
    else if (req.method === 'getTokenAccountsByOwner') {
      const usdc = req.params[1].mint === RECIPIENT;
      result = { context: { slot: 1 }, value: usdc ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: '50000000' } } } } } }] : [] };
    }
    await r.fulfill({ json: { jsonrpc: '2.0', id: req.id, result }, headers: { 'access-control-allow-origin': '*' } });
  });

  await ctx.addInitScript(mockWallet);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_FAILED/.test(m.text())) errors.push(m.text()); });

  const cta = page.locator('#cta');

  // 1. Landing page renders and links to the app
  await page.goto(base + '/index.html');
  await page.waitForSelector('#orbitNodes .node');
  assert.equal(await page.locator('#orbitNodes .node').count(), 8);
  await page.click('#feeSize');
  if (shots) await page.screenshot({ path: `${shots}/landing.png`, fullPage: false });

  // 2. App: quote without a wallet
  await page.goto(base + '/app.html');
  await page.fill('#inAmount', '1');
  await page.waitForFunction(() => document.querySelector('#outAmount').value === '150');
  assert.equal(await cta.textContent(), 'Connect wallet');
  assert.equal(orders.at(-1).taker, undefined);
  assert.match(await page.textContent('#dRate'), /1 SOL ≈ 150 USDC/);
  assert.equal(await page.textContent('#dRoute'), 'Meteora DLMM via Jupiter');
  assert.equal(await page.textContent('#dFee'), '0.1% · $0.15');

  // 3. Connect wallet through the CTA
  await cta.click();
  await page.waitForSelector('#walletModal.open');
  await page.click('#walletList .list-item');
  await page.waitForFunction(() => document.querySelector('#walletBtn').textContent.includes('GkwF'));
  await page.waitForFunction(() => document.querySelector('#inBal').textContent === '2 SOL');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Swap');
  assert.equal(orders.at(-1).taker, OWNER);
  assert.match(await page.textContent('#dNet'), /0\.000025 SOL/);
  if (shots) await page.screenshot({ path: `${shots}/app-quote.png` });

  // 4. Swap
  await cta.click();
  await page.waitForSelector('.toast.ok >> text=Swap complete');
  assert.equal(executes.length, 1);
  assert.equal(executes[0].requestId, 'req-1000000000');
  assert.deepEqual([...Buffer.from(executes[0].signedTransaction, 'base64')], [1, 2, 3, 4, 5, 99]);
  assert.equal(await page.inputValue('#inAmount'), '');
  assert.equal(await page.locator('.act-list li').count(), 1);
  assert.match(await page.textContent('.act-list li'), /1 SOL → 150 USDC/);

  // 5. Insufficient balance
  await page.fill('#inAmount', '5');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Insufficient SOL');

  // 6. Max keeps a 0.01 SOL reserve
  await page.click('#maxBtn');
  assert.equal(await page.inputValue('#inAmount'), '1.99');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Swap');

  // 7. Recipient address
  await page.check('#recvToggle');
  await page.fill('#recvInput', 'not-an-address');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Enter a valid recipient');
  await page.fill('#recvInput', RECIPIENT);
  await page.waitForFunction(() => document.querySelector('#cta').textContent.startsWith('Swap and send to EPjF'));
  assert.equal(orders.at(-1).receiver, RECIPIENT);
  await page.uncheck('#recvToggle');

  // 8. Wallet rejection
  await page.evaluate(() => { window.__reject = true; });
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Swap');
  await cta.click();
  await page.waitForSelector('.toast >> text=Cancelled');
  assert.equal(executes.length, 1);
  await page.evaluate(() => { window.__reject = false; });

  // 9. Severe price impact needs two clicks
  await page.fill('#inAmount', '1.5');
  await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Swap anyway');
  assert.match(await page.textContent('#msg'), /Price impact is 8\.20%/);
  await cta.click();
  assert.match(await cta.textContent(), /^Confirm: 8\.20% price impact/);
  await cta.click();
  await page.waitForFunction(() => document.querySelectorAll('.act-list li').length === 2);
  assert.equal(executes.length, 2);

  // 10. Flip tokens uses the quoted output
  await page.fill('#inAmount', '1');
  await page.waitForFunction(() => document.querySelector('#outAmount').value === '150');
  await page.click('#flipBtn');
  assert.equal(await page.inputValue('#inAmount'), '150');
  assert.match(await page.textContent('#inTokenBtn'), /USDC/);
  await page.waitForFunction(() => document.querySelector('#outAmount').value === '1');

  // 11. Slippage setting is sent to Jupiter
  await page.click('#settingsBtn');
  await page.click('#slipOpts [data-bps="50"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#dSlip').textContent === '0.5%');
  assert.equal(orders.at(-1).slippageBps, '50');

  // 12. Reload reconnects silently and keeps prefs
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#walletBtn').textContent.includes('GkwF'));
  assert.match(await page.textContent('#inTokenBtn'), /USDC/);

  // 13. Disconnect
  await page.click('#walletBtn');
  await page.click('#disconnectBtn');
  await page.waitForFunction(() => document.querySelector('#walletBtn').textContent === 'Connect wallet');

  // 14. Mobile layout has no horizontal scroll
  const m = await browser.newContext({ ...devices['iPhone 13'] });
  await m.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const mp = await m.newPage();
  for (const path of ['/index.html', '/app.html', '/risks.html']) {
    await mp.goto(base + path);
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${path} overflows by ${overflow}px`);
  }
  // No wallet in a plain mobile browser: deep links are offered
  await mp.goto(base + '/app.html');
  await mp.click('#walletBtn');
  await mp.waitForSelector('#walletModal.open');
  assert.match(await mp.textContent('#walletList'), /Open in Phantom/);
  if (shots) await mp.screenshot({ path: `${shots}/app-mobile.png` });

  assert.deepEqual(errors, [], 'console errors: ' + errors.join('\n'));
  await browser.close();
  server.close();
  console.log('e2e: all checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
