import { stripe } from "./stripe.js";
import { lemonsqueezy } from "./lemonsqueezy.js";
import { paddle } from "./paddle.js";
import { mock } from "./mock.js";

// ADD A PROVIDER: create providers/<name>.js exporting
//   { name, requiredEnv: [...], sessionRequired: bool,
//     createCheckout(env, order, fetch) -> { url, sessionId },
//     verifyWebhook(env, rawBody, headers, nowMs) -> normalised event (MUST verify the provider's signature first, else throw),
//     verifyTransaction?(env, event, fetch)  // optional server-to-server re-check, throw {mismatch:true} if inconsistent
//     enrich?(env, event, fetch) -> event }   // optional, e.g. fetch the buyer email
// Normalised event: { id, kind: paid|pending|failed|expired|refunded|disputed|dispute_won|ignored, orderRef, sessionId,
//   transactionId, amount|null, currency|null, email, productOk: true|false|null, livemode: true|false|null }
// then register it below. Nothing else in the project changes.
const registry = { lemonsqueezy, paddle, stripe, mock };

export function getProvider(env) {
  const name = String(env.PAYMENT_PROVIDER || "").toLowerCase();
  if (!name || !registry[name]) return null;
  if (name === "mock" && (env.ENVIRONMENT === "production" || env.ALLOW_MOCK_PAYMENTS !== "true")) return null;
  return registry[name];
}
export const providerNames = () => Object.keys(registry).filter((n) => n !== "mock");
