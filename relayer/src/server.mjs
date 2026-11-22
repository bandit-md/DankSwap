#!/usr/bin/env node
// DankSwap private pool relayer: GET /info, POST /relay, GET /commitments, GET /health
// (docs/PHASE2_SPEC.md §9). Plain node:http, no framework. UNAUDITED; devnet unless explicitly allowed.
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, parseKeypairSecret, GENESIS } from './config.mjs';
import { Indexer } from './indexer.mjs';
import { Relayer, RelayError } from './relay.mjs';
import { isSanctioned as bundledSanctions } from '../../assets/js/pool/sanctions.js';
import { Rpc } from '../../assets/js/pool/client.js';

const require = createRequire(import.meta.url);
const MAX_BODY = 16 * 1024;

/** Fixed-window per-IP counter. */
export class RateLimiter {
  constructor(perMinute) {
    this.limit = perMinute;
    this.hits = new Map();
    this.window = 60_000;
  }

  allow(ip, now = Date.now()) {
    let e = this.hits.get(ip);
    if (!e || now - e.start >= this.window) {
      e = { start: now, n: 0 };
      this.hits.set(ip, e);
    }
    e.n++;
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (now - v.start >= this.window) this.hits.delete(k);
    return e.n <= this.limit;
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new RelayError(413, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/** Build the request handler. Exported for tests. */
export function createHandler({ config, relayer, indexer, log = console }) {
  const relayLimit = new RateLimiter(config.rateLimit.relayPerMin);
  const readLimit = new RateLimiter(config.rateLimit.readPerMin);
  const started = Date.now();

  return async function handler(req, res) {
    const origin = req.headers.origin;
    const allowAll = config.allowedOrigins.includes('*');
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin' };
    if (origin && (allowAll || config.allowedOrigins.includes(origin))) {
      headers['access-control-allow-origin'] = allowAll ? '*' : origin;
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
      headers['access-control-allow-headers'] = 'content-type';
      headers['access-control-max-age'] = '600';
    }
    const send = (status, obj) => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, 'http://relayer');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        return res.end();
      }
      if (origin && !headers['access-control-allow-origin']) return send(403, { error: 'Origin not allowed' });
      const ip = clientIp(req, config.trustProxy);

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { ok: true, cluster: config.cluster, uptimeSec: Math.round((Date.now() - started) / 1000), indexer: indexer.stats() });
      }
      if (req.method === 'GET' && (url.pathname === '/info' || url.pathname === '/commitments')) {
        if (!readLimit.allow(ip)) return send(429, { error: 'Too many requests. Wait a minute.' });
        if (url.pathname === '/info') return send(200, relayer.info());
        const pool = url.searchParams.get('pool') || '';
        const from = Number(url.searchParams.get('from') || 0);
        if (!Number.isInteger(from) || from < 0) return send(400, { error: 'from must be a non-negative integer' });
        const page = indexer.page(pool, from);
        if (!page) return send(404, { error: 'Unknown pool' });
        return send(200, page);
      }
      if (req.method === 'POST' && url.pathname === '/relay') {
        if (!relayLimit.allow(ip)) return send(429, { error: 'Too many relay requests. Wait a minute.' });
        if (!/application\/json/.test(req.headers['content-type'] || '')) return send(415, { error: 'Send application/json' });
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e instanceof RelayError) throw e;
          return send(400, { error: 'Body is not valid JSON' });
        }
        const out = await relayer.relay(body);
        return send(200, out);
      }
      return send(404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof RelayError) return send(e.status, { error: e.message, ...(e.details ? { details: e.details } : {}) });
      log.error('internal error:', e);
      return send(500, { error: 'Internal error' });
    }
  };
}

/** Wire everything from env and start listening. */
export async function main(env = process.env) {
  const config = loadConfig(env);
  const web3 = require('@solana/web3.js');
  const keypair = web3.Keypair.fromSecretKey(parseKeypairSecret(env.RELAYER_KEYPAIR));
  const connection = new web3.Connection(config.rpcUrl, 'confirmed');
  if (config.checkGenesis) {
    const g = await connection.getGenesisHash();
    if (g !== GENESIS[config.cluster]) throw new Error(`RPC_URL is not ${config.cluster} (genesis ${g}). Refusing to start.`);
  }
  let extra = new Set();
  if (config.extraSanctionsFile) {
    extra = new Set(readFileSync(config.extraSanctionsFile, 'utf8').split(/\s+/).filter(Boolean));
  }
  const sanctions = (a) => bundledSanctions(a) || extra.has(a);
  const relayer = new Relayer({ web3, connection, keypair, config, sanctions });
  await relayer.loadLookupTable();
  const indexer = new Indexer({ rpc: new Rpc([config.rpcUrl]), web3, programId: config.programId, tokens: config.tokens, file: config.indexFile });
  indexer.load();
  indexer.start(config.pollMs);
  const bal = await connection.getBalance(keypair.publicKey).catch(() => null);
  const server = http.createServer(createHandler({ config, relayer, indexer }));
  server.listen(config.port, config.host, () => {
    console.log(`DankSwap relayer on ${config.cluster} at http://${config.host}:${config.port}  relayer=${relayer.address}  balance=${bal === null ? '?' : bal / 1e9} SOL`);
    if (bal !== null && bal < 50_000_000) console.warn('Relayer wallet has under 0.05 SOL; it pays network fees and nullifier rent up front.');
  });
  const stop = () => {
    indexer.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { server, indexer, relayer };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
