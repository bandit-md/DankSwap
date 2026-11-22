// Private pool client: balance scan, coin selection and the shield / send / unshield flows
// (docs/PHASE2_SPEC.md §9, §10). No DOM access; web3, fetch and the prover are injected so the
// same code runs in the page and in Node tests.
import { POOL_CONFIG, poolTokens } from './config.js';
import { MerkleTree } from './merkle.js';
import { Note, mintField, tryDecryptNote } from './note.js';
import { decodeAddress } from './keys.js';
import { buildTransaction, instructionArgs, checkPublicSignals } from './transaction.js';
import { encodeProof, relayRequestBody } from './encode.js';
import {
  associatedTokenAddress, computeUnitLimitInstruction, configPda, nullifierPda, transactInstruction,
} from './accounts.js';
import { swapEscrowAccounts } from './swap.js';
import { requiredFee } from './fees.js';
import { isSanctioned } from './sanctions.js';
import { base64ToBytes, bytesToBase64, bytesToHex, fieldToBytes, hexToBytes, bytesToBigInt, isSolanaAddress } from './util.js';

export class PoolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/** JSON-RPC over fetch with endpoint fallback (the first that answers is remembered). */
export class Rpc {
  constructor(urls, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.urls = urls.slice();
    this.fetch = fetchImpl;
    this.good = 0;
    this.id = 0;
  }

  async call(method, params = []) {
    let lastErr = null;
    for (let k = 0; k < this.urls.length; k++) {
      const i = (this.good + k) % this.urls.length;
      try {
        const res = await this.fetch(this.urls[i], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        });
        if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
        const j = await res.json();
        if (j.error) {
          const e = new Error(j.error.message || 'RPC error');
          e.rpc = j.error;
          throw e;
        }
        this.good = i;
        return j.result;
      } catch (e) {
        if (e.rpc) throw e; // a real answer from the node: do not retry elsewhere
        lastErr = e;
      }
    }
    throw lastErr || new Error('No RPC endpoint answered');
  }
}

/** Pick 1 or 2 unspent notes covering `target`, preferring the smallest total (circuit has 2 inputs). */
export function selectNotes(notes, target) {
  const t = BigInt(target);
  const list = notes.filter((n) => n.amount > 0n).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  const one = list.find((n) => n.amount >= t);
  let best = one ? [one] : null;
  let bestSum = one ? one.amount : null;
  const pool = list.slice(-200);
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const s = pool[i].amount + pool[j].amount;
      if (s >= t && (bestSum === null || s < bestSum)) {
        best = [pool[i], pool[j]];
        bestSum = s;
      }
    }
  }
  if (!best) {
    const top2 = list.slice(-2).reduce((s, n) => s + n.amount, 0n);
    const total = list.reduce((s, n) => s + n.amount, 0n);
    if (total >= t) throw new PoolError('FRAGMENTED', 'Your private balance is split over too many notes for one transaction. Send a smaller amount, or move funds to yourself first to combine notes.', { maxSingle: top2 });
    throw new PoolError('INSUFFICIENT', 'Not enough private balance');
  }
  return best;
}

export class PoolClient {
  /**
   * @param {object} o
   * @param {object} o.web3        @solana/web3.js 1.x namespace (window.solanaWeb3 in the page)
   * @param {object} [o.config]    POOL_CONFIG override
   * @param {object} [o.prover]    { prove(input, onProgress) → { proof, publicSignals } }
   * @param {Function} [o.fetch]
   */
  constructor({ web3, config = POOL_CONFIG, prover = null, fetch: fetchImpl } = {}) {
    this.web3 = web3;
    this.config = config;
    this.prover = prover;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.rpc = new Rpc(config.RPC[config.POOL_CLUSTER] || [], this.fetch);
    this.keys = null;
    this.state = new Map(); // mint → { tree, notes: Map<index, Note>, spent: Set<index>, pending: Set<index> }
    this.info = null;
  }

  get cluster() {
    return this.config.POOL_CLUSTER;
  }

  get tokens() {
    return poolTokens(this.config);
  }

  token(symbol) {
    const t = this.tokens.find((x) => x.symbol === symbol);
    if (!t) throw new PoolError('NO_TOKEN', `Unknown token ${symbol}`);
    if (!t.mint) throw new PoolError('NO_POOL', `There is no ${symbol} pool on ${this.cluster}`);
    return t;
  }

  setKeys(keys) {
    this.keys = keys;
    this.state.clear();
  }

  /** Every component refuses mainnet unless explicitly configured (§0): POOL_AUDITED must be true. */
  assertClusterAllowed() {
    if (this.cluster !== 'devnet' && !(this.cluster === 'mainnet' && this.config.POOL_AUDITED === true)) {
      throw new PoolError('CLUSTER', 'The private pool is not enabled on this network.');
    }
  }

  _relayer(path) {
    const base = (this.config.RELAYER_URL || '').replace(/\/+$/, '');
    if (!base) throw new PoolError('NO_RELAYER', 'No relayer is configured for the private pool yet.');
    return base + path;
  }

  async _getJson(path) {
    let res;
    try {
      res = await this.fetch(this._relayer(path), { headers: { accept: 'application/json' } });
    } catch (_) {
      throw new PoolError('RELAYER_DOWN', 'Could not reach the relayer. Check your connection and try again.');
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new PoolError('RELAYER', j.error || `Relayer error (HTTP ${res.status})`);
    return j;
  }

  /** GET /info, cached. Refuses a relayer on another cluster or program. */
  async relayerInfo(force = false) {
    if (this.info && !force) return this.info;
    const info = await this._getJson('/info');
    if (info.cluster !== this.cluster) throw new PoolError('RELAYER', `The relayer runs on ${info.cluster}, this page on ${this.cluster}.`);
    if (info.programId !== this.config.POOL_PROGRAM_ID) throw new PoolError('RELAYER', 'The relayer serves a different pool program.');
    if (!isSolanaAddress(info.relayer)) throw new PoolError('RELAYER', 'The relayer sent an invalid address.');
    this.info = info;
    return info;
  }

  /** True when the program's config account exists on this cluster. */
  async isDeployed() {
    const r = await this.rpc.call('getAccountInfo', [configPda(this.web3, this.config.POOL_PROGRAM_ID).toBase58(), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    return !!(r && r.value);
  }

  _st(mint) {
    if (!this.state.has(mint)) this.state.set(mint, { tree: new MerkleTree(this.config.TREE_LEVELS), notes: new Map(), spent: new Set(), pending: new Set() });
    return this.state.get(mint);
  }

  /**
   * Pull new leaves from the relayer index (GET /commitments), rebuild the tree, and keep the
   * outputs this account can decrypt. Checks that the rebuilt root equals the relayer's.
   */
  async sync(symbol) {
    const t = this.token(symbol);
    const st = this._st(t.mint);
    for (let guard = 0; guard < 10_000; guard++) {
      const from = st.tree.nextIndex;
      const page = await this._getJson(`/commitments?pool=${encodeURIComponent(t.mint)}&from=${from}`);
      const items = Array.isArray(page.items) ? page.items : [];
      const leaves = [];
      items.forEach((it, i) => {
        if (it.index !== from + i) throw new PoolError('INDEX', 'The relayer index has a gap. Try again later.');
        leaves.push(bytesToBigInt(hexToBytes(it.commitment)));
      });
      st.tree.bulkInsert(leaves);
      if (this.keys) {
        items.forEach((it, i) => {
          const note = tryDecryptNote({ index: it.index, commitment: leaves[i], encryptedOutput: base64ToBytes(it.encryptedOutput) }, this.keys, t.mint);
          if (note && note.amount > 0n) st.notes.set(note.index, note);
        });
      }
      if (!items.length || st.tree.nextIndex >= page.nextIndex) {
        if (page.root && st.tree.nextIndex === page.nextIndex && bytesToHex(fieldToBytes(st.tree.root())) !== String(page.root).toLowerCase()) {
          this.state.delete(t.mint);
          throw new PoolError('INDEX', 'The relayer index does not match its own root. Try again later.');
        }
        break;
      }
    }
    return st;
  }

  /** Mark notes whose nullifier account exists on-chain as spent (getMultipleAccounts, 100 per call). */
  async refreshSpent(symbol) {
    const t = this.token(symbol);
    const st = this._st(t.mint);
    const open = [...st.notes.values()].filter((n) => !st.spent.has(n.index));
    for (let i = 0; i < open.length; i += 100) {
      const chunk = open.slice(i, i + 100);
      const keys = chunk.map((n) => nullifierPda(this.web3, this.config.POOL_PROGRAM_ID, fieldToBytes(n.nullifier())).toBase58());
      const r = await this.rpc.call('getMultipleAccounts', [keys, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
      (r.value || []).forEach((acc, k) => {
        if (acc) st.spent.add(chunk[k].index);
      });
    }
    return st;
  }

  /** Sync + spent check, then { balance, notes } for one token. */
  async refresh(symbol) {
    await this.sync(symbol);
    await this.refreshSpent(symbol);
    return { balance: this.balance(symbol), notes: this.unspent(symbol) };
  }

  unspent(symbol) {
    const t = this.token(symbol);
    const st = this._st(t.mint);
    return [...st.notes.values()].filter((n) => !st.spent.has(n.index) && !st.pending.has(n.index));
  }

  balance(symbol) {
    return this.unspent(symbol).reduce((s, n) => s + n.amount, 0n);
  }

  async _accountExists(address) {
    const r = await this.rpc.call('getAccountInfo', [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    return !!(r && r.value);
  }

  async _prove(tx, onProgress) {
    if (!this.prover) throw new PoolError('NO_PROVER', 'Proving is not available');
    const { proof, publicSignals, ms } = await this.prover.prove(tx.input, onProgress);
    checkPublicSignals(tx, publicSignals);
    return { proof, ms, args: instructionArgs(tx, encodeProof(proof)) };
  }

  _requireKeys() {
    if (!this.keys) throw new PoolError('LOCKED', 'Unlock your private balance first.');
  }

  /**
   * Shield: build and prove a deposit. Returns an unsigned v0 transaction (bytes) for the
   * user's wallet; the depositor pays the network fee and nullifier rent (§5: fee 0).
   */
  async buildShield({ symbol, amount, owner, onProgress }) {
    this.assertClusterAllowed();
    this._requireKeys();
    const amt = BigInt(amount);
    if (amt <= 0n) throw new PoolError('AMOUNT', 'Enter an amount');
    if (isSanctioned(owner)) throw new PoolError('SANCTIONED', 'This wallet is on a sanctions list and cannot use the private pool.');
    const t = this.token(symbol);
    const st = await this.sync(symbol);
    const web3 = this.web3;
    const native = !!t.native;
    const ownerTokenAccount = native ? null : associatedTokenAddress(web3, owner, t.mint).toBase58();
    // Deposits: recipient = relayer = the depositor's wallet (spec §5, programs/README.md); they only
    // go into extDataHash. SPL funds come from signer_token_account.
    const counterparty = owner;
    const out = new Note({ amount: amt, pubKey: this.keys.pubKey, encPublic: this.keys.encPublic, mint: t.mint });
    const tx = await buildTransaction({
      tree: st.tree, mintField: mintField(t.mint), inputs: [], outputs: [out],
      extData: { recipient: counterparty, relayer: counterparty, extAmount: amt, fee: 0n },
    });
    const { args, ms, proof } = await this._prove(tx, onProgress);
    const ix = await transactInstruction(web3, {
      programId: this.config.POOL_PROGRAM_ID, mint: t.mint, native, signer: owner,
      nullifiers: args.inputNullifiers, recipient: counterparty, relayerFeeAccount: counterparty,
      signerTokenAccount: ownerTokenAccount,
    }, args);
    const bh = await this.rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const message = new web3.TransactionMessage({
      payerKey: new web3.PublicKey(owner),
      recentBlockhash: bh.value.blockhash,
      instructions: [computeUnitLimitInstruction(web3, this.config.COMPUTE_UNITS), ix],
    }).compileToV0Message();
    const bytes = new web3.VersionedTransaction(message).serialize();
    return { bytes, tx, args, proof, proveMs: ms, lastValidBlockHeight: bh.value.lastValidBlockHeight };
  }

  /** Send a wallet-signed transaction (base64) after a preflight simulation; returns the signature. */
  async sendSigned(signedBytes) {
    return this.rpc.call('sendTransaction', [bytesToBase64(signedBytes), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
  }

  /** Poll until confirmed or the blockhash expires. */
  async confirm(signature, lastValidBlockHeight, { intervalMs = 1500, timeoutMs = 90_000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await this.rpc.call('getSignatureStatuses', [[signature]]);
      const s = r && r.value && r.value[0];
      if (s && s.err) throw new PoolError('TX_FAILED', 'The transaction failed on-chain. No funds moved.');
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s;
      if (lastValidBlockHeight) {
        const h = await this.rpc.call('getBlockHeight', [{ commitment: 'confirmed' }]);
        if (h > lastValidBlockHeight) throw new PoolError('EXPIRED', 'The transaction expired before it landed. No funds moved.');
      }
      await new Promise((r2) => setTimeout(r2, intervalMs));
    }
    throw new PoolError('TIMEOUT', 'Still waiting for confirmation. Check the explorer before retrying.');
  }

  async _spendPlan(symbol, total) {
    await this.refresh(symbol);
    return selectNotes(this.unspent(symbol), total);
  }

  /** Fee the relayer will charge for an unshield of `amount` to `recipientWallet`. */
  async quoteUnshield({ symbol, amount, recipientWallet }) {
    const t = this.token(symbol);
    const info = await this.relayerInfo();
    let needsAta = false;
    let recipient = recipientWallet;
    if (t.native) {
      // A brand-new system account must receive at least the rent-exempt minimum (890,880 lamports).
      if (BigInt(amount) < 890_880n && !(await this._accountExists(recipientWallet))) {
        throw new PoolError('RENT', 'This address has never been used. Send at least 0.00089088 SOL to it, or the network rejects the transfer.');
      }
    } else {
      recipient = associatedTokenAddress(this.web3, recipientWallet, t.mint).toBase58();
      needsAta = !(await this._accountExists(recipient));
    }
    return { fee: requiredFee(info, symbol, BigInt(amount), needsAta), needsAta, recipient, info };
  }

  _relayerFeeAccount(info, t) {
    return t.native ? info.relayer : associatedTokenAddress(this.web3, info.relayer, t.mint).toBase58();
  }

  /** Unshield: `amount` goes to `recipientWallet`, the relayer fee comes on top. Returns the POST /relay body. */
  async buildUnshield({ symbol, amount, recipientWallet, onProgress }) {
    this.assertClusterAllowed();
    this._requireKeys();
    if (!isSolanaAddress(recipientWallet)) throw new PoolError('ADDRESS', 'Enter a valid Solana address');
    if (isSanctioned(recipientWallet)) throw new PoolError('SANCTIONED', 'This address is on a sanctions list. The pool cannot send to it.');
    const amt = BigInt(amount);
    if (amt <= 0n) throw new PoolError('AMOUNT', 'Enter an amount');
    const t = this.token(symbol);
    const q = await this.quoteUnshield({ symbol, amount: amt, recipientWallet });
    const ins = await this._spendPlan(symbol, amt + q.fee);
    const change = ins.reduce((s, n) => s + n.amount, 0n) - amt - q.fee;
    const outputs = change > 0n ? [new Note({ amount: change, pubKey: this.keys.pubKey, encPublic: this.keys.encPublic, mint: t.mint })] : [];
    const st = this._st(t.mint);
    const tx = await buildTransaction({
      tree: st.tree, mintField: mintField(t.mint), inputs: ins, outputs,
      extData: { recipient: q.recipient, relayer: this._relayerFeeAccount(q.info, t), extAmount: -amt, fee: q.fee },
    });
    const { args, ms, proof } = await this._prove(tx, onProgress);
    const body = relayRequestBody({ instruction: 'transact', pool: t.mint, args, extData: tx.extData, recipientOwner: t.native ? undefined : recipientWallet });
    return { body, fee: q.fee, needsAta: q.needsAta, inputs: ins, tx, proof, proveMs: ms };
  }

  /** Private send to a dank… address. The recipient sees the note; nobody else sees the amount. */
  async buildSend({ symbol, amount, to, onProgress }) {
    this.assertClusterAllowed();
    this._requireKeys();
    const dest = decodeAddress(to);
    if (!dest) throw new PoolError('ADDRESS', 'Enter a valid shielded address (starts with dank)');
    const amt = BigInt(amount);
    if (amt <= 0n) throw new PoolError('AMOUNT', 'Enter an amount');
    const t = this.token(symbol);
    const info = await this.relayerInfo();
    const fee = requiredFee(info, symbol, 0n);
    const ins = await this._spendPlan(symbol, amt + fee);
    const change = ins.reduce((s, n) => s + n.amount, 0n) - amt - fee;
    const outputs = [new Note({ amount: amt, pubKey: dest.pubKey, encPublic: dest.encPublic, mint: t.mint })];
    if (change > 0n) outputs.push(new Note({ amount: change, pubKey: this.keys.pubKey, encPublic: this.keys.encPublic, mint: t.mint }));
    const feeAccount = this._relayerFeeAccount(info, t);
    const st = this._st(t.mint);
    // extAmount 0: nothing leaves the pool except the fee. recipient is unused, so it is the
    // relayer's fee account (a valid account of the right kind for this pool).
    const tx = await buildTransaction({
      tree: st.tree, mintField: mintField(t.mint), inputs: ins, outputs,
      extData: { recipient: feeAccount, relayer: feeAccount, extAmount: 0n, fee },
    });
    const { args, ms, proof } = await this._prove(tx, onProgress);
    const body = relayRequestBody({ instruction: 'transact', pool: t.mint, args, extData: tx.extData });
    return { body, fee, inputs: ins, tx, proof, proveMs: ms };
  }

  /** POST /relay. On success the spent inputs are hidden until the next sync confirms them. */
  async relay(built) {
    let res;
    try {
      res = await this.fetch(this._relayer('/relay'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(built.body) });
    } catch (_) {
      throw new PoolError('RELAYER_DOWN', 'Could not reach the relayer. Your funds are still in the pool.');
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.signature) throw new PoolError('RELAYER', j.error || `The relayer refused the transaction (HTTP ${res.status}). Your funds are still in the pool.`);
    const st = this._st(built.body.pool);
    for (const n of built.inputs || []) if (n.index !== null) st.pending.add(n.index);
    return j.signature;
  }

  /**
   * Can this page swap privately? Swaps CPI the pool's configured swap program: Jupiter, which only
   * exists on mainnet (and mainnet needs POOL_AUDITED), or, for dev testing, the mock-swap program
   * when the relayer advertises that route. Returns { ok, code, reason }.
   */
  swapSupport(info = this.info) {
    if (this.cluster !== 'devnet' && !(this.cluster === 'mainnet' && this.config.POOL_AUDITED === true)) {
      return { ok: false, code: 'CLUSTER', reason: 'The private pool is not enabled on this network.' };
    }
    const s = info && info.swap;
    if (s && s.enabled && (this.cluster === 'mainnet' ? s.route === 'jupiter' : s.route === 'mock')) return { ok: true, code: '', reason: '', route: s.route };
    if (this.cluster !== 'mainnet') return { ok: false, code: 'SWAP_DEVNET', reason: 'Private swaps run through Jupiter, which only exists on mainnet.' };
    return { ok: false, code: 'SWAP_UNAVAILABLE', reason: (s && s.reason) || 'The relayer does not offer private swaps.' };
  }

  async _swapInfo() {
    this.assertClusterAllowed();
    let info = null;
    try {
      info = await this.relayerInfo();
    } catch (e) {
      // On devnet a missing relayer reads the same as no swap route.
      if (this.cluster === 'mainnet') throw e;
    }
    const sup = this.swapSupport(info);
    if (!sup.ok) throw new PoolError(sup.code, sup.reason);
    return info;
  }

  _swapTokens(fromToken, toToken) {
    const tIn = this.token(fromToken);
    const tOut = this.token(toToken);
    if (tIn.mint === tOut.mint) throw new PoolError('SWAP_SAME', 'Choose two different tokens');
    return { tIn, tOut };
  }

  /**
   * GET /swap/quote for `amount` (base units of fromToken, the amount that leaves the pool for the
   * swap; the relayer fee comes on top). Returns BigInts: { outAmount, minOut, fee, priceImpactPct,
   * expiresAt, ... }. minOut becomes the proven swapAmount: the note you receive is worth exactly that.
   */
  async quoteSwap({ fromToken, toToken, amount }) {
    const info = await this._swapInfo();
    const { tIn, tOut } = this._swapTokens(fromToken, toToken);
    const amt = BigInt(amount);
    if (amt <= 0n) throw new PoolError('AMOUNT', 'Enter an amount');
    const q = await this._getJson(`/swap/quote?inputMint=${encodeURIComponent(tIn.mint)}&outputMint=${encodeURIComponent(tOut.mint)}&amount=${amt}`);
    if (q.inputMint !== tIn.mint || q.outputMint !== tOut.mint || String(q.amount) !== amt.toString()) throw new PoolError('RELAYER', 'The relayer quoted a different swap.');
    const outAmount = BigInt(q.outAmount);
    const minOut = BigInt(q.minOut);
    if (minOut <= 0n || minOut > outAmount) throw new PoolError('RELAYER', 'The relayer sent an invalid quote.');
    // Never pay less than the published schedule; a quote asking for more is shown as is.
    const scheduleFee = requiredFee(info, tIn.symbol, amt);
    const fee = BigInt(q.feeInInputMint || 0) > scheduleFee ? BigInt(q.feeInInputMint) : scheduleFee;
    return {
      fromToken: tIn.symbol, toToken: tOut.symbol, inputMint: tIn.mint, outputMint: tOut.mint, amount: amt,
      outAmount, minOut, fee, otherAmountThreshold: BigInt(q.otherAmountThreshold || q.minOut),
      priceImpactPct: Number(q.priceImpactPct || 0), slippageBps: Number(q.slippageBps || 0), swapFeeBps: Number(q.swapFeeBps || 0),
      route: q.route, routePlan: q.routePlan || [], expiresAt: Number(q.expiresAt || 0),
    };
  }

  /**
   * Private swap, proving step. Spends `amount + fee` of fromToken (extAmount = -amount into the
   * input pool's escrow, fee to the relayer) and proves a new note of toToken worth quote.minOut,
   * owned by this account and encrypted to its own key (§4 swap public inputs, §5 extData).
   * Returns the POST /relay body ({ instruction: "transact_swap" }).
   */
  async buildSwap({ fromToken, toToken, amount, quote = null, onProgress } = {}) {
    const info = await this._swapInfo();
    this._requireKeys();
    const { tIn, tOut } = this._swapTokens(fromToken, toToken);
    const amt = BigInt(amount);
    if (amt <= 0n) throw new PoolError('AMOUNT', 'Enter an amount');
    let q = quote;
    const stale = !q || q.inputMint !== tIn.mint || q.outputMint !== tOut.mint || BigInt(q.amount) !== amt || (q.expiresAt && Date.now() > q.expiresAt);
    if (stale) q = await this.quoteSwap({ fromToken, toToken, amount: amt });
    const fee = q.fee;
    const ins = await this._spendPlan(tIn.symbol, amt + fee);
    const change = ins.reduce((s, n) => s + n.amount, 0n) - amt - fee;
    const outputs = change > 0n ? [new Note({ amount: change, pubKey: this.keys.pubKey, encPublic: this.keys.encPublic, mint: tIn.mint })] : [];
    const e = swapEscrowAccounts(this.web3, this.config.POOL_PROGRAM_ID, tIn.mint, tOut.mint);
    const st = this._st(tIn.mint);
    const tx = await buildTransaction({
      tree: st.tree, mintField: mintField(tIn.mint), inputs: ins, outputs,
      extData: { recipient: e.escrow, relayer: this._relayerFeeAccount(info, tIn), extAmount: -amt, fee },
      swap: { mintField: mintField(tOut.mint), amount: q.minOut, pubKey: this.keys.pubKey, encPublic: this.keys.encPublic },
    });
    const { args, ms, proof } = await this._prove(tx, onProgress);
    // swapData stays empty: the relayer re-routes |extAmount| and fills in the route itself.
    const body = relayRequestBody({ instruction: 'transact_swap', pool: tIn.mint, args: { ...args, outputPool: tOut.mint }, extData: tx.extData });
    return { body, fee, quote: q, inputs: ins, tx, proof, proveMs: ms, swapNote: tx.swapNote, escrow: e.escrow, toToken: tOut.symbol };
  }

  /**
   * Private swap: quote, prove, relay. The new toToken note shows up after the next sync of the
   * output pool (GET /commitments), like any other incoming note. Returns { signature, built }.
   */
  async swap({ fromToken, toToken, amount, quote = null, onProgress } = {}) {
    const built = await this.buildSwap({ fromToken, toToken, amount, quote, onProgress });
    const signature = await this.relay(built);
    return { signature, built };
  }
}
