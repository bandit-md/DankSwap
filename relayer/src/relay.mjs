// POST /relay: validate a proof-carrying transact request, rebuild the transaction with the relayer
// as fee payer, simulate it, sign and send (docs/PHASE2_SPEC.md §9). The relayer never holds user
// funds: the pool pays the fee to its fee account only when the proof verifies on-chain.
import { parseRelayRequest, argsFromRelay } from '../../assets/js/pool/encode.js';
import {
  associatedTokenAddress, createAtaIdempotentInstruction, computeUnitLimitInstruction, transactInstruction, transactSwapInstruction, toBuffer, configPda, poolPda,
  treePda, vaultAddress, escrowPda, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from '../../assets/js/pool/accounts.js';
import { requiredFee } from '../../assets/js/pool/fees.js';
import { isSanctioned } from '../../assets/js/pool/sanctions.js';
import { mintFieldBytes } from '../../assets/js/pool/note.js';
import { equalBytes } from '../../assets/js/pool/util.js';
import {
  swapEscrowAccounts, swapMinOut, slippageForMinOut, swapRemainingAccounts, swapInstructionData, parseSetupInstructions,
  mockReserveAuthority, WSOL_MINT,
} from '../../assets/js/pool/swap.js';
import { SwapRouter, SwapRouteError } from './swap.mjs';

export class RelayError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export { createAtaIdempotentInstruction };

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
export function lookupTableAddresses(web3, config, relayerAddress = null) {
  const out = new Set([configPda(web3, config.programId).toBase58(), TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID]);
  for (const t of config.tokens) {
    out.add(poolPda(web3, config.programId, t.mint).toBase58());
    out.add(treePda(web3, config.programId, t.mint).toBase58());
    out.add(vaultAddress(web3, config.programId, t.mint, !!t.native).toBase58());
    if (!t.native) out.add(t.mint);
  }
  // Private swaps (transact_swap): 18 fixed accounts plus the route only fit 1232 bytes when every
  // static one comes from a table: escrows and their token accounts, the swap program, the
  // relayer's fee / surplus token accounts and, for the dev route, mock-swap's reserve.
  const swap = config.swap || {};
  if (swap.route) {
    out.add(swap.program);
    out.add(ASSOCIATED_TOKEN_PROGRAM_ID);
    out.add(WSOL_MINT);
    for (const a of config.tokens) {
      const escrow = escrowPda(web3, config.programId, poolPda(web3, config.programId, a.mint));
      out.add(escrow.toBase58());
      for (const b of config.tokens) out.add(associatedTokenAddress(web3, escrow, b.mint).toBase58());
      if (relayerAddress && !a.native) out.add(associatedTokenAddress(web3, relayerAddress, a.mint).toBase58());
      if (swap.route === 'mock') out.add(associatedTokenAddress(web3, mockReserveAuthority(web3, swap.program), a.mint).toBase58());
    }
    if (swap.route === 'mock') out.add(mockReserveAuthority(web3, swap.program).toBase58());
  }
  return [...out];
}

/** Signature status poll for the relayer's own setup transactions. */
async function confirmSignature(connection, signature, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await connection.getSignatureStatuses([signature]);
    const st = r && r.value && r.value[0];
    if (st && st.err) throw new RelayError(502, 'The swap setup transaction failed on-chain', { err: st.err });
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st;
    await new Promise((ok) => setTimeout(ok, intervalMs));
  }
  throw new RelayError(504, 'The swap setup transaction did not confirm in time. Try again.');
}

export class Relayer {
  constructor({ web3, connection, keypair, config, sanctions = isSanctioned, log = console, lookupTables = [], fetch: fetchImpl, router }) {
    this.web3 = web3;
    this.connection = connection;
    this.keypair = keypair;
    this.config = config;
    this.isSanctioned = sanctions;
    this.log = log;
    this.address = keypair.publicKey.toBase58();
    this.inflight = new Set(); // nullifiers being relayed right now
    this.lookupTables = lookupTables;
    this.router = router || new SwapRouter({ web3, config, relayer: this.address, fetch: fetchImpl });
    this.altCache = new Map(); // route lookup tables, address → AddressLookupTableAccount
    this.quoteCache = new Map(); // "in|out|amount" → { at, quote }
    this.locks = new Map(); // escrow output account → promise chain (SOL-output swaps re-create it)
    this.setupDelayMs = 1000;
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
      swap: {
        enabled: this.router.enabled,
        route: this.router.enabled ? this.config.swap.route : null,
        program: this.router.enabled ? this.config.swap.program : null,
        slippageBps: this.config.swap?.slippageBps ?? 0,
        swapFeeBps: this.config.swap?.swapFeeBps ?? 0,
        quoteTtlMs: this.config.swap?.quoteTtlMs ?? 0,
        reason: this.router.disabledReason,
      },
    };
  }

  /** Token account that receives output above swapAmount: the relayer itself for SOL, else its ATA. */
  surplusAccount(token) {
    return this.feeAccount(token);
  }

  _swapTokens(inputMint, outputMint) {
    const tin = this.config.tokens.find((t) => t.mint === inputMint);
    const tout = this.config.tokens.find((t) => t.mint === outputMint);
    if (!tin || !tout) throw new RelayError(400, 'Unknown pool');
    if (tin.mint === tout.mint) throw new RelayError(400, 'Choose two different tokens');
    return { tin, tout };
  }

  async _route(opts) {
    try {
      return await this.router.build(opts);
    } catch (e) {
      if (e instanceof SwapRouteError) throw new RelayError(e.status, e.message);
      throw e;
    }
  }

  /**
   * GET /swap/quote: route `amount` (= |extAmount|, base units of the input mint) from the input
   * pool's escrow. minOut is the swapAmount the client should prove: outAmount minus the slippage
   * buffer and the relayer's swap margin. The relayer keeps any output above it (positive
   * slippage) and charges the normal input-mint fee on top of `amount`.
   */
  async quoteSwap({ inputMint, outputMint, amount }) {
    if (!this.router.enabled) throw new RelayError(400, this.router.disabledReason);
    const { tin, tout } = this._swapTokens(inputMint, outputMint);
    let amt;
    try {
      amt = BigInt(amount);
    } catch (_) {
      throw new RelayError(400, 'amount must be an integer');
    }
    if (amt <= 0n || amt >= 1n << 63n) throw new RelayError(400, 'amount must be positive');
    const key = `${tin.mint}|${tout.mint}|${amt}`;
    const now = Date.now();
    const hit = this.quoteCache.get(key);
    if (hit && now - hit.at < 10_000) return hit.quote;
    const sw = this.config.swap;
    const r = await this._route({ inputMint: tin.mint, outputMint: tout.mint, amount: amt });
    const minOut = swapMinOut(r.outAmount, sw.slippageBps, sw.swapFeeBps);
    if (minOut <= 0n) throw new RelayError(400, 'Amount too small to swap');
    const e = swapEscrowAccounts(this.web3, this.config.programId, tin.mint, tout.mint);
    const quote = {
      inputMint: tin.mint,
      outputMint: tout.mint,
      amount: amt.toString(),
      outAmount: r.outAmount.toString(),
      otherAmountThreshold: r.otherAmountThreshold.toString(),
      minOut: minOut.toString(),
      feeInInputMint: requiredFee(this.info(), tin.symbol, amt).toString(),
      slippageBps: sw.slippageBps,
      swapFeeBps: sw.swapFeeBps,
      priceImpactPct: r.priceImpactPct,
      route: r.route,
      routePlan: r.routePlan,
      escrow: e.escrow,
      relayerFeeAccount: this.feeAccount(tin),
      expiresAt: now + sw.quoteTtlMs,
    };
    this.quoteCache.set(key, { at: now, quote });
    if (this.quoteCache.size > 500) for (const [k, v] of this.quoteCache) if (now - v.at > 10_000) this.quoteCache.delete(k);
    return quote;
  }

  async _lookupTable(address) {
    const c = this.altCache.get(address);
    if (c && Date.now() - c.at < 10 * 60_000) return c.table;
    const r = await this.connection.getAddressLookupTable(new this.web3.PublicKey(address));
    if (!r.value) throw new RelayError(502, `Swap route lookup table ${address} not found`);
    this.altCache.set(address, { at: Date.now(), table: r.value });
    return r.value;
  }

  async _missing(addresses) {
    const keys = addresses.map((a) => new this.web3.PublicKey(a));
    const infos = await this.connection.getMultipleAccountsInfo(keys, 'confirmed');
    return addresses.filter((_, i) => !infos[i]);
  }

  /** Sign a v0 transaction; returns { tx, size } (size Infinity when it cannot even serialize). */
  _compile(instructions, tables, blockhash) {
    const web3 = this.web3;
    let tx;
    let size = Infinity;
    try {
      const message = new web3.TransactionMessage({ payerKey: this.keypair.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(tables);
      tx = new web3.VersionedTransaction(message);
      tx.sign([this.keypair]);
      size = tx.serialize().length;
    } catch (_) {}
    return { tx, size };
  }

  _computeBudget() {
    const ixs = [computeUnitLimitInstruction(this.web3, this.config.computeUnits)];
    if (this.config.priorityMicroLamports) ixs.push(setComputeUnitPrice(this.web3, this.config.priorityMicroLamports));
    return ixs;
  }

  /**
   * transact_swap: re-route exactly |extAmount| from the escrow, require the route to deliver at
   * least swapAmount, make sure the escrow token accounts exist, and assemble
   * [compute budget, (account setup), transact_swap(swap_data = route data, remaining = route accounts)]
   * as a v0 transaction with the route's and the relayer's lookup tables.
   */
  async _prepareSwap(parsed, token) {
    const web3 = this.web3;
    if (!this.router.enabled) throw new RelayError(400, `Private swaps are not available on this relayer: ${this.router.disabledReason}`);
    const { extData, args } = parsed;
    const { tin, tout } = this._swapTokens(token.mint, args.outputPool);
    if (extData.extAmount >= 0n) throw new RelayError(400, 'A swap needs extAmount < 0 (the amount leaving the pool)');
    if (args.swapAmount <= 0n) throw new RelayError(400, 'swapAmount must be positive');
    if (!equalBytes(args.swapMintField, mintFieldBytes(tout.mint))) throw new RelayError(400, 'swapMintField does not match the output pool');
    const e = swapEscrowAccounts(web3, this.config.programId, tin.mint, tout.mint);
    if (extData.recipient !== e.escrow) throw new RelayError(400, `For a swap, extData.recipient must be the input pool's escrow ${e.escrow}`);
    const feeAccount = this.feeAccount(tin);
    if (extData.relayer !== feeAccount) throw new RelayError(400, `extData.relayer must be this relayer's fee account ${feeAccount}`);
    const amountIn = -extData.extAmount;
    const minFee = requiredFee(this.info(), tin.symbol, amountIn);
    if (extData.fee < minFee) throw new RelayError(400, `Fee too low: at least ${minFee} base units of ${tin.symbol}`, { minFee: minFee.toString() });

    // Fresh route for exactly the amount the program moves into the escrow.
    const sw = this.config.swap;
    let route = await this._route({ inputMint: tin.mint, outputMint: tout.mint, amount: amountIn });
    if (route.outAmount < args.swapAmount) {
      throw new RelayError(409, `Price moved: the route now returns ${route.outAmount}, below the guaranteed ${args.swapAmount}. Get a new quote.`, { outAmount: route.outAmount.toString() });
    }
    if (route.otherAmountThreshold < args.swapAmount && route.route === 'jupiter') {
      // Tighten Jupiter's own slippage so its on-chain minimum covers swapAmount.
      route = await this._route({ inputMint: tin.mint, outputMint: tout.mint, amount: amountIn, slippageBps: slippageForMinOut(route.outAmount, args.swapAmount) });
    }
    if (route.outAmount < args.swapAmount || route.otherAmountThreshold < args.swapAmount) {
      throw new RelayError(409, `Price moved: the route's minimum ${route.otherAmountThreshold} is below the guaranteed ${args.swapAmount}. Get a new quote.`, { outAmount: route.outAmount.toString() });
    }
    return this._assembleSwap({ parsed, tin, tout, e, feeAccount, route, maxAccounts: sw.maxAccounts });
  }

  async _assembleSwap({ parsed, tin, tout, e, feeAccount, route, maxAccounts, retried = false }) {
    const web3 = this.web3;
    const { extData, args } = parsed;
    if (route.swapInstruction.programId !== this.config.swap.program) throw new RelayError(502, 'The swap route uses a program the pool does not allow');
    let remaining;
    let setup;
    try {
      remaining = swapRemainingAccounts(route.swapInstruction, { escrow: e.escrow, relayer: this.address });
      setup = parseSetupInstructions(route.setupInstructions, { escrow: e.escrow, relayer: this.address });
    } catch (err) {
      throw new RelayError(502, `Unusable swap route: ${err.message}`);
    }
    const surplus = this.surplusAccount(tout);
    // Accounts that must exist before the swap (created idempotently, relayer-paid):
    // the escrow's input and output token accounts (wSOL for a SOL side; the program closes a SOL
    // output account after every swap), the relayer's surplus token account, and route setup.
    const want = new Map();
    want.set(e.escrowInput, { ata: e.escrowInput, owner: e.escrow, mint: tin.mint });
    want.set(e.escrowOutput, { ata: e.escrowOutput, owner: e.escrow, mint: tout.mint });
    if (!tout.native) want.set(surplus, { ata: surplus, owner: this.address, mint: tout.mint });
    for (const s of setup) if (!want.has(s.ata)) want.set(s.ata, s);
    const missing = new Set(await this._missing([...want.keys()]));
    const createIxs = [...want.values()].filter((w) => missing.has(w.ata)).map((w) => createAtaIdempotentInstruction(web3, this.address, w.ata, w.owner, w.mint));

    const swapIx = await transactSwapInstruction(web3, {
      programId: this.config.programId, mint: tin.mint, native: !!tin.native, outputMint: tout.mint, outputNative: !!tout.native,
      signer: this.address, nullifiers: args.inputNullifiers, relayerFeeAccount: feeAccount, relayerSurplusAccount: surplus,
      swapProgram: this.config.swap.program, remainingAccounts: remaining,
    }, { ...argsFromRelay(parsed), swapData: swapInstructionData(route.swapInstruction) });

    const tables = [...this.lookupTables];
    for (const a of route.lookupTables) tables.push(await this._lookupTable(a));
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    // Setup inline when it fits (atomic); otherwise as a separate relayer transaction first.
    let built = this._compile([...this._computeBudget(), ...createIxs, swapIx], tables, blockhash);
    let setupTx = null;
    if (built.size > MAX_TX_BYTES && createIxs.length) {
      built = this._compile([...this._computeBudget(), swapIx], tables, blockhash);
      setupTx = this._compile(createIxs, this.lookupTables, blockhash).tx;
    }
    if (built.size > MAX_TX_BYTES) {
      if (route.route === 'jupiter' && !retried && maxAccounts > 8) {
        // A simpler route (fewer accounts) usually fits.
        const smaller = Math.floor(maxAccounts / 2);
        const r2 = await this._route({ inputMint: tin.mint, outputMint: tout.mint, amount: -extData.extAmount, slippageBps: route.slippageBps, maxAccounts: smaller });
        if (r2.outAmount >= args.swapAmount && r2.otherAmountThreshold >= args.swapAmount) {
          return this._assembleSwap({ parsed, tin, tout, e, feeAccount, route: r2, maxAccounts: smaller, retried: true });
        }
      }
      throw new RelayError(400, this.lookupTables.length
        ? 'This swap route is too large for one transaction. Try a smaller amount or another pair.'
        : 'Swaps need the relayer lookup table (RELAYER_LOOKUP_TABLE) to fit in one transaction.');
    }
    return {
      tx: built.tx, setupTx, parsed, token: tin, outToken: tout, fee: extData.fee, needsAta: false, lastValidBlockHeight,
      swap: { route: route.route, outAmount: route.outAmount, otherAmountThreshold: route.otherAmountThreshold, swapAmount: args.swapAmount, escrowOutput: e.escrowOutput, remaining, createdAccounts: createIxs.length },
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
    if (parsed.instruction === 'transact_swap') return this._prepareSwap(parsed, token);
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
    // Swaps to SOL re-create the escrow's wSOL output account, which every such swap closes:
    // serialize them per escrow account so one swap cannot close it under another.
    const swapKey = body && body.instruction === 'transact_swap' ? `${body.pool}|${body.args && body.args.outputPool}` : null;
    if (!swapKey) return this._relay(body);
    const prev = this.locks.get(swapKey) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this._relay(body));
    const tail = run.catch(() => {});
    this.locks.set(swapKey, tail);
    tail.then(() => {
      if (this.locks.get(swapKey) === tail) this.locks.delete(swapKey);
    });
    return run;
  }

  async _simulate(tx, what) {
    const sim = await this.connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
    if (sim.value.err) {
      const logs = (sim.value.logs || []).filter((l) => /Error|failed|AnchorError|slippage/i.test(l)).slice(-5);
      throw new RelayError(400, `Simulation failed: the ${what} would not succeed (stale root, spent note, bad proof, fee or price move).`, { err: sim.value.err, logs });
    }
    return sim;
  }

  async _relay(body) {
    const prep = await this.prepare(body);
    const key = prep.parsed.args.inputNullifiers.map((n) => Buffer.from(n).toString('hex')).join(':');
    if (this.inflight.has(key)) throw new RelayError(409, 'This transaction is already being relayed');
    this.inflight.add(key);
    try {
      let setupSignature;
      if (prep.setupTx) {
        await this._simulate(prep.setupTx, 'swap account setup');
        setupSignature = await this.connection.sendRawTransaction(prep.setupTx.serialize(), { skipPreflight: true, maxRetries: 5 });
        await confirmSignature(this.connection, setupSignature, { intervalMs: this.setupDelayMs });
      }
      await this._simulate(prep.tx, prep.swap ? 'swap' : 'transaction');
      const signature = await this.connection.sendRawTransaction(prep.tx.serialize(), { skipPreflight: true, maxRetries: 5 });
      if (prep.swap) {
        this.log.info?.(`relayed swap ${prep.token.symbol}->${prep.outToken.symbol} in=${-prep.parsed.extData.extAmount} min=${prep.swap.swapAmount} route=${prep.swap.outAmount} fee=${prep.fee} sig=${signature}`);
        return { signature, ...(setupSignature ? { setupSignature } : {}), outAmount: prep.swap.outAmount.toString() };
      }
      this.log.info?.(`relayed ${prep.token.symbol} ${prep.parsed.extData.extAmount < 0n ? 'unshield' : 'send'} fee=${prep.fee} sig=${signature}`);
      return { signature };
    } finally {
      this.inflight.delete(key);
    }
  }
}
