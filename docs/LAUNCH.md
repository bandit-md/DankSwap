# Launch checklist

## Phase 1: Solana swap app (this release)

Must do before sharing the link:

- [ ] Nothing to sign up for: Jupiter and the RPC endpoints are free and keyless by default. Leave them as they are.
- [ ] Decide on revenue: set up the Jupiter referral account and token accounts for SOL, USDC and USDT, or leave `REFERRAL_ACCOUNT` empty. Keep the treasury in a multisig (for example Squads).
- [ ] Buy the domain, deploy to a free tier of Vercel, Netlify or Cloudflare Pages, and check the security headers are served (`curl -I https://yourdomain`).
- [ ] Change `og:image` and `twitter:image` in the three HTML pages to the absolute URL on your domain (see docs/HOSTING.md, Link previews).
- [ ] Do three real swaps with small amounts from Phantom, Solflare, a mobile wallet's in-app browser (iPhone and Android), and the embed widget on a test page: SOL→USDC, USDC→USDT, USDT→SOL, and one "send to a different address".
- [ ] Legal review: terms of use, whether an interface fee changes your obligations where you operate, and whether to geo-block restricted regions at the host or CDN. `risks.html` is a plain-language disclosure, not legal terms.
- [ ] Decide whether the landing headline ("Trade in private") should wait for Phase 2. The page labels every feature as Live or Phase N, but retail users may read only the headline.

Nice to have:

- [ ] Free analytics if wanted (Cloudflare Web Analytics, or your host's built-in analytics); add its host to the CSP `script-src` and `connect-src`.
- [ ] Status monitoring on the domain and on Jupiter's status page.
- [ ] Support channel linked in the footer (Discord, Telegram or email).

## Phase 2: private pool (devnet preview built)

Devnet:
- [ ] Generate the program keypair, set its address in `declare_id!` and `Anchor.toml`, regenerate the circuit fixtures (`cd circuits && npm run fixtures`), and run the CI deploy job (secrets `DEVNET_DEPLOYER_KEYPAIR`, `DEVNET_PROGRAM_KEYPAIR`).
- [ ] Run `initialize` and `initialize_pool` for SOL and a devnet USDC mint. Set `POOL_PROGRAM_ID` and the mints in `assets/js/pool/config.js`.
- [ ] Deploy the relayer (`relayer/README.md`), fund it with devnet SOL, create its lookup table and its fee token accounts, and set `RELAYER_URL`.

Before mainnet (see `docs/PHASE2_AUDIT.md`):
- [ ] Public multi-party trusted setup.
- [ ] Two independent audits of circuits and program, plus a review of the SDK and relayer.
- [ ] Set `SITE_DOMAIN` in `assets/js/pool/config.js` to the official host name (phishing protection: wallets warn on other sites). Set it once, before any real deposit; changing it later changes every user's keys.
- [ ] Self-relay fallback and a second relayer.
- [ ] Move the upgrade authority to a timelocked multisig, then freeze it.
- [ ] Legal review specific to privacy tooling; production sanctions screening.

## Phase 3: cross-chain exits

Pick a solver or intent network per chain (for example deBridge DLN, Mayan, Relay), integrate quotes and status tracking, and handle refunds on failed fills.
