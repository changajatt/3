# TEST-REPORT.md

Run on 30 Oct 2026 in a sandbox with **no internet access to payment providers, email services or Cloudflare**. Chromium (Playwright), Node 22, Python 3.12.

## Totals (all actually run; none skipped)
| Suite | Where | Passed | Failed | Skipped |
|---|---|---|---|---|
| Backend unit + integration (payments, delivery, security, providers, email) | `api/` → `npm test` | **66** | 0 | 0 |
| Browser end-to-end purchase journey (real handlers + TEST-ONLY mock gateway, real Chromium) | `qa/e2e_browser.py` | **42** | 0 | 0 |
| Browser regression: layout on every page at 320/375/768/1024/1440, menu keyboard flow, config validation, no-JS, reduced motion, links/IDs/meta, secret & PDF scan | `qa/regression_browser.py` | **115** | 0 | 0 |
| Mutation check: 25 deliberate breakages of security logic; the tests must fail for each | scripted | **25 of 25 caught** | 0 survived | 0 |
| **Total checks** | | **223** + 25 mutants | **0** | **0** |

Failures I hit and fixed during the run (not hidden): download button stayed visible despite `hidden` (CSS bug); a new download link opened in the same tab was not re-validated; held-for-review orders could not be released; wrong test expectations (email counts, footer order, reused order ids); a test-file import; a scanner flagging its own pattern text.

## Coverage against your required list
**Website:** all 11 pages load (index, order, download, recover, contact, privacy, terms, refunds, delivery, 404) · all internal links/assets resolve · mobile menu (Enter, Tab, Shift+Tab, Escape, outside click, resize) · buy buttons in unconfigured, gated (3 reasons), unavailable-server, unreachable-API, configured and hosted-link states · forms validate (invalid email → accessible error + focus) · no horizontal overflow, no console/page errors, no small tap targets · no placeholder text (scan clean) · cover image loads with dimensions and alt text · scripts-off fallback · reduced motion.
**Payments:** valid paid · invalid/missing signature · unknown order · mismatched session · mismatched order reference · wrong amount · wrong currency · wrong product · wrong payment mode · pending · failed · cancelled/expired · duplicate webhook · concurrent webhooks · repeated and simultaneous checkout requests · refunded · disputed · dispute won · forged success URL · price tampering. Run for the mock gateway, and with generated signatures and fake HTTP for **Stripe, Lemon Squeezy and Paddle**.
**Delivery:** paid order gets email · unpaid cannot download · expired/invalid/malformed token · download limit (also under concurrency) · other customers' orders and tokens isolated · email failure recovered (provider retry and customer resend) · resend throttling, enumeration protection, old-link invalidation · missing PDF does not consume a download.
**Security:** CORS on every browser endpoint · rate limits (checkout, resend, download, admin) · input validation · secret/PDF exposure scan (and a probe proving the scan detects an injected key) · no secrets/emails/tokens in responses or logs · admin auth, redaction, block/unblock/erase/export · purge of stale data · no GET download route.

## Not run: requires something I do not have
| Not tested | Why / who |
|---|---|
| Any real provider (Lemon Squeezy, Paddle, Stripe) in sandbox or live | No accounts/credentials/network. **You** (FINAL-LAUNCH-CHECKLIST §2–3) |
| Real email delivery (Resend or other) | No credentials |
| Deployment to Cloudflare (`wrangler deploy`), real Durable Object behaviour and real R2 | No account/network. The ledger's atomicity is tested with an in-memory emulation only |
| Real GitHub Pages deployment (and the `404.html` path behaviour there) | No repository access; tested with a local server under `/2/` |
| Lighthouse/performance scores | Tool unavailable. Mitigations: no dependencies, 18 KB cover image with set dimensions, no third-party requests |
| Real phones, Safari, Firefox, screen readers | Only Chromium here. Contrast was measured earlier for the shared palette; new pages reuse it |
| Visual inspection of **every** page at mobile **and** desktop | Automated overflow/target checks cover every page at 5 widths; I visually inspected the hero (desktop+mobile), recover, contact, a policy page and the share image only |
| Legal review of the policy templates | Needs a qualified professional |
