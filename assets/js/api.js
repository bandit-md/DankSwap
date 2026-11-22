// Network calls: Jupiter Swap API V2 and Solana JSON-RPC (balances only).
import { CONFIG } from './config.js';

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function jupHeaders(extra = {}) {
  const h = { Accept: 'application/json', ...extra };
  if (CONFIG.JUPITER_API_KEY) h['x-api-key'] = CONFIG.JUPITER_API_KEY;
  return h;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return { error: text.slice(0, 200) };
  }
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
  let res;
  try {
    res = await fetch(`${CONFIG.JUPITER_API}/order?${p}`, { headers: jupHeaders(), signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Could not reach the quote service. Check your connection.');
  }
  const body = await readJson(res);
  if (res.status === 429) throw new ApiError('Too many requests. Waiting a moment…', { status: 429 });
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

/** POST /execute with the signed transaction. */
export async function executeOrder({ signedTransaction, requestId }) {
  let res;
  try {
    res = await fetch(`${CONFIG.JUPITER_API}/execute`, {
      method: 'POST',
      headers: jupHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ signedTransaction, requestId }),
    });
  } catch (e) {
    throw new ApiError('Network error while sending. Check your wallet history before retrying.');
  }
  const body = await readJson(res);
  if (!res.ok && !body.status) {
    throw new ApiError(body.error || `Execution failed (${res.status})`, { status: res.status, code: body.code, body });
  }
  return body;
}

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(CONFIG.RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new ApiError(`RPC ${res.status}`, { status: res.status });
  const body = await res.json();
  if (body.error) throw new ApiError(body.error.message || 'RPC error');
  return body.result;
}

/**
 * Balances in base units (BigInt) for each token, keyed by symbol.
 * SOL is the native balance; SPL tokens sum all token accounts for the mint.
 */
export async function getBalances(owner, tokens) {
  const out = {};
  await Promise.all(
    tokens.map(async (t) => {
      if (t.symbol === 'SOL') {
        const r = await rpc('getBalance', [owner, { commitment: 'confirmed' }]);
        out[t.symbol] = BigInt(r.value);
      } else {
        const r = await rpc('getTokenAccountsByOwner', [
          owner,
          { mint: t.mint },
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ]);
        let sum = 0n;
        for (const acc of r.value || []) {
          const amt = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
          if (amt) sum += BigInt(amt);
        }
        out[t.symbol] = sum;
      }
    })
  );
  return out;
}
