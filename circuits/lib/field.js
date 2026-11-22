// Field constants and byte helpers (spec §1).

/** BN254 scalar field modulus (circuit field). */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** BN254 base field modulus (curve coordinates). */
export const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export const mod = (x, m = P) => ((BigInt(x) % m) + m) % m;

/** bigint -> 32-byte big-endian Uint8Array. */
export function toBE32(x) {
  let v = BigInt(x);
  if (v < 0n || v >= 1n << 256n) throw new Error('toBE32: out of range');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/** big-endian bytes -> bigint. */
export function fromBE(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

export const toHex = (bytes) => Buffer.from(bytes).toString('hex');
export const fromHex = (hex) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
export const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// ---- base58 (Bitcoin alphabet, as used by Solana) ----
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Decode(str) {
  let v = 0n;
  for (const c of str) {
    const d = MAP.get(c);
    if (d === undefined) throw new Error(`invalid base58 char ${c}`);
    v = v * 58n + d;
  }
  const bytes = [];
  while (v > 0n) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

export function base58Encode(bytes) {
  let v = fromBE(bytes);
  let s = '';
  while (v > 0n) { s = ALPHABET[Number(v % 58n)] + s; v /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

/** Decode a Solana pubkey (base58 string or 32 bytes) to 32 bytes. */
export function pubkeyBytes(pk) {
  const b = typeof pk === 'string' ? base58Decode(pk) : new Uint8Array(pk);
  if (b.length !== 32) throw new Error(`pubkey must be 32 bytes, got ${b.length}`);
  return b;
}
