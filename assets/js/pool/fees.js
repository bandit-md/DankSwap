// Relayer fee schedule, shared by the page (to show and set the fee) and the relayer (to check it).
// The relayer publishes its schedule at GET /info (docs/PHASE2_SPEC.md §9):
//   { feeBps, minFeeLamports: { SOL, USDC, USDT }, createAtaFee: { USDC, USDT } }
// minFeeLamports is in each token's base units (lamports for SOL, 10^-6 for USDC/USDT).

/**
 * Smallest fee the relayer accepts.
 * @param {object} info            GET /info response
 * @param {string} symbol          'SOL' | 'USDC' | 'USDT'
 * @param {bigint} withdrawAmount  -extAmount for an unshield, 0 for a private send
 * @param {boolean} [needsAta]     unshield to a wallet without a token account (the relayer creates it)
 */
export function requiredFee(info, symbol, withdrawAmount, needsAta = false) {
  const bps = BigInt(info.feeBps || 0);
  const min = BigInt((info.minFeeLamports && info.minFeeLamports[symbol]) || 0);
  const amt = BigInt(withdrawAmount);
  const pct = amt > 0n ? (amt * bps + 9999n) / 10000n : 0n; // rounded up
  let fee = pct > min ? pct : min;
  if (needsAta) fee += BigInt((info.createAtaFee && info.createAtaFee[symbol]) || 0);
  return fee;
}

/** For "unshield X, fee comes out of X": the largest amount a balance can withdraw after the fee. */
export function maxWithdrawable(info, symbol, balance, needsAta = false) {
  let lo = 0n;
  let hi = BigInt(balance);
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid + requiredFee(info, symbol, mid, needsAta) <= balance) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}
