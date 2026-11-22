// Program addresses and account lists for dankswap_pool instructions (docs/PHASE2_SPEC.md §8).
// web3 (@solana/web3.js 1.x, or window.solanaWeb3 from the vendored IIFE) is passed in, so this
// module loads nothing at import time and works in browsers and Node.
import { utf8, pubkeyBytes } from './util.js';
import { transactInstructionData, transactSwapInstructionData } from './encode.js';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

const pk = (web3, k) => (k instanceof web3.PublicKey ? k : new web3.PublicKey(k));
const pda = (web3, seeds, programId) => web3.PublicKey.findProgramAddressSync(seeds, pk(web3, programId))[0];

export function configPda(web3, programId) {
  return pda(web3, [utf8('config')], programId);
}
export function poolPda(web3, programId, mint) {
  return pda(web3, [utf8('pool'), pubkeyBytes(mint)], programId);
}
export function treePda(web3, programId, mint) {
  return pda(web3, [utf8('tree'), pubkeyBytes(mint)], programId);
}
export function nullifierPda(web3, programId, nullifier32) {
  return pda(web3, [utf8('nullifier'), nullifier32], programId);
}
export function escrowPda(web3, programId, pool) {
  return pda(web3, [utf8('escrow'), pubkeyBytes(pool)], programId);
}
export function associatedTokenAddress(web3, owner, mint) {
  return pda(web3, [pubkeyBytes(owner), pubkeyBytes(TOKEN_PROGRAM_ID), pubkeyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function vaultPda(web3, programId, mint) {
  return pda(web3, [utf8('vault'), pubkeyBytes(mint)], programId);
}

/** The pool's vault PDA ["vault", mint]: a system-owned lamport account for native SOL, an SPL token account owned by the pool PDA otherwise. */
// eslint-disable-next-line no-unused-vars
export function vaultAddress(web3, programId, mint, native) {
  return vaultPda(web3, programId, mint);
}

/**
 * Account metas for `transact`, in §8 order: signer, config, pool, tree, vault, nullifier0,
 * nullifier1, recipient, relayer_fee_account, signer_token_account (optional: the program id
 * stands in for None, Anchor's convention), token_program, system_program.
 */
export function transactAccounts(web3, { programId, mint, native, signer, nullifiers, recipient, relayerFeeAccount, signerTokenAccount = null }) {
  const prog = pk(web3, programId);
  const meta = (pubkey, isSigner, isWritable) => ({ pubkey: pk(web3, pubkey), isSigner, isWritable });
  return [
    meta(signer, true, true),
    meta(configPda(web3, prog), false, false),
    meta(poolPda(web3, prog, mint), false, false),
    meta(treePda(web3, prog, mint), false, true),
    meta(vaultAddress(web3, prog, mint, native), false, true),
    meta(nullifierPda(web3, prog, nullifiers[0]), false, true),
    meta(nullifierPda(web3, prog, nullifiers[1]), false, true),
    meta(recipient, false, true),
    meta(relayerFeeAccount, false, true),
    signerTokenAccount ? meta(signerTokenAccount, false, true) : meta(prog, false, false),
    meta(TOKEN_PROGRAM_ID, false, false),
    meta(SYSTEM_PROGRAM_ID, false, false),
  ];
}

/** setComputeUnitLimit (ComputeBudget instruction 2, u32 LE). */
export function computeUnitLimitInstruction(web3, units) {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return new web3.TransactionInstruction({ programId: pk(web3, COMPUTE_BUDGET_PROGRAM_ID), keys: [], data: toBuffer(web3, data) });
}

export function toBuffer(web3, bytes) {
  // web3.js 1.x wants a Buffer. The IIFE build does not export its Buffer polyfill, but
  // PublicKey.toBuffer() returns one, which gives us the class.
  const B = globalThis.Buffer || new web3.PublicKey(SYSTEM_PROGRAM_ID).toBuffer().constructor;
  return B.from(bytes);
}

/** Full `transact` instruction. `args` = encode.js transact args (bytes). */
export async function transactInstruction(web3, accountsOpts, args) {
  const data = await transactInstructionData(args);
  return new web3.TransactionInstruction({
    programId: pk(web3, accountsOpts.programId),
    keys: transactAccounts(web3, accountsOpts),
    data: toBuffer(web3, data),
  });
}

/**
 * `transact_swap` (programs/README.md): signer, config, input_pool, input_tree, input_vault,
 * nullifier0, nullifier1, relayer_fee_account, escrow (extDataHash recipient), escrow_input_token,
 * escrow_output_token, output_pool, output_tree, output_vault, relayer_surplus_account,
 * swap_program, token program, system program, then the swap route accounts.
 * Escrow token accounts are the escrow PDA's ATAs (wSOL for a SOL side); the caller must create them.
 */
export function transactSwapAccounts(web3, o) {
  const prog = pk(web3, o.programId);
  const meta = (pubkey, isSigner, isWritable) => ({ pubkey: pk(web3, pubkey), isSigner, isWritable });
  const inPool = poolPda(web3, prog, o.mint);
  const escrow = escrowPda(web3, prog, inPool);
  return [
    meta(o.signer, true, true),
    meta(configPda(web3, prog), false, false),
    meta(inPool, false, false),
    meta(treePda(web3, prog, o.mint), false, true),
    meta(vaultAddress(web3, prog, o.mint, o.native), false, true),
    meta(nullifierPda(web3, prog, o.nullifiers[0]), false, true),
    meta(nullifierPda(web3, prog, o.nullifiers[1]), false, true),
    meta(o.relayerFeeAccount, false, true),
    meta(escrow, false, true),
    meta(associatedTokenAddress(web3, escrow, o.mint), false, true),
    meta(associatedTokenAddress(web3, escrow, o.outputMint), false, true),
    meta(poolPda(web3, prog, o.outputMint), false, false),
    meta(treePda(web3, prog, o.outputMint), false, true),
    meta(vaultAddress(web3, prog, o.outputMint, o.outputNative), false, true),
    meta(o.relayerSurplusAccount, false, true),
    meta(o.swapProgram, false, false),
    meta(TOKEN_PROGRAM_ID, false, false),
    meta(SYSTEM_PROGRAM_ID, false, false),
    ...(o.remainingAccounts || []).map((a) => meta(a.pubkey, !!a.isSigner, !!a.isWritable)),
  ];
}

export async function transactSwapInstruction(web3, opts, args) {
  return new web3.TransactionInstruction({
    programId: pk(web3, opts.programId),
    keys: transactSwapAccounts(web3, opts),
    data: toBuffer(web3, await transactSwapInstructionData(args)),
  });
}
