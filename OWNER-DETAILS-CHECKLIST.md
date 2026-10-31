# OWNER-DETAILS-CHECKLIST.md: only what *you* must supply

Nothing here can be invented by me. Until each item is done the store **stays closed** (the Buy button shows "Purchasing is not open yet", policy pages show "not published yet").

## A. Public values: edit `site-config.js`
| Key | What to enter |
|---|---|
| `supportEmail` | A real inbox you monitor. **Also** set `SUPPORT_EMAIL` in `api/wrangler.toml` (same address). |
| `business.name` | Your legal or trading name as you want it to appear in the policies (an individual's name is acceptable if that is the legal seller). Do not invent a company. |
| `business.jurisdiction` | The country/state whose law governs your terms, e.g. "Pakistan" (confirm with a lawyer). |
| `business.address` | Only if required where you operate; leave `""` otherwise. |
| `policiesUpdated` | Effective date text, e.g. `"1 March 2027"`. |
| `refundTerms` | **Your actual refund and cancellation conditions**, one sentence per item. I deliberately did not write any, because I cannot promise a refund period on your behalf. If you offer none, say so plainly (and check what your payment provider and local consumer law require). |
| `paymentProviderName`, `emailProviderName` | Names of the services you chose (appear in the Privacy Policy). |
| `apiBase` | After deploying the API: its `https://…workers.dev` URL. |
| `policiesApproved` | Set `true` **only** after you (ideally a lawyer) have read and approved `privacy.html`, `terms.html`, `refunds.html`, `delivery.html`. They are **draft templates**, not legal advice and not a claim of compliance anywhere. |

## B. Public (non-secret) API settings: `api/wrangler.toml`
`PAYMENT_PROVIDER`, `PAYMENT_MODE` (`test` → `live`), `API_URL`, `EMAIL_FROM` (on a domain you control and have verified with the email service), `SUPPORT_EMAIL`, provider IDs (`LEMONSQUEEZY_STORE_ID`/`_VARIANT_ID` or `PADDLE_PRICE_ID`), and confirm `PRICE_CENTS = "2700"`.

## C. Secrets: only via `npx wrangler secret put NAME` (never in files)
Provider API key + webhook secret (see PAYMENT-CONNECTION-GUIDE), `RESEND_API_KEY` (or your email service key), and a long random `ADMIN_TOKEN` (24+ characters; enables the owner recovery tool; leave unset to keep it disabled).

## D. Files and accounts
- The **final PDF** (`AI_Marketing_Freelancer_System__2_.pdf`, 75 pages A4, the file I verified) → uploaded to the **private** Cloudflare R2 bucket (never to GitHub).
- Accounts you must create/approve: payment provider, Cloudflare, email service (domain verification), GitHub Pages (already in use).

## E. Business decisions to confirm (I used these defaults)
Price $27.00 USD · download links last 72 hours, 5 downloads · resend limited to once per 10 minutes per email · canonical URL = your GitHub Pages address (change if you adopt a custom domain).
