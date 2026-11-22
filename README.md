# DankSwap

Swap SOL, USDC and USDT on Solana at the best aggregated price. Non-custodial: the user's wallet signs every trade, and DankSwap never holds keys or funds.

This is Phase 1 from the project outline: a working swap app for real users on Solana mainnet. The shielded pool (Phase 2), cross-chain exits (Phase 3) and view keys (Phase 4) are shown on the landing page as roadmap items and are not live.

## Phase 2: private pool (devnet preview)

`private.html` is a shielded pool for SOL, USDC and USDT. **Unaudited, devnet only: do not use real funds.**

- **Shield:** deposit and get a private note.
- **Send privately:** pay another user's `dank…` address.
- **Unshield:** withdraw to any Solana address. A relayer pays gas and takes a fee from the amount.
- **Private swap:** swap inside the pool. The program side is verified on a real SVM; the Jupiter route integration is in progress.

| Part | Where | Docs |
|---|---|---|
| Spec (encodings, flows) | `docs/PHASE2_SPEC.md` | |
| ZK circuit (Circom, Groth16) | `circuits/` | `circuits/README.md` |
| Solana program (Anchor) | `programs/` | `programs/README.md` |
| Relayer and index (Node) | `relayer/` | `relayer/README.md` |
| Browser SDK and prover | `assets/js/pool/`, `assets/zk/` | |
| Internal review and open gaps | `docs/PHASE2_AUDIT.md` | |

Mainnet requires independent audits, a public trusted-setup ceremony and the critical items in `docs/PHASE2_AUDIT.md`.

`npm run test:all` runs every suite (site, SDK, circuits, relayer, program host tests, browser tests). CI runs the same suites, plus the program's SBF build and on-chain tests (`.github/workflows/`).

## What's in it

| Path | What it is |
|---|---|
| `index.html` | Landing page (from the Phase 0 design), with live/roadmap status on every feature |
| `app.html` | The swap app |
| `risks.html` | Risk disclosure for users |
| `assets/js/config.js` | **All settings**: API endpoints, fee account, tokens |
| `assets/js/app.js` | Swap UI and flow |
| `assets/js/api.js` | Jupiter Swap API V2 (`/order`, `/execute`) and Solana RPC balance reads |
| `assets/js/wallet.js` | Wallet Standard client plus older injected wallets (Phantom, Solflare, Backpack, Trust, Coinbase, OKX, Bitget, Exodus), mobile deep links |
| `assets/js/compat.js` | Runs first: polyfills, embedded-mode flag, clear message on old browsers or `file://` |
| `assets/vendor/solana-web3.iife.min.js` | web3.js 1.98.4 (MIT), loaded only when an older injected wallet is used |
| `embed.js` | One-line widget to put the swap on any other website |
| `manifest.webmanifest`, `assets/*.png` | Add-to-home-screen icons and link-preview image |
| `assets/js/lib.js` | Pure helpers: amount math, address validation, error messages |
| `wrangler.jsonc`, `.assetsignore`, `.github/workflows/deploy-cloudflare.yml` | Cloudflare deployment (dashboard, GitHub Actions or CLI) |
| `vercel.json`, `_headers`, `.htaccess`, `web.config`, `firebase.json`, `docs/nginx.conf`, `.nojekyll` | Security headers for Vercel, Netlify, Cloudflare Pages, Apache/cPanel, IIS/Azure, Firebase, Nginx, GitHub Pages |
| `tests/` | Unit tests, end-to-end browser test, local server |

No build step, no dependencies, no backend, and **only free, keyless APIs**: no sign-ups, no API keys, no monthly bills. Deploy the folder as static files on any free host.

## How a swap works

1. The user types an amount. The app calls Jupiter `GET /swap/v2/order`. Jupiter's routers (Metis on-chain routing, JupiterZ RFQ market makers, DFlow, OKX) compete for the best price.
2. With a wallet connected, the order includes a ready-to-sign transaction. The app shows rate, minimum received, price impact, total fee, network fee (or "Sponsored" for gasless swaps), slippage and route.
3. On **Swap**, the wallet signs the raw transaction bytes (Wallet Standard `solana:signTransaction`). Quotes older than 25 s are refreshed first; if the refreshed price is more than 0.5% worse, the user is asked to review it.
4. The signed transaction goes to `POST /swap/v2/execute`, which lands it and reports the result. The app shows a toast with a Solscan link, saves the swap to local history and refreshes balances.

Safety rails: slippage limit on every trade (Auto by default), a warning above 1% price impact and a two-tap confirmation above 5%, a SOL reserve kept back on **Max**, recipient address validation, and readable messages for every Jupiter error code.

## Free APIs used

| Service | Used for | Cost |
|---|---|---|
| Jupiter Swap API V2 (keyless) | Quotes, routing, transaction landing, gasless swaps | Free, no key |
| PublicNode / api.mainnet-beta.solana.com / dRPC public RPC | Wallet balances | Free, no key |
| Google Fonts | Inter and JetBrains Mono | Free |
| Solscan | Transaction links | Free |

Cost to run: a domain name, plus a free static host (Vercel, Netlify, Cloudflare Pages or GitHub Pages).

## Configuration

Edit `assets/js/config.js` before deploying. The defaults work as-is.

| Setting | Default | Notes |
|---|---|---|
| `JUPITER_API` | Jupiter Swap API V2, keyless | 30 requests/min per caller. Calls come from each visitor's browser, so each visitor has their own allowance. The app spaces quote requests 2.1 s apart and retries automatically on a 429. Do not add a free-tier key: free keys are capped at 1 request/s for the whole organisation, shared by every visitor. |
| `RPC_URLS` | PublicNode, Solana Foundation, dRPC public endpoints | Free, keyless, used only for balances. Tried in order; the first that works is remembered. If all fail, balances show "—" and swaps still work. |
| `REFERRAL_ACCOUNT` | empty | Empty means DankSwap charges nothing. See Revenue below. |
| `REFERRAL_FEE_BPS` | 50 | Jupiter accepts 50–255 bps. |

### Revenue

DankSwap earns through Jupiter's referral program:

1. Go to [referral.jup.ag](https://referral.jup.ag), connect the treasury wallet (ideally a multisig) and create a referral account under the **Jupiter Ultra** referral project.
2. Create referral token accounts for SOL (wSOL), USDC and USDT. If the account for a fee mint is missing, Jupiter still fills the swap but skips your fee.
3. Put the referral account address in `REFERRAL_ACCOUNT`.

Jupiter keeps 20% of integrator fees, so 50 bps nets 40 bps. Jupiter also charges its own fee by pair; the app shows the combined total per quote.

**Note:** the outline's proposed schedule (0.30% swaps, 0.10% stable-to-stable) cannot be matched on this path, because Jupiter's referral fee floor is 0.50%. Options: accept 0.50% for now, charge nothing until the pool launches, or move to the `/build` path with your own fee instruction and your own transaction sending (more work, Metis routing only).

## Run locally

```bash
node tests/serve.mjs 8080      # then open http://127.0.0.1:8080/
```

Wallet extensions work on `http://127.0.0.1`. Use a small amount for your first real swap.

## Tests

```bash
npm test          # unit tests (node --test), no install needed
npm run e2e       # browser tests; need Playwright with Chromium installed
```

`tests/compat.e2e.mjs` covers compatibility: an older injected wallet signing a real v0 transaction, the embed widget on another origin (auto-resize, new-tab fallback, landing page refusing to be framed), iPhone, iPad, Pixel and Galaxy layouts (no sideways scroll, 16px inputs so iOS doesn't zoom, back button closes dialogs), the old-browser notice, opening from disk, and the manifest and preview images.

The main e2e test drives the real app in Chromium with a mock Wallet Standard wallet and mocked Jupiter and RPC responses: quoting, connecting, swapping, insufficient balance, Max, recipient address, wallet rejection, high price impact confirmation, flip, slippage, silent reconnect, disconnect, mobile layout and mobile deep links.

## Deploy, phones and embedding

Any static host works; config for every common host is included. See [docs/HOSTING.md](docs/HOSTING.md) for per-host steps, supported phones and browsers, and how to put the swap on WordPress, Wix, Shopify, Squarespace, Webflow, Notion and other sites.

See [docs/LAUNCH.md](docs/LAUNCH.md) for the pre-launch checklist.
