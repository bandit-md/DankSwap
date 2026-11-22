/* Runs first on every page as a classic script, so it also works in browsers that cannot run
 * the app's ES modules. Adds small polyfills, flags embedded mode and explains problems that
 * would otherwise show up as a silently broken page. */
(function () {
  var doc = document.documentElement;
  var embedded = false;
  try {
    embedded = window.self !== window.top;
  } catch (e) {
    embedded = true;
  }
  if (embedded || /[?&]embed=1\b/.test(location.search)) doc.className += ' is-embedded';

  // Element.replaceChildren (Safari < 14, Chrome < 86)
  if (window.Element && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        this.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
      }
    };
  }

  var problem = null;
  var isApp = !!document.querySelector('meta[name="dankswap-app"]');
  var modules = 'noModule' in document.createElement('script');
  if (!window.BigInt || !modules || !window.fetch || !window.Promise) {
    problem = 'Your browser is too old to run DankSwap. Update it, or open this page in a current version of Chrome, Safari, Firefox, Edge or your wallet app.';
  } else if (location.protocol === 'file:' && isApp) {
    problem = 'DankSwap must be opened from a website (https://), not as a file. Wallets do not connect to local files. Upload the folder to your host, or run "npm start" and open http://127.0.0.1:8080/.';
  }
  if (!problem) return;

  function show() {
    var bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.className = 'compat-bar';
    bar.textContent = problem;
    document.body.insertBefore(bar, document.body.firstChild);
  }
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
})();
