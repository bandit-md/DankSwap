# DankSwap

Swap SOL, USDC and USDT on Solana at the best aggregated price. Non-custodial: the user's wallet signs every trade, and DankSwap never holds keys or funds.

This is Phase 1 from the project outline: a working swap app for real users on Solana mainnet. The shielded pool (Phase 2), cross-chain exits (Phase 3) and view keys (Phase 4) are shown on the landing page as roadmap items and are not live.

## What's in it

| Path | What it is |
|---|---|
| `index.html` | Landing page (from the Phase 0 design), with live/roadmap status on every feature |
| `app.html` | The swap app |
| `risks.html` | Risk disclosure for users |
| `assets/js/config.js` | **All settings**: API key, RPC, fee account, tokens |
| `assets/js/app.js` | Swap UI and flow |
| `assets/js/api.js` | Jupiter Swap API V2 (`/order`, `/execute`) and Solana RPC balance reads |
| `assets/js/wallet.js` | Wallet Standard client (Phantom, Solflare, Backpack and others), mobile deep links |
| `assets/js/lib.js` | Pure helpers: amount math, address validation, error messages |
| `vercel.json`, `_headers` | Security headers (CSP, no framing, HSTS) for Vercel / Netlify / Cloudflare Pages |
| `tests/` | Unit tests, end-to-end browser test, local server |

No build step, no dependencies, no backend. Deploy the folder as static files.

## How a swap works

1. The user types an amount. The app calls Jupiter `GET /swap/v2/order`. Jupiter's routers (Metis on-chain routing, JupiterZ RFQ market makers, DFlow, OKX) compete for the best price.
2. With a wallet connected, the order includes a ready-to-sign transaction. The app shows rate, minimum received, price impact, total fee, network fee (or "Sponsored" for gasless swaps), slippage and route.
3. On **Swap**, the wallet signs the raw transaction bytes (Wallet Standard `solana:signTransaction`). Quotes older than 25 s are refreshed first; if the refreshed price is more than 0.5% worse, the user is asked to review it.
4. The signed transaction goes to `POST /swap/v2/execute`, which lands it and reports the result. The app shows a toast with a Solscan link, saves the swap to local history and refreshes balances.

Safety rails: slippage limit on every trade (Auto by default), a warning above 1% price impact and a two-tap confirmation above 5%, a SOL reserve kept back on **Max**, recipient address validation, and readable messages for every Jupiter error code.

## Configuration

Edit `assets/js/config.js` before deploying.

| Setting | Default | Notes |
|---|---|---|
| `JUPITER_API_KEY` | empty | Keyless access is about 1 request per 2 s per user IP. That works, but quotes feel slow under load. Get a free key at [developers.jup.ag/portal](https://developers.jup.ag/portal). The key is visible in the browser, which is how Jupiter keys are meant to be used from frontends; restrict it in the portal if offered. |
| `RPC_URL` | public mainnet | Used only for balances. The public endpoint rate-limits hard; use Helius, Triton, QuickNode or similar. If balances fail to load, swaps still work. |
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
npm run e2e       # browser test; needs Playwright with Chromium installed
```

The e2e test drives the real app in Chromium with a mock Wallet Standard wallet and mocked Jupiter and RPC responses: quoting, connecting, swapping, insufficient balance, Max, recipient address, wallet rejection, high price impact confirmation, flip, slippage, silent reconnect, disconnect, mobile layout and mobile deep links.

## Deploy

Any static host works. Vercel (`vercel.json`) and Netlify or Cloudflare Pages (`_headers`) pick up the security headers automatically. On other hosts, copy the headers from `_headers`. Serve over HTTPS on your own domain; never let the app be framed.

See [docs/LAUNCH.md](docs/LAUNCH.md) for the pre-launch checklist.
