//! TEST-ONLY stand-in for Jupiter used by the dankswap-pool `transact_swap`
//! LiteSVM tests. NEVER deploy this to a public cluster: anyone can drain its
//! reserve.
//!
//! `swap(amount_in, amount_out)`:
//!   1. pulls `amount_in` from `user_source` (authority `user_authority`, which
//!      is the pool's escrow PDA signing through the CPI) into `reserve_in`;
//!   2. pays `amount_out` from `reserve_out` (owned by PDA ["reserve"]) to
//!      `user_destination`.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::token::{spl_token, Token};

declare_id!("9GECyzNTXuqebHQb6WBWcFxiVqpUheQ8brZXRDBdNbsJ");

pub const RESERVE_SEED: &[u8] = b"reserve";

#[program]
pub mod mock_swap {
    use super::*;

    pub fn swap(ctx: Context<Swap>, amount_in: u64, amount_out: u64) -> Result<()> {
        let a = &ctx.accounts;
        let ix = spl_token::instruction::transfer(
            &spl_token::ID,
            a.user_source.key,
            a.reserve_in.key,
            a.user_authority.key,
            &[],
            amount_in,
        )?;
        invoke(
            &ix,
            &[
                a.user_source.to_account_info(),
                a.reserve_in.to_account_info(),
                a.user_authority.to_account_info(),
            ],
        )?;

        let ix = spl_token::instruction::transfer(
            &spl_token::ID,
            a.reserve_out.key,
            a.user_destination.key,
            a.reserve_authority.key,
            &[],
            amount_out,
        )?;
        invoke_signed(
            &ix,
            &[
                a.reserve_out.to_account_info(),
                a.user_destination.to_account_info(),
                a.reserve_authority.to_account_info(),
            ],
            &[&[RESERVE_SEED, &[ctx.bumps.reserve_authority]]],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user_authority: Signer<'info>,
    /// CHECK: token account; the token program enforces authority and mint.
    #[account(mut)]
    pub user_source: UncheckedAccount<'info>,
    /// CHECK: token account receiving the input.
    #[account(mut)]
    pub reserve_in: UncheckedAccount<'info>,
    /// CHECK: token account owned by `reserve_authority`.
    #[account(mut)]
    pub reserve_out: UncheckedAccount<'info>,
    /// CHECK: token account receiving the output.
    #[account(mut)]
    pub user_destination: UncheckedAccount<'info>,
    /// CHECK: PDA ["reserve"].
    #[account(seeds = [RESERVE_SEED], bump)]
    pub reserve_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
