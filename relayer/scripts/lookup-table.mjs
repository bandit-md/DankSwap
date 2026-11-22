#!/usr/bin/env node
// One-time setup: create an address lookup table holding the pool's static accounts and print its
// address for RELAYER_LOOKUP_TABLE. Token unshields that must create the recipient's token account
// only fit in a transaction (1232 bytes) with this table. Costs about 0.003 SOL of rent, paid by
// the relayer wallet. Uses the same env vars as the server (RELAYER_KEYPAIR, CLUSTER, RPC_URL, ...).
//
//   RELAYER_KEYPAIR=./relayer.json node scripts/lookup-table.mjs
import { createRequire } from 'node:module';
import { loadConfig, parseKeypairSecret } from '../src/config.mjs';
import { lookupTableAddresses } from '../src/relay.mjs';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');

async function main() {
  const config = loadConfig();
  const payer = web3.Keypair.fromSecretKey(parseKeypairSecret(process.env.RELAYER_KEYPAIR));
  const connection = new web3.Connection(config.rpcUrl, 'confirmed');
  const addresses = lookupTableAddresses(web3, config, payer.publicKey.toBase58()).map((a) => new web3.PublicKey(a));
  const slot = await connection.getSlot('finalized');
  const [createIx, table] = web3.AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  // One extend instruction fits about 20 addresses in a transaction; swap support adds escrows
  // and their token accounts, so extend in chunks.
  for (let i = 0; i < addresses.length; i += 20) {
    const extendIx = web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: addresses.slice(i, i + 20) });
    const tx = i === 0 ? new web3.Transaction().add(createIx, extendIx) : new web3.Transaction().add(extendIx);
    const sig = await web3.sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
    console.log(`${i === 0 ? 'Created' : 'Extended'} lookup table ${table.toBase58()} (+${Math.min(20, addresses.length - i)} addresses, tx ${sig}).`);
  }
  console.log(`Set RELAYER_LOOKUP_TABLE=${table.toBase58()} and restart the relayer (tables become usable one slot after extension).`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
