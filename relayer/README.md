# DankSwap private pool relayer

> **Unaudited. Devnet first.** It refuses mainnet unless `RELAYER_ALLOW_MAINNET=1`, and it should
> not be set before the circuits and program are audited and a multi-party trusted setup is done.

A small Node 20+ service (plain `node:http`, one dependency: `@solana/web3.js`) that implements
docs/PHASE2_SPEC.md §9:

- **Relays** private sends, unshields and private swaps. The user's browser builds and proves the transaction; the
  relayer checks the fee and the recipient, rebuilds the `transact` instruction byte for byte,
  **simulates** it, signs it as fee payer and sends it. The user's wallet never appears on-chain.
  The relayer never holds user funds: the pool pays its fee only if the proof verifies on-chain.
- **Indexes** commitments. It pages the program's signatures over plain RPC
  (`getSignaturesForAddress` + `getTransaction`), decodes Anchor `NewCommitment` events from the
  `Program data:` log lines (only lines logged by the pool program itself), and serves them so
  wallets can find their notes and build Merkle paths. The index is kept in memory and in a JSON file.

It imports the browser SDK from `../assets/js/pool/` (encodings, Merkle tree, accounts, fee schedule,
sanctions list), so it must run from a checkout of the whole repository.

## API

| Method | Path | Response |
|---|---|---|
| GET | `/info` | `{ relayer, feeBps, minFeeLamports: {SOL, USDC, USDT}, createAtaFee: {USDC, USDT}, cluster, programId, pools: [{symbol, mint}], swap: { enabled, route, program, slippageBps, swapFeeBps, quoteTtlMs, reason } }` |
| POST | `/relay` | body `{ instruction: "transact" \| "transact_swap", pool: <mint>, args, extData }` (below) → `{ signature }` (swaps also `outAmount`, `setupSignature`) |
| GET | `/swap/quote?inputMint&outputMint&amount` | private swap quote (below) |
| GET | `/commitments?pool=<mint>&from=<index>` | `{ items: [{ index, commitment, encryptedOutput }], nextIndex, root }`, at most 1000 items |
| GET | `/health` | `{ ok, cluster, uptimeSec, indexer: { lastSync, lastSignature, pools } }` |

`commitment` and `root` are 32-byte big-endian hex; `encryptedOutput` is base64 (87 bytes). Only the
gap-free prefix of each tree is served, and `root` is the root of exactly those `nextIndex` leaves.

`POST /relay` body (all byte fields base64, amounts as decimal strings), as built by
`relayRequestBody()` in `assets/js/pool/encode.js`:

```json
{
  "instruction": "transact",
  "pool": "So11111111111111111111111111111111111111112",
  "args": { "proofA": "…64B", "proofB": "…128B", "proofC": "…64B", "root": "…32B",
            "inputNullifiers": ["…32B", "…32B"], "outputCommitments": ["…32B", "…32B"] },
  "extData": { "recipient": "<address>", "relayer": "<relayer fee account>", "extAmount": "-100000000",
               "fee": "3000000", "encryptedOutput1": "…87B", "encryptedOutput2": "…87B",
               "encryptedSwapOutput": "…87 zero bytes", "recipientOwner": "<wallet, SPL unshields only>" }
}
```

Checks before anything is signed:

- known pool, `extAmount <= 0` (deposits are signed by the depositor);
- `extData.relayer` is this relayer's fee account: its own address for SOL, its associated token account for USDC/USDT;
- private send (`extAmount == 0`): `extData.recipient == extData.relayer` (the account is unused);
- SPL unshield: `recipient` must be the associated token account of `recipientOwner`; if it does not
  exist yet the relayer adds an idempotent create-ATA instruction and charges `createAtaFee` on top;
- recipient (and `recipientOwner`) not on the bundled OFAC list (`assets/js/pool/sanctions.js`, plus `SANCTIONS_FILE`);
- `fee >= max(minFeeLamports[token], ceil(withdrawn × feeBps / 10000)) (+ createAtaFee)` (`assets/js/pool/fees.js`);
- the transaction fits in 1232 bytes, and simulation succeeds (stale root, double spend, bad proof → 400, nothing sent).

Requests are rate-limited per IP (`RATE_RELAY_PER_MIN`, `RATE_READ_PER_MIN`, `RATE_QUOTE_PER_MIN`); bodies are capped at 16 KB.

## Private swaps (`transact_swap`)

The program CPIs `config.swap_program` signed as the escrow PDA `["escrow", input_pool]`
(programs/README.md). The relayer must route through that same program:

| Cluster | Route | Program |
|---|---|---|
| mainnet | Jupiter Swap API V2 `GET /build` (keyless, raw instructions, Metis routing) | Jupiter v6 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` |
| devnet (default) | none: `/swap/quote` and swap relays return "Private swaps route through Jupiter, which only exists on Solana mainnet" | — |
| devnet, `SWAP_PROGRAM=9GECyzNTXuqebHQb6WBWcFxiVqpUheQ8brZXRDBdNbsJ` | dev route through `programs/mock-swap` (TEST ONLY, anyone can drain its reserve), fixed `SWAP_MOCK_RATES` | mock-swap |

`GET /swap/quote?inputMint&outputMint&amount` (`amount` = `|extAmount|`, base units of the input mint,
the fee comes on top) calls `/build` with `taker` = the input pool's escrow PDA, `payer` = the relayer,
`wrapAndUnwrapSol=false` (the program wraps native SOL into the escrow's wSOL account and unwraps by
closing it), `destinationTokenAccount` = the escrow's output ATA, `slippageBps = SWAP_SLIPPAGE_BPS` and
`maxAccounts = JUPITER_MAX_ACCOUNTS`, and returns:

```json
{ "inputMint": "…", "outputMint": "…", "amount": "300000000", "outAmount": "45123456", "otherAmountThreshold": "…",
  "minOut": "44897838", "feeInInputMint": "3000000", "slippageBps": 50, "swapFeeBps": 0, "priceImpactPct": "0.0004",
  "route": "jupiter", "routePlan": ["Whirlpool"], "escrow": "<escrow PDA>", "relayerFeeAccount": "…", "expiresAt": 1760000000000 }
```

`minOut = outAmount × (10000 − SWAP_SLIPPAGE_BPS − SWAP_FEE_BPS) / 10000` is what the client proves as
`swapAmount`: the note it receives is worth exactly that. The relayer earns the normal input-mint fee
(`feeInInputMint`, same schedule as an unshield of `amount`) plus any output above `swapAmount`
(positive slippage), which the program pays to the relayer's surplus account. Identical quotes are
cached for 10 s, and all Jupiter calls share a `JUPITER_PER_MIN` budget (keyless limit: 30/min).

`POST /relay` with `instruction: "transact_swap"` adds `args.swapMintField`, `args.swapAmount`,
`args.swapCommitment`, `args.outputPool` (output mint) and `extData.encryptedSwapOutput`; the client's
`args.swapData` is ignored. Checks, then assembly:

- swap route configured; two different known pools; `extAmount < 0`; `swapAmount > 0`;
  `swapMintField == mintField(outputPool)`; `extData.recipient` = the input pool's escrow PDA;
  `extData.relayer` = the relayer's fee account for the input mint; `fee >= schedule(|extAmount|)`;
- a fresh `/build` for exactly `|extAmount|`. It needs `outAmount >= swapAmount` **and**
  `otherAmountThreshold >= swapAmount` (Jupiter's own on-chain minimum). If only the threshold is short, the relayer
  re-builds once with the largest slippage that still covers `swapAmount`; otherwise it returns 409 "Price moved".
- the route's program must be `config.swap_program`. Its only signer may be the escrow (the outer transaction
  does not sign for it: its `isSigner` is cleared and the program signs in the CPI) or the relayer. Setup
  instructions may only create associated token accounts for the escrow or the relayer.
- the escrow's input and output ATAs (wSOL for a SOL side) and the relayer's surplus ATA (token outputs)
  are created idempotently, relayer-paid, when missing. A SOL output closes the escrow's wSOL account
  on every swap, so it is re-created before every swap to SOL (its rent comes back in the surplus).
  These creates go inline when they fit, otherwise in a separate relayer transaction that is confirmed first.
  Swaps to the same escrow output account are serialized.
- transaction: `[setComputeUnitLimit(1.4M), (priority fee), (creates), transact_swap]`, where `swap_data` is Jupiter's
  `swapInstruction.data` and `remaining_accounts` are its accounts in Jupiter's order. It is a v0 message with Jupiter's
  lookup tables (`addressesByLookupTableAddress`, fetched on-chain) plus `RELAYER_LOOKUP_TABLE`. If it exceeds
  1232 bytes the relayer retries once with half the route accounts, then refuses. Then simulate, sign, send.

Swaps **require** `RELAYER_LOOKUP_TABLE` made by `scripts/lookup-table.mjs` with the swap route configured:
the table then also holds the escrows, their token accounts, the swap program, the relayer's token accounts
and (dev route) the mock reserve. Re-create the table after enabling swaps. With a realistic one-hop Jupiter
route (24 accounts) the swap transaction measures about 1204 bytes in the tests.

Dev route: the mock reserve is the PDA `["reserve"]` of mock-swap; its ATAs for each mint must exist
and be funded with the output tokens. The pool's `config.swap_program` must be the mock program.

## Run locally

```bash
cd relayer
npm install
solana-keygen new -o relayer.json        # or any 64-byte secret key JSON array
# fund it on devnet: https://faucet.solana.com (it pays network fees + nullifier rent up front)
RELAYER_KEYPAIR=./relayer.json npm start   # http://0.0.0.0:8787
npm test                                    # mocked RPC, no network
```

Then set `RELAYER_URL` in `assets/js/pool/config.js` to the relayer's **https** URL (the site's
Content-Security-Policy only allows https connections) and `ALLOWED_ORIGINS` here to the site's origin.

### Token unshields to new token accounts: lookup table

An SPL unshield that also creates the recipient's token account is 1264 bytes without an address
lookup table, over Solana's 1232-byte limit. Create one once (about 0.003 SOL) and configure it:

```bash
RELAYER_KEYPAIR=./relayer.json node scripts/lookup-table.mjs   # prints the table address
RELAYER_LOOKUP_TABLE=<address> RELAYER_KEYPAIR=./relayer.json npm start
```

Without it, those requests are refused with a clear message (nothing is signed); SOL unshields,
private sends and SPL unshields to existing token accounts work either way.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `RELAYER_KEYPAIR` | required | path to a keypair JSON file, or the JSON array itself |
| `CLUSTER` | `devnet` | `devnet` or `mainnet` |
| `RELAYER_ALLOW_MAINNET` | unset | must be `1` for `CLUSTER=mainnet`; otherwise the relayer exits |
| `RPC_URL` | public endpoint of the cluster | checked at start-up against the cluster's genesis hash (`SKIP_GENESIS_CHECK=1` to skip) |
| `PROGRAM_ID` | `POOL_PROGRAM_ID` from `assets/js/pool/config.js` | |
| `POOL_MINT_SOL/USDC/USDT` | mints from `assets/js/pool/config.js` | empty string disables that pool |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | |
| `ALLOWED_ORIGINS` | `*` | comma-separated site origins for CORS, e.g. `https://dankswap.app` |
| `TRUST_PROXY` | unset | `1` to rate-limit by `X-Forwarded-For` behind a proxy |
| `FEE_BPS` | `30` | percentage fee on unshields (0.30%) |
| `MIN_FEE_SOL` | `3000000` | lamports (covers network fee + rent of two nullifier accounts ≈ 0.0019 SOL) |
| `MIN_FEE_USDC`, `MIN_FEE_USDT` | `500000` | base units (0.50) |
| `CREATE_ATA_FEE_USDC`, `CREATE_ATA_FEE_USDT` | `500000` | extra when the relayer creates the recipient's token account (≈0.002 SOL rent) |
| `DYNAMIC_FEES` | `1` on mainnet, `0` otherwise | Raise the USDC/USDT minimums above to cover the relayer's SOL costs at the live SOL price (Jupiter Price API, free and keyless, polled each minute). The values above stay the floor; implausible prices are ignored and the last good fees are kept |
| `FEE_MARGIN_BPS` | `2500` | Margin over cost for the live minimums (25%) |
| `PRICE_API` | `https://api.jup.ag/price/v3` | Price source |
| `RELAYER_LOOKUP_TABLE` | unset | address lookup table from `scripts/lookup-table.mjs` |
| `INDEX_FILE` | `relayer/data/index.json` | JSON persistence of the commitment index |
| `POLL_MS` | `15000` | index refresh interval |
| `RATE_RELAY_PER_MIN`, `RATE_READ_PER_MIN` | `6`, `120` | per IP |
| `COMPUTE_UNITS` | `1400000` | compute unit limit per transaction (spec §8) |
| `PRIORITY_MICROLAMPORTS` | `0` | optional priority fee |
| `SWAP_PROGRAM` | Jupiter v6 on mainnet, unset on devnet | must equal the pool's `config.swap_program`; on devnet only the mock-swap program is accepted (dev route) |
| `SWAP_SLIPPAGE_BPS` | `50` | buffer between the quote and the proven minimum; also Jupiter's `slippageBps` |
| `SWAP_FEE_BPS` | `0` | extra margin under the quote kept by the relayer as surplus |
| `JUPITER_API` | `https://api.jup.ag/swap/v2` | Swap API V2 base URL (keyless) |
| `JUPITER_MAX_ACCOUNTS` | `20` | route account cap so the swap fits one transaction |
| `JUPITER_PER_MIN` | `25` | Jupiter requests per minute for the whole relayer |
| `SWAP_QUOTE_TTL_MS` | `60000` | quote validity shown to clients |
| `SWAP_MOCK_RATES` | `{"SOL/USDC":150,"SOL/USDT":150,"USDC/USDT":1}` with the dev route | UI-unit prices for the dev route |
| `RATE_QUOTE_PER_MIN` | `20` | `/swap/quote` per IP |
| `SANCTIONS_FILE` | unset | extra blocked addresses, whitespace-separated |

Fees in USDC/USDT are paid into the relayer's associated token accounts for those mints: create them
once (`spl-token create-account <mint> --owner <relayer>`), or token fees cannot be received and
those transactions fail simulation.

## Deploy (free hosts)

Any host that runs a long-lived Node 20+ process works. The relayer needs outbound HTTPS to the RPC
and, ideally, a persistent disk for `INDEX_FILE` (without one it rebuilds the index from RPC at
every start, which is fine on devnet but slow on a busy pool).

- **Render** (free web service): root directory `relayer`, build `npm install`, start `npm start`,
  env vars as above. Put the keypair JSON array in `RELAYER_KEYPAIR` as a secret. Free instances sleep
  when idle; the first request after a sleep is slow.
- **Fly.io / Koyeb / Railway**: same commands; a Dockerfile is not required (Node buildpacks).
  On Fly, mount a small volume and point `INDEX_FILE` at it.
- **Google Cloud Run** (free tier) or **Oracle Cloud Always Free VM**: run `node relayer/src/server.mjs`
  behind HTTPS; set `TRUST_PROXY=1` behind a load balancer.

The relayer wallet needs SOL: it pays the network fee and the rent of the two nullifier accounts
(~0.0019 SOL) for every relayed transaction before the pool reimburses it through the fee. Keep a
few SOL on mainnet (only after audits) or a faucet top-up on devnet, and watch `/health` and the
start-up log, which warns under 0.05 SOL. Keep `assets/js/pool/sanctions.js` fresh with
`node scripts/update-sanctions.mjs` (weekly) and redeploy.
