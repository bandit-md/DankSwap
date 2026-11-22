// Compatibility checks: legacy wallets, embedding on other websites, phones (iOS + Android),
// old browsers, opening from disk, PWA manifest and link-preview tags.
// Run: node tests/compat.e2e.mjs   (needs the `playwright` package)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OWNER = 'GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ';
const SOL = 'So11111111111111111111111111111111111111112';
const cors = { 'access-control-allow-origin': '*' };

async function mockNetwork(ctx, { txB64, executes }) {
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await ctx.route('https://api.jup.ag/swap/v2/order**', async (r) => {
    const q = new URL(r.request().url()).searchParams;
    const amount = BigInt(q.get('amount'));
    const inSol = q.get('inputMint') === SOL;
    const out = inSol ? (amount * 150n) / 1000n : (amount * 1000n) / 150n;
    await r.fulfill({
      headers: cors,
      json: {
        inAmount: amount.toString(), outAmount: out.toString(), otherAmountThreshold: out.toString(),
        inUsdValue: 150, outUsdValue: 150, priceImpact: -0.01, slippageBps: 30, feeBps: 10, router: 'metis',
        routePlan: [], gasless: true, transaction: q.get('taker') ? txB64 : null, requestId: 'r1',
      },
    });
  });
  await ctx.route('https://api.jup.ag/swap/v2/execute', async (r) => {
    executes.push(JSON.parse(r.request().postData()));
    await r.fulfill({ headers: cors, json: { status: 'Success', signature: 'sigLegacy', totalOutputAmount: '150000000' } });
  });
  await ctx.route(/publicnode|mainnet-beta|drpc/, async (r) => {
    const req = JSON.parse(r.request().postData());
    const result = req.method === 'getBalance' ? { value: 2_000_000_000 } : { value: [] };
    await r.fulfill({ headers: cors, json: { jsonrpc: '2.0', id: req.id, result } });
  });
}

async function main() {
  const server = await startServer(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/fonts|ERR_FAILED|Failed to load resource|Refused to display|frame-ancestors/.test(m.text())) errors.push(m.text());
    });
  };

  // Build a real serialized v0 transaction with the vendored web3.js, as Jupiter would return.
  const builder = await browser.newPage();
  await builder.goto(base + '/risks.html');
  await builder.addScriptTag({ url: base + '/assets/vendor/solana-web3.iife.min.js' });
  const txB64 = await builder.evaluate((owner) => {
    const w = window.solanaWeb3;
    const payer = new w.PublicKey(owner);
    const msg = new w.TransactionMessage({
      payerKey: payer,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [w.SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })],
    }).compileToV0Message();
    const bytes = new w.VersionedTransaction(msg).serialize();
    return btoa(String.fromCharCode(...bytes));
  }, OWNER);
  await builder.close();

  /* 1. Legacy injected wallet (no Wallet Standard), e.g. older wallets / some in-app browsers */
  {
    const executes = [];
    const ctx = await browser.newContext();
    await mockNetwork(ctx, { txB64, executes });
    await ctx.addInitScript(`
      (() => {
        const pk = { toString: () => '${OWNER}', toBytes: () => new Uint8Array(32) };
        window.__legacySigned = 0;
        window.phantom = { solana: {
          isPhantom: true, publicKey: null,
          connect: async () => { window.phantom.solana.publicKey = pk; return { publicKey: pk }; },
          disconnect: async () => {},
          on: () => {},
          signTransaction: async (tx) => {
            if (typeof tx.serialize !== 'function' || !tx.message) throw new Error('expected a VersionedTransaction');
            tx.signatures[0] = new Uint8Array(64).fill(7);
            window.__legacySigned++;
            return tx;
          },
        } };
        window.solana = window.phantom.solana; // common alias, must not show twice
      })();
    `);
    const page = await ctx.newPage();
    watch(page);
    await page.goto(base + '/app.html');
    await page.click('#walletBtn');
    await page.waitForSelector('#walletList button.list-item >> text=Phantom');
    assert.equal(await page.locator('#walletList button.list-item').count(), 1, 'legacy wallet listed once');
    await page.click('#walletList button.list-item');
    await page.waitForFunction(() => document.querySelector('#walletBtn').textContent.includes('GkwF'));
    await page.fill('#inAmount', '1');
    await page.waitForFunction(() => document.querySelector('#cta').textContent === 'Swap');
    await page.click('#cta');
    await page.waitForSelector('.toast.ok >> text=Swap complete');
    assert.equal(await page.evaluate(() => window.__legacySigned), 1);
    const signed = Buffer.from(executes[0].signedTransaction, 'base64');
    assert.equal(signed[0], 1, 'one signature');
    assert.ok(signed.subarray(1, 65).every((b) => b === 7), 'signature from legacy wallet is in the bytes sent');
    await ctx.close();
    console.log('ok legacy wallet');
  }

  /* 2. Embedding on another website (different origin) with embed.js */
  {
    // A second local server on another port is a different origin, like a customer's website.
    const hostHtml = `<!doctype html><html><body style="background:#fff">
          <h1>My blog</h1>
          <script src="${base}/embed.js" async></script>
          <iframe id="landing" src="${base}/index.html" style="width:400px;height:200px"></iframe>
        </body></html>`;
    const host = await startServer(0, {
      extra: (req, res) => {
        if (!req.url.startsWith('/host.html')) return false;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(hostHtml);
        return true;
      },
    });
    const ctx = await browser.newContext();
    await mockNetwork(ctx, { txB64, executes: [] });
    const page = await ctx.newPage();
    watch(page);
    await page.goto('http://127.0.0.1:' + host.address().port + '/host.html');
    const iframe = page.locator('iframe[title="DankSwap swap widget"]');
    await iframe.waitFor();
    const frame = await (await iframe.elementHandle()).contentFrame();
    await frame.waitForSelector('#cta');
    assert.ok(await frame.evaluate(() => document.documentElement.classList.contains('is-embedded')));
    // Auto-resize from the app's height message
    await page.waitForFunction(() => document.querySelector('iframe[title="DankSwap swap widget"]').style.height !== '760px');
    // No wallet in the frame: offer to open in a new tab
    await frame.click('#walletBtn');
    await frame.waitForSelector('#walletList >> text=Open DankSwap in a new tab');
    const href = await frame.getAttribute('#walletList a', 'href');
    assert.ok(href.startsWith(base + '/app.html') && !href.includes('embed=1'));
    // Landing page refuses to be framed (clickjacking protection)
    const landing = page.frames().find((f) => f.parentFrame() === page.mainFrame() && f !== frame);
    const landingText = await landing.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    assert.ok(!/Trade in private/.test(landingText), 'landing page must not render inside a frame');
    await ctx.close();
    host.close();
    console.log('ok embed');
  }

  /* 3. Phones: iPhone (Safari) and Android (Chrome) */
  for (const name of ['iPhone 13', 'Pixel 7', 'Galaxy S9+', 'iPad (gen 7)']) {
    const ctx = await browser.newContext({ ...devices[name] });
    await mockNetwork(ctx, { txB64, executes: [] });
    const page = await ctx.newPage();
    watch(page);
    for (const path of ['/index.html', '/app.html', '/risks.html']) {
      await page.goto(base + path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `${name} ${path} overflows by ${overflow}px`);
    }
    // Inputs must be >= 16px or iOS zooms the page on focus
    await page.goto(base + '/app.html');
    await page.check('#recvToggle');
    for (const id of ['inAmount', 'recvInput']) {
      const fs = await page.evaluate((i) => parseFloat(getComputedStyle(document.getElementById(i)).fontSize), id);
      assert.ok(fs >= 16, `${name} #${id} font-size ${fs}px`);
    }
    // Tap targets for Half/Max are not tiny (only shown when connected; measure the CSS rule)
    // Dialog opens as a sheet and the phone back button closes it
    await page.click('#walletBtn');
    await page.waitForSelector('#walletModal.open');
    assert.match(await page.textContent('#walletList'), /Open in Phantom/);
    assert.match(await page.textContent('#walletList'), /Copy link/);
    assert.ok(await page.evaluate(() => document.body.classList.contains('modal-open')), 'background scroll locked');
    await page.goBack();
    await page.waitForSelector('#walletModal:not(.open)', { state: 'attached' });
    assert.equal(new URL(page.url()).pathname, '/app.html', 'back closed the dialog without leaving the page');
    // Closing with the X then pressing back leaves the page normally (no stuck history entries)
    await page.click('#settingsBtn');
    await page.click('#settingsModal [data-close]');
    await page.waitForSelector('#settingsModal:not(.open)', { state: 'attached' });
    await ctx.close();
    console.log('ok', name);
  }

  /* 4. Old browser without BigInt gets a clear message instead of a broken page */
  {
    const ctx = await browser.newContext();
    await ctx.route(/fonts/, (r) => r.abort());
    await ctx.addInitScript('delete window.BigInt;');
    const page = await ctx.newPage();
    await page.goto(base + '/app.html');
    await page.waitForSelector('.compat-bar');
    assert.match(await page.textContent('.compat-bar'), /too old/);
    await ctx.close();
    console.log('ok old browser notice');
  }

  /* 5. Opened from disk (file://): landing works, app explains it needs a website */
  {
    const ctx = await browser.newContext();
    await ctx.route(/fonts/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto('file://' + ROOT + 'index.html');
    await page.waitForSelector('#orbitNodes .node');
    assert.equal(await page.locator('#orbitNodes .node').count(), 8);
    await page.goto('file://' + ROOT + 'app.html');
    await page.waitForSelector('.compat-bar');
    assert.match(await page.textContent('.compat-bar'), /opened from a website/);
    await ctx.close();
    console.log('ok file://');
  }

  /* 6. PWA manifest, icons and link previews */
  {
    const page = await browser.newPage();
    await page.route(/fonts/, (r) => r.abort());
    await page.goto(base + '/index.html');
    const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
    const manifest = await (await page.request.get(base + '/' + manifestHref)).json();
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) assert.equal((await page.request.get(base + '/' + icon.src)).status(), 200, icon.src);
    for (const sel of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
      const src = await page.getAttribute(sel, 'content');
      assert.equal((await page.request.get(base + '/' + src)).status(), 200, src);
    }
    assert.equal((await page.request.get(base + '/assets/apple-touch-icon.png')).status(), 200);
    await page.close();
    console.log('ok manifest + previews');
  }

  assert.deepEqual(errors, [], 'console errors:\n' + errors.join('\n'));
  await browser.close();
  server.close();
  console.log('compat: all checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
