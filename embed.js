/* DankSwap embed widget. Paste on any web page (WordPress, Wix, Squarespace, Webflow,
 * Shopify, Ghost, plain HTML...):
 *
 *   <script src="https://YOUR-DANKSWAP-DOMAIN/embed.js" async></script>
 *
 * Optional attributes: data-height="760" (initial px), data-max-width="520px".
 * The widget is an iframe of app.html that resizes itself to fit. If the visitor's wallet does
 * not connect inside the frame, the widget offers to open DankSwap in a new tab. */
(function () {
  var script = document.currentScript;
  if (!script) {
    var all = document.querySelectorAll('script[src*="embed.js"]');
    script = all[all.length - 1];
  }
  if (!script || script.getAttribute('data-dankswap-done')) return;
  script.setAttribute('data-dankswap-done', '1');

  var src = script.src;
  var base = src.slice(0, src.lastIndexOf('/') + 1);
  var origin = new URL(base).origin;

  var frame = document.createElement('iframe');
  frame.src = base + 'app.html?embed=1';
  frame.title = 'DankSwap swap widget';
  frame.setAttribute('allow', 'clipboard-write');
  frame.setAttribute('loading', 'lazy');
  frame.style.cssText =
    'display:block;width:100%;border:0;margin:0 auto;border-radius:20px;background:#08090a;color-scheme:dark;' +
    'max-width:' + (script.getAttribute('data-max-width') || '520px') + ';' +
    'height:' + (parseInt(script.getAttribute('data-height'), 10) || 760) + 'px;';
  script.parentNode.insertBefore(frame, script.nextSibling);

  window.addEventListener('message', function (e) {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (d && d.type === 'dankswap:height' && typeof d.height === 'number') {
      frame.style.height = Math.max(420, Math.min(2400, Math.ceil(d.height))) + 'px';
    }
  });
})();
