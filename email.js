import { esc } from "./util.js";

// Sender: Resend REST API (reference adapter, not tested against a live account). To use another email service,
// replace only this function; the rest of the project just calls sendEmail(env, to, message, fetch).
export async function sendEmail(env, to, msg, doFetch) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("email_not_configured");
  const r = await doFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], reply_to: env.EMAIL_REPLY_TO || env.SUPPORT_EMAIL, subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!r.ok) throw new Error("email_http_" + r.status);
}

const wrap = (inner) => `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:auto;color:#14182b;line-height:1.6">${inner}<hr style="border:0;border-top:1px solid #dde2ee"><p style="color:#566079;font-size:13px">Zyvtron · AI Marketing Freelancer System</p></div>`;
const btn = (href, label) => `<p><a href="${esc(href)}" style="background:#00d4c0;color:#0b1020;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">${esc(label)}</a></p>`;
const limits = (d) => `The link works for ${d.hours} hours and up to ${d.max} downloads. If it expires, request a new one at ${d.recoverUrl}.`;

// d = { link, hours, max, ref, support, orderUrl, recoverUrl }
export const templates = {
  // 1. Sent ONLY after verified payment.
  paidDelivery: (d) => ({
    subject: "Your AI Marketing Freelancer System download",
    text: `Thank you for your purchase. Your payment has been confirmed.\n\nDownload your PDF: ${d.link}\n\n${limits(d)}\nOrder reference: ${d.ref}\nOrder page: ${d.orderUrl}\nProblems? Reply to this email or contact ${d.support}.`,
    html: wrap(`<h2>Your payment is confirmed</h2><p>Thank you for buying <strong>AI Marketing Freelancer System</strong> (PDF ebook).</p>${btn(d.link, "Download your PDF")}<p>${esc(limits(d))}</p><p>Order reference: <code>${esc(d.ref)}</code><br><a href="${esc(d.orderUrl)}">View your order</a><br>Problems? Reply to this email or contact ${esc(d.support)}.</p>`),
  }),
  // 2.
  resend: (d) => ({
    subject: "Your new download link",
    text: `Here is a new download link for your order (${d.ref}): ${d.link}\n\n${limits(d)}\nAny earlier link no longer works. If you did not request this, contact ${d.support}.`,
    html: wrap(`<h2>Your new download link</h2>${btn(d.link, "Download your PDF")}<p>${esc(limits(d))}</p><p>Order reference: <code>${esc(d.ref)}</code>. Any earlier link no longer works. If you did not request this, contact ${esc(d.support)}.</p>`),
  }),
  // 3. Sent when the provider reports a delayed payment (no download is included).
  pendingPayment: (d) => ({
    subject: "Your payment is still being confirmed",
    text: `We have not yet received confirmation of your payment for order ${d.ref}. Some payment methods take time. Your download link will be emailed only after the payment is confirmed. Check status: ${d.orderUrl}\nQuestions: ${d.support}.`,
    html: wrap(`<p>We have not yet received confirmation of your payment for order <code>${esc(d.ref)}</code>. Some payment methods take time.</p><p>Your download link will be emailed <strong>only after</strong> the payment is confirmed.</p><p><a href="${esc(d.orderUrl)}">Check order status</a><br>Questions: ${esc(d.support)}.</p>`),
  }),
  // 4.
  paymentFailed: (d) => ({
    subject: "Your payment did not go through",
    text: `Your payment for order ${d.ref} was not completed, so no purchase was made and no download was issued. You can try again at ${d.siteUrl}. If you think you were charged, contact ${d.support} with your order reference.`,
    html: wrap(`<p>Your payment for order <code>${esc(d.ref)}</code> was not completed, so no purchase was made and no download was issued.</p><p>You can <a href="${esc(d.siteUrl)}">try again</a>. If you think you were charged, contact ${esc(d.support)} with your order reference.</p>`),
  }),
  // 6. Sent when the provider reports a full refund.
  refundConfirmation: (d) => ({
    subject: "Your refund has been processed",
    text: `The payment for order ${d.ref} has been refunded, and the download link for this order no longer works. Refund timing depends on your payment provider and bank. Questions: ${d.support}.`,
    html: wrap(`<p>The payment for order <code>${esc(d.ref)}</code> has been refunded, and the download link for this order no longer works.</p><p>Refund timing depends on your payment provider and bank. Questions: ${esc(d.support)}.</p>`),
  }),
};
// 5 (support acknowledgement) is intentionally not implemented: support runs through the support mailbox, not a web form.
