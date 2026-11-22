// Groth16 proving (docs/PHASE2_SPEC.md §10). In the browser the work runs in prover.worker.js so
// the page stays responsive; in Node (tests, scripts) pass a snarkjs module to proveInProcess.

/** Stringify every bigint in a circuit input object (snarkjs accepts decimal strings). */
export function stringifyInput(input) {
  const s = (v) => (Array.isArray(v) ? v.map(s) : typeof v === 'bigint' ? v.toString() : typeof v === 'number' ? String(v) : v);
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = s(v);
  return out;
}

export class Prover {
  /**
   * @param {object} o
   * @param {string|URL} o.wasmUrl, o.zkeyUrl  absolute or page-relative URLs of the proving files
   * @param {string|URL} [o.workerUrl]        defaults to ./prover.worker.js next to this module
   */
  constructor({ wasmUrl, zkeyUrl, workerUrl } = {}) {
    this.wasmUrl = String(new URL(wasmUrl, globalThis.location ? location.href : undefined));
    this.zkeyUrl = String(new URL(zkeyUrl, globalThis.location ? location.href : undefined));
    this.workerUrl = workerUrl || new URL('./prover.worker.js', import.meta.url);
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') throw new Error('This browser cannot run background workers, which proving needs');
    const w = new Worker(this.workerUrl);
    w.onmessage = (e) => {
      const m = e.data || {};
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        if (p.onProgress) p.onProgress({ stage: m.stage, pct: m.pct, detail: m.detail });
      } else if (m.type === 'result') {
        this.pending.delete(m.id);
        p.resolve({ proof: m.proof, publicSignals: m.publicSignals, ms: m.ms });
      } else if (m.type === 'error') {
        this.pending.delete(m.id);
        p.reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      const err = new Error((e && e.message) || 'The prover stopped unexpectedly');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
      try {
        w.terminate();
      } catch (_) {}
    };
    this.worker = w;
    return w;
  }

  /** Prove; resolves { proof, publicSignals, ms }. onProgress({ stage, pct, detail }). */
  prove(input, onProgress) {
    const w = this._ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ id, type: 'prove', input: stringifyInput(input), wasmUrl: this.wasmUrl, zkeyUrl: this.zkeyUrl });
    });
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

/** Prove in the current thread with a given snarkjs module (Node tests). */
export async function proveInProcess(snarkjs, input, wasm, zkey) {
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(stringifyInput(input), wasm, zkey, undefined, undefined, { singleThread: true });
  return { proof, publicSignals, ms: Date.now() - t0 };
}
