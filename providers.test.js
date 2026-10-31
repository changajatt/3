import test from "node:test";
import assert from "node:assert/strict";
import { stripe } from "../src/providers/stripe.js";
import { lemonsqueezy } from "../src/providers/lemonsqueezy.js";
import { paddle } from "../src/providers/paddle.js";
import { hmacHex } from "../src/util.js";
import { makeEnv, makeDeps, call, startCheckout, webhook, statusOf, SITE } from "./helpers.js";
import { sendEmail, templates } from "../src/email.js";

const NOW = 1_700_000_000_000, T = String(NOW / 1000), R = "R".repeat(22);

// ===== Stripe (optional) =====
const sEnv = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };
const sess = (o = {}) => ({ id: "cs_1", client_reference_id: R, amount_total: 2700, currency: "usd", payment_status: "paid", payment_intent: "pi_1", customer_details: { email: "b@m.test" }, ...o });
const sRaw = (type, obj = sess(), x = {}) => JSON.stringify({ id: "evt_1", type, livemode: false, data: { object: obj }, ...x });
const sSigned = async (raw, t = T, secret = sEnv.STRIPE_WEBHOOK_SECRET) => new Headers({ "stripe-signature": `t=${t},v1=${await hmacHex(secret, t + "." + raw)}` });
test("stripe: signature verified; normalised paid event", async () => {
  const raw = sRaw("checkout.session.completed"), e = await stripe.verifyWebhook(sEnv, raw, await sSigned(raw), NOW);
  assert.deepEqual([e.kind, e.amount, e.currency, e.email, e.orderRef, e.sessionId, e.transactionId, e.livemode], ["paid", 2700, "USD", "b@m.test", R, "cs_1", "pi_1", false]);
});
test("stripe: tampered body / wrong secret / stale / missing header rejected", async () => {
  const raw = sRaw("checkout.session.completed"), h = await sSigned(raw);
  await assert.rejects(stripe.verifyWebhook(sEnv, raw.replace("2700", "1"), h, NOW), /signature_mismatch/);
  await assert.rejects(stripe.verifyWebhook(sEnv, raw, await sSigned(raw, T, "other"), NOW), /signature_mismatch/);
  await assert.rejects(stripe.verifyWebhook(sEnv, raw, h, NOW + 10 * 60000), /stale/); await assert.rejects(stripe.verifyWebhook(sEnv, raw, new Headers(), NOW), /bad_signature_header/);
});
test("stripe: event mapping (unpaid, async ok/fail, expired, full vs partial refund, dispute open/won/lost)", async () => {
  const k = async (type, o, x) => { const raw = sRaw(type, o, x); return (await stripe.verifyWebhook(sEnv, raw, await sSigned(raw), NOW)).kind; };
  assert.equal(await k("checkout.session.completed", sess({ payment_status: "unpaid" })), "pending"); assert.equal(await k("checkout.session.async_payment_succeeded"), "paid");
  assert.equal(await k("checkout.session.async_payment_failed"), "failed"); assert.equal(await k("checkout.session.expired"), "expired");
  assert.equal(await k("charge.refunded", { payment_intent: "pi_1", refunded: true }), "refunded"); assert.equal(await k("charge.refunded", { payment_intent: "pi_1", refunded: false }), "ignored");
  assert.equal(await k("charge.dispute.created", { payment_intent: "pi_1" }), "disputed"); assert.equal(await k("charge.dispute.closed", { payment_intent: "pi_1", status: "won" }), "dispute_won"); assert.equal(await k("charge.dispute.closed", { payment_intent: "pi_1", status: "lost" }), "ignored");
  assert.equal(await k("customer.created", {}), "ignored");
});
test("stripe: createCheckout request shape + error handling", async () => {
  let seen; const f = async (u, i) => { seen = { u, i }; return new Response(JSON.stringify({ id: "cs_9", url: "https://checkout.stripe.com/c/pay/cs_9" })); };
  const o = { orderRef: R, amount: 2700, currency: "USD", productName: "P", successUrl: "https://s/ok", cancelUrl: "https://s/no", idempotencyKey: "k" };
  assert.deepEqual(await stripe.createCheckout(sEnv, o, f), { url: "https://checkout.stripe.com/c/pay/cs_9", sessionId: "cs_9" });
  assert.equal(seen.i.headers.authorization, "Bearer sk_test_x"); assert.equal(seen.i.body.get("line_items[0][price_data][unit_amount]"), "2700"); assert.equal(seen.i.body.get("client_reference_id"), R);
  await assert.rejects(stripe.createCheckout(sEnv, o, async () => new Response("no", { status: 402 })), /stripe_http_402/);
});
test("stripe: verifyTransaction re-checks with Stripe's API (mismatch rejected, outage retryable)", async () => {
  const ev = { kind: "paid", sessionId: "cs_1", orderRef: R, amount: 2700, currency: "USD" }; const good = async () => new Response(JSON.stringify(sess()));
  await stripe.verifyTransaction(sEnv, ev, good);
  for (const bad of [sess({ payment_status: "unpaid" }), sess({ amount_total: 1 }), sess({ client_reference_id: "other" }), sess({ id: "cs_other" }), sess({ currency: "eur" })])
    await assert.rejects(stripe.verifyTransaction(sEnv, ev, async () => new Response(JSON.stringify(bad))), (e) => e.mismatch === true);
  await assert.rejects(stripe.verifyTransaction(sEnv, ev, async () => new Response("x", { status: 500 })), (e) => e.retryable === true);
});
test("stripe END-TO-END through the worker: another buyer's valid payment cannot be attached to order A; mismatch from Stripe lookup -> 400, 5xx -> 503", async () => {
  const mk = () => makeEnv({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", MOCK_WEBHOOK_SECRET: "" });
  const env = mk(); let lookup = async (u) => null; const createF = async (u, i) => { if (String(u).includes("/checkout/sessions/")) return lookup(u); return new Response(JSON.stringify({ id: "cs_" + i.body.get("client_reference_id"), url: "https://checkout.stripe.com/x" })); };
  const deps = makeDeps({ fetch: createF }); const A = (await startCheckout(env, deps, "A".repeat(20))).body;
  const send = async (obj, type = "checkout.session.completed", id = "evt_x") => { const raw = sRaw(type, obj, { id }); return call(env, deps, "/api/webhook", { method: "POST", headers: await sSigned(raw, String(deps.now() / 1000), "whsec_x"), body: raw }); };
  // attacker's REAL paid session cs_ATTACK carries A's reference (payment-link trick)
  lookup = async () => new Response(JSON.stringify(sess({ id: "cs_ATTACK", client_reference_id: A.ref })));
  assert.equal((await send(sess({ id: "cs_ATTACK", client_reference_id: A.ref }))).status, 200); assert.equal((await statusOf(env, deps, A.ref)).status, "review"); assert.equal(deps.outbox.length, 0);
  const B = (await startCheckout(env, deps, "B".repeat(20))).body;
  lookup = async () => new Response(JSON.stringify(sess({ id: "cs_" + B.ref, client_reference_id: B.ref, amount_total: 1 }))); // Stripe says a different amount than the event
  assert.equal((await send(sess({ id: "cs_" + B.ref, client_reference_id: B.ref }), "checkout.session.completed", "evt_y")).status, 400); assert.equal((await statusOf(env, deps, B.ref)).status, "pending");
  lookup = async () => new Response("down", { status: 500 }); assert.equal((await send(sess({ id: "cs_" + B.ref, client_reference_id: B.ref }), "checkout.session.completed", "evt_z")).status, 503);
  lookup = async () => new Response(JSON.stringify(sess({ id: "cs_" + B.ref, client_reference_id: B.ref }))); // genuine
  assert.equal((await send(sess({ id: "cs_" + B.ref, client_reference_id: B.ref }), "checkout.session.completed", "evt_ok")).status, 200); assert.equal((await statusOf(env, deps, B.ref)).status, "paid"); assert.equal(deps.outbox.length, 1);
});

// ===== Lemon Squeezy =====
const lEnv = { LEMONSQUEEZY_API_KEY: "ls_key", LEMONSQUEEZY_WEBHOOK_SECRET: "ls_secret", LEMONSQUEEZY_STORE_ID: "11", LEMONSQUEEZY_VARIANT_ID: "22", PAYMENT_MODE: "test" };
const lOrder = (o = {}, meta = {}, id = "501") => JSON.stringify({ meta: { event_name: "order_created", test_mode: true, custom_data: { order_ref: R }, ...meta }, data: { type: "orders", id, attributes: { store_id: 11, user_email: "Buyer@Mail.test", status: "paid", test_mode: true, first_order_item: { product_id: 3, variant_id: 22 }, ...o } } });
const lSign = async (raw, secret = "ls_secret") => new Headers({ "x-signature": await hmacHex(secret, raw) });
test("lemonsqueezy: signature verified; order_created -> paid with variant/store check, custom_data ref, test mode", async () => {
  const raw = lOrder(), e = await lemonsqueezy.verifyWebhook(lEnv, raw, await lSign(raw));
  assert.deepEqual([e.kind, e.orderRef, e.productOk, e.livemode, e.transactionId, e.id, e.email], ["paid", R, true, false, "ls_order:501", "order_created:501", "Buyer@Mail.test"]);
});
test("lemonsqueezy: bad/missing/tampered signature rejected", async () => {
  const raw = lOrder(); await assert.rejects(lemonsqueezy.verifyWebhook(lEnv, raw, await lSign(raw, "wrong")), /signature_mismatch/);
  await assert.rejects(lemonsqueezy.verifyWebhook(lEnv, raw.replace("501", "502"), await lSign(raw)), /signature_mismatch/); await assert.rejects(lemonsqueezy.verifyWebhook(lEnv, raw, new Headers()), /signature_mismatch/);
});
test("lemonsqueezy: status/event mapping and product mismatch", async () => {
  const k = async (raw) => lemonsqueezy.verifyWebhook(lEnv, raw, await lSign(raw));
  assert.equal((await k(lOrder({ status: "pending" }))).kind, "pending"); assert.equal((await k(lOrder({ status: "failed" }))).kind, "failed"); assert.equal((await k(lOrder({ status: "void" }))).kind, "ignored");
  assert.equal((await k(lOrder({ status: "refunded" }, { event_name: "order_refunded" }))).kind, "refunded"); assert.equal((await k(lOrder({ status: "partial_refund" }, { event_name: "order_refunded" }))).kind, "ignored");
  assert.equal((await k(lOrder({ first_order_item: { variant_id: 99 } }))).productOk, false); assert.equal((await k(lOrder({ store_id: 12 }))).productOk, false);
  assert.equal((await k(lOrder({}, { event_name: "subscription_created" }))).kind, "ignored");
  assert.equal((await k(JSON.stringify({ meta: { event_name: "order_created" }, data: { type: "subscriptions", id: "1", attributes: {} } }))).kind, "ignored");
});
test("lemonsqueezy: createCheckout follows the documented API (custom_price, custom data, relationships, redirect, test_mode)", async () => {
  let seen; const f = async (u, i) => { seen = { u, i }; return new Response(JSON.stringify({ data: { id: "co_1", attributes: { url: "https://store.lemonsqueezy.com/checkout/custom/co_1?signature=x" } } }), { status: 201 }); };
  const out = await lemonsqueezy.createCheckout(lEnv, { orderRef: R, amount: 2700, successUrl: "https://s/ok" }, f); const b = JSON.parse(seen.i.body);
  assert.equal(out.url, "https://store.lemonsqueezy.com/checkout/custom/co_1?signature=x"); assert.equal(seen.u, "https://api.lemonsqueezy.com/v1/checkouts");
  assert.equal(seen.i.headers["content-type"], "application/vnd.api+json"); assert.equal(seen.i.headers.authorization, "Bearer ls_key");
  assert.equal(b.data.attributes.custom_price, 2700); assert.equal(b.data.attributes.checkout_data.custom.order_ref, R); assert.equal(b.data.attributes.product_options.redirect_url, "https://s/ok"); assert.equal(b.data.attributes.test_mode, true);
  assert.deepEqual([b.data.relationships.store.data.id, b.data.relationships.variant.data.id], ["11", "22"]);
  await assert.rejects(lemonsqueezy.createCheckout(lEnv, { orderRef: R, amount: 1, successUrl: "x" }, async () => new Response("no", { status: 401 })), /ls_http_401/);
});
test("lemonsqueezy END-TO-END through the worker: paid, refund, wrong variant held, live/test mode, replay", async () => {
  const env = makeEnv({ PAYMENT_PROVIDER: "lemonsqueezy", ...lEnv, LEMONSQUEEZY_WEBHOOK_SECRET: "ls_secret", MOCK_WEBHOOK_SECRET: "" });
  const f = async () => new Response(JSON.stringify({ data: { id: "co_1", attributes: { url: "https://store.lemonsqueezy.com/checkout/custom/co_1" } } }), { status: 201 }); const deps = makeDeps({ fetch: f });
  const { body } = await startCheckout(env, deps); const hook = async (raw) => call(env, deps, "/api/webhook", { method: "POST", headers: await lSign(raw), body: raw });
  const mine = (o, m) => lOrder(o, { custom_data: { order_ref: body.ref }, ...m });
  assert.equal((await hook(mine({ first_order_item: { variant_id: 999 } }))).status, 200); assert.equal((await statusOf(env, deps, body.ref)).status, "review"); assert.equal(deps.outbox.length, 0);
  const b2 = (await startCheckout(env, deps, "L".repeat(20))).body; const m2 = (o, m) => lOrder(o, { custom_data: { order_ref: b2.ref }, ...m }, "777");
  const wrongMode = m2({ test_mode: false }, { test_mode: false }); assert.equal((await (await hook(wrongMode)).json()).ignored, "mode"); assert.equal((await statusOf(env, deps, b2.ref)).status, "pending");
  assert.equal((await hook(m2({ user_email: "x@mail.test" }))).status, 200); assert.equal((await statusOf(env, deps, b2.ref)).status, "paid"); assert.equal(deps.outbox.length, 1); assert.equal(deps.outbox[0].to, "x@mail.test");
  assert.equal((await hook(m2({}))).status, 200); assert.equal(deps.outbox.length, 1); // replay of the same LS event
  assert.equal((await hook(m2({ status: "refunded" }, { event_name: "order_refunded" }))).status, 200); assert.equal((await statusOf(env, deps, b2.ref)).status, "refunded");
});

// ===== Paddle =====
const pEnv = { PADDLE_API_KEY: "pdl_key", PADDLE_WEBHOOK_SECRET: "pdl_secret", PADDLE_PRICE_ID: "pri_1", PAYMENT_MODE: "test" };
const pEvt = (o = {}, type = "transaction.completed") => JSON.stringify({ event_id: "evt_p1", event_type: type, data: { id: "txn_1", status: "completed", customer_id: "ctm_1", custom_data: { order_ref: R }, items: [{ price: { id: "pri_1" } }], ...o } });
const pSign = async (raw, ts = T, secret = "pdl_secret", extra = "") => new Headers({ "paddle-signature": `ts=${ts};h1=${await hmacHex(secret, ts + ":" + raw)}${extra}` });
test("paddle: signature scheme (ts:body), rotation with several h1, tamper/stale/missing rejected", async () => {
  const raw = pEvt(); const e = await paddle.verifyWebhook(pEnv, raw, await pSign(raw), NOW);
  assert.deepEqual([e.kind, e.orderRef, e.sessionId, e.productOk, e.customerId], ["paid", R, "txn_1", true, "ctm_1"]);
  await paddle.verifyWebhook(pEnv, raw, new Headers({ "paddle-signature": `ts=${T};h1=${"0".repeat(64)};h1=${await hmacHex("pdl_secret", T + ":" + raw)}` }), NOW);
  await assert.rejects(paddle.verifyWebhook(pEnv, raw, await pSign(raw, T, "bad"), NOW), /signature_mismatch/); await assert.rejects(paddle.verifyWebhook(pEnv, raw.replace("txn_1", "txn_2"), await pSign(raw), NOW), /signature_mismatch/);
  await assert.rejects(paddle.verifyWebhook(pEnv, raw, await pSign(raw), NOW + 600000), /stale/); await assert.rejects(paddle.verifyWebhook(pEnv, raw, new Headers(), NOW), /bad_signature_header/);
});
test("paddle: only completed transactions are 'paid'; wrong price flagged; createCheckout + customer email lookup", async () => {
  const k = async (raw) => paddle.verifyWebhook(pEnv, raw, await pSign(raw), NOW);
  assert.equal((await k(pEvt({ status: "billed" }))).kind, "ignored"); assert.equal((await k(pEvt({}, "transaction.created"))).kind, "ignored"); assert.equal((await k(pEvt({ items: [{ price: { id: "pri_x" } }] }))).productOk, false);
  let seen; const out = await paddle.createCheckout(pEnv, { orderRef: R }, async (u, i) => { seen = { u, i }; return new Response(JSON.stringify({ data: { id: "txn_9", checkout: { url: "https://pay.example-shop.test/pay?_ptxn=txn_9" } } }), { status: 201 }); });
  assert.deepEqual(out, { url: "https://pay.example-shop.test/pay?_ptxn=txn_9", sessionId: "txn_9" }); assert.equal(seen.u, "https://sandbox-api.paddle.com/transactions"); const b = JSON.parse(seen.i.body); assert.deepEqual([b.items[0].price_id, b.custom_data.order_ref], ["pri_1", R]);
  await assert.rejects(paddle.createCheckout(pEnv, { orderRef: R }, async () => new Response(JSON.stringify({ data: { id: "txn_9", checkout: { url: null } } }))), /paddle_no_checkout_url/);
  const e = await paddle.enrich(pEnv, { kind: "paid", customerId: "ctm_1" }, async () => new Response(JSON.stringify({ data: { email: "p@m.test" } }))); assert.equal(e.email, "p@m.test");
  await assert.rejects(paddle.enrich(pEnv, { kind: "paid", customerId: "ctm_1" }, async () => new Response("x", { status: 500 })), (er) => er.retryable);
  assert.equal(paddle.createCheckout.length >= 2, true);
});
test("paddle END-TO-END through the worker (enrich + session match)", async () => {
  const env = makeEnv({ PAYMENT_PROVIDER: "paddle", ...pEnv, MOCK_WEBHOOK_SECRET: "" });
  const f = async (u, i) => String(u).includes("/customers/") ? new Response(JSON.stringify({ data: { email: "pp@mail.test" } })) : new Response(JSON.stringify({ data: { id: "txn_E", checkout: { url: "https://pay.shop.test/p?_ptxn=txn_E" } } }), { status: 201 });
  const deps = makeDeps({ fetch: f }); const { body } = await startCheckout(env, deps);
  const send = async (raw) => call(env, deps, "/api/webhook", { method: "POST", headers: await pSign(raw, String(deps.now() / 1000)), body: raw });
  assert.equal((await send(pEvt({ id: "txn_OTHER", custom_data: { order_ref: body.ref } }))).status, 200); assert.equal((await statusOf(env, deps, body.ref)).status, "review"); assert.equal(deps.outbox.length, 0);
  const b2 = (await startCheckout(env, deps, "P".repeat(20))).body; assert.equal((await send(pEvt({ id: "txn_E", custom_data: { order_ref: b2.ref } }).replace("evt_p1", "evt_p2"))).status, 200);
  assert.equal((await statusOf(env, deps, b2.ref)).status, "paid"); assert.equal(deps.outbox[0].to, "pp@mail.test");
});

// ===== Email =====
test("email templates: HTML-escape every field; all five templates render; no download link in pending/failed/refund", () => {
  const d = { link: "https://s/2/download.html#t=abc", hours: 72, max: 5, ref: "<img src=x onerror=1>", support: "help@m.test", orderUrl: "https://s/o", recoverUrl: "https://s/r", siteUrl: "https://s/" };
  for (const k of Object.keys(templates)) { const t = templates[k](d); assert.ok(t.subject && t.text && t.html, k); assert.ok(!t.html.includes("<img"), k + " unescaped"); }
  for (const k of ["pendingPayment", "paymentFailed", "refundConfirmation"]) assert.ok(!templates[k](d).text.includes("#t="), k);
  assert.ok(templates.paidDelivery(d).text.includes("#t=abc") && templates.resend(d).text.includes("#t=abc"));
});
test("sendEmail: not configured throws; correct request; provider error throws", async () => {
  await assert.rejects(sendEmail({}, "a@b.co", { subject: "s", text: "t", html: "h" }, fetch), /email_not_configured/);
  let seen; const env = { RESEND_API_KEY: "re_x", EMAIL_FROM: "Z <o@m.test>", SUPPORT_EMAIL: "help@m.test" };
  await sendEmail(env, "c@d.co", { subject: "s", text: "t", html: "h" }, async (u, i) => { seen = { u, i }; return new Response("{}"); });
  const b = JSON.parse(seen.i.body); assert.deepEqual([seen.u, b.to, b.reply_to, seen.i.headers.authorization], ["https://api.resend.com/emails", ["c@d.co"], "help@m.test", "Bearer re_x"]);
  await assert.rejects(sendEmail(env, "c@d.co", { subject: "s", text: "t", html: "h" }, async () => new Response("no", { status: 500 })), /email_http_500/);
});
