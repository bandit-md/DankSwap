// Encodings shared byte-for-byte with the circuit and the program (docs/PHASE2_SPEC.md §5, §7, §8):
// publicAmount, extDataHash, Groth16 proof bytes, Anchor instruction data and event decoding.
// Used by the browser SDK and by the relayer (which imports this file directly).
import {
  BASE_FIELD, FIELD_SIZE, I64_MAX, I64_MIN, U64_MAX, base64ToBytes, bytesToBase64, bytesToBigInt, concatBytes,
  fieldToBytes, i64LE, modField, pubkeyBytes, readI64LE, readU64LE, sha256, u32LE, u64LE, utf8, base58Encode,
} from './util.js';
import { ENCRYPTED_OUTPUT_LENGTH } from './note.js';

export const ZERO_ENCRYPTED_OUTPUT = new Uint8Array(ENCRYPTED_OUTPUT_LENGTH);

/** publicAmount = (extAmount - fee) mod p (§4). */
export function publicAmount(extAmount, fee) {
  const e = BigInt(extAmount);
  const f = BigInt(fee);
  if (e < I64_MIN || e > I64_MAX) throw new Error('extAmount out of i64 range');
  if (f < 0n || f > U64_MAX) throw new Error('fee out of u64 range');
  return modField(e - f);
}

function enc87(v, name) {
  const b = v === undefined || v === null ? ZERO_ENCRYPTED_OUTPUT : typeof v === 'string' ? base64ToBytes(v) : v;
  if (!(b instanceof Uint8Array) || b.length !== ENCRYPTED_OUTPUT_LENGTH) throw new Error(`${name} must be ${ENCRYPTED_OUTPUT_LENGTH} bytes`);
  return b;
}

/** The exact bytes hashed into extDataHash (§5). */
export function extDataBytes(extData) {
  return concatBytes(
    pubkeyBytes(extData.recipient),
    pubkeyBytes(extData.relayer),
    i64LE(extData.extAmount),
    u64LE(extData.fee),
    enc87(extData.encryptedOutput1, 'encryptedOutput1'),
    enc87(extData.encryptedOutput2, 'encryptedOutput2'),
    enc87(extData.encryptedSwapOutput, 'encryptedSwapOutput'),
  );
}

/** extDataHash = sha256(extData bytes) with byte 0 set to 0x00, read big-endian (§5). */
export async function extDataHash(extData) {
  const d = await sha256(extDataBytes(extData));
  d[0] = 0;
  return bytesToBigInt(d);
}

/** Groth16 proof from snarkjs proof.json → groth16-solana bytes (§7). */
export function encodeProof(proof) {
  const be = (v) => fieldBytesAny(BigInt(v));
  const ax = BigInt(proof.pi_a[0]);
  const ay = BigInt(proof.pi_a[1]);
  const proofA = concatBytes(be(ax), be((BASE_FIELD - (ay % BASE_FIELD)) % BASE_FIELD));
  const b = proof.pi_b;
  const proofB = concatBytes(be(b[0][1]), be(b[0][0]), be(b[1][1]), be(b[1][0]));
  const proofC = concatBytes(be(proof.pi_c[0]), be(proof.pi_c[1]));
  return { proofA, proofB, proofC };
}

// Base-field coordinates can exceed the scalar field, so they are not range-checked against p.
function fieldBytesAny(v) {
  if (v < 0n || v >= BASE_FIELD) throw new Error('Coordinate out of range');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The 11 public signals, in §4 order, as 32-byte big-endian each. */
export function encodePublicSignals(publicSignals) {
  if (publicSignals.length !== 11) throw new Error('Expected 11 public signals');
  return publicSignals.map((s) => fieldToBytes(BigInt(s)));
}

export const PUBLIC_SIGNAL_NAMES = [
  'root', 'publicAmount', 'extDataHash', 'mintField', 'inputNullifier0', 'inputNullifier1',
  'outputCommitment0', 'outputCommitment1', 'swapMintField', 'swapAmount', 'swapCommitment',
];

/* ---------------- Anchor ---------------- */

const discCache = new Map();
/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export async function instructionDiscriminator(name) {
  const k = 'global:' + name;
  if (!discCache.has(k)) discCache.set(k, (await sha256(utf8(k))).slice(0, 8));
  return discCache.get(k);
}

/** Anchor event discriminator: sha256("event:<Name>")[0..8]. */
export async function eventDiscriminator(name) {
  const k = 'event:' + name;
  if (!discCache.has(k)) discCache.set(k, (await sha256(utf8(k))).slice(0, 8));
  return discCache.get(k);
}

function fixed(bytes, len, name) {
  const b = typeof bytes === 'string' ? base64ToBytes(bytes) : bytes;
  if (!(b instanceof Uint8Array) || b.length !== len) throw new Error(`${name} must be ${len} bytes`);
  return b;
}

/**
 * Borsh args shared by transact and transact_swap, in declaration order (§8):
 * proof_a [u8;64], proof_b [u8;128], proof_c [u8;64], root [u8;32], input_nullifiers [[u8;32];2],
 * output_commitments [[u8;32];2], ext_amount i64, fee u64, encrypted_output1 [u8;87], encrypted_output2 [u8;87].
 */
function transactArgsBytes(a) {
  return concatBytes(
    fixed(a.proofA, 64, 'proofA'),
    fixed(a.proofB, 128, 'proofB'),
    fixed(a.proofC, 64, 'proofC'),
    fixed(a.root, 32, 'root'),
    fixed(a.inputNullifiers[0], 32, 'inputNullifiers[0]'),
    fixed(a.inputNullifiers[1], 32, 'inputNullifiers[1]'),
    fixed(a.outputCommitments[0], 32, 'outputCommitments[0]'),
    fixed(a.outputCommitments[1], 32, 'outputCommitments[1]'),
    i64LE(a.extAmount),
    u64LE(a.fee),
    fixed(a.encryptedOutput1, ENCRYPTED_OUTPUT_LENGTH, 'encryptedOutput1'),
    fixed(a.encryptedOutput2, ENCRYPTED_OUTPUT_LENGTH, 'encryptedOutput2'),
  );
}

/** Instruction data for `transact`. */
export async function transactInstructionData(args) {
  return concatBytes(await instructionDiscriminator('transact'), transactArgsBytes(args));
}

/**
 * Instruction data for `transact_swap`: the transact args, then swap_amount u64,
 * swap_commitment [u8;32], encrypted_swap_output [u8;87], swap_data Vec<u8> (Borsh: u32 LE length + bytes).
 */
export async function transactSwapInstructionData(args) {
  const swapData = typeof args.swapData === 'string' ? base64ToBytes(args.swapData) : args.swapData || new Uint8Array(0);
  return concatBytes(
    await instructionDiscriminator('transact_swap'),
    transactArgsBytes(args),
    u64LE(args.swapAmount),
    fixed(args.swapCommitment, 32, 'swapCommitment'),
    fixed(args.encryptedSwapOutput, ENCRYPTED_OUTPUT_LENGTH, 'encryptedSwapOutput'),
    u32LE(swapData.length),
    swapData,
  );
}

/** Parse transact args back from instruction data (relayer-side checks, tests). */
export function decodeTransactArgs(data) {
  let o = 8;
  const take = (n) => {
    const s = data.slice(o, o + n);
    if (s.length !== n) throw new Error('Instruction data too short');
    o += n;
    return s;
  };
  const out = {
    proofA: take(64), proofB: take(128), proofC: take(64), root: take(32),
    inputNullifiers: [take(32), take(32)], outputCommitments: [take(32), take(32)],
  };
  out.extAmount = readI64LE(take(8));
  out.fee = readU64LE(take(8));
  out.encryptedOutput1 = take(ENCRYPTED_OUTPUT_LENGTH);
  out.encryptedOutput2 = take(ENCRYPTED_OUTPUT_LENGTH);
  out.rest = data.slice(o);
  return out;
}

/**
 * Decode a NewCommitment event body (after the 8-byte discriminator):
 * pool Pubkey, commitment [u8;32], index u64, encrypted_output [u8;87] — or Vec<u8> (u32 length prefix).
 */
export function decodeNewCommitment(body) {
  const fixedLen = 32 + 32 + 8 + ENCRYPTED_OUTPUT_LENGTH;
  let enc;
  if (body.length === fixedLen) enc = body.slice(72, 72 + ENCRYPTED_OUTPUT_LENGTH);
  else if (body.length === fixedLen + 4 && readU32(body, 72) === ENCRYPTED_OUTPUT_LENGTH) enc = body.slice(76, 76 + ENCRYPTED_OUTPUT_LENGTH);
  else throw new Error(`Unexpected NewCommitment length ${body.length}`);
  return {
    pool: base58Encode(body.slice(0, 32)),
    commitment: bytesToBigInt(body.slice(32, 64)),
    index: Number(readU64LE(body, 64)),
    encryptedOutput: enc,
  };
}

function readU32(b, o) {
  return new DataView(b.buffer, b.byteOffset + o, 4).getUint32(0, true);
}

/** Decode a NewNullifier event body: nullifier [u8;32]. */
export function decodeNewNullifier(body) {
  if (body.length < 32) throw new Error('Unexpected NewNullifier length');
  return { nullifier: bytesToBigInt(body.slice(0, 32)) };
}

/* ---------------- relay request (§9) ---------------- */

/**
 * Relay request body for POST /relay. Every byte field is base64; amounts are decimal strings.
 * { instruction, pool, args: { proofA, proofB, proofC, root, inputNullifiers[2], outputCommitments[2], ...swap },
 *   extData: { recipient, relayer, extAmount, fee, encryptedOutput1, encryptedOutput2, encryptedSwapOutput } }
 */
export function relayRequestBody({ instruction = 'transact', pool, args, extData, recipientOwner }) {
  const b64 = (x) => (typeof x === 'string' ? x : bytesToBase64(x));
  const body = {
    instruction,
    pool: typeof pool === 'string' ? pool : base58Encode(pubkeyBytes(pool)),
    args: {
      proofA: b64(args.proofA),
      proofB: b64(args.proofB),
      proofC: b64(args.proofC),
      root: b64(args.root),
      inputNullifiers: args.inputNullifiers.map(b64),
      outputCommitments: args.outputCommitments.map(b64),
    },
    extData: {
      recipient: String(extData.recipient),
      relayer: String(extData.relayer),
      extAmount: String(extData.extAmount),
      fee: String(extData.fee),
      encryptedOutput1: b64(extData.encryptedOutput1),
      encryptedOutput2: b64(extData.encryptedOutput2),
      encryptedSwapOutput: b64(extData.encryptedSwapOutput || ZERO_ENCRYPTED_OUTPUT),
    },
  };
  if (recipientOwner) body.extData.recipientOwner = String(recipientOwner);
  if (instruction === 'transact_swap') {
    body.args.swapMintField = b64(args.swapMintField);
    body.args.swapAmount = String(args.swapAmount);
    body.args.swapCommitment = b64(args.swapCommitment);
    body.args.swapData = b64(args.swapData || new Uint8Array(0));
    body.args.outputPool = String(args.outputPool);
  }
  return body;
}

/** Inverse of relayRequestBody: base64 → bytes, strings → BigInt. Throws on malformed input. */
export function parseRelayRequest(body) {
  if (!body || typeof body !== 'object') throw new Error('Body must be a JSON object');
  if (body.instruction !== 'transact' && body.instruction !== 'transact_swap') throw new Error('instruction must be transact or transact_swap');
  const a = body.args || {};
  const e = body.extData || {};
  const bytes = (v, len, name) => {
    if (typeof v !== 'string') throw new Error(`${name} missing`);
    let b;
    try {
      b = base64ToBytes(v);
    } catch (_) {
      throw new Error(`${name} is not base64`);
    }
    if (b.length !== len) throw new Error(`${name} must be ${len} bytes`);
    return b;
  };
  const int = (v, name) => {
    if (typeof v !== 'string' || !/^-?\d{1,20}$/.test(v)) throw new Error(`${name} must be an integer string`);
    return BigInt(v);
  };
  if (!Array.isArray(a.inputNullifiers) || a.inputNullifiers.length !== 2) throw new Error('inputNullifiers must have 2 entries');
  if (!Array.isArray(a.outputCommitments) || a.outputCommitments.length !== 2) throw new Error('outputCommitments must have 2 entries');
  const out = {
    instruction: body.instruction,
    pool: base58Encode(pubkeyBytes(body.pool)),
    args: {
      proofA: bytes(a.proofA, 64, 'proofA'),
      proofB: bytes(a.proofB, 128, 'proofB'),
      proofC: bytes(a.proofC, 64, 'proofC'),
      root: bytes(a.root, 32, 'root'),
      inputNullifiers: a.inputNullifiers.map((x, i) => bytes(x, 32, `inputNullifiers[${i}]`)),
      outputCommitments: a.outputCommitments.map((x, i) => bytes(x, 32, `outputCommitments[${i}]`)),
    },
    extData: {
      recipient: base58Encode(pubkeyBytes(e.recipient)),
      relayer: base58Encode(pubkeyBytes(e.relayer)),
      extAmount: int(e.extAmount, 'extAmount'),
      fee: int(e.fee, 'fee'),
      encryptedOutput1: bytes(e.encryptedOutput1, ENCRYPTED_OUTPUT_LENGTH, 'encryptedOutput1'),
      encryptedOutput2: bytes(e.encryptedOutput2, ENCRYPTED_OUTPUT_LENGTH, 'encryptedOutput2'),
      encryptedSwapOutput: e.encryptedSwapOutput === undefined ? ZERO_ENCRYPTED_OUTPUT : bytes(e.encryptedSwapOutput, ENCRYPTED_OUTPUT_LENGTH, 'encryptedSwapOutput'),
      recipientOwner: e.recipientOwner ? base58Encode(pubkeyBytes(e.recipientOwner)) : null,
    },
  };
  if (out.extData.extAmount < I64_MIN || out.extData.extAmount > I64_MAX) throw new Error('extAmount out of range');
  if (out.extData.fee < 0n || out.extData.fee > U64_MAX) throw new Error('fee out of range');
  for (const f of [out.args.root, ...out.args.inputNullifiers, ...out.args.outputCommitments]) {
    if (bytesToBigInt(f) >= FIELD_SIZE) throw new Error('Field element out of range');
  }
  if (body.instruction === 'transact_swap') {
    out.args.swapMintField = bytes(a.swapMintField, 32, 'swapMintField');
    out.args.swapAmount = int(a.swapAmount, 'swapAmount');
    out.args.swapCommitment = bytes(a.swapCommitment, 32, 'swapCommitment');
    out.args.swapData = typeof a.swapData === 'string' ? base64ToBytes(a.swapData) : new Uint8Array(0);
    out.args.outputPool = base58Encode(pubkeyBytes(a.outputPool));
  }
  return out;
}

/** Instruction args object (bytes) from a parsed relay request. */
export function argsFromRelay(parsed) {
  const { args, extData } = parsed;
  return {
    ...args,
    extAmount: extData.extAmount,
    fee: extData.fee,
    encryptedOutput1: extData.encryptedOutput1,
    encryptedOutput2: extData.encryptedOutput2,
    encryptedSwapOutput: extData.encryptedSwapOutput,
  };
}
