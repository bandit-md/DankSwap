# DankSwap Phase 2 circuits

> **DEV TRUSTED SETUP: UNSAFE FOR REAL FUNDS.**
> The committed `assets/zk/transaction_final.zkey`, `assets/zk/verification_key.json` and
> `programs/dankswap-pool/src/verifying_key.rs` come from a Powers of Tau and a phase 2 that
> were generated on one machine by one contributor (`npm run build`). Whoever ran it could
> forge proofs and drain a pool. The circuits are also **unaudited**. Use on devnet only.

Implements `Transaction(levels=20, nIns=2, nOuts=2)` from [`docs/PHASE2_SPEC.md`](../docs/PHASE2_SPEC.md) §1-5, §7, §11.

## Layout

| Path | What |
|---|---|
| `transaction.circom` | `Transaction(levels, nIns, nOuts)` and `component main = Transaction(20, 2, 2)` with the 11 public signals in spec §4 order |
| `keypair.circom` | `Keypair` (pubKey = Poseidon(privKey)), `Signature` (Poseidon(privKey, commitment, pathIndex)) |
| `merkleproof.circom` | `MerkleProof(levels)`: leaf index decomposed into `levels` bits (LSB = bottom), Poseidon(left, right) |
| `lib/` | Node ESM helpers: `field.js` (BN254 constants, BE bytes, base58), `poseidon.js`, `keys.js` (§2 privKey/pubKey, `mintField`), `note.js` (commitment, signature, nullifier), `merkle.js` (incremental depth-20 tree, paths), `extdata.js` (§5), `encode.js` (§7 proof / public input / VK encodings), `witness.js` (`buildWitnessInput`), `prover.js` (snarkjs prove/verify), `scenario.js` (deterministic deposit -> transfer -> withdraw -> swap sequence) |
| `scripts/build.mjs` | compile + DEV ptau + groth16 setup + contribution + beacon + VK export + copy to `assets/zk/` + Rust VK |
| `scripts/vk-to-rust.mjs` | `verification_key.json` -> `programs/dankswap-pool/src/verifying_key.rs` (groth16-solana 0.2 `Groth16Verifyingkey`) |
| `scripts/gen-fixtures.mjs` | writes `fixtures/*.json` (needs a build for `proofs.json`) |
| `fixtures/` | cross-check vectors for the program and the SDK (see below) |
| `test/` | `node --test`: helper unit tests and circuit tests (valid proofs + soundness failures) |

## Commands

```sh
cd circuits
npm install
npm run build        # compile, DEV setup (2^16 ptau, cached in build/), copy artifacts, regenerate verifying_key.rs
npm run fixtures     # regenerate fixtures/*.json, including 4 real proofs
npm test             # unit + circuit tests
```

`npm run build -- --fresh-ptau` regenerates the cached Powers of Tau; `--verify` also runs `snarkjs zkey verify`;
`--skip-compile` reuses `build/transaction.r1cs`. `POT_POWER=15 npm run build` changes the ptau size.

**Rebuilding changes the proving/verifying keys.** After `npm run build` you must also run `npm run fixtures`,
and the program must be rebuilt with the new `verifying_key.rs`. Old proofs and fixtures stop verifying.

## Circuit summary (spec §4)

Public, in declaration order: `root, publicAmount, extDataHash, mintField, inputNullifier[2], outputCommitment[2], swapMintField, swapAmount, swapCommitment`.

- Inputs: `inPubkey = Poseidon(inPrivateKey)`, `commitment = Poseidon(amount, pubKey, blinding, mintField)`,
  `signature = Poseidon(privKey, commitment, pathIndex)`, `nullifier = Poseidon(commitment, pathIndex, signature)` == public.
  Root check via `ForceEqualIfEnabled` with `enabled = 1 - IsZero(inAmount)`. `inPathIndices` must be `< 2^20`.
- Outputs: `outputCommitment[j] = Poseidon(outAmount, outPubkey, outBlinding, mintField)`.
- All input, output and swap amounts: `Num2Bits(64)`.
- Nullifiers distinct (`IsEqual(...) === 0`).
- `sum(inAmount) + publicAmount === sum(outAmount)` in the field.
- Swap: `IsZero(swapAmount)`; zero => `swapCommitment === 0`; non-zero => `swapCommitment === Poseidon(swapAmount, swapPubkey, swapBlinding, swapMintField)` and `swapMintField != mintField`.
- `extDataHash` bound with a square.

Compiled with `--O2` (circom 2.2.2 via circom2 0.2.22): **13016 constraints**, 11 public inputs, 55 private witness inputs. Minimum ptau power 14; the dev setup uses 2^16 per spec §11. Full build takes ~17 min on 4 CPUs, almost all of it `powersoftau prepare phase2` (cached afterwards). Proving in Node (snarkjs 0.7.5, 4 CPUs): ~1.2-2.1 s per proof.

## Encodings (spec §7, groth16-solana 0.2)

- `proofA` = `x || (q - y)` (negated G1), `proofB` = `x.c1 || x.c0 || y.c1 || y.c0`, `proofC` = `x || y`; all 32-byte BE.
- Public inputs: 11 x 32-byte BE in §4 order. `publicAmount = (extAmount - fee) mod p`.
- VK: G1 `x || y`; G2 `x.c1 || x.c0 || y.c1 || y.c0` (same as groth16-solana's `parse_vk_to_rust.js`). `nr_pubinputs: 11`, `vk_ic` has 12 entries.

## Fixtures

| File | Content |
|---|---|
| `poseidon.json` | Poseidon vectors with 1, 2, 3, 4 inputs |
| `zeros.json` | `zeros[0..20]`, empty root |
| `merkle.json` | 3 pair inserts (6 leaves) with root after each, the same as single inserts, and a path for leaf 3 |
| `extdata.json` | extData cases (base58 pubkeys, i64/u64 as decimal strings, 87-byte hex blobs), preimage hex and `extDataHash` (decimal + hex) |
| `mint.json` | `mintField` for wSOL, USDC, USDT |
| `proofs.json` | 4 real proofs (deposit, transfer, withdraw, swap) on one SOL pool tree: snarkjs public signals, 11 public inputs (hex), `proofA/B/C` (hex, groth16-solana encoding), extData, root, leaves before/after, SHA-256 of the VK they verify against |

All proofs use the SOL pool, so recipient/relayer are system accounts. The swap fixture's recipient is the SOL pool escrow PDA `5LXAZN9Ja6xmjjh6hWmaPckciMNDGNc12JGXs9tnQHQz` (seeds `["escrow", pool]`, pool = `["pool", wSOL]`) for the placeholder program id `FtV5X43qGc37tjUkbzxoexyg1A4oFUv9wE42d3Ukhtc6`, recorded as `programId` in `proofs.json`. If the program id changes, update `lib/scenario.js` and run `npm run fixtures`.

## Production trusted setup (spec §11)

Do **not** ship the dev keys. Before mainnet:

1. **Freeze and audit the circuit.** Independent audit of `transaction.circom`, `keypair.circom`, `merkleproof.circom`
   (and the circomlib version). Tag the commit; record the `transaction.r1cs` SHA-256 and the circom version
   (`circom2` npm 0.2.22 = circom 2.2.2, `--O2`).
2. **Phase 1 (universal).** Use a public Powers of Tau, e.g. the Perpetual Powers of Tau / Hermez
   `powersOfTau28_hez_final_16.ptau` (or larger). Download it from the official source and check its published
   Blake2b hash: `snarkjs powersoftau verify powersOfTau28_hez_final_16.ptau`.
3. **Phase 2 (circuit-specific), public multi-party ceremony.**
   - Coordinator: `snarkjs groth16 setup transaction.r1cs pot_final.ptau transaction_0000.zkey`, publish it and its hash.
   - Each contributor in turn, on their own machine with their own entropy:
     `snarkjs zkey contribute transaction_<n-1>.zkey transaction_<n>.zkey --name="<who>"`, publishes the
     contribution hash it prints, uploads the new zkey, and destroys their entropy. Aim for many independent
     contributors (at least a few unaffiliated people/orgs); the setup is safe if any one of them is honest.
   - Anyone: `snarkjs zkey verify transaction.r1cs pot_final.ptau transaction_<n>.zkey` after each step.
4. **Final beacon.** Pre-announce a public randomness source that nobody controls at announcement time (e.g. a
   specific future Bitcoin block hash or drand round), then
   `snarkjs zkey beacon transaction_<n>.zkey transaction_final.zkey <beaconHex> 10 -n="Final beacon"` and verify again.
5. **Export and publish.** `snarkjs zkey export verificationkey transaction_final.zkey verification_key.json`,
   `node scripts/vk-to-rust.mjs verification_key.json`, copy the wasm/zkey/vk into `assets/zk/`. Publish the full
   transcript (all intermediate zkeys or their hashes, attestations, beacon) so anyone can re-run `zkey verify`.
6. Rebuild and redeploy the program with the new `verifying_key.rs`, regenerate fixtures, and then remove the
   "dev setup" warnings.
