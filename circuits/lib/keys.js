// Key derivation and mint field (spec §1, §2). Encryption keys are the SDK's job.
import { createHash } from 'node:crypto';
import { P, fromBE, concat, pubkeyBytes } from './field.js';
import { poseidon } from './poseidon.js';

export const SIGN_MESSAGE =
  'DankSwap shielded account v1\n\nSign to unlock your private balance. This is free and does not move funds.';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());

/** seed = sha256(walletSignatureBytes) */
export const seedFromSignature = (sig) => sha256(new Uint8Array(sig));

/** privKey = BE(sha256(seed ++ 0x01)) mod p */
export function privKeyFromSeed(seed) {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  return fromBE(sha256(concat(seed, Uint8Array.of(1)))) % P;
}

/** pubKey = Poseidon(privKey) */
export const pubKeyFromPriv = (priv) => poseidon([priv]);

/** mintField = first 31 bytes of the mint pubkey, big-endian. */
export function mintField(mint) {
  return fromBE(pubkeyBytes(mint).slice(0, 31));
}

export class Keypair {
  constructor(privKey) {
    this.privKey = BigInt(privKey) % P;
    this.pubKey = pubKeyFromPriv(this.privKey);
  }
  static fromSeed(seed) { return new Keypair(privKeyFromSeed(seed)); }
}
