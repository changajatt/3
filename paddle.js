// Paddle Billing (merchant of record). Pakistan is in Paddle's supported-countries table, but seller/product approval is
// discretionary. Verified from Paddle docs: Paddle-Signature "ts=...;h1=..." = HMAC-SHA256 hex of "<ts>:<raw body>"
// (several h1 may appear during secret rotation); POST /transactions with items[{price_id,quantity}] + custom_data returns
// data.id (txn_...) and data.checkout.url (needs an APPROVED default payment link: a page on your site running Paddle.js).
// NOT included/verified here: that Paddle.js payment-link page, refunds/chargebacks (adjustment events). Lower priority than LS.
import { hmacHex, safeEqual } from "../util.js";
const base = (env) => (env.PAYMENT_MODE === "live" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com");

export const paddle = {
  name: "paddle",
  requiredEnv: ["PADDLE_API_KEY", "PADDLE_WEBHOOK_SECRET", "PADDLE_PRICE_ID"],
  sessionRequired: true,

  async createCheckout(env, o, doFetch) {
    const r = await doFetch(base(env) + "/transactions", {
      method: "POST", headers: { authorization: "Bearer " + env.PADDLE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ items: [{ price_id: env.PADDLE_PRICE_ID, quantity: 1 }], custom_data: { order_ref: o.orderRef } }),
    });
    if (!r.ok) throw new Error("paddle_http_" + r.status);
    const j = await r.json(), id = j && j.data && j.data.id, url = j && j.data && j.data.checkout && j.data.checkout.url;
    if (!id || !url) throw new Error("paddle_no_checkout_url_(default_payment_link_not_approved?)");
    return { url, sessionId: id };
  },

  async verifyWebhook(env, raw, headers, nowMs) {
    const h = headers.get("paddle-signature") || "";
    const ts = (h.match(/(?:^|;)ts=(\d+)/) || [])[1];
    const sigs = [...h.matchAll(/(?:^|;)h1=([0-9a-fA-F]+)/g)].map((m) => m[1].toLowerCase());
    if (!ts || !sigs.length) throw new Error("bad_signature_header");
    if (Math.abs(nowMs / 1000 - Number(ts)) > 300) throw new Error("stale_signature");
    const expected = await hmacHex(env.PADDLE_WEBHOOK_SECRET, ts + ":" + raw);
    if (!sigs.some((s) => safeEqual(s, expected))) throw new Error("signature_mismatch");
    const ev = JSON.parse(raw), d = ev.data || {};
    const b = {
      id: ev.event_id, livemode: null, orderRef: (d.custom_data && d.custom_data.order_ref) || "", sessionId: d.id || "", transactionId: d.id || "",
      amount: null, currency: null, email: "", customerId: d.customer_id || "",
      productOk: Array.isArray(d.items) ? d.items.some((i) => i.price && i.price.id === env.PADDLE_PRICE_ID) : null,
    };
    return { ...b, kind: ev.event_type === "transaction.completed" && d.status === "completed" ? "paid" : "ignored" };
  },

  // Paddle events carry customer_id, not email: fetch it (a failure is retryable).
  async enrich(env, ev, doFetch) {
    if (ev.kind !== "paid" || !ev.customerId) return ev;
    const r = await doFetch(base(env) + "/customers/" + encodeURIComponent(ev.customerId), { headers: { authorization: "Bearer " + env.PADDLE_API_KEY } });
    if (!r.ok) throw Object.assign(new Error("paddle_customer_" + r.status), { retryable: true });
    const j = await r.json();
    return { ...ev, email: (j.data && j.data.email) || "" };
  },
};
