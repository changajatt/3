/* Policy pages stay unpublished (a holding notice is shown) until the owner supplies the required details
   in site-config.js AND sets policiesApproved to true. Nothing is invented. */
(function () {
  "use strict";
  var C = window.ZYVTRON_CONFIG || {}, B = C.business || {}, page = document.body.getAttribute("data-page");
  var support = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(C.supportEmail || "")) ? C.supportEmail : "";
  var v = { name: B.name, support: support, jurisdiction: B.jurisdiction, updated: C.policiesUpdated, payment: C.paymentProviderName || "our payment provider", email: C.emailProviderName || "our email service provider" };
  var terms = Array.isArray(C.refundTerms) ? C.refundTerms.filter(function (t) { return typeof t === "string" && t.trim(); }) : [];
  var ready = C.policiesApproved === true && v.name && v.support && v.jurisdiction && v.updated && (page !== "refunds" || terms.length);
  var holding = document.getElementById("holding"), body = document.getElementById("policy");
  if (!ready) { holding.hidden = false; body.hidden = true; return; }
  holding.hidden = true; body.hidden = false;
  Array.prototype.forEach.call(document.querySelectorAll("[data-cfg]"), function (el) {
    var k = el.getAttribute("data-cfg");
    if (k === "support") { var a = document.createElement("a"); a.href = "mailto:" + v.support; a.textContent = v.support; el.appendChild(a); }
    else el.textContent = v[k] || "";
  });
  var ul = document.getElementById("refundTerms");
  if (ul) terms.forEach(function (t) { var li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
  var addr = document.getElementById("addr");
  if (addr && B.address) { addr.textContent = " · Address: " + B.address; addr.hidden = false; }
})();
