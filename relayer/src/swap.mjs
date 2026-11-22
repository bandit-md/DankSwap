// Swap routes for transact_swap (docs/PHASE2_SPEC.md §8, programs/README.md): Jupiter Swap API V2
// `/build` on mainnet (keyless, raw instructions), or the test-only mock-swap program in dev.
// Both return the same normalized shape, so quoting and relaying share one code path.
import { swapEscrowAccounts, mockSwapInstruction, buildLookupTableAddresses } from '../../assets/js/pool/swap.js';

export class SwapRouteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Sliding one-minute counter shared by every caller (Jupiter's keyless limit is per caller IP). */
class MinuteBudget {
  constructor(perMinute) {
    this.limit = perMinute;
    this.stamps = [];
  }

  take(now = Date.now()) {
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  }
}

/**
 * @typedef {object} SwapRoute
 * @property {'jupiter'|'mock'} route
 * @property {bigint} inAmount
 * @property {bigint} outAmount
 * @property {bigint} otherAmountThreshold   minimum the route itself enforces on-chain
 * @property {string} priceImpactPct         decimal ratio as a string ("0.001" = 0.1%)
 * @property {number} slippageBps
 * @property {{programId, accounts, data}} swapInstruction
 * @property {Array} setupInstructions
 * @property {string[]} lookupTables         lookup table addresses the route needs
 */

export class SwapRouter {
  /**
   * @param {object} o
   * @param {object} o.web3
   * @param {object} o.config      relayer config (loadConfig)
   * @param {string} o.relayer     relayer address (fee payer for route setup)
   * @param {Function} [o.fetch]
   */
  constructor({ web3, config, relayer, fetch: fetchImpl = globalThis.fetch?.bind(globalThis) }) {
    this.web3 = web3;
    this.config = config;
    this.swap = config.swap || { route: '' };
    this.relayer = relayer;
    this.fetch = fetchImpl;
    this.budget = new MinuteBudget(this.swap.jupiterPerMin || 25);
  }

  get enabled() {
    return this.swap.route === 'jupiter' || this.swap.route === 'mock';
  }

  /** Why swaps are off on this relayer, for clients. */
  get disabledReason() {
    if (this.enabled) return '';
    return this.config.cluster === 'mainnet'
      ? 'This relayer has no swap route configured.'
      : 'Private swaps route through Jupiter, which only exists on Solana mainnet.';
  }

  /**
   * Route `amount` (base units of inputMint) from the input pool's escrow to its output token account.
   * @returns {Promise<SwapRoute>}
   */
  async build({ inputMint, outputMint, amount, slippageBps = this.swap.slippageBps, maxAccounts = this.swap.maxAccounts }) {
    if (!this.enabled) throw new SwapRouteError(400, this.disabledReason);
    if (this.swap.route === 'mock') return this._mock({ inputMint, outputMint, amount, slippageBps });
    return this._jupiter({ inputMint, outputMint, amount, slippageBps, maxAccounts });
  }

  async _jupiter({ inputMint, outputMint, amount, slippageBps, maxAccounts }) {
    const e = swapEscrowAccounts(this.web3, this.config.programId, inputMint, outputMint);
    // The program wraps native SOL into the escrow's wSOL account itself and unwraps SOL output by
    // closing the escrow's wSOL output account, so Jupiter must not wrap or unwrap: it swaps from
    // the taker's (escrow's) input ATA into the escrow's output ATA. The relayer pays any setup.
    const q = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amount),
      taker: e.escrow,
      payer: this.relayer,
      slippageBps: String(slippageBps),
      wrapAndUnwrapSol: 'false',
      destinationTokenAccount: e.escrowOutput,
      maxAccounts: String(maxAccounts),
    });
    if (!this.budget.take()) throw new SwapRouteError(429, 'The swap router is busy. Try again in a minute.');
    let res;
    try {
      res = await this.fetch(`${this.swap.jupiterApi}/build?${q}`, { headers: { accept: 'application/json' } });
    } catch (_) {
      throw new SwapRouteError(502, 'Could not reach Jupiter. Try again.');
    }
    const j = await res.json().catch(() => ({}));
    if (res.status === 429) throw new SwapRouteError(429, 'Jupiter rate limit reached. Try again in a minute.');
    if (!res.ok) throw new SwapRouteError(res.status >= 500 ? 502 : 400, `No swap route: ${j.error || `Jupiter HTTP ${res.status}`}`);
    if (!j.swapInstruction || !j.outAmount) throw new SwapRouteError(502, 'Jupiter returned an incomplete route');
    if (j.inputMint && j.inputMint !== inputMint) throw new SwapRouteError(502, 'Jupiter route has the wrong input mint');
    if (j.outputMint && j.outputMint !== outputMint) throw new SwapRouteError(502, 'Jupiter route has the wrong output mint');
    if (j.inAmount && BigInt(j.inAmount) !== BigInt(amount)) throw new SwapRouteError(502, 'Jupiter route swaps a different amount');
    if (j.swapMode && j.swapMode !== 'ExactIn') throw new SwapRouteError(502, 'Jupiter route is not ExactIn');
    return {
      route: 'jupiter',
      inAmount: BigInt(amount),
      outAmount: BigInt(j.outAmount),
      otherAmountThreshold: BigInt(j.otherAmountThreshold ?? j.outAmount),
      priceImpactPct: String(j.priceImpactPct ?? j.priceImpact ?? '0'),
      slippageBps: Number(j.slippageBps ?? slippageBps),
      swapInstruction: j.swapInstruction,
      setupInstructions: j.setupInstructions || [],
      lookupTables: buildLookupTableAddresses(j),
      lookupTableHints: j.addressesByLookupTableAddress || null,
      routePlan: (j.routePlan || []).map((s) => s.swapInfo && s.swapInfo.label).filter(Boolean),
    };
  }

  /** Dev route: a fixed rate (SWAP_MOCK_RATES, UI units), mock-swap pays exactly outAmount. */
  async _mock({ inputMint, outputMint, amount, slippageBps }) {
    const tin = this.config.tokens.find((t) => t.mint === inputMint);
    const tout = this.config.tokens.find((t) => t.mint === outputMint);
    if (!tin || !tout) throw new SwapRouteError(400, 'Unknown pool');
    const rates = this.swap.mockRates || {};
    let num;
    let den;
    const direct = rates[`${tin.symbol}/${tout.symbol}`];
    const inverse = rates[`${tout.symbol}/${tin.symbol}`];
    const scale = 1_000_000_000n;
    if (direct) {
      num = BigInt(Math.round(Number(direct) * 1e9));
      den = scale;
    } else if (inverse) {
      num = scale;
      den = BigInt(Math.round(Number(inverse) * 1e9));
    } else {
      throw new SwapRouteError(400, `No mock rate for ${tin.symbol}/${tout.symbol} (SWAP_MOCK_RATES)`);
    }
    // out = amount * rate * 10^(outDecimals - inDecimals)
    let out = BigInt(amount) * num;
    let d = den;
    const dd = tout.decimals - tin.decimals;
    if (dd >= 0) out *= 10n ** BigInt(dd);
    else d *= 10n ** BigInt(-dd);
    out /= d;
    if (out <= 0n) throw new SwapRouteError(400, 'Amount too small to swap');
    const ix = await mockSwapInstruction(this.web3, { programId: this.config.programId, inputMint, outputMint, amountIn: BigInt(amount), amountOut: out, mockProgram: this.swap.program });
    return {
      route: 'mock',
      inAmount: BigInt(amount),
      outAmount: out,
      otherAmountThreshold: out, // mock-swap pays exactly amount_out or fails
      priceImpactPct: '0',
      slippageBps,
      swapInstruction: ix,
      setupInstructions: [],
      lookupTables: [],
      lookupTableHints: null,
      routePlan: ['mock-swap'],
    };
  }
}
