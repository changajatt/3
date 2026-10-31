// The ledger owns ALL order state. In production it runs inside ONE Cloudflare Durable Object (class `Ledger`),
// whose storage is serialised: while a storage call is in flight no other request runs, so every method below is atomic.
// RULES that keep it atomic: methods only await `this.st.*` (never fetch, never crypto.subtle) and never call out.
const MIN = 60000, DAY = 86400000;
const IDEM_MS = 30 * MIN, EVENT_KEEP_MS = 90 * DAY;
const push = (o, s, why, at) => { o.history = (o.history || []).slice(-29); o.history.push({ s, why, at }); };

export class LedgerCore {
  constructor(storage) { this.st = storage; }
  async get(k) { return (await this.st.get(k)) || null; }
  put(k, v) { return this.st.put(k, v); }
  del(k) { return this.st.delete(k); }

  // ---- rate limiting (fixed window) ----
  async hit(key, limit, windowMs, now) {
    const w = Math.floor(now / windowMs), k = "rl:" + key, r = await this.get(k);
    if (!r || r.w !== w) { await this.put(k, { w, n: 1, t: now }); return true; }
    if (r.n >= limit) return false;
    r.n += 1; await this.put(k, r); return true;
  }

  // ---- checkout creation: one idempotency key -> one provider session -> one order ----
  async reserveCheckout(key, ref, now) {
    const ex = await this.get("idem:" + key);
    if (ex && now - ex.at < IDEM_MS) {
      if (ex.url) return { state: "reuse", ref: ex.ref, url: ex.url };
      if (now - ex.at < MIN) return { state: "busy" }; // another request is creating it right now
    }
    await this.put("idem:" + key, { ref, at: now });
    return { state: "new" };
  }
  async finalizeCheckout(key, o, url, now) {
    await this.put("order:" + o.ref, { ...o, status: "pending", delivery: "none", createdAt: now, notices: {}, history: [{ s: "pending", why: "checkout_created", at: now }] });
    await this.put("idem:" + key, { ref: o.ref, url, at: now });
  }
  releaseCheckout(key) { return this.del("idem:" + key); }

  // ---- THE payment state machine. ev is a signature-verified, normalised provider event. ----
  async processEvent(ev, c) {
    const evKey = `evt:${c.provider}:${ev.id}`;
    const dup = !!(await this.get(evKey));
    let order = ev.orderRef ? await this.get("order:" + ev.orderRef) : null;
    if (!order && ev.transactionId) { const r = await this.get(`txn:${c.provider}:${ev.transactionId}`); if (r) order = await this.get("order:" + r); }
    if (!order) return { outcome: "unknown_order" };           // never creates orders from provider events
    if (order.provider !== c.provider) return { outcome: "provider_mismatch" };
    const now = c.now;

    if (dup) { // replay: only ever useful to recover a stuck delivery of an already-paid order
      if (ev.kind === "paid" && order.status === "paid" && (order.delivery === "email_failed" || (order.delivery === "pending" && now - (order.deliveryAt || 0) > 2 * MIN))) {
        order.delivery = "pending"; order.deliveryAt = now; await this.put("order:" + order.ref, order);
        return { outcome: "duplicate_retry_delivery", deliver: { ref: order.ref, email: order.email } };
      }
      return { outcome: "duplicate" };
    }

    const out = { outcome: "ok" };
    const review = (why) => { // held for the owner; remember who paid so a manual release can still deliver
      order.status = "review"; order.reviewReason = why; order.reviewEmail = email; order.reviewEmailHash = c.emailHash || ""; order.reviewTx = ev.transactionId || "";
      push(order, "review", why, now); out.outcome = why; };
    const set = (s, why) => { order.status = s; push(order, s, why, now); };
    const email = (ev.email || "").trim().toLowerCase();
    order.notices = order.notices || {};

    switch (ev.kind) {
      case "paid": {
        if (order.status === "refunded" || order.status === "disputed") { out.outcome = "ignored_" + order.status; break; }
        if (order.status === "paid") { out.outcome = "already_paid"; break; }   // second paid event: never a second delivery
        const bad =
          ev.sessionId && order.sessionId && ev.sessionId !== order.sessionId ? "session_mismatch" :
          c.sessionRequired && !ev.sessionId ? "session_missing" :
          ev.productOk === false ? "product_mismatch" :
          ev.amount != null && ev.amount !== order.amount ? "amount_mismatch" :
          ev.currency && ev.currency !== order.currency ? "currency_mismatch" :
          order.email && email && order.email !== email ? "buyer_mismatch" : null;
        if (bad) { review(bad); break; }
        set("paid", "verified_payment");
        order.paidAt = now; order.email = email || order.email || ""; order.emailHash = c.emailHash || order.emailHash || "";
        if (ev.transactionId) { order.transactionId = ev.transactionId; await this.put(`txn:${c.provider}:${ev.transactionId}`, order.ref); }
        if (order.emailHash) { const refs = (await this.get("em:" + order.emailHash)) || []; if (!refs.includes(order.ref)) { refs.push(order.ref); await this.put("em:" + order.emailHash, refs); } }
        order.delivery = order.email ? "pending" : "no_email"; order.deliveryAt = now;
        if (order.email) out.deliver = { ref: order.ref, email: order.email };
        break;
      }
      case "pending":
        if (order.status === "pending" && email && !order.notices.pending) { order.notices.pending = true; out.notify = { type: "pendingPayment", email, ref: order.ref }; }
        break;
      case "failed":
        if (order.status === "pending" || order.status === "failed") {
          set("failed", "payment_failed");
          if (email && !order.notices.failed) { order.notices.failed = true; out.notify = { type: "paymentFailed", email, ref: order.ref }; }
        }
        break;
      case "expired": if (order.status === "pending") set("cancelled", "checkout_expired"); break;
      case "refunded":
        if (["paid", "disputed", "review"].includes(order.status)) {
          set("refunded", "refunded"); order.refundedAt = now;
          if (order.tokenHash) { await this.del("tok:" + order.tokenHash); order.tokenHash = ""; }
          if (order.email && !order.notices.refund) { order.notices.refund = true; out.notify = { type: "refundConfirmation", email: order.email, ref: order.ref }; }
        }
        break;
      case "disputed": if (order.status === "paid") { set("disputed", "dispute_opened"); order.disputedAt = now; } break;
      case "dispute_won": if (order.status === "disputed") set("paid", "dispute_won"); break;
      default: out.outcome = "ignored_kind";
    }
    await this.put("order:" + order.ref, order);
    await this.put(evKey, { at: now });
    return out;
  }

  // ---- delivery bookkeeping ----
  async markDelivery(ref, result, now) {
    const o = await this.get("order:" + ref); if (!o || o.status !== "paid") return false;
    o.delivery = result; o.deliveryAt = now; push(o, "delivery", result, now); await this.put("order:" + ref, o); return true;
  }
  async issueToken(ref, hash, expiresAt, max) {
    const o = await this.get("order:" + ref); if (!o || o.status !== "paid") return false;
    if (o.tokenHash) await this.del("tok:" + o.tokenHash);          // a new link invalidates the previous one
    await this.put("tok:" + hash, { ref, expiresAt, max, used: 0 }); o.tokenHash = hash; await this.put("order:" + ref, o); return true;
  }
  async inspectToken(hash, now) {
    const t = await this.get("tok:" + hash); if (!t) return { ok: false, code: "not_found" };
    const o = await this.get("order:" + t.ref);
    if (!o || o.status !== "paid") return { ok: false, code: "not_paid" };
    if (now > t.expiresAt) return { ok: false, code: "expired" };
    if (t.used >= t.max) return { ok: false, code: "limit" };
    return { ok: true, expiresAt: t.expiresAt, remaining: t.max - t.used };
  }
  async consumeDownload(hash, now) {
    const r = await this.inspectToken(hash, now); if (!r.ok) return r;
    const t = await this.get("tok:" + hash); t.used += 1; await this.put("tok:" + hash, t);
    const o = await this.get("order:" + t.ref); o.downloads = (o.downloads || 0) + 1; o.firstDownloadAt = o.firstDownloadAt || now; await this.put("order:" + o.ref, o);
    return { ok: true, remaining: t.max - t.used };
  }
  async releaseDownload(hash) { const t = await this.get("tok:" + hash); if (t && t.used > 0) { t.used -= 1; await this.put("tok:" + hash, t); } }

  // ---- customer self-service resend (never reveals whether an order exists) ----
  async requestResend(emailHash, now, cooldownMs) {
    if (!(await this.hit("rs:" + emailHash, 1, cooldownMs, now))) return { outcome: "throttled" };
    const refs = (await this.get("em:" + emailHash)) || [];
    for (let i = refs.length - 1; i >= 0; i--) {
      const o = await this.get("order:" + refs[i]);
      if (o && o.status === "paid" && o.email) { o.delivery = "pending"; o.deliveryAt = now; await this.put("order:" + o.ref, o); return { outcome: "found", deliver: { ref: o.ref, email: o.email } }; }
    }
    return { outcome: "none" };
  }

  // ---- reads ----
  async publicOrder(ref) { const o = await this.get("order:" + ref); return o ? { status: o.status, delivery: o.delivery || "none" } : null; }
  async adminOrder(ref) { const o = await this.get("order:" + ref); if (!o) return null; const { tokenHash, reviewEmail, reviewEmailHash, emailHash, ...rest } = o; const red = (e) => (e ? e.replace(/^(.).*(@.*)$/, "$1***$2") : ""); return { ...rest, email: red(o.email), reviewEmail: red(reviewEmail) }; }
  async adminRelease(ref, now) { // owner decision: release an order held for manual review
    const o = await this.get("order:" + ref); if (!o || o.status !== "review") return { ok: false };
    o.status = "paid"; o.paidAt = now; push(o, "paid", "owner_released", now);
    o.email = o.email || o.reviewEmail || ""; o.emailHash = o.emailHash || o.reviewEmailHash || "";
    if (o.reviewTx) await this.put(`txn:${o.provider}:${o.reviewTx}`, ref);
    if (o.emailHash) { const refs = (await this.get("em:" + o.emailHash)) || []; if (!refs.includes(ref)) { refs.push(ref); await this.put("em:" + o.emailHash, refs); } }
    o.delivery = o.email ? "pending" : "no_email"; o.deliveryAt = now;
    await this.put("order:" + ref, o); return { ok: true, deliver: o.email ? { ref, email: o.email } : null };
  }
  async adminRedeliver(ref, now) {
    const o = await this.get("order:" + ref); if (!o || o.status !== "paid" || !o.email) return { ok: false };
    o.delivery = "pending"; o.deliveryAt = now; await this.put("order:" + ref, o); return { ok: true, deliver: { ref, email: o.email } };
  }

  async adminBlock(ref, now) { // owner pauses downloads (e.g. a dispute reported only in the provider dashboard)
    const o = await this.get("order:" + ref); if (!o || o.status !== "paid") return { ok: false };
    o.status = "disputed"; o.disputedAt = now; push(o, "disputed", "owner_block", now);
    if (o.tokenHash) { await this.del("tok:" + o.tokenHash); o.tokenHash = ""; }
    await this.put("order:" + ref, o); return { ok: true };
  }
  async adminUnblock(ref, now) { // restores a blocked order and re-delivers a fresh link
    const o = await this.get("order:" + ref); if (!o || o.status !== "disputed" || !o.email) return { ok: false };
    o.status = "paid"; push(o, "paid", "owner_unblock", now); o.delivery = "pending"; o.deliveryAt = now;
    await this.put("order:" + ref, o); return { ok: true, deliver: { ref, email: o.email } };
  }
  async adminErase(ref) { // privacy request: remove the order record, its link, and its email/transaction indexes
    const o = await this.get("order:" + ref); if (!o) return { ok: false };
    if (o.tokenHash) await this.del("tok:" + o.tokenHash);
    if (o.transactionId) await this.del(`txn:${o.provider}:${o.transactionId}`);
    for (const h of [o.emailHash, o.reviewEmailHash]) if (h) { const refs = ((await this.get("em:" + h)) || []).filter((r) => r !== ref); if (refs.length) await this.put("em:" + h, refs); else await this.del("em:" + h); }
    await this.del("order:" + ref); return { ok: true };
  }
  async adminExport() { // owner backup: every order record (no download-token hashes)
    return (await this.st.list("order:")).map(([, v]) => { const { tokenHash, ...r } = v; return r; });
  }

  // ---- housekeeping: keeps hashed-IP counters and stale records from accumulating ----
  async purge(now) {
    let n = 0;
    for (const [k, v] of await this.st.list("rl:")) if (now - (v.t || 0) > DAY) { await this.del(k); n++; }
    for (const [k, v] of await this.st.list("idem:")) if (now - v.at > IDEM_MS) { await this.del(k); n++; }
    for (const [k, v] of await this.st.list("tok:")) if (now > v.expiresAt + 7 * DAY) { await this.del(k); n++; }
    for (const [k, v] of await this.st.list("evt:")) if (now - v.at > EVENT_KEEP_MS) { await this.del(k); n++; }
    return n;
  }
}

// ---- storage backends ----
export class MapStorage { // used by tests and the local simulation server
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async delete(k) { this.m.delete(k); }
  async list(prefix) { return [...this.m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]); }
}
export class MemoryLedger { // same call() surface as the Durable Object stub
  // A Durable Object runs one request at a time; this mutex emulates that so tests exercise the same serialisation.
  constructor() { this.core = new LedgerCore(new MapStorage()); this.q = Promise.resolve(); }
  call(op, ...args) {
    if (!OPS.includes(op)) throw new Error("bad_op");
    const run = this.q.then(() => this.core[op](...args));
    this.q = run.catch(() => {});
    return run;
  }
}

export const OPS = ["hit", "reserveCheckout", "finalizeCheckout", "releaseCheckout", "processEvent", "markDelivery", "issueToken", "inspectToken", "consumeDownload", "releaseDownload", "requestResend", "publicOrder", "adminOrder", "adminRelease", "adminRedeliver", "adminBlock", "adminUnblock", "adminErase", "adminExport", "purge"];

// Cloudflare Durable Object wrapper (the single instance named "main").
export class Ledger {
  constructor(state) {
    this.state = state;
    const s = state.storage;
    this.core = new LedgerCore({
      get: (k) => s.get(k), put: (k, v) => s.put(k, v), delete: (k) => s.delete(k),
      list: async (p) => [...(await s.list({ prefix: p }))],
    });
  }
  async fetch(request) {
    const { op, args } = await request.json();
    if (!OPS.includes(op)) return new Response("bad op", { status: 400 });
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + DAY);
    return Response.json((await this.core[op](...args)) ?? null);
  }
  async alarm() { await this.core.purge(Date.now()); await this.state.storage.setAlarm(Date.now() + DAY); }
}
