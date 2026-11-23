// Landing page: hands out the add-ons (Chrome extension, userscript) and the bookmark, per platform.
import { bookmarkletFor } from "./bridge.js";

const $ = (s) => document.querySelector(s);
const CARD_URL = new URL("card.html", location.href).href;
const EXT_ZIP = "addon/ytdlp-extension.zip";
const USERSCRIPT = "addon/ytdlp.user.js";
let code = "";

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const fa = (cls) => h("i", { class: cls });
// Static, trusted copy below; parsed with DOMParser so only our own markup is ever used.
const rich = (html) => new DOMParser().parseFromString(`<span>${html}</span>`, "text/html").body.firstChild;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2600);
}

const PLATFORMS = {
  desktop: {
    cta: "Add to Chrome",
    main: {
      icon: "fa-brands fa-chrome", title: "Chrome extension",
      sub: "Puts a Download button next to Like on every video, and next to Create on Shorts.",
      actions: [
        { href: EXT_ZIP, icon: "fa-solid fa-download", label: "Download extension", download: "ytdlp-extension.zip", primary: true },
        { href: USERSCRIPT, icon: "fa-solid fa-code", label: "Userscript (Tampermonkey)" },
      ],
      steps: [
        "<b>Unzip</b> the download. You get a folder called <b>ytdlp-extension</b>.",
        "Open <kbd>chrome://extensions</kbd> (Edge: <kbd>edge://extensions</kbd>) and turn on <b>Developer mode</b>.",
        "Click <b>Load unpacked</b> and pick the <b>ytdlp-extension</b> folder.",
        "Open any YouTube video and click <b>Download</b> next to Like.",
      ],
      note: "Works in Chrome, Edge, Brave, Opera and Vivaldi. It isn't on the Chrome Web Store because Google doesn't allow YouTube downloaders there. Already use Tampermonkey? The userscript does the same and updates itself.",
    },
    alt: {
      title: "No install: use the bookmark",
      drag: true,
      steps: [
        "<b>Drag the green ytdlp button</b> onto your bookmarks bar. (Bar hidden? <kbd>Ctrl/⌘</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>.)",
        "Open any <b>YouTube video</b> and click the <b>ytdlp</b> bookmark.",
      ],
    },
  },
  android: {
    cta: "Install on Android",
    main: {
      icon: "fa-solid fa-mobile-screen-button", title: "Userscript",
      sub: "Adds a download icon next to Dislike on every video. Install once, it updates itself.",
      actions: [{ href: USERSCRIPT, icon: "fa-solid fa-download", label: "Install userscript", primary: true }],
      steps: [
        "Chrome for Android can't run add-ons, so use <b>Microsoft Edge</b> or <b>Firefox</b> from the Play Store.",
        "Add a userscript manager. Edge: <b>⋮ → Extensions → Tampermonkey</b>. Firefox: <b>⋮ → Add-ons → Violentmonkey</b>.",
        "Open this page in that browser, tap <b>Install userscript</b>, then <b>Install</b>.",
        "Open <b>m.youtube.com</b>, play a video and tap the <b>download icon</b> next to Dislike.",
      ],
      note: "Watching in the YouTube app? Tap <b>Share → Copy link</b>, then open the link in Edge or Firefox.",
    },
    alt: {
      title: "Stuck with Chrome? Use the bookmark",
      copy: true,
      steps: [
        "Tap <b>Copy bookmark code</b>.",
        "Bookmark this page (<b>⋮ → ☆</b>), then edit the bookmark: name it <b>ytdlp</b> and replace its URL with the copied code.",
        "On a YouTube video, type <b>ytdlp</b> in the address bar and tap the bookmark result (the one with the star).",
      ],
    },
  },
  ios: {
    cta: "Install on iPhone",
    main: {
      icon: "fa-brands fa-safari", title: "Userscript for Safari",
      sub: "Adds a download icon next to Dislike on every video. Install once, it updates itself.",
      actions: [{ href: USERSCRIPT, icon: "fa-solid fa-download", label: "Install userscript", primary: true }],
      steps: [
        "Get the free <b>Userscripts</b> app from the App Store.",
        "Turn it on: <b>Settings → Apps → Safari → Extensions → Userscripts</b>, and allow it on <b>youtube.com</b>.",
        "Back here in Safari, tap <b>Install userscript</b>, then the <b>puzzle icon</b> in the address bar → <b>Userscripts</b> → <b>Install</b>.",
        "Open a video on <b>m.youtube.com</b> and tap the <b>download icon</b> next to Dislike.",
      ],
      note: "The engine needs WebAssembly JSPI, which only recent Safari versions have. If the card says your browser isn't supported, update iOS.",
    },
    alt: {
      title: "Or use the bookmark",
      copy: true,
      steps: [
        "Tap <b>Copy bookmark code</b>.",
        "Tap <b>Share → Add Bookmark</b>, save it, then open <b>Bookmarks → Edit</b>, rename it <b>ytdlp</b> and paste the code as its address.",
        "On a YouTube video in Safari, open <b>Bookmarks</b> and tap <b>ytdlp</b>.",
      ],
    },
  },
};

const stepList = (steps) => h("ol", { class: "steps" }, steps.map((s) => h("li", {}, rich(s))));

function renderMethods(p) {
  const { main, alt } = PLATFORMS[p];
  const box = $("#methods");
  box.replaceChildren(
    h("div", { class: "method" },
      h("div", { class: "m-head" },
        h("span", { class: "m-ic" }, fa(main.icon)),
        h("div", {}, h("div", { class: "m-title" }, main.title, h("span", { class: "badge" }, "Recommended")), h("div", { class: "m-sub" }, main.sub))),
      h("div", { class: "m-actions" }, main.actions.map((a) =>
        h("a", { class: a.primary ? "btn primary" : "btn", href: a.href, download: a.download || null }, fa(a.icon), a.label))),
      stepList(main.steps),
      main.note ? h("p", { class: "m-note" }, fa("fa-solid fa-circle-info"), rich(main.note)) : null),
    h("details", { class: "method alt" },
      h("summary", {}, fa("fa-solid fa-bookmark"), alt.title, fa("fa-solid fa-chevron-down chev")),
      alt.drag ? h("div", { class: "drag-row" },
        h("a", { class: "bookmark", id: "bookmarklet", href: code || "#", title: "Drag me to your bookmarks bar",
          onclick: (e) => { e.preventDefault(); toast("Drag it to your bookmarks bar, then click it on a YouTube video."); } },
          fa("fa-solid fa-bolt"), " ytdlp"),
        h("span", { class: "install-hint" }, fa("fa-solid fa-arrow-up"), "Drag to your bookmarks bar")) : null,
      stepList(alt.steps),
      alt.copy ? h("button", { class: "copy", onclick: copyCode }, fa("fa-regular fa-copy"), h("span", {}, "Copy bookmark code")) : null),
  );
}

async function copyCode() {
  if (!code) return toast("Still preparing the bookmark, one second…");
  try { await navigator.clipboard.writeText(code); toast("Copied. Paste it as the bookmark's URL."); }
  catch { toast("Couldn't access the clipboard. Try again, or use a desktop browser."); }
}

function showPlatform(p) {
  document.querySelectorAll("#platformTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.p === p)));
  $("#cta span").textContent = PLATFORMS[p].cta;
  renderMethods(p);
}

document.querySelectorAll("#platformTabs button").forEach((b) => b.addEventListener("click", () => showPlatform(b.dataset.p)));

const ua = navigator.userAgent;
const detected = /Android/i.test(ua) ? "android" : /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ios" : "desktop";
// The card links here as #desktop / #android / #ios.
const fromHash = () => (PLATFORMS[location.hash.slice(1)] ? location.hash.slice(1) : null);
showPlatform(fromHash() || detected);
if (fromHash()) requestAnimationFrame(() => $("#get").scrollIntoView({ behavior: "smooth", block: "start" }));
window.addEventListener("hashchange", () => { const p = fromHash(); if (p) { showPlatform(p); $("#get").scrollIntoView({ behavior: "smooth" }); } });

bookmarkletFor(CARD_URL).then((c) => { code = c; const b = $("#bookmarklet"); if (b) b.href = c; })
  .catch((e) => toast(`Couldn't build the bookmark: ${e.message}`));
