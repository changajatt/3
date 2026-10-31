# SETUP.md: deploy and connect the store

Read **OWNER-DETAILS-CHECKLIST.md** first (what you must supply) and **PAYMENT-CONNECTION-GUIDE.md** (choosing and connecting a provider). Run commands from the project folder. You need Node 20+, a free Cloudflare account and a GitHub account.

```
GitHub Pages (static site)  ──HTTPS──▶  Cloudflare Worker (api/)  ──▶  Durable Object "Ledger" (all order state, atomic)
                                                     │                 private R2 bucket (the PDF)
          customer ──▶ provider's hosted checkout ──signed webhook──▶   email service (Resend by default)
```

## 1. Folder layout
`index.html styles.css script.js site-config.js common.js` storefront · `order/download/recover/contact/404 .html` + `order.js download.js` · `privacy|terms|refunds|delivery .html legal.js` · `assets/cover.webp og-image.png robots.txt sitemap.xml` · **`api/`** backend + tests (**not** uploaded to GitHub Pages) · docs.
**Never commit:** `.env`, `.dev.vars`, any `*.pdf`, `private/` (all in `.gitignore`).

## 2. Deploy the API (Cloudflare)
```
cd api
npx wrangler login
npx wrangler r2 bucket create zyvtron-private          # PRIVATE. Do NOT enable public access / r2.dev
npx wrangler r2 object put zyvtron-private/AI-Marketing-Freelancer-System.pdf --file "<path>/AI_Marketing_Freelancer_System__2_.pdf" --content-type application/pdf
# edit wrangler.toml public values (OWNER-DETAILS-CHECKLIST §B), then:
npx wrangler deploy                                     # prints https://zyvtron-api.<you>.workers.dev
```
Put that URL in `API_URL` (wrangler.toml) and redeploy, then in `apiBase` (site-config.js).
Secrets (each prompts for the value; never put them in files):
```
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put <PROVIDER_API_KEY>  &  <PROVIDER_WEBHOOK_SECRET>   # names in PAYMENT-CONNECTION-GUIDE
npx wrangler secret put ADMIN_TOKEN                                         # optional, 24+ random chars
```
The Durable Object and its migration are created automatically from `wrangler.toml`. (Not verified on a real Cloudflare account by me; see limitations.)

## 3. Email (Resend by default)
Create an account, **verify your sending domain** (DNS records), create an API key. `EMAIL_FROM` must be on that domain (e.g. `Zyvtron <orders@yourdomain>`). To use another email service, replace only `sendEmail()` in `api/src/email.js`. Templates (purchase, resend, pending, failed, refund) are in the same file. *Support acknowledgement is not implemented: support is a mailbox, not a web form.*

## 4. Publish the website (GitHub Pages)
1. Edit `site-config.js` (OWNER-DETAILS-CHECKLIST §A).
2. In your repository (**Add file → Upload files**) upload everything **except** `api/`, `*.md` docs and `.env.example` (they may stay in the repo, but the PDF must never be there).
3. **Settings → Pages** → source = main branch. Wait ~2 min, hard-refresh. The site works under the `/2/` project path (all links are relative; `404.html` uses `<base href="/2/">`).

### Custom domain later
Add the domain in Pages (it enforces HTTPS), then change: `canonical`/`og:` URLs in `index.html`, `sitemap.xml`, `robots.txt`, `siteUrl` (site-config.js), `SITE_URL` + `SITE_ORIGIN` (wrangler.toml), `<base href>` in `404.html` (to `/`), then redeploy the API.

## 5. Connect the provider and test
Follow PAYMENT-CONNECTION-GUIDE §2 then FINAL-LAUNCH-CHECKLIST. The buy button stays disabled until the API itself reports that **every** required setting exists, **and** you have a support email, `policiesApproved: true` and `refundTerms`.

## 6. Owner recovery tools (`/api/admin`, enabled only if `ADMIN_TOKEN` is set)
```
curl -s -X POST $API_URL/api/admin -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"action":"get","ref":"<order ref>"}'
```
Actions: `get` (order status + history, emails redacted) · `redeliver` (new link emailed to a **paid** order) · `release` (order held for **review**: you verified the payment in the provider dashboard → mark paid and deliver) · `block` (pause downloads, e.g. a dispute or a refund the provider didn't report) · `unblock` · `erase` (privacy/deletion request: removes the order, link and indexes; delete old backups too) · `export` (full order list for backup). Backup: `ADMIN_TOKEN=… API_URL=… node api/scripts/backup.mjs` → `private/orders-backup-DATE.json` (contains emails: keep private).

## 7. Backup and recovery (honest version)
- The **payment provider's dashboard is the source of truth for money**. The ledger holds order/delivery state.
- Back up the ledger with the script above (weekly is sensible). There is **no automated restore tool**: if the ledger were lost, use the export and the provider's records to fulfil customers manually (send the PDF by email) and re-create nothing automatically.
- Keep your own copy of the final PDF outside Cloudflare.
- A failed email never loses an order: it is recorded as paid with delivery "email failed", the provider is asked to retry the webhook (HTTP 500), and the customer can use *Resend my download link*.

## 8. Run the tests yourself
```
cd api && npm test            # 66 backend tests, no dependencies
node test/local-server.js 8787 http://127.0.0.1:8081    # local API with a TEST-ONLY mock gateway and in-memory data
python3 -m http.server 8081   # (site folder) with apiBase "http://127.0.0.1:8787" to click through the full flow locally
```
