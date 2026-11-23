import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feesForPrice, lamportsToStableUnits, PriceFeed, WSOL_MINT, NULLIFIER_RENT_LAMPORTS, SIGNATURE_FEE_LAMPORTS } from '../src/pricing.mjs';

const floors = { minFeeLamports: { SOL: 3_000_000, USDC: 500_000, USDT: 500_000 }, createAtaFee: { USDC: 500_000, USDT: 500_000 } };

test('lamport cost converts to stablecoin units with margin, rounded up', () => {
  // 1 SOL at $150 with no margin = 150 USDC
  assert.equal(lamportsToStableUnits(1_000_000_000n, 150_000_000n, 0), 150_000_000n);
  // 1 lamport at $150 is 0.00015 micro-USD: rounds up to 1 unit
  assert.equal(lamportsToStableUnits(1n, 150_000_000n, 0), 1n);
});

test('cheap SOL keeps the configured floors', () => {
  const f = feesForPrice(150, floors);
  // per-tx cost 0.001898 SOL * $150 * 1.25 ≈ $0.356 < $0.50 floor
  assert.equal(f.minFeeLamports.USDC, 500_000);
  assert.equal(f.minFeeLamports.SOL, 3_000_000);
  // token account rent 0.00203928 SOL * $150 * 1.25 ≈ $0.382 < floor
  assert.equal(f.createAtaFee.USDT, 500_000);
});

test('expensive SOL raises token minimums to cover costs', () => {
  const f = feesForPrice(400, floors);
  const cost = NULLIFIER_RENT_LAMPORTS + SIGNATURE_FEE_LAMPORTS;
  const expect = Number(lamportsToStableUnits(cost, 400_000_000n, 2500));
  assert.equal(f.minFeeLamports.USDC, expect);
  assert.ok(f.minFeeLamports.USDC > 500_000); // ≈ $0.95
  assert.ok(f.createAtaFee.USDC > 1_000_000); // ≈ $1.02
  assert.equal(f.minFeeLamports.SOL, 3_000_000, 'SOL fees are already in SOL');
  // floors are not mutated
  assert.equal(floors.minFeeLamports.USDC, 500_000);
});

test('PriceFeed updates config.fees live and ignores implausible prices', async () => {
  let price = 400;
  const config = { priceApi: 'https://example.test/price', feeMarginBps: 2500, fees: { feeBps: 30, ...structuredClone(floors) } };
  const fetch = async (url) => {
    assert.match(url, new RegExp(`ids=${WSOL_MINT}`));
    return { ok: true, json: async () => ({ [WSOL_MINT]: { usdPrice: price } }) };
  };
  const feed = new PriceFeed({ config, fetch, log: { warn() {} } });
  await feed.update();
  assert.ok(config.fees.minFeeLamports.USDC > 500_000);
  price = 0.0001;
  await assert.rejects(feed.update(), /implausible/);
  assert.ok(config.fees.minFeeLamports.USDC > 500_000, 'last good fees kept');
  price = 100;
  await feed.update();
  assert.equal(config.fees.minFeeLamports.USDC, 500_000, 'falls back to floor when SOL is cheap again');
});
