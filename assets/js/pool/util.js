// Byte, field and encoding helpers shared by the private-pool SDK and the relayer.
// No DOM or network access: importable in browsers, Web Workers and Node 20+.
import { base58Decode, bytesToBase64, base64ToBytes } from '../lib.js';

export { base58Decode, bytesToBase64, base64ToBytes };

/** BN254 scalar field (circuit field), docs/PHASE2_SPEC.md §1. */
export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** BN254 base field, used to negate proof A (§7). */
export const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export const U64_MAX = (1n << 64n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

const B58 = '123456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode bytes as base58 (Bitcoin alphabet, as used by Solana). */
export function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const b of bytes) {
    if (b !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  // A zero-length or all-zero input leaves a single leading 0 digit that must not print.
  if (bytes.length && bytes.every((b) => b === 0)) return '1'.repeat(bytes.length);
  return out;
}

/** 32-byte public key from a base58 string or bytes. Throws on anything else. */
export function pubkeyBytes(key) {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new Error('Public key must be 32 bytes');
    return key;
  }
  if (key && typeof key.toBytes === 'function') return pubkeyBytes(key.toBytes());
  const b = base58Decode(String(key || '').trim());
  if (!b || b.length !== 32) throw new Error(`Invalid Solana address: ${key}`);
  return b;
}

export function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('Invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Big-endian unsigned integer from bytes. */
export function bytesToBigInt(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** Big-endian fixed-width bytes from a non-negative BigInt. */
export function bigIntToBytes(value, length = 32) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('Negative value');
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`Value does not fit in ${length} bytes`);
  return out;
}

/** Field element as 32-byte big-endian (§1). */
export function fieldToBytes(value) {
  const v = BigInt(value);
  if (v < 0n || v >= FIELD_SIZE) throw new Error('Not a field element');
  return bigIntToBytes(v, 32);
}

export function u64LE(value) {
  const v = BigInt(value);
  if (v < 0n || v > U64_MAX) throw new Error('u64 out of range');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

export function i64LE(value) {
  const v = BigInt(value);
  if (v < I64_MIN || v > I64_MAX) throw new Error('i64 out of range');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, v, true);
  return out;
}

export function readU64LE(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

export function readI64LE(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigInt64(0, true);
}

export function u32LE(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(value), true);
  return out;
}

/** Reduce any integer (possibly negative) into the field. */
export function modField(v) {
  const r = BigInt(v) % FIELD_SIZE;
  return r < 0n ? r + FIELD_SIZE : r;
}

function cryptoObj() {
  const c = globalThis.crypto;
  if (!c || !c.subtle || !c.getRandomValues) throw new Error('Web Crypto is not available (needs https or localhost)');
  return c;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  cryptoObj().getRandomValues(out);
  return out;
}

export async function sha256(bytes) {
  return new Uint8Array(await cryptoObj().subtle.digest('SHA-256', bytes));
}

export function utf8(str) {
  return new TextEncoder().encode(str);
}
