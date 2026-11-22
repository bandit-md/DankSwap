use anchor_lang::prelude::*;

use crate::crypto::{TreeState, ROOT_HISTORY_SIZE, TREE_DEPTH};

/// PDA `["config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub swap_program: Pubkey,
    pub deposits_paused: bool,
    pub bump: u8,
}

/// PDA `["pool", mint]`.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub mint: Pubkey,
    pub mint_field: [u8; 32],
    pub is_native: bool,
    pub max_deposit: u64,
    /// SPL: token account PDA `["vault", mint]` owned by the pool PDA.
    /// Native SOL: the pool PDA itself (lamports above rent exemption).
    pub vault: Pubkey,
    pub tree: Pubkey,
    pub bump: u8,
}

/// PDA `["tree", mint]`, zero-copy. 8 (discriminator) + 3856 bytes.
#[account(zero_copy)]
pub struct MerkleTree {
    pub filled_subtrees: [[u8; 32]; TREE_DEPTH],
    pub roots: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub current_root_index: u64,
    pub next_index: u64,
}

impl MerkleTree {
    pub const SIZE: usize = 32 * TREE_DEPTH + 32 * ROOT_HISTORY_SIZE + 8 + 8;
}

impl TreeState for MerkleTree {
    fn filled_subtrees(&mut self) -> &mut [[u8; 32]; TREE_DEPTH] {
        &mut self.filled_subtrees
    }
    fn roots(&mut self) -> &mut [[u8; 32]; ROOT_HISTORY_SIZE] {
        &mut self.roots
    }
    fn roots_ref(&self) -> &[[u8; 32]; ROOT_HISTORY_SIZE] {
        &self.roots
    }
    fn current_root_index(&mut self) -> &mut u64 {
        &mut self.current_root_index
    }
    fn next_index(&mut self) -> &mut u64 {
        &mut self.next_index
    }
}

/// PDA `["nullifier", nullifier32]`: empty marker (8-byte discriminator only).
/// Its existence means the nullifier is spent.
#[account]
#[derive(InitSpace)]
pub struct Nullifier {}

#[event]
pub struct NewCommitment {
    pub pool: Pubkey,
    pub commitment: [u8; 32],
    pub index: u64,
    pub encrypted_output: [u8; 87],
}

#[event]
pub struct NewNullifier {
    pub nullifier: [u8; 32],
}
