// groth16-solana encodings (spec §7).
import { P, Q, toBE32, toHex, concat, mod } from './field.js';

/** G1 [x, y, (z)] -> x(32 BE) ++ y(32 BE) */
export const g1ToBytes = (p) => concat(toBE32(p[0]), toBE32(p[1]));

/** G2 [[x.c0, x.c1], [y.c0, y.c1], (z)] -> x.c1 ++ x.c0 ++ y.c1 ++ y.c0 */
export const g2ToBytes = (p) => concat(toBE32(p[0][1]), toBE32(p[0][0]), toBE32(p[1][1]), toBE32(p[1][0]));

/** Negate a G1 point (affine, projective z must be 1). */
export function negateG1(p) {
  const x = BigInt(p[0]), y = BigInt(p[1]);
  if (p[2] !== undefined && BigInt(p[2]) !== 1n) throw new Error('G1 point not affine');
  return [x, y === 0n ? 0n : Q - y];
}

/** snarkjs proof.json -> { proofA (negated), proofB, proofC } as Uint8Arrays (64/128/64). */
export function encodeProof(proof) {
  return {
    proofA: g1ToBytes(negateG1(proof.pi_a)),
    proofB: g2ToBytes(proof.pi_b),
    proofC: g1ToBytes(proof.pi_c),
  };
}

/** snarkjs public signals (decimal strings) -> 11 x 32-byte BE (Uint8Array[]). */
export function encodePublicInputs(publicSignals) {
  return publicSignals.map((s) => {
    const v = BigInt(s);
    if (v < 0n || v >= P) throw new Error('public signal not reduced');
    return toBE32(v);
  });
}

/** publicAmount = (extAmount - fee) mod p */
export const publicAmount = (extAmount, fee) => mod(BigInt(extAmount) - BigInt(fee));

export const proofToHex = (proof) => {
  const e = encodeProof(proof);
  return { proofA: toHex(e.proofA), proofB: toHex(e.proofB), proofC: toHex(e.proofC) };
};
