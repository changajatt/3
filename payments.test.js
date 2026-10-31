import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeDeps, call, post, startCheckout, webhook, paidEvent, statusOf, paidOrder, dl, tokenFrom } from "./helpers.js";

// ---------- checkout ----------
test("product: price from server settings; availability reflects configuration", async () => {
  const r = await (await call(makeEnv(), makeDeps(), "/api/product")).json(); assert.equal(r.priceLabel, "$27.00 USD"); assert.equal(r.checkoutAvailable, true);
});
test("checkout unavailable (503) when ANY required setting is missing", async () => {
  for (const over of [{ PAYMENT_PROVIDER: "" }, { RESEND_API_KEY: "" }, { PDF_KEY: "" }, { DOWNLOADS: undefined }, { SUPPORT_EMAIL: "" }, { PAYMENT_MODE: "" }, { MOCK_WEBHOOK_SECRET: "" }, { API_URL: "" }, { PAYMENT_MODE: "banana" }]) {
    const env = makeEnv(over), deps = makeDeps(); assert.equal((await startCheckout(env, deps)).res.status, 503, JSON.stringify(over));
    assert.equal((await (await call(env, deps, "/api/product")).json()).checkoutAvailable, false);
  }
});
test("mock provider refused in production; unknown provider refused", async () => {
  assert.equal((await startCheckout(makeEnv({ ENVIRONMENT: "production" }), makeDeps())).res.status, 503);
  assert.equal((await startCheckout(makeEnv({ PAYMENT_PROVIDER: "nope" }), makeDeps())).res.status, 503);
});
test("checkout ignores browser-supplied price/currency/status; server values are used", async () => {
  const env = makeEnv(), deps = makeDeps();
  const r = await post(env, deps, "/api/checkout", { productId: "ams-ebook", price: 1, amount: 1, currency: "EUR", status: "paid" }, { "idempotency-key": "a".repeat(20) });
  assert.equal(r.status, 200); assert.equal(env.__lastCheckout.amount, 2700); assert.equal(env.__lastCheckout.currency, "USD");
  assert.equal((await statusOf(env, deps, (await r.json()).ref)).status, "pending");
});
test("unknown product, missing/short idempotency key, bad JSON, oversized body rejected", async () => {
  const env = makeEnv(), deps = makeDeps(), k = { "idempotency-key": "a".repeat(20) };
  assert.equal((await post(env, deps, "/api/checkout", { productId: "x" }, k)).status, 400);
  assert.equal((await post(env, deps, "/api/checkout", { productId: "ams-ebook" })).status, 400);
  assert.equal((await post(env, deps, "/api/checkout", { productId: "ams-ebook" }, { "idempotency-key": "short" })).status, 400);
  assert.equal((await call(env, deps, "/api/checkout", { method: "POST", headers: { origin: "https://site.test", ...k }, body: "{not json" })).status, 400);
  assert.equal((await post(env, deps, "/api/checkout", { productId: "ams-ebook", pad: "x".repeat(5000) }, k)).status, 400);
});
test("repeated checkout request (same key) reuses ONE session/order", async () => {
  const env = makeEnv(), deps = makeDeps(); const a = await startCheckout(env, deps, "dup".repeat(8)), b = await startCheckout(env, deps, "dup".repeat(8));
  assert.equal(a.body.ref, b.body.ref); assert.equal(a.body.url, b.body.url); assert.equal(env.__checkoutCount, 1);
  assert.notEqual((await startCheckout(env, deps, "other".repeat(5))).body.ref, a.body.ref);
});
test("simultaneous duplicate requests create exactly one provider session", async () => {
  const env = makeEnv(), deps = makeDeps(); const rs = await Promise.all(Array.from({ length: 6 }, () => startCheckout(env, deps, "race".repeat(6))));
  assert.equal(env.__checkoutCount, 1); assert.equal(rs.filter((r) => r.res.status === 200).length >= 1, true); assert.ok(rs.every((r) => [200, 409].includes(r.res.status)));
});
test("provider failure releases the key so the customer can retry", async () => {
  const env = makeEnv(), deps = makeDeps(); const orig = env.__ledger; let fail = true;
  const { mock } = await import("../src/providers/mock.js"); const real = mock.createCheckout; mock.createCheckout = async (...a) => { if (fail) throw new Error("down"); return real(...a); };
  try { assert.equal((await startCheckout(env, deps, "retry".repeat(5))).res.status, 502); fail = false; assert.equal((await startCheckout(env, deps, "retry".repeat(5))).res.status, 200); } finally { mock.createCheckout = real; }
});
test("checkout rate limit per IP (429 after 20/hour)", async () => {
  const env = makeEnv(), deps = makeDeps(); let last;
  for (let i = 0; i < 21; i++) last = (await startCheckout(env, deps, "rl" + String(i).padStart(18, "x"), "9.9.9.9")).res.status;
  assert.equal(last, 429);
});

// ---------- verified payment ----------
test("valid paid event: order paid, ONE email with site download link, status delivered", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  assert.equal((await webhook(env, deps, paidEvent(body.ref))).status, 200);
  const s = await statusOf(env, deps, body.ref); assert.deepEqual([s.status, s.delivery], ["paid", "sent"]);
  assert.equal(deps.outbox.length, 1); assert.equal(deps.outbox[0].to, "buyer@mail.test"); assert.match(deps.outbox[0].msg.text, /https:\/\/site\.test\/2\/download\.html#t=[\w-]+/);
});
test("invalid or missing signature: rejected, nothing changes", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  assert.equal((await webhook(env, deps, paidEvent(body.ref), { secret: "wrong" })).status, 400);
  assert.equal((await webhook(env, deps, paidEvent(body.ref), { sign: false })).status, 400);
  assert.equal((await statusOf(env, deps, body.ref)).status, "pending"); assert.equal(deps.outbox.length, 0);
});
test("forged success URL (no webhook) never marks paid or delivers", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  const s = await statusOf(env, deps, body.ref); assert.deepEqual([s.status, s.delivery], ["pending", "none"]); assert.equal(deps.outbox.length, 0);
});
test("unknown order reference: ignored, no order is created, nothing sent", async () => {
  const env = makeEnv(), deps = makeDeps(); const ref = "Z".repeat(22);
  assert.equal((await webhook(env, deps, paidEvent(ref))).status, 200); assert.equal((await call(env, deps, "/api/order-status?ref=" + ref)).status, 404); assert.equal(deps.outbox.length, 0);
});
test("SECURITY: valid payment for session B cannot be attached to order A by reusing A's reference", async () => {
  const env = makeEnv(), deps = makeDeps(); const A = (await startCheckout(env, deps, "A".repeat(20))).body, B = (await startCheckout(env, deps, "B".repeat(20))).body;
  await webhook(env, deps, paidEvent(A.ref, { sessionId: "mock_" + B.ref, id: "evt_attack" }));
  assert.equal((await statusOf(env, deps, A.ref)).status, "review"); assert.equal(deps.outbox.length, 0); assert.equal((await statusOf(env, deps, B.ref)).status, "pending");
});
test("session id missing on a provider that requires it: held for review", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  await webhook(env, deps, paidEvent(body.ref, { sessionId: "" })); assert.equal((await statusOf(env, deps, body.ref)).status, "review"); assert.equal(deps.outbox.length, 0);
});
test("wrong amount / wrong currency / wrong product: held for review, nothing delivered", async () => {
  for (const o of [{ amount: 100 }, { currency: "EUR" }, { productOk: false }]) {
    const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps); await webhook(env, deps, paidEvent(body.ref, o));
    assert.equal((await statusOf(env, deps, body.ref)).status, "review", JSON.stringify(o)); assert.equal(deps.outbox.length, 0);
  }
});
test("test-mode event on a live endpoint (and vice versa) is ignored", async () => {
  const env = makeEnv({ PAYMENT_MODE: "live" }), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  const r = await webhook(env, deps, paidEvent(body.ref)); assert.equal((await r.json()).ignored, "mode"); assert.equal((await statusOf(env, deps, body.ref)).status, "pending");
});
test("pending payment: no delivery; ONE pending notice (no download link in it)", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  await webhook(env, deps, paidEvent(body.ref, { kind: "pending", id: "p1" })); await webhook(env, deps, paidEvent(body.ref, { kind: "pending", id: "p2" }));
  assert.equal((await statusOf(env, deps, body.ref)).status, "pending"); assert.equal(deps.outbox.length, 1); assert.ok(!/download\.html#t=/.test(deps.outbox[0].msg.text)); assert.match(deps.outbox[0].msg.subject, /still being confirmed/);
});
test("failed payment: status failed, one guidance email, no download; cancelled/expired: status cancelled", async () => {
  const env = makeEnv(), deps = makeDeps(); const a = (await startCheckout(env, deps, "f".repeat(20))).body, b = (await startCheckout(env, deps, "g".repeat(20))).body;
  await webhook(env, deps, paidEvent(a.ref, { kind: "failed" })); assert.equal((await statusOf(env, deps, a.ref)).status, "failed"); assert.equal(deps.outbox.length, 1); assert.match(deps.outbox[0].msg.subject, /did not go through/);
  await webhook(env, deps, paidEvent(b.ref, { kind: "expired" })); assert.equal((await statusOf(env, deps, b.ref)).status, "cancelled"); assert.equal(deps.outbox.length, 1);
});
test("duplicate webhook (same event id) never sends a second email", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps); await webhook(env, deps, paidEvent(body.ref)); const r = await webhook(env, deps, paidEvent(body.ref));
  assert.equal((await r.json()).ok, true); assert.equal(deps.outbox.length, 1);
});
test("many concurrent paid events (different ids) produce exactly ONE delivery", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  await Promise.all(Array.from({ length: 12 }, (_, i) => webhook(env, deps, paidEvent(body.ref, { id: "evt_c" + i })))); assert.equal(deps.outbox.length, 1);
});
test("refund: status refunded, link revoked, confirmation email, later paid event ignored", async () => {
  const env = makeEnv(), deps = makeDeps(); const { ref, token } = await paidOrder(env, deps);
  await webhook(env, deps, paidEvent(ref, { kind: "refunded", id: "r1", orderRef: "", sessionId: "" }));
  assert.equal((await statusOf(env, deps, ref)).status, "refunded"); assert.equal((await dl(env, deps, token)).status, 404);
  assert.match(deps.outbox.at(-1).msg.subject, /refund/i); const n = deps.outbox.length;
  await webhook(env, deps, paidEvent(ref, { id: "late" })); assert.equal((await statusOf(env, deps, ref)).status, "refunded"); assert.equal(deps.outbox.length, n);
});
test("refund of an unpaid order is ignored; refund event for unknown transaction ignored", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  await webhook(env, deps, paidEvent(body.ref, { kind: "refunded", id: "r0" })); assert.equal((await statusOf(env, deps, body.ref)).status, "pending");
  assert.equal((await webhook(env, deps, { id: "r9", kind: "refunded", orderRef: "", transactionId: "nope" })).status, 200);
});
test("dispute blocks downloads; winning the dispute restores access", async () => {
  const env = makeEnv(), deps = makeDeps(); const { ref, token } = await paidOrder(env, deps);
  await webhook(env, deps, { id: "d1", kind: "disputed", orderRef: "", transactionId: "tx_" + ref }); assert.equal((await statusOf(env, deps, ref)).status, "disputed"); assert.equal((await dl(env, deps, token)).status, 403);
  await webhook(env, deps, { id: "d2", kind: "dispute_won", orderRef: "", transactionId: "tx_" + ref }); assert.equal((await statusOf(env, deps, ref)).status, "paid"); assert.equal((await dl(env, deps, token)).status, 200);
});
test("ledger: buyer-identity mismatch and provider mismatch are held/refused", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps); const core = env.__ledger.core;
  const o = await core.get("order:" + body.ref); o.email = "first@mail.test"; await core.put("order:" + body.ref, o);
  const r = await env.__ledger.call("processEvent", { id: "x1", kind: "paid", orderRef: body.ref, sessionId: "mock_" + body.ref, email: "other@mail.test" }, { provider: "mock", sessionRequired: true, now: 1 }); assert.equal(r.outcome, "buyer_mismatch");
  assert.equal((await env.__ledger.call("processEvent", { id: "x2", kind: "paid", orderRef: body.ref }, { provider: "lemonsqueezy", now: 1 })).outcome, "provider_mismatch");
});
