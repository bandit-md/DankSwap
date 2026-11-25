// Private balance page (private.html): shield, private send, unshield, private swap (Jupiter on
// mainnet once audited, or a relayer's dev swap route on devnet).
// Uses the browser SDK in assets/js/pool/ and the Wallet Standard client in wallet.js.
import { getWallets, onWalletsChanged, connect, lastWalletName, isMobile, mobileDeepLinks, INSTALL_LINKS } from './wallet.js';
import { parseUnits, formatUnits, formatUnitsPlain, shortAddress } from './lib.js';
import { POOL_CONFIG, poolConfigured, showUnauditedBanner } from './pool/config.js';
import { PoolClient, PoolError, isRetryableRelayerError } from './pool/client.js';
import { Prover } from './pool/prover.js';
import { deriveKeys, signUnlockMessage, isShieldedAddress } from './pool/keys.js';
import { requiredFee } from './pool/fees.js';
import { isSanctioned } from './pool/sanctions.js';
import { isSolanaAddress } from './pool/util.js';
import { associatedTokenAddress } from './pool/accounts.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) n.append(kid);
  return n;
};

const CFG = POOL_CONFIG;
const CLUSTER = CFG.POOL_CLUSTER;
const CHAIN = `solana:${CLUSTER}`;
const NULLIFIER_RENT_LAMPORTS = 2n * 946_560n; // two 8-byte nullifier accounts, paid by the depositor
const TABS = ['shield', 'send', 'unshield', 'swap'];
const TAB_KEY = 'dankswap.private.tab';

const S = {
  session: null,
  keys: null,
  client: null,
  web3: null,
  deployed: null, // null = unknown, true/false after the check
  info: null,
  infoErr: '',
  tab: 'shield',
  token: null,
  amountStr: '',
  to: '',
  priv: {}, // symbol → bigint | null
  privErr: {},
  wallet: {}, // symbol → bigint | null (public wallet balance, for Shield)
  quote: null, // { key, fee, needsAta } for unshield
  selfRelay: false, // unshield paid by the connected wallet, no relayer
  toToken: null, // swap output token
  swapQuote: null, // { key, q } from GET /swap/quote
  swapQuoteErr: '',
  quoting: false,
  busy: false,
  syncing: false,
};

const tokens = () => (CFG.TOKENS[CLUSTER] || []);
/** Swap availability for this page and relayer (PoolClient.swapSupport without needing web3 yet). */
const swapSupport = () => PoolClient.prototype.swapSupport.call({ cluster: CLUSTER, config: CFG }, S.info);
const SWAP_OFF_TEXT = 'Private swaps route through Jupiter, which only exists on Solana mainnet. They stay off in this devnet preview and on mainnet until the pool is audited.';
const tokenAvailable = (t) => !!t.mint;
const fmt = (v, t) => formatUnits(v, t.decimals, t.symbol === 'SOL' ? 6 : 4);

/* ---------------- web3 + client ---------------- */
let web3Promise = null;
function loadWeb3() {
  if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3);
  if (!web3Promise) {
    web3Promise = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/solana-web3.iife.min.js', import.meta.url).href;
      s.onload = () => (window.solanaWeb3 ? ok(window.solanaWeb3) : fail(new Error('web3 failed to load')));
      s.onerror = () => {
        web3Promise = null;
        fail(new Error('Could not load the Solana helper. Check your connection.'));
      };
      document.head.appendChild(s);
    });
  }
  return web3Promise;
}

async function ensureClient() {
  if (S.client) return S.client;
  S.web3 = await loadWeb3();
  const prover = new Prover({ wasmUrl: CFG.ZK_WASM, zkeyUrl: CFG.ZK_ZKEY });
  S.client = new PoolClient({ web3: S.web3, config: CFG, prover });
  return S.client;
}

/* ---------------- banner, notices ---------------- */
function renderBanner() {
  $('pvBanner').hidden = !showUnauditedBanner(CFG);
  $('clusterTag').textContent = CLUSTER;
}

function notice(text) {
  const n = $('poolNotice');
  n.textContent = text || '';
  n.hidden = !text;
}

async function checkPool() {
  if (!poolConfigured(CFG)) {
    S.deployed = false;
    notice('The private pool program is not configured on this site yet.');
    return render();
  }
  if (CLUSTER === 'mainnet' && CFG.POOL_AUDITED !== true) {
    S.deployed = false;
    notice('The private pool is not enabled on mainnet: it has not been audited.');
    return render();
  }
  try {
    const c = await ensureClient();
    S.deployed = await c.isDeployed();
    if (!S.deployed) notice(`The private pool is not deployed on ${CLUSTER} yet. Check back soon.`);
  } catch (e) {
    S.deployed = null;
    notice(`Could not reach Solana ${CLUSTER}. Balances and actions will retry when you refresh.`);
  }
  if (CFG.RELAYER_URL || (CFG.RELAYER_URLS || []).length) {
    try {
      S.info = await S.client.relayerInfo();
    } catch (e) {
      S.infoErr = e.message;
    }
  } else {
    S.infoErr = 'No relayer is configured, so private balances and relayed actions are unavailable.';
  }
  pickToToken();
  render();
  scheduleSwapQuote();
}

/* ---------------- wallet ---------------- */
function renderWalletButton() {
  const b = $('walletBtn');
  b.replaceChildren();
  if (S.session) {
    const chip = el('span', { class: 'wallet-chip' });
    if (S.session.icon) chip.append(el('img', { src: S.session.icon, alt: '' }));
    chip.append(document.createTextNode(shortAddress(S.session.address)));
    b.append(chip);
    b.setAttribute('aria-label', `Wallet ${S.session.address}`);
  } else {
    b.textContent = 'Connect wallet';
    b.removeAttribute('aria-label');
  }
}

function renderWalletList() {
  const list = $('walletList');
  list.replaceChildren();
  const ws = getWallets();
  if (ws.length) {
    for (const w of ws) {
      const canSign = !!w.features['solana:signMessage'];
      list.append(el('button', { class: 'list-item', type: 'button', onclick: () => doConnect(w) },
        w.icon ? el('img', { src: w.icon, alt: '' }) : null,
        el('span', { class: 'grow' }, document.createTextNode(w.name), canSign ? null : el('small', { text: 'Cannot sign messages: unlocking may not work' })),
        el('span', { class: 'right', text: 'Detected' })));
    }
    return;
  }
  if (isMobile()) {
    list.append(el('p', { text: 'Open this page inside your wallet app to connect:' }));
    for (const l of mobileDeepLinks()) {
      list.append(el('a', { class: 'list-item', href: l.href, rel: 'noopener' }, el('span', { class: 'grow', text: `Open in ${l.name}` }), el('span', { class: 'right', text: '↗' })));
    }
  } else {
    list.append(el('p', { text: 'No Solana wallet found in this browser. Install one, then reload this page:' }));
    for (const l of INSTALL_LINKS) {
      list.append(el('a', { class: 'list-item', href: l.href, target: '_blank', rel: 'noopener' }, el('span', { class: 'grow', text: l.name }), el('span', { class: 'right', text: 'Install ↗' })));
    }
  }
}

function attachSession(session) {
  S.session = session;
  session.onChange = (acct) => {
    if (!acct) return disconnect();
    lock();
    renderWalletButton();
    refreshWalletBalances();
  };
  renderWalletButton();
  refreshWalletBalances();
  render();
}

async function doConnect(w) {
  closeModal('walletModal');
  try {
    attachSession(await connect(w));
    toast('ok', 'Wallet connected', `${w.name} · ${shortAddress(S.session.address)}`);
  } catch (e) {
    if (isUserReject(e)) return;
    toast('err', 'Could not connect', e.message || String(e));
  }
}

function lock() {
  S.keys = null;
  S.priv = {};
  S.privErr = {};
  if (S.client) S.client.setKeys(null);
  render();
}

async function disconnect() {
  if (S.session) await S.session.disconnect();
  S.session = null;
  S.wallet = {};
  lock();
  closeModal('accountModal');
  renderWalletButton();
}

async function tryAutoConnect() {
  const name = lastWalletName();
  if (!name) return;
  const attempt = async () => {
    const w = getWallets().find((x) => x.name === name);
    if (!w || S.session) return !!w;
    try {
      attachSession(await connect(w, { silent: true }));
    } catch (_) {}
    return true;
  };
  if (await attempt()) return;
  const off = onWalletsChanged(async () => {
    if (await attempt()) off();
  });
  setTimeout(off, 3000);
}

function isUserReject(e) {
  const m = `${e?.message || ''} ${e?.name || ''}`;
  return e?.code === 4001 || /reject|denied|cancel|declin|closed/i.test(m);
}

/* ---------------- balances ---------------- */
async function refreshWalletBalances() {
  if (!S.session) return;
  try {
    const c = await ensureClient();
    const owner = S.session.address;
    for (const t of tokens()) {
      if (!tokenAvailable(t)) continue;
      if (t.native) {
        const r = await c.rpc.call('getBalance', [owner, { commitment: 'confirmed' }]);
        S.wallet[t.symbol] = BigInt(r.value);
      } else {
        const r = await c.rpc.call('getTokenAccountsByOwner', [owner, { mint: t.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        S.wallet[t.symbol] = (r.value || []).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
      }
    }
  } catch (e) {
    console.warn('wallet balance', e);
  }
  render();
}

async function refreshPrivate() {
  if (!S.keys || S.syncing) return;
  S.syncing = true;
  render();
  const c = await ensureClient();
  for (const t of tokens()) {
    if (!tokenAvailable(t)) continue;
    try {
      const r = await c.refresh(t.symbol);
      S.priv[t.symbol] = r.balance;
      delete S.privErr[t.symbol];
    } catch (e) {
      S.privErr[t.symbol] = e.message;
    }
  }
  S.syncing = false;
  render();
}

async function unlock() {
  if (!S.session || S.busy) return;
  S.busy = true;
  setCta('Check your wallet…', { disabled: true, spinner: true });
  try {
    const sig = await signUnlockMessage(S.session.wallet, S.session.account, { domain: CFG.SITE_DOMAIN || '', currentHost: location.host });
    const keys = await deriveKeys(sig);
    sig.fill(0);
    const c = await ensureClient();
    c.setKeys(keys);
    S.keys = keys;
    toast('ok', 'Private balance unlocked', 'Scanning the pool for your notes…', 3500);
  } catch (e) {
    if (isUserReject(e)) toast('err', 'Cancelled', 'Nothing was signed.');
    else toast('err', 'Could not unlock', e.message || String(e));
  } finally {
    S.busy = false;
  }
  render();
  if (S.keys) refreshPrivate();
}

/* ---------------- rendering ---------------- */
function renderTokens() {
  const seg = $('tokenSeg');
  seg.replaceChildren();
  for (const t of tokens()) {
    const on = S.token === t;
    seg.append(el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', disabled: !tokenAvailable(t) || S.busy,
      title: tokenAvailable(t) ? t.name : `No ${t.symbol} pool on ${CLUSTER}`,
      onclick: () => pickToken(t),
    }, el('span', { class: 'tok-icon', 'aria-hidden': 'true', style: `background:${t.color}`, text: t.symbol === 'SOL' ? 'SOL' : t.symbol.slice(0, 2) }), document.createTextNode(t.symbol)));
  }
}

function renderToTokens() {
  const seg = $('toTokenSeg');
  seg.replaceChildren();
  for (const t of tokens()) {
    const on = S.toToken === t;
    const ok = tokenAvailable(t) && t !== S.token;
    seg.append(el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', disabled: !ok || S.busy,
      title: !tokenAvailable(t) ? `No ${t.symbol} pool on ${CLUSTER}` : t === S.token ? 'Already the token you pay with' : `Receive ${t.symbol}`,
      'data-symbol': t.symbol,
      onclick: () => pickToToken2(t),
    }, el('span', { class: 'tok-icon', 'aria-hidden': 'true', style: `background:${t.color}`, text: t.symbol === 'SOL' ? 'SOL' : t.symbol.slice(0, 2) }), document.createTextNode(t.symbol)));
  }
}

function renderBalances() {
  const list = $('balList');
  list.replaceChildren();
  for (const t of tokens()) {
    let v;
    let cls = 'v';
    if (!tokenAvailable(t)) {
      v = `No pool on ${CLUSTER}`;
      cls += ' dim';
    } else if (S.privErr[t.symbol]) {
      v = '—';
      cls += ' warn';
    } else if (S.priv[t.symbol] === undefined || S.priv[t.symbol] === null) {
      v = S.syncing ? 'Scanning…' : '—';
    } else {
      v = `${fmt(S.priv[t.symbol], t)} ${t.symbol}`;
    }
    const li = el('li', { 'data-symbol': t.symbol },
      el('span', { class: 'tok-icon', 'aria-hidden': 'true', style: `background:${t.color}`, text: t.symbol === 'SOL' ? 'SOL' : t.symbol.slice(0, 2) }),
      el('span', { class: 'grow' }, document.createTextNode(t.name), S.privErr[t.symbol] ? el('small', { class: 'warn', text: S.privErr[t.symbol] }) : null),
      el('span', { class: cls, text: v }));
    list.append(li);
  }
}

function available() {
  const t = S.token;
  if (!t) return null;
  if (S.tab === 'shield') {
    const w = S.wallet[t.symbol];
    if (w === undefined || w === null) return null;
    if (t.native) {
      const keep = BigInt(CFG.SOL_RESERVE_LAMPORTS);
      return w > keep ? w - keep : 0n;
    }
    return w;
  }
  const p = S.priv[t.symbol];
  return p === undefined ? null : p;
}

function amountRaw() {
  return S.token ? parseUnits(S.amountStr, S.token.decimals) : null;
}

function currentFee() {
  const t = S.token;
  const amt = amountRaw();
  if (!t) return null;
  if (S.tab === 'unshield' && S.selfRelay) return 0n;
  if (!S.info) return null;
  if (S.tab === 'send') return requiredFee(S.info, t.symbol, 0n);
  if (S.tab === 'swap') return S.swapQuote && S.swapQuote.key === swapKey() ? S.swapQuote.q.fee : null;
  if (S.tab === 'unshield' && S.selfRelay) return 0n;
  if (S.tab === 'unshield') {
    if (t.native || (S.quote && S.quote.key === quoteKey())) {
      return requiredFee(S.info, t.symbol, amt || 0n, t.native ? false : S.quote.needsAta);
    }
    return null;
  }
  return 0n;
}

function swapKey() {
  const amt = amountRaw();
  return `${S.token && S.token.symbol}|${S.toToken && S.toToken.symbol}|${amt || 0}`;
}

function pickToToken() {
  if (S.toToken && S.toToken !== S.token && tokenAvailable(S.toToken)) return;
  S.toToken = tokens().find((x) => tokenAvailable(x) && x !== S.token) || null;
}

function quoteKey() {
  return `${S.token && S.token.symbol}|${S.to.trim()}`;
}

function setCta(text, { disabled = false, spinner = false } = {}) {
  const b = $('cta');
  b.disabled = disabled;
  b.replaceChildren();
  if (spinner) b.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  b.append(document.createTextNode(text));
}

function render() {
  renderBanner();
  // tabs
  for (const tab of TABS) {
    const b = $(`tab-${tab}`);
    const on = tab === S.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $(`panel-${tab}`).hidden = !on;
  }
  const swap = S.tab === 'swap';
  const sup = swapSupport();
  $('formFields').hidden = swap && !sup.ok;
  if (swap) {
    $('swapText').textContent = sup.ok
      ? `Swap inside your private balance. Your notes pay into the pool's swap escrow, ${sup.route === 'mock' ? 'a test swap program (dev route, not real prices)' : 'Jupiter'} swaps it, and a new private note worth at least the minimum below lands in your balance. A relayer submits it, so your wallet never appears.`
      : (CLUSTER === 'devnet' ? SWAP_OFF_TEXT : `${sup.reason} ${SWAP_OFF_TEXT}`);
  }

  // account section
  const unlocked = !!S.keys;
  $('lockedView').hidden = unlocked;
  $('unlockedView').hidden = !unlocked;
  $('refreshBtn').hidden = !unlocked;
  $('refreshBtn').disabled = S.syncing;
  if (!unlocked) {
    $('lockedText').textContent = S.session ? 'Unlock to scan the pool for notes that belong to this wallet.' : 'Connect a wallet to see your private balance.';
    const ub = $('unlockBtn');
    ub.textContent = S.session ? 'Unlock private balance' : 'Connect wallet';
    ub.disabled = S.busy;
  } else {
    $('shieldedAddr').textContent = S.keys.address;
    renderBalances();
  }

  renderTokens();
  $('swapToWrap').hidden = !swap || !sup.ok;
  if (swap && sup.ok) renderToTokens();
  const t = S.token;
  $('amountSym').textContent = t ? t.symbol : '';
  const avail = available();
  $('availText').textContent = avail === null ? (S.tab === 'shield' ? 'Wallet —' : 'Private —') : `${S.tab === 'shield' ? 'Wallet' : 'Private'} ${fmt(avail, t)}`;

  // recipient
  const needsTo = S.tab === 'send' || S.tab === 'unshield';
  $('toWrap').hidden = !needsTo;
  if (S.tab === 'send') {
    $('toLabel').textContent = 'Shielded address';
    $('toInput').placeholder = 'dank…';
    $('toHint').textContent = 'The recipient finds the funds when they unlock their private balance.';
  } else if (S.tab === 'unshield') {
    $('toLabel').textContent = 'Destination Solana address';
    $('toInput').placeholder = 'Any Solana wallet address';
    $('toHint').textContent = 'Funds arrive from the pool, not from your wallet. Double-check: transfers cannot be reversed.';
  }
  const toBad = needsTo && S.to.trim() !== '' && !(S.tab === 'send' ? isShieldedAddress(S.to) : isSolanaAddress(S.to.trim()));
  $('toInput').classList.toggle('bad', toBad);
  $('toInput').setAttribute('aria-invalid', String(toBad));

  // details
  const amt = amountRaw();
  const fee = currentFee();
  $('details').hidden = (swap && !sup.ok) || !t || !amt;
  const sq = swap && S.swapQuote && S.swapQuote.key === swapKey() ? S.swapQuote.q : null;
  for (const id of ['dOutRow', 'dMinRow', 'dImpactRow']) $(id).hidden = !swap;
  if (swap && t && amt) {
    const to = S.toToken;
    $('dOut').textContent = sq ? `≈ ${fmt(sq.outAmount, to)} ${to.symbol}` : (S.swapQuoteErr ? '—' : 'Quoting…');
    $('dMin').textContent = sq ? `${fmt(sq.minOut, to)} ${to.symbol}` : '—';
    const impact = sq ? sq.priceImpactPct * 100 : null;
    $('dImpact').textContent = impact === null ? '—' : impact < 0.01 ? '< 0.01%' : `${impact.toFixed(2)}%`;
    $('dImpact').classList.toggle('warn', impact !== null && impact > 1);
  }
  if (t && amt) {
    $('dNet').textContent = CLUSTER === 'devnet' ? 'Solana devnet' : 'Solana mainnet';
    if (S.tab === 'unshield' && S.selfRelay) {
      $('dFeeLabel').textContent = 'Paid by your wallet';
      $('dFee').textContent = `≈ ${formatUnits(NULLIFIER_RENT_LAMPORTS + 10_000n, 9, 6)} SOL`;
      $('dTotalLabel').textContent = 'Leaves your private balance';
      $('dTotal').textContent = `${fmt(amt, t)} ${t.symbol}`;
    } else if (S.tab === 'shield') {
      $('dFeeLabel').textContent = 'Network fee + account rent';
      $('dFee').textContent = `≈ ${formatUnits(NULLIFIER_RENT_LAMPORTS + 10_000n, 9, 6)} SOL`;
      $('dTotalLabel').textContent = 'Leaves your wallet';
      $('dTotal').textContent = `${fmt(amt, t)} ${t.symbol}`;
    } else {
      $('dFeeLabel').textContent = 'Relayer fee';
      $('dFee').textContent = fee === null ? (S.quoting ? 'Checking…' : '—') : `${fmt(fee, t)} ${t.symbol}`;
      $('dTotalLabel').textContent = 'Leaves your private balance';
      $('dTotal').textContent = fee === null ? '—' : `${fmt(amt + fee, t)} ${t.symbol}`;
    }
  }

  if (S.busy) return;
  // CTA
  const action = { shield: 'Shield', send: 'Send', unshield: 'Unshield', swap: 'Swap' }[S.tab];
  if (swap && !sup.ok) return setCta(CLUSTER === 'mainnet' ? 'Swap is not enabled yet' : 'Swap: mainnet only', { disabled: true });
  if (!S.session) return setCta('Connect wallet');
  if (!S.keys) return setCta('Unlock private balance');
  if (S.deployed === false) return setCta(`Pool not live on ${CLUSTER}`, { disabled: true });
  if (!t || !tokenAvailable(t)) return setCta('Choose a token', { disabled: true });
  if (S.tab !== 'shield' && !S.info && !(S.tab === 'unshield' && S.selfRelay)) return setCta('Relayer unavailable', { disabled: true });
  if (!amt) return setCta('Enter an amount', { disabled: true });
  if (needsTo && !S.to.trim()) return setCta(S.tab === 'send' ? 'Enter a shielded address' : 'Enter a destination', { disabled: true });
  if (toBad) return setCta(S.tab === 'send' ? 'Enter a valid dank… address' : 'Enter a valid Solana address', { disabled: true });
  if (S.tab === 'shield' && isSanctioned(S.session.address)) return setCta('Wallet not allowed', { disabled: true });
  if (S.tab === 'unshield' && isSanctioned(S.to.trim())) return setCta('Destination not allowed', { disabled: true });
  if (swap && !S.toToken) return setCta('Choose a token to receive', { disabled: true });
  if (swap && S.swapQuoteErr && fee === null) return setCta('No swap quote', { disabled: true });
  if (swap && fee === null) return setCta('Getting quote…', { disabled: true, spinner: true });
  if (S.tab !== 'shield' && fee === null) return setCta('Checking fee…', { disabled: true, spinner: true });
  const need = amt + (S.tab === 'shield' ? 0n : fee);
  if (avail !== null && need > avail) return setCta(`Insufficient ${S.tab === 'shield' ? '' : 'private '}${t.symbol}`, { disabled: true });
  const label = S.tab === 'send' ? `Send ${fmt(amt, t)} ${t.symbol} privately` : swap ? `Swap ${fmt(amt, t)} ${t.symbol} → ${S.toToken.symbol}` : `${action} ${fmt(amt, t)} ${t.symbol}`;
  setCta(label);
}

/* ---------------- quoting (unshield fee for token accounts) ---------------- */
let quoteTimer = null;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  const t = S.token;
  if (S.tab !== 'unshield' || !t || t.native || !isSolanaAddress(S.to.trim()) || !S.client) return;
  const key = quoteKey();
  if (S.quote && S.quote.key === key) return;
  quoteTimer = setTimeout(async () => {
    S.quoting = true;
    render();
    try {
      const ata = associatedTokenAddress(S.web3, S.to.trim(), t.mint).toBase58();
      const r = await S.client.rpc.call('getAccountInfo', [ata, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
      if (quoteKey() === key) S.quote = { key, needsAta: !(r && r.value) };
    } catch (e) {
      $('msg').textContent = 'Could not check the destination account. Try again.';
    }
    S.quoting = false;
    render();
  }, 350);
}

/* ---------------- quoting (private swap) ---------------- */
// Each quote costs the relayer a Jupiter request (keyless: 30/min), so quote only after typing
// pauses, and reuse a quote for the same amount until it expires.
let swapTimer = null;
function scheduleSwapQuote() {
  clearTimeout(swapTimer);
  if (S.tab !== 'swap' || !swapSupport().ok || !S.client || !S.token || !S.toToken) return;
  const amt = amountRaw();
  if (!amt) return;
  const key = swapKey();
  if (S.swapQuote && S.swapQuote.key === key && Date.now() < S.swapQuote.q.expiresAt - 5000) return;
  S.swapQuoteErr = '';
  swapTimer = setTimeout(async () => {
    try {
      const q = await S.client.quoteSwap({ fromToken: S.token.symbol, toToken: S.toToken.symbol, amount: amt });
      if (swapKey() === key) {
        S.swapQuote = { key, q };
        $('msg').textContent = '';
      }
    } catch (e) {
      if (swapKey() === key) {
        S.swapQuoteErr = friendly(e);
        $('msg').textContent = S.swapQuoteErr;
      }
    }
    render();
  }, 600);
}

/* ---------------- actions ---------------- */
const STAGES = { download: 'Downloading proving key', witness: 'Computing witness', prove: 'Generating zero-knowledge proof', done: 'Proof ready' };
function progress(p) {
  const box = $('progress');
  if (!p) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('progressLabel').textContent = p.label || STAGES[p.stage] || 'Working…';
  const pct = Math.max(0, Math.min(100, Math.round(p.pct || 0)));
  $('progressPct').textContent = `${pct}%`;
  $('progressFill').style.width = `${pct}%`;
  $('progressBar').setAttribute('aria-valuenow', String(pct));
  if (p.detail !== undefined) $('progressDetail').textContent = p.detail || 'Proving runs on your device. Keep this tab open; it can take a minute on phones.';
}

function friendly(e) {
  if (e instanceof PoolError) return e.message;
  const m = e && e.message ? e.message : String(e);
  if (/Assert Failed|Error in template|Constraint doesn't match/i.test(m)) return 'The proof could not be built from your notes. Refresh your balance and try again.';
  return m;
}

async function signAndSend(bytes, lastValidBlockHeight) {
  const feature = S.session.wallet.features['solana:signTransaction'];
  const [out] = await feature.signTransaction({ account: S.session.account, transaction: bytes, chain: CHAIN });
  if (!out || !out.signedTransaction) throw new Error('Wallet returned no signed transaction');
  const sig = await S.client.sendSigned(out.signedTransaction);
  progress({ label: 'Waiting for confirmation', pct: 100, detail: '' });
  await S.client.confirm(sig, lastValidBlockHeight);
  return sig;
}

/**
 * Run a build-and-relay step; if the relayer is unreachable or failing and another is configured,
 * switch and run it again (a new proof, since the proof binds the relayer's fee account).
 */
async function withRelayerFailover(run) {
  const c = S.client;
  let tries = Math.max(1, c.relayers.length);
  let staleRetried = false;
  for (;;) {
    try {
      return await run();
    } catch (e) {
      // Stale root: same relayer, fresh sync and proof (once).
      if (e instanceof PoolError && e.code === 'STALE_ROOT' && !staleRetried) {
        staleRetried = true;
        toast('', 'Updating', e.message, 4000);
        continue;
      }
      tries -= 1;
      if (tries <= 0 || !isRetryableRelayerError(e) || !c.switchRelayer()) throw e;
      S.info = await c.relayerInfo();
      toast('', 'Trying another relayer', 'The relayer did not respond. Retrying with the next one; your funds are still in the pool.', 5000);
    }
  }
}

async function submit() {
  if (S.busy) return;
  if (!S.session) {
    renderWalletList();
    return openModal('walletModal');
  }
  if (!S.keys) return unlock();
  const t = S.token;
  const amt = amountRaw();
  if (!t || !amt) return;
  S.busy = true;
  $('msg').textContent = '';
  setCta('Proving…', { disabled: true, spinner: true });
  renderTokens();
  const onProgress = (p) => progress(p);
  progress({ stage: 'download', pct: 0 });
  try {
    const c = await ensureClient();
    let sig;
    let built;
    if (S.tab === 'shield') {
      built = await c.buildShield({ symbol: t.symbol, amount: amt, owner: S.session.address, onProgress });
      progress({ label: 'Confirm in your wallet', pct: 100, detail: '' });
      setCta('Check your wallet…', { disabled: true, spinner: true });
      sig = await signAndSend(built.bytes, built.lastValidBlockHeight);
      toast('ok', 'Shielded', `${fmt(amt, t)} ${t.symbol} is now in your private balance.`, 8000, sig);
    } else if (S.tab === 'send') {
      sig = await withRelayerFailover(async () => {
        built = await c.buildSend({ symbol: t.symbol, amount: amt, to: S.to.trim(), onProgress });
        progress({ label: 'Relaying', pct: 100, detail: '' });
        return c.relay(built);
      });
      toast('ok', 'Sent privately', `${fmt(amt, t)} ${t.symbol} sent. Fee ${fmt(built.fee, t)} ${t.symbol}.`, 8000, sig);
    } else if (S.tab === 'unshield' && S.selfRelay) {
      built = await c.buildUnshieldSelf({ symbol: t.symbol, amount: amt, recipientWallet: S.to.trim(), payer: S.session.address, onProgress });
      if (built.preBytes) {
        progress({ label: 'Create the destination token account', pct: 100, detail: 'Confirm in your wallet (1 of 2)' });
        setCta('Check your wallet…', { disabled: true, spinner: true });
        await signAndSend(built.preBytes, built.lastValidBlockHeight);
      }
      progress({ label: 'Confirm in your wallet', pct: 100, detail: built.preBytes ? '2 of 2' : '' });
      setCta('Check your wallet…', { disabled: true, spinner: true });
      sig = await signAndSend(built.bytes, built.lastValidBlockHeight);
      c.markPending(t.symbol, built.inputs);
      toast('ok', 'Unshielded', `${fmt(amt, t)} ${t.symbol} sent to ${shortAddress(S.to.trim())}. Your wallet paid the network fee.`, 8000, sig);
    } else if (S.tab === 'unshield') {
      sig = await withRelayerFailover(async () => {
        built = await c.buildUnshield({ symbol: t.symbol, amount: amt, recipientWallet: S.to.trim(), onProgress });
        progress({ label: 'Relaying', pct: 100, detail: '' });
        return c.relay(built);
      });
      toast('ok', 'Unshielded', `${fmt(amt, t)} ${t.symbol} sent to ${shortAddress(S.to.trim())}. Fee ${fmt(built.fee, t)} ${t.symbol}.`, 8000, sig);
    } else if (S.tab === 'swap') {
      const to = S.toToken;
      const sq = S.swapQuote && S.swapQuote.key === swapKey() ? S.swapQuote.q : null;
      if (!sq || Date.now() > sq.expiresAt) {
        // The quote the user saw is gone: show a fresh one and let them confirm again.
        S.swapQuote = null;
        scheduleSwapQuote();
        throw new PoolError('QUOTE_EXPIRED', 'The quote expired. Check the new minimum and confirm again.');
      }
      built = await c.buildSwap({ fromToken: t.symbol, toToken: to.symbol, amount: amt, quote: sq, onProgress });
      progress({ label: 'Relaying', pct: 100, detail: '' });
      sig = await c.relay(built);
      S.swapQuote = null;
      toast('ok', 'Swapped privately', `${fmt(amt, t)} ${t.symbol} → at least ${fmt(built.quote.minOut, to)} ${to.symbol}. Fee ${fmt(built.fee, t)} ${t.symbol}. The new ${to.symbol} note appears in your balance once indexed.`, 9000, sig);
    }
    // Public data only (proof, public signals, relay body): used by tests/pool.e2e.mjs.
    window.__pool.last = { tab: S.tab, sig, proveMs: built.proveMs, proof: built.proof, publicSignals: built.tx.publicSignals, body: built.body || null, minOut: built.quote ? String(built.quote.minOut) : null };
    S.amountStr = '';
    $('amountInput').value = '';
  } catch (e) {
    if (isUserReject(e)) toast('err', 'Cancelled', 'Nothing was sent.');
    else {
      $('msg').textContent = friendly(e) + (S.tab === 'unshield' && !S.selfRelay && e instanceof PoolError && /^RELAYER/.test(e.code)
        ? ' You can also tick "Pay the network fee from my wallet" to withdraw without a relayer.' : '');
      toast('err', 'Not completed', friendly(e));
      if (e instanceof PoolError && e.code === 'FRAGMENTED') {
        $('combineBtn').hidden = false;
        $('combineBtn').dataset.symbol = t.symbol;
      }
    }
  } finally {
    S.busy = false;
    progress(null);
    render();
    refreshWalletBalances();
    setTimeout(refreshPrivate, 1500);
  }
}

/** Merge the two largest notes into one (private send to self through the relayer). */
async function combineNotes() {
  if (S.busy || !S.client) return;
  const symbol = $('combineBtn').dataset.symbol || (S.token && S.token.symbol);
  if (!symbol) return;
  S.busy = true;
  $('combineBtn').hidden = true;
  $('msg').textContent = '';
  setCta('Combining notes…', { disabled: true, spinner: true });
  progress({ stage: 'download', pct: 0 });
  try {
    const built = await S.client.buildConsolidate({ symbol, onProgress: (p) => progress(p) });
    progress({ label: 'Relaying', pct: 100, detail: '' });
    const sig = await S.client.relay(built);
    const t = S.client.token(symbol);
    toast('ok', 'Notes combined', `Two notes merged into ${fmt(built.combined, t)} ${symbol} (fee ${fmt(built.fee, t)} ${symbol}). Try your transaction again once it is indexed.`, 9000, sig);
  } catch (e) {
    $('msg').textContent = friendly(e);
    toast('err', 'Not completed', friendly(e));
  } finally {
    S.busy = false;
    progress(null);
    render();
    setTimeout(refreshPrivate, 1500);
  }
}

/* ---------------- tabs, tokens, inputs ---------------- */
function setTab(tab, focus = false) {
  if (!TABS.includes(tab) || S.busy) return;
  S.tab = tab;
  S.quote = null;
  S.swapQuoteErr = '';
  $('msg').textContent = '';
  $('combineBtn').hidden = true;
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch (_) {}
  pickToToken();
  render();
  scheduleQuote();
  scheduleSwapQuote();
  if (focus) $(`tab-${tab}`).focus();
}

function pickToken(t) {
  if (!tokenAvailable(t) || S.busy) return;
  S.token = t;
  S.quote = null;
  S.swapQuoteErr = '';
  pickToToken();
  normaliseAmount();
  render();
  scheduleQuote();
  scheduleSwapQuote();
}

function pickToToken2(t) {
  if (!tokenAvailable(t) || t === S.token || S.busy) return;
  S.toToken = t;
  S.swapQuoteErr = '';
  render();
  scheduleSwapQuote();
}

function normaliseAmount() {
  let v = S.amountStr.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const firstDot = v.indexOf('.');
  if (firstDot !== -1) v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
  const [w, f] = v.split('.');
  if (S.token && f !== undefined && f.length > S.token.decimals) v = `${w}.${f.slice(0, S.token.decimals)}`;
  if (/^0\d/.test(v)) v = v.replace(/^0+(?=\d)/, '');
  S.amountStr = v;
  $('amountInput').value = v;
}

function setMax() {
  const t = S.token;
  const avail = available();
  if (!t || avail === null) return;
  let v = avail;
  if (S.tab !== 'shield' && S.info && !(S.tab === 'unshield' && S.selfRelay)) {
    const needsAta = S.tab === 'unshield' && !t.native && S.quote ? S.quote.needsAta : false;
    // largest amount whose fee still fits
    let lo = 0n;
    let hi = avail;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      const f = S.tab === 'send' ? requiredFee(S.info, t.symbol, 0n) : requiredFee(S.info, t.symbol, mid, needsAta);
      if (mid + f <= avail) lo = mid;
      else hi = mid - 1n;
    }
    v = lo;
  }
  S.amountStr = v > 0n ? formatUnitsPlain(v, t.decimals) : '0';
  $('amountInput').value = S.amountStr;
  render();
  scheduleSwapQuote();
}

/* ---------------- modals (same behaviour as the swap page) ---------------- */
let lastFocus = null;
let ownBacks = 0;
function openModal(id) {
  lastFocus = document.activeElement;
  const m = $(id);
  const wasOpen = anyModalOpen();
  m.classList.add('open');
  document.body.classList.add('modal-open');
  if (!wasOpen) {
    try {
      history.pushState({ dankswapModal: id }, '');
    } catch (_) {}
  }
  const f = m.querySelector('button, a, input');
  if (f) f.focus({ preventScroll: true });
}
function closeModal(id, fromHistory = false) {
  const m = $(id);
  if (!m.classList.contains('open')) return;
  m.classList.remove('open');
  if (!anyModalOpen()) document.body.classList.remove('modal-open');
  if (!fromHistory && history.state && history.state.dankswapModal) {
    try {
      ownBacks++;
      history.back();
    } catch (_) {
      ownBacks--;
    }
  }
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
}
function anyModalOpen() {
  return !!document.querySelector('.modal-bg.open');
}
window.addEventListener('popstate', () => {
  if (ownBacks > 0) {
    ownBacks--;
    return;
  }
  document.querySelectorAll('.modal-bg.open').forEach((m) => closeModal(m.id, true));
});

/* ---------------- toasts ---------------- */
function toast(kind, title, body, ms = 6000, sig) {
  const link = sig && CFG.EXPLORER_TX[CLUSTER] ? CFG.EXPLORER_TX[CLUSTER](sig) : null;
  const t = el('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('div', {}, el('b', { text: title }), el('span', { text: body }),
      link ? el('div', {}, el('a', { href: link, target: '_blank', rel: 'noopener', text: 'View transaction ↗' })) : null));
  $('toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

/* ---------------- binding ---------------- */
function bind() {
  $('walletBtn').addEventListener('click', () => {
    if (S.session) {
      $('accName').textContent = S.session.name;
      $('accAddr').textContent = S.session.address;
      $('lockBtn').hidden = !S.keys;
      openModal('accountModal');
    } else {
      renderWalletList();
      openModal('walletModal');
    }
  });
  $('unlockBtn').addEventListener('click', () => {
    if (!S.session) {
      renderWalletList();
      openModal('walletModal');
    } else unlock();
  });
  $('lockBtn').addEventListener('click', () => {
    lock();
    closeModal('accountModal');
  });
  $('disconnectBtn').addEventListener('click', disconnect);
  $('refreshBtn').addEventListener('click', () => refreshPrivate());
  $('copyShielded').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(S.keys.address);
      toast('ok', 'Copied', 'Shielded address copied.', 2500);
    } catch (_) {
      toast('err', 'Copy failed', 'Select and copy the address manually.');
    }
  });

  const tablist = document.querySelector('.pv-tabs');
  tablist.addEventListener('click', (e) => {
    const b = e.target.closest('[role="tab"]');
    if (b) setTab(b.id.replace('tab-', ''));
  });
  tablist.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(S.tab);
    if (e.key === 'ArrowRight') setTab(TABS[(i + 1) % TABS.length], true);
    else if (e.key === 'ArrowLeft') setTab(TABS[(i + TABS.length - 1) % TABS.length], true);
    else if (e.key === 'Home') setTab(TABS[0], true);
    else if (e.key === 'End') setTab(TABS[TABS.length - 1], true);
    else return;
    e.preventDefault();
  });

  $('amountInput').addEventListener('input', (e) => {
    S.amountStr = e.target.value;
    S.swapQuoteErr = '';
    normaliseAmount();
    render();
    scheduleSwapQuote();
  });
  $('maxBtn').addEventListener('click', setMax);
  $('combineBtn').addEventListener('click', combineNotes);
  $('selfRelay').addEventListener('change', (e) => {
    S.selfRelay = e.target.checked;
    $('selfRelayHint').hidden = !S.selfRelay;
    render();
  });
  $('toInput').addEventListener('input', (e) => {
    S.to = e.target.value;
    render();
    scheduleQuote();
  });
  $('actionForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  document.querySelectorAll('.modal-bg').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) closeModal(m.id);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.modal-bg.open');
      if (open) closeModal(open.id);
    }
  });
  onWalletsChanged(() => {
    if ($('walletModal').classList.contains('open')) renderWalletList();
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.busy) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ---------------- boot ---------------- */
S.token = tokens().find(tokenAvailable) || null;
pickToToken();
try {
  const saved = localStorage.getItem(TAB_KEY);
  if (TABS.includes(saved)) S.tab = saved;
} catch (_) {}
bind();
renderWalletButton();
render();
checkPool();
tryAutoConnect();

// Test hook (tests/pool.e2e.mjs); exposes no keys.
window.__pool = { get state() { return { tab: S.tab, unlocked: !!S.keys, deployed: S.deployed, priv: { ...S.priv }, busy: S.busy, swap: swapSupport().ok, toToken: S.toToken && S.toToken.symbol }; }, last: null };
