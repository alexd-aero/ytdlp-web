// Landing page: hands out the bookmark (a loader for js/bridge-inject.js) with per-platform setup steps.
import { bookmarkletFor } from "./bridge.js";

const $ = (s) => document.querySelector(s);
const CARD_URL = new URL("card.html", location.href).href;
let code = "";

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2600);
}

const STEPS = {
  desktop: [
    "<b>Drag the green ytdlp button</b> above onto your bookmarks bar. (Bar hidden? Press <kbd>Ctrl/⌘</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>.)",
    "Open any <b>YouTube video</b>.",
    "Click the <b>ytdlp</b> bookmark. The card floats in on the right. Drag it by its top bar, and press <kbd>Esc</kbd> to hide it.",
  ],
  android: [
    "Tap <b>Copy bookmark code</b> below.",
    "Bookmark this page (<b>⋮ → ☆</b>), then edit the bookmark: name it <b>ytdlp</b> and replace its URL with the copied code.",
    "On a YouTube video, type <b>ytdlp</b> in the address bar and tap the bookmark result (the one with the star). The card slides up from the bottom.",
  ],
  ios: [
    "Tap <b>Copy bookmark code</b> below.",
    "Tap <b>Share → Add Bookmark</b>, save it, then open <b>Bookmarks → Edit</b>, rename it <b>ytdlp</b> and paste the code as its address.",
    "On a YouTube video in Safari, open <b>Bookmarks</b> and tap <b>ytdlp</b>.",
  ],
};

function showPlatform(p) {
  document.querySelectorAll("#platformTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.p === p)));
  const ol = $("#steps");
  ol.replaceChildren();
  // Static, trusted copy above; built with DOMParser so only our own markup is ever parsed.
  for (const html of STEPS[p]) {
    const li = document.createElement("li");
    const frag = new DOMParser().parseFromString(`<span>${html}</span>`, "text/html").body.firstChild;
    li.append(frag);
    ol.append(li);
  }
  $("#installHint").hidden = p !== "desktop";
}

document.querySelectorAll("#platformTabs button").forEach((b) => b.addEventListener("click", () => showPlatform(b.dataset.p)));
const ua = navigator.userAgent;
showPlatform(/Android/i.test(ua) ? "android" : /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ios" : "desktop");

$("#bookmarklet").addEventListener("click", (e) => { e.preventDefault(); toast("Drag it to your bookmarks bar, then tap it on a YouTube video."); });
$("#btnCopy").addEventListener("click", async () => {
  if (!code) return toast("Still preparing the bookmark, one second…");
  try { await navigator.clipboard.writeText(code); toast("Copied. Paste it as the bookmark's URL."); }
  catch { toast("Couldn't access the clipboard. Long-press the green button and copy its link."); }
});

bookmarkletFor(CARD_URL).then((c) => { code = c; $("#bookmarklet").href = c; })
  .catch((e) => toast(`Couldn't build the bookmark: ${e.message}`));
