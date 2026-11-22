# Phase 2 internal review

**What this is:** an internal code review and test pass done while building Phase 2.
**What it is not:** an independent security audit. Real funds need two independent audits (circuits and program), a public trusted-setup ceremony, and the fixes below.

Status: **devnet preview**. Shield, private send and unshield via a relayer are complete and tested. Private swap is verified on-chain against a mock swap program; Jupiter routing is tracked separately (see "Private swap").

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
1. **Trusted setup is development-only** (single contributor). Anyone with the toxic waste could forge proofs and drain the pool. Run a public multi-party phase 2 on a public Powers of Tau (circuits/README.md).
2. **No independent audits** of the circuits, program, SDK or relayer.
3. **Phishing risk in key derivation.** The unlock message is fixed and domain-free, so a phishing site that gets the user to sign the same message learns their shielded spending key. Before launch, add the official domain and a warning to the message (spec §2). This must happen before any real deposit, since changing it changes every user's keys.

**High**
4. **Single relayer.** It can censor withdrawals (it cannot steal). Offer a self-relay fallback in the UI (the user's own wallet pays gas, which links that wallet) and support multiple relayers.
5. **Privacy at launch.** A small anonymity set, unique amounts and timing make links easy. The UI should warn about this and suggest waiting, using round amounts and splitting.
6. **Relayer fees are fixed in token units** (0.5 USDC/USDT minimum). If SOL rises far, token withdrawals that also create a token account could run at a loss. Price fees from a live SOL price.
7. **Program id is a placeholder.** Deploying with a new program id changes every PDA and the escrow address bound into the swap fixture proof, so fixtures must be regenerated after the first deploy (programs/README.md).

**Medium**
8. **Balance split across many notes.** More than 2 notes per transaction needs a manual "send to self" first. Add automatic consolidation.
9. **Indexing depends on the free public RPC.** Slow or rate-limited scans hurt the UX. The relayer index helps, but users trust it for availability (not for correctness: notes are verified locally).
10. **Tree capacity is 2^20 notes per pool.** When a pool fills, deposits stop (`TreeFull`) and a migration path is needed.
11. **`swap_program` is set once at `initialize`** with no setter. Devnet (mock) and mainnet (Jupiter) need separate deployments; a switch means redeploying.
12. **The sanctions list comes from a third-party mirror of the OFAC SDN list** (the official download is blocked from the build sandbox), and it currently lists 4 SOL addresses. Use the official source or a screening API in production.

**Low**
13. Jupiter routes with many accounts may not fit one transaction even with lookup tables. This is unverified until mainnet.
14. Phone proving time has not been measured (expect 5–15 s on mid-range phones).

## Private swap

The program side is done and passes on a real SVM with a mock swap program. The client and relayer integration with Jupiter (quoting, building the route for the escrow, lookup tables) is being finished separately; see the status in the README. On devnet, swaps can only use the mock route, because Jupiter is mainnet-only.
