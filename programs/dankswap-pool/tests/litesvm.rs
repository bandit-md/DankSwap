//! Instruction-level integration tests on LiteSVM.
//!
//! These load the SBF builds `target/deploy/dankswap_pool.so` and
//! `target/deploy/mock_swap.so`, which cannot be produced in the dev sandbox,
//! so every test is `#[ignore]`d. CI runs them after `anchor build` with
//! `cargo test -p dankswap-pool --test litesvm -- --include-ignored`.
//!
//! Instruction data and account metas are built by hand (Anchor discriminator
//! `sha256("global:<ix>")[..8]` + Borsh args) so this file doubles as a byte-level
//! reference for the relayer / SDK (see programs/README.md).
//!
//! The fixture proofs (circuits/fixtures/proofs.json) form one sequence on the
//! SOL pool: deposit -> transfer -> withdraw -> swap (SOL -> USDC). They bind the
//! exact recipient / relayer keys and amounts through extDataHash, and the swap
//! binds the escrow PDA of the placeholder program id.

mod common;

use common::*;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::path::PathBuf;
use std::str::FromStr;

const POOL_PROGRAM: &str = "FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6";
const MOCK_PROGRAM: &str = "9GECyzNTXuqebHQb6WBWcFxiVqpUheQ8brZXRDBdNbsJ";
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const LOADER_V3: &str = "BPFLoaderUpgradeab1e11111111111111111111111";
const COMPUTE_BUDGET: &str = "ComputeBudget111111111111111111111111111111";
const NATIVE_MINT: &str = "So11111111111111111111111111111111111111112";
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

fn a(s: &str) -> Address {
    Address::from_str(s).unwrap()
}
fn from_pk(pk: &anchor_lang::prelude::Pubkey) -> Address {
    Address::new_from_array(pk.to_bytes())
}
fn pool_id() -> Address {
    a(POOL_PROGRAM)
}
fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

fn disc(name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("global:{name}").as_bytes());
    h[..8].try_into().unwrap()
}

fn deploy_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy")
}

fn program_bytes(name: &str) -> Vec<u8> {
    let p = deploy_dir().join(name);
    std::fs::read(&p).unwrap_or_else(|e| {
        panic!("{} missing ({e}): run `anchor build` (or cargo build-sbf) first", p.display())
    })
}

// ---------------------------------------------------------------------------
// Raw SPL Token layouts (avoid depending on a particular spl-token crate version)
// ---------------------------------------------------------------------------

fn coption_key(k: Option<&Address>) -> Vec<u8> {
    let mut v = Vec::with_capacity(36);
    match k {
        Some(k) => {
            v.extend_from_slice(&1u32.to_le_bytes());
            v.extend_from_slice(k.as_ref());
        }
        None => v.extend_from_slice(&[0u8; 36]),
    }
    v
}

fn mint_data(authority: &Address, decimals: u8) -> Vec<u8> {
    let mut d = coption_key(Some(authority));
    d.extend_from_slice(&0u64.to_le_bytes());
    d.push(decimals);
    d.push(1);
    d.extend(coption_key(None));
    assert_eq!(d.len(), 82);
    d
}

fn token_account_data(mint: &Address, owner: &Address, amount: u64, native_reserve: Option<u64>) -> Vec<u8> {
    let mut d = Vec::with_capacity(165);
    d.extend_from_slice(mint.as_ref());
    d.extend_from_slice(owner.as_ref());
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend(coption_key(None)); // delegate
    d.push(1); // Initialized
    match native_reserve {
        Some(r) => {
            d.extend_from_slice(&1u32.to_le_bytes());
            d.extend_from_slice(&r.to_le_bytes());
        }
        None => d.extend_from_slice(&[0u8; 12]),
    }
    d.extend_from_slice(&0u64.to_le_bytes()); // delegated_amount
    d.extend(coption_key(None)); // close_authority
    assert_eq!(d.len(), 165);
    d
}

fn token_amount(svm: &LiteSVM, acc: &Address) -> u64 {
    let d = svm.get_account(acc).expect("token account").data;
    u64::from_le_bytes(d[64..72].try_into().unwrap())
}

fn lamports(svm: &LiteSVM, acc: &Address) -> u64 {
    svm.get_account(acc).map(|x| x.lamports).unwrap_or(0)
}

fn put_mint(svm: &mut LiteSVM, mint: &Address, authority: &Address, decimals: u8) {
    let data = mint_data(authority, decimals);
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(*mint, Account { lamports, data, owner: a(TOKEN_PROGRAM), executable: false, rent_epoch: 0 })
        .unwrap();
}

fn put_token_account(svm: &mut LiteSVM, addr: &Address, mint: &Address, owner: &Address, amount: u64) {
    let rent = svm.minimum_balance_for_rent_exemption(165);
    let native = *mint == a(NATIVE_MINT);
    let data = token_account_data(mint, owner, amount, native.then_some(rent));
    let lamports = if native { rent + amount } else { rent };
    svm.set_account(*addr, Account { lamports, data, owner: a(TOKEN_PROGRAM), executable: false, rent_epoch: 0 })
        .unwrap();
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    payer: Keypair,
}

fn send(env: &mut Env, ixs: Vec<Instruction>, extra: &[&Keypair]) -> Result<u64, String> {
    let mut all = vec![Instruction {
        program_id: a(COMPUTE_BUDGET),
        accounts: vec![],
        data: {
            let mut d = vec![2u8];
            d.extend_from_slice(&1_400_000u32.to_le_bytes());
            d
        },
    }];
    all.extend(ixs);
    let mut signers: Vec<&Keypair> = vec![&env.payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(&all, Some(&env.payer.pubkey()), &signers, env.svm.latest_blockhash());
    let res = env.svm.send_transaction(tx);
    env.svm.expire_blockhash();
    match res {
        Ok(m) => Ok(m.compute_units_consumed),
        Err(f) => Err(format!("{:?}\n{}", f.err, f.meta.logs.join("\n"))),
    }
}

fn expect_err(r: Result<u64, String>, needle: &str) {
    match r {
        Ok(_) => panic!("expected failure containing {needle:?}, but the transaction succeeded"),
        Err(e) => assert!(e.contains(needle), "expected {needle:?} in error:\n{e}"),
    }
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(pool_id(), &program_bytes("dankswap_pool.so")).unwrap();
    svm.add_program(a(MOCK_PROGRAM), &program_bytes("mock_swap.so")).unwrap();
    let admin = Keypair::new();
    let payer = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&payer.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();

    // Give the program an upgrade authority (LiteSVM deploys with none).
    let pd_addr = pda(&[pool_id().as_ref()], &a(LOADER_V3));
    let mut pd = svm.get_account(&pd_addr).expect("programdata");
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }
    pd.data[0..4].copy_from_slice(&3u32.to_le_bytes());
    pd.data[12] = 1;
    pd.data[13..45].copy_from_slice(admin.pubkey().as_ref());
    svm.set_account(pd_addr, pd).unwrap();

    Env { svm, admin, payer }
}

fn config_pda() -> Address {
    pda(&[b"config"], &pool_id())
}
fn pool_pda(mint: &Address) -> Address {
    pda(&[b"pool", mint.as_ref()], &pool_id())
}
fn tree_pda(mint: &Address) -> Address {
    pda(&[b"tree", mint.as_ref()], &pool_id())
}
fn vault_pda(mint: &Address) -> Address {
    pda(&[b"vault", mint.as_ref()], &pool_id())
}
fn escrow_pda(pool: &Address) -> Address {
    pda(&[b"escrow", pool.as_ref()], &pool_id())
}
fn nullifier_pda(n: &[u8; 32]) -> Address {
    pda(&[b"nullifier", n], &pool_id())
}

fn ix_initialize(env: &Env, swap_program: &Address) -> Instruction {
    let mut data = disc("initialize").to_vec();
    data.extend_from_slice(swap_program.as_ref());
    Instruction {
        program_id: pool_id(),
        accounts: vec![
            AccountMeta::new(env.admin.pubkey(), true),
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(pool_id(), false),
            AccountMeta::new_readonly(pda(&[pool_id().as_ref()], &a(LOADER_V3)), false),
            AccountMeta::new_readonly(a(SYSTEM_PROGRAM), false),
        ],
        data,
    }
}

fn ix_initialize_pool(env: &Env, mint: &Address, max_deposit: u64) -> Instruction {
    let native = *mint == a(NATIVE_MINT);
    let vault = if native { pool_pda(mint) } else { vault_pda(mint) };
    let mut data = disc("initialize_pool").to_vec();
    data.extend_from_slice(&max_deposit.to_le_bytes());
    Instruction {
        program_id: pool_id(),
        accounts: vec![
            AccountMeta::new(env.admin.pubkey(), true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(pool_pda(mint), false),
            AccountMeta::new(tree_pda(mint), false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(a(TOKEN_PROGRAM), false),
            AccountMeta::new_readonly(a(SYSTEM_PROGRAM), false),
        ],
        data,
    }
}

fn ix_set_paused(authority: &Address, paused: bool) -> Instruction {
    let mut data = disc("set_deposits_paused").to_vec();
    data.push(paused as u8);
    Instruction {
        program_id: pool_id(),
        accounts: vec![AccountMeta::new_readonly(*authority, true), AccountMeta::new(config_pda(), false)],
        data,
    }
}

fn ix_set_limits(authority: &Address, mint: &Address, max_deposit: u64) -> Instruction {
    let mut data = disc("set_pool_limits").to_vec();
    data.extend_from_slice(&max_deposit.to_le_bytes());
    Instruction {
        program_id: pool_id(),
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(pool_pda(mint), false),
        ],
        data,
    }
}

/// Borsh args shared by transact / transact_swap (spec §8 order).
fn transact_args(c: &ProofCase, name: &str) -> Vec<u8> {
    let mut d = disc(name).to_vec();
    d.extend_from_slice(&c.proof_a);
    d.extend_from_slice(&c.proof_b);
    d.extend_from_slice(&c.proof_c);
    d.extend_from_slice(&c.root);
    d.extend_from_slice(&c.nullifiers[0]);
    d.extend_from_slice(&c.nullifiers[1]);
    d.extend_from_slice(&c.commitments[0]);
    d.extend_from_slice(&c.commitments[1]);
    d.extend_from_slice(&c.ext_amount.to_le_bytes());
    d.extend_from_slice(&c.fee.to_le_bytes());
    d.extend_from_slice(&c.enc1);
    d.extend_from_slice(&c.enc2);
    d
}

/// `transact` on the native SOL pool (signer_token_account = None, encoded as
/// the program id per Anchor's optional-account convention).
fn ix_transact_sol(signer: &Address, c: &ProofCase, recipient: &Address, relayer: &Address) -> Instruction {
    let mint = a(NATIVE_MINT);
    let pool = pool_pda(&mint);
    Instruction {
        program_id: pool_id(),
        accounts: vec![
            AccountMeta::new(*signer, true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new_readonly(pool, false),
            AccountMeta::new(tree_pda(&mint), false),
            AccountMeta::new(pool, false), // vault = pool PDA for native SOL
            AccountMeta::new(nullifier_pda(&c.nullifiers[0]), false),
            AccountMeta::new(nullifier_pda(&c.nullifiers[1]), false),
            AccountMeta::new(*recipient, false),
            AccountMeta::new(*relayer, false),
            AccountMeta::new_readonly(pool_id(), false), // signer_token_account: None
            AccountMeta::new_readonly(a(TOKEN_PROGRAM), false),
            AccountMeta::new_readonly(a(SYSTEM_PROGRAM), false),
        ],
        data: transact_args(c, "transact"),
    }
}

fn case<'a>(cases: &'a [ProofCase], name: &str) -> &'a ProofCase {
    cases.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("proofs.json has no {name:?} proof"))
}

fn init_sol_pool(env: &mut Env) {
    let ix = ix_initialize(env, &a(MOCK_PROGRAM));
    let admin = env.admin.insecure_clone();
    send(env, vec![ix], &[&admin]).expect("initialize");
    let ix = ix_initialize_pool(env, &a(NATIVE_MINT), 10 * LAMPORTS_PER_SOL);
    send(env, vec![ix], &[&admin]).expect("initialize_pool SOL");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
#[ignore = "needs target/deploy/*.so from `anchor build` (runs in CI)"]
fn initialize_and_pool_init() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();

    // Only the upgrade authority may initialize.
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), LAMPORTS_PER_SOL).unwrap();
    let mut bad = ix_initialize(&env, &a(MOCK_PROGRAM));
    bad.accounts[0] = AccountMeta::new(stranger.pubkey(), true);
    expect_err(send(&mut env, vec![bad], &[&stranger]), "Custom(6000)");

    init_sol_pool(&mut env);
    let sol_pool = pool_pda(&a(NATIVE_MINT));
    assert!(env.svm.get_account(&sol_pool).is_some());
    let tree = env.svm.get_account(&tree_pda(&a(NATIVE_MINT))).unwrap();
    assert_eq!(tree.data.len(), 8 + 3856);
    // roots[0] = empty root = zeros[20]
    assert_eq!(&tree.data[8 + 640..8 + 672], &dankswap_pool::crypto::ZEROS[20]);

    // SPL pool: vault PDA token account owned by the pool PDA.
    let usdc = a(USDC_MINT);
    put_mint(&mut env.svm, &usdc, &admin.pubkey(), 6);
    let ix = ix_initialize_pool(&env, &usdc, 1_000_000_000_000);
    let cu = send(&mut env, vec![ix], &[&admin]).expect("initialize_pool USDC");
    println!("initialize_pool (SPL) CU: {cu}");
    let vault = env.svm.get_account(&vault_pda(&usdc)).unwrap();
    assert_eq!(vault.owner, a(TOKEN_PROGRAM));
    assert_eq!(&vault.data[0..32], usdc.as_ref());
    assert_eq!(&vault.data[32..64], pool_pda(&usdc).as_ref());

    // Non-authority cannot pause or change limits.
    expect_err(send(&mut env, vec![ix_set_paused(&stranger.pubkey(), true)], &[&stranger]), "Custom(6000)");
    expect_err(send(&mut env, vec![ix_set_limits(&stranger.pubkey(), &usdc, 1)], &[&stranger]), "Custom(6000)");
    send(&mut env, vec![ix_set_limits(&admin.pubkey(), &usdc, 5)], &[&admin]).expect("set_pool_limits");
}

/// deposit -> double spend -> private transfer -> pause -> withdraw -> swap.
#[test]
#[ignore = "needs target/deploy/*.so from `anchor build` (runs in CI)"]
fn fixture_sequence_deposit_transfer_withdraw_swap() {
    let proofs = load_fixture("proofs.json");
    assert_eq!(proofs["programId"].as_str(), Some(POOL_PROGRAM), "fixtures were generated for another program id");
    let cases = proof_cases(&proofs);
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    init_sol_pool(&mut env);
    let mint = a(NATIVE_MINT);
    let pool = pool_pda(&mint);
    let payer = env.payer.pubkey();
    let pool_start = lamports(&env.svm, &pool);

    // --- deposit (1 SOL) ---
    let dep = case(&cases, "deposit");
    assert!(dep.ext_amount > 0);
    let (r, rl) = (from_pk(&dep.recipient), from_pk(&dep.relayer));
    let payer_before = lamports(&env.svm, &payer);
    let cu = send(&mut env, vec![ix_transact_sol(&payer, dep, &r, &rl)], &[]).expect("deposit");
    println!("transact deposit CU: {cu}");
    assert_eq!(lamports(&env.svm, &pool), pool_start + dep.ext_amount as u64);
    assert!(payer_before - lamports(&env.svm, &payer) >= dep.ext_amount as u64);
    assert!(env.svm.get_account(&nullifier_pda(&dep.nullifiers[0])).is_some());

    // --- double spend rejected (nullifier PDA already exists) ---
    expect_err(send(&mut env, vec![ix_transact_sol(&payer, dep, &r, &rl)], &[]), "already in use");

    // --- private transfer (fee to relayer) ---
    let tr = case(&cases, "transfer");
    let (r, rl) = (from_pk(&tr.recipient), from_pk(&tr.relayer));
    let rl_before = lamports(&env.svm, &rl);
    let cu = send(&mut env, vec![ix_transact_sol(&payer, tr, &r, &rl)], &[]).expect("transfer");
    println!("transact private send CU: {cu}");
    assert_eq!(lamports(&env.svm, &rl), rl_before + tr.fee);

    // --- pause deposits: a deposit fails, the withdrawal still works ---
    send(&mut env, vec![ix_set_paused(&admin.pubkey(), true)], &[&admin]).expect("pause");
    let mut fake = dep.clone();
    fake.root = dankswap_pool::crypto::ZEROS[20]; // still a known root
    fake.nullifiers = [[9u8; 32], [10u8; 32]];
    for n in fake.nullifiers.iter_mut() {
        n[0] = 0;
    }
    let (r, rl) = (from_pk(&fake.recipient), from_pk(&fake.relayer));
    expect_err(send(&mut env, vec![ix_transact_sol(&payer, &fake, &r, &rl)], &[]), "Custom(6002)");

    let wd = case(&cases, "withdraw");
    assert!(wd.ext_amount < 0);
    let (r, rl) = (from_pk(&wd.recipient), from_pk(&wd.relayer));
    // Tampered recipient => extDataHash mismatch => proof rejected.
    let wrong = Keypair::new().pubkey();
    expect_err(send(&mut env, vec![ix_transact_sol(&payer, wd, &wrong, &rl)], &[]), "Custom(6005)");
    let (r_before, rl_before, pool_before) = (lamports(&env.svm, &r), lamports(&env.svm, &rl), lamports(&env.svm, &pool));
    let cu = send(&mut env, vec![ix_transact_sol(&payer, wd, &r, &rl)], &[]).expect("withdraw while paused");
    println!("transact withdraw CU: {cu}");
    let out = wd.ext_amount.unsigned_abs();
    assert_eq!(lamports(&env.svm, &r), r_before + out);
    assert_eq!(lamports(&env.svm, &rl), rl_before + wd.fee);
    assert_eq!(lamports(&env.svm, &pool), pool_before - out - wd.fee);
    send(&mut env, vec![ix_set_paused(&admin.pubkey(), false)], &[&admin]).expect("unpause");

    // --- deposit limit ---
    send(&mut env, vec![ix_set_limits(&admin.pubkey(), &mint, 1)], &[&admin]).expect("limit");
    let mut fake2 = fake.clone();
    fake2.nullifiers[0][5] = 77;
    expect_err(send(&mut env, vec![ix_transact_sol(&payer, &fake2, &r, &rl)], &[]), "Custom(6003)");
    send(&mut env, vec![ix_set_limits(&admin.pubkey(), &mint, 10 * LAMPORTS_PER_SOL)], &[&admin]).expect("limit");

    // --- private swap SOL -> USDC through mock-swap ---
    let sw = case(&cases, "swap");
    let usdc = a(USDC_MINT);
    assert_eq!(sw.swap_mint.map(|m| from_pk(&m)), Some(usdc));
    let escrow = escrow_pda(&pool);
    assert_eq!(from_pk(&sw.recipient), escrow, "swap fixture must bind the escrow PDA");
    let relayer = from_pk(&sw.relayer);

    put_mint(&mut env.svm, &usdc, &admin.pubkey(), 6);
    let ix = ix_initialize_pool(&env, &usdc, 1_000_000_000_000);
    send(&mut env, vec![ix], &[&admin]).expect("initialize_pool USDC");

    let mock = a(MOCK_PROGRAM);
    let reserve = pda(&[b"reserve"], &mock);
    let (esc_in, esc_out, res_in, res_out, surplus) =
        (Keypair::new().pubkey(), Keypair::new().pubkey(), Keypair::new().pubkey(), Keypair::new().pubkey(), Keypair::new().pubkey());
    put_token_account(&mut env.svm, &esc_in, &mint, &escrow, 0);
    put_token_account(&mut env.svm, &esc_out, &usdc, &escrow, 0);
    put_token_account(&mut env.svm, &res_in, &mint, &reserve, 0);
    put_token_account(&mut env.svm, &res_out, &usdc, &reserve, 1_000_000_000);
    put_token_account(&mut env.svm, &surplus, &usdc, &relayer, 0);

    let amount_in = sw.ext_amount.unsigned_abs();
    let amount_out = sw.swap_amount + 1_000_000; // 1 USDC surplus for the relayer
    let mut swap_data = disc("swap").to_vec();
    swap_data.extend_from_slice(&amount_in.to_le_bytes());
    swap_data.extend_from_slice(&amount_out.to_le_bytes());

    let build_swap_ix = |swap_data: Vec<u8>| {
        let mut data = transact_args(sw, "transact_swap");
        data.extend_from_slice(&sw.swap_amount.to_le_bytes());
        data.extend_from_slice(&sw.swap_commitment);
        data.extend_from_slice(&sw.enc_swap);
        data.extend_from_slice(&(swap_data.len() as u32).to_le_bytes());
        data.extend_from_slice(&swap_data);
        Instruction {
            program_id: pool_id(),
            accounts: vec![
                AccountMeta::new(payer, true),
                AccountMeta::new_readonly(config_pda(), false),
                AccountMeta::new_readonly(pool, false),
                AccountMeta::new(tree_pda(&mint), false),
                AccountMeta::new(pool, false), // input vault (native)
                AccountMeta::new(nullifier_pda(&sw.nullifiers[0]), false),
                AccountMeta::new(nullifier_pda(&sw.nullifiers[1]), false),
                AccountMeta::new(relayer, false), // relayer_fee_account (SOL)
                AccountMeta::new(escrow, false),
                AccountMeta::new(esc_in, false),
                AccountMeta::new(esc_out, false),
                AccountMeta::new_readonly(pool_pda(&usdc), false),
                AccountMeta::new(tree_pda(&usdc), false),
                AccountMeta::new(vault_pda(&usdc), false),
                AccountMeta::new(surplus, false),
                AccountMeta::new_readonly(mock, false),
                AccountMeta::new_readonly(a(TOKEN_PROGRAM), false),
                AccountMeta::new_readonly(a(SYSTEM_PROGRAM), false),
                // remaining_accounts = mock-swap `swap` accounts, in its order
                AccountMeta::new(escrow, false),
                AccountMeta::new(esc_in, false),
                AccountMeta::new(res_in, false),
                AccountMeta::new(res_out, false),
                AccountMeta::new(esc_out, false),
                AccountMeta::new_readonly(reserve, false),
                AccountMeta::new_readonly(a(TOKEN_PROGRAM), false),
            ],
            data,
        }
    };

    // A swap that returns less than swap_amount is rejected.
    let mut short = disc("swap").to_vec();
    short.extend_from_slice(&amount_in.to_le_bytes());
    short.extend_from_slice(&(sw.swap_amount - 1).to_le_bytes());
    expect_err(send(&mut env, vec![build_swap_ix(short)], &[]), "Custom(6020)");

    let (pool_before, rl_before) = (lamports(&env.svm, &pool), lamports(&env.svm, &relayer));
    let cu = send(&mut env, vec![build_swap_ix(swap_data)], &[]).expect("transact_swap");
    println!("transact_swap (SOL->USDC, mock) CU: {cu}");
    assert_eq!(lamports(&env.svm, &pool), pool_before - amount_in - sw.fee);
    assert_eq!(lamports(&env.svm, &relayer), rl_before + sw.fee);
    assert_eq!(token_amount(&env.svm, &vault_pda(&usdc)), sw.swap_amount);
    assert_eq!(token_amount(&env.svm, &surplus), 1_000_000);
    assert_eq!(token_amount(&env.svm, &esc_in), 0);
    assert_eq!(token_amount(&env.svm, &esc_out), 0);
    assert_eq!(token_amount(&env.svm, &res_in), amount_in);
    let out_tree = env.svm.get_account(&tree_pda(&usdc)).unwrap();
    let next_index = u64::from_le_bytes(out_tree.data[3856..3864].try_into().unwrap());
    assert_eq!(next_index, 1);
    let in_tree = env.svm.get_account(&tree_pda(&mint)).unwrap();
    let next_index = u64::from_le_bytes(in_tree.data[3856..3864].try_into().unwrap());
    assert_eq!(next_index, 8);

    // Pool accounting: everything that left is accounted for.
    assert_eq!(
        lamports(&env.svm, &pool),
        pool_start + dep.ext_amount as u64 - tr.fee - wd.ext_amount.unsigned_abs() - wd.fee - amount_in - sw.fee
    );
}
