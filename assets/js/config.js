// DankSwap runtime configuration. Edit before deploying. See README.md "Configuration".

export const CONFIG = {
  // Jupiter Swap API V2 (order + execute). Keyless access works at a low rate limit
  // (about 1 request every 2 seconds per user IP). For production traffic, create a free
  // key at https://developers.jup.ag/portal and paste it below.
  JUPITER_API: 'https://api.jup.ag/swap/v2',
  JUPITER_API_KEY: '',

  // Solana RPC, used only to read wallet balances. Swaps are sent by Jupiter, not this RPC.
  // The public endpoint is heavily rate limited; use a provider (Helius, Triton, QuickNode...)
  // in production.
  RPC_URL: 'https://api.mainnet-beta.solana.com',

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

  // Requote interval while a quote is on screen (ms). Keep >= 10000 on keyless access.
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
