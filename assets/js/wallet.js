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

function register(...list) {
  let added = false;
  for (const w of list) {
    if (!isSolanaWallet(w) || wallets.includes(w)) continue;
    if (wallets.some((x) => x.name === w.name)) continue;
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
  ];
}

export const INSTALL_LINKS = [
  { name: 'Phantom', href: 'https://phantom.com/download' },
  { name: 'Solflare', href: 'https://solflare.com/download' },
  { name: 'Backpack', href: 'https://backpack.app/download' },
];
