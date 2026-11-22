/* Groth16 prover running in a dedicated Web Worker (classic worker, same origin).
 * Loads the vendored snarkjs build and proves with assets/zk/transaction.wasm + transaction_final.zkey.
 * Keeps the downloaded files in memory so later proofs skip the download.
 *
 * Messages in:  { id, type: 'prove', input, wasmUrl, zkeyUrl }
 * Messages out: { id, type: 'progress', stage, pct, detail } | { id, type: 'result', proof, publicSignals, ms }
 *               | { id, type: 'error', message }
 *
 * snarkjs runs single-threaded here (no nested Blob workers), which keeps it working under a
 * strict Content-Security-Policy. It compiles WebAssembly, so if the host sends a CSP header on
 * this script, that header must allow 'wasm-unsafe-eval'. */
/* global snarkjs, importScripts */
'use strict';

importScripts('../../vendor/snarkjs.min.js');

const files = {};

async function download(url, id, stage, pctFrom, pctTo) {
  if (files[url]) return files[url];
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`Could not download ${url.split('/').pop()} (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let data;
  if (res.body && res.body.getReader && total) {
    const reader = res.body.getReader();
    const buf = new Uint8Array(total);
    let got = 0;
    let lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > buf.length) throw new Error('Download larger than announced');
      buf.set(value, got);
      got += value.length;
      const pct = Math.round(pctFrom + ((pctTo - pctFrom) * got) / total);
      if (pct !== lastPct) {
        lastPct = pct;
        postMessage({ id, type: 'progress', stage, pct, detail: `${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` });
      }
    }
    data = got === total ? buf : buf.slice(0, got);
  } else {
    data = new Uint8Array(await res.arrayBuffer());
  }
  files[url] = data;
  return data;
}

// snarkjs logs these steps while proving; map them onto a progress bar.
const STEPS = [
  [/Reading Wtns/i, 62], [/Reading Coeffs/i, 66], [/Building ABC/i, 70], [/QAP AB/i, 74],
  [/QAP C/i, 78], [/Multiexp A/i, 82], [/Multiexp B1/i, 86], [/Multiexp B2/i, 90], [/Multiexp C/i, 94],
];

self.onmessage = async (e) => {
  const { id, type, input, wasmUrl, zkeyUrl } = e.data || {};
  if (type !== 'prove') return;
  const t0 = Date.now();
  try {
    postMessage({ id, type: 'progress', stage: 'download', pct: 0, detail: '' });
    const wasm = await download(wasmUrl, id, 'download', 0, 10);
    const zkey = await download(zkeyUrl, id, 'download', 10, 50);
    postMessage({ id, type: 'progress', stage: 'witness', pct: 55, detail: '' });
    const logger = {
      debug: (m) => {
        const s = STEPS.find(([re]) => re.test(String(m)));
        if (s) postMessage({ id, type: 'progress', stage: 'prove', pct: s[1], detail: String(m) });
      },
      info: () => {}, warn: () => {}, error: (m) => console.error(m),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      { type: 'mem', data: wasm },
      { type: 'mem', data: zkey },
      logger,
      undefined,
      { singleThread: true },
    );
    postMessage({ id, type: 'progress', stage: 'done', pct: 100, detail: '' });
    postMessage({ id, type: 'result', proof, publicSignals, ms: Date.now() - t0 });
  } catch (err) {
    postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
