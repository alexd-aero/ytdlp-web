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
