// ytdlp bridge: runs ON youtube.com (loaded by the bookmark from your GitHub Pages).
// Floats the ytdlp card (an iframe of card.html) over the page and performs fetches
// for it as youtube.com. Self-contained ES5 on purpose; no innerHTML (YouTube enforces
// Trusted Types).
(function (APP_URL, VER) {
  var W = window, D = document;
  var APP = new URL(APP_URL).origin;
  if (W.__ytdlpWeb && W.__ytdlpWeb.app === APP_URL) { W.__ytdlpWeb.open(); return; }
  var ALLOW = /^https:\/\/(?:[a-z0-9-]+\.)*(?:youtube\.com|googlevideo\.com|ytimg\.com|ggpht\.com|youtube-nocookie\.com|googleusercontent\.com|googleapis\.com)(?::\d+)?\//i;
  var st = { frame: null, timer: null, h: 360, pos: null };

  function send(target, msg, transfer) {
    try { target.postMessage(msg, APP, transfer || []); } catch (e) { /* closed */ }
  }
  function cfg(k) {
    try { return W.ytcfg && W.ytcfg.get ? W.ytcfg.get(k) : null; } catch (e) { return null; }
  }

  W.addEventListener("message", function (ev) {
    if (ev.origin !== APP || !st.frame || ev.source !== st.frame.contentWindow) return;
    var d = ev.data;
    if (!d || d.__ytdlp !== VER) return;
    var src = ev.source;
    if (d.t === "close-overlay") { hide(); return; }
    if (d.t === "size") { st.h = Math.max(120, d.h | 0); place(); return; }
    if (d.t === "move") {
      var r = st.frame.getBoundingClientRect();
      st.pos = {
        x: Math.max(0, Math.min(W.innerWidth - r.width, r.left + (+d.dx || 0))),
        y: Math.max(0, Math.min(W.innerHeight - 60, r.top + (+d.dy || 0)))
      };
      place();
      return;
    }
    if (d.t !== "fetch") return;
    var out = { __ytdlp: VER, t: "res", id: d.id };
    var url;
    try { url = new URL(d.url, location.href).href; } catch (e) { out.error = "Bad URL"; send(src, out); return; }
    if (!ALLOW.test(url)) { out.error = "Bridge refuses host " + new URL(url).host; send(src, out); return; }
    var init = { method: d.method || "GET", headers: d.headers || {}, credentials: "omit", redirect: "follow", cache: "no-store" };
    if (d.body) init.body = d.body;
    fetch(url, init).then(function (r) {
      return r.arrayBuffer().then(function (buf) {
        var h = [];
        r.headers.forEach(function (v, k) { h.push([k, v]); });
        out.status = r.status; out.statusText = r.statusText; out.url = r.url; out.headers = h; out.buf = buf;
        send(src, out, [buf]);
      });
    }).catch(function (e) { out.error = String(e && e.message || e); send(src, out); });
  });

  function hello() {
    if (!st.frame || !st.frame.contentWindow) return;
    var pid = (String(cfg("PLAYER_JS_URL") || "").match(/player\/([0-9a-fA-F]{8})\//) || [])[1] || null;
    send(st.frame.contentWindow, { __ytdlp: VER, t: "hello", host: location.host, page: location.href, vd: cfg("VISITOR_DATA"), pid: pid });
  }

  function place() {
    var f = st.frame;
    if (!f) return;
    var small = Math.min(W.innerWidth, (W.screen && W.screen.width) || 9999) < 640;
    var maxH = W.innerHeight - (small ? 16 : 96);
    if (st.pos) {
      f.style.right = "auto"; f.style.bottom = "auto";
      f.style.left = st.pos.x + "px"; f.style.top = st.pos.y + "px";
      f.style.width = small ? "calc(100vw - 16px)" : "420px";
      maxH = W.innerHeight - st.pos.y - 8;
    } else if (small) {
      f.style.left = "8px"; f.style.right = "8px"; f.style.top = "auto"; f.style.bottom = "8px";
      f.style.width = "calc(100vw - 16px)";
    } else {
      f.style.left = "auto"; f.style.right = "24px"; f.style.top = "72px"; f.style.bottom = "auto";
      f.style.width = "420px";
    }
    f.style.height = Math.min(st.h, maxH) + "px";
  }

  function open() {
    if (!st.frame) {
      var f = D.createElement("iframe");
      f.src = APP_URL + "#bridge";
      f.allow = "clipboard-write";
      f.title = "ytdlp";
      f.style.cssText = "position:fixed;z-index:2147483647;border:0;border-radius:26px;background:transparent;color-scheme:dark;" +
        "backdrop-filter:blur(26px) saturate(160%);-webkit-backdrop-filter:blur(26px) saturate(160%);" +
        "box-shadow:0 0 0 1px rgba(0,255,136,.28),0 0 48px -6px rgba(0,255,136,.35),0 40px 90px rgba(0,0,0,.75);" +
        "opacity:0;transform:translateY(14px) scale(.98);transition:opacity .35s ease,transform .35s cubic-bezier(.2,.9,.2,1.1),height .3s cubic-bezier(.2,.8,.2,1)";
      D.documentElement.appendChild(f);
      st.frame = f;
      W.addEventListener("resize", place);
      W.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
    }
    st.frame.style.display = "block";
    place();
    requestAnimationFrame(function () { st.frame.style.opacity = "1"; st.frame.style.transform = "none"; });
    if (!st.timer) st.timer = setInterval(hello, 700);
    hello();
  }

  function hide() {
    if (!st.frame) return;
    st.frame.style.opacity = "0";
    st.frame.style.transform = "translateY(14px) scale(.98)";
    setTimeout(function () { if (st.frame && st.frame.style.opacity === "0") st.frame.style.display = "none"; }, 350);
  }

  W.__ytdlpWeb = { app: APP_URL, open: open };
  open();
})(
  window.__ytdlpAppUrl || new URL("../card.html", (document.currentScript && document.currentScript.src) || location.href).href,
  1
);
