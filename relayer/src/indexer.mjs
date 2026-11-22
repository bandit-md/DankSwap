// Commitment indexer: pages the program's signatures over plain RPC (getSignaturesForAddress +
// getTransaction), decodes Anchor `NewCommitment` events from "Program data: " log lines, and keeps
// one leaf list + Merkle tree per pool, persisted to a JSON file (docs/PHASE2_SPEC.md §9).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MerkleTree } from '../../assets/js/pool/merkle.js';
import { decodeNewCommitment, eventDiscriminator } from '../../assets/js/pool/encode.js';
import { poolPda } from '../../assets/js/pool/accounts.js';
import { bytesToBase64, bytesToHex, equalBytes, fieldToBytes, hexToBytes, bytesToBigInt } from '../../assets/js/pool/util.js';

const PAGE = 1000;

/**
 * Extract Anchor events emitted by `programId` itself. Tracks the invoke stack so a different
 * program invoked in the same transaction cannot inject look-alike "Program data:" lines.
 */
export function programDataLines(logs, programId) {
  const stack = [];
  const out = [];
  for (const line of logs || []) {
    let m = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (m) {
      stack.push(m[1]);
      continue;
    }
    m = /^Program (\S+) (success|failed)/.exec(line);
    if (m) {
      if (stack[stack.length - 1] === m[1]) stack.pop();
      continue;
    }
    m = /^Program data: (\S+)$/.exec(line);
    if (m && stack[stack.length - 1] === programId) out.push(Uint8Array.from(Buffer.from(m[1], 'base64')));
  }
  return out;
}

export class Indexer {
  /**
   * @param {object} o
   * @param {{ call(method, params): Promise<any> }} o.rpc  plain JSON-RPC client (assets/js/pool/client.js Rpc)
   * @param {object} o.web3
   * @param {string} o.programId
   * @param {Array<{symbol, mint}>} o.tokens
   * @param {string} [o.file]  JSON persistence path ('' = memory only)
   */
  constructor({ rpc, web3, programId, tokens, file = '', levels = 20, log = console }) {
    this.rpc = rpc;
    this.web3 = web3;
    this.programId = programId;
    this.file = file;
    this.levels = levels;
    this.log = log;
    this.pools = new Map(); // mint → { symbol, poolPda, items: [], pending: Map<index, item>, tree }
    this.byPda = new Map();
    for (const t of tokens) {
      const pda = poolPda(web3, programId, t.mint).toBase58();
      const p = { symbol: t.symbol, mint: t.mint, poolPda: pda, items: [], pending: new Map(), tree: new MerkleTree(levels) };
      this.pools.set(t.mint, p);
      this.byPda.set(pda, p);
    }
    this.lastSignature = null;
    this.lastSync = null;
    this.syncing = null;
    this.disc = null;
  }

  load() {
    if (!this.file) return;
    let j;
    try {
      j = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') this.log.warn('index file unreadable, rebuilding from RPC:', e.message);
      return;
    }
    if (j.programId !== this.programId) {
      this.log.warn('index file is for another program, rebuilding');
      return;
    }
    this.lastSignature = j.lastSignature || null;
    for (const [mint, saved] of Object.entries(j.pools || {})) {
      const p = this.pools.get(mint);
      if (!p) continue;
      for (const it of saved.items || []) this._add(p, it);
      for (const it of saved.pending || []) this._add(p, it);
    }
  }

  save() {
    if (!this.file) return;
    const pools = {};
    for (const [mint, p] of this.pools) pools[mint] = { items: p.items, pending: [...p.pending.values()] };
    const body = JSON.stringify({ programId: this.programId, lastSignature: this.lastSignature, savedAt: new Date().toISOString(), pools });
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, this.file);
  }

  /** Add one leaf. Out-of-order leaves wait in `pending` until the gap fills. */
  _add(p, it) {
    if (it.index < p.items.length) {
      if (p.items[it.index].commitment !== it.commitment) this.log.warn(`conflicting leaf ${it.index} in ${p.symbol} ignored`);
      return;
    }
    p.pending.set(it.index, it);
    const batch = [];
    while (p.pending.has(p.items.length + batch.length)) batch.push(p.pending.get(p.items.length + batch.length));
    for (const b of batch) p.pending.delete(b.index);
    if (batch.length) {
      p.items.push(...batch);
      p.tree.bulkInsert(batch.map((b) => bytesToBigInt(hexToBytes(b.commitment))));
    }
  }

  async _events(logs) {
    if (!this.disc) this.disc = await eventDiscriminator('NewCommitment');
    const events = [];
    for (const data of programDataLines(logs, this.programId)) {
      if (data.length < 8 || !equalBytes(data.subarray(0, 8), this.disc)) continue;
      try {
        events.push(decodeNewCommitment(data.subarray(8)));
      } catch (e) {
        this.log.warn('bad NewCommitment event:', e.message);
      }
    }
    return events;
  }

  /** Apply the events of one confirmed transaction (exported for tests). */
  async applyTransaction(tx) {
    if (!tx || !tx.meta || tx.meta.err) return 0;
    const logs = tx.meta.logMessages || [];
    if (logs.some((l) => /Log truncated/i.test(l))) this.log.warn('truncated logs in a pool transaction; events may be missing');
    let n = 0;
    for (const ev of await this._events(logs)) {
      const p = this.byPda.get(ev.pool);
      if (!p) continue;
      this._add(p, { index: ev.index, commitment: bytesToHex(fieldToBytes(ev.commitment)), encryptedOutput: bytesToBase64(ev.encryptedOutput) });
      n++;
    }
    return n;
  }

  /** One pass: fetch every signature newer than lastSignature, oldest first, and apply them. */
  async syncOnce() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const sigs = [];
      let before;
      for (;;) {
        const opts = { limit: PAGE, commitment: 'confirmed' };
        if (before) opts.before = before;
        if (this.lastSignature) opts.until = this.lastSignature;
        const page = (await this.rpc.call('getSignaturesForAddress', [this.programId, opts])) || [];
        if (!page.length) break;
        sigs.push(...page);
        before = page[page.length - 1].signature;
        if (page.length < PAGE) break;
      }
      sigs.reverse(); // oldest first
      let applied = 0;
      for (const s of sigs) {
        if (!s.err) {
          const tx = await this.rpc.call('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
          if (!tx) break; // not served yet: retry from here next time
          applied += await this.applyTransaction(tx);
        }
        this.lastSignature = s.signature;
      }
      this.lastSync = new Date().toISOString();
      if (sigs.length) this.save();
      return applied;
    })();
    try {
      return await this.syncing;
    } finally {
      this.syncing = null;
    }
  }

  start(intervalMs) {
    const tick = () => this.syncOnce().catch((e) => this.log.warn('index sync failed:', e.message));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** GET /commitments page. Only the gap-free prefix is served, with its root. */
  page(mint, from, limit = PAGE) {
    const p = this.pools.get(mint);
    if (!p) return null;
    const start = Math.max(0, Math.min(from, p.items.length));
    return {
      items: p.items.slice(start, start + limit),
      nextIndex: p.items.length,
      root: bytesToHex(fieldToBytes(p.tree.root())),
    };
  }

  stats() {
    const pools = {};
    for (const p of this.pools.values()) pools[p.symbol] = { leaves: p.items.length, waiting: p.pending.size };
    return { lastSync: this.lastSync, lastSignature: this.lastSignature, pools };
  }
}
