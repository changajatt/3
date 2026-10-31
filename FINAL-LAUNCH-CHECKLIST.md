# FINAL-LAUNCH-CHECKLIST.md

Tick in order. **Do not announce the store until every box under "Live test" is ticked.**

## 1. Prepare (no money involved)
- [ ] Provider account approved (PAYMENT-CONNECTION-GUIDE.md §2)
- [ ] OWNER-DETAILS-CHECKLIST.md sections A–E complete
- [ ] Policies read/approved by you (and a lawyer if possible) → `policiesApproved: true`
- [ ] Cloudflare: Durable Object + private R2 bucket created, PDF uploaded, API deployed (SETUP.md §2)
- [ ] Email service domain verified; `EMAIL_FROM` and `SUPPORT_EMAIL` set; a test email reaches your inbox (not spam)
- [ ] Provider webhook endpoint added and **test mode** secrets stored
- [ ] `site-config.js` has `apiBase`; site uploaded to GitHub Pages; hard-refreshed

## 2. Test-mode purchase (provider sandbox/test mode, `PAYMENT_MODE="test"`)
- [ ] Sales page shows **"$27.00 USD"** (from the server) and no "unavailable" notice
- [ ] Buy → provider's hosted checkout opens → pay with a **provider test card**
- [ ] Returns to the order page → shows **Payment confirmed**
- [ ] Email arrives with a download link; link opens the download page; **PDF downloads and opens (75 pages)**
- [ ] Press "Resend my download link" → new email; the **old link no longer works**
- [ ] Refund the test order in the provider dashboard → order page shows **refunded**; link stops; refund email arrives
- [ ] In the provider dashboard "resend webhook" for the paid event → **no second email**

## 3. Live test (real money, tiny)
- [ ] Set `PAYMENT_MODE="live"`, switch to **live** provider keys and **live** webhook; redeploy
- [ ] Buy the product yourself with a real card; repeat the checks in §2
- [ ] Refund yourself; confirm money returns and the payout/bank path works for Pakistan
- [ ] Confirm provider payout setup (bank, currency, thresholds, fees) is understood

## 4. Go live
- [ ] Support inbox monitored; reply process decided; run `node api/scripts/backup.mjs` once and store the file privately
- [ ] Set a Cloudflare rate-limiting rule for `/api/checkout`, `/api/resend` (recommended extra)
- [ ] Add a Cloudflare notification for Worker errors (recommended)
