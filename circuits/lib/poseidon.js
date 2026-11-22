// circomlib Poseidon via circomlibjs (spec §1). Call `await initPoseidon()` once,
// then use the synchronous `poseidon([...])`, which returns a bigint.
import { buildPoseidon } from 'circomlibjs';

let instance = null;

export async function initPoseidon() {
  if (!instance) instance = await buildPoseidon();
  return poseidon;
}

export function poseidon(inputs) {
  if (!instance) throw new Error('poseidon not initialised: await initPoseidon() first');
  if (inputs.length < 1 || inputs.length > 16) throw new Error('poseidon: 1..16 inputs');
  return instance.F.toObject(instance(inputs.map((x) => BigInt(x))));
}
