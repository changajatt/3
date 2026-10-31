# PAYMENT-CONNECTION-GUIDE.md

**You choose the provider; the store does not change.** Everything provider-specific lives in one file per provider (`api/src/providers/`). Switching provider = change `PAYMENT_PROVIDER`, secrets and IDs in `api/wrangler.toml`, then redeploy. The site, orders, emails and delivery do not change.

> **Nothing below means any provider has approved your business.** Approval, payouts and fees are decided by the provider. Verify every point on the provider's own pages before you apply.

## 1. Eligibility for a business operated from Pakistan (researched 30 Oct 2026; re-check before applying)

| Provider | Finding | Confidence / source |
|---|---|---|
| **Lemon Squeezy** (merchant of record) | Pakistan is listed on Lemon Squeezy's own **supported countries / bank payout** page. Hosted checkout; they act as seller of record and handle sales tax. **Caveat:** several 2026 articles say Lemon Squeezy (owned by Stripe) is steering customers toward "Stripe Managed Payments", and reports mention slower support. I found **no confirmed shutdown or closure to new sellers**, but I could not verify its current onboarding status. Check at signup. | Primary: docs.lemonsqueezy.com "Supported Countries". Direction-of-travel: secondary articles (unverified). |
| **Paddle** (merchant of record) | Pakistan appeared in Paddle's published supported-countries information. Paddle **reviews each seller and product**; approval of an *ebook* specifically is uncertain and some sellers report rejections. Checkout also requires a page on your own site running Paddle.js ("default payment link"), which is **not included** in this project. | Primary: developer.paddle.com supported countries and acceptable-use pages. Approval odds: unknown. |
| **Stripe** | Multiple sources (including a payments firm's South Asia guide) say Stripe **does not onboard Pakistan-registered businesses**. One aggregator site claims otherwise. Treat as **not available** unless you independently hold an eligible Stripe account (e.g. through a legitimately registered business in a supported country, which has its own legal/tax requirements). Stripe is kept only as an **optional adapter**. | Mixed. Confirm at stripe.com/global. |
| **Payhip / Gumroad / others** | **No adapter**: I did not verify their webhook/API documentation, so I did not write code from memory. They can still be used in **hosted-link mode** (set `checkoutUrl`; the provider delivers the file itself), but then the order ledger, expiring links, resend page and refund/dispute handling **do not apply**. | Not researched in depth. |

**Recommendation (not a guarantee):** apply to **Lemon Squeezy first** (best documented fit; adapter fully implemented). If rejected or unavailable, apply to Paddle. Do not pay for or promise anything to customers until an account is approved **and** a test purchase works end to end.

## 2. What each provider needs from you

### A. Lemon Squeezy (`PAYMENT_PROVIDER = "lemonsqueezy"`)
1. Create a store; complete their identity/payout verification.
2. Create a product **"AI Marketing Freelancer System"** with one variant priced **$27.00 USD**. (Our checkout also sends a server-set `custom_price`, but set the variant price to match.) You do **not** need to upload the PDF there; delivery is done by this project.
3. Note the **Store ID** and **Variant ID** → `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID` in `api/wrangler.toml`.
4. Settings → API → create an API key → `wrangler secret put LEMONSQUEEZY_API_KEY`.
5. Settings → Webhooks → add `https://<API_URL>/api/webhook`, choose a long random **signing secret** → `wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET`. Subscribe to: **`order_created`, `order_refunded`**.
6. Keep `PAYMENT_MODE = "test"`, use Lemon Squeezy **test mode**, run the test purchase (see FINAL-LAUNCH-CHECKLIST). Then switch to live: set `PAYMENT_MODE = "live"`, put the **live** API key and a **live** webhook, redeploy.
7. Known characteristics (from their docs): LS adds tax and converts currency, so the adapter verifies the **variant and store IDs** and the order reference instead of an exact amount; events have no unique id, so duplicates are blocked on `event name + order id`; this adapter handles **order creation and full refunds only**; I did not verify a dispute event, so if a dispute is opened in the Lemon Squeezy dashboard, pause that order's downloads yourself with the admin `block` action (SETUP.md §6).

### B. Paddle (`PAYMENT_PROVIDER = "paddle"`)
Seller verification and **product approval** → create a product and a **$27.00 USD** price → `PADDLE_PRICE_ID` (vars), `PADDLE_API_KEY` (secret) → notification destination `https://<API_URL>/api/webhook`, subscribe to **`transaction.completed`**, store its secret as `PADDLE_WEBHOOK_SECRET` → set up and **get approved** a *default payment link* page on your site that runs Paddle.js (not provided; see Paddle docs). **Not implemented:** Paddle refunds/chargebacks (a refund or chargeback in Paddle will not revoke a download link automatically; use the admin `block` action (SETUP.md §6)). Sandbox first: `PAYMENT_MODE="test"` uses Paddle's sandbox API host.

### C. Stripe, optional (`PAYMENT_PROVIDER = "stripe"`)
Only if you independently hold an eligible Stripe account. Secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; webhook to `https://<API_URL>/api/webhook` with: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`. Stripe is the only adapter with server-side re-verification (it re-fetches the session and compares ID, status, amount, currency and reference).

### D. Hosted-link mode (provider delivers the file itself)
Set `checkoutUrl` (https) and leave `apiBase` empty. Only the sales page, policies and purchase gate apply. You must verify delivery and refunds in that provider's dashboard.

## 3. Test checklist per provider (you must do this; I could not)
Sandbox/test purchase → order page shows *Payment confirmed* → email arrives → download works → refund in dashboard → order page shows *refunded*, old link stops → resend works → a second identical webhook (use the provider's "resend event") does not send another email.

## 4. Adding any other provider
Copy `api/src/providers/lemonsqueezy.js`, implement the three functions described at the top of `api/src/providers/index.js`, register it, and add tests modelled on `api/test/providers.test.js`. **The adapter must verify the provider's signature before trusting anything.**
