use anchor_lang::prelude::*;

/// Custom errors. Anchor numbers these from 6000 in declaration order;
/// the order is part of the client ABI (see programs/README.md). Append only.
#[error_code]
pub enum PoolError {
    #[msg("Signer is not the config authority")]
    Unauthorized, // 6000
    #[msg("Merkle root is zero or not in the root history")]
    UnknownRoot, // 6001
    #[msg("Deposits are paused")]
    DepositsPaused, // 6002
    #[msg("Deposit exceeds the pool's max_deposit")]
    DepositLimitExceeded, // 6003
    #[msg("Deposits must have fee == 0")]
    DepositFeeNotZero, // 6004
    #[msg("Groth16 proof verification failed")]
    InvalidProof, // 6005
    #[msg("Arithmetic overflow")]
    MathOverflow, // 6006
    #[msg("Merkle tree is full")]
    TreeFull, // 6007
    #[msg("Poseidon hash failed")]
    PoseidonError, // 6008
    #[msg("Vault account does not match the pool")]
    InvalidVault, // 6009
    #[msg("Mint is not a supported SPL Token mint")]
    InvalidMint, // 6010
    #[msg("Recipient account is invalid for this pool")]
    InvalidRecipient, // 6011
    #[msg("Relayer fee account is invalid for this pool")]
    InvalidRelayerAccount, // 6012
    #[msg("SPL deposits require signer_token_account of the pool mint")]
    InvalidSignerTokenAccount, // 6013
    #[msg("Withdrawal would take the native pool below rent exemption")]
    InsufficientPoolBalance, // 6014
    #[msg("transact_swap requires ext_amount < 0")]
    InvalidSwapExtAmount, // 6015
    #[msg("Output pool must use a different mint than the input pool")]
    SameMintSwap, // 6016
    #[msg("swap_amount must be > 0")]
    ZeroSwapAmount, // 6017
    #[msg("Swap program does not match config.swap_program")]
    InvalidSwapProgram, // 6018
    #[msg("Escrow token account is invalid")]
    InvalidEscrowAccount, // 6019
    #[msg("Swap returned less than swap_amount")]
    SwapOutputTooLow, // 6020
    #[msg("Swap did not consume the full input amount")]
    SwapInputNotConsumed, // 6021
    #[msg("Escrow token account was tampered with during the swap CPI")]
    EscrowTampered, // 6022
    #[msg("Surplus recipient account is invalid")]
    InvalidSurplusAccount, // 6023
    #[msg("Instruction data is malformed")]
    InvalidInstructionData, // 6024
}
