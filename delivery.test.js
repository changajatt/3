import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeDeps, call, post, startCheckout, webhook, paidEvent, statusOf, paidOrder, dl, tokenFrom, SITE } from "./helpers.js";

test("paid order: token downloads the PDF with safe headers", async () => {
  const env = makeEnv(), deps = makeDeps(); const { token } = await paidOrder(env, deps); const r = await dl(env, deps, token);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/pdf"); assert.match(r.headers.get("content-disposition"), /attachment/);
  assert.equal(r.headers.get("cache-control"), "private, no-store"); assert.equal(r.headers.get("x-robots-tag"), "noindex"); assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.match(await r.text(), /%PDF/);
});
test("unpaid orders can never get a token or download", async () => {
  const env = makeEnv(), deps = makeDeps(); const { body } = await startCheckout(env, deps);
  assert.equal(await env.__ledger.call("issueToken", body.ref, "h".repeat(64), Date.now() + 1e6, 5), false);
  assert.equal((await dl(env, deps, "z".repeat(40))).status, 404);
  const o = await env.__ledger.core.get("order:" + body.ref); assert.equal(o.tokenHash, undefined);
});
test("invalid / malformed / missing tokens rejected", async () => {
  const env = makeEnv(), deps = makeDeps(); await paidOrder(env, deps);
  for (const t of ["", "short", "z".repeat(40), "../etc/passwd" + "a".repeat(10), undefined, 123]) assert.equal((await dl(env, deps, t)).status, 404, String(t));
});
test("expired token rejected", async () => {
  const env = makeEnv(), deps = makeDeps(); const { token } = await paidOrder(env, deps);
  assert.equal((await dl(env, makeDeps({ now: () => 1_700_000_000_000 + 73 * 3600000 }), token)).status, 410);
});
test("download limit enforced (MAX_DOWNLOADS=2); info reports remaining without consuming", async () => {
  const env = makeEnv(), deps = makeDeps(); const { token } = await paidOrder(env, deps);
  assert.equal((await (await dl(env, deps, token, "/api/download-info")).json()).remaining, 2);
  assert.equal((await dl(env, deps, token)).status, 200); assert.equal((await (await dl(env, deps, token, "/api/download-info")).json()).remaining, 1);
  assert.equal((await dl(env, deps, token)).status, 200); assert.equal((await dl(env, deps, token)).status, 410);
});
test("concurrent downloads cannot exceed the limit", async () => {
  const env = makeEnv({ MAX_DOWNLOADS: "3" }), deps = makeDeps(); const { token } = await paidOrder(env, deps);
  const rs = await Promise.all(Array.from({ length: 10 }, () => dl(env, deps, token))); assert.equal(rs.filter((r) => r.status === 200).length, 3);
});
test("missing PDF in storage: 503 and the download is NOT counted", async () => {
  const env = makeEnv(), deps = makeDeps(); const { token } = await paidOrder(env, deps); const real = env.DOWNLOADS; env.DOWNLOADS = { async get() { return null; } };
  assert.equal((await dl(env, deps, token)).status, 503); env.DOWNLOADS = real; assert.equal((await (await dl(env, deps, token, "/api/download-info")).json()).remaining, 2);
});
test("customer isolation: a token only serves its own order; status/info never expose emails or tokens", async () => {
  const env = makeEnv(), deps = makeDeps(); const a = await paidOrder(env, deps, "a".repeat(20), "alice@mail.test"), b = await paidOrder(env, deps, "b".repeat(20), "bob@mail.test");
  assert.notEqual(a.token, b.token); const dump = JSON.stringify([await statusOf(env, deps, a.ref), await (await dl(env, deps, a.token, "/api/download-info")).json(), await (await call(env, deps, "/api/product")).json()]);
  for (const s of ["alice@", "bob@", a.token, b.token, "tokenHash"]) assert.ok(!dump.includes(s), s);
  assert.equal((await post(env, deps, "/api/resend", { email: "bob@mail.test" }, { "cf-connecting-ip": "5.5.5.5" })).status, 200);
  assert.equal(deps.outbox.at(-1).to, "bob@mail.test"); assert.equal((await dl(env, deps, a.token)).status, 200); // alice's link unaffected by bob's resend
});
test("email failure: webhook returns 500 (provider retries), order stays paid + recoverable; retry delivers once", async () => {
  const env = makeEnv(); let fail = true; const sent = [];
  const deps = makeDeps({ sendEmail: async (e, to, msg) => { if (fail) throw new Error("smtp_down"); sent.push({ to, msg }); } });
  const { body } = await startCheckout(env, deps); const ev = paidEvent(body.ref);
  assert.equal((await webhook(env, deps, ev)).status, 500);
  let s = await statusOf(env, deps, body.ref); assert.deepEqual([s.status, s.delivery, s.supportEmail], ["paid", "email_failed", "help@mail.test"]);
  fail = false; assert.equal((await webhook(env, deps, ev)).status, 200); // provider retry of the SAME event
  s = await statusOf(env, deps, body.ref); assert.deepEqual([s.status, s.delivery], ["paid", "sent"]); assert.equal(sent.length, 1);
  assert.equal((await webhook(env, deps, ev)).status, 200); assert.equal(sent.length, 1); // further replays do nothing
});
test("email failure is never reported as delivered; customer can still resend", async () => {
  const env = makeEnv(); let fail = true; const sent = [];
  const deps = makeDeps({ sendEmail: async (e, to, msg) => { if (fail) throw new Error("x"); sent.push(msg); } });
  const { body } = await startCheckout(env, deps); await webhook(env, deps, paidEvent(body.ref)); assert.notEqual((await statusOf(env, deps, body.ref)).delivery, "sent");
  fail = false; await post(env, deps, "/api/resend", { email: "buyer@mail.test" }); assert.equal(sent.length, 1); assert.equal((await statusOf(env, deps, body.ref)).delivery, "sent");
});
test("resend: same response for known/unknown address, only paid orders, throttled, new link kills old link", async () => {
  const env = makeEnv(), deps = makeDeps(); const { token } = await paidOrder(env, deps);
  const known = await post(env, deps, "/api/resend", { email: "buyer@mail.test" }), unknown = await post(env, deps, "/api/resend", { email: "nobody@mail.test" });
  assert.deepEqual(await known.json(), await unknown.json()); assert.equal(deps.outbox.length, 2);
  await post(env, deps, "/api/resend", { email: "buyer@mail.test" }); assert.equal(deps.outbox.length, 2); // throttled, still identical reply
  assert.equal((await dl(env, deps, token)).status, 404); assert.equal((await dl(env, deps, tokenFrom(deps.outbox[1].msg))).status, 200);
  assert.equal((await post(env, deps, "/api/resend", { email: "nope" })).status, 400);
});
test("resend: refunded / failed orders get nothing", async () => {
  const env = makeEnv(), deps = makeDeps(); const { ref } = await paidOrder(env, deps); await webhook(env, deps, paidEvent(ref, { kind: "refunded", id: "r", orderRef: "", sessionId: "" })); const n = deps.outbox.length;
  await post(env, deps, "/api/resend", { email: "buyer@mail.test" }, { "cf-connecting-ip": "7.7.7.7" }); assert.equal(deps.outbox.length, n);
});
test("resend rate limit per IP (429 after 10/hour) and download-info limit (429 after 60/hour)", async () => {
  const env = makeEnv(), deps = makeDeps(); let last; for (let i = 0; i < 11; i++) last = (await post(env, deps, "/api/resend", { email: `u${i}@mail.test` }, { "cf-connecting-ip": "8.8.8.8" })).status; assert.equal(last, 429);
  for (let i = 0; i < 61; i++) last = (await dl(env, deps, "z".repeat(30), "/api/download-info", "6.6.6.6")).status; assert.equal(last, 429);
});
