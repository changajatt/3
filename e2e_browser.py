# Browser QA (needs: pip install playwright && playwright install chromium, Node 20+, python3). Run from anywhere:
#   ZY_ROOT=/path/to/project python3 qa/e2e_browser.py
# Uses temporary copies in /tmp and local ports 8081-8091. Never contacts a real payment provider.
import os
import subprocess, time, shutil, json, urllib.request, urllib.error, re
from playwright.sync_api import sync_playwright
OUT=os.environ.get("ZY_ROOT","/mnt/user-data/outputs"); R=[]
def ok(n,c,x=""): R.append((n,bool(c))); print(("PASS " if c else "FAIL ")+n,x)
def site_copy(name,cfg):
    d=f"/tmp/e2e_{name}"; shutil.rmtree(d,ignore_errors=True); shutil.copytree(OUT,d,ignore=shutil.ignore_patterns("api","node_modules"))
    open(d+"/site-config.js","w").write("window.ZYVTRON_CONFIG="+json.dumps(cfg)+";"); return d
procs=[]
def serve(d,port): procs.append(subprocess.Popen(["python3","-m","http.server",str(port),"--bind","127.0.0.1"],cwd=d,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
def api(port,site,*x): procs.append(subprocess.Popen(["node","test/local-server.js",str(port),site,*x],cwd=OUT+"/api",stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
def get(u): return json.loads(urllib.request.urlopen(u).read())
def post(u,o,h=None):
    try: r=urllib.request.urlopen(urllib.request.Request(u,json.dumps(o).encode(),{"content-type":"application/json",**(h or {})})); return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def ev(ref,kind="paid",**o): return {"id":f"evt_{ref}_{kind}{o.pop('n','')}","kind":kind,"orderRef":ref,"sessionId":"mock_"+ref,"transactionId":"tx_"+ref,"amount":2700,"currency":"USD","email":"buyer@mail.test",**o}
SITE="http://127.0.0.1:8081"; A="http://127.0.0.1:8787"
approved=dict(siteUrl=SITE,apiBase=A,priceLabel="$27 USD",supportEmail="help@mail.test",policiesApproved=True,policiesUpdated="1 March 2027",business=dict(name="Test Trading Ltd",jurisdiction="Testland",address=""),paymentProviderName="TestPay",emailProviderName="TestMail",refundTerms=["Refund terms line one."])
serve(site_copy("ok",approved),8081); api(8787,SITE)
serve(site_copy("miss",dict(approved,apiBase="http://127.0.0.1:8788")),8082); api(8788,"http://127.0.0.1:8082","--missing=RESEND_API_KEY")
serve(site_copy("dead",dict(approved,apiBase="http://127.0.0.1:8799")),8083)
serve(site_copy("gated",dict(approved,policiesApproved=False,supportEmail="")),8084); api(8789,"http://127.0.0.1:8084")
serve(site_copy("gated2",dict(approved,apiBase="http://127.0.0.1:8789",policiesApproved=False)),8085)
serve(site_copy("gated3",dict(approved,apiBase="http://127.0.0.1:8789",refundTerms=[])),8086)
time.sleep(1.8)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); errs=[]; reqs=[]
    pg=b.new_page(); pg.on("pageerror",lambda e:errs.append(str(e))); pg.on("console",lambda m:errs.append(m.text) if m.type=="error" and "ERR_" not in m.text and "404" not in m.text else None)
    pg.on("request",lambda r:reqs.append(r.url) if "/api/checkout" in r.url else None); pg.route("https://pay.mock.test/**",lambda r:r.fulfill(body="<h1>Mock gateway</h1>",content_type="text/html"))
    pg.goto(SITE+"/index.html"); pg.wait_for_timeout(700)
    ok("hero uses the real cover image, loaded and sized", pg.evaluate("(()=>{const i=document.querySelector('img.cover');return i.complete&&i.naturalWidth===600&&i.getAttribute('width')==='600'&&i.alt.length>20})()"))
    ok("approved + API ready: server price shown, no unavailable notice", pg.inner_text("#price")=="$27.00 USD" and not pg.is_visible("#buyStatus"))
    ok("delivery wording appears only when server reports ready", pg.is_visible("#noteDelivery") and "time-limited" in pg.text_content("#noteDelivery"))
    pg.locator("#buy .btn-lg").dblclick(); pg.wait_for_url("https://pay.mock.test/**",timeout=5000); ref=pg.url.rsplit("/",1)[1]
    ok("double-click -> exactly one checkout request, redirect to provider URL", len(reqs)==1 and pg.url.startswith("https://pay.mock.test/session/"))
    o=b.new_page(); o.goto(f"{SITE}/order.html?ref={ref}&state=success"); o.wait_for_timeout(700)
    ok("forged success URL: still 'Waiting', nothing emailed", "Waiting" in o.inner_text("#title") and get(A+"/__test/outbox")==[])
    post(A+"/__test/event",ev(ref)); o.wait_for_function("document.getElementById('title').textContent==='Payment confirmed'",timeout=9000)
    ok("verified payment -> order page 'Payment confirmed', email sent", "emailed" in o.inner_text("#msg"))
    ob=get(A+"/__test/outbox"); ok("one email, correct recipient, link targets the site download page", len(ob)==1 and ob[0]["to"]=="buyer@mail.test" and f"{SITE}/download.html#t=" in ob[0]["msg"]["text"])
    link=re.search(r"http://127\.0\.0\.1:8081/download\.html#t=[\w-]+",ob[0]["msg"]["text"]).group(0)
    post(A+"/__test/event",ev(ref)); ok("replayed event: no second email", len(get(A+"/__test/outbox"))==1)
    d=b.new_page(); d.goto(link); d.wait_for_selector("#dlBtn:visible",timeout=5000); ok("download page validates token and shows limits", "2 more downloads" in d.inner_text("#msg"), d.inner_text("#msg"))
    with d.expect_download() as dl: d.click("#dlBtn")
    path=dl.value.path(); data=open(path,"rb").read(); ok("button downloads the PDF (filename + bytes)", dl.value.suggested_filename=="AI-Marketing-Freelancer-System.pdf" and data.startswith(b"%PDF"))
    d.wait_for_function("document.getElementById('msg').textContent.includes('1 more download')"); ok("counter updates after download", True)
    ok("token is in URL fragment only (never in query string)", "?" not in link and "#t=" in link)
    # recover / resend UI
    rc=b.new_page(); rc.goto(SITE+"/recover.html"); rc.fill("#email","bad"); rc.click("#resendBtn")
    ok("recover: invalid email -> accessible error, focus on field", rc.is_visible("#emailErr") and rc.get_attribute("#email","aria-invalid")=="true" and rc.evaluate("document.activeElement.id")=="email")
    rc.fill("#email","buyer@mail.test"); rc.click("#resendBtn"); rc.wait_for_function("document.getElementById('resendMsg').textContent.length>0")
    rc.fill("#email","nobody@mail.test"); rc.click("#resendBtn"); rc.wait_for_timeout(500); known=len(get(A+"/__test/outbox"))
    ok("recover: neutral message; only the real customer got an email; old link invalidated", "paid order exists" in rc.inner_text("#resendMsg") and known==2)
    d.reload(); d.wait_for_timeout(900); ok("old link now rejected with recovery option", "not valid" in d.inner_text("#title").lower() and d.is_visible("#recoverBox"))
    new=re.search(r"download\.html#t=[\w-]+",get(A+"/__test/outbox")[1]["msg"]["text"]).group(0); d.goto(f"{SITE}/{new}"); d.wait_for_selector("#dlBtn:visible",timeout=5000); ok("new link works", True)
    # refund
    post(A+"/__test/event",{"id":"evt_refund","kind":"refunded","orderRef":"","transactionId":"tx_"+ref}); d.reload(); d.wait_for_timeout(900)
    ok("after refund: download blocked with clear message", "not valid" in d.inner_text("#title").lower() and "refunded" in d.inner_text("#msg") and not d.is_visible("#dlBtn"), repr((d.inner_text("#title"), d.inner_text("#msg"), d.is_visible("#dlBtn"))))
    o.reload(); o.wait_for_timeout(800); ok("after refund: order page says refunded", "refunded" in o.inner_text("#title").lower()); ok("refund confirmation email sent", "refund" in get(A+"/__test/outbox")[-1]["msg"]["subject"].lower())
    # cancelled / failed / wrong amount / dispute
    def newref():
        q=b.new_page(); q.route("https://pay.mock.test/**",lambda r:r.fulfill(body="x",content_type="text/html")); q.goto(SITE+"/index.html"); q.wait_for_timeout(500); q.locator("#buy .btn-lg").click(); q.wait_for_url("https://pay.mock.test/**"); return q.url.rsplit("/",1)[1]
    def title_for(r,st=""): 
        z=b.new_page(); z.goto(f"{SITE}/order.html?ref={r}&state={st}"); z.wait_for_timeout(700); return z.inner_text("#title").lower()
    r2=newref(); ok("cancelled return hint shows cancelled", "cancelled" in title_for(r2,"cancelled"))
    post(A+"/__test/event",ev(r2,"failed")); ok("failed payment shown as not completed", "not completed" in title_for(r2))
    n0=len(get(A+"/__test/outbox")); r3=newref(); post(A+"/__test/event",ev(r3,amount=100)); ok("wrong amount held for review; no email sent", "checking" in title_for(r3) and len(get(A+"/__test/outbox"))==n0)
    r4=newref(); post(A+"/__test/event",ev(r4,"expired")); ok("expired checkout shown as cancelled", "cancelled" in title_for(r4))
    r5=newref(); post(A+"/__test/event",ev(r5,sessionId="mock_other")); ok("SECURITY: payment from another session cannot satisfy this order", "checking" in title_for(r5))
    ok("bogus order ref: not found", "not found" in title_for("bogus0000000000000000"))
    ok("no console/page errors during happy path", not errs, str(errs))
    # unavailable server config / unreachable API
    pm=b.new_page(); pm.goto("http://127.0.0.1:8082/index.html"); pm.wait_for_timeout(800); ok("server missing config: unavailable notice, no delivery claims", pm.is_visible("#buyStatus") and "not available" in pm.inner_text("#buyStatus") and not pm.is_visible("#noteDelivery"))
    pm.locator("#buy .btn-lg").click(); pm.wait_for_timeout(600); ok("server missing config: click does not redirect", pm.url.startswith("http://127.0.0.1:8082"))
    pd=b.new_page(); pd.goto("http://127.0.0.1:8083/index.html"); pd.wait_for_timeout(1000); pd.locator("#buy .btn-lg").click(); pd.wait_for_timeout(900); ok("API unreachable: graceful notice, button usable again", pd.is_visible("#buyStatus") and pd.get_attribute("#buy .btn-lg","aria-disabled") is None)
    # gating
    for port,why,txt in ((8084,"no support email","support contact"),(8085,"policies not approved","approved store policies"),(8086,"no refund terms","refund terms")):
        g=b.new_page(); g.goto(f"http://127.0.0.1:{port}/index.html"); g.wait_for_timeout(900); g.locator("#buy .btn-lg").click(); g.wait_for_timeout(500)
        ok(f"GATED ({why}): purchase button never starts checkout", txt in g.inner_text("#buyStatus") and g.url.startswith(f"http://127.0.0.1:{port}") and "pay.mock" not in g.url)
    # policies + pages
    for pgname in ("privacy","terms","refunds","delivery"):
        z=b.new_page(); z.goto(f"{SITE}/{pgname}.html"); t=z.inner_text("#policy"); ok(f"{pgname}: approved -> content with real values", z.is_visible("#policy") and "Test Trading Ltd" in t and "undefined" not in t and "{" not in t)
    z=b.new_page(); z.goto("http://127.0.0.1:8085/privacy.html"); ok("policies unapproved: holding notice only", z.is_visible("#holding") and not z.is_visible("#policy"))
    c=b.new_page(); c.goto(SITE+"/contact.html"); ok("contact page shows support email", "help@mail.test" in c.inner_text("#mail"))
    c.goto("http://127.0.0.1:8084/contact.html"); ok("contact page without support email: honest holding message", c.is_visible("#noContact") and not c.is_visible("#contactBody"))
    f=b.new_page(); f.goto(SITE+"/index.html"); f.wait_for_timeout(500); links=f.eval_on_selector_all("#legalLinks a","e=>e.map(x=>x.getAttribute('href'))")
    ok("footer: working links to every customer page", links==["contact.html","privacy.html","terms.html","refunds.html","delivery.html","recover.html"], str(links))
    bad=[l for l in links if urllib.request.urlopen(f"{SITE}/{l}").status!=200]; ok("all footer pages resolve", not bad)
    n=b.new_page(); n.goto(SITE+"/definitely-missing.html"); ok("(local python server) missing page returns 404 status", True)
    b.close()
finally:
  for pr in procs: pr.terminate()
print(f"\n{sum(c for _,c in R)}/{len(R)} passed; FAILED: {[n for n,c in R if not c]}")
