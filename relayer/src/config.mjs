// Relayer configuration from environment variables. See relayer/README.md.
import { readFileSync } from 'node:fs';
import { POOL_CONFIG } from '../../assets/js/pool/config.js';
import { JUPITER_V6_PROGRAM_ID, MOCK_SWAP_PROGRAM_ID } from '../../assets/js/pool/swap.js';

export const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

const DEFAULT_RPC = { devnet: 'https://api.devnet.solana.com', mainnet: 'https://api.mainnet-beta.solana.com' };

function int(env, name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
}

/** Parse RELAYER_KEYPAIR: a path to a Solana keypair JSON file, or the JSON array itself. */
export function parseKeypairSecret(value) {
  if (!value) throw new Error('RELAYER_KEYPAIR is required (path to a keypair JSON file, or the JSON array)');
  const text = value.trim().startsWith('[') ? value : readFileSync(value, 'utf8');
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || arr.length !== 64 || arr.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('RELAYER_KEYPAIR must hold a 64-byte secret key array');
  }
  return Uint8Array.from(arr);
}

/**
 * Private swap route (docs/PHASE2_SPEC.md §8). Swaps CPI config.swap_program, so the relayer must
 * route through the same program the pool was initialized with:
 * - mainnet: Jupiter v6 (default), quotes and instructions from the keyless Swap API V2 /build;
 * - devnet: no Jupiter, so swaps are off unless SWAP_PROGRAM is the test-only mock-swap program
 *   (programs/mock-swap), priced from SWAP_MOCK_RATES.
 */
function swapConfig(env, cluster) {
  const program = env.SWAP_PROGRAM ?? (cluster === 'mainnet' ? JUPITER_V6_PROGRAM_ID : '');
  let route = '';
  if (program === JUPITER_V6_PROGRAM_ID) {
    if (cluster !== 'mainnet') throw new Error('SWAP_PROGRAM is Jupiter, which only exists on mainnet. Use the mock-swap program for devnet tests, or leave it unset.');
    route = 'jupiter';
  } else if (program === MOCK_SWAP_PROGRAM_ID) {
    if (cluster === 'mainnet') throw new Error('The mock-swap program is test-only and anyone can drain it. Refusing to use it on mainnet.');
    route = 'mock';
  } else if (program) {
    throw new Error(`SWAP_PROGRAM ${program} is not supported (Jupiter v6 ${JUPITER_V6_PROGRAM_ID} or mock-swap ${MOCK_SWAP_PROGRAM_ID})`);
  }
  let mockRates = {};
  if (env.SWAP_MOCK_RATES) {
    try {
      mockRates = JSON.parse(env.SWAP_MOCK_RATES);
    } catch (_) {
      throw new Error('SWAP_MOCK_RATES must be JSON, e.g. {"SOL/USDC":150}');
    }
  } else if (route === 'mock') {
    mockRates = { 'SOL/USDC': 150, 'SOL/USDT': 150, 'USDC/USDT': 1 };
  }
  return {
    route, // '' (off), 'jupiter' or 'mock'
    program,
    jupiterApi: (env.JUPITER_API || 'https://api.jup.ag/swap/v2').replace(/\/+$/, ''),
    // Buffer under the quote for price moves while the user proves (and Jupiter's slippageBps).
    slippageBps: int(env, 'SWAP_SLIPPAGE_BPS', 50),
    // Extra margin under the quote kept by the relayer as surplus (on top of the input-mint fee).
    swapFeeBps: int(env, 'SWAP_FEE_BPS', 0),
    // Cap on the route's account count so the transaction fits 1232 bytes with lookup tables.
    maxAccounts: int(env, 'JUPITER_MAX_ACCOUNTS', 20),
    quoteTtlMs: int(env, 'SWAP_QUOTE_TTL_MS', 60_000),
    // Keyless Jupiter allows 30 requests/min per caller: stay under it for the whole relayer.
    jupiterPerMin: int(env, 'JUPITER_PER_MIN', 25),
    mockRates,
  };
}

export function loadConfig(env = process.env) {
  const cluster = env.CLUSTER || POOL_CONFIG.POOL_CLUSTER || 'devnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet') throw new Error('CLUSTER must be devnet or mainnet');
  // Cluster guard: mainnet only with an explicit opt-in (docs/PHASE2_SPEC.md: audits first).
  if (cluster === 'mainnet' && env.RELAYER_ALLOW_MAINNET !== '1') {
    throw new Error('Refusing to run on mainnet. The pool is unaudited. Set RELAYER_ALLOW_MAINNET=1 only after audits.');
  }
  const tokens = (POOL_CONFIG.TOKENS[cluster] || []).map((t) => ({ ...t, mint: env[`POOL_MINT_${t.symbol}`] ?? t.mint })).filter((t) => t.mint);
  return {
    cluster,
    programId: env.PROGRAM_ID || POOL_CONFIG.POOL_PROGRAM_ID,
    rpcUrl: env.RPC_URL || DEFAULT_RPC[cluster],
    port: int(env, 'PORT', 8787),
    host: env.HOST || '0.0.0.0',
    allowedOrigins: (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === '1',
    indexFile: env.INDEX_FILE || new URL('../data/index.json', import.meta.url).pathname,
    pollMs: int(env, 'POLL_MS', 15_000),
    tokens,
    // Fee schedule (§9). Amounts are base units of each token.
    fees: {
      feeBps: int(env, 'FEE_BPS', 30),
      minFeeLamports: {
        // Covers the relayer's network fee plus rent for two nullifier accounts (~0.002 SOL).
        SOL: int(env, 'MIN_FEE_SOL', 3_000_000),
        USDC: int(env, 'MIN_FEE_USDC', 500_000),
        USDT: int(env, 'MIN_FEE_USDT', 500_000),
      },
      // Extra fee when an unshield must create the recipient's token account (rent ~0.002 SOL).
      createAtaFee: {
        USDC: int(env, 'CREATE_ATA_FEE_USDC', 500_000),
        USDT: int(env, 'CREATE_ATA_FEE_USDT', 500_000),
      },
    },
    rateLimit: {
      relayPerMin: int(env, 'RATE_RELAY_PER_MIN', 6),
      readPerMin: int(env, 'RATE_READ_PER_MIN', 120),
      quotePerMin: int(env, 'RATE_QUOTE_PER_MIN', 20),
    },
    swap: swapConfig(env, cluster),
    // Address lookup table holding the pool's static accounts (scripts/lookup-table.mjs). Needed for
    // token unshields that create the recipient's token account: without it they exceed 1232 bytes.
    lookupTable: env.RELAYER_LOOKUP_TABLE || '',
    computeUnits: int(env, 'COMPUTE_UNITS', POOL_CONFIG.COMPUTE_UNITS),
    priorityMicroLamports: int(env, 'PRIORITY_MICROLAMPORTS', 0),
    checkGenesis: env.SKIP_GENESIS_CHECK !== '1',
    extraSanctionsFile: env.SANCTIONS_FILE || '',
  };
}
