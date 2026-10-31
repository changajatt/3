/* Zyvtron storefront script. All settings come from site-config.js (public values only).
   Purchase modes: A) API (apiBase): server creates the checkout and verifies payment/delivery.
                   B) Hosted link (checkoutUrl): provider handles checkout and delivery.
                   Neither configured: honest "purchasing unavailable" state. */
(function () {
  "use strict";
  var doc = document;
  var C = window.ZYVTRON_CONFIG || {};
  var $ = function (id) { return doc.getElementById(id); };
  var txt = function (v) { return typeof v === "string" ? v.trim() : ""; };
  var closest = function (el, sel) { while (el && el.nodeType === 1) { if (el.matches && el.matches(sel)) return el; el = el.parentNode; } return null; };

  // ---------- Validation (syntax only: a valid URL does NOT prove it works) ----------
  var PLACEHOLDER_HOST = /(^|\.)(example(\.(com|net|org))?|invalid|test|localhost)$/i;
  var DEV = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  function cleanUrl(v, allowMailto, allowDev) {
    v = txt(v); if (!v) return "";
    if (allowMailto && /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(v)) return v;
    try {
      var u = new URL(v);
      if (allowDev && DEV && u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return u.href.replace(/\/$/, "");
      if (u.protocol !== "https:" || u.username || u.password) return "";
      if (u.hostname.indexOf(".") < 1 || PLACEHOLDER_HOST.test(u.hostname)) return "";
      return u.href;
    } catch (e) { return ""; }
  }
  var api = cleanUrl(C.apiBase, false, true).replace(/\/+$/, "");
  var link = api ? "" : cleanUrl(C.checkoutUrl, false, false);
  var support = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(txt(C.supportEmail)) ? txt(C.supportEmail) : "";
  var delivery = txt(C.deliveryNote), refund = txt(C.refundNote);
  var apiReady = false; // set true only when the API itself reports checkout + delivery are fully configured
  // Selling is gated on the owner having published a support contact, approved policies and supplied refund terms.
  var gateMsg = !support ? "a support contact" : C.policiesApproved !== true ? "approved store policies" : !(C.refundTerms || []).length ? "refund terms" : "";
  var gated = gateMsg !== "";

  var status = $("buyStatus");
  function notice(msg) { if (!status) return; status.textContent = msg; status.hidden = false; }
  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }

  // ---------- Price, year ----------
  if ($("price") && txt(C.priceLabel)) $("price").textContent = txt(C.priceLabel);
  if ($("year")) $("year").textContent = new Date().getFullYear();
  Array.prototype.forEach.call(doc.querySelectorAll("main section[id]"), function (s) { if (!s.hasAttribute("tabindex")) s.setAttribute("tabindex", "-1"); });

  // ---------- Purchase buttons ----------
  var buttons = Array.prototype.slice.call(doc.querySelectorAll("[data-buy]"));
  var busy = false;
  function setBusy(on) {
    busy = on;
    buttons.forEach(function (b) {
      if (!b.dataset.label) b.dataset.label = b.textContent;
      b.textContent = on ? "Opening secure checkout…" : b.dataset.label;
      if (on) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
    });
  }
  var idemKey = (function () { var a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; }); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); })();

  function startCheckout() {
    if (busy) return; // duplicate-click protection (server also de-duplicates via the idempotency key)
    setBusy(true);
    if (status) status.hidden = true;
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    fetch(api + "/api/checkout", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": idemKey },
      body: JSON.stringify({ productId: "ams-ebook" }), signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      if (r.status === 503) throw new Error("unavailable");
      if (!r.ok) throw new Error("failed");
      return r.json();
    }).then(function (d) {
      if (d && typeof d.url === "string" && /^https:\/\//i.test(d.url)) { location.assign(d.url); return; } // stay "busy" while the browser navigates
      throw new Error("failed");
    }).catch(function (e) {
      clearTimeout(timer); setBusy(false);
      notice(e.message === "unavailable"
        ? "Purchasing is not available right now. Please try again later" + (support ? " or contact " + support + "." : ".")
        : "We could not start checkout. Nothing has been charged. Please try again" + (support ? ", or contact " + support + " if it keeps happening." : "."));
      if (status) status.focus({ preventScroll: false });
    });
  }
  window.addEventListener("pageshow", function (e) { if (e.persisted) setBusy(false); }); // back button from the payment page

  function unavailable(msg) {
    if (gated) { notice("Purchasing is not open yet. It opens once the store has published " + gateMsg + "."); return; }
    notice(msg || "Purchasing is not available yet. Checkout has not been connected, so this ebook cannot be bought from this page right now.");
  }

  buttons.forEach(function (el) {
    if (link && !gated) { el.setAttribute("href", link); el.setAttribute("rel", "noopener noreferrer"); return; }
    el.addEventListener("click", function (e) {
      if (api && !gated) { e.preventDefault(); startCheckout(); return; }
      setTimeout(function () { if (status) status.focus({ preventScroll: true }); }, 0); // native #buy navigation + focus the notice
    });
  });
  if ((!api && !link) || gated) unavailable();

  // Mode A: the SERVER is the source of truth for price and for whether selling is possible.
  function applyProduct(p) {
    apiReady = !!(p && p.checkoutAvailable);
    if (p && p.priceLabel) setText("price", p.priceLabel);
    if (gated) { unavailable(); return; }
    if (!apiReady) { unavailable("Purchasing is not available yet. Checkout has not been fully connected, so this ebook cannot be bought from this page right now."); return; }
    if (status) status.hidden = true;
    var d = "After payment is confirmed, a secure, time-limited download link is emailed to the address you used at checkout.";
    setText("specDelivery", "Digital download (PDF), emailed as a secure, time-limited link after verified payment");
    if ($("noteDelivery")) { $("noteDelivery").textContent = "Delivery: " + d; $("noteDelivery").hidden = false; }
    composeFaq(d);
  }
  if (api) {
    if (!gated) unavailable("Checking whether purchasing is available…");
    var t = window.AbortController ? new AbortController() : null; var tm = setTimeout(function () { if (t) t.abort(); }, 8000);
    fetch(api + "/api/product", { signal: t ? t.signal : undefined }).then(function (r) { clearTimeout(tm); if (!r.ok) throw 0; return r.json(); })
      .then(applyProduct).catch(function () { applyProduct(null); });
  }

  // ---------- Delivery / refund / support wording: only what is real ----------
  function composeFaq(autoDelivery) {
    var f = $("faqDelivery"); if (!f) return;
    var d = autoDelivery || (delivery ? "Delivery: " + delivery : "");
    f.textContent = (d || "Delivery details have not been published on this page yet.") + " " +
      (refund ? "Refunds: " + refund : "Refund terms are not summarised here" + (C.policiesApproved && (C.refundTerms || []).length ? "; see the Refund Policy." : " and have not been published yet."));
  }
  if (link && !gated) {
    if (delivery) { setText("specDelivery", delivery); if ($("noteDelivery")) { $("noteDelivery").textContent = "Delivery: " + delivery; $("noteDelivery").hidden = false; } }
    if (status) status.hidden = true;
  }
  composeFaq(null);
  if (refund && (api || link) && $("noteRefund")) { $("noteRefund").textContent = "Refunds: " + refund; $("noteRefund").hidden = false; }
  if (support) {
    setText("faqSupport", "Email " + support + " and include your order reference if you have one.");
    var sn = $("noteSupport"); if (sn) { sn.textContent = ""; sn.appendChild(doc.createTextNode("Support: ")); var a = doc.createElement("a"); a.href = "mailto:" + support; a.textContent = support; sn.appendChild(a); sn.hidden = false; }
  }

  // ---------- Footer ----------
  var linksEl = $("legalLinks");
  if (linksEl) {
    linksEl.textContent = "";
    var items = [], missing = [];
    if (support) items.push(["Contact", "contact.html"]); else missing.push("contact details");
    var ok = C.policiesApproved === true;
    [["Privacy", "privacy.html", "privacy policy"], ["Terms", "terms.html", "terms of service"], ["Refunds", "refunds.html", "refund policy"], ["Delivery", "delivery.html", "delivery policy"]].forEach(function (p) {
      if (ok && (p[1] !== "refunds.html" || (C.refundTerms || []).length)) items.push([p[0], p[1]]); else missing.push(p[2]);
    });
    if (api) items.push(["Resend download", "recover.html"]);
    items.forEach(function (it, i) { if (i) linksEl.appendChild(doc.createTextNode(" · ")); var a = doc.createElement("a"); a.href = it[1]; a.textContent = it[0]; linksEl.appendChild(a); });
    if (missing.length) linksEl.appendChild(doc.createTextNode((items.length ? " " : "") + "Not yet published: " + missing.join(", ") + "."));
  }

  // ---------- Mobile menu (optional enhancement) ----------
  var btn = $("menuBtn"), nav = $("nav"), hdr = doc.querySelector(".hdr");
  if (btn && nav && hdr) {
    doc.documentElement.classList.add("js-menu");
    var isOpen = function () { return btn.getAttribute("aria-expanded") === "true"; };
    var setMenu = function (open) { nav.classList.toggle("open", open); btn.setAttribute("aria-expanded", open ? "true" : "false"); btn.setAttribute("aria-label", open ? "Close menu" : "Open menu"); };
    setMenu(false);
    btn.addEventListener("click", function () { setMenu(!isOpen()); });
    nav.addEventListener("click", function (e) {
      var a = closest(e.target, "a"); if (!a || !isOpen()) return; setMenu(false);
      var h = a.getAttribute("href") || ""; var t = h.charAt(0) === "#" && h.length > 1 ? $(h.slice(1)) : null;
      if (t) { if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); }
    });
    doc.addEventListener("click", function (e) { if (isOpen() && !hdr.contains(e.target)) setMenu(false); });
    hdr.addEventListener("focusout", function (e) { if (isOpen() && e.relatedTarget && !hdr.contains(e.relatedTarget)) setMenu(false); });
    doc.addEventListener("keydown", function (e) { if ((e.key === "Escape" || e.key === "Esc") && isOpen()) { setMenu(false); if (hdr.contains(doc.activeElement)) btn.focus(); } });
    if (window.matchMedia) { var mq = window.matchMedia("(min-width:1024px)"), oc = function () { setMenu(false); }; if (mq.addEventListener) mq.addEventListener("change", oc); else if (mq.addListener) mq.addListener(oc); }
  }

  // ---------- Owner-only console checklist ----------
  if (window.console && console.info) {
    var todo = [];
    if (!api && !link) todo.push("Purchasing: neither apiBase nor checkoutUrl is set/valid.");
    if (link) todo.push("checkoutUrl looks well-formed; that does NOT prove checkout works or that the file is delivered. Do a real test purchase.");
    if (api) todo.push("apiBase set; the page shows 'available' only if the API reports every required setting is present. Still run a real test purchase.");
    if (gated) todo.push("Purchasing is GATED: missing " + gateMsg + " (support email, policiesApproved:true, refundTerms).");
    console.info("[Zyvtron] Launch checklist:\n- " + todo.join("\n- "));
  }
})();
