/* Order status page. The state shown comes ONLY from the API (set by verified payment events).
   The ?state= value in the URL is a cosmetic hint and can never mark anything as paid. */
(function () {
  "use strict";
  var ZY = window.ZY, $ = ZY.$, api = ZY.api(), q = new URLSearchParams(location.search), ref = q.get("ref") || "", hint = q.get("state") || "";
  var title = $("title"), msg = $("msg"), tries = 0, MAX = 30;
  function show(t, m) { title.textContent = t; msg.textContent = m; }
  ZY.supportLine($("supportLine")); ZY.bindResend($("resendForm"));
  if (!api) { show("Order status unavailable", "Order tracking is not connected on this site."); return; }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(ref)) { show("Order not found", "This link is missing a valid order reference."); return; }
  $("refLine").textContent = "Order reference: " + ref; $("refLine").hidden = false; $("resendBox").hidden = false;

  function render(s) {
    var st = s.status, dl = s.delivery;
    if (st === "paid") {
      if (dl === "sent") show("Payment confirmed", "We emailed your secure download link to the address you used at checkout. Check your spam folder if you cannot see it.");
      else if (dl === "email_failed" || dl === "no_email") show("Payment confirmed, but the email failed", "Your payment was received but we could not send the download email. Use the form below to request a new link, or contact support with your order reference.");
      else show("Payment confirmed", "Your download email is being prepared. Check your inbox shortly.");
      return true;
    }
    if (st === "failed") { show("Payment not completed", "Your payment did not go through, and no download was issued. You can return to the ebook page and try again."); return true; }
    if (st === "cancelled") { show("Checkout cancelled", "This checkout expired or was cancelled before payment completed, so no order was made. You can start again from the ebook page."); return true; }
    if (st === "refunded") { show("Order refunded", "This order has been refunded and its download link no longer works."); return true; }
    if (st === "disputed") { show("Order under dispute", "A payment dispute is open on this order, so downloads are paused. Please contact support."); return true; }
    if (st === "review") { show("We are checking your order", "Your order needs a manual check. Please contact support with your order reference."); return true; }
    if (hint === "cancelled" && tries === 0) { show("Checkout cancelled", "You left checkout before paying, so no order was completed. You can try again from the ebook page."); return true; }
    show("Waiting for payment confirmation", "We have not received confirmation of your payment yet. Some payment methods take longer. This page updates automatically, and we will email your download once payment is confirmed.");
    return false;
  }
  function poll() {
    fetch(api + "/api/order-status?ref=" + encodeURIComponent(ref)).then(function (r) {
      if (r.status === 404) { show("Order not found", "We could not find that order reference."); return true; }
      if (!r.ok) throw 0; return r.json().then(render);
    }).then(function (done) {
      if (done) return; tries++;
      if (tries < MAX) setTimeout(poll, 4000); else show("Still processing", "Your payment has not been confirmed yet. If you were charged, you will still receive your download email once it is confirmed. Contact support if nothing arrives.");
    }).catch(function () { show("We could not check your order", "Please refresh this page in a moment or contact support."); });
  }
  poll();
})();
