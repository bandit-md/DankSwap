//! DankSwap Phase 2 shielded pool (`dankswap_pool`).
//!
//! UNAUDITED. DEVNET ONLY. See docs/PHASE2_SPEC.md (§1, §3, §5, §7, §8) and
//! programs/README.md for the client ABI (instruction args, account order,
//! PDAs, events, errors).
#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program::{invoke, invoke_signed},
    program_pack::Pack,
};
use anchor_spl::token::{spl_token, Token, TokenAccount};

pub mod crypto;
pub mod errors;
pub mod state;
pub mod verifying_key;

use crypto::*;
use errors::PoolError;
use state::*;

// Placeholder program id. After `anchor keys sync` (or when deploying with a
// different program keypair) replace it here AND in Anchor.toml; every PDA and
// the swap fixture's escrow address depend on it.
declare_id!("FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6");

pub const CONFIG_SEED: &[u8] = b"config";
pub const POOL_SEED: &[u8] = b"pool";
pub const TREE_SEED: &[u8] = b"tree";
pub const VAULT_SEED: &[u8] = b"vault";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
pub const ESCROW_SEED: &[u8] = b"escrow";

/// wSOL mint. A pool for this mint is the native SOL pool (holds lamports).
pub const NATIVE_MINT: Pubkey = spl_token::native_mint::ID;

const ZERO_BLOB: [u8; ENC_LEN] = [0u8; ENC_LEN];
const ZERO32: [u8; 32] = [0u8; 32];

#[program]
pub mod dankswap_pool {
    use super::*;

    /// Create the global config. Only the program's upgrade authority may call
    /// it (prevents front-running the first initialize after deploy).
    pub fn initialize(ctx: Context<Initialize>, swap_program: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.swap_program = swap_program;
        config.deposits_paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Create a pool, its Merkle tree and (SPL only) its vault. Authority only.
    pub fn initialize_pool(ctx: Context<InitializePool>, max_deposit: u64) -> Result<()> {
        let mint_key = ctx.accounts.mint.key();
        let pool_key = ctx.accounts.pool.key();
        let is_native = mint_key == NATIVE_MINT;

        let vault_key = if is_native {
            // Native SOL lives in a data-less, system-owned PDA ["vault", wSOL mint],
            // so every SOL movement is a signed System Program transfer (direct
            // lamport edits followed by CPIs are rejected by the runtime).
            create_native_vault(
                &ctx.accounts.authority.to_account_info(),
                &ctx.accounts.vault.to_account_info(),
                &mint_key,
                &ctx.accounts.system_program.to_account_info(),
                ctx.program_id,
            )?;
            ctx.accounts.vault.key()
        } else {
            let mint_ai = ctx.accounts.mint.to_account_info();
            require_keys_eq!(*mint_ai.owner, spl_token::ID, PoolError::InvalidMint);
            {
                let data = mint_ai.try_borrow_data()?;
                spl_token::state::Mint::unpack(&data).map_err(|_| error!(PoolError::InvalidMint))?;
            }
            create_vault(
                &ctx.accounts.authority.to_account_info(),
                &ctx.accounts.vault.to_account_info(),
                &mint_ai,
                &pool_key,
                &ctx.accounts.system_program.to_account_info(),
                ctx.program_id,
            )?;
            ctx.accounts.vault.key()
        };

        let pool = &mut ctx.accounts.pool;
        pool.mint = mint_key;
        pool.mint_field = mint_field(&mint_key);
        pool.is_native = is_native;
        pool.max_deposit = max_deposit;
        pool.vault = vault_key;
        pool.tree = ctx.accounts.tree.key();
        pool.bump = ctx.bumps.pool;

        let mut tree = ctx.accounts.tree.load_init()?;
        tree_init(&mut *tree);
        Ok(())
    }

    /// Change a pool's max deposit. Authority only; cannot touch funds.
    pub fn set_pool_limits(ctx: Context<SetPoolLimits>, max_deposit: u64) -> Result<()> {
        ctx.accounts.pool.max_deposit = max_deposit;
        Ok(())
    }

    /// Pause or resume deposits (and swaps into pools). Authority only.
    /// Withdrawals and private sends are never affected.
    pub fn set_deposits_paused(ctx: Context<SetDepositsPaused>, paused: bool) -> Result<()> {
        ctx.accounts.config.deposits_paused = paused;
        Ok(())
    }

    /// Shield (ext_amount > 0), private send (ext_amount == 0) or unshield
    /// (ext_amount < 0). See spec §8.
    pub fn transact(
        ctx: Context<Transact>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        input_nullifiers: [[u8; 32]; 2],
        output_commitments: [[u8; 32]; 2],
        ext_amount: i64,
        fee: u64,
        encrypted_output1: [u8; 87],
        encrypted_output2: [u8; 87],
    ) -> Result<()> {
        let a = &ctx.accounts;
        let pool = &a.pool;

        // Root must be known.
        {
            let tree = a.tree.load()?;
            require!(tree_is_known_root(&*tree, &root), PoolError::UnknownRoot);
        }

        // Deposit rules.
        if ext_amount > 0 {
            require!(!a.config.deposits_paused, PoolError::DepositsPaused);
            require!(ext_amount as u64 <= pool.max_deposit, PoolError::DepositLimitExceeded);
            require!(fee == 0, PoolError::DepositFeeNotZero);
        }

        // Public inputs derived on-chain.
        let ext_hash = ext_data_hash(
            a.recipient.key,
            a.relayer_fee_account.key,
            ext_amount,
            fee,
            &encrypted_output1,
            &encrypted_output2,
            &ZERO_BLOB,
        );
        let inputs = build_public_inputs(
            &root,
            &public_amount(ext_amount, fee)?,
            &ext_hash,
            &pool.mint_field,
            &input_nullifiers,
            &output_commitments,
            &ZERO32,
            &ZERO32,
            &ZERO32,
        );
        verify_groth16(&proof_a, &proof_b, &proof_c, &inputs)?;

        // Nullifier PDAs were created by `init` above (double spend => failure).
        // Move funds.
        let vault = a.vault.to_account_info();
        let pool_ai = a.pool.to_account_info();
        let token_program = a.token_program.to_account_info();
        let pool_seeds: &[&[u8]] = &[POOL_SEED, pool.mint.as_ref(), &[pool.bump]];

        if ext_amount > 0 {
            let amount = ext_amount as u64;
            if pool.is_native {
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        a.system_program.key(),
                        anchor_lang::system_program::Transfer {
                            from: a.signer.to_account_info(),
                            to: vault.clone(),
                        },
                    ),
                    amount,
                )?;
            } else {
                let src = a
                    .signer_token_account
                    .as_ref()
                    .ok_or(error!(PoolError::InvalidSignerTokenAccount))?;
                require_keys_eq!(src.mint, pool.mint, PoolError::InvalidSignerTokenAccount);
                token_transfer(
                    &src.to_account_info(),
                    &vault,
                    &a.signer.to_account_info(),
                    &token_program,
                    amount,
                    None,
                )?;
            }
        } else {
            let amount = ext_amount.unsigned_abs();
            if amount > 0 {
                require_keys_neq!(a.recipient.key(), vault.key(), PoolError::InvalidRecipient);
                pay_out(
                    pool,
                    &vault,
                    &pool_ai,
                    &a.recipient.to_account_info(),
                    &token_program,
                    &a.system_program.to_account_info(),
                    pool_seeds,
                    amount,
                    PoolError::InvalidRecipient,
                )?;
            }
        }
        if fee > 0 {
            require_keys_neq!(
                a.relayer_fee_account.key(),
                vault.key(),
                PoolError::InvalidRelayerAccount
            );
            pay_out(
                pool,
                &vault,
                &pool_ai,
                &a.relayer_fee_account.to_account_info(),
                &token_program,
                &a.system_program.to_account_info(),
                pool_seeds,
                fee,
                PoolError::InvalidRelayerAccount,
            )?;
        }

        // Append commitments and emit events.
        let pool_key = a.pool.key();
        append_commitments(
            &a.tree,
            pool_key,
            &[
                (&output_commitments[0], &encrypted_output1),
                (&output_commitments[1], &encrypted_output2),
            ],
        )?;
        emit!(NewNullifier { nullifier: input_nullifiers[0] });
        emit!(NewNullifier { nullifier: input_nullifiers[1] });
        Ok(())
    }

    /// Private swap: spend notes of the input pool (ext_amount < 0), swap the
    /// outflow through `config.swap_program` from the escrow PDA, and credit a
    /// `swap_amount` note in the output pool. See spec §8 and programs/README.md.
    pub fn transact_swap<'info>(
        ctx: Context<'info, TransactSwap<'info>>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        root: [u8; 32],
        input_nullifiers: [[u8; 32]; 2],
        output_commitments: [[u8; 32]; 2],
        ext_amount: i64,
        fee: u64,
        encrypted_output1: [u8; 87],
        encrypted_output2: [u8; 87],
        swap_amount: u64,
        swap_commitment: [u8; 32],
        encrypted_swap_output: [u8; 87],
        swap_data: Vec<u8>,
    ) -> Result<()> {
        require!(ext_amount < 0, PoolError::InvalidSwapExtAmount);
        require!(swap_amount > 0, PoolError::ZeroSwapAmount);
        {
            let a = &ctx.accounts;
            require!(
                a.input_pool.mint_field != a.output_pool.mint_field,
                PoolError::SameMintSwap
            );
            // A swap credits the output pool, so it obeys the output pool's deposit rules.
            require!(!a.config.deposits_paused, PoolError::DepositsPaused);
            require!(
                swap_amount <= a.output_pool.max_deposit,
                PoolError::DepositLimitExceeded
            );
            {
                let tree = a.input_tree.load()?;
                require!(tree_is_known_root(&*tree, &root), PoolError::UnknownRoot);
            }
            let ext_hash = ext_data_hash(
                a.escrow.key,
                a.relayer_fee_account.key,
                ext_amount,
                fee,
                &encrypted_output1,
                &encrypted_output2,
                &encrypted_swap_output,
            );
            // swap_mint_field is taken from the output pool, so
            // swap_mint_field == output_pool.mint_field holds by construction.
            let inputs = build_public_inputs(
                &root,
                &public_amount(ext_amount, fee)?,
                &ext_hash,
                &a.input_pool.mint_field,
                &input_nullifiers,
                &output_commitments,
                &a.output_pool.mint_field,
                &u64_to_field(swap_amount),
                &swap_commitment,
            );
            verify_groth16(&proof_a, &proof_b, &proof_c, &inputs)?;
        }

        swap_move_and_settle(&ctx, ext_amount.unsigned_abs(), fee, swap_amount, swap_data)?;

        let a = &ctx.accounts;
        append_commitments(
            &a.input_tree,
            a.input_pool.key(),
            &[
                (&output_commitments[0], &encrypted_output1),
                (&output_commitments[1], &encrypted_output2),
            ],
        )?;
        append_commitments(
            &a.output_tree,
            a.output_pool.key(),
            &[(&swap_commitment, &encrypted_swap_output)],
        )?;
        emit!(NewNullifier { nullifier: input_nullifiers[0] });
        emit!(NewNullifier { nullifier: input_nullifiers[1] });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[inline(never)]
fn create_vault<'info>(
    payer: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    pool_key: &Pubkey,
    system_program: &AccountInfo<'info>,
    program_id: &Pubkey,
) -> Result<()> {
    let mint_key = mint.key();
    let (expected, bump) =
        Pubkey::find_program_address(&[VAULT_SEED, mint_key.as_ref()], program_id);
    require_keys_eq!(vault.key(), expected, PoolError::InvalidVault);
    let space = spl_token::state::Account::LEN;
    let lamports = Rent::get()?.minimum_balance(space);
    let seeds: &[&[u8]] = &[VAULT_SEED, mint_key.as_ref(), &[bump]];
    let current = vault.lamports();
    if current == 0 {
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                system_program.key(),
                anchor_lang::system_program::CreateAccount { from: payer.clone(), to: vault.clone() },
                &[seeds],
            ),
            lamports,
            space as u64,
            &spl_token::ID,
        )?;
    } else {
        // Pre-funded address (griefing): top up, allocate, assign.
        let top_up = lamports.saturating_sub(current);
        if top_up > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    system_program.key(),
                    anchor_lang::system_program::Transfer { from: payer.clone(), to: vault.clone() },
                ),
                top_up,
            )?;
        }
        anchor_lang::system_program::allocate(
            CpiContext::new_with_signer(
                system_program.key(),
                anchor_lang::system_program::Allocate { account_to_allocate: vault.clone() },
                &[seeds],
            ),
            space as u64,
        )?;
        anchor_lang::system_program::assign(
            CpiContext::new_with_signer(
                system_program.key(),
                anchor_lang::system_program::Assign { account_to_assign: vault.clone() },
                &[seeds],
            ),
            &spl_token::ID,
        )?;
    }
    let ix = spl_token::instruction::initialize_account3(&spl_token::ID, vault.key, mint.key, pool_key)?;
    invoke(&ix, &[vault.clone(), mint.clone()])?;
    Ok(())
}

/// Read an SPL Token account from an unchecked AccountInfo (owner + unpack).
fn read_token_account(ai: &AccountInfo, err: PoolError) -> Result<spl_token::state::Account> {
    if *ai.owner != spl_token::ID {
        return Err(error!(err));
    }
    let data = ai.try_borrow_data()?;
    spl_token::state::Account::unpack(&data).map_err(|_| error!(err))
}

/// SPL `Transfer` CPI, optionally signed with PDA seeds.
fn token_transfer<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    seeds: Option<&[&[u8]]>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let ix = spl_token::instruction::transfer(
        &spl_token::ID,
        from.key,
        to.key,
        authority.key,
        &[],
        amount,
    )?;
    let infos = [from.clone(), to.clone(), authority.clone(), token_program.clone()];
    match seeds {
        Some(s) => invoke_signed(&ix, &infos, &[s])?,
        None => invoke(&ix, &infos)?,
    }
    Ok(())
}

/// Create (or adopt a pre-funded) native SOL vault: a system-owned PDA
/// ["vault", wSOL mint] with no data, kept at least rent-exempt.
#[inline(never)]
fn create_native_vault<'info>(
    payer: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    mint_key: &Pubkey,
    system_program: &AccountInfo<'info>,
    program_id: &Pubkey,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(&[VAULT_SEED, mint_key.as_ref()], program_id);
    require_keys_eq!(vault.key(), expected, PoolError::InvalidVault);
    require_keys_eq!(*vault.owner, anchor_lang::system_program::ID, PoolError::InvalidVault);
    require!(vault.data_is_empty(), PoolError::InvalidVault);
    let rent_min = Rent::get()?.minimum_balance(0);
    let top_up = rent_min.saturating_sub(vault.lamports());
    if top_up > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                system_program.key(),
                anchor_lang::system_program::Transfer { from: payer.clone(), to: vault.clone() },
            ),
            top_up,
        )?;
    }
    Ok(())
}

/// Pay lamports out of the native SOL vault with a signed System transfer,
/// never leaving the vault below rent exemption.
fn native_vault_transfer<'info>(
    vault: &AccountInfo<'info>,
    dest: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    mint: &Pubkey,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let (expected, bump) = Pubkey::find_program_address(&[VAULT_SEED, mint.as_ref()], &crate::ID);
    require_keys_eq!(vault.key(), expected, PoolError::InvalidVault);
    let rent_min = Rent::get()?.minimum_balance(0);
    let after = vault
        .lamports()
        .checked_sub(amount)
        .ok_or(error!(PoolError::InsufficientPoolBalance))?;
    require!(after >= rent_min, PoolError::InsufficientPoolBalance);
    let bump = [bump];
    let seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &bump];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program.key(),
            anchor_lang::system_program::Transfer { from: vault.clone(), to: dest.clone() },
            &[seeds],
        ),
        amount,
    )
}

/// Pay `amount` out of a pool's vault to `dest` (lamports for the native pool,
/// tokens of the pool mint otherwise; `dest` must then be a token account of
/// the pool mint).
fn pay_out<'info>(
    pool: &Pool,
    vault: &AccountInfo<'info>,
    pool_ai: &AccountInfo<'info>,
    dest: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    pool_seeds: &[&[u8]],
    amount: u64,
    dest_err: PoolError,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if pool.is_native {
        native_vault_transfer(vault, dest, system_program, &pool.mint, amount)
    } else {
        let acc = read_token_account(dest, dest_err)?;
        if acc.mint != pool.mint {
            return Err(error!(dest_err));
        }
        token_transfer(vault, dest, pool_ai, token_program, amount, Some(pool_seeds))
    }
}

/// Append leaves to a tree (one root pushed per call) and emit NewCommitment.
fn append_commitments(
    tree: &AccountLoader<MerkleTree>,
    pool: Pubkey,
    leaves: &[(&[u8; 32], &[u8; ENC_LEN])],
) -> Result<()> {
    let mut t = tree.load_mut()?;
    let mut root = ZERO32;
    for (commitment, enc) in leaves {
        let (r, index) = tree_append(&mut *t, commitment)?;
        root = r;
        emit!(NewCommitment {
            pool,
            commitment: **commitment,
            index,
            encrypted_output: **enc,
        });
    }
    tree_push_root(&mut *t, root);
    Ok(())
}

/// Funds movement for transact_swap: fee to relayer, outflow to the escrow,
/// swap CPI, output checks, output to the output vault, surplus to relayer.
#[inline(never)]
fn swap_move_and_settle<'info>(
    ctx: &Context<'info, TransactSwap<'info>>,
    amount_in: u64,
    fee: u64,
    swap_amount: u64,
    swap_data: Vec<u8>,
) -> Result<()> {
    let a = &ctx.accounts;
    let input_pool = &a.input_pool;
    let output_pool = &a.output_pool;
    let token_program = a.token_program.to_account_info();
    let input_vault = a.input_vault.to_account_info();
    let input_pool_ai = a.input_pool.to_account_info();
    let escrow_ai = a.escrow.to_account_info();
    let escrow_in_ai = a.escrow_input_token.to_account_info();
    let escrow_out_ai = a.escrow_output_token.to_account_info();
    let input_pool_key = a.input_pool.key();
    let input_seeds: &[&[u8]] = &[POOL_SEED, input_pool.mint.as_ref(), &[input_pool.bump]];
    let escrow_bump = [ctx.bumps.escrow];
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, input_pool_key.as_ref(), &escrow_bump];

    // All SOL movements are signed System transfers out of the native vault PDA
    // (no direct lamport edits), so they compose safely with the swap CPI.

    // 1. Outflow into the escrow input token account.
    let pre_in = a.escrow_input_token.amount;
    let pre_out = a.escrow_output_token.amount;
    if input_pool.is_native {
        // Wrap: lamports into the escrow's wSOL account, then SyncNative.
        native_vault_transfer(
            &input_vault,
            &escrow_in_ai,
            &a.system_program.to_account_info(),
            &input_pool.mint,
            amount_in,
        )?;
        let ix = spl_token::instruction::sync_native(&spl_token::ID, escrow_in_ai.key)?;
        invoke(&ix, &[escrow_in_ai.clone(), token_program.clone()])?;
    } else {
        token_transfer(
            &input_vault,
            &escrow_in_ai,
            &input_pool_ai,
            &token_program,
            amount_in,
            Some(input_seeds),
        )?;
    }

    // 2. Swap CPI signed by the escrow PDA.
    let escrow_key = escrow_ai.key();
    let metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|ai| AccountMeta {
            pubkey: *ai.key,
            is_signer: ai.is_signer || *ai.key == escrow_key,
            is_writable: ai.is_writable,
        })
        .collect();
    let ix = Instruction {
        program_id: a.swap_program.key(),
        accounts: metas,
        data: swap_data,
    };
    let mut infos: Vec<AccountInfo<'info>> = ctx.remaining_accounts.to_vec();
    infos.push(escrow_ai.clone());
    infos.push(a.swap_program.to_account_info());
    invoke_signed(&ix, &infos, &[escrow_seeds])?;

    // 3. Post-swap checks (re-read raw account data; the CPI may have changed it).
    let esc_in = read_token_account(&escrow_in_ai, PoolError::EscrowTampered)?;
    let esc_out = read_token_account(&escrow_out_ai, PoolError::EscrowTampered)?;
    for acc in [&esc_in, &esc_out] {
        require_keys_eq!(acc.owner, escrow_key, PoolError::EscrowTampered);
        require!(acc.delegate.is_none(), PoolError::EscrowTampered);
        require!(acc.close_authority.is_none(), PoolError::EscrowTampered);
    }
    require_keys_eq!(esc_in.mint, input_pool.mint, PoolError::EscrowTampered);
    require_keys_eq!(esc_out.mint, output_pool.mint, PoolError::EscrowTampered);
    require!(esc_in.amount <= pre_in, PoolError::SwapInputNotConsumed);
    let received = esc_out
        .amount
        .checked_sub(pre_out)
        .ok_or(error!(PoolError::SwapOutputTooLow))?;
    require!(received >= swap_amount, PoolError::SwapOutputTooLow);
    let surplus = received - swap_amount;

    // 4. Settle: swap_amount to the output vault, surplus to the relayer.
    let output_vault = a.output_vault.to_account_info();
    let surplus_ai = a.relayer_surplus_account.to_account_info();
    require_keys_neq!(surplus_ai.key(), escrow_key, PoolError::InvalidSurplusAccount);
    require_keys_neq!(surplus_ai.key(), output_vault.key(), PoolError::InvalidSurplusAccount);
    if output_pool.is_native {
        // Unwrap: close the wSOL escrow account into the escrow PDA (system
        // account), then pay swap_amount lamports to the pool PDA and the rest
        // (surplus + the closed account's rent) to the relayer.
        let ix = spl_token::instruction::close_account(
            &spl_token::ID,
            escrow_out_ai.key,
            escrow_ai.key,
            escrow_ai.key,
            &[],
        )?;
        invoke_signed(
            &ix,
            &[escrow_out_ai.clone(), escrow_ai.clone(), token_program.clone()],
            &[escrow_seeds],
        )?;
        let system_program = a.system_program.key();
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                system_program,
                anchor_lang::system_program::Transfer { from: escrow_ai.clone(), to: output_vault.clone() },
                &[escrow_seeds],
            ),
            swap_amount,
        )?;
        let rest = escrow_ai.lamports();
        if rest > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    system_program,
                    anchor_lang::system_program::Transfer { from: escrow_ai.clone(), to: surplus_ai.clone() },
                    &[escrow_seeds],
                ),
                rest,
            )?;
        }
    } else {
        token_transfer(
            &escrow_out_ai,
            &output_vault,
            &escrow_ai,
            &token_program,
            swap_amount,
            Some(escrow_seeds),
        )?;
        if surplus > 0 {
            let acc = read_token_account(&surplus_ai, PoolError::InvalidSurplusAccount)?;
            require_keys_eq!(acc.mint, output_pool.mint, PoolError::InvalidSurplusAccount);
            token_transfer(
                &escrow_out_ai,
                &surplus_ai,
                &escrow_ai,
                &token_program,
                surplus,
                Some(escrow_seeds),
            )?;
        }
    }

    // 5. Relayer fee in the input mint.
    if fee > 0 {
        require_keys_neq!(
            a.relayer_fee_account.key(),
            input_vault.key(),
            PoolError::InvalidRelayerAccount
        );
        pay_out(
            input_pool,
            &input_vault,
            &input_pool_ai,
            &a.relayer_fee_account.to_account_info(),
            &token_program,
            &a.system_program.to_account_info(),
            input_seeds,
            fee,
            PoolError::InvalidRelayerAccount,
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ PoolError::Unauthorized)]
    pub program: Program<'info, crate::program::DankswapPool>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ PoolError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ PoolError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: wSOL mint for the native pool, otherwise validated as an SPL Token mint in the handler.
    pub mint: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED, mint.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    #[account(init, payer = authority, space = 8 + MerkleTree::SIZE, seeds = [TREE_SEED, mint.key().as_ref()], bump)]
    pub tree: AccountLoader<'info, MerkleTree>,
    /// CHECK: PDA ["vault", mint], created here: a system-owned lamport vault for
    /// native SOL, an SPL token account owned by the pool PDA otherwise.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPoolLimits<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ PoolError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SetDepositsPaused<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ PoolError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(proof_a: [u8; 64], proof_b: [u8; 128], proof_c: [u8; 64], root: [u8; 32], input_nullifiers: [[u8; 32]; 2])]
pub struct Transact<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [POOL_SEED, pool.mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, address = pool.tree)]
    pub tree: AccountLoader<'info, MerkleTree>,
    /// CHECK: must equal pool.vault (SPL token vault, or the pool PDA for native SOL).
    #[account(mut, address = pool.vault @ PoolError::InvalidVault)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = signer, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Box<Account<'info, Nullifier>>,
    #[account(init, payer = signer, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Box<Account<'info, Nullifier>>,
    /// CHECK: bound by extDataHash. Withdrawals: system account (native) or
    /// token account of the pool mint (SPL), validated in the handler.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: bound by extDataHash. Fee destination, validated like `recipient`.
    #[account(mut)]
    pub relayer_fee_account: UncheckedAccount<'info>,
    /// SPL deposits only: the signer's token account of the pool mint.
    #[account(mut)]
    pub signer_token_account: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof_a: [u8; 64], proof_b: [u8; 128], proof_c: [u8; 64], root: [u8; 32], input_nullifiers: [[u8; 32]; 2])]
pub struct TransactSwap<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [POOL_SEED, input_pool.mint.as_ref()], bump = input_pool.bump)]
    pub input_pool: Box<Account<'info, Pool>>,
    #[account(mut, address = input_pool.tree)]
    pub input_tree: AccountLoader<'info, MerkleTree>,
    /// CHECK: must equal input_pool.vault.
    #[account(mut, address = input_pool.vault @ PoolError::InvalidVault)]
    pub input_vault: UncheckedAccount<'info>,
    #[account(init, payer = signer, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Box<Account<'info, Nullifier>>,
    #[account(init, payer = signer, space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Box<Account<'info, Nullifier>>,
    /// CHECK: bound by extDataHash (`relayer`). Fee in the input mint.
    #[account(mut)]
    pub relayer_fee_account: UncheckedAccount<'info>,
    /// CHECK: PDA ["escrow", input_pool]; signs the swap CPI; extDataHash `recipient`.
    #[account(mut, seeds = [ESCROW_SEED, input_pool.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    #[account(mut, token::mint = input_pool.mint, token::authority = escrow)]
    pub escrow_input_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = output_pool.mint, token::authority = escrow)]
    pub escrow_output_token: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [POOL_SEED, output_pool.mint.as_ref()], bump = output_pool.bump)]
    pub output_pool: Box<Account<'info, Pool>>,
    #[account(mut, address = output_pool.tree)]
    pub output_tree: AccountLoader<'info, MerkleTree>,
    /// CHECK: must equal output_pool.vault.
    #[account(mut, address = output_pool.vault @ PoolError::InvalidVault)]
    pub output_vault: UncheckedAccount<'info>,
    /// CHECK: receives any output above swap_amount (token account of the
    /// output mint, or any system account for a native SOL output pool).
    #[account(mut)]
    pub relayer_surplus_account: UncheckedAccount<'info>,
    /// CHECK: must equal config.swap_program.
    #[account(executable, address = config.swap_program @ PoolError::InvalidSwapProgram)]
    pub swap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
