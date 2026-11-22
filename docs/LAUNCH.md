# Launch checklist

## Phase 1: Solana swap app (this release)

Must do before sharing the link:

- [ ] Nothing to sign up for: Jupiter and the RPC endpoints are free and keyless by default. Leave them as they are.
- [ ] Decide on revenue: set up the Jupiter referral account and token accounts for SOL, USDC and USDT, or leave `REFERRAL_ACCOUNT` empty. Keep the treasury in a multisig (for example Squads).
- [ ] Buy the domain, deploy to a free tier of Vercel, Netlify or Cloudflare Pages, and check the security headers are served (`curl -I https://yourdomain`).
- [ ] Do three real swaps with small amounts from Phantom, Solflare and a mobile wallet's in-app browser: SOL→USDC, USDC→USDT, USDT→SOL, and one "send to a different address".
- [ ] Legal review: terms of use, whether an interface fee changes your obligations where you operate, and whether to geo-block restricted regions at the host or CDN. `risks.html` is a plain-language disclosure, not legal terms.
- [ ] Decide whether the landing headline ("Trade in private") should wait for Phase 2. The page labels every feature as Live or Phase N, but retail users may read only the headline.

Nice to have:

- [ ] Free analytics if wanted (Cloudflare Web Analytics, or your host's built-in analytics); add its host to the CSP `script-src` and `connect-src`.
- [ ] Status monitoring on the domain and on Jupiter's status page.
- [ ] Support channel linked in the footer (Discord, Telegram or email).

## Phase 2: private pool (not started in this repo)

Needs, in order: circuit design (note tiers, Merkle depth, nullifiers), Anchor program with Groth16 verifier, relayer, in-browser prover, two independent audits of program and circuits, timelocked multisig upgrade authority, sanctions screening on deposits, and legal review specific to privacy tooling. None of this should face retail users before the audits.

## Phase 3: cross-chain exits

Pick a solver or intent network per chain (for example deBridge DLN, Mayan, Relay), integrate quotes and status tracking, and handle refunds on failed fills.
