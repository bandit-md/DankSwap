// Pure helpers with no DOM or network access. Covered by tests/lib.test.mjs.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));

/** Decode a base58 string into bytes. Returns null if the string is not valid base58. */
export function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) return null;
  const bytes = [];
  for (const ch of str) {
    const val = B58_MAP[ch];
    if (val === undefined) return null;
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** True when the string decodes to a 32-byte Solana public key. */
export function isSolanaAddress(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  if (s.length < 32 || s.length > 44) return false;
  const b = base58Decode(s);
  return !!b && b.length === 32;
}

/**
 * Parse a user-typed decimal string into integer base units (BigInt).
 * Returns null for empty or invalid input. Extra decimals beyond `decimals` are rejected.
 */
export function parseUnits(input, decimals) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/,/g, '');
  if (s === '' || s === '.') return null;
  if (!/^\d*\.?\d*$/.test(s)) return null;
  let [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  whole = whole || '0';
  frac = frac.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

/** Format integer base units (BigInt|string|number) as a decimal string, trimmed to maxFrac digits. */
export function formatUnits(value, decimals, maxFrac = decimals) {
  if (value === null || value === undefined || value === '') return '';
  let v = BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac);
  frac = frac.replace(/0+$/, '');
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (frac ? `${w}.${frac}` : w);
}

/** Same as formatUnits but without thousands separators, suitable for writing back into an input. */
export function formatUnitsPlain(value, decimals, maxFrac = decimals) {
  return formatUnits(value, decimals, maxFrac).replace(/,/g, '');
}

/** Sensible display precision for a token amount. */
export function displayDecimals(symbol) {
  return symbol === 'SOL' ? 6 : 4;
}

export function formatUsd(n) {
  if (n === null || n === undefined || !isFinite(n)) return '$—';
  if (n !== 0 && Math.abs(n) < 0.01) return '<$0.01';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPct(n, digits = 2) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

export function bpsToPct(bps) {
  return `${(Number(bps) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** Shorten an address for display: "AbCd…WxYz". */
export function shortAddress(addr, n = 4) {
  if (!addr || addr.length <= n * 2 + 1) return addr || '';
  return `${addr.slice(0, n)}…${addr.slice(-n)}`;
}

/** Max spendable amount. For SOL, keep a reserve for network fees and token-account rent. */
export function maxSpendable(balance, symbol, solReserve) {
  if (balance === null || balance === undefined) return null;
  const b = BigInt(balance);
  if (symbol !== 'SOL') return b;
  const r = BigInt(solReserve);
  return b > r ? b - r : 0n;
}

/** Classify price impact (Jupiter returns percentage points, usually negative). */
export function impactLevel(priceImpact) {
  const p = Math.abs(Number(priceImpact) || 0);
  if (p >= 5) return 'severe';
  if (p >= 1) return 'high';
  return 'ok';
}

/** Rate string "1 SOL ≈ 142.31 USDC" from raw amounts. */
export function rateString(inAmount, inDec, inSym, outAmount, outDec, outSym) {
  const i = Number(inAmount) / 10 ** inDec;
  const o = Number(outAmount) / 10 ** outDec;
  if (!i || !o) return '—';
  const r = o / i;
  const digits = r >= 100 ? 2 : r >= 1 ? 4 : 6;
  return `1 ${inSym} ≈ ${r.toLocaleString('en-US', { maximumFractionDigits: digits })} ${outSym}`;
}

/** Human message for a Jupiter /order errorCode. */
export function orderErrorMessage(router, code, fallback) {
  if (router === 'jupiterz') {
    if (code === 1) return 'Insufficient balance for this swap.';
    if (code === 2) return 'A required token account is missing. Try a smaller amount or a different pair.';
    if (code === 3) return 'This quote could not be built. Try again.';
  } else {
    if (code === 1) return 'Insufficient balance for this swap.';
    if (code === 2) return 'Not enough SOL to pay network fees. Keep about 0.01 SOL in your wallet.';
    if (code === 3) return 'Amount is below the minimum for a gasless swap. Increase the amount or add a little SOL.';
  }
  return fallback || 'This swap cannot be built right now.';
}

/** Human message for a Jupiter /execute failure code. */
export function executeErrorMessage(code, fallback) {
  const map = {
    '-1': 'The quote expired before it was sent. Please try again.',
    '-2': 'The wallet returned an invalid signed transaction.',
    '-3': 'The wallet returned an invalid transaction.',
    '-1000': 'The transaction did not land. No funds moved. Please try again.',
    '-1001': 'Unknown error while sending. Check your wallet history before retrying.',
    '-1002': 'The transaction was rejected as invalid.',
    '-1003': 'The transaction was not fully signed.',
    '-1004': 'The transaction used an invalid block height. Please try again.',
    '-1005': 'The transaction expired before it landed. No funds moved. Please try again.',
    '-2000': 'The market maker could not fill the order. No funds moved. Please try again.',
    '-2001': 'Unknown market-maker error. Check your wallet history before retrying.',
    '-2002': 'The order payload was invalid. Please try again.',
    '-2003': 'The quote expired. Please try again.',
    '-2004': 'The market maker rejected the swap. Please try again.',
  };
  return map[String(code)] || fallback || 'The swap failed. No funds moved.';
}

export function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
