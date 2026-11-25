# Phase 2 spec: shielded pool (shield, private send, private swap, unshield, relayer)

Status: implementation spec. Devnet first. **Mainnet only after independent audits of circuits and program and a multi-party trusted setup.** Every component must refuse mainnet unless explicitly configured.

Design: a variable-amount UTXO pool (the Tornado Nova model, as used by Privacy Cash on Solana), one pool per mint (SOL, USDC, USDT). Notes carry an amount, so swaps and partial withdrawals work without fixed tiers.

All three workstreams MUST follow the encodings below byte-for-byte. Cross-checks are done with fixtures in `circuits/fixtures/`.

## 1. Field, hashes, encodings

- Field: BN254 scalar field `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- Field elements on-chain and in fixtures: **32-byte big-endian**. In JSON fixtures: decimal strings.
- Poseidon: circomlib Poseidon (`circomlib/circuits/poseidon.circom`, `circomlibjs` `buildPoseidon`). On-chain: `solana-poseidon` / `light-poseidon` with circom parameters (`Parameters::Bn254X5`, big-endian), which match circomlib for 1–12 inputs.
- `mintField(mint)`: the first 31 bytes of the 32-byte mint pubkey as a big-endian integer. As 32 bytes: `[0x00] ++ mint[0..31]`.
- Native SOL uses the wSOL mint `So11111111111111111111111111111111111111112` for `mintField`, but the SOL pool holds native lamports.

## 2. Keys and notes

- Shielded key seed: the user's wallet signs the UTF-8 message
  `DankSwap shielded account v1\n\nSign to unlock your private balance. This is free and does not move funds.`
  `seed = sha256(signatureBytes)`.
  Production (when `POOL_CONFIG.SITE_DOMAIN` is set): the message is instead a fixed Sign-In-With-Solana message for that domain and the wallet address, with no nonce or timestamp (`unlockMessage()` in `assets/js/pool/keys.js`). The text is the same every time, so keys stay deterministic, and SIWS-aware wallets warn the user when the requesting site is not the domain. Keys depend on the message, so the domain is set once, before any real deposit.
- `privKey = BE(sha256(seed ++ 0x01)) mod p`. `pubKey = Poseidon(privKey)`.
- Encryption keypair (X25519, tweetnacl `box`): `encSecret = sha256(seed ++ 0x02)`; `encPublic = nacl.box.keyPair.fromSecretKey(encSecret).publicKey`.
- Shielded address string: `"dank" + base58(pubKey32BE ++ encPublic32)`.
- Note (UTXO): `{ amount: u64, pubKey: field, blinding: field (random 31 bytes), mint }`.
- `commitment = Poseidon(amount, pubKey, blinding, mintField)` (4 inputs).
- `signature = Poseidon(privKey, commitment, pathIndex)`.
- `nullifier = Poseidon(commitment, pathIndex, signature)`.

## 3. Merkle tree

- Depth **20**, binary, `Poseidon(left, right)`.
- Zero leaf = `0`. `zeros[0] = 0`, `zeros[i+1] = Poseidon(zeros[i], zeros[i])`.
- One tree per pool. Leaves appended in order. `transact` appends `outputCommitment[0]` at `nextIndex` and `outputCommitment[1]` at `nextIndex+1`. `transact_swap` also appends `swapCommitment` to the **output pool's** tree (single append).
- The program keeps `filledSubtrees[20]`, a ring of the last **100** roots, and `nextIndex`. The input root must be one of the stored roots (and non-zero).

## 4. Circuit `Transaction(levels=20, nIns=2, nOuts=2)`

Public signals, declared **in this exact order** in the template (snarkjs public signal order = declaration order):

| # | Signal | Meaning |
|---|---|---|
| 0 | `root` | Merkle root the inputs are proven against |
| 1 | `publicAmount` | `(extAmount - fee) mod p` |
| 2 | `extDataHash` | §5 |
| 3 | `mintField` | Pool mint; every input and output note uses it |
| 4,5 | `inputNullifier[2]` | |
| 6,7 | `outputCommitment[2]` | |
| 8 | `swapMintField` | Output mint of a private swap, else 0 |
| 9 | `swapAmount` | Guaranteed swap output (minimum out), else 0 |
| 10 | `swapCommitment` | Note commitment in the output pool, else 0 |

Private signals: per input `inAmount, inPrivateKey, inBlinding, inPathIndices, inPathElements[levels]`; per output `outAmount, outPubkey, outBlinding`; `swapPubkey, swapBlinding`.

Constraints:
1. Each input: `inPubkey = Poseidon(inPrivateKey)`, commitment, signature, nullifier as §2; nullifier equals the public `inputNullifier[i]`. The Merkle root check is enforced only if `inAmount != 0` (dummy zero-amount inputs are allowed and still publish a unique nullifier).
2. Each output: `outputCommitment[j] = Poseidon(outAmount, outPubkey, outBlinding, mintField)`. All amounts are range-checked to **64 bits**.
3. The two input nullifiers are different.
4. Balance: `sum(inAmount) + publicAmount == sum(outAmount)` (field arithmetic).
5. Swap: if `swapAmount == 0` then `swapCommitment == 0` (and swapMintField is unconstrained but must be 0 by program rule). If `swapAmount != 0`, then `swapCommitment == Poseidon(swapAmount, swapPubkey, swapBlinding, swapMintField)`, `swapAmount` is 64-bit, and `swapMintField != mintField`.
6. `extDataHash` is bound with a dummy square constraint, as in Tornado.

A private swap spends notes of mint A with `extAmount = -x` (x leaves the pool for the swap), and proves the B note it will receive is worth exactly `swapAmount` of mint B.

## 5. External data and `extDataHash`

`extData = { recipient: Pubkey, relayer: Pubkey, extAmount: i64, fee: u64, encryptedOutput1: [u8; 87], encryptedOutput2: [u8; 87], encryptedSwapOutput: [u8; 87] (all zero if no swap) }`

`extDataHash = sha256(recipient(32) ++ relayer(32) ++ extAmount(i64 LE) ++ fee(u64 LE) ++ encryptedOutput1 ++ encryptedOutput2 ++ encryptedSwapOutput)`, then set byte 0 of the digest to `0x00`, read as a big-endian field element.

- Deposit (shield): `extAmount > 0`, `fee == 0`, `recipient` = depositor, `relayer` = depositor.
- Private send: `extAmount == 0`, `fee >= 0` paid from the pool to `relayer`.
- Withdraw (unshield): `extAmount < 0`: `-extAmount` goes to `recipient` and `fee` to `relayer`.
- Swap: `extAmount < 0`; `recipient` = the program's swap escrow PDA for the input pool.

Pool outflow = `max(-extAmount, 0) + fee`. Inflow = `max(extAmount, 0)`.

## 6. Encrypted outputs (note discovery)

`encryptedOutput = ephemeralPublicKey(32) ++ nacl.box(plaintext, nonce = 24 zero bytes, recipientEncPublic, ephemeralSecret)`, where `plaintext = amount(u64 LE, 8) ++ blinding(31 bytes BE)` (39 bytes → 55-byte box) → **87 bytes total**. A fresh ephemeral keypair per output makes the zero nonce safe. Wallets try to decrypt every output and keep the notes whose recomputed commitment matches.

Dummy/zero outputs still get a valid-looking encryption to a random key.

## 7. Proof encoding (groth16-solana)

From snarkjs `proof.json`:
- `proofA` (64): `x(32 BE) ++ (p_q - y)(32 BE)`, i.e. **negated** G1, where `p_q` is the base field modulus `21888242871839275222246405745257275088696311157297823662689037894645226208583`.
- `proofB` (128): `x.c1 ++ x.c0 ++ y.c1 ++ y.c0`, where snarkjs `pi_b = [[x.c0, x.c1], [y.c0, y.c1], ...]`.
- `proofC` (64): `x ++ y`.
- Public inputs: 11 × 32-byte BE in the §4 order.
- Verifying key: generated from `verification_key.json` into `programs/dankswap-pool/src/verifying_key.rs` as a `groth16_solana::groth16::Groth16Verifyingkey` (G2 points also c1 before c0).

## 8. Program `dankswap_pool` (Anchor)

PDAs:
- `config` = `["config"]`: `authority`, `swap_program` (Jupiter v6 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` on mainnet; a mock in tests), `deposits_paused: bool`, `bump`.
- `pool` = `["pool", mint]`: `mint`, `mint_field: [u8;32]`, `is_native: bool`, `max_deposit: u64`, `vault` (SPL token account owned by the pool PDA, or for native SOL the pool PDA's own lamports above rent), `tree` key, `bump`.
- `tree` = `["tree", mint]`: zero-copy `filled_subtrees: [[u8;32];20]`, `roots: [[u8;32];100]`, `current_root_index: u64`, `next_index: u64`.
- `nullifier` = `["nullifier", nullifier32]`: empty marker account created with `init`; its existence means spent.
- `escrow` = `["escrow", pool]`: swap escrow authority (token accounts for the in/out mints).

Instructions:
- `initialize(swap_program)`: create the config (authority = signer).
- `initialize_pool(max_deposit)`: authority only. Creates pool, tree (with `zeros` and the initial root) and vault.
- `set_pool_limits(max_deposit)`, `set_deposits_paused(bool)`: authority only. **Neither can touch funds or block withdrawals.**
- `transact(proof_a, proof_b, proof_c, root, input_nullifiers[2], output_commitments[2], ext_amount: i64, fee: u64, encrypted_output1, encrypted_output2)`:
  the program derives `mintField` from the pool, `publicAmount` from ext_amount/fee, and `extDataHash` from the accounts and data (§5, with a zero swap blob). Swap public inputs are 0. Steps: check root is known; check deposit rules (not paused, `ext_amount <= max_deposit`, fee == 0); verify the Groth16 proof; `init` both nullifier PDAs (fails on double spend); move funds; append the two commitments; emit `NewCommitment { pool, commitment, index, encrypted_output }` twice and `NewNullifier { nullifier }` twice.
  Accounts: `signer` (payer: depositor or relayer), `config`, `pool`, `tree`, `vault`, `nullifier0`, `nullifier1`, `recipient` (system account, or token account for SPL), `relayer_fee_account`, optional `signer_token_account` (SPL deposits), `token_program`, `system_program`.
- `transact_swap(...)`: like transact with `ext_amount < 0` and the swap public inputs supplied. Funds go to the escrow input token account; the program CPIs `config.swap_program` with caller-provided instruction data and `remaining_accounts`, signing as the escrow PDA; then requires the escrow output-token balance to rise by `>= swap_amount`; moves `swap_amount` into the output pool's vault, sends any surplus to the relayer, and appends `swapCommitment` to the output pool's tree (with a `NewCommitment` event carrying `encryptedSwapOutput`). It requires `swap_mint_field == output_pool.mint_field`.
- Compute: request 1.4M CU. The Groth16 verify uses alt_bn128 syscalls; Poseidon uses the `sol_poseidon` syscall.

Rules: no instruction lets anyone move pool funds without a valid proof. Withdrawals are never pausable. Amount math is checked (no overflow). The upgrade authority is a multisig with a timelock, then removed (documented, not code).

## 9. Relayer (`relayer/`, Node 20+, no framework)

- `GET /info` → `{ relayer: pubkey, feeBps, minFeeLamports: {SOL,USDC,USDT}, cluster, programId }`.
- `POST /relay` body `{ instruction: "transact"|"transact_swap", pool, args (base64 fields), extData }`: validates the fee against its schedule, screens the recipient against the sanctions list, rebuilds and **simulates** the transaction, signs as fee payer, sends, and returns `{ signature }`.
- `GET /commitments?pool=<mint>&from=<index>` → `{ items: [{ index, commitment, encryptedOutput }], nextIndex, root }` from an in-memory and JSON-file index built from program logs (free public RPC).
- Never holds user funds. Keypair from the `RELAYER_KEYPAIR` env var (path or JSON array). Rate limits per IP.

## 10. Browser SDK (`assets/js/pool/`) and UI (`private.html`)

- ES modules, no build step at runtime; third-party libraries pre-bundled into `assets/vendor/` (snarkjs, poseidon, tweetnacl) with the bundling script committed.
- Modules: `keys.js` (§2), `note.js` (commitments, nullifiers, encryption §6), `merkle.js` (§3), `prover.js` (Web Worker running snarkjs with `assets/zk/transaction.wasm` and `transaction_final.zkey`), `encode.js` (§5, §7, instruction data), `client.js` (deposit/send/withdraw/swap flows, balance scan via the relayer index).
- UI tabs: Shield, Send privately, Unshield, Swap (mainnet only; disabled on devnet). Shows the private balance per token, fees before signing, and progress while proving.
- Cluster from `CONFIG.POOL_CLUSTER` (default `devnet`). Shows a permanent "Unaudited devnet preview" banner unless the cluster is mainnet **and** `CONFIG.POOL_AUDITED === true`.
- Sanctions: the depositor and the withdrawal recipient are checked against the bundled OFAC list (`assets/js/pool/sanctions.js`, refreshed by a script).

## 11. Trusted setup

- Dev: a locally generated Powers of Tau (2^16) plus a single-contributor phase 2. **Unsafe for real funds.** Marked as such in the files and UI.
- Production: Perpetual Powers of Tau or Hermez ptau, plus a public multi-party phase 2 ceremony with an attested final beacon.
