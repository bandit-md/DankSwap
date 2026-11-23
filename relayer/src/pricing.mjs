// Live minimum fees for token pools. The relayer pays its costs in SOL (two nullifier accounts'
// rent, the signature fee and, sometimes, a recipient token account), but USDC/USDT withdrawals
// pay it in tokens. Fixed token minimums lose money if SOL gets expensive, so the token minimums
// follow the SOL price from Jupiter's free, keyless Price API. Configured values stay the floor.

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
// Two 8-byte nullifier PDAs (8-byte discriminator + 0 data): rent-exempt minimum each.
export const NULLIFIER_RENT_LAMPORTS = 2n * 946_560n;
// A 165-byte SPL token account.
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;
export const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** Convert a lamport cost to token base units (6-decimal USD stablecoins), with a margin, rounded up. */
export function lamportsToStableUnits(lamports, solUsdMicro, marginBps) {
  const num = BigInt(lamports) * BigInt(solUsdMicro) * (10_000n + BigInt(marginBps));
  const den = 1_000_000_000n * 10_000n;
  return (num + den - 1n) / den;
}

/**
 * Fee table for a SOL price. `floors` = the configured { minFeeLamports, createAtaFee }; stable
 * tokens get max(floor, live cost), SOL keeps its floor (its cost is already in SOL).
 */
export function feesForPrice(solUsd, floors, { marginBps = 2500, priorityLamports = 0n, stables = ['USDC', 'USDT'] } = {}) {
  const micro = BigInt(Math.round(solUsd * 1e6));
  const perTx = NULLIFIER_RENT_LAMPORTS + SIGNATURE_FEE_LAMPORTS + BigInt(priorityLamports);
  const minFeeLamports = { ...floors.minFeeLamports };
  const createAtaFee = { ...floors.createAtaFee };
  for (const s of stables) {
    const live = lamportsToStableUnits(perTx, micro, marginBps);
    const liveAta = lamportsToStableUnits(TOKEN_ACCOUNT_RENT_LAMPORTS, micro, marginBps);
    if (s in minFeeLamports) minFeeLamports[s] = Number(bigMax(BigInt(floors.minFeeLamports[s]), live));
    if (s in createAtaFee) createAtaFee[s] = Number(bigMax(BigInt(floors.createAtaFee[s]), liveAta));
  }
  return { minFeeLamports, createAtaFee };
}

const bigMax = (a, b) => (a > b ? a : b);

/** Polls the SOL price and rewrites config.fees in place (GET /info reads it live). */
export class PriceFeed {
  constructor({ config, fetch: fetchImpl = globalThis.fetch, log = console, intervalMs = 60_000 }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.log = log;
    this.intervalMs = intervalMs;
    this.floors = {
      minFeeLamports: { ...config.fees.minFeeLamports },
      createAtaFee: { ...config.fees.createAtaFee },
    };
    this.solUsd = null;
    this.updatedAt = 0;
    this.timer = null;
  }

  async update() {
    const url = `${this.config.priceApi}?ids=${WSOL_MINT}`;
    const res = await this.fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`price API HTTP ${res.status}`);
    const j = await res.json();
    const p = Number(j && j[WSOL_MINT] && (j[WSOL_MINT].usdPrice ?? j[WSOL_MINT].price));
    // Sanity bounds: ignore nonsense rather than charge absurd fees.
    if (!Number.isFinite(p) || p < 1 || p > 100_000) throw new Error(`implausible SOL price ${p}`);
    this.solUsd = p;
    this.updatedAt = Date.now();
    const f = feesForPrice(p, this.floors, { marginBps: this.config.feeMarginBps, priorityLamports: this.config.priorityLamports || 0n });
    this.config.fees.minFeeLamports = f.minFeeLamports;
    this.config.fees.createAtaFee = f.createAtaFee;
    return p;
  }

  start() {
    const tick = () => this.update().catch((e) => this.log.warn?.(`price feed: ${e.message}; keeping the last fees`));
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }
}
