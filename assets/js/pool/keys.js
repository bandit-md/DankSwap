// Shielded account keys (docs/PHASE2_SPEC.md §2). No DOM access at import time.
import nacl from '../../vendor/tweetnacl.min.js';
import { poseidon } from '../../vendor/poseidon.bundle.js';
import {
  FIELD_SIZE, base58Decode, base58Encode, bigIntToBytes, bytesToBigInt, concatBytes, pubkeyBytes, sha256, utf8,
} from './util.js';

export const UNLOCK_MESSAGE =
  'DankSwap shielded account v1\n\nSign to unlock your private balance. This is free and does not move funds.';

export const ADDRESS_PREFIX = 'dank';

/**
 * Derive every shielded key from the wallet's signature of UNLOCK_MESSAGE.
 * seed = sha256(sig); privKey = BE(sha256(seed ++ 0x01)) mod p; pubKey = Poseidon(privKey);
 * encSecret = sha256(seed ++ 0x02); encPublic = X25519 public key of encSecret.
 */
export async function deriveKeys(signatureBytes) {
  if (!(signatureBytes instanceof Uint8Array) || signatureBytes.length !== 64) throw new Error('Expected a 64-byte wallet signature');
  const seed = await sha256(signatureBytes);
  const privKey = bytesToBigInt(await sha256(concatBytes(seed, Uint8Array.of(1)))) % FIELD_SIZE;
  const pubKey = poseidon([privKey]);
  const encSecret = await sha256(concatBytes(seed, Uint8Array.of(2)));
  const encPublic = nacl.box.keyPair.fromSecretKey(encSecret).publicKey;
  return { privKey, pubKey, encSecret, encPublic, address: encodeAddress(pubKey, encPublic) };
}

/** "dank" + base58(pubKey 32 BE ++ encPublic 32). */
export function encodeAddress(pubKey, encPublic) {
  if (!(encPublic instanceof Uint8Array) || encPublic.length !== 32) throw new Error('Bad encryption key');
  return ADDRESS_PREFIX + base58Encode(concatBytes(bigIntToBytes(pubKey, 32), encPublic));
}

/** Parse a shielded address. Returns { pubKey: bigint, encPublic: Uint8Array } or null. */
export function decodeAddress(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s.startsWith(ADDRESS_PREFIX) || s.length < 80 || s.length > 96) return null;
  const raw = base58Decode(s.slice(ADDRESS_PREFIX.length));
  if (!raw || raw.length !== 64) return null;
  const pubKey = bytesToBigInt(raw.subarray(0, 32));
  if (pubKey === 0n || pubKey >= FIELD_SIZE) return null;
  return { pubKey, encPublic: raw.slice(32) };
}

export function isShieldedAddress(str) {
  return decodeAddress(str) !== null;
}

/**
 * Ask a Wallet Standard wallet to sign UNLOCK_MESSAGE (solana:signMessage) and return the
 * 64-byte signature. The signature is checked against the account's public key, so a wallet
 * that returns something else cannot silently give the user a different shielded account.
 */
export async function signUnlockMessage(wallet, account) {
  const feature = wallet && wallet.features && wallet.features['solana:signMessage'];
  if (!feature) throw new Error('This wallet cannot sign messages. Try Phantom, Solflare or Backpack.');
  const message = utf8(UNLOCK_MESSAGE);
  const [out] = await feature.signMessage({ account, message });
  const sig = out && (out.signature instanceof Uint8Array ? out.signature : out.signature ? Uint8Array.from(out.signature) : null);
  if (!sig || sig.length !== 64) throw new Error('The wallet returned no signature');
  if (out.signedMessage && out.signedMessage.length && !sameBytes(out.signedMessage, message)) {
    throw new Error('The wallet signed a different message');
  }
  const pk = account.publicKey && account.publicKey.length === 32 && account.publicKey.some((b) => b !== 0)
    ? Uint8Array.from(account.publicKey)
    : pubkeyBytes(account.address);
  if (!nacl.sign.detached.verify(message, sig, pk)) throw new Error('The wallet signature did not verify');
  return sig;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
