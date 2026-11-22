/* Landing page script. Classic script (not a module) so it runs everywhere, including when
 * the page is opened straight from disk. */
(function () {
  // Orbit nodes
  var chains = ['SOL', 'ETH', 'BNB', 'BASE', 'ARB', 'TRX', 'AVAX', 'POL'];
  var g = document.getElementById('orbitNodes');
  if (g) {
    var NS = 'http://www.w3.org/2000/svg';
    chains.forEach(function (c, i) {
      var a = (i / chains.length) * Math.PI * 2 - Math.PI / 2;
      var x = 210 + 165 * Math.cos(a);
      var y = 210 + 165 * Math.sin(a);
      var node = document.createElementNS(NS, 'g');
      node.setAttribute('class', 'node' + (i === 0 ? ' hub' : ''));
      var circ = document.createElementNS(NS, 'circle');
      circ.setAttribute('cx', x);
      circ.setAttribute('cy', y);
      circ.setAttribute('r', 26);
      var t = document.createElementNS(NS, 'text');
      t.setAttribute('x', x);
      t.setAttribute('y', y + 3.5);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = c;
      node.appendChild(circ);
      node.appendChild(t);
      g.appendChild(node);
    });
  }

  // Fee estimator (private pool schedule, proposed)
  var RATES = {
    stable: { bps: 10, label: 'Protocol fee (0.10%)', note: 'Estimate for the shielded pool (Phase 2). Excludes network costs.' },
    swap: { bps: 30, label: 'Protocol fee (0.30%)', note: 'Estimate for the shielded pool (Phase 2). Excludes network costs and price impact.' },
    cross: { bps: 40, label: 'Protocol fee (0.40%)', note: 'Estimate for cross-chain routes (Phase 3). Solver cost is quoted separately before you sign.' },
  };
  var kind = 'stable';
  var size = document.getElementById('feeSize');
  function usd(n) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function set(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function update() {
    if (!size) return;
    var amt = Number(size.value);
    var r = RATES[kind];
    var proto = (amt * r.bps) / 10000;
    var relay = Math.max(0.25, amt * 0.0005);
    set('feeSizeVal', '$' + amt.toLocaleString('en-US'));
    set('feeLabel', r.label);
    set('feeProto', usd(proto));
    set('feeRelay', usd(relay));
    set('feeNet', usd(Math.max(0, amt - proto - relay)));
    set('feeNote', r.note);
  }
  var buttons = document.querySelectorAll('.seg button');
  Array.prototype.forEach.call(buttons, function (b) {
    b.addEventListener('click', function () {
      kind = b.getAttribute('data-kind');
      Array.prototype.forEach.call(buttons, function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      update();
    });
  });
  if (size) size.addEventListener('input', update);
  update();
})();
