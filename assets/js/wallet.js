// Minimal Wallet Standard client (https://github.com/wallet-standard/wallet-standard).
// Phantom, Solflare, Backpack, Glow and most Solana wallets register through this protocol,
// so no wallet-adapter bundle is needed. Transactions are signed as raw bytes.

const SOLANA_MAINNET = 'solana:mainnet';
const STORAGE_KEY = 'dankswap.wallet';

const wallets = [];
const listeners = new Set();

function isSolanaWallet(w) {
  return (
    w &&
    Array.isArray(w.chains) &&
    w.chains.some((c) => c.startsWith('solana:')) &&
    w.features &&
    w.features['standard:connect'] &&
    w.features['solana:signTransaction']
  );
}

const sameName = (a, b) => a.toLowerCase().replace(/\s+wallet$/, '') === b.toLowerCase().replace(/\s+wallet$/, '');

function register(...list) {
  let added = false;
  for (const w of list) {
    if (!isSolanaWallet(w) || wallets.includes(w)) continue;
    const dup = wallets.findIndex((x) => sameName(x.name, w.name));
    if (dup !== -1) {
      // A Wallet Standard registration replaces a legacy wrapper of the same wallet.
      if (wallets[dup].__legacy && !w.__legacy) {
        wallets[dup] = w;
        added = true;
      }
      continue;
    }
    wallets.push(w);
    added = true;
  }
  if (added) listeners.forEach((fn) => fn(getWallets()));
  return () => {};
}

const api = Object.freeze({ register });

if (typeof window !== 'undefined') {
  window.addEventListener('wallet-standard:register-wallet', (e) => {
    try {
      e.detail(api);
    } catch (err) {
      console.warn('Wallet registration failed', err);
    }
  });
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch (err) {
    console.warn(err);
  }
}

/* ---------- Legacy injected providers ----------
 * Some wallets, mostly older versions and some mobile in-app browsers, only inject a
 * window.* provider that signs web3.js transaction objects. For those, web3.js is loaded on
 * demand (vendored, same origin) and wrapped to look like a Wallet Standard wallet. */
const LEGACY = [
  ['Phantom', () => window.phantom && window.phantom.solana],
  ['Solflare', () => window.solflare],
  ['Backpack', () => window.backpack],
  ['Coinbase Wallet', () => window.coinbaseSolana],
  ['Trust Wallet', () => window.trustwallet && (window.trustwallet.solana || window.trustwallet)],
  ['OKX Wallet', () => window.okxwallet && window.okxwallet.solana],
  ['Bitget Wallet', () => window.bitkeep && window.bitkeep.solana],
  ['Exodus', () => window.exodus && window.exodus.solana],
  ['Solana wallet', () => window.solana],
];

let web3Promise = null;
function loadWeb3() {
  if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3);
  if (!web3Promise) {
    web3Promise = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/solana-web3.iife.min.js', import.meta.url).href;
      s.onload = () => (window.solanaWeb3 ? ok(window.solanaWeb3) : fail(new Error('web3 failed to load')));
      s.onerror = () => {
        web3Promise = null;
        fail(new Error('Could not load the wallet helper. Check your connection.'));
      };
      document.head.appendChild(s);
    });
  }
  return web3Promise;
}

function wrapLegacy(name, provider) {
  let account = null;
  const toAccount = (pk) => (pk ? { address: pk.toString(), publicKey: pk.toBytes ? pk.toBytes() : new Uint8Array(32), chains: [SOLANA_MAINNET], features: ['solana:signTransaction'] } : null);
  const w = {
    __legacy: true,
    version: '1.0.0',
    name,
    icon: typeof provider.icon === 'string' ? provider.icon : '',
    chains: [SOLANA_MAINNET],
    get accounts() {
      return account ? [account] : [];
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async (opts) => {
          const res = await provider.connect(opts && opts.silent ? { onlyIfTrusted: true } : undefined);
          account = toAccount((res && res.publicKey) || provider.publicKey);
          return { accounts: account ? [account] : [] };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          account = null;
          if (provider.disconnect) await provider.disconnect();
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (ev, cb) => {
          if (ev !== 'change' || !provider.on) return () => {};
          const h = (pk) => {
            account = toAccount(pk);
            cb({ accounts: account ? [account] : [] });
          };
          provider.on('accountChanged', h);
          return () => (provider.off || provider.removeListener || (() => {})).call(provider, 'accountChanged', h);
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => {
          const web3 = await loadWeb3();
          const out = [];
          for (const input of inputs) {
            const tx = web3.VersionedTransaction.deserialize(input.transaction);
            const signed = await provider.signTransaction(tx);
            out.push({ signedTransaction: signed.serialize() });
          }
          return out;
        },
      },
    },
  };
  return w;
}

function scanLegacy() {
  const seen = new Set();
  for (const [name, get] of LEGACY) {
    let p;
    try {
      p = get();
    } catch (_) {
      continue;
    }
    if (!p || typeof p.connect !== 'function' || typeof p.signTransaction !== 'function' || seen.has(p)) continue;
    seen.add(p);
    // window.solana is often an alias of a named wallet; name it if we can.
    let label = name;
    if (name === 'Solana wallet') {
      if (p.isPhantom) label = 'Phantom';
      else if (p.isSolflare) label = 'Solflare';
      else if (p.isBackpack) label = 'Backpack';
      else if (p.isTrust || p.isTrustWallet) label = 'Trust Wallet';
      else if (p.isCoinbaseWallet) label = 'Coinbase Wallet';
    }
    if (wallets.some((x) => sameName(x.name, label))) continue;
    register(wrapLegacy(label, p));
  }
}

if (typeof window !== 'undefined') {
  // Give Wallet Standard wallets first chance to register, then look for legacy providers.
  setTimeout(scanLegacy, 300);
  window.addEventListener('load', () => setTimeout(scanLegacy, 300));
}

export function getWallets() {
  return wallets.slice();
}

export function onWalletsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A connected session around one Wallet Standard wallet. */
export class WalletSession {
  constructor(wallet, account) {
    this.wallet = wallet;
    this.account = account;
    this._off = null;
    this.onChange = null;
    const events = wallet.features['standard:events'];
    if (events) {
      this._off = events.on('change', ({ accounts }) => {
        if (!accounts) return;
        this.account = accounts[0] || null;
        if (this.onChange) this.onChange(this.account);
      });
    }
  }

  get address() {
    return this.account ? this.account.address : null;
  }

  get name() {
    return this.wallet.name;
  }

  get icon() {
    return this.wallet.icon;
  }

  /** Sign a serialized transaction. Returns the signed bytes. */
  async signTransaction(bytes) {
    const feature = this.wallet.features['solana:signTransaction'];
    const [out] = await feature.signTransaction({
      account: this.account,
      transaction: bytes,
      chain: SOLANA_MAINNET,
    });
    if (!out || !out.signedTransaction) throw new Error('Wallet returned no signed transaction');
    return out.signedTransaction;
  }

  async disconnect() {
    try {
      if (this._off) this._off();
      const f = this.wallet.features['standard:disconnect'];
      if (f) await f.disconnect();
    } catch (e) {
      console.warn(e);
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }
}

export async function connect(wallet, { silent = false } = {}) {
  const feature = wallet.features['standard:connect'];
  const res = await feature.connect(silent ? { silent: true } : undefined);
  const accounts = (res && res.accounts && res.accounts.length ? res.accounts : wallet.accounts) || [];
  const account = accounts.find((a) => !a.chains || a.chains.some((c) => c.startsWith('solana:'))) || accounts[0];
  if (!account) throw new Error(silent ? 'Not authorised' : 'No account was shared by the wallet');
  try {
    localStorage.setItem(STORAGE_KEY, wallet.name);
  } catch (_) {}
  return new WalletSession(wallet, account);
}

export function lastWalletName() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

export function isMobile() {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')) return true;
  // iPadOS reports a desktop UA; fall back to touch + coarse pointer.
  return navigator.maxTouchPoints > 1 && window.matchMedia && matchMedia('(pointer: coarse)').matches;
}

/** Links that reopen this page inside a mobile wallet's built-in browser. */
export function mobileDeepLinks() {
  const url = encodeURIComponent(location.href);
  const ref = encodeURIComponent(location.origin);
  return [
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
    { name: 'Backpack', href: `https://backpack.app/ul/v1/browse/${url}?ref=${ref}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=501&url=${url}` },
    { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${url}` },
  ];
}

export const INSTALL_LINKS = [
  { name: 'Phantom', href: 'https://phantom.com/download' },
  { name: 'Solflare', href: 'https://solflare.com/download' },
  { name: 'Backpack', href: 'https://backpack.app/download' },
];
