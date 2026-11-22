# Hosting and embedding

DankSwap is plain static files: HTML, CSS, JS and images. No build step, no server code, no database. Any host that serves files works, including free tiers. Upload the whole folder; links are relative, so it also works in a subfolder (`example.com/swap/`).

Use HTTPS. Wallets, clipboard and "add to home screen" need a secure page.

## Hosts

Each host gets the same security policy: the landing and risk pages cannot be framed by other sites, and `app.html` can be framed so you can embed it.

| Host | What to do | Config used |
|---|---|---|
| **Vercel** (free) | Import the repo, or `npx vercel` in the folder. No build command, output directory `.` | `vercel.json` |
| **Netlify** (free) | Drag the folder onto app.netlify.com/drop, or connect the repo. No build command, publish directory `.` | `_headers` |
| **Cloudflare** (free, recommended) | See "Cloudflare" below | `wrangler.jsonc`, `.assetsignore`, `_headers` |
| **GitHub Pages** (free) | Settings → Pages → deploy from branch, folder `/ (root)` | `.nojekyll`; headers can't be set, so the `<meta>` security policy in each page is used |
| **Firebase Hosting** (free) | `firebase init hosting` (keep the existing `firebase.json`), then `firebase deploy` | `firebase.json` |
| **cPanel, Hostinger, Bluehost, GoDaddy, Namecheap, SiteGround** and other Apache/LiteSpeed shared hosting | Upload everything to `public_html` (or a subfolder) with File Manager or FTP. Make sure hidden files are uploaded too | `.htaccess` |
| **Nginx** (VPS) | Copy files to the web root and add `docs/nginx.conf` to your `server {}` block | `docs/nginx.conf` |
| **IIS, Azure App Service**, Windows hosting | Copy files to the site root | `web.config` |
| **AWS S3 + CloudFront, Google Cloud Storage, Azure Static Web Apps** | Upload the folder, set `index.html` as the index document. Add the headers from `_headers` as a response-headers policy if you can | `<meta>` policy fallback |

To check a deployment: open `https://yourdomain/app.html`, connect a wallet, and run `curl -I https://yourdomain/` to see the headers.

## Cloudflare

The repo is set up for Cloudflare Workers static assets, Cloudflare's current way to host static sites. It's free and serves from Cloudflare's global network. Tested locally on Cloudflare's runtime (`wrangler dev`): every page gets its security headers, and tests, docs, config files and `.git` are not published (`.assetsignore`). `app.html` is also served at `/app`.

Pick one way to deploy:

1. **Dashboard, no code.** Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick `DankSwap`. Leave the build command empty and keep the deploy command `npx wrangler deploy`. Every push to the chosen branch redeploys.
2. **GitHub Actions.** Add the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. `.github/workflows/deploy-cloudflare.yml` runs the tests and deploys on every push to `main`.
3. **Command line.** `npx wrangler login`, then `npx wrangler deploy` in the folder.

The site goes live at `https://dankswap.<your-subdomain>.workers.dev`. To use your own domain: Workers & Pages → dankswap → Settings → Domains & Routes → Add custom domain. The domain's DNS must be on Cloudflare; a free plan works.

Optional, also free: Cloudflare Web Analytics (cookie-free), and WAF or geo-blocking rules under Security if your legal review asks for them.

## Phones and browsers

- Works on iPhone and iPad (iOS 14 and later), Android (Chrome, Samsung Internet, Firefox), and desktop Chrome, Edge, Firefox, Safari, Brave and Opera from 2020 onwards. Older browsers see a message asking them to update instead of a broken page.
- **Inside wallet apps** (Phantom, Solflare, Backpack, Trust Wallet, Coinbase Wallet, OKX, Bitget, Exodus): the wallet is detected automatically. Both Wallet Standard and older injected wallets are supported.
- **In a phone's normal browser**, or in the in-app browsers of X, Telegram, Instagram and others: tapping Connect offers "Open in Phantom / Solflare / Backpack / Trust Wallet / Coinbase Wallet", plus "Copy link" for any other wallet app.
- **Add to home screen** gives the app an icon and opens it full screen.
- Dialogs open as bottom sheets on phones, and the phone's back button closes them.

## Put DankSwap on another website

Pick the option your site builder allows.

**1. Script (resizes itself).** Works on self-hosted WordPress (Custom HTML block), Webflow (Embed), Shopify (Custom Liquid or theme code), Squarespace (Code block), Wix (Embed code → Custom code), Ghost, Framer, Carrd (Pro) and plain HTML:

```html
<script src="https://YOUR-DOMAIN/embed.js" async></script>
```

Optional attributes: `data-height="760"` (starting height in px), `data-max-width="520px"`.

**2. Iframe.** For builders that allow iframes but not scripts:

```html
<iframe src="https://YOUR-DOMAIN/app.html?embed=1" title="DankSwap" style="width:100%;max-width:520px;height:780px;border:0;border-radius:20px" allow="clipboard-write"></iframe>
```

**3. Link.** Works everywhere, including WordPress.com free plans, Linktree, Notion, social bios, emails and QR codes:

```html
<a href="https://YOUR-DOMAIN/app.html">Swap on DankSwap</a>
```

Notion: type `/embed` and paste `https://YOUR-DOMAIN/app.html?embed=1`.

**Notes on embedding**

- Some browser wallets do not connect inside frames on other sites. The embedded app then shows "Open DankSwap in a new tab". On phones, a normal link (option 3) is usually best.
- If the host page has its own Content Security Policy, it must allow your domain in `frame-src` (and in `script-src` for option 1).
- To allow embedding only on your own sites, replace `frame-ancestors *` with your domains (for example `frame-ancestors https://myblog.com https://shop.example`) in `vercel.json`, `_headers`, `.htaccess`, `web.config`, `firebase.json` or `docs/nginx.conf`. To turn embedding off, use `frame-ancestors 'none'`.

## Link previews

Shared links show a preview card (`assets/og.png`) on X, Telegram, Discord, WhatsApp, Slack, iMessage, LinkedIn and Facebook. Some platforms, Facebook and LinkedIn in particular, need an absolute image URL. After you choose a domain, change `content="assets/og.png"` to `content="https://YOUR-DOMAIN/assets/og.png"` in the `og:image` and `twitter:image` tags of the three HTML pages.
