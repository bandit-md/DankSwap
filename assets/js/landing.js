import { CONFIG } from './config.js';

// Orbit nodes
const chains = ['SOL', 'ETH', 'BNB', 'BASE', 'ARB', 'TRX', 'AVAX', 'POL'];
const g = document.getElementById('orbitNodes');
if (g) {
  const NS = 'http://www.w3.org/2000/svg';
  chains.forEach((c, i) => {
    const a = (i / chains.length) * Math.PI * 2 - Math.PI / 2;
    const x = 210 + 165 * Math.cos(a);
    const y = 210 + 165 * Math.sin(a);
    const node = document.createElementNS(NS, 'g');
    node.setAttribute('class', 'node' + (i === 0 ? ' hub' : ''));
    const circ = document.createElementNS(NS, 'circle');
    circ.setAttribute('cx', x);
    circ.setAttribute('cy', y);
    circ.setAttribute('r', 26);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x);
    t.setAttribute('y', y + 3.5);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = c;
    node.append(circ, t);
    g.append(node);
  });
}

// Live fee label
const live = document.getElementById('liveFee');
if (live && CONFIG.REFERRAL_ACCOUNT) live.textContent = `+${(CONFIG.REFERRAL_FEE_BPS / 100).toFixed(2)}%`;

// Fee estimator (private pool schedule, proposed)
const RATES = {
  stable: { bps: 10, label: 'Protocol fee (0.10%)', note: 'Estimate for the shielded pool (Phase 2). Excludes network costs.' },
  swap: { bps: 30, label: 'Protocol fee (0.30%)', note: 'Estimate for the shielded pool (Phase 2). Excludes network costs and price impact.' },
  cross: { bps: 40, label: 'Protocol fee (0.40%)', note: 'Estimate for cross-chain routes (Phase 3). Solver cost is quoted separately before you sign.' },
};
let kind = 'stable';
const size = document.getElementById('feeSize');
const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function update() {
  if (!size) return;
  const amt = Number(size.value);
  const r = RATES[kind];
  const proto = (amt * r.bps) / 10000;
  const relay = Math.max(0.25, amt * 0.0005);
  document.getElementById('feeSizeVal').textContent = '$' + amt.toLocaleString('en-US');
  document.getElementById('feeLabel').textContent = r.label;
  document.getElementById('feeProto').textContent = usd(proto);
  document.getElementById('feeRelay').textContent = usd(relay);
  document.getElementById('feeNet').textContent = usd(Math.max(0, amt - proto - relay));
  document.getElementById('feeNote').textContent = r.note;
}

document.querySelectorAll('.seg button').forEach((b) => {
  b.addEventListener('click', () => {
    kind = b.dataset.kind;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    update();
  });
});
if (size) size.addEventListener('input', update);
update();
