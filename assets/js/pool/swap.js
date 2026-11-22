// Private swap helpers shared by the browser SDK and the relayer (docs/PHASE2_SPEC.md §5, §8;
// programs/README.md `transact_swap`). No network: Jupiter is called by the relayer only.
//
// A private swap spends notes of pool A (extAmount = -x) into the program's escrow PDA
// ["escrow", pool A]. The program wraps/transfers x into the escrow's input token account, CPIs
// config.swap_program (Jupiter v6 on mainnet, programs/mock-swap in dev) with the relayer-supplied
// `swap_data` and remaining accounts, signed as the escrow, then credits `swapAmount` of mint B to
// pool B as a new note and sends any surplus to the relayer.
import { utf8, base64ToBytes, bytesToBase64, concatBytes, u64LE, sha256 } from './util.js';
import { associatedTokenAddress, escrowPda, poolPda, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from './accounts.js';

export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** programs/mock-swap: TEST/DEV ONLY (anyone can drain its reserve). */
export const MOCK_SWAP_PROGRAM_ID = '9GECyzNTXuqebHQb6WBWcFxiVqpUheQ8brZXRDBdNbsJ';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const pk = (web3, k) => (k instanceof web3.PublicKey ? k : new web3.PublicKey(k));

/**
 * The escrow PDA of the input pool and its token accounts (ATAs; wSOL for a SOL side), which the
 * program receives as escrow_input_token / escrow_output_token (programs/README.md #8-#10).
 */
export function swapEscrowAccounts(web3, programId, inputMint, outputMint) {
  const inputPool = poolPda(web3, programId, inputMint);
  const escrow = escrowPda(web3, programId, inputPool);
  return {
    inputPool: inputPool.toBase58(),
    escrow: escrow.toBase58(),
    escrowInput: associatedTokenAddress(web3, escrow, inputMint).toBase58(),
    escrowOutput: associatedTokenAddress(web3, escrow, outputMint).toBase58(),
  };
}

/**
 * Minimum output the user's swap note is worth: the quoted output minus the slippage buffer and
 * the relayer's swap margin (both in basis points of outAmount, rounded down).
 */
export function swapMinOut(outAmount, slippageBps = 50, swapFeeBps = 0) {
  const out = BigInt(outAmount);
  const keep = 10_000n - BigInt(slippageBps) - BigInt(swapFeeBps);
  if (keep <= 0n) throw new Error('slippage + swap fee must be below 100%');
  return (out * keep) / 10_000n;
}

/**
 * Largest Jupiter slippage (bps) that still guarantees `minOut`: otherAmountThreshold is
 * outAmount * (10000 - slippageBps) / 10000, and it must stay >= minOut.
 */
export function slippageForMinOut(outAmount, minOut, capBps = 300) {
  const out = BigInt(outAmount);
  const min = BigInt(minOut);
  if (out <= 0n || min > out) return 0;
  const bps = Number(((out - min) * 10_000n) / out);
  return Math.max(0, Math.min(capBps, bps));
}

/* ---------------- mock-swap dev route (programs/mock-swap) ---------------- */

/** PDA ["reserve"] of the mock program: owns its reserve token accounts. */
export function mockReserveAuthority(web3, mockProgram = MOCK_SWAP_PROGRAM_ID) {
  return web3.PublicKey.findProgramAddressSync([utf8('reserve')], pk(web3, mockProgram))[0];
}

/** mock-swap `swap(amount_in: u64, amount_out: u64)`: sha256("global:swap")[..8] ++ u64 LE ++ u64 LE. */
export async function mockSwapData(amountIn, amountOut) {
  const disc = (await sha256(utf8('global:swap'))).slice(0, 8);
  return concatBytes(disc, u64LE(amountIn), u64LE(amountOut));
}

/**
 * A mock-swap instruction in the same shape as Jupiter's /build `swapInstruction`
 * ({ programId, accounts: [{ pubkey, isSigner, isWritable }], data: base64 }).
 * Account order (programs/mock-swap/src/lib.rs `Swap`): user_authority (the escrow, signer via the
 * pool's invoke_signed), user_source, reserve_in, reserve_out, user_destination,
 * reserve_authority, token_program. Reserve token accounts are the reserve PDA's ATAs.
 */
export async function mockSwapInstruction(web3, { programId, inputMint, outputMint, amountIn, amountOut, mockProgram = MOCK_SWAP_PROGRAM_ID }) {
  const e = swapEscrowAccounts(web3, programId, inputMint, outputMint);
  const reserve = mockReserveAuthority(web3, mockProgram);
  const a = (pubkey, isSigner, isWritable) => ({ pubkey: String(pubkey), isSigner, isWritable });
  return {
    programId: String(mockProgram),
    accounts: [
      a(e.escrow, true, true),
      a(e.escrowInput, false, true),
      a(associatedTokenAddress(web3, reserve, inputMint).toBase58(), false, true),
      a(associatedTokenAddress(web3, reserve, outputMint).toBase58(), false, true),
      a(e.escrowOutput, false, true),
      a(reserve.toBase58(), false, false),
      a(TOKEN_PROGRAM_ID, false, false),
    ],
    data: bytesToBase64(await mockSwapData(amountIn, amountOut)),
  };
}

/* ---------------- Jupiter /build response handling ---------------- */

/** Lookup table addresses from a /build response (addressesByLookupTableAddress, or the older addressLookupTableAddresses list). */
export function buildLookupTableAddresses(build) {
  const out = new Set();
  if (build && build.addressesByLookupTableAddress && typeof build.addressesByLookupTableAddress === 'object') {
    for (const k of Object.keys(build.addressesByLookupTableAddress)) out.add(k);
  }
  if (build && Array.isArray(build.addressLookupTableAddresses)) for (const k of build.addressLookupTableAddresses) out.add(String(k));
  return [...out];
}

/**
 * The swap instruction's accounts as transact_swap remaining_accounts, in Jupiter's order.
 * The escrow PDA (Jupiter's `taker`) cannot sign the outer transaction: its isSigner is cleared
 * here and the program sets it again for the CPI (invoke_signed). Any other signer except the
 * relayer (fee payer, which signs anyway) is refused.
 */
export function swapRemainingAccounts(swapInstruction, { escrow, relayer }) {
  if (!swapInstruction || !Array.isArray(swapInstruction.accounts)) throw new Error('Swap route has no instruction');
  return swapInstruction.accounts.map((m, i) => {
    const pubkey = String(m.pubkey);
    let isSigner = !!m.isSigner;
    if (pubkey === escrow) isSigner = false;
    else if (isSigner && pubkey !== relayer) throw new Error(`Swap route account ${i} (${pubkey}) needs a signature nobody here can give`);
    return { pubkey, isSigner, isWritable: !!m.isWritable };
  });
}

/** Instruction data bytes of a /build instruction (base64). */
export function swapInstructionData(swapInstruction) {
  return base64ToBytes(swapInstruction.data);
}

/**
 * Validate Jupiter setupInstructions: only associated-token-account creates for accounts owned by
 * the escrow or the relayer are accepted. Returns [{ ata, owner, mint }] for the caller to create
 * itself (idempotently, relayer-paid); anything else makes the route unusable.
 */
export function parseSetupInstructions(setupInstructions, { escrow, relayer }) {
  const out = [];
  for (const ix of setupInstructions || []) {
    if (ix.programId !== ASSOCIATED_TOKEN_PROGRAM_ID) throw new Error(`Unsupported swap setup instruction for program ${ix.programId}`);
    const acc = ix.accounts || [];
    if (acc.length < 6 || acc[4].pubkey !== SYSTEM_PROGRAM_ID) throw new Error('Unsupported associated token account instruction');
    const owner = String(acc[2].pubkey);
    if (owner !== escrow && owner !== relayer) throw new Error('Swap setup creates an account for an unexpected owner');
    out.push({ ata: String(acc[1].pubkey), owner, mint: String(acc[3].pubkey) });
  }
  return out;
}
