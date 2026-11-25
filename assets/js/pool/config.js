// Private pool (Phase 2) settings. Edit before deploying. See docs/PHASE2_SPEC.md and relayer/README.md.
//
// UNAUDITED. The circuits, program and trusted setup have not been audited, and the dev trusted
// setup is unsafe for real funds. Every component refuses mainnet unless explicitly configured.

export const POOL_CONFIG = {
  // 'devnet' (default) or 'mainnet'. Mainnet also needs POOL_AUDITED and real audits.
  POOL_CLUSTER: 'devnet',

  // dankswap_pool program id (programs/README.md). The page checks on-chain that the program's
  // config account exists and shows "not deployed yet" until it does. '' = not configured.
  POOL_PROGRAM_ID: 'FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6',

  // Relayer base URL (https, no trailing slash). It submits private sends and unshields so the
  // user's wallet never appears on-chain, and serves the commitment index used for balances.
  // Empty = not configured. Must be https: the page's Content-Security-Policy only allows https.
  RELAYER_URL: '',
  // More relayers (https, tried in order after RELAYER_URL). If one is unreachable or failing, the
  // page switches to the next and re-proves (the proof binds the relayer's fee account). A refusal
  // such as a sanctions hit is not retried elsewhere.
  RELAYER_URLS: [],

  // Set to true only after independent audits of the circuits and the program and a public
  // multi-party trusted setup. Until then the "Unaudited" banner stays on every cluster.
  POOL_AUDITED: false,

  // Official site host name, e.g. 'dankswap.example' (no https://, no path). When set, unlocking
  // signs a Sign-In-With-Solana message for this domain, so wallets warn about phishing sites, and
  // the page refuses to unlock on any other host. Every user's private keys derive from this
  // message: set it ONCE before any real deposit and never change it. '' = v1 devnet message.
  SITE_DOMAIN: '',

  // Free public RPC per cluster (tried in order).
  RPC: {
    devnet: ['https://api.devnet.solana.com'],
    mainnet: ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'],
  },

  // Explorer links per cluster.
  EXPLORER_TX: {
    devnet: (sig) => `https://solscan.io/tx/${sig}?cluster=devnet`,
    mainnet: (sig) => `https://solscan.io/tx/${sig}`,
  },

  // Tokens with a pool, per cluster. mint '' = no pool on that cluster.
  // Native SOL uses the wSOL mint for mintField but the pool holds native lamports (§1).
  TOKENS: {
    devnet: [
      { symbol: 'SOL', name: 'Solana', mint: 'So11111111111111111111111111111111111111112', decimals: 9, native: true, color: '#9945FF' },
      // Circle's devnet USDC (faucet.circle.com).
      { symbol: 'USDC', name: 'USD Coin', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6, color: '#2775CA' },
      // There is no official devnet USDT. Put the mint of your own devnet test token here.
      { symbol: 'USDT', name: 'Tether USD', mint: '', decimals: 6, color: '#26A17B' },
    ],
    mainnet: [
      { symbol: 'SOL', name: 'Solana', mint: 'So11111111111111111111111111111111111111112', decimals: 9, native: true, color: '#9945FF' },
      { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, color: '#2775CA' },
      { symbol: 'USDT', name: 'Tether USD', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, color: '#26A17B' },
    ],
  },

  // Proving files (Groth16, dev trusted setup). Paths are relative to the site root.
  ZK_WASM: 'assets/zk/transaction.wasm',
  ZK_ZKEY: 'assets/zk/transaction_final.zkey',

  // Merkle tree depth (§3) and compute budget (§8).
  TREE_LEVELS: 20,
  COMPUTE_UNITS: 1_400_000,

  // SOL kept back when shielding with Max (lamports): fees plus nullifier account rent.
  SOL_RESERVE_LAMPORTS: 10_000_000,
};

/** A program id is configured (whether it is deployed is checked on-chain by the client). */
export function poolConfigured(cfg = POOL_CONFIG) {
  return typeof cfg.POOL_PROGRAM_ID === 'string' && cfg.POOL_PROGRAM_ID.length >= 32 && cfg.POOL_PROGRAM_ID !== '11111111111111111111111111111111';
}

/** Show the unaudited banner unless the cluster is mainnet and POOL_AUDITED is true (§10). */
export function showUnauditedBanner(cfg = POOL_CONFIG) {
  return !(cfg.POOL_CLUSTER === 'mainnet' && cfg.POOL_AUDITED === true);
}

export function poolTokens(cfg = POOL_CONFIG) {
  return (cfg.TOKENS[cfg.POOL_CLUSTER] || []).slice();
}
