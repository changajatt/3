/* Secure download page. The token lives in the URL FRAGMENT (#t=...), which browsers never send to servers or in Referer headers. */
(function () {
  "use strict";
  var ZY = window.ZY, $ = ZY.$, api = ZY.api(), m = /^#t=([A-Za-z0-9_-]{20,100})$/.exec(location.hash), token = m ? m[1] : "";
  var title = $("title"), msg = $("msg"), btn = $("dlBtn"), recover = $("recoverBox");
  function show(t, p, showRecover) { title.textContent = t; msg.textContent = p; btn.hidden = true; recover.hidden = !showRecover; }
  ZY.supportLine($("supportLine"));
  if (!api) { show("Downloads unavailable", "Downloads are not connected on this site.", false); return; }
  if (!token) { show("Download link not recognised", "Please open the link from your purchase email. If you can't find it, request a new one.", true); return; }
  var ERR = { 404: ["Download link not valid", "This link is not valid. It may have been replaced by a newer link, or the order may have been refunded. If you need help, request a new link or contact support.", true], 410: ["Download link no longer available", "This link has expired or its download limit has been reached. You can request a new one.", true],
              403: ["Download not available", "Downloads are not available for this order (for example it was refunded or is under review). Please contact support.", false], 429: ["Please wait", "Too many requests. Try again in a little while.", false] };
  function post(path) { return fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token }) }); }
  function info() {
    return post("/api/download-info").then(function (r) {
      if (!r.ok) { var e = ERR[r.status] || ["Something went wrong", "Please try again, or contact support.", false]; show(e[0], e[1], e[2]); return false; }
      return r.json().then(function (d) {
        title.textContent = "Your ebook is ready";
        msg.textContent = "AI Marketing Freelancer System (PDF). This link expires on " + new Date(d.expiresAt).toLocaleString() + " and allows " + d.remaining + " more download" + (d.remaining === 1 ? "" : "s") + ".";
        btn.hidden = false; recover.hidden = true; return true;
      });
    }).catch(function () { show("We could not check your link", "Please check your connection and refresh.", false); });
  }
  btn.addEventListener("click", function () {
    btn.disabled = true; btn.textContent = "Preparing download…";
    post("/api/download").then(function (r) {
      if (!r.ok) { var e = ERR[r.status] || (r.status === 503 ? ["File temporarily unavailable", "The file could not be loaded and this attempt was not counted. Please try again shortly or contact support.", false] : ["Something went wrong", "Please try again, or contact support.", false]); show(e[0], e[1], e[2]); return null; }
      return r.blob().then(function (b) {
        var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "AI-Marketing-Freelancer-System.pdf"; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return info();
      });
    }).catch(function () { show("Download interrupted", "Your connection dropped. Please try again.", false); })
      .then(function () { btn.disabled = false; btn.textContent = "Download PDF"; });
  });
  window.addEventListener("hashchange", function () { location.reload(); }); // a newer link opened in the same tab
  info();
})();
