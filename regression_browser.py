# Browser QA (needs: pip install playwright && playwright install chromium, Node 20+, python3). Run from anywhere:
#   ZY_ROOT=/path/to/project python3 qa/regression_browser.py
# Uses temporary copies in /tmp and local ports 8081-8091. Never contacts a real payment provider.
import os
import shutil, os, re, json, glob
from playwright.sync_api import sync_playwright
SRC=os.environ.get("ZY_ROOT","/mnt/user-data/outputs"); R=[]
def ok(n,c,x=""): R.append((n,bool(c))); print(("PASS " if c else "FAIL ")+n,x)
BASE=dict(siteUrl="https://changajatt.github.io/2",apiBase="",checkoutUrl="",priceLabel="$27 USD",supportEmail="",policiesApproved=False,business={},refundTerms=[])
APPR=dict(supportEmail="h@mail.test",policiesApproved=True,policiesUpdated="1 March 2027",business=dict(name="T Ltd",jurisdiction="Testland"),refundTerms=["x"])
def variant(name,cfg=None,html=None,page="index.html"):
    d=f"/tmp/w_{name}"; shutil.rmtree(d,ignore_errors=True); shutil.copytree(SRC,d,ignore=shutil.ignore_patterns("api"))
    if cfg is not None: open(d+"/site-config.js","w").write("window.ZYVTRON_CONFIG="+json.dumps(dict(BASE,**cfg))+";")
    if html:
        h=open(d+"/index.html").read()
        for a,b in html: assert a in h,a; h=h.replace(a,b)
        open(d+"/index.html","w").write(h)
    return "file://"+d+"/"+page
default="file://"+SRC+"/index.html"
with sync_playwright() as p:
    b=p.chromium.launch()
    # layout on every page
    appr=variant("appr",APPR,page="terms.html")
    pages=[("index",default),("order","file://"+SRC+"/order.html?ref="+"a"*22),("download","file://"+SRC+"/download.html#t="+"a"*30),("recover","file://"+SRC+"/recover.html"),("contact-holding","file://"+SRC+"/contact.html"),("contact-approved",variant("capp",APPR,page="contact.html")),("privacy-holding","file://"+SRC+"/privacy.html"),("terms-approved",appr)]
    for w in (320,375,768,1024,1440):
        for name,u in pages:
            pg=b.new_page(viewport={"width":w,"height":800}); errs=[]
            pg.on("pageerror",lambda e:errs.append(str(e))); pg.on("console",lambda m:errs.append(m.text) if m.type=="error" else None)
            pg.goto(u); pg.wait_for_timeout(120)
            ov=pg.evaluate("Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth")
            wide=pg.evaluate("[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left<-1)&&!e.closest('.table-wrap')&&!e.classList.contains('skip')}).slice(0,3).map(e=>e.tagName+'.'+e.className)")
            small=pg.evaluate("[...document.querySelectorAll('a,button,summary,input')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height<44&&!e.closest('.skip')&&!e.closest('p,li:not(.nav *),.meta')}).map(e=>(e.textContent||e.id).trim().slice(0,16)+':'+Math.round(e.getBoundingClientRect().height))")
            real=[e for e in errs if "Failed to load resource" not in e and "ERR_" not in e and "net::" not in e]
            ok(f"{name} @{w}: no overflow/errors/small targets",ov<=0 and not wide and not small and not real,f"ov={ov} wide={wide} small={small} errs={real}")
            pg.close()
    # menu keyboard flow (index, mobile)
    pg=b.new_page(viewport={"width":375,"height":800}); pg.goto(default)
    pg.focus("#menuBtn"); pg.keyboard.press("Enter"); ok("menu opens with Enter",pg.get_attribute("#menuBtn","aria-expanded")=="true")
    pg.keyboard.press("Tab"); ok("Tab enters nav",pg.evaluate("document.activeElement.textContent.trim()")=="The system")
    pg.keyboard.press("Shift+Tab"); pg.keyboard.press("Escape"); ok("Escape closes, focus on button",pg.get_attribute("#menuBtn","aria-expanded")=="false" and pg.evaluate("document.activeElement.id")=="menuBtn")
    pg.keyboard.press("Enter")
    for _ in range(7): pg.keyboard.press("Tab")
    ok("tabbing out closes menu",pg.get_attribute("#menuBtn","aria-expanded")=="false")
    pg.click("#menuBtn"); pg.click("#nav a[href='#faq']"); pg.wait_for_timeout(500); ok("link closes menu, focus on section",pg.evaluate("document.activeElement.id")=="faq")
    pg.click("#menuBtn"); pg.set_viewport_size({"width":1200,"height":800}); pg.wait_for_timeout(100); ok("resize resets menu",pg.get_attribute("#menuBtn","aria-expanded")=="false" and pg.is_visible("#nav"))
    pg.close()
    # nothing configured
    pg=b.new_page(viewport={"width":375,"height":800}); pg.goto(default); good=0; n=pg.locator("[data-buy]").count()
    for i in range(n):
        pg.goto(default)
        if i==0: pg.click("#menuBtn")
        pg.locator("[data-buy]").nth(i).click(); pg.wait_for_timeout(250)
        good+= pg.evaluate("document.activeElement.id")=="buyStatus" and pg.is_visible("#buyStatus")
    ok(f"unconfigured: all {n} CTAs show focused notice",good==n)
    pg.goto(default); t=pg.inner_text("#buyStatus"); ok("unconfigured wording accurate (gated, no success claim)",t.startswith("Purchasing is not open yet") and "support contact" in t and "success" not in t.lower())
    ok("unconfigured: FAQ delivery/support honest",pg.text_content("#faqDelivery").startswith("Delivery details have not been published") and "has not been published" in pg.text_content("#faqSupport") and "Not yet published: contact details, privacy policy, terms of service, refund policy, delivery policy." in pg.inner_text("#legalLinks"))
    ok("unconfigured: spec table doesn't promise delivery method","not been published" in pg.inner_text("#specDelivery"))
    pg.close()
    # hosted-link mode + validation
    u=variant("link",dict(APPR,checkoutUrl="https://pay.testshop.io/b/abc",deliveryNote="TEST DELIVERY",refundNote="TEST REFUND")); pg=b.new_page(); pg.goto(u)
    hr=pg.eval_on_selector_all("[data-buy]","e=>e.map(x=>[x.href,x.rel])"); ok("link mode: all CTAs -> checkout, noopener noreferrer",len(hr)==4 and all(h==["https://pay.testshop.io/b/abc","noopener noreferrer"] for h in hr))
    ok("link mode: notice hidden, notes from config",not pg.is_visible("#buyStatus") and pg.inner_text("#noteDelivery")=="Delivery: TEST DELIVERY" and pg.inner_text("#noteRefund")=="Refunds: TEST REFUND" and pg.inner_text("#specDelivery")=="TEST DELIVERY"); pg.close()
    for bad in ["http://pay.testshop.io/x","javascript:alert(1)","https://example.com/pay","https://u:p@pay.testshop.io/x","https://localhost/x","pay.testshop.io","https://nodot/x"]:
        pg=b.new_page(); pg.goto(variant("bad",dict(APPR,checkoutUrl=bad))); ok(f"rejects checkoutUrl '{bad}'",pg.is_visible("#buyStatus") and pg.get_attribute("[data-buy]","href")=="#buy"); pg.close()
    pg=b.new_page(); pg.goto(variant("badapi",dict(APPR,apiBase="http://evil-api.test"))); ok("non-https apiBase rejected outside localhost",pg.is_visible("#buyStatus") and "not available yet" in pg.inner_text("#buyStatus")); pg.close()
    pg=b.new_page(); pg.goto(variant("apiunreach",dict(APPR,apiBase="https://api.testshop.io"))); pg.wait_for_timeout(1200); ok("https apiBase unreachable -> unavailable notice",pg.is_visible("#buyStatus") and "not available" in pg.inner_text("#buyStatus")); pg.close()
    pg=b.new_page(); errs=[]; pg.on("pageerror",lambda e:errs.append(str(e))); pg.goto(variant("nocfg",None,[('<script src="site-config.js"></script>','')])); ok("missing site-config.js: no crash, unavailable state",not errs and pg.is_visible("#buyStatus")); pg.close()
    pg=b.new_page(); errs=[]; pg.on("pageerror",lambda e:errs.append(str(e))); pg.goto(variant("noel",None,[('id="menuBtn"','id="x1"'),('id="buyStatus"','id="x2"'),('id="legalLinks"','id="x3"'),('id="price"','id="x4"'),('id="faqDelivery"','id="x5"')])); pg.click("[data-buy]"); ok("missing elements: no errors",not errs,str(errs)); pg.close()
    ctx=b.new_context(java_script_enabled=False,viewport={"width":375,"height":800}); pg=ctx.new_page(); pg.goto(default); ok("no-JS: nav visible, honest static text",pg.is_visible("#nav") and not pg.is_visible("#menuBtn") and "not been published" in pg.inner_text("#legalLinks") or "Not yet published" in pg.inner_text("#legalLinks")); ctx.close()
    ctx=b.new_context(java_script_enabled=False); pg=ctx.new_page(); pg.goto("file://"+SRC+"/privacy.html"); ok("no-JS policy page: shows needs-JS notice, no policy text",not pg.is_visible("#policy")); ctx.close()
    ctx=b.new_context(reduced_motion="reduce"); pg=ctx.new_page(); pg.goto(default); ok("reduced motion: smooth scroll off",pg.evaluate("getComputedStyle(document.documentElement).scrollBehavior")=="auto"); ctx.close()
    pg=b.new_page(viewport={"width":1024,"height":800}); pg.goto(default); pg.focus("#faq summary"); pg.keyboard.press("Enter"); ok("FAQ keyboard toggle",pg.evaluate("document.querySelector('#faq details').open"))
    pg.goto(default); pg.keyboard.press("Tab"); pg.keyboard.press("Enter"); ok("skip link focuses main",pg.evaluate("document.activeElement.id")=="main")
    o=b.new_page(); o.goto("file://"+SRC+"/order.html?ref=short"); ok("order page: no API configured message","not connected" in o.inner_text("#msg")); o.goto("file://"+SRC+"/download.html#t="+"a"*30); ok("download page: no API configured message","not connected" in o.inner_text("#msg"))
    import subprocess,time
    shutil.rmtree("/tmp/srv404",ignore_errors=True); shutil.copytree(SRC,"/tmp/srv404/2",ignore=shutil.ignore_patterns("api"))
    sv=subprocess.Popen(["python3","-m","http.server","8091","--bind","127.0.0.1"],cwd="/tmp/srv404",stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
    try:
        for w in (320,768,1440):
            pg=b.new_page(viewport={"width":w,"height":800}); errs=[]; pg.on("pageerror",lambda e:errs.append(str(e))); pg.goto("http://127.0.0.1:8091/2/404.html"); pg.wait_for_timeout(200)
            css=pg.evaluate("getComputedStyle(document.querySelector('.doc-hdr')).backgroundColor"); ov=pg.evaluate("document.documentElement.scrollWidth-innerWidth")
            ok(f"404 page @{w}: stylesheet loads via <base>, no overflow/errors",css!="rgba(0, 0, 0, 0)" and ov<=0 and not errs,css); pg.close()
    finally: sv.terminate()
    b.close()
# static checks across files
html={f:open(f).read() for f in glob.glob(SRC+"/*.html")}
for f,h in html.items():
    ids=re.findall(r'id="([^"]+)"',h); ok(f"{os.path.basename(f)}: unique ids, anchors resolve",len(ids)==len(set(ids)) and all(a in ids for a in re.findall(r'href="#([^"]+)"',h)))
    refs=re.findall(r'(?:href|src)="([^"#:?]+\.(?:css|js|html|png|webp))"',h); miss=[r for r in refs if not os.path.exists(SRC+"/"+r)]; ok(f"{os.path.basename(f)}: local references exist",not miss,str(miss))
    ok(f"{os.path.basename(f)}: one h1",h.count("<h1")==1)
ix=html[SRC+"/index.html"]
for k,v in [("canonical",'rel="canonical" href="https://changajatt.github.io/2/"'),("og:url",'og:url" content="https://changajatt.github.io/2/"'),("og:image",'og-image.png"'),("twitter large",'summary_large_image'),("description",'name="description"')]: ok("index meta: "+k, v in ix)
ok("no fake structured data/ratings in any page", not any(("application/ld+json" in h or "aggregateRating" in h or "ratingValue" in h) for h in html.values()))
ok("all non-sales pages are noindex", all('noindex' in html[SRC+"/"+f] for f in ("order.html","download.html","recover.html","contact.html","404.html","privacy.html","terms.html","refunds.html","delivery.html")))
ok("sitemap lists only the sales page; robots present", open(SRC+"/sitemap.xml").read().count("<loc>")==1 and os.path.exists(SRC+"/robots.txt"))
ok("index has real cover image with dimensions + alt", 'src="assets/cover.webp" width="600" height="848"' in html[SRC+"/index.html"] and os.path.exists(SRC+"/assets/cover.webp"))
sec=re.compile(r"(sk_(live|test)_|whsec_|re_[A-Za-z0-9]{10,}|-----BEGIN|AKIA[0-9A-Z]{12}|api[_-]?key\s*[:=]\s*['\"][A-Za-z0-9]{12,})")
pub=[f for f in glob.glob(SRC+"/*") if os.path.isfile(f) and not f.endswith(".png")]; leaks=[f for f in pub if sec.search(open(f,errors="ignore").read())]; ok("no secret-looking strings in public site files",not leaks,str(leaks))
allf=[f for f in glob.glob(SRC+"/**",recursive=True) if os.path.isfile(f) and not f.endswith(".png") and "/test/" not in f and "/qa/" not in f]; leaks=[f for f in allf if re.search(r"(sk_live_|sk_test_[A-Za-z0-9]{8,}|-----BEGIN)",open(f,errors="ignore").read())]; ok("no real-looking keys anywhere in deliverables",not leaks,str(leaks))
ok("no PDF or customer data in project",not glob.glob(SRC+"/**/*.pdf",recursive=True) and not glob.glob(SRC+"/**/orders*",recursive=True))
print(f"\n{sum(c for _,c in R)}/{len(R)} passed"); print("FAILED:",[n for n,c in R if not c])
