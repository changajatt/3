# Zyvtron: AI Marketing Freelancer System (store + secure delivery API)

Provider-independent ebook store: static site on GitHub Pages + a small Cloudflare Worker that creates checkouts, **verifies payments by signed webhook**, records orders atomically, emails **expiring** download links and serves the PDF from a **private** bucket.

**Start with:** `OWNER-DETAILS-CHECKLIST.md` → `PAYMENT-CONNECTION-GUIDE.md` → `SETUP.md` → `FINAL-LAUNCH-CHECKLIST.md`. Reports: `TEST-REPORT.md`, `SECURITY-AUDIT.md`.

## Architecture
| Piece | File(s) |
|---|---|
| Sales page, policies, order/download/recover/contact/404 pages | `*.html`, `styles.css`, `script.js`, `common.js`, `order.js`, `download.js`, `legal.js` |
| **All public settings (one place)** | `site-config.js` |
| API routes: product, checkout, webhook, order-status, download-info, download, resend, admin | `api/src/index.js` |
| Atomic order state machine (Durable Object) | `api/src/ledger.js` |
| Provider adapters (isolated) | `api/src/providers/{lemonsqueezy,paddle,stripe,mock}.js` + registry `index.js` |
| Email sender + 5 templates | `api/src/email.js` |
| Tests, local simulator, owner backup script | `api/test/`, `api/scripts/backup.mjs` |

Order lifecycle: **pending → paid → (delivery pending → delivered | email failed) → refunded | disputed**; also **cancelled**, **failed**, **review** (manual). Public pages show: waiting, confirmed, failed, cancelled, refunded, disputed, checking.

## Product facts (verified against the final PDF, 75 pages A4, sha256 prefix `19cb0144…`)
PRISM framework (5 stages) · 24 engineered prompts · 51 Asset Vault assets · 90-day roadmap · 10 end-to-end workflows. The website claims nothing beyond these.

## Status
See `FINAL-LAUNCH-CHECKLIST.md`. In short: **code complete and locally tested; not connected to any real provider, email service or storage; no live test purchase has been made; not ready to take real customers.**
