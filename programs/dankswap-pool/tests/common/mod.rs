//! Shared helpers for the host tests: fixture loading and proofs.json parsing.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use dankswap_pool::crypto::*;
use serde_json::Value;
use std::path::PathBuf;
use std::str::FromStr;

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../circuits/fixtures")
}

/// Load a fixture or fail loudly ("fixtures missing").
pub fn load_fixture(name: &str) -> Value {
    let path = fixtures_dir().join(name);
    let data = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "fixtures missing: cannot read {} ({e}). Generate them with `cd circuits && npm run build && npm run fixtures`.",
            path.display()
        )
    });
    serde_json::from_str(&data).unwrap_or_else(|e| panic!("bad JSON in {}: {e}", path.display()))
}

pub fn hex_bytes(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    assert!(s.len() % 2 == 0, "odd hex length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

pub fn dec_to_be32(s: &str) -> [u8; 32] {
    let v = num_bigint::BigUint::parse_bytes(s.as_bytes(), 10).expect("decimal");
    let b = v.to_bytes_be();
    assert!(b.len() <= 32, "value too large");
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

fn arr<const N: usize>(v: &Value) -> [u8; N] {
    hex_bytes(v.as_str().expect("hex string"))
        .try_into()
        .unwrap_or_else(|_| panic!("expected {N} bytes"))
}

/// One proof from circuits/fixtures/proofs.json.
#[derive(Clone)]
pub struct ProofCase {
    pub name: String,
    pub flow: String,
    pub mint: Pubkey,
    pub swap_mint: Option<Pubkey>,
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub public_signals: [[u8; 32]; NR_PUBLIC_INPUTS],
    pub recipient: Pubkey,
    pub relayer: Pubkey,
    pub ext_amount: i64,
    pub fee: u64,
    pub enc1: [u8; 87],
    pub enc2: [u8; 87],
    pub enc_swap: [u8; 87],
    pub root: [u8; 32],
    pub nullifiers: [[u8; 32]; 2],
    pub commitments: [[u8; 32]; 2],
    pub swap_amount: u64,
    pub swap_commitment: [u8; 32],
    pub leaves_before: usize,
}

impl ProofCase {
    /// Public inputs derived exactly as the program derives them.
    pub fn derived_public_inputs(&self) -> [[u8; 32]; NR_PUBLIC_INPUTS] {
        let (swap_mf, swap_amt) = match self.swap_mint {
            Some(m) => (mint_field(&m), u64_to_field(self.swap_amount)),
            None => ([0u8; 32], [0u8; 32]),
        };
        build_public_inputs(
            &self.root,
            &public_amount(self.ext_amount, self.fee).unwrap(),
            &ext_data_hash(
                &self.recipient,
                &self.relayer,
                self.ext_amount,
                self.fee,
                &self.enc1,
                &self.enc2,
                &self.enc_swap,
            ),
            &mint_field(&self.mint),
            &self.nullifiers,
            &self.commitments,
            &swap_mf,
            &swap_amt,
            &self.swap_commitment,
        )
    }
}

pub fn proof_cases(f: &Value) -> Vec<ProofCase> {
    f["proofs"]
        .as_array()
        .expect("proofs.json: `proofs` array")
        .iter()
        .map(|p| {
            let sig: Vec<[u8; 32]> = p["publicSignals"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| dec_to_be32(s.as_str().unwrap()))
                .collect();
            assert_eq!(sig.len(), NR_PUBLIC_INPUTS);
            let public_signals: [[u8; 32]; NR_PUBLIC_INPUTS] = sig.clone().try_into().unwrap();
            let e = &p["extData"];
            let swap_amount_be = sig[9];
            let swap_amount = u64::from_be_bytes(swap_amount_be[24..].try_into().unwrap());
            assert!(swap_amount_be[..24].iter().all(|b| *b == 0));
            ProofCase {
                name: p["name"].as_str().unwrap().to_string(),
                flow: p["flow"].as_str().unwrap_or("").to_string(),
                mint: Pubkey::from_str(p["mint"].as_str().unwrap()).unwrap(),
                swap_mint: p["swapMint"].as_str().map(|s| Pubkey::from_str(s).unwrap()),
                proof_a: arr(&p["proofA"]),
                proof_b: arr(&p["proofB"]),
                proof_c: arr(&p["proofC"]),
                public_signals,
                recipient: Pubkey::from_str(e["recipient"].as_str().unwrap()).unwrap(),
                relayer: Pubkey::from_str(e["relayer"].as_str().unwrap()).unwrap(),
                ext_amount: e["extAmount"].as_str().unwrap().parse().unwrap(),
                fee: e["fee"].as_str().unwrap().parse().unwrap(),
                enc1: arr(&e["encryptedOutput1"]),
                enc2: arr(&e["encryptedOutput2"]),
                enc_swap: arr(&e["encryptedSwapOutput"]),
                root: sig[0],
                nullifiers: [sig[4], sig[5]],
                commitments: [sig[6], sig[7]],
                swap_amount,
                swap_commitment: sig[10],
                leaves_before: p["leavesBefore"].as_array().map(|a| a.len()).unwrap_or(0),
            }
        })
        .collect()
}
