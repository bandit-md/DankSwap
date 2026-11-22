import { CONFIG, TOKENS } from './config.js';
import { getOrder, executeOrder, getBalances } from './api.js';
import {
  getWallets, onWalletsChanged, connect, lastWalletName, isMobile, mobileDeepLinks, INSTALL_LINKS,
} from './wallet.js';
import {
  parseUnits, formatUnits, formatUnitsPlain, displayDecimals, formatUsd, formatPct, bpsToPct,
  shortAddress, maxSpendable, impactLevel, rateString, orderErrorMessage, executeErrorMessage,
  isSolanaAddress, bytesToBase64, base64ToBytes,
} from './lib.js';

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

const PREFS_KEY = 'dankswap.prefs';
const HISTORY_KEY = 'dankswap.history';

const S = {
  inTok: TOKENS[0],
  outTok: TOKENS[1],
  inStr: '',
  session: null,
  balances: null,
  quote: null,
  quoteKey: '',
  quoteAt: 0,
  quoting: false,
  quoteErr: '',
  slippage: 'auto',
  receiverOn: false,
  receiver: '',
  busy: false,
  busyText: '',
  confirmImpact: false,
};

/* ---------------- persistence ---------------- */
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    const find = (sym) => TOKENS.find((t) => t.symbol === sym);
    if (find(p.in) && find(p.out) && p.in !== p.out) {
      S.inTok = find(p.in);
      S.outTok = find(p.out);
    }
    if (p.slippage === 'auto' || (Number.isInteger(p.slippage) && p.slippage > 0 && p.slippage <= 5000)) S.slippage = p.slippage;
  } catch (_) {}
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ in: S.inTok.symbol, out: S.outTok.symbol, slippage: S.slippage }));
  } catch (_) {}
}
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch (_) {
    return [];
  }
}
function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 25)));
  } catch (_) {}
}

/* ---------------- token UI ---------------- */
function tokIcon(t) {
  const i = el('span', { class: 'tok-icon', 'aria-hidden': 'true', text: t.symbol === 'SOL' ? 'SOL' : t.symbol.slice(0, 2) });
  i.style.background = t.symbol === 'SOL' ? 'linear-gradient(135deg,#9945FF,#14F195)' : t.color;
  if (t.symbol === 'SOL') i.style.fontSize = '8px';
  return i;
}
function chev() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'chev');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.innerHTML = '<path d="M6 9l6 6 6-6"/>';
  return s;
}
function renderTokenButtons() {
  for (const [btn, t] of [[$('inTokenBtn'), S.inTok], [$('outTokenBtn'), S.outTok]]) {
    btn.replaceChildren(tokIcon(t), document.createTextNode(t.symbol), chev());
  }
}

/* ---------------- amounts ---------------- */
function inAmountRaw() {
  return parseUnits(S.inStr, S.inTok.decimals);
}
function balanceOf(t) {
  return S.balances ? S.balances[t.symbol] ?? null : null;
}
function receiverValid() {
  return !S.receiverOn || (isSolanaAddress(S.receiver) && S.receiver.trim() !== S.session?.address);
}
function effectiveReceiver() {
  return S.receiverOn && receiverValid() ? S.receiver.trim() : null;
}
function slippageParam() {
  return S.slippage === 'auto' ? null : S.slippage;
}
function currentKey() {
  const amt = inAmountRaw();
  return [S.inTok.mint, S.outTok.mint, amt ?? '', S.session?.address ?? '', effectiveReceiver() ?? '', S.slippage].join('|');
}

/* ---------------- quoting ---------------- */
let quoteTimer = null;
let refreshTimer = null;
let quoteAbort = null;
let quoteSeq = 0;

function scheduleQuote(delay = 450) {
  clearTimeout(quoteTimer);
  clearTimeout(refreshTimer);
  S.confirmImpact = false;
  const amt = inAmountRaw();
  if (!amt || amt <= 0n) {
    if (quoteAbort) quoteAbort.abort();
    S.quote = null;
    S.quoteKey = '';
    S.quoting = false;
    S.quoteErr = '';
    render();
    return;
  }
  S.quoting = true;
  render();
  quoteTimer = setTimeout(() => fetchQuote().catch(() => {}), delay);
}

async function fetchQuote() {
  const amt = inAmountRaw();
  if (!amt || amt <= 0n) return null;
  if (quoteAbort) quoteAbort.abort();
  const ctrl = new AbortController();
  quoteAbort = ctrl;
  const seq = ++quoteSeq;
  const key = currentKey();
  S.quoting = true;
  S.quoteErr = '';
  render();
  try {
    const q = await getOrder({
      inputMint: S.inTok.mint,
      outputMint: S.outTok.mint,
      amount: amt.toString(),
      taker: S.session?.address,
      receiver: effectiveReceiver(),
      slippageBps: slippageParam(),
      signal: ctrl.signal,
    });
    if (seq !== quoteSeq) return null;
    S.quote = q;
    S.quoteKey = key;
    S.quoteAt = Date.now();
    S.quoting = false;
    scheduleRefresh();
    render();
    return q;
  } catch (e) {
    if (e.name === 'AbortError' || seq !== quoteSeq) return null;
    S.quoting = false;
    if (e.status === 429) {
      S.quoteErr = '';
      S.quoting = true;
      quoteTimer = setTimeout(() => fetchQuote().catch(() => {}), e.retryAfterMs || 4000);
    } else {
      S.quote = null;
      S.quoteErr = e.message || 'Could not get a quote.';
      scheduleRefresh(8000);
    }
    render();
    throw e;
  }
}

function scheduleRefresh(ms = CONFIG.QUOTE_REFRESH_MS) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (S.busy || document.hidden || anyModalOpen()) return scheduleRefresh(ms);
    fetchQuote().catch(() => {});
  }, ms);
}

/* ---------------- balances ---------------- */
let balSeq = 0;
async function refreshBalances() {
  if (!S.session) {
    S.balances = null;
    render();
    return;
  }
  const seq = ++balSeq;
  const addr = S.session.address;
  try {
    const b = await getBalances(addr, TOKENS);
    if (seq === balSeq && S.session?.address === addr) {
      S.balances = b;
      render();
    }
  } catch (e) {
    console.warn('Balance lookup failed', e);
    if (seq === balSeq) {
      S.balances = null;
      render();
    }
  }
}

/* ---------------- render ---------------- */
function setCta(text, { disabled = false, danger = false, spinner = false } = {}) {
  const b = $('cta');
  b.disabled = disabled;
  b.classList.toggle('danger', danger);
  b.replaceChildren();
  if (spinner) b.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  b.append(document.createTextNode(text));
}

function render() {
  const amt = inAmountRaw();
  const q = S.quote && S.quoteKey === currentKey() ? S.quote : null;
  const stale = S.quote && !q;

  // Balances
  const inBal = balanceOf(S.inTok);
  const outBal = balanceOf(S.outTok);
  $('inBalWrap').hidden = !S.session;
  $('outBalWrap').hidden = !S.session;
  $('inBal').textContent = inBal === null ? 'Balance —' : `${formatUnits(inBal, S.inTok.decimals, displayDecimals(S.inTok.symbol))} ${S.inTok.symbol}`;
  $('outBal').textContent = outBal === null ? '' : `${formatUnits(outBal, S.outTok.decimals, displayDecimals(S.outTok.symbol))} ${S.outTok.symbol}`;

  // Output + USD
  const shown = q || (stale && S.quoting ? S.quote : null);
  const out = $('outAmount');
  out.value = shown && amt ? formatUnits(shown.outAmount, S.outTok.decimals, displayDecimals(S.outTok.symbol)) : '';
  out.classList.toggle('loading', S.quoting);
  $('inUsd').textContent = shown && amt ? formatUsd(shown.inUsdValue) : '$0.00';
  $('outUsd').textContent = shown && amt ? formatUsd(shown.outUsdValue) : '$0.00';

  // Details
  const d = $('details');
  d.hidden = !(shown && amt);
  if (shown && amt) {
    $('dRate').textContent = rateString(shown.inAmount, S.inTok.decimals, S.inTok.symbol, shown.outAmount, S.outTok.decimals, S.outTok.symbol);
    $('dMin').textContent = shown.otherAmountThreshold
      ? `${formatUnits(shown.otherAmountThreshold, S.outTok.decimals, displayDecimals(S.outTok.symbol))} ${S.outTok.symbol}`
      : '—';
    const lvl = impactLevel(shown.priceImpact);
    const imp = $('dImpact');
    imp.textContent = shown.priceImpact === undefined ? '—' : Math.abs(shown.priceImpact) < 0.01 ? '<0.01%' : formatPct(Math.abs(shown.priceImpact));
    imp.className = 'v' + (lvl === 'severe' ? ' danger' : lvl === 'high' ? ' warn' : '');
    const feeBps = Number(shown.feeBps || 0);
    const usdBase = shown.swapUsdValue || shown.inUsdValue;
    $('dFee').textContent = feeBps === 0 ? 'Free' : `${bpsToPct(feeBps)}${usdBase ? ` · ${formatUsd((usdBase * feeBps) / 10000)}` : ''}`;
    const net = $('dNet');
    if (shown.gasless) {
      net.textContent = 'Sponsored';
      net.className = 'v good';
    } else {
      const me = S.session?.address;
      const mine = (payer) => !me || !payer || payer === me;
      let lam = 0;
      if (mine(shown.signatureFeePayer)) lam += Number(shown.signatureFeeLamports || 0);
      if (mine(shown.prioritizationFeePayer)) lam += Number(shown.prioritizationFeeLamports || 0);
      if (mine(shown.rentFeePayer)) lam += Number(shown.rentFeeLamports || 0);
      net.textContent = lam ? `≈ ${formatUnits(BigInt(lam), 9, 6)} SOL` : '—';
      net.className = 'v';
    }
    $('dSlip').textContent = shown.slippageBps !== undefined ? `${bpsToPct(shown.slippageBps)}${S.slippage === 'auto' ? ' (auto)' : ''}` : '—';
    $('dRoute').textContent = routeLabel(shown);
  }

  // Message line
  const msg = $('msg');
  msg.textContent = '';
  if (S.quoteErr) msg.textContent = S.quoteErr;
  else if (q && q.errorCode) msg.textContent = orderErrorMessage(q.router, q.errorCode, q.errorMessage);
  else if (q && impactLevel(q.priceImpact) === 'severe') msg.textContent = `Price impact is ${formatPct(Math.abs(q.priceImpact))}. You would get much less than market value. Try a smaller amount.`;
  else if (q && impactLevel(q.priceImpact) === 'high') msg.textContent = 'Price impact is above 1%. Consider a smaller amount.';
  else if (S.receiverOn && S.receiver && !receiverValid()) {
    msg.textContent = S.receiver.trim() === S.session?.address ? 'That is your connected wallet. Untick the box to receive there.' : 'That is not a valid Solana address.';
  }
  $('recvInput').classList.toggle('bad', S.receiverOn && !!S.receiver && !receiverValid());

  // CTA
  if (S.busy) return setCta(S.busyText || 'Working…', { disabled: true, spinner: true });
  if (!amt || amt <= 0n) return setCta(S.session ? 'Enter an amount' : 'Enter an amount', { disabled: true });
  if (S.receiverOn && !receiverValid()) return setCta('Enter a valid recipient', { disabled: true });
  if (!S.session) return setCta('Connect wallet');
  if (inBal !== null && amt > inBal) return setCta(`Insufficient ${S.inTok.symbol}`, { disabled: true });
  if (S.quoteErr) return setCta('Swap unavailable', { disabled: true });
  if (!q) return setCta('Fetching best price…', { disabled: true, spinner: true });
  if (q.errorCode || !q.transaction) return setCta('Swap unavailable', { disabled: true });
  if (impactLevel(q.priceImpact) === 'severe') {
    return setCta(S.confirmImpact ? `Confirm: ${formatPct(Math.abs(q.priceImpact))} price impact` : 'Swap anyway', { danger: true });
  }
  setCta(S.receiverOn ? `Swap and send to ${shortAddress(effectiveReceiver())}` : 'Swap');
}

function routeLabel(q) {
  const names = { metis: 'Jupiter', jupiterz: 'JupiterZ RFQ', dflow: 'DFlow', okx: 'OKX' };
  const labels = [...new Set((q.routePlan || []).map((s) => s.swapInfo?.label).filter(Boolean))];
  const router = names[q.router] || q.router || 'Jupiter';
  if (!labels.length) return router;
  const shownLabels = labels.slice(0, 2).join(' + ') + (labels.length > 2 ? ` +${labels.length - 2}` : '');
  return `${shownLabels} via ${router}`;
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
      list.append(
        el('button', { class: 'list-item', type: 'button', onclick: () => doConnect(w) },
          w.icon ? el('img', { src: w.icon, alt: '' }) : null,
          el('span', { class: 'grow', text: w.name }),
          el('span', { class: 'right', text: 'Detected' }))
      );
    }
    return;
  }
  if (isMobile()) {
    list.append(el('p', { text: 'Open DankSwap inside your wallet app to connect:' }));
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
    S.balances = null;
    renderWalletButton();
    refreshBalances();
    scheduleQuote(0);
  };
  renderWalletButton();
  refreshBalances();
  scheduleQuote(0);
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

async function disconnect() {
  if (S.session) await S.session.disconnect();
  S.session = null;
  S.balances = null;
  closeModal('accountModal');
  renderWalletButton();
  scheduleQuote(0);
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

/* ---------------- swap ---------------- */
async function doSwap() {
  if (S.busy) return;
  let q = S.quote && S.quoteKey === currentKey() ? S.quote : null;
  if (q && impactLevel(q.priceImpact) === 'severe' && !S.confirmImpact) {
    S.confirmImpact = true;
    render();
    return;
  }
  const inTok = S.inTok;
  const outTok = S.outTok;
  const receiver = effectiveReceiver();
  clearTimeout(refreshTimer);
  clearTimeout(quoteTimer);
  S.busy = true;
  S.busyText = 'Preparing…';
  render();
  try {
    if (!q || !q.transaction || Date.now() - S.quoteAt > CONFIG.QUOTE_MAX_AGE_MS) {
      S.busyText = 'Refreshing price…';
      render();
      const prevOut = q ? BigInt(q.outAmount) : null;
      q = await fetchQuote();
      S.busy = true;
      if (!q) throw new Error('Could not refresh the quote.');
      if (q.errorCode || !q.transaction) throw new Error(orderErrorMessage(q.router, q.errorCode, q.errorMessage));
      // If the fresh price is meaningfully worse, let the user review it first.
      if (prevOut && BigInt(q.outAmount) * 1000n < prevOut * 995n) {
        S.busy = false;
        render();
        toast('', 'Price updated', 'The price moved since your last quote. Review and press Swap again.');
        return;
      }
    }
    S.busyText = 'Confirm in your wallet';
    render();
    let signed;
    try {
      signed = await S.session.signTransaction(base64ToBytes(q.transaction));
    } catch (e) {
      if (isUserReject(e)) {
        toast('', 'Cancelled', 'You declined the transaction in your wallet.');
        return;
      }
      throw e;
    }
    S.busyText = 'Swapping…';
    render();
    const pending = toast('pending', 'Swap submitted', `${formatUnits(q.inAmount, inTok.decimals, displayDecimals(inTok.symbol))} ${inTok.symbol} → ${outTok.symbol}`, 0);
    const r = await executeOrder({ signedTransaction: bytesToBase64(signed), requestId: q.requestId });
    pending.remove();
    const entry = {
      ts: Date.now(),
      sig: r.signature || null,
      in: inTok.symbol,
      out: outTok.symbol,
      inAmt: r.totalInputAmount || q.inAmount,
      outAmt: r.totalOutputAmount || q.outAmount,
      to: receiver,
      ok: r.status === 'Success',
    };
    if (r.status === 'Success') {
      const got = `${formatUnits(entry.outAmt, outTok.decimals, displayDecimals(outTok.symbol))} ${outTok.symbol}`;
      toast('ok', 'Swap complete', `${receiver ? `Sent ${got} to ${shortAddress(receiver)}` : `Received ${got}`}`, 9000, r.signature);
      saveHistory([entry, ...loadHistory()]);
      S.inStr = '';
      $('inAmount').value = '';
      S.quote = null;
      S.quoteKey = '';
    } else {
      toast('err', 'Swap failed', executeErrorMessage(r.code, r.error), 12000, r.signature);
      if (r.signature) saveHistory([entry, ...loadHistory()]);
    }
    renderHistory();
    setTimeout(refreshBalances, 1200);
    setTimeout(refreshBalances, 6000);
  } catch (e) {
    if (e.status === 429) {
      toast('', 'Busy', 'The free quote service is busy. Nothing was sent. Try again in a few seconds.');
    } else {
      console.error(e);
      toast('err', 'Swap failed', e.message || String(e), 10000);
    }
  } finally {
    S.busy = false;
    S.confirmImpact = false;
    render();
    const fresh = S.quote && S.quoteKey === currentKey() && Date.now() - S.quoteAt < 5000;
    if (fresh) scheduleRefresh();
    else if (inAmountRaw()) scheduleQuote(0);
  }
}

/* ---------------- history ---------------- */
function renderHistory() {
  const list = loadHistory();
  const body = $('actBody');
  $('clearAct').hidden = !list.length;
  if (!list.length) {
    body.replaceChildren(el('div', { class: 'act-empty', text: 'Your swaps on this device will show here.' }));
    return;
  }
  const ul = el('ul', { class: 'act-list' });
  for (const h of list) {
    const inT = TOKENS.find((t) => t.symbol === h.in);
    const outT = TOKENS.find((t) => t.symbol === h.out);
    const text = `${inT ? formatUnits(h.inAmt, inT.decimals, displayDecimals(h.in)) : ''} ${h.in} → ${outT ? formatUnits(h.outAmt, outT.decimals, displayDecimals(h.out)) : ''} ${h.out}`;
    ul.append(
      el('li', {},
        el('div', {}, el('div', { text: (h.ok ? '' : 'Failed · ') + text }), el('div', { class: 'when', text: new Date(h.ts).toLocaleString() + (h.to ? ` · to ${shortAddress(h.to)}` : '') })),
        h.sig ? el('a', { href: CONFIG.EXPLORER_TX + h.sig, target: '_blank', rel: 'noopener', text: 'View ↗' }) : el('span'))
    );
  }
  body.replaceChildren(ul);
}

/* ---------------- modals ---------------- */
let lastFocus = null;
function openModal(id) {
  lastFocus = document.activeElement;
  const m = $(id);
  m.classList.add('open');
  const f = m.querySelector('button, a, input');
  if (f) f.focus();
}
function closeModal(id) {
  $(id).classList.remove('open');
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
function anyModalOpen() {
  return !!document.querySelector('.modal-bg.open');
}

let pickingSide = 'in';
function openTokenPicker(side) {
  pickingSide = side;
  const list = $('tokenList');
  list.replaceChildren();
  const current = side === 'in' ? S.inTok : S.outTok;
  for (const t of TOKENS) {
    const bal = balanceOf(t);
    list.append(
      el('button', { class: 'list-item', type: 'button', role: 'option', 'aria-selected': String(t === current), onclick: () => pickToken(t) },
        tokIcon(t),
        el('span', { class: 'grow' }, document.createTextNode(t.symbol), el('small', { text: t.name })),
        el('span', { class: 'right', text: bal === null ? '' : formatUnits(bal, t.decimals, displayDecimals(t.symbol)) }))
    );
  }
  openModal('tokenModal');
}
function pickToken(t) {
  closeModal('tokenModal');
  if (pickingSide === 'in') {
    if (t === S.outTok) S.outTok = S.inTok;
    S.inTok = t;
  } else {
    if (t === S.inTok) S.inTok = S.outTok;
    S.outTok = t;
  }
  normaliseInput();
  savePrefs();
  renderTokenButtons();
  scheduleQuote(0);
}

function renderSlippage() {
  for (const b of $('slipOpts').querySelectorAll('button')) {
    const v = b.dataset.bps === 'auto' ? 'auto' : Number(b.dataset.bps);
    b.setAttribute('aria-pressed', String(v === S.slippage));
  }
  const preset = S.slippage === 'auto' || [10, 50, 100].includes(S.slippage);
  if (preset) $('slipCustom').value = '';
  else $('slipCustom').value = String(S.slippage / 100);
  $('slipMsg').textContent = S.slippage !== 'auto' && S.slippage > 300 ? 'High slippage: your trade may be front-run and fill at a worse price.' : S.slippage !== 'auto' && S.slippage < 10 ? 'Very low slippage: your trade may fail.' : '';
}

/* ---------------- toasts ---------------- */
function toast(kind, title, body, ms = 6000, sig) {
  const t = el('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' },
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    el('div', {}, el('b', { text: title }), el('span', { text: body }),
      sig ? el('div', {}, el('a', { href: CONFIG.EXPLORER_TX + sig, target: '_blank', rel: 'noopener', text: 'View transaction ↗' })) : null));
  $('toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

/* ---------------- input handling ---------------- */
function normaliseInput() {
  let v = S.inStr.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const firstDot = v.indexOf('.');
  if (firstDot !== -1) v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
  const [w, f] = v.split('.');
  if (f !== undefined && f.length > S.inTok.decimals) v = `${w}.${f.slice(0, S.inTok.decimals)}`;
  if (/^0\d/.test(v)) v = v.replace(/^0+(?=\d)/, '');
  S.inStr = v;
  $('inAmount').value = v;
}

function setFraction(num, den) {
  const bal = balanceOf(S.inTok);
  if (bal === null) return;
  const max = maxSpendable(bal, S.inTok.symbol, CONFIG.SOL_RESERVE_LAMPORTS);
  const v = (max * BigInt(num)) / BigInt(den);
  S.inStr = v > 0n ? formatUnitsPlain(v, S.inTok.decimals) : '0';
  $('inAmount').value = S.inStr;
  scheduleQuote(0);
}

function bind() {
  $('inAmount').addEventListener('input', (e) => {
    S.inStr = e.target.value;
    normaliseInput();
    scheduleQuote();
  });
  $('halfBtn').addEventListener('click', () => setFraction(1, 2));
  $('maxBtn').addEventListener('click', () => setFraction(1, 1));
  $('flipBtn').addEventListener('click', () => {
    const q = S.quote && S.quoteKey === currentKey() ? S.quote : null;
    [S.inTok, S.outTok] = [S.outTok, S.inTok];
    if (q && q.outAmount) S.inStr = formatUnitsPlain(q.outAmount, S.inTok.decimals, displayDecimals(S.inTok.symbol));
    $('inAmount').value = S.inStr;
    normaliseInput();
    savePrefs();
    renderTokenButtons();
    scheduleQuote(0);
  });
  $('inTokenBtn').addEventListener('click', () => openTokenPicker('in'));
  $('outTokenBtn').addEventListener('click', () => openTokenPicker('out'));

  $('recvToggle').addEventListener('change', (e) => {
    S.receiverOn = e.target.checked;
    $('recvWrap').hidden = !S.receiverOn;
    if (S.receiverOn) $('recvInput').focus();
    scheduleQuote(0);
  });
  $('recvInput').addEventListener('input', (e) => {
    S.receiver = e.target.value.trim();
    scheduleQuote(300);
  });

  $('swapForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!S.session) {
      renderWalletList();
      openModal('walletModal');
      return;
    }
    doSwap();
  });

  $('walletBtn').addEventListener('click', () => {
    if (S.session) {
      $('accName').textContent = S.session.name;
      $('accAddr').textContent = S.session.address;
      $('viewAddr').href = CONFIG.EXPLORER_ACCOUNT + S.session.address;
      openModal('accountModal');
    } else {
      renderWalletList();
      openModal('walletModal');
    }
  });
  $('copyAddr').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(S.session.address);
      toast('ok', 'Copied', shortAddress(S.session.address), 2500);
    } catch (_) {
      toast('err', 'Copy failed', 'Select and copy the address manually.');
    }
  });
  $('disconnectBtn').addEventListener('click', disconnect);

  $('settingsBtn').addEventListener('click', () => {
    renderSlippage();
    openModal('settingsModal');
  });
  $('slipOpts').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.slippage = b.dataset.bps === 'auto' ? 'auto' : Number(b.dataset.bps);
    savePrefs();
    renderSlippage();
    scheduleQuote(0);
  });
  $('slipCustom').addEventListener('change', (e) => {
    const pct = Number(String(e.target.value).replace(',', '.'));
    if (!isFinite(pct) || pct <= 0 || pct > 50) {
      $('slipMsg').textContent = 'Enter a value between 0.01 and 50.';
      return;
    }
    S.slippage = Math.max(1, Math.round(pct * 100));
    savePrefs();
    renderSlippage();
    scheduleQuote(0);
  });

  $('clearAct').addEventListener('click', () => {
    saveHistory([]);
    renderHistory();
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.quote && Date.now() - S.quoteAt > CONFIG.QUOTE_REFRESH_MS && !S.busy) fetchQuote().catch(() => {});
  });

  onWalletsChanged(() => {
    if ($('walletModal').classList.contains('open')) renderWalletList();
  });
}

/* ---------------- boot ---------------- */
loadPrefs();
renderTokenButtons();
bind();
renderWalletButton();
renderHistory();
render();
tryAutoConnect();

// Test hook (used by tests/e2e.mjs); harmless in production.
window.__dankswap = { state: S };
