// ==UserScript==
// @name         ytdlp - Download button for YouTube
// @namespace    https://alexd-aero.github.io/ytdlp-web/
// @version      1.0.0
// @description  Adds a Download button to YouTube that opens ytdlp: real yt-dlp + FFmpeg running in your browser.
// @homepageURL  https://alexd-aero.github.io/ytdlp-web/
// @icon         https://alexd-aero.github.io/ytdlp-web/addon/extension/icon128.png
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        none
// @inject-into  page
// @run-at       document-idle
// @noframes
// @downloadURL  https://alexd-aero.github.io/ytdlp-web/addon/ytdlp.user.js
// @updateURL    https://alexd-aero.github.io/ytdlp-web/addon/ytdlp.user.js
// ==/UserScript==

// ytdlp add-on config: where the card lives, and wait for the Download button before opening.
window.__ytdlpAppUrl = "https://alexd-aero.github.io/ytdlp-web/card.html";
window.__ytdlpVia = "userscript";
window.__ytdlpNoAutoOpen = true;

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
  // How this bridge was loaded: "bookmark" (default), "extension" or "userscript".
  var VIA = W.__ytdlpVia || "bookmark";

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
    }).catch(function (e) {
      // A server rejection (e.g. 403) arrives without CORS headers, so the browser reports it as
      // "Failed to fetch". An opaque no-cors probe tells a rejection apart from a real network failure.
      var msg = String(e && e.message || e);
      fetch(url, { method: "GET", mode: "no-cors", credentials: "omit", cache: "no-store" }).then(function () {
        out.status = 403; out.statusText = "Refused by server (" + msg + ")"; out.url = url; out.headers = []; out.buf = new ArrayBuffer(0);
        send(src, out);
      }).catch(function () { out.error = "Network error: " + msg; send(src, out); });
    });
  });

  function hello() {
    if (!st.frame || !st.frame.contentWindow) return;
    var pid = (String(cfg("PLAYER_JS_URL") || "").match(/player\/([0-9a-fA-F]{8})\//) || [])[1] || null;
    send(st.frame.contentWindow, { __ytdlp: VER, t: "hello", host: location.host, page: location.href, vd: cfg("VISITOR_DATA"), pid: pid, via: VIA });
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

  W.__ytdlpWeb = { app: APP_URL, open: open, hide: hide };
  // The extension / userscript wait for their Download button instead of opening right away.
  if (!W.__ytdlpNoAutoOpen) open();
})(
  window.__ytdlpAppUrl || new URL("../card.html", (document.currentScript && document.currentScript.src) || location.href).href,
  1
);

// ytdlp native button: adds a "Download" button to YouTube that looks exactly like YouTube's own,
// by cloning one of YouTube's buttons on the page (so it follows YouTube's current styles, theme
// and hover effects) and swapping in a download icon. Clicking it opens the ytdlp card.
//   www watch page   → left of the Like/Dislike pill
//   www Shorts       → in the top bar, left of "Create"
//   m.youtube.com    → icon next to Dislike (watch) / in the top bar (Shorts)
// Used by the browser extension and the userscript (both load bridge-inject.js first).
// ES5, no innerHTML (YouTube enforces Trusted Types).
(function () {
  var W = window, D = document;
  if (W.__ytdlpButton) return;
  W.__ytdlpButton = true;

  var HOST_ID = "ytdlp-dl-btn";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICON = "M12 15.6 7.4 11l1.4-1.4 2.2 2.2V4h2v7.8l2.2-2.2 1.4 1.4L12 15.6ZM6 20q-.8 0-1.4-.6Q4 18.8 4 18v-3h2v3h12v-3h2v3q0 .8-.6 1.4-.6.6-1.4.6H6Z";
  var LABEL = "Download";
  var ICON_ONLY = /\b(?:ytSpecButtonShapeNextIconButton|ytSpecButtonShapeNextIconOnlyDefault|yt-spec-button-shape-next--icon-button|yt-spec-button-shape-next--icon-only-default)\b/g;
  var TEXT_SEL = ".ytSpecButtonShapeNextButtonTextContent, .yt-spec-button-shape-next__button-text-content";
  var ICON_SEL = ".ytSpecButtonShapeNextIcon, .yt-spec-button-shape-next__icon";
  var FALLBACK_CLASS = "ytSpecButtonShapeNextHost ytSpecButtonShapeNextTonal ytSpecButtonShapeNextMono ytSpecButtonShapeNextSizeM " +
    "yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m";

  function q(sel, root) { return (root || D).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || D).querySelectorAll(sel)); }
  function visible(el) { return !!(el && el.getClientRects().length); }

  function icon(size) {
    var s = D.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size); s.setAttribute("height", size);
    s.setAttribute("fill", "currentColor");
    s.setAttribute("aria-hidden", "true");
    s.style.display = "block"; s.style.pointerEvents = "none";
    var p = D.createElementNS(SVG_NS, "path");
    p.setAttribute("d", ICON);
    s.appendChild(p);
    return s;
  }

  // Clone a YouTube button and turn it into ours.
  function build(template, withText) {
    var b;
    if (template) {
      b = template.cloneNode(true);
      var ids = qa("[id]", b);
      for (var i = 0; i < ids.length; i++) ids[i].removeAttribute("id");
      ["id", "disabled", "aria-disabled", "aria-pressed", "aria-haspopup", "aria-expanded", "aria-describedby", "title", "href"]
        .forEach(function (a) { b.removeAttribute(a); });
    } else {
      b = D.createElement("button");
      b.className = FALLBACK_CLASS;
    }
    // Icon: replace YouTube's icon (svg, lottie or c3-icon) with ours, keeping its wrapper and size.
    var iconBox = q(ICON_SEL, b);
    if (!iconBox) {
      // A plain icon button (e.g. the mobile top bar's search): keep its look, replace its content.
      b.className = b.className.replace(/\btopbar-button-[\w-]+/g, "");
      while (b.firstChild) b.removeChild(b.firstChild);
      iconBox = D.createElement("span");
      iconBox.className = "ytSpecButtonShapeNextIcon";
      iconBox.style.cssText = "display:flex;align-items:center;justify-content:center";
      b.appendChild(iconBox);
    }
    var old = template && q(ICON_SEL, template);
    var r = old && old.getBoundingClientRect();
    var size = r && r.width >= 16 && r.width <= 32 ? Math.round(r.width) : 24;
    var svg = q("svg", iconBox);
    // Keep YouTube's static icon wrappers (they size and colour the icon); drop animated ones.
    var slot = svg && !q("lottie-component, ytd-lottie-player, animated-icon, yt-animated-icon", iconBox) ? svg.parentNode : iconBox;
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    slot.appendChild(icon(size));

    // Text: a label next to the icon (desktop) or icon only (mobile, like its neighbours).
    var txt = q(TEXT_SEL, b);
    if (withText) {
      if (!txt) {
        txt = D.createElement("div");
        txt.className = "ytSpecButtonShapeNextButtonTextContent ytSpecButtonShapeNextElevatedContent yt-spec-button-shape-next__button-text-content";
        iconBox.parentNode.insertBefore(txt, iconBox.nextSibling);
      }
      while (txt.firstChild) txt.removeChild(txt.firstChild);
      txt.appendChild(D.createTextNode(LABEL));
      b.className = b.className.replace(ICON_ONLY, "").replace(/\s+/g, " ") +
        (/ytSpecButtonShapeNextHost/.test(b.className) ? " ytSpecButtonShapeNextIconLeading" : " yt-spec-button-shape-next--icon-leading");
    } else if (txt) {
      txt.parentNode.removeChild(txt);
    }
    b.setAttribute("aria-label", "Download with ytdlp");
    b.setAttribute("title", "Download with ytdlp");
    b.setAttribute("type", "button");
    return b;
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (W.__ytdlpWeb) W.__ytdlpWeb.open();
  }

  function makeHost(button, cls, style) {
    var host = D.createElement("div");
    host.id = HOST_ID;
    if (cls) host.className = cls;
    host.style.cssText = "display:inline-flex;align-items:center;flex:none;" + (style || "");
    host.appendChild(button);
    // Capture so none of YouTube's delegated handlers see the click.
    host.addEventListener("click", onClick, true);
    return host;
  }

  function byLabel(buttons, re) {
    for (var i = 0; i < buttons.length; i++) if (re.test(buttons[i].getAttribute("aria-label") || "")) return buttons[i];
    return null;
  }

  // Where the button belongs on the current page: { parent, after (null = first), make() } or null.
  function placement() {
    var path = location.pathname;
    var mobile = /^m\./.test(location.host);
    var isWatch = path === "/watch" || /^\/live\//.test(path);
    var isShorts = /^\/shorts\//.test(path);

    if (!mobile && isWatch) {
      var menu = q("ytd-watch-metadata ytd-menu-renderer");
      var row = menu && q("#top-level-buttons-computed", menu);
      if (!row || !visible(row)) return null;
      var btns = qa("button", menu).filter(visible);
      var tpl = byLabel(btns, /^share/i) ||
        btns.filter(function (b) { return /Tonal|--tonal/.test(b.className) && !/Segmented|--segmented/.test(b.className); })[0] ||
        q("ytd-masthead #buttons button");
      return { parent: row, after: null, make: function () { return makeHost(build(tpl, true), "", "margin-right:8px"); } };
    }
    if (!mobile && isShorts) {
      var bar = q("ytd-masthead #buttons");
      if (!bar || !visible(bar)) return null;
      var create = q("button", bar);
      return { parent: bar, after: null, make: function () { return makeHost(build(create, true), "", "margin-right:8px"); } };
    }
    if (mobile && isWatch) {
      var acts = q("ytm-slim-video-action-bar-renderer .slim-video-action-bar-actions");
      if (!acts || !visible(acts)) return null;
      // Right after Dislike (the bar renders in pieces, so wait for it).
      var after = q(":scope > dislike-button-view-model", acts) || q(":scope > like-button-view-model", acts);
      var tplHost = q(":scope > button-view-model", acts);
      if (!after || !tplHost) return null;
      var mtpl = q("button", tplHost);
      return { parent: acts, after: after, make: function () { return makeHost(build(mtpl, false), tplHost.className, ""); } };
    }
    if (mobile && isShorts) {
      var top = q("ytm-mobile-topbar-renderer .mobile-topbar-header-content");
      if (!top || !visible(top)) return null;
      var ttpl = q("button", top);
      return { parent: top, after: null, make: function () { return makeHost(build(ttpl, false), "", ""); } };
    }
    return null;
  }

  var busy = false;
  function ensure() {
    if (busy) return;
    busy = true;
    try {
      var cur = D.getElementById(HOST_ID);
      var p = placement();
      if (!p) { if (cur) cur.parentNode.removeChild(cur); return; }
      var placed = cur && cur.isConnected && cur.parentNode === p.parent &&
        (p.after ? cur.previousElementSibling === p.after : cur === p.parent.firstElementChild);
      if (placed) return;
      if (cur) cur.parentNode.removeChild(cur);
      p.parent.insertBefore(p.make(), p.after ? p.after.nextSibling : p.parent.firstChild);
    } catch (e) {
      // YouTube changed its layout; try again on the next tick.
    } finally {
      busy = false;
    }
  }

  ["yt-navigate-finish", "yt-page-data-updated", "state-navigateend", "popstate"].forEach(function (ev) {
    W.addEventListener(ev, function () { setTimeout(ensure, 50); setTimeout(ensure, 600); });
  });
  setInterval(ensure, 1000);
  ensure();
})();
