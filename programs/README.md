# DankSwap shielded pool program (`dankswap_pool`)

> **Unaudited. Devnet only.** It uses a dev trusted setup (single contributor, so it is unsafe for real funds).
> Mainnet needs independent audits of the circuits and the program, and a multi-party
> phase-2 ceremony (docs/PHASE2_SPEC.md §11).

This is an Anchor program for a variable-amount UTXO pool (Tornado Nova style) with one pool per mint
(SOL, USDC, USDT). It verifies Groth16 proofs with `groth16-solana` (alt_bn128 syscalls), keeps a
Poseidon Merkle tree (`sol_poseidon` syscall) and marks spent notes with nullifier PDAs.
Encodings follow docs/PHASE2_SPEC.md byte for byte. This document is the client ABI for the
relayer and the browser SDK.

| Item | Value |
|---|---|
| Program id (placeholder) | `FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6` |
| Test-only mock swap program | `9GECyzNTXuqebHQb6WBWcFxiVqpUheQ8brZXRDBdNbsJ` (`programs/mock-swap`, never deploy) |
| Crates | `anchor-lang =1.2.2`, `anchor-spl =1.2.2` (`token`, `token_2022`, `solana-v3`), `groth16-solana =0.2.0`, `solana-poseidon =4.0.0`, `solana-sha256-hasher =3.1.0`, `bytemuck 1`; dev: `litesvm =0.16.0` |
| Token program | Classic SPL Token only (`Tokenkeg…`). Token-2022 mints are rejected by `initialize_pool`. |

### Replacing the program id

The id in `declare_id!` (`programs/dankswap-pool/src/lib.rs`) and `Anchor.toml` is a placeholder
with no known keypair. To use a real program keypair:

1. Put the keypair at `target/deploy/dankswap_pool-keypair.json` and run `anchor keys sync`, or edit
   `declare_id!` and both `Anchor.toml` entries by hand.
2. Every PDA changes, including the swap escrow, which is bound into the swap proof's
   extDataHash. Regenerate `circuits/fixtures/proofs.json` with the new `PROGRAM_ID` in
   `circuits/lib/scenario.js`. The LiteSVM tests assert that `proofs.json.programId` matches.
3. Store the program keypair as the `DEVNET_PROGRAM_KEYPAIR` secret for the CI deploy job.

## PDAs

| Account | Seeds | Notes |
|---|---|---|
| config | `["config"]` | `Config { authority: Pubkey, swap_program: Pubkey, deposits_paused: bool, bump: u8 }`, 8 + 66 bytes |
| pool | `["pool", mint]` | `Pool { mint: Pubkey, mint_field: [u8;32], is_native: bool, max_deposit: u64, vault: Pubkey, tree: Pubkey, bump: u8 }`, 8 + 138 bytes |
| tree | `["tree", mint]` | zero-copy `MerkleTree { filled_subtrees: [[u8;32];20], roots: [[u8;32];100], current_root_index: u64, next_index: u64 }`, 8 + 3856 bytes |
| vault (SPL) | `["vault", mint]` | SPL token account; mint = pool mint, owner (authority) = pool PDA |
| vault (native SOL) | `["vault", wSOL mint]` | data-less **system-owned** PDA holding the pool's lamports; kept rent-exempt. All SOL moves are signed System transfers (no direct lamport edits, which the runtime rejects when a CPI follows) |
| nullifier | `["nullifier", nullifier32]` | empty marker (8-byte discriminator). If it exists, the note is spent. Global, not per pool |
| escrow | `["escrow", input_pool]` | system account with no data. It signs the swap CPI and owns the escrow token accounts |

All Anchor accounts start with the 8-byte discriminator `sha256("account:<Name>")[..8]`.
Offsets inside `tree` data: `filled_subtrees` at 8, `roots` at 648, `current_root_index` at 3848,
`next_index` at 3856.

The native SOL pool is the pool whose mint is `So11111111111111111111111111111111111111112`.
Its `mintField` comes from that wSOL mint (spec §1), but it holds native lamports.

## Instruction encoding

Instruction data is `sha256("global:<ix_name>")[..8]`, followed by the arguments in **Borsh**:
fixed arrays as raw bytes, `u64`/`i64` little-endian, `bool` as 1 byte, `Pubkey` as 32 bytes,
`Vec<u8>` as a `u32` LE length then the bytes. Field elements are 32-byte big-endian (spec §1).
Optional accounts (`Option<…>`): to pass *None*, pass the **program id** in that slot
(read-only), as Anchor does.

Account flags: **w** = writable, **s** = signer.

### `initialize(swap_program: Pubkey)`

Creates the config with `authority = signer`. Only the program's **upgrade authority** may call
it, so nobody can front-run initialization after a deploy.

| # | Account | Flags |
|---|---|---|
| 0 | authority (= program upgrade authority, payer) | w, s |
| 1 | config PDA | w |
| 2 | program (this program id) | |
| 3 | program data (`find_program_address([program_id], BPFLoaderUpgradeab1e…)`) | |
| 4 | system program | |

### `initialize_pool(max_deposit: u64)` (authority only)

Creates the pool, the tree (filled_subtrees = zeros, roots[0] = zeros[20]) and, for SPL mints, the vault.

| # | Account | Flags |
|---|---|---|
| 0 | authority (payer) | w, s |
| 1 | config | |
| 2 | mint (wSOL mint for the SOL pool; it does not need to exist) | |
| 3 | pool PDA `["pool", mint]` | w |
| 4 | tree PDA `["tree", mint]` | w |
| 5 | vault: PDA `["vault", mint]` (SPL token account, or system-owned lamport vault for native SOL) | w |
| 6 | token program | |
| 7 | system program | |

### `set_pool_limits(max_deposit: u64)` (authority only)

| # | Account | Flags |
|---|---|---|
| 0 | authority | s |
| 1 | config | |
| 2 | pool | w |

### `set_deposits_paused(paused: bool)` (authority only)

| # | Account | Flags |
|---|---|---|
| 0 | authority | s |
| 1 | config | w |

When deposits are paused, `transact` with `ext_amount > 0` and every `transact_swap` (a swap
credits the output pool) are blocked. Withdrawals and private sends are **never** blocked.
The authority cannot move funds, change the verifying key or block withdrawals. The authority
cannot be changed either. A program upgrade is the only path, governed by the upgrade
authority plan below.

### `transact(...)`

Arguments, in this order:

| Arg | Type | Bytes |
|---|---|---|
| proof_a | `[u8; 64]` | negated G1 (spec §7) |
| proof_b | `[u8; 128]` | G2, `x.c1‖x.c0‖y.c1‖y.c0` |
| proof_c | `[u8; 64]` | |
| root | `[u8; 32]` | |
| input_nullifiers | `[[u8; 32]; 2]` | |
| output_commitments | `[[u8; 32]; 2]` | |
| ext_amount | `i64` | |
| fee | `u64` | |
| encrypted_output1 | `[u8; 87]` | |
| encrypted_output2 | `[u8; 87]` | |

Total data = 8 + 64 + 128 + 64 + 32 + 64 + 64 + 8 + 8 + 87 + 87 = **614 bytes**.

| # | Account | Flags | Notes |
|---|---|---|---|
| 0 | signer | w, s | pays nullifier rent (depositor or relayer) |
| 1 | config | | |
| 2 | pool | | |
| 3 | tree (= pool.tree) | w | |
| 4 | vault (= pool.vault, PDA `["vault", mint]`) | w | |
| 5 | nullifier0 PDA `["nullifier", input_nullifiers[0]]` | w | created with `init` |
| 6 | nullifier1 PDA `["nullifier", input_nullifiers[1]]` | w | created with `init` |
| 7 | recipient | w | see below |
| 8 | relayer_fee_account | w | see below |
| 9 | signer_token_account (optional) | w | SPL deposits: the signer's token account of the pool mint. Otherwise pass the program id (None) |
| 10 | token program | | always required |
| 11 | system program | | |

**extDataHash binding (important for clients).** The program computes
`extDataHash = sha256(recipient ‖ relayer ‖ ext_amount LE ‖ fee LE ‖ enc1 ‖ enc2 ‖ 87 zero bytes)`,
sets byte 0 to `0x00`, and uses **the public keys of accounts #7 and #8** as `recipient` and `relayer`.
That means:

- SOL pool: `recipient` / `relayer` are the system accounts that receive lamports.
- SPL pool withdrawals and private sends: `recipient` / `relayer` are the **token accounts**
  (for example ATAs) that receive tokens. They must be SPL token accounts of the pool mint.
  The program checks this whenever it pays a non-zero amount to them.
- Deposits: the two keys only go into the hash. By convention both are the depositor's wallet
  (spec §5). They are not used for funds, but they must still be passed as writable.

Rules:

- The `root` must be non-zero and among the last 100 roots.
- Deposit (`ext_amount > 0`): deposits must not be paused, `ext_amount <= pool.max_deposit`, and
  `fee == 0`. Funds come from the signer: a system transfer for SOL, or an SPL `Transfer` from
  `signer_token_account` (signer = owner) for SPL pools.
- `ext_amount < 0`: `-ext_amount` goes to the recipient. `fee > 0` goes to `relayer_fee_account`. Both
  come from the vault. The SOL vault PDA pays out by signed System transfer and never goes below its rent-exempt
  minimum. A brand-new SOL recipient must receive at least the rent-exempt minimum for 0 bytes
  (890,880 lamports), or the runtime rejects the transaction.
- `publicAmount = (ext_amount − fee) mod p` (32-byte BE, `p − |x|` when negative). `mintField = pool.mint_field`.
  The swap inputs are 0. The proof is verified with the inputs range-checked (`< p`), so
  non-canonical nullifier encodings are rejected.
- Appends `output_commitments[0]` at `next_index` and `[1]` at `next_index + 1`. **One** root is pushed per instruction.

Events: `NewCommitment` ×2, then `NewNullifier` ×2.

### `transact_swap(...)`

Takes the same first 10 arguments as `transact`, then:

| Arg | Type | Notes |
|---|---|---|
| swap_amount | `u64` | guaranteed (minimum) output, public input #9 (32-byte BE of the u64) |
| swap_commitment | `[u8; 32]` | public input #10, appended to the **output** pool's tree |
| encrypted_swap_output | `[u8; 87]` | goes into extDataHash and the output pool's `NewCommitment` event |
| swap_data | `Vec<u8>` | raw instruction data for `config.swap_program` (for example a Jupiter v6 route) |

`swap_mint_field` is **not** an argument. The program uses `output_pool.mint_field`, so the
spec's rule `swap_mint_field == output_pool.mint_field` holds by construction. It also requires
`output_pool.mint_field != input_pool.mint_field`, `ext_amount < 0` and `swap_amount > 0`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 0 | signer (relayer / fee payer) | w, s | pays nullifier rent |
| 1 | config | | |
| 2 | input_pool | | |
| 3 | input_tree | w | |
| 4 | input_vault (= input_pool.vault) | w | |
| 5 | nullifier0 | w | |
| 6 | nullifier1 | w | |
| 7 | relayer_fee_account | w | extDataHash `relayer`. The fee is paid in the input mint (system account for SOL, token account otherwise) |
| 8 | escrow PDA `["escrow", input_pool]` | w | extDataHash `recipient` |
| 9 | escrow_input_token | w | token account: mint = input mint (wSOL for the SOL pool), owner = escrow |
| 10 | escrow_output_token | w | token account: mint = output mint (wSOL for the SOL pool), owner = escrow |
| 11 | output_pool | | |
| 12 | output_tree | w | |
| 13 | output_vault (= output_pool.vault) | w | |
| 14 | relayer_surplus_account | w | receives any output above `swap_amount`: a token account of the output mint, or any system account if the output is SOL |
| 15 | swap_program (= config.swap_program) | | executable |
| 16 | token program | | |
| 17 | system program | | |
| 18… | remaining accounts | | passed through, in order, to the swap CPI. The escrow PDA's `is_signer` is set to true; the other signer and writable flags are copied |

Flow:

1. Check the root, the deposit rules of the output pool (not paused, `swap_amount <= output_pool.max_deposit`) and the proof.
2. Pay `fee` from the input vault to `relayer_fee_account`.
3. Move `-ext_amount` into `escrow_input_token`. For a SOL input, lamports go from the pool PDA into
   the escrow's wSOL account, followed by `SyncNative`.
4. CPI `swap_program(swap_data, remaining_accounts)`, signed by the escrow PDA.
5. Re-read both escrow token accounts. Each must still be owned by the escrow, have the same mint,
   and have no delegate and no close authority. The input balance must be ≤ its balance before step 3,
   meaning the full input was consumed. The output balance increase must be ≥ `swap_amount`.
6. Move `swap_amount` to the output vault and the surplus to `relayer_surplus_account`. For a SOL
   output, the escrow's wSOL account is **closed** into the escrow PDA. `swap_amount` lamports go to
   the SOL pool PDA, and everything left (surplus plus the closed account's rent) goes to
   `relayer_surplus_account`. The client must re-create the escrow wSOL account before each such
   swap, for example with an idempotent ATA create instruction earlier in the same transaction.
7. Append both output commitments to the input tree (one root), and `swap_commitment` to the output tree (one root).

Events: `NewCommitment` ×2 (input pool), `NewCommitment` ×1 (output pool, `encrypted_swap_output`), then `NewNullifier` ×2.

Clients must create the escrow token accounts beforehand. Using the escrow PDA's ATAs is
recommended. A Jupiter route plus 18 fixed accounts does not fit in a legacy transaction,
so use a v0 transaction with address lookup tables.

## Events

Anchor events are logged as `Program data: base64(sha256("event:<Name>")[..8] ‖ borsh(fields))`.

| Event | Fields (Borsh order) |
|---|---|
| `NewCommitment` | `pool: Pubkey`, `commitment: [u8;32]`, `index: u64`, `encrypted_output: [u8;87]` |
| `NewNullifier` | `nullifier: [u8;32]` |

## Errors

Custom codes start at 6000 (Anchor). Anchor's own constraint errors use codes from 2000 upward.
A double spend shows up as the system program's "already in use" error when `init` creates the
nullifier PDA.

| Code | Name | Meaning |
|---|---|---|
| 6000 | Unauthorized | signer is not the config authority (or not the upgrade authority for `initialize`) |
| 6001 | UnknownRoot | root is zero or not in the 100-root history |
| 6002 | DepositsPaused | |
| 6003 | DepositLimitExceeded | `ext_amount` (or `swap_amount`) > `max_deposit` |
| 6004 | DepositFeeNotZero | |
| 6005 | InvalidProof | Groth16 verification failed (includes any extDataHash mismatch and public inputs ≥ p) |
| 6006 | MathOverflow | |
| 6007 | TreeFull | 2^20 leaves |
| 6008 | PoseidonError | |
| 6009 | InvalidVault | |
| 6010 | InvalidMint | not a classic SPL Token mint |
| 6011 | InvalidRecipient | not a token account of the pool mint (SPL), or equal to the vault |
| 6012 | InvalidRelayerAccount | same check, for `relayer_fee_account` |
| 6013 | InvalidSignerTokenAccount | SPL deposit without a matching `signer_token_account` |
| 6014 | InsufficientPoolBalance | would take the SOL pool below rent exemption |
| 6015 | InvalidSwapExtAmount | `transact_swap` needs `ext_amount < 0` |
| 6016 | SameMintSwap | |
| 6017 | ZeroSwapAmount | |
| 6018 | InvalidSwapProgram | |
| 6019 | InvalidEscrowAccount | (reserved) |
| 6020 | SwapOutputTooLow | |
| 6021 | SwapInputNotConsumed | |
| 6022 | EscrowTampered | |
| 6023 | InvalidSurplusAccount | |
| 6024 | InvalidInstructionData | (reserved) |

## Compute

These are **estimates**, not measurements: the SBF build cannot run in the dev sandbox. The CI LiteSVM tests print the
real `compute_units_consumed` for every instruction (`--nocapture`). Update this table from the CI log.

| Instruction | Estimate | Main costs |
|---|---|---|
| transact | ~200k–260k CU | Groth16: 11 G1 mul + add (~45k) + 4-pair pairing (~85k) + allocation; 40 Poseidon hashes (~32k); 2 `init` CPIs; 100-root scan |
| transact_swap | ~300k CU + swap CPI | as above, plus 20 Poseidon hashes for the output tree, token CPIs, and the Jupiter route (100k–600k) |
| initialize_pool | ~30k CU | account creation |

Recommended client compute limits: about 400,000 CU for `transact`. The spec asks for 1.4M for
`transact_swap`, which is the cap. Clients should simulate first and set the limit to roughly 1.2× the simulated units.

## Upgrade authority plan (devnet → mainnet)

1. **Devnet:** a single deployer key (`DEVNET_DEPLOYER_KEYPAIR`) is the upgrade authority, so the program can iterate quickly.
2. **Mainnet (only after the audits and the MPC ceremony):** deploy with the upgrade authority set to a
   Squads multisig (for example 3-of-5 independent signers). Every upgrade goes through a timelock
   (at least 7 days, announced publicly with the verifiable-build hash) so users can withdraw first.
   Withdrawals can never be paused, so exiting is always possible.
3. **After a stabilization period:** remove the upgrade authority
   (`solana program set-upgrade-authority --final`), which freezes the program and its verifying key.

The config authority (pause and limits) should be the same multisig. It cannot move funds.

## Tests

- `cargo test -p dankswap-pool --test fixtures` runs on the host and needs `circuits/fixtures/*.json`, including
  `proofs.json`, plus the generated `src/verifying_key.rs`. It covers Poseidon parity, zeros, Merkle single and pair
  inserts, the root ring, extDataHash, mintField, publicAmount encoding, Groth16 verification of every
  fixture proof, and rejection of tampered inputs (flipped byte, wrong root, un-negated `proof_a`, wrong fee,
  non-canonical nullifier).
- `cargo test -p dankswap-pool --test litesvm -- --include-ignored` needs `target/deploy/{dankswap_pool,mock_swap}.so`
  (`cargo build-sbf`) and runs in CI. It covers initialize (upgrade-authority gate), SOL and SPL pool init,
  authority-only admin, the fixture sequence (deposit, double spend rejected, private send, a deposit blocked while
  paused while the withdrawal still succeeds, tampered recipient rejected, deposit limit), and SOL→USDC `transact_swap`
  through `mock-swap` (including a too-low output being rejected).
