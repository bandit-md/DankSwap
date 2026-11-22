// PLACEHOLDER — NOT A REAL VERIFYING KEY.
// Created by the program workstream only because circuits/ had not generated this
// file yet. It is overwritten by `cd circuits && npm run build` (scripts/vk-to-rust.mjs).
// With an empty `vk_ic`, groth16-solana rejects every proof
// (InvalidPublicInputsLength), so this placeholder can never accept a proof.

use groth16_solana::groth16::Groth16Verifyingkey;

pub const VERIFYINGKEY: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: 11,
    vk_alpha_g1: [0u8; 64],
    vk_beta_g2: [0u8; 128],
    vk_gamme_g2: [0u8; 128],
    vk_delta_g2: [0u8; 128],
    vk_ic: &[],
};
