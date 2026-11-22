# DankSwap private pool relayer

> **Unaudited. Devnet first.** It refuses mainnet unless `RELAYER_ALLOW_MAINNET=1`, and it should
> not be set before the circuits and program are audited and a multi-party trusted setup is done.

A small Node 20+ service (plain `node:http`, one dependency: `@solana/web3.js`) that implements
docs/PHASE2_SPEC.md §9:

- **Relays** private sends and unshields. The user's browser builds and proves the transaction; the
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
| GET | `/info` | `{ relayer, feeBps, minFeeLamports: {SOL, USDC, USDT}, createAtaFee: {USDC, USDT}, cluster, programId, pools: [{symbol, mint}] }` |
| POST | `/relay` | body `{ instruction: "transact", pool: <mint>, args, extData }` (below) → `{ signature }` |
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

- known pool, `instruction == "transact"` (swaps are not relayed yet), `extAmount <= 0` (deposits are signed by the depositor);
- `extData.relayer` is this relayer's fee account: its own address for SOL, its associated token account for USDC/USDT;
- private send (`extAmount == 0`): `extData.recipient == extData.relayer` (the account is unused);
- SPL unshield: `recipient` must be the associated token account of `recipientOwner`; if it does not
  exist yet the relayer adds an idempotent create-ATA instruction and charges `createAtaFee` on top;
- recipient (and `recipientOwner`) not on the bundled OFAC list (`assets/js/pool/sanctions.js`, plus `SANCTIONS_FILE`);
- `fee >= max(minFeeLamports[token], ceil(withdrawn × feeBps / 10000)) (+ createAtaFee)` (`assets/js/pool/fees.js`);
- the transaction fits in 1232 bytes, and simulation succeeds (stale root, double spend, bad proof → 400, nothing sent).

Requests are rate-limited per IP (`RATE_RELAY_PER_MIN`, `RATE_READ_PER_MIN`); bodies are capped at 16 KB.

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
| `RELAYER_LOOKUP_TABLE` | unset | address lookup table from `scripts/lookup-table.mjs` |
| `INDEX_FILE` | `relayer/data/index.json` | JSON persistence of the commitment index |
| `POLL_MS` | `15000` | index refresh interval |
| `RATE_RELAY_PER_MIN`, `RATE_READ_PER_MIN` | `6`, `120` | per IP |
| `COMPUTE_UNITS` | `1400000` | compute unit limit per transaction (spec §8) |
| `PRIORITY_MICROLAMPORTS` | `0` | optional priority fee |
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
