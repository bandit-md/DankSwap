// POST /relay: validate a proof-carrying transact request, rebuild the transaction with the relayer
// as fee payer, simulate it, sign and send (docs/PHASE2_SPEC.md §9). The relayer never holds user
// funds: the pool pays the fee to its fee account only when the proof verifies on-chain.
import { parseRelayRequest, argsFromRelay } from '../../assets/js/pool/encode.js';
import {
  associatedTokenAddress, computeUnitLimitInstruction, transactInstruction, toBuffer, configPda, poolPda, treePda, vaultAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from '../../assets/js/pool/accounts.js';
import { requiredFee } from '../../assets/js/pool/fees.js';
import { isSanctioned } from '../../assets/js/pool/sanctions.js';

export class RelayError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** createAssociatedTokenAccountIdempotent (ATA program instruction 1). */
export function createAtaIdempotentInstruction(web3, payer, ata, owner, mint) {
  const k = (pubkey, isSigner, isWritable) => ({ pubkey: new web3.PublicKey(pubkey), isSigner, isWritable });
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [k(payer, true, true), k(ata, false, true), k(owner, false, false), k(mint, false, false), k(SYSTEM_PROGRAM_ID, false, false), k(TOKEN_PROGRAM_ID, false, false)],
    data: toBuffer(web3, Uint8Array.of(1)),
  });
}

function setComputeUnitPrice(web3, microLamports) {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, BigInt(microLamports), true);
  return new web3.TransactionInstruction({ programId: new web3.PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: toBuffer(web3, data) });
}

const MAX_TX_BYTES = 1232;

/**
 * Accounts worth putting in the relayer's address lookup table: every static account of the pool
 * instructions that is not a signer and not an invoked program.
 */
export function lookupTableAddresses(web3, config) {
  const out = new Set([configPda(web3, config.programId).toBase58(), TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID]);
  for (const t of config.tokens) {
    out.add(poolPda(web3, config.programId, t.mint).toBase58());
    out.add(treePda(web3, config.programId, t.mint).toBase58());
    out.add(vaultAddress(web3, config.programId, t.mint, !!t.native).toBase58());
    if (!t.native) out.add(t.mint);
  }
  return [...out];
}

export class Relayer {
  constructor({ web3, connection, keypair, config, sanctions = isSanctioned, log = console, lookupTables = [] }) {
    this.web3 = web3;
    this.connection = connection;
    this.keypair = keypair;
    this.config = config;
    this.isSanctioned = sanctions;
    this.log = log;
    this.address = keypair.publicKey.toBase58();
    this.inflight = new Set(); // nullifiers being relayed right now
    this.lookupTables = lookupTables;
  }

  /** Load RELAYER_LOOKUP_TABLE (an AddressLookupTableAccount) once at startup. */
  async loadLookupTable() {
    if (!this.config.lookupTable) return null;
    const r = await this.connection.getAddressLookupTable(new this.web3.PublicKey(this.config.lookupTable));
    if (!r.value) throw new Error(`RELAYER_LOOKUP_TABLE ${this.config.lookupTable} not found on ${this.config.cluster}`);
    this.lookupTables = [r.value];
    return r.value;
  }

  info() {
    return {
      relayer: this.address,
      feeBps: this.config.fees.feeBps,
      minFeeLamports: this.config.fees.minFeeLamports,
      createAtaFee: this.config.fees.createAtaFee,
      cluster: this.config.cluster,
      programId: this.config.programId,
      pools: this.config.tokens.map((t) => ({ symbol: t.symbol, mint: t.mint })),
    };
  }

  feeAccount(token) {
    return token.native ? this.address : associatedTokenAddress(this.web3, this.address, token.mint).toBase58();
  }

  async _exists(address) {
    return !!(await this.connection.getAccountInfo(new this.web3.PublicKey(address), 'confirmed'));
  }

  /** Validate and build. Returns { tx, parsed, token, fee, needsAta }. Throws RelayError(400) on bad input. */
  async prepare(body) {
    let parsed;
    try {
      parsed = parseRelayRequest(body);
    } catch (e) {
      throw new RelayError(400, `Bad request: ${e.message}`);
    }
    const token = this.config.tokens.find((t) => t.mint === parsed.pool);
    if (!token) throw new RelayError(400, 'Unknown pool');
    if (parsed.instruction !== 'transact') throw new RelayError(400, 'Private swaps are not relayed on this network');
    const { extData } = parsed;
    if (extData.extAmount > 0n) throw new RelayError(400, 'Deposits are signed by the depositor, not relayed');
    const feeAccount = this.feeAccount(token);
    if (extData.relayer !== feeAccount) throw new RelayError(400, `extData.relayer must be this relayer's fee account ${feeAccount}`);

    let needsAta = false;
    let owner = null;
    if (extData.extAmount === 0n) {
      // Private send: nothing leaves the pool but the fee; the recipient account is unused.
      if (extData.recipient !== feeAccount) throw new RelayError(400, 'For a private send, extData.recipient must equal extData.relayer');
    } else if (token.native) {
      owner = extData.recipient;
    } else {
      owner = extData.recipientOwner;
      if (!owner) throw new RelayError(400, 'extData.recipientOwner (the wallet) is required for token unshields');
      const ata = associatedTokenAddress(this.web3, owner, token.mint).toBase58();
      if (ata !== extData.recipient) throw new RelayError(400, 'extData.recipient must be the associated token account of recipientOwner');
      needsAta = !(await this._exists(ata));
    }
    if (owner && (this.isSanctioned(owner) || this.isSanctioned(extData.recipient))) {
      throw new RelayError(403, 'The recipient is on a sanctions list');
    }

    const withdrawAmount = extData.extAmount < 0n ? -extData.extAmount : 0n;
    const minFee = requiredFee(this.info(), token.symbol, withdrawAmount, needsAta);
    if (extData.fee < minFee) throw new RelayError(400, `Fee too low: at least ${minFee} base units of ${token.symbol}`, { minFee: minFee.toString() });

    const web3 = this.web3;
    const args = argsFromRelay(parsed);
    const instructions = [computeUnitLimitInstruction(web3, this.config.computeUnits)];
    if (this.config.priorityMicroLamports) instructions.push(setComputeUnitPrice(web3, this.config.priorityMicroLamports));
    // Unshield to a wallet without a token account: create it first (idempotent, so a race with
    // the recipient creating it is harmless). Paid by the relayer, covered by createAtaFee.
    if (!token.native && withdrawAmount > 0n && needsAta) {
      instructions.push(createAtaIdempotentInstruction(web3, this.address, extData.recipient, owner, token.mint));
    }
    instructions.push(await transactInstruction(web3, {
      programId: this.config.programId, mint: token.mint, native: !!token.native, signer: this.address,
      nullifiers: args.inputNullifiers, recipient: extData.recipient, relayerFeeAccount: feeAccount, signerTokenAccount: null,
    }, args));
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const message = new web3.TransactionMessage({ payerKey: this.keypair.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(this.lookupTables);
    const tx = new web3.VersionedTransaction(message);
    tx.sign([this.keypair]);
    let size = Infinity;
    try {
      size = tx.serialize().length;
    } catch (_) {}
    if (size > MAX_TX_BYTES) {
      throw new RelayError(400, needsAta
        ? 'The recipient has no token account yet and this relayer has no lookup table to fit creating one. Ask the recipient to create the token account first, or use another relayer.'
        : 'Transaction too large for this relayer configuration.');
    }
    return { tx, parsed, token, fee: extData.fee, needsAta, lastValidBlockHeight };
  }

  /** Full relay: prepare, simulate, send. Returns { signature }. */
  async relay(body) {
    const prep = await this.prepare(body);
    const key = prep.parsed.args.inputNullifiers.map((n) => Buffer.from(n).toString('hex')).join(':');
    if (this.inflight.has(key)) throw new RelayError(409, 'This transaction is already being relayed');
    this.inflight.add(key);
    try {
      const sim = await this.connection.simulateTransaction(prep.tx, { sigVerify: true, commitment: 'confirmed' });
      if (sim.value.err) {
        const logs = (sim.value.logs || []).filter((l) => /Error|failed|AnchorError/i.test(l)).slice(-5);
        throw new RelayError(400, 'Simulation failed: the transaction would not succeed (stale root, spent note, bad proof or fee).', { err: sim.value.err, logs });
      }
      const signature = await this.connection.sendRawTransaction(prep.tx.serialize(), { skipPreflight: true, maxRetries: 5 });
      this.log.info?.(`relayed ${prep.token.symbol} ${prep.parsed.extData.extAmount < 0n ? 'unshield' : 'send'} fee=${prep.fee} sig=${signature}`);
      return { signature };
    } finally {
      this.inflight.delete(key);
    }
  }
}
