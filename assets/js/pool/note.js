// Notes (UTXOs), commitments, nullifiers and encrypted outputs (docs/PHASE2_SPEC.md §1, §2, §6).
import nacl from '../../vendor/tweetnacl.min.js';
import { poseidon } from '../../vendor/poseidon.bundle.js';
import {
  FIELD_SIZE, U64_MAX, bigIntToBytes, bytesToBigInt, concatBytes, pubkeyBytes, randomBytes, readU64LE, u64LE,
} from './util.js';

export const ENCRYPTED_OUTPUT_LENGTH = 87; // 32 ephemeral key + 39 plaintext + 16 MAC
const PLAINTEXT_LENGTH = 39; // amount u64 LE (8) ++ blinding 31 bytes BE
const ZERO_NONCE = new Uint8Array(24);

/** mintField(mint) = first 31 bytes of the mint pubkey, big-endian (§1). */
export function mintField(mint) {
  return bytesToBigInt(pubkeyBytes(mint).subarray(0, 31));
}

/** mintField as 32 bytes: 0x00 ++ mint[0..31]. */
export function mintFieldBytes(mint) {
  return concatBytes(Uint8Array.of(0), pubkeyBytes(mint).subarray(0, 31));
}

function checkAmount(amount) {
  const a = BigInt(amount);
  if (a < 0n || a > U64_MAX) throw new Error('Amount out of u64 range');
  return a;
}

/** commitment = Poseidon(amount, pubKey, blinding, mintField). */
export function commitmentHash(amount, pubKey, blinding, mintFieldValue) {
  return poseidon([checkAmount(amount), BigInt(pubKey), BigInt(blinding), BigInt(mintFieldValue)]);
}

/** signature = Poseidon(privKey, commitment, pathIndex). */
export function signatureHash(privKey, commitment, pathIndex) {
  return poseidon([BigInt(privKey), BigInt(commitment), BigInt(pathIndex)]);
}

/** nullifier = Poseidon(commitment, pathIndex, signature). */
export function nullifierHash(privKey, commitment, pathIndex) {
  const sig = signatureHash(privKey, commitment, pathIndex);
  return poseidon([BigInt(commitment), BigInt(pathIndex), sig]);
}

/** Random 31-byte blinding (always < p). */
export function randomBlinding() {
  return bytesToBigInt(randomBytes(31));
}

/**
 * A note. `pubKey` is the owner's shielded public key; `encPublic` (optional) the owner's X25519
 * key for the encrypted output. `index` is set once the note is in the tree.
 */
export class Note {
  constructor({ amount = 0n, pubKey, blinding, mint, mintFieldValue, encPublic = null, privKey = null, index = null }) {
    this.amount = checkAmount(amount);
    this.pubKey = BigInt(pubKey);
    this.blinding = blinding === undefined || blinding === null ? randomBlinding() : BigInt(blinding);
    if (this.blinding >= 1n << 248n) throw new Error('Blinding must fit in 31 bytes');
    this.mint = mint || null;
    this.mintField = mintFieldValue !== undefined ? BigInt(mintFieldValue) : mintField(mint);
    this.encPublic = encPublic;
    this.privKey = privKey === null ? null : BigInt(privKey);
    this.index = index;
    this._commitment = null;
  }

  get commitment() {
    if (this._commitment === null) this._commitment = commitmentHash(this.amount, this.pubKey, this.blinding, this.mintField);
    return this._commitment;
  }

  /** Needs privKey and the leaf index (dummy inputs use index 0). */
  nullifier(pathIndex = this.index ?? 0) {
    if (this.privKey === null) throw new Error('Cannot compute a nullifier without the private key');
    return nullifierHash(this.privKey, this.commitment, pathIndex);
  }

  /**
   * 87-byte encrypted output. Zero-amount notes and notes without an encryption key are
   * encrypted to a random key (§6: dummy outputs still look like real ones).
   */
  encrypt() {
    if (this.amount === 0n || !this.encPublic) return encryptToRandom(this.amount, this.blinding);
    return encryptOutput(this.amount, this.blinding, this.encPublic);
  }
}

/** ephemeralPublicKey(32) ++ nacl.box(amount LE ++ blinding31 BE, zero nonce, recipient, ephemeralSecret). */
export function encryptOutput(amount, blinding, recipientEncPublic, ephemeral = nacl.box.keyPair()) {
  if (!(recipientEncPublic instanceof Uint8Array) || recipientEncPublic.length !== 32) throw new Error('Bad recipient encryption key');
  const plaintext = concatBytes(u64LE(amount), bigIntToBytes(blinding, 31));
  const box = nacl.box(plaintext, ZERO_NONCE, recipientEncPublic, ephemeral.secretKey);
  const out = concatBytes(ephemeral.publicKey, box);
  if (out.length !== ENCRYPTED_OUTPUT_LENGTH) throw new Error('Encrypted output has the wrong length');
  return out;
}

export function encryptToRandom(amount = 0n, blinding = randomBlinding()) {
  return encryptOutput(amount, blinding, nacl.box.keyPair().publicKey);
}

/** Returns { amount, blinding } or null when the output is not for this key. */
export function decryptOutput(encrypted, encSecret) {
  if (!(encrypted instanceof Uint8Array) || encrypted.length !== ENCRYPTED_OUTPUT_LENGTH) return null;
  const plain = nacl.box.open(encrypted.subarray(32), ZERO_NONCE, encrypted.subarray(0, 32), encSecret);
  if (!plain || plain.length !== PLAINTEXT_LENGTH) return null;
  return { amount: readU64LE(plain, 0), blinding: bytesToBigInt(plain.subarray(8)) };
}

/**
 * Try to read one leaf of the tree as a note owned by `keys`. Returns a Note (with index and
 * privKey) or null. The decrypted values must reproduce the leaf's commitment.
 */
export function tryDecryptNote({ index, commitment, encryptedOutput }, keys, mint) {
  const dec = decryptOutput(encryptedOutput, keys.encSecret);
  if (!dec) return null;
  const note = new Note({ amount: dec.amount, pubKey: keys.pubKey, blinding: dec.blinding, mint, privKey: keys.privKey, encPublic: keys.encPublic, index });
  if (note.commitment !== BigInt(commitment)) return null;
  return note;
}

export { FIELD_SIZE };
