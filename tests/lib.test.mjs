import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base58Decode, isSolanaAddress, parseUnits, formatUnits, formatUnitsPlain, maxSpendable,
  impactLevel, rateString, orderErrorMessage, executeErrorMessage, bpsToPct, shortAddress,
  bytesToBase64, base64ToBytes, formatUsd,
} from '../assets/js/lib.js';

test('base58 decodes known Solana keys to 32 bytes', () => {
  assert.equal(base58Decode('So11111111111111111111111111111111111111112').length, 32);
  assert.equal(base58Decode('11111111111111111111111111111111').length, 32);
  assert.deepEqual([...base58Decode('11111111111111111111111111111111')], new Array(32).fill(0));
  assert.equal(base58Decode('0OIl'), null);
});

test('base58 alphabet is complete and round-trips real keys', () => {
  // Regression: the alphabet once lacked 'L', rejecting valid addresses.
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  for (const ch of B58) assert.ok(base58Decode(ch + '1'.repeat(10)) !== null, ch);
  // Addresses containing 'L' (Raydium AMM v4, Token-2022, Jupiter v6 programs)
  for (const a of ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4']) {
    assert.ok(isSolanaAddress(a), a);
  }
  // Known decoding: System Program = 32 zero bytes; wSOL mint first byte 0x06
  assert.equal(base58Decode('So11111111111111111111111111111111111111112')[0], 0x06);
});

test('isSolanaAddress', () => {
  assert.ok(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
  assert.ok(isSolanaAddress('  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB '));
  assert.ok(!isSolanaAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'));
  assert.ok(!isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEG'));
  assert.ok(!isSolanaAddress(''));
  assert.ok(!isSolanaAddress(null));
});

test('parseUnits', () => {
  assert.equal(parseUnits('1', 9), 1_000_000_000n);
  assert.equal(parseUnits('1.5', 6), 1_500_000n);
  assert.equal(parseUnits('.25', 6), 250_000n);
  assert.equal(parseUnits('0.000001', 6), 1n);
  assert.equal(parseUnits('0.0000001', 6), null);
  assert.equal(parseUnits('1,000.5', 6), 1_000_500_000n);
  assert.equal(parseUnits('', 6), null);
  assert.equal(parseUnits('.', 6), null);
  assert.equal(parseUnits('abc', 6), null);
  assert.equal(parseUnits('1e5', 6), null);
  assert.equal(parseUnits('-1', 6), null);
});

test('formatUnits', () => {
  assert.equal(formatUnits(1_500_000n, 6), '1.5');
  assert.equal(formatUnits('1234567890000', 6, 2), '1,234,567.89');
  assert.equal(formatUnits(1n, 9, 6), '0');
  assert.equal(formatUnits(0n, 9), '0');
  assert.equal(formatUnitsPlain(1_234_500_000n, 6), '1234.5');
});

test('maxSpendable keeps SOL reserve only for SOL', () => {
  assert.equal(maxSpendable(1_000_000_000n, 'SOL', 10_000_000), 990_000_000n);
  assert.equal(maxSpendable(5_000_000n, 'SOL', 10_000_000), 0n);
  assert.equal(maxSpendable(5_000_000n, 'USDC', 10_000_000), 5_000_000n);
  assert.equal(maxSpendable(null, 'SOL', 1), null);
});

test('impactLevel thresholds', () => {
  assert.equal(impactLevel(-0.05), 'ok');
  assert.equal(impactLevel(-1.2), 'high');
  assert.equal(impactLevel(-7), 'severe');
  assert.equal(impactLevel(undefined), 'ok');
});

test('rateString', () => {
  assert.equal(rateString('1000000000', 9, 'SOL', '142310000', 6, 'USDC'), '1 SOL ≈ 142.31 USDC');
  assert.equal(rateString('0', 9, 'SOL', '1', 6, 'USDC'), '—');
});

test('error messages', () => {
  assert.match(orderErrorMessage('metis', 2), /SOL/);
  assert.match(orderErrorMessage('jupiterz', 2), /token account/);
  assert.equal(orderErrorMessage('metis', 99, 'x'), 'x');
  assert.match(executeErrorMessage(-1005), /expired/);
  assert.match(executeErrorMessage('-2003'), /expired/);
  assert.equal(executeErrorMessage(-9, 'raw'), 'raw');
});

test('misc formatting', () => {
  assert.equal(bpsToPct(50), '0.5%');
  assert.equal(bpsToPct(10), '0.1%');
  assert.equal(bpsToPct(100), '1%');
  assert.equal(shortAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'EPjF…Dt1v');
  assert.equal(formatUsd(1234.5), '$1,234.50');
  assert.equal(formatUsd(0.001), '<$0.01');
  assert.equal(formatUsd(undefined), '$—');
});

test('base64 round trip', () => {
  const b = new Uint8Array(70000).map((_, i) => i % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(b)), b);
});
