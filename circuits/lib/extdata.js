// External data hash (spec §5).
import { createHash } from 'node:crypto';
import { fromBE, toHex, fromHex, pubkeyBytes, concat } from './field.js';

export const ENC_LEN = 87;
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n, U64_MAX = (1n << 64n) - 1n;

function blob(x) {
  if (x === undefined || x === null) return new Uint8Array(ENC_LEN);
  const b = typeof x === 'string' ? fromHex(x) : new Uint8Array(x);
  if (b.length !== ENC_LEN) throw new Error(`encrypted output must be ${ENC_LEN} bytes, got ${b.length}`);
  return b;
}

/** Serialize extData into the exact byte string hashed by §5 (32+32+8+8+87*3 = 341 bytes). */
export function extDataBytes(ext) {
  const extAmount = BigInt(ext.extAmount);
  const fee = BigInt(ext.fee);
  if (extAmount < I64_MIN || extAmount > I64_MAX) throw new Error('extAmount out of i64');
  if (fee < 0n || fee > U64_MAX) throw new Error('fee out of u64');
  const nums = Buffer.alloc(16);
  nums.writeBigInt64LE(extAmount, 0);
  nums.writeBigUInt64LE(fee, 8);
  return concat(
    pubkeyBytes(ext.recipient),
    pubkeyBytes(ext.relayer),
    new Uint8Array(nums),
    blob(ext.encryptedOutput1),
    blob(ext.encryptedOutput2),
    blob(ext.encryptedSwapOutput),
  );
}

/** sha256(...) with byte 0 zeroed -> { bytes (32 BE), value (bigint) } */
export function extDataHash(ext) {
  const d = new Uint8Array(createHash('sha256').update(extDataBytes(ext)).digest());
  d[0] = 0;
  return { bytes: d, hex: toHex(d), value: fromBE(d) };
}
