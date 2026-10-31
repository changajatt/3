// Lemon Squeezy (merchant of record). Pakistan appears on Lemon Squeezy's published bank-payout list; account approval is theirs.
// Verified from LS docs: POST /v1/checkouts (JSON:API, custom_price, checkout_data.custom, product_options.redirect_url,
// relationships store+variant, response data.attributes.url), webhook header X-Signature = HMAC-SHA256 hex of the raw body,
// events order_created / order_refunded with meta.custom_data and data.attributes.{user_email,status,test_mode,first_order_item}.
// LS payloads carry no unique event id and no timestamp, so we dedupe on "<event_name>:<order id>".
import { hmacHex, safeEqual } from "../util.js";

export const lemonsqueezy = {
  name: "lemonsqueezy",
  requiredEnv: ["LEMONSQUEEZY_API_KEY", "LEMONSQUEEZY_WEBHOOK_SECRET", "LEMONSQUEEZY_STORE_ID", "LEMONSQUEEZY_VARIANT_ID"],
  sessionRequired: false,

  async createCheckout(env, o, doFetch) {
    const r = await doFetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: { accept: "application/vnd.api+json", "content-type": "application/vnd.api+json", authorization: "Bearer " + env.LEMONSQUEEZY_API_KEY },
      body: JSON.stringify({ data: { type: "checkouts",
        attributes: { custom_price: o.amount, checkout_data: { custom: { order_ref: o.orderRef } }, product_options: { redirect_url: o.successUrl }, test_mode: env.PAYMENT_MODE !== "live" },
        relationships: { store: { data: { type: "stores", id: String(env.LEMONSQUEEZY_STORE_ID) } }, variant: { data: { type: "variants", id: String(env.LEMONSQUEEZY_VARIANT_ID) } } } } }),
    });
    if (!r.ok) throw new Error("ls_http_" + r.status);
    const j = await r.json(), url = j && j.data && j.data.attributes && j.data.attributes.url;
    if (!url) throw new Error("ls_bad_response");
    return { url, sessionId: String(j.data.id || "") };
  },

  async verifyWebhook(env, raw, headers) {
    const sig = (headers.get("x-signature") || "").toLowerCase();
    if (!sig || !safeEqual(sig, await hmacHex(env.LEMONSQUEEZY_WEBHOOK_SECRET, raw))) throw new Error("signature_mismatch");
    const j = JSON.parse(raw), meta = j.meta || {}, d = j.data || {}, a = d.attributes || {};
    const name = meta.event_name;
    const item = a.first_order_item || {};
    const base = {
      id: `${name}:${d.id}`, livemode: !(a.test_mode ?? meta.test_mode),
      orderRef: (meta.custom_data && meta.custom_data.order_ref) || "", sessionId: "", transactionId: "ls_order:" + d.id,
      amount: null, currency: null, // MoR adds tax/FX; price is enforced via custom_price at checkout creation + variant check below
      email: a.user_email || "",
      productOk: String(item.variant_id) === String(env.LEMONSQUEEZY_VARIANT_ID) && String(a.store_id) === String(env.LEMONSQUEEZY_STORE_ID),
    };
    if (d.type !== "orders") return { ...base, kind: "ignored" };
    if (name === "order_created") return { ...base, kind: a.status === "paid" ? "paid" : a.status === "pending" ? "pending" : a.status === "failed" ? "failed" : "ignored" };
    if (name === "order_refunded") return { ...base, kind: a.status === "refunded" ? "refunded" : "ignored" }; // partial refunds ignored
    return { ...base, kind: "ignored" };
  },
};
