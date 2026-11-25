# Phase 2 internal review

**What this is:** an internal code review and test pass done while building Phase 2.
**What it is not:** an independent security audit. Real funds need two independent audits (circuits and program), a public trusted-setup ceremony, and the fixes below.

Status: **devnet preview**. Shield, private send, unshield via a relayer and private swap are complete and tested. The swap program side is verified on a real SVM with a mock swap program. The Jupiter route path is tested against realistic mocks only: Jupiter is mainnet-only and unreachable from the build sandbox.

## What was verified, and how

| Area | How | Result |
|---|---|---|
| Circuit soundness | 27 tests with real proofs: valid deposit, transfer, withdraw and swap; rejection of inflation, wrong mint, duplicate nullifier, wrong or fake root, tampered path, wrong path index or key, swap amount or commitment mismatch, swap into the same mint, 64-bit overflow and field wrap | pass |
| Cross-component encoding | Fixtures shared by circuits, program and SDK: Poseidon, zero hashes, Merkle roots, extDataHash, mintField, public inputs, proof bytes | identical in JS (circuits), Rust (program) and browser SDK |
| Groth16 on-chain verifier | Host test: all 4 fixture proofs verify with the generated key; each of the 11 inputs tampered, an un-negated proof_a, a wrong fee and a non-canonical nullifier (n+p) are all rejected | pass |
| Program on a real SVM | CI (LiteSVM, SBF build): init (upgrade-authority gated), SOL and SPL pools, deposit, double spend rejected, private send, deposits paused while withdrawal still pays, tampered recipient rejected, deposit limit, SOL→USDC `transact_swap` via mock swap (low output rejected, surplus to relayer) | pass; ~194k CU deposit, ~197k private send, ~203k withdraw |
| Browser proving | Playwright: real proofs in a Web Worker, checked against the program's public-input layout; iPhone layout | pass; ~3.5–4.9 s per proof in headless Chromium |
| Relayer | 8 tests with mocked RPC: request validation, fee floor, sanctions screening, exact rebuild of the transaction, simulate before send | pass |

## Issues found and fixed during the review

1. **SOL-pool swap failed on a real SVM** (found by CI, not by host tests). The program moved lamports by editing the pool account directly, then made CPIs, which the runtime rejects ("unbalanced instruction"). **Fix:** native SOL now sits in a data-less, system-owned vault PDA `["vault", wSOL]`, and every SOL movement is a signed System transfer. Re-verified in CI.
2. **Base58 decoder missing the letter `L`** (site code, found by the SDK workstream). Valid Solana addresses containing `L` were rejected by the swap page's recipient check. **Fix:** corrected the alphabet and added a regression test.
3. **CSP for the prover.** The proof worker compiles WebAssembly. Every host config now gives `private.html` and `prover.worker.js` a policy that allows `'wasm-unsafe-eval'` and nothing broader.
4. **Front-running the first `initialize`.** Prevented: `initialize` requires the program's upgrade authority.

## Design properties checked

- No instruction moves pool funds without a valid proof. The admin can only pause deposits (and swaps into a pool) and set deposit limits; **withdrawals cannot be paused**.
- Proofs bind recipient, relayer, fee and amounts (extDataHash), so a relayer or front-runner cannot redirect a withdrawal. A copied deposit proof only gifts the note to its owner.
- Double spends: nullifier PDAs (`init`), plus a range check so a nullifier can't be replayed in a different field encoding.
- Swaps: the CPI target is fixed in config; the escrow signs only for itself; output must be at least the proven `swapAmount`; the escrow's token accounts must keep their owner and mint and gain no delegate or close authority; surplus goes to the relayer.
- The relayer only signs transactions it builds itself from its config and the proven data. It never signs user-supplied transactions. Request bodies are capped at 16 KB; rate limits apply per IP.
- Shielded keys are derived from a wallet signature and never stored by the page.

## Open gaps (must address before mainnet)

**Critical**
1. **Trusted setup is development-only** (single contributor). Anyone with the toxic waste could forge proofs and drain the pool. *Tooling built and tested:* `circuits/scripts/ceremony.mjs` runs a public multi-party phase 2 with a verifiable transcript (circuits/README.md). **Still to do: run it with independent contributors** on a public Powers of Tau.
2. **No independent audits** of the circuits, program, SDK or relayer.
3. **Phishing risk in key derivation.** *Mechanism built:* with `SITE_DOMAIN` set, unlocking signs a fixed Sign-In-With-Solana message for that domain, so SIWS-aware wallets warn on phishing sites, and the page refuses to unlock on another host. **Still to do: choose the domain and set it once, before any real deposit** (it changes every user's keys).

**High**
4. **Single relayer.** It can censor withdrawals (it cannot steal). *Mitigated:* the Unshield tab has a self-relay option (the user's wallet pays gas, with a linkability warning), suggested automatically when the relayer fails. Also fixed: several relayers can be configured (`RELAYER_URLS`). The page uses the first healthy one and, if it is unreachable or failing, switches and re-proves automatically; refusals are not retried. Remaining: actually run more than one independent relayer.
5. **Privacy at launch.** A small anonymity set, unique amounts and timing make links easy. *Mitigated in the UI:* a "Privacy tips" section (wait, round amounts, fresh destination, prefer the relayer). The anonymity set itself only grows with use.
6. **Relayer fees vs SOL price.** *Fixed:* token minimums now follow the live SOL price (Jupiter Price API, `DYNAMIC_FEES`, on by default on mainnet), with the configured values as the floor.
7. **Program id is a placeholder.** Deploying with a new program id changes every PDA and the escrow address bound into the swap fixture proof, so fixtures must be regenerated after the first deploy (programs/README.md).

**Medium**
8. **Balance split across many notes.** *Fixed:* when a transaction needs more than 2 notes, the page offers "Combine my notes" (a private send to self that merges the two largest notes, through the relayer). Tested with real proofs.
9. **Indexing depends on the free public RPC.** Slow or rate-limited scans hurt the UX. The relayer index helps, but users trust it for availability (not for correctness: notes are verified locally).
10. **Tree capacity is 2^20 notes per pool.** When a pool fills, deposits stop (`TreeFull`) and a migration path is needed.
11. **`swap_program` is set once at `initialize`** with no setter. Devnet (mock) and mainnet (Jupiter) need separate deployments; a switch means redeploying.
12. **The sanctions list comes from a third-party mirror of the OFAC SDN list** (the official download is blocked from the build sandbox), and it currently lists 4 SOL addresses. Use the official source or a screening API in production.

**Low**
13. Jupiter routes with many accounts may not fit one transaction even with lookup tables. This is unverified until mainnet.
14. Phone proving time has not been measured (expect 5–15 s on mid-range phones).

## Private swap

- **Program:** passes on a real SVM (LiteSVM, SOL→USDC via mock swap, low output rejected, surplus to relayer).
- **SDK and relayer:** `GET /swap/quote` gets a Jupiter `/build` route for the escrow PDA. The user proves a swap note worth `minOut`. At relay time, the relayer rebuilds the route and refuses to proceed unless both `outAmount` and `otherAmountThreshold` cover `swapAmount`, so a bad quote fails safely before signing. Route setup is limited to creating token accounts for the escrow or relayer, and no foreign signers are allowed.
- **Tests:** a real in-browser swap proof (~3.5 s), the swap note found in the output pool, transaction size 1,204 bytes with lookup tables (mock route).

Unverified until mainnet:
- whether Jupiter `/build` accepts an off-curve PDA as `taker`;
- real route sizes and compute (the relayer retries with fewer accounts if a transaction is too large);
- live rate limits.

The relayer pays one-time rent for escrow token accounts; the rent for a swap's wSOL output is returned to it.
