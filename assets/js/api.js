// Network calls, all to free, keyless public APIs:
//  - Jupiter Swap API V2 (keyless tier) for quotes and transaction landing
//  - Public Solana RPC endpoints (with fallback) for wallet balances
import { CONFIG } from './config.js';

export class ApiError extends Error {
  constructor(message, { status, code, body, retryAfterMs } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms, signal) =>
  new Promise((ok, fail) => {
    const t = setTimeout(ok, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        fail(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return { error: text.slice(0, 200) };
  }
}

/* ---------- Jupiter keyless pacing ----------
 * Keyless access allows 30 requests per 60 s sliding window per caller. Quote requests are
 * spaced so one browser never exceeds it. /execute has its own, much larger bucket and is
 * not paced, so a swap is never delayed after the user signs. */
let nextSlot = 0;

async function takeSlot(signal) {
  const interval = CONFIG.JUPITER_MIN_INTERVAL_MS;
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + interval;
  if (start > now) {
    try {
      await sleep(start - now, signal);
    } catch (e) {
      // Give the unused slot back.
      if (nextSlot === start + interval) nextSlot = start;
      throw e;
    }
  }
}

function retryAfter(res) {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (reset > 0) return Math.min(30_000, Math.max(500, reset * 1000 - Date.now()));
  return 4_000;
}

/** Milliseconds until the next quote request may be sent (for UI hints). */
export function quoteWaitMs() {
  return Math.max(0, nextSlot - Date.now());
}

/**
 * GET /order. Returns a quote, and when `taker` is given, a base64 transaction to sign.
 */
export async function getOrder({ inputMint, outputMint, amount, taker, receiver, slippageBps, signal }) {
  const p = new URLSearchParams({ inputMint, outputMint, amount: String(amount) });
  if (taker) p.set('taker', taker);
  if (receiver && receiver !== taker) p.set('receiver', receiver);
  if (slippageBps !== null && slippageBps !== undefined) p.set('slippageBps', String(slippageBps));
  if (CONFIG.REFERRAL_ACCOUNT) {
    p.set('referralAccount', CONFIG.REFERRAL_ACCOUNT);
    p.set('referralFee', String(CONFIG.REFERRAL_FEE_BPS));
  }
  await takeSlot(signal);
  let res;
  try {
    res = await fetch(`${CONFIG.JUPITER_API}/order?${p}`, { headers: { Accept: 'application/json' }, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Could not reach the quote service. Check your connection.');
  }
  if (res.status === 429) {
    const wait = retryAfter(res);
    nextSlot = Math.max(nextSlot, Date.now() + wait);
    throw new ApiError('Busy, retrying…', { status: 429, retryAfterMs: wait });
  }
  const body = await readJson(res);
  if (!res.ok) {
    const msg = body.error || body.errorMessage || `Quote failed (${res.status})`;
    throw new ApiError(friendlyQuoteError(msg), { status: res.status, body });
  }
  return body;
}

function friendlyQuoteError(msg) {
  if (/no route|could not find any route|NO_ROUTES_FOUND/i.test(msg)) return 'No route found for this pair and amount.';
  if (/amount/i.test(msg) && /small|minimum/i.test(msg)) return 'Amount is too small to swap.';
  return msg;
}

/** POST /execute with the signed transaction. Retries briefly if rate limited. */
export async function executeOrder({ signedTransaction, requestId }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${CONFIG.JUPITER_API}/execute`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedTransaction, requestId }),
      });
    } catch (e) {
      throw new ApiError('Network error while sending. Check your wallet history before retrying.');
    }
    if (res.status === 429 && attempt < 3) {
      await sleep(Math.min(retryAfter(res), 3000));
      continue;
    }
    const body = await readJson(res);
    if (!res.ok && !body.status) {
      throw new ApiError(body.error || `Execution failed (${res.status})`, { status: res.status, code: body.code, body });
    }
    return body;
  }
}

/* ---------- Solana RPC with fallback across free public endpoints ---------- */
let rpcId = 0;
const RPC_PREF_KEY = 'dankswap.rpc';
let preferred = 0; // index of the last endpoint that worked, remembered across visits
try {
  const saved = localStorage.getItem(RPC_PREF_KEY);
  const idx = CONFIG.RPC_URLS.indexOf(saved);
  if (idx >= 0) preferred = idx;
} catch (_) {}

async function rpcOnce(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new ApiError(`RPC ${res.status}`, { status: res.status });
    const body = await res.json();
    if (body.error) throw new ApiError(body.error.message || 'RPC error');
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

export async function rpc(method, params) {
  const urls = CONFIG.RPC_URLS;
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const idx = (preferred + i) % urls.length;
    try {
      const r = await rpcOnce(urls[idx], method, params);
      if (preferred !== idx) {
        preferred = idx;
        try {
          localStorage.setItem(RPC_PREF_KEY, urls[idx]);
        } catch (_) {}
      }
      return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new ApiError('No RPC endpoint available');
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * Balances in base units (BigInt) for each token, keyed by symbol. Two RPC calls total:
 * native SOL, and every SPL token account the wallet owns (summed per mint).
 */
export async function getBalances(owner, tokens) {
  const [sol, accounts] = await Promise.all([
    rpc('getBalance', [owner, { commitment: 'confirmed' }]),
    rpc('getTokenAccountsByOwner', [owner, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
  ]);
  const byMint = {};
  for (const acc of accounts.value || []) {
    const info = acc.account?.data?.parsed?.info;
    if (!info?.mint || !info.tokenAmount?.amount) continue;
    byMint[info.mint] = (byMint[info.mint] || 0n) + BigInt(info.tokenAmount.amount);
  }
  const out = {};
  for (const t of tokens) out[t.symbol] = t.symbol === 'SOL' ? BigInt(sol.value) : byMint[t.mint] || 0n;
  return out;
}
