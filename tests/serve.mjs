// Tiny static file server for local preview and the e2e test. Usage: node tests/serve.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// Mirror production security headers from _headers (Netlify/Cloudflare format) so tests catch
// CSP and framing problems. "/*" applies everywhere; exact paths add to it.
const RULES = {};
try {
  let current = null;
  for (const line of readFileSync(join(ROOT, '_headers'), 'utf8').split('\n')) {
    if (/^\//.test(line)) {
      current = line.trim();
      RULES[current] = RULES[current] || {};
    } else {
      const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
      if (m && current && m[1] !== 'Strict-Transport-Security') RULES[current][m[1]] = m[2];
    }
  }
} catch (_) {}
const headersFor = (path) => ({ ...(RULES['/*'] || {}), ...(RULES[path] || {}) });

export function startServer(port = 0, { extra } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (extra && extra(req, res)) return;
      const reqPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let p = reqPath;
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) throw new Error('outside root');
      const body = await readFile(file);
      res.writeHead(200, { ...headersFor(reqPath), 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (_) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8080);
  startServer(port).then(() => console.log(`DankSwap at http://127.0.0.1:${port}/`));
}
