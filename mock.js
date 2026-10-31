// TEST-ONLY provider (refused in production). Lets tests and the local simulator exercise the real code paths.
import { hmacHex, safeEqual } from "../util.js";
export const mock = {
  name: "mock",
  requiredEnv: ["MOCK_WEBHOOK_SECRET"],
  sessionRequired: true,
  async createCheckout(env, o) { env.__lastCheckout = o; env.__checkoutCount = (env.__checkoutCount || 0) + 1; return { url: "https://pay.mock.test/session/" + o.orderRef, sessionId: "mock_" + o.orderRef }; },
  async verifyWebhook(env, raw, headers) {
    if (!safeEqual(headers.get("x-mock-signature") || "", await hmacHex(env.MOCK_WEBHOOK_SECRET, raw))) throw new Error("signature_mismatch");
    return { livemode: false, sessionId: "", transactionId: "", amount: null, currency: null, email: "", productOk: null, ...JSON.parse(raw) };
  },
};
