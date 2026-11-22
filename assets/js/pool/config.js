// Private pool (Phase 2) settings. Edit before deploying. See docs/PHASE2_SPEC.md and relayer/README.md.
//
// UNAUDITED. The circuits, program and trusted setup have not been audited, and the dev trusted
// setup is unsafe for real funds. Every component refuses mainnet unless explicitly configured.

export const POOL_CONFIG = {
  // 'devnet' (default) or 'mainnet'. Mainnet also needs POOL_AUDITED and real audits.
  POOL_CLUSTER: 'devnet',

  // dankswap_pool program id. Placeholder until the program is deployed; while it is the
  // placeholder the page shows "not deployed yet" and builds no transactions.
  POOL_PROGRAM_ID: '11111111111111111111111111111111',

  // Relayer base URL (https, no trailing slash). It submits private sends and unshields so the
  // user's wallet never appears on-chain, and serves the commitment index used for balances.
  // Empty = not configured. Must be https: the page's Content-Security-Policy only allows https.
  RELAYER_URL: '',

  // Set to true only after independent audits of the circuits and the program and a public
  // multi-party trusted setup. Until then the "Unaudited" banner stays on every cluster.
  POOL_AUDITED: false,

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

/** The placeholder program id means "not deployed". */
export function poolDeployed(cfg = POOL_CONFIG) {
  return !!cfg.POOL_PROGRAM_ID && cfg.POOL_PROGRAM_ID !== '11111111111111111111111111111111';
}

/** Show the unaudited banner unless the cluster is mainnet and POOL_AUDITED is true (§10). */
export function showUnauditedBanner(cfg = POOL_CONFIG) {
  return !(cfg.POOL_CLUSTER === 'mainnet' && cfg.POOL_AUDITED === true);
}

export function poolTokens(cfg = POOL_CONFIG) {
  return (cfg.TOKENS[cfg.POOL_CLUSTER] || []).slice();
}
