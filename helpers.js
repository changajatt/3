import { route } from "../src/index.js";
import { MemoryLedger } from "../src/ledger.js";
import { hmacHex } from "../src/util.js";

export const SITE = "https://site.test", SITE_URL = SITE + "/2";
export const fakeR2 = (bytes = "%PDF-1.7 TEST-FILE") => ({ async get(k) { return k === "test.pdf" ? { body: new Response(bytes).body } : null; } });
export function makeEnv(over = {}) {
  return {
    ENVIRONMENT: "test", ALLOW_MOCK_PAYMENTS: "true", PAYMENT_PROVIDER: "mock", PAYMENT_MODE: "test", MOCK_WEBHOOK_SECRET: "whsec_test",
    SITE_URL, SITE_ORIGIN: SITE, API_URL: "https://api.test", PRICE_CENTS: "2700", CURRENCY: "USD", PDF_KEY: "test.pdf",
    DOWNLOAD_HOURS: "72", MAX_DOWNLOADS: "2", EMAIL_FROM: "Z <o@mail.test>", SUPPORT_EMAIL: "help@mail.test", RESEND_API_KEY: "re_test",
    LEDGER: {}, DOWNLOADS: fakeR2(), __ledger: new MemoryLedger(), ...over,
  };
}
export function makeDeps(over = {}) {
  const outbox = [];
  return { outbox, now: () => 1_700_000_000_000, sendEmail: async (env, to, msg) => { outbox.push({ to, msg }); }, ...over };
}
export const call = (env, deps, path, init = {}) => route(new Request("https://api.test" + path, init), env, deps);
export const post = (env, deps, path, body, headers = {}) =>
  call(env, deps, path, { method: "POST", headers: { "content-type": "application/json", origin: SITE, "cf-connecting-ip": "1.1.1.1", ...headers }, body: JSON.stringify(body) });
export async function startCheckout(env, deps, key = "k".repeat(20), ip = "1.1.1.1") {
  const res = await post(env, deps, "/api/checkout", { productId: "ams-ebook" }, { "idempotency-key": key, "cf-connecting-ip": ip });
  return { res, body: await res.json() };
}
export async function webhook(env, deps, ev, { secret = "whsec_test", sign = true } = {}) {
  const raw = JSON.stringify(ev);
  return call(env, deps, "/api/webhook", { method: "POST", headers: sign ? { "x-mock-signature": await hmacHex(secret, raw) } : {}, body: raw });
}
// A normal verified payment for `ref` (sessionId matches what the mock provider issued at checkout).
export const paidEvent = (ref, o = {}) => ({ id: "evt_" + ref + (o.kind || "paid"), kind: "paid", orderRef: ref, sessionId: "mock_" + ref, transactionId: "tx_" + ref, amount: 2700, currency: "USD", email: "buyer@mail.test", ...o });
export const statusOf = async (env, deps, ref) => (await call(env, deps, "/api/order-status?ref=" + ref, { headers: { origin: SITE } })).json();
export const tokenFrom = (msg) => msg.text.match(/#t=([\w-]+)/)[1];
export const dl = (env, deps, token, path = "/api/download", ip = "2.2.2.2") => post(env, deps, path, { token }, { "cf-connecting-ip": ip });
export async function paidOrder(env, deps, key = "k".repeat(20), email = "buyer@mail.test") {
  const { body } = await startCheckout(env, deps, key); await webhook(env, deps, paidEvent(body.ref, { email }));
  return { ref: body.ref, token: tokenFrom(deps.outbox[deps.outbox.length - 1].msg) };
}
