# SECURITY-AUDIT.md

Scope: the whole project (site, API, ledger, adapters, email, config, tests). Method: code review, 66 automated tests, 25 deliberate "mutation" breakages to prove the tests catch regressions, browser E2E against the real handlers with a mock gateway, and a secret/PDF scan. **Not done:** penetration test, live-provider testing, Cloudflare-side testing.

## A. Problems found in the previous version (all fixed)
| # | Finding | Fix |
|---|---|---|
| 1 | **A valid payment event could be attached to a different order by supplying that order's reference**: the webhook trusted `orderRef` and never compared the provider session/transaction ID with the one stored at checkout. | Session/transaction ID stored at checkout and **must match** (`session_mismatch` → order held for review, no delivery). Missing ID where required → review. Test: "valid payment for session B cannot be attached to order A". |
| 2 | Orders could be **created** from provider events with unknown references. | Unknown references are ignored; orders exist only if our own checkout created them. |
| 3 | State in KV (eventually consistent): concurrent webhooks could double-deliver; download counters could be exceeded. | All state moved to one **Durable Object ledger** (serialised). Tests run 12 concurrent paid events and 10 concurrent downloads. |
| 4 | Download token travelled in a GET URL query. | Tokens only in the **URL fragment**, sent by POST body; no GET download route (tested). |
| 5 | No rate limiting; resend could be abused. | Ledger-level limits: checkout 20/h/IP, resend 1/10 min/email + 10/h/IP, download endpoints 60/h/IP, admin 20/h/IP. Counters use hashed IPs and are purged. |
| 6 | Email failure returned 200 → provider stopped retrying. | Returns 500 so providers retry; the retried event re-attempts delivery once (tested); resend also recovers. |
| 7 | Stripe event trusted without server-side confirmation. | Stripe adapter re-fetches the Checkout Session and compares ID, status, amount, currency and reference. |
| 8 | Refund/dispute/cancel states missing; refunded orders kept working links. | Full state machine; refund revokes the link; disputes block downloads. |
| 9 | Test-mode events could hit the live endpoint. | `PAYMENT_MODE` must match the event's livemode (Stripe/LS) or the event is ignored. |
| 10 | Held-for-review orders couldn't be released (buyer email wasn't kept). | Reviewer email stored separately; admin `release` delivers. Found by a failing test. |
| 11 | Front end: `hidden` attribute overridden by CSS (button stayed visible); hash-only navigation didn't re-validate a new download link. | Fixed; found by the browser E2E. |
| 12 | Purchase button could work without support contact / approved policies. | **Gate**: no checkout until `supportEmail`, `policiesApproved:true`, `refundTerms` exist (browser-tested for each missing item). |

## B. Controls and the tests that prove them
Webhook signature (Stripe, LS, Paddle, mock: tamper, wrong secret, stale, missing) · unknown order · session mismatch · missing session · amount/currency/product mismatch · buyer-identity mismatch · provider mismatch · wrong payment mode · pending/failed/cancelled/refunded/disputed/dispute-won · duplicate event · concurrent events · repeated and simultaneous checkout requests · price tampering by the browser · forged success URL · token invalid/expired/limit/unpaid/revoked · concurrent downloads · missing PDF doesn't consume a download · customer isolation · resend enumeration (identical replies), throttling, link invalidation · email failure and recovery · CORS on every browser endpoint · input validation · log/response secret scan · admin auth, redaction, rate limit · purge · repo hygiene (no PDF/.env).

## C. Residual risks and limitations (not "solved")
1. **Atomicity on real Cloudflare is unverified by me.** The design relies on Durable Object semantics (a single-instance object running one request at a time while code awaits only storage). Tests emulate this with a mutex; they cannot prove Cloudflare's behaviour. The single global ledger instance caps throughput (adequate for a low-volume ebook).
2. **No live provider has been tested.** Adapters follow documentation; Stripe/Paddle/LS request shapes were checked against docs/search excerpts, not sandboxes. Paddle adapter: refunds/chargebacks and the Paddle.js payment-link page are **not implemented**. Lemon Squeezy adapter: amount is **not** verified exactly (MoR tax/FX); price is enforced by `custom_price` + variant/store check.
3. **Email retry relies on the provider re-sending the webhook** (finite retries). After that, delivery is recovered by the customer (resend) or by you (`redeliver`).
4. **Origin checks are not authentication.** CORS stops other websites' browsers, not scripts; the rate limits and tokens are the real protection. Add Cloudflare rate-limit rules as a second layer.
5. **Download link = bearer secret.** Anyone with the link can download until it expires or hits its limit (72 h / 5). Sharing can't be fully prevented; limits and invalidation-on-resend reduce it. The PDF has no per-customer watermark.
6. **PII:** order records hold the buyer's email until you erase them. The owner-only `erase` action (SETUP.md §6) removes an order, its link and its indexes (tested); **backups you made with the export script still contain the email**, so delete those too when honouring a request.
7. **Customer enumeration** is blocked on resend; the order-status endpoint reveals only status for a 128-bit random reference.
8. No dependency risk: the API has **zero runtime dependencies**.
9. The Resend adapter is untested against a live account.

## D. Verdict
Security-critical logic is implemented and tested locally. It has **not** been exercised against real providers or Cloudflare, so treat it as **ready for a sandbox test purchase, not yet proven for live money**.
