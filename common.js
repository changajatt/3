/* Shared helpers for the order, download, recover and contact pages. Public values only (from site-config.js). */
(function () {
  "use strict";
  var C = window.ZYVTRON_CONFIG || {};
  var DEV = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var ZY = window.ZY = {};
  ZY.$ = function (id) { return document.getElementById(id); };
  ZY.api = function () {
    try { var u = new URL(String(C.apiBase || "").trim());
      if (u.protocol === "https:" || (DEV && u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return u.href.replace(/\/+$/, "");
    } catch (e) {}
    return "";
  };
  ZY.support = function () { var s = String(C.supportEmail || "").trim(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ""; };
  ZY.isEmail = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); };
  ZY.supportLine = function (el) {
    if (!el) return; var s = ZY.support(); el.textContent = "";
    if (!s) { el.textContent = "A support contact has not been published yet."; return; }
    var a = document.createElement("a"); a.href = "mailto:" + s; a.textContent = s;
    el.appendChild(document.createTextNode("Need help? Email ")); el.appendChild(a); el.appendChild(document.createTextNode(" and include your order reference if you have one."));
  };
  // Resend form. The server answers identically whether or not an order exists, so neither do we.
  ZY.bindResend = function (form) {
    if (!form) return; var api = ZY.api(), $ = ZY.$;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var em = $("email").value.trim(), err = $("emailErr"), out = $("resendMsg"), btn = $("resendBtn");
      err.hidden = true; out.textContent = "";
      if (!api) { out.textContent = "Resending is not available on this site yet."; return; }
      if (!ZY.isEmail(em)) { err.textContent = "Please enter a valid email address."; err.hidden = false; $("email").setAttribute("aria-invalid", "true"); $("email").focus(); return; }
      $("email").removeAttribute("aria-invalid"); btn.disabled = true;
      fetch(api + "/api/resend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: em }) })
        .then(function (r) { return r.json().then(function (d) {
          out.textContent = r.ok ? d.message : r.status === 429 ? "Too many requests. Please wait a while and try again." : r.status === 503 ? "Resending is not available right now. Please contact support." : "Something went wrong. Please try again."; }); })
        .catch(function () { out.textContent = "We could not reach the server. Please try again."; })
        .then(function () { btn.disabled = false; });
    });
  };
})();
