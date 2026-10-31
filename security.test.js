import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeDeps, call, post, startCheckout, webhook, paidEvent, statusOf, paidOrder, dl, tokenFrom, SITE } from "./helpers.js";
import { MemoryLedger } from "../src/ledger.js";

test("CORS: only the configured site origin; others get 403 on every browser endpoint and no allow-origin header", async () => {
  const env = makeEnv(), deps = makeDeps();
  for (const [path, b] of [["/api/checkout", { productId: "ams-ebook" }], ["/api/resend", { email: "a@b.co" }], ["/api/download", { token: "x".repeat(30) }], ["/api/download-info", { token: "x".repeat(30) }]]) {
    const r = await post(env, deps, path, b, { origin: "https://evil.test", "idempotency-key": "a".repeat(20) }); assert.equal(r.status, 403, path); assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await call(env, deps, "/api/product", { headers: { origin: SITE } })).headers.get("access-control-allow-origin"), SITE);
  assert.equal((await call(env, deps, "/api/product", { method: "OPTIONS", headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await call(env, deps, "/api/product", { method: "OPTIONS", headers: { origin: SITE } })).status, 204);
});
test("no GET download route exists (tokens never travel in URLs)", async () => {
  const env = makeEnv(), deps = makeDeps(); const { token } = await paidOrder(env, deps); assert.equal((await call(env, deps, "/api/download?t=" + token)).status, 404);
});
test("unknown routes/methods 404", async () => {
  const env = makeEnv(), deps = makeDeps(); assert.equal((await call(env, deps, "/api/nope")).status, 404); assert.equal((await call(env, deps, "/api/checkout")).status, 404); assert.equal((await call(env, deps, "/api/webhook")).status, 404);
});
test("responses and logs never contain secrets, emails, tokens or full tokens hashes", async () => {
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(" "));
  const env = makeEnv(), responses = [];
  try {
    const deps = makeDeps(); const { body } = await startCheckout(env, deps); responses.push(JSON.stringify(body));
    for (const r of [await webhook(env, deps, paidEvent(body.ref)), await webhook(env, deps, paidEvent(body.ref), { secret: "bad" }), await call(env, deps, "/api/product"), await statusOf(env, deps, body.ref) && new Response("")]) responses.push(await r.text());
    const tok = deps.outbox[0].msg.text.match(/#t=([\w-]+)/)[1];
    const failing = makeDeps({ sendEmail: async () => { throw new Error("boom"); } }); const b2 = (await startCheckout(env, failing, "z".repeat(20))).body; await webhook(env, failing, paidEvent(b2.ref));
    const all = responses.join("\n") + "\n" + logs.join("\n");
    for (const s of ["buyer@mail.test", tok, "whsec_test", "re_test"]) assert.ok(!all.includes(s), "leaked: " + s);
  } finally { console.error = orig; }
  assert.ok(logs.length > 0);
});
test("admin endpoint: disabled without ADMIN_TOKEN; wrong token 403; get is redacted; release/redeliver work; rate limited", async () => {
  const deps = makeDeps(); let env = makeEnv(); const { body } = await startCheckout(env, deps);
  assert.equal((await post(env, deps, "/api/admin", { action: "get", ref: body.ref }, { authorization: "Bearer x" })).status, 404);
  env = makeEnv({ ADMIN_TOKEN: "t".repeat(32) }); const d2 = makeDeps(); const o = (await startCheckout(env, d2, "q".repeat(20))).body; const H = { authorization: "Bearer " + "t".repeat(32), "cf-connecting-ip": "3.3.3.3" };
  assert.equal((await post(env, d2, "/api/admin", { action: "get", ref: o.ref }, { authorization: "Bearer wrong", "cf-connecting-ip": "3.3.3.3" })).status, 403);
  await webhook(env, d2, paidEvent(o.ref, { amount: 5 })); // -> review
  const got = await (await post(env, d2, "/api/admin", { action: "get", ref: o.ref }, H)).json(); assert.equal(got.status, "review"); assert.equal(got.reviewReason, "amount_mismatch"); assert.ok(!JSON.stringify(got).includes("buyer@mail.test")); assert.equal(got.tokenHash, undefined);
  assert.equal((await (await post(env, d2, "/api/admin", { action: "release", ref: o.ref }, H)).json()).emailed, true); assert.equal((await statusOf(env, d2, o.ref)).status, "paid");
  assert.equal((await post(env, d2, "/api/admin", { action: "release", ref: o.ref }, H)).status, 409);
  assert.equal((await (await post(env, d2, "/api/admin", { action: "redeliver", ref: o.ref }, H)).json()).emailed, true); assert.equal(d2.outbox.length, 2);
  let last; for (let i = 0; i < 21; i++) last = (await post(env, d2, "/api/admin", { action: "get", ref: o.ref }, { authorization: "Bearer wrong", "cf-connecting-ip": "4.4.4.4" })).status; assert.equal(last, 429);
});
test("input validation: refs and tokens are pattern-checked; invalid refs 404", async () => {
  const env = makeEnv(), deps = makeDeps();
  for (const r of ["", "a", "../../x", "<script>", "a".repeat(80)]) assert.equal((await call(env, deps, "/api/order-status?ref=" + encodeURIComponent(r))).status, 404);
});
test("ledger purge removes stale rate-limit/idempotency/token/event records but keeps orders", async () => {
  const L = new MemoryLedger(), c = L.core, DAY = 86400000, now = 1e12;
  await c.put("rl:a", { w: 1, n: 1, t: now - 2 * DAY }); await c.put("idem:a", { at: now - DAY }); await c.put("tok:a", { expiresAt: now - 8 * DAY }); await c.put("evt:p:a", { at: now - 100 * DAY });
  await c.put("rl:b", { w: 1, n: 1, t: now }); await c.put("order:o", { ref: "o" });
  assert.equal(await L.call("purge", now), 4); assert.ok(await c.get("rl:b")); assert.ok(await c.get("order:o")); assert.equal(await c.get("rl:a"), null);
});
test("ledger RPC allow-list rejects unknown operations", async () => { assert.throws(() => new MemoryLedger().call("__proto__"), /bad_op/); assert.throws(() => new MemoryLedger().call("get", "x"), /bad_op/); });
test("repo hygiene: no PDF files, no .env, secrets only as names", async () => {
  const { execSync } = await import("node:child_process"); const root = new URL("../../", import.meta.url).pathname;
  assert.equal(execSync(`find "${root}" -name "*.pdf" -not -path "*/node_modules/*" | wc -l`).toString().trim(), "0");
  assert.equal(execSync(`find "${root}" -name ".env" -o -name ".dev.vars" | wc -l`).toString().trim(), "0");
});

test("admin export: requires the admin token; returns orders without token hashes; backup script is syntactically valid", async () => {
  const env = makeEnv({ ADMIN_TOKEN: "t".repeat(32) }), deps = makeDeps(); const { ref } = await paidOrder(env, deps);
  assert.equal((await post(env, deps, "/api/admin", { action: "export" }, { authorization: "Bearer nope" })).status, 403);
  assert.equal((await post(env, deps, "/api/admin", { action: "export" })).status, 403);
  const r = await (await post(env, deps, "/api/admin", { action: "export" }, { authorization: "Bearer " + "t".repeat(32) })).json();
  assert.equal(r.orders.length, 1); assert.equal(r.orders[0].ref, ref); assert.equal(r.orders[0].email, "buyer@mail.test"); assert.equal(r.orders[0].tokenHash, undefined);
});

test("admin block/unblock: owner can pause an order's downloads (provider-side disputes/refunds) and restore it", async () => {
  const env = makeEnv({ ADMIN_TOKEN: "t".repeat(32) }), deps = makeDeps(); const { ref, token } = await paidOrder(env, deps); const H = { authorization: "Bearer " + "t".repeat(32) };
  assert.equal((await post(env, deps, "/api/admin", { action: "unblock", ref }, H)).status, 409); // only a blocked order can be unblocked
  assert.equal((await post(env, deps, "/api/admin", { action: "block", ref }, H)).status, 200);
  assert.equal((await statusOf(env, deps, ref)).status, "disputed"); assert.equal((await dl(env, deps, token)).status, 404);
  assert.equal((await post(env, deps, "/api/admin", { action: "block", ref }, H)).status, 409);
  const r = await (await post(env, deps, "/api/admin", { action: "unblock", ref }, H)).json(); assert.equal(r.emailed, true);
  assert.equal((await statusOf(env, deps, ref)).status, "paid"); assert.equal((await dl(env, deps, tokenFrom(deps.outbox.at(-1).msg))).status, 200);
});

test("admin erase (privacy request): removes the order, its link and indexes; resend then finds nothing; other customers untouched", async () => {
  const env = makeEnv({ ADMIN_TOKEN: "t".repeat(32) }), deps = makeDeps(); const a = await paidOrder(env, deps, "a".repeat(20), "alice@mail.test"), b = await paidOrder(env, deps, "b".repeat(20), "bob@mail.test"); const H = { authorization: "Bearer " + "t".repeat(32) };
  assert.equal((await post(env, deps, "/api/admin", { action: "erase", ref: a.ref }, H)).status, 200);
  assert.equal((await call(env, deps, "/api/order-status?ref=" + a.ref)).status, 404); assert.equal((await dl(env, deps, a.token)).status, 404);
  const n = deps.outbox.length; await post(env, deps, "/api/resend", { email: "alice@mail.test" }, { "cf-connecting-ip": "5.5.5.5" }); assert.equal(deps.outbox.length, n);
  assert.equal((await dl(env, deps, b.token)).status, 200); assert.equal((await statusOf(env, deps, b.ref)).status, "paid");
  const left = [...env.__ledger.core.st.m].filter(([k, v]) => /^(order|txn|tok|em):/.test(k) && (k + JSON.stringify(v)).includes(a.ref)); assert.deepEqual(left, []); // only non-personal dedupe/idempotency stubs may remain
  assert.equal((await post(env, deps, "/api/admin", { action: "erase", ref: a.ref }, H)).status, 404);
});
