// DankSwap runtime configuration. Edit before deploying. See README.md "Configuration".

export const CONFIG = {
  // Everything below uses free, keyless public APIs. No sign-up, no API keys, no backend.

  // Jupiter Swap API V2 (order + execute), keyless tier: 30 requests per minute per caller.
  // Requests come from each visitor's own browser, so every visitor has their own allowance.
  // Do NOT add a free-tier API key here: free keys are limited to 1 request/second for the
  // whole organisation, which every visitor would then share.
  JUPITER_API: 'https://api.jup.ag/swap/v2',
  // Minimum spacing between quote requests from one browser (30/min = one per 2 s).
  JUPITER_MIN_INTERVAL_MS: 2_100,

  // Free public Solana RPC endpoints, used only to read wallet balances (swaps are sent by
  // Jupiter). Tried in order; the first that answers is remembered. If all fail, balances show
  // as "—" and swapping still works.
  RPC_URLS: [
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
    'https://solana.drpc.org',
  ],

  // DankSwap revenue. Leave REFERRAL_ACCOUNT empty to charge no DankSwap fee.
  // Create the account at https://referral.jup.ag under the Jupiter Ultra referral project and
  // initialise token accounts for SOL, USDC and USDT, or the fee is skipped for that mint.
  // Jupiter accepts 50-255 bps and keeps 20% of integrator fees.
  REFERRAL_ACCOUNT: '',
  REFERRAL_FEE_BPS: 50,

  EXPLORER_TX: 'https://solscan.io/tx/',
  EXPLORER_ACCOUNT: 'https://solscan.io/account/',

  // SOL kept back when the user presses Max (lamports): fees plus token-account rent.
  SOL_RESERVE_LAMPORTS: 10_000_000, // 0.01 SOL

  // Requote interval while a quote is on screen (ms). Keeps well inside the keyless limit.
  QUOTE_REFRESH_MS: 20_000,
  // A quote older than this is refreshed before asking the wallet to sign (ms).
  QUOTE_MAX_AGE_MS: 25_000,
};

export const TOKENS = [
  {
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    color: '#9945FF',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    color: '#2775CA',
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    color: '#26A17B',
  },
];
