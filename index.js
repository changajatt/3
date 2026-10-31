// Zyvtron API (Cloudflare Worker). Routes: product, checkout, webhook, order-status, download-info, download, resend, admin.
// All order state lives in the Ledger Durable Object (src/ledger.js). This file does network I/O (providers, email, R2);
// the ledger does the atomic bookkeeping.
import { json, randomToken, sha256Hex, safeEqual, isEmail } from "./util.js";
import { getProvider } from "./providers/index.js";
import { sendEmail, templates } from "./email.js";
export { Ledger } from "./ledger.js";

const HOUR = 3600000;
const REF_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
const DELIVERY_ENV = ["LEDGER", "DOWNLOADS", "PDF_KEY", "API_URL", "SITE_URL", "SITE_ORIGIN", "EMAIL_FROM", "RESEND_API_KEY", "SUPPORT_EMAIL", "PAYMENT_MODE"];
const BROWSER_POSTS = ["/api/checkout", "/api/resend", "/api/download", "/api/download-info"];

export function ledgerFor(env) {
  if (env.__ledger) return env.__ledger; // test/local injection only
  const stub = env.LEDGER.get(env.LEDGER.idFromName("main"));
  return { call: async (op, ...args) => (await stub.fetch("https://ledger/", { method: "POST", body: JSON.stringify({ op, args }) })).json() };
}
function settings(env) {
  const n = (v, d) => { const x = parseInt(v ?? d, 10); return Number.isFinite(x) ? x : d; };
  return { productId: "ams-ebook", productName: "AI Marketing Freelancer System (PDF ebook)", priceCents: n(env.PRICE_CENTS, 2700),
    currency: String(env.CURRENCY || "USD").toUpperCase(), siteUrl: String(env.SITE_URL || "").replace(/\/+$/, ""), apiUrl: String(env.API_URL || "").replace(/\/+$/, ""),
    hours: n(env.DOWNLOAD_HOURS, 72), max: n(env.MAX_DOWNLOADS, 5) };
}
const priceLabel = (c) => `${c.currency === "USD" ? "$" : ""}${(c.priceCents / 100).toFixed(2)} ${c.currency}`;
export function readiness(env) {
  const provider = getProvider(env), c = settings(env), missing = [];
  if (!provider) missing.push("PAYMENT_PROVIDER");
  for (const k of [...DELIVERY_ENV, ...(provider ? provider.requiredEnv : [])]) if (!env[k]) missing.push(k);
  if (!(c.priceCents > 0)) missing.push("PRICE_CENTS");
  if (env.PAYMENT_MODE && !["test", "live"].includes(env.PAYMENT_MODE)) missing.push("PAYMENT_MODE(test|live)");
  return { provider, c, missing, ready: missing.length === 0 };
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (e) { console.error("unhandled_error", e && e.message); return json({ error: "server_error" }, 500); }
  },
};

export async function route(request, env, deps = {}) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const now = deps.now ? deps.now() : Date.now();
  const origin = request.headers.get("origin"), allowed = env.SITE_ORIGIN || "";
  const cors = {};
  if (origin && allowed && origin === allowed) Object.assign(cors, { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, idempotency-key", "access-control-allow-methods": "GET, POST, OPTIONS", vary: "Origin" });
  if (method === "OPTIONS") return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 403, headers: cors });
  if (origin && origin !== allowed && BROWSER_POSTS.includes(path)) return json({ error: "origin_not_allowed" }, 403);

  const ip = await sha256Hex(request.headers.get("cf-connecting-ip") || "unknown");
  const ctx = { env, deps, now, cors, ip, L: ledgerFor(env), doFetch: deps.fetch || fetch, send: deps.sendEmail || sendEmail };
  if (path === "/api/product" && method === "GET") return product(ctx);
  if (path === "/api/checkout" && method === "POST") return checkout(request, ctx);
  if (path === "/api/webhook" && method === "POST") return webhook(request, ctx);
  if (path === "/api/order-status" && method === "GET") return orderStatus(url, ctx);
  if (path === "/api/download-info" && method === "POST") return downloadInfo(request, ctx);
  if (path === "/api/download" && method === "POST") return download(request, ctx);
  if (path === "/api/resend" && method === "POST") return resend(request, ctx);
  if (path === "/api/admin" && method === "POST") return admin(request, ctx);
  return json({ error: "not_found" }, 404, cors);
}

const body = async (request, limit = 4096) => { const t = await request.text(); if (t.length > limit) throw new Error("too_large"); return t ? JSON.parse(t) : {}; };

function product({ env, cors }) {
  const r = readiness(env);
  return json({ productId: r.c.productId, name: r.c.productName, priceCents: r.c.priceCents, currency: r.c.currency, priceLabel: priceLabel(r.c), checkoutAvailable: r.ready }, 200, cors);
}

async function checkout(request, { env, now, cors, ip, L, doFetch }) {
  const r = readiness(env);
  if (!r.ready) { console.error("checkout_unavailable_missing:", r.missing.join(",")); return json({ error: "checkout_unavailable" }, 503, cors); }
  if (!(await L.call("hit", "co:" + ip, 20, HOUR, now))) return json({ error: "rate_limited" }, 429, cors);
  let b; try { b = await body(request); } catch { return json({ error: "bad_request" }, 400, cors); }
  if (b.productId !== r.c.productId) return json({ error: "unknown_product" }, 400, cors); // price/currency/status are never read from the browser
  const key = request.headers.get("idempotency-key") || "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) return json({ error: "idempotency_key_required" }, 400, cors);

  const ref = randomToken(16);
  const rs = await L.call("reserveCheckout", key, ref, now);
  if (rs.state === "reuse") return json({ url: rs.url, ref: rs.ref }, 200, cors);
  if (rs.state === "busy") return json({ error: "in_progress" }, 409, cors);
  let s;
  try {
    s = await r.provider.createCheckout(env, { orderRef: ref, amount: r.c.priceCents, currency: r.c.currency, productName: r.c.productName,
      successUrl: `${r.c.siteUrl}/order.html?ref=${ref}&state=success`, cancelUrl: `${r.c.siteUrl}/order.html?ref=${ref}&state=cancelled`, idempotencyKey: key }, doFetch);
  } catch (e) { await L.call("releaseCheckout", key); console.error("provider_checkout_failed", e.message); return json({ error: "checkout_failed" }, 502, cors); }
  await L.call("finalizeCheckout", key, { ref, provider: r.provider.name, sessionId: s.sessionId, productId: r.c.productId, amount: r.c.priceCents, currency: r.c.currency }, s.url, now);
  return json({ url: s.url, ref }, 200, cors);
}

// The ONLY path to "paid": signature-verified event -> optional provider re-check -> ledger state machine.
async function webhook(request, { env, now, L, doFetch, send }) {
  const r = readiness(env);
  if (!r.ready) { console.error("webhook_unavailable_missing:", r.missing.join(",")); return json({ error: "unavailable" }, 503); }
  const raw = await request.text();
  if (raw.length > 1000000) return json({ error: "too_large" }, 413);
  let ev;
  try { ev = await r.provider.verifyWebhook(env, raw, request.headers, now); }
  catch (e) { console.error("webhook_rejected", e.message); return json({ error: "invalid_signature" }, 400); }
  if (!ev || ev.kind === "ignored") return json({ ok: true, ignored: true });
  if (!ev.id) return json({ error: "bad_event" }, 400);
  if (ev.livemode != null && ev.livemode !== (env.PAYMENT_MODE === "live")) { console.error("webhook_wrong_mode", ev.livemode); return json({ ok: true, ignored: "mode" }); } // test event on live endpoint or vice versa
  try {
    if (r.provider.enrich) ev = await r.provider.enrich(env, ev, doFetch);
    if (r.provider.verifyTransaction) await r.provider.verifyTransaction(env, ev, doFetch);
  } catch (e) {
    console.error("verification_failed", e.message);
    return e.mismatch ? json({ error: "verification_mismatch" }, 400) : json({ error: "verification_unavailable" }, 503); // 503 -> provider retries later
  }
  const emailHash = ev.email ? await sha256Hex(ev.email.trim().toLowerCase()) : "";
  const out = await L.call("processEvent", ev, { provider: r.provider.name, sessionRequired: !!r.provider.sessionRequired, emailHash, now });
  if (out.outcome !== "ok" && out.outcome !== "duplicate" && out.outcome !== "already_paid") console.error("event_outcome", out.outcome, ev.id);
  if (out.deliver) { const ok = await runDelivery(env, r.c, out.deliver, "paidDelivery", { now, L, doFetch, send }); if (!ok) return json({ error: "delivery_retry" }, 500); } // 500 => provider retries; ledger recovers delivery
  if (out.notify) await notify(env, r.c, out.notify, { doFetch, send });
  return json({ ok: true });
}

const links = (c, token, ref) => ({ link: `${c.siteUrl}/download.html#t=${token}`, orderUrl: `${c.siteUrl}/order.html?ref=${ref}`, recoverUrl: `${c.siteUrl}/recover.html` });
async function runDelivery(env, c, d, template, { now, L, doFetch, send }) {
  const token = randomToken(32), hash = await sha256Hex(token);
  if (!(await L.call("issueToken", d.ref, hash, now + c.hours * HOUR, c.max))) return false;
  try {
    await send(env, d.email, templates[template]({ ...links(c, token, d.ref), hours: c.hours, max: c.max, ref: d.ref, support: env.SUPPORT_EMAIL }), doFetch);
    await L.call("markDelivery", d.ref, "sent", now); return true;
  } catch (e) { await L.call("markDelivery", d.ref, "email_failed", now); console.error("email_failed", d.ref, e.message); return false; }
}
async function notify(env, c, n, { doFetch, send }) { // best effort: a lost notice never affects orders
  try { await send(env, n.email, templates[n.type]({ ref: n.ref, support: env.SUPPORT_EMAIL, orderUrl: `${c.siteUrl}/order.html?ref=${n.ref}`, siteUrl: c.siteUrl + "/" }), doFetch); }
  catch (e) { console.error("notice_failed", n.type, n.ref, e.message); }
}

async function orderStatus(url, { env, cors, L }) {
  const ref = url.searchParams.get("ref") || "";
  if (!REF_RE.test(ref)) return json({ status: "unknown" }, 404, cors);
  const o = await L.call("publicOrder", ref);
  if (!o) return json({ status: "unknown" }, 404, cors);
  return json({ ...o, supportEmail: env.SUPPORT_EMAIL || null }, 200, cors); // status only: never email, token or provider data
}

async function tokenFrom(request) { let b; try { b = await body(request, 512); } catch { return null; } return TOKEN_RE.test(b.token || "") ? { token: b.token, hash: await sha256Hex(b.token) } : null; }
const dlErr = { not_found: 404, expired: 410, limit: 410, not_paid: 403 };

async function downloadInfo(request, { env, now, cors, ip, L }) {
  if (!(await L.call("hit", "dl:" + ip, 60, HOUR, now))) return json({ error: "rate_limited" }, 429, cors);
  const t = await tokenFrom(request); if (!t) return json({ error: "not_found" }, 404, cors);
  const r = await L.call("inspectToken", t.hash, now);
  return r.ok ? json({ ok: true, expiresAt: r.expiresAt, remaining: r.remaining }, 200, cors) : json({ error: r.code }, dlErr[r.code] || 404, cors);
}
async function download(request, { env, now, cors, ip, L }) {
  if (!(await L.call("hit", "dl:" + ip, 60, HOUR, now))) return json({ error: "rate_limited" }, 429, cors);
  const t = await tokenFrom(request); if (!t || !env.DOWNLOADS) return json({ error: "not_found" }, 404, cors);
  const r = await L.call("consumeDownload", t.hash, now);
  if (!r.ok) return json({ error: r.code }, dlErr[r.code] || 404, cors);
  const obj = await env.DOWNLOADS.get(env.PDF_KEY);
  if (!obj) { await L.call("releaseDownload", t.hash); console.error("pdf_missing_in_storage"); return json({ error: "file_unavailable" }, 503, cors); }
  return new Response(obj.body, { status: 200, headers: { ...cors, "content-type": "application/pdf", "content-disposition": 'attachment; filename="AI-Marketing-Freelancer-System.pdf"', "cache-control": "private, no-store", "x-robots-tag": "noindex", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}

async function resend(request, { env, now, cors, ip, L, doFetch, send }) {
  const generic = () => json({ ok: true, message: "If a paid order exists for that email address, a new download link is on its way." }, 200, cors);
  const r = readiness(env); if (!r.ready) return json({ error: "unavailable" }, 503, cors);
  let b; try { b = await body(request); } catch { return json({ error: "bad_request" }, 400, cors); }
  if (!isEmail(b.email)) return json({ error: "invalid_email" }, 400, cors);
  if (!(await L.call("hit", "rsip:" + ip, 10, HOUR, now))) return json({ error: "rate_limited" }, 429, cors);
  const eh = await sha256Hex(b.email.trim().toLowerCase());
  const out = await L.call("requestResend", eh, now, 10 * 60000);
  if (out.outcome === "found") await runDelivery(env, r.c, out.deliver, "resend", { now, L, doFetch, send });
  return generic(); // identical whether or not an order exists, throttled, or email failed
}

// Owner-only recovery tool. Disabled unless the ADMIN_TOKEN secret is set. Never returns tokens or full emails.
async function admin(request, { env, now, ip, L, doFetch, send }) {
  const given = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return json({ error: "not_found" }, 404);
  if (!(await L.call("hit", "adm:" + ip, 20, HOUR, now))) return json({ error: "rate_limited" }, 429);
  if (!safeEqual(given, env.ADMIN_TOKEN)) return json({ error: "forbidden" }, 403);
  let b; try { b = await body(request); } catch { return json({ error: "bad_request" }, 400); }
  if (b.action === "export") return json({ exportedAt: now, orders: await L.call("adminExport") }); // needs no ref
  if (!REF_RE.test(b.ref || "")) return json({ error: "bad_ref" }, 400);
  const r = readiness(env);
  if (b.action === "get") { const o = await L.call("adminOrder", b.ref); return o ? json(o) : json({ error: "not_found" }, 404); }
  if (b.action === "erase") { const res = await L.call("adminErase", b.ref); return res.ok ? json({ ok: true }) : json({ error: "not_found" }, 404); }
  if (b.action === "block") { const res = await L.call("adminBlock", b.ref, now); return res.ok ? json({ ok: true }) : json({ error: "not_applicable" }, 409); }
  if (b.action === "release" || b.action === "redeliver" || b.action === "unblock") {
    const res = await L.call({ release: "adminRelease", redeliver: "adminRedeliver", unblock: "adminUnblock" }[b.action], b.ref, now);
    if (!res.ok) return json({ error: "not_applicable" }, 409);
    const sent = res.deliver ? await runDelivery(env, r.c, res.deliver, "paidDelivery", { now, L, doFetch, send }) : false;
    return json({ ok: true, emailed: sent });
  }
  return json({ error: "bad_action" }, 400);
}
