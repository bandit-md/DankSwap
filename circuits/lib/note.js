// Notes / UTXOs (spec §2).
import { randomBytes } from 'node:crypto';
import { fromBE } from './field.js';
import { poseidon } from './poseidon.js';

export const randomBlinding = () => fromBE(randomBytes(31));

export const commitmentHash = (amount, pubKey, blinding, mintField) =>
  poseidon([amount, pubKey, blinding, mintField]);
export const signatureHash = (privKey, commitment, pathIndex) => poseidon([privKey, commitment, pathIndex]);
export const nullifierHash = (commitment, pathIndex, signature) => poseidon([commitment, pathIndex, signature]);

export class Note {
  /**
   * @param {{amount?: bigint|number, keypair?: import('./keys.js').Keypair, pubKey?: bigint,
   *          blinding?: bigint, mintField: bigint, index?: number}} o
   * keypair is needed to spend (nullifier); pubKey alone is enough to create an output.
   */
  constructor({ amount = 0n, keypair = null, pubKey, blinding, mintField, index = null }) {
    this.amount = BigInt(amount);
    if (this.amount < 0n || this.amount >= 1n << 64n) throw new Error('amount must be u64');
    this.keypair = keypair;
    this.pubKey = pubKey !== undefined ? BigInt(pubKey) : keypair.pubKey;
    this.blinding = blinding !== undefined ? BigInt(blinding) : randomBlinding();
    this.mintField = BigInt(mintField);
    this.index = index;
  }
  get commitment() { return commitmentHash(this.amount, this.pubKey, this.blinding, this.mintField); }
  nullifier(index = this.index ?? 0) {
    if (!this.keypair) throw new Error('nullifier needs the private key');
    const c = this.commitment;
    const sig = signatureHash(this.keypair.privKey, c, index);
    return nullifierHash(c, index, sig);
  }
}
