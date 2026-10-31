// OPTIONAL adapter. Stripe does not onboard Pakistan-registered businesses (verify at stripe.com/global). Use only if you
// independently hold an eligible Stripe account. Written from Stripe's documented Checkout Sessions API and webhook signature
// scheme; tested locally with generated signatures and a fake HTTP layer, NOT against a live Stripe account.
import { hmacHex, safeEqual } from "../util.js";

export const stripe = {
  name: "stripe",
  requiredEnv: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  sessionRequired: true,

  async createCheckout(env, o, doFetch) {
    const body = new URLSearchParams({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": o.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(o.amount),
      "line_items[0][price_data][product_data][name]": o.productName,
      success_url: o.successUrl, cancel_url: o.cancelUrl,
      client_reference_id: o.orderRef, "metadata[order_ref]": o.orderRef,
    });
    const r = await doFetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded", "idempotency-key": "ams-" + o.idempotencyKey },
      body,
    });
    if (!r.ok) throw new Error("stripe_http_" + r.status);
    const s = await r.json();
    if (!s || !s.id || !s.url) throw new Error("stripe_bad_response");
    return { url: s.url, sessionId: s.id };
  },

  async verifyWebhook(env, raw, headers, nowMs) {
    const parts = (headers.get("stripe-signature") || "").split(",").map((p) => p.trim());
    const t = (parts.find((p) => p.startsWith("t=")) || "").slice(2);
    const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
    const ts = Number(t);
    if (!t || !sigs.length || !Number.isFinite(ts)) throw new Error("bad_signature_header");
    if (Math.abs(nowMs / 1000 - ts) > 300) throw new Error("stale_signature");
    const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + "." + raw);
    if (!sigs.some((s) => safeEqual(s, expected))) throw new Error("signature_mismatch");

    const ev = JSON.parse(raw), o = (ev.data && ev.data.object) || {};
    const isSession = String(ev.type).startsWith("checkout.session.");
    const base = {
      id: ev.id, livemode: ev.livemode === true,
      orderRef: isSession ? o.client_reference_id || (o.metadata && o.metadata.order_ref) || "" : "",
      sessionId: isSession ? o.id || "" : "",
      transactionId: o.payment_intent || "",
      amount: isSession ? o.amount_total : null,
      currency: isSession ? String(o.currency || "").toUpperCase() : null,
      email: isSession ? (o.customer_details && o.customer_details.email) || o.customer_email || "" : "",
      productOk: null,
    };
    switch (ev.type) {
      case "checkout.session.completed": return { ...base, kind: o.payment_status === "paid" ? "paid" : "pending" };
      case "checkout.session.async_payment_succeeded": return { ...base, kind: "paid" };
      case "checkout.session.async_payment_failed": return { ...base, kind: "failed" };
      case "checkout.session.expired": return { ...base, kind: "expired" };
      case "charge.refunded": return { ...base, kind: o.refunded === true ? "refunded" : "ignored" }; // partial refunds are ignored
      case "charge.dispute.created": return { ...base, kind: "disputed" };
      case "charge.dispute.closed": return { ...base, kind: o.status === "won" ? "dispute_won" : "ignored" };
      default: return { ...base, kind: "ignored" };
    }
  },

  // Server-to-server re-check with Stripe's own API: the event alone is never the last word.
  async verifyTransaction(env, ev, doFetch) {
    if (ev.kind !== "paid") return;
    const r = await doFetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(ev.sessionId), { headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
    if (!r.ok) throw Object.assign(new Error("stripe_lookup_" + r.status), { retryable: true });
    const s = await r.json();
    const ok = s.id === ev.sessionId && s.payment_status === "paid" && s.amount_total === ev.amount && String(s.currency).toUpperCase() === ev.currency && s.client_reference_id === ev.orderRef;
    if (!ok) throw Object.assign(new Error("verification_mismatch"), { mismatch: true });
  },
};
