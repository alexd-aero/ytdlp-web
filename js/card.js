// ytdlp floating card: Video or Audio → quality → extras → confirm → live progress → Download now.
import { Bridge } from "./bridge.js";
import { Engine } from "./engine.js";
import { runJob, hasVideo, hasAudio } from "./pipeline.js";
import { DEFAULTS } from "./options.js";
import { setRetryLogger } from "./download.js";

// ------------------------------------------------------------------ helpers
const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const fa = (name, style = "solid") => h("i", { class: `fa-${style} fa-${name}` });
const fmtBytes = (n) => {
  if (!n) return "–";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
const fmtDur = (s) => {
  if (!s && s !== 0) return "";
  s = Math.round(s);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, "0")}` : `${mm}`) + `:${String(ss).padStart(2, "0")}`;
};
const videoIdOf = (u) => {
  try {
    const url = new URL(u);
    if (url.hostname === "youtu.be") return url.pathname.slice(1, 12);
    if (url.searchParams.get("v")) return url.searchParams.get("v");
    const m = url.pathname.match(/\/(shorts|live|embed)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch { return null; }
};

// ------------------------------------------------------------------ state
const PREF_KEY = "ytdlp.card.v1";
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; } })();
const state = {
  step: "type",
  url: null, vid: null, title: null, video: null, probing: false, probeError: null,
  kind: prefs.kind || null,
  container: prefs.container || "mp4",
  height: null,
  aFormat: prefs.aFormat || "mp3",
  aChoice: prefs.aChoice || null,
  thumb: prefs.thumb ?? true, square: prefs.square ?? true, meta: prefs.meta ?? true,
  chapters: prefs.chapters ?? true, subs: prefs.subs ?? false, sponsor: prefs.sponsor ?? false,
  ctrl: null, result: null, error: null,
  tipDismissed: prefs.tipDismissed ?? false,
};
const savePrefs = () => {
  const { kind, container, aFormat, aChoice, thumb, square, meta, chapters, subs, sponsor, tipDismissed } = state;
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ kind, container, aFormat, aChoice, thumb, square, meta, chapters, subs, sponsor, tipDismissed })); } catch {}
};

const inFrame = window.parent !== window;
if (!inFrame) { document.body.classList.add("standalone"); $("#btnClose").hidden = true; }

const bridge = new Bridge();
const engine = new Engine(bridge);

// ------------------------------------------------------------------ frame integration (size, close, drag)
const card = $("#card");
new ResizeObserver(() => bridge.reportSize(card.getBoundingClientRect().height)).observe(card);
$("#btnClose").addEventListener("click", () => bridge.closeOverlay());
window.addEventListener("keydown", (e) => { if (e.key === "Escape") bridge.closeOverlay(); });
(() => {
  const top = $(".top");
  let last = null;
  top.addEventListener("pointerdown", (e) => {
    if (!inFrame || e.target.closest("button")) return;
    last = [e.screenX, e.screenY];
    top.setPointerCapture(e.pointerId);
    top.style.cursor = "grabbing";
  });
  top.addEventListener("pointermove", (e) => {
    if (!last) return;
    bridge.moveBy(e.screenX - last[0], e.screenY - last[1]);
    last = [e.screenX, e.screenY];
  });
  const end = () => { last = null; top.style.cursor = ""; };
  top.addEventListener("pointerup", end);
  top.addEventListener("pointercancel", end);
})();

// ------------------------------------------------------------------ engine status
const engineEl = $("#engine");
const setEngine = (cls, icon, text) => { engineEl.className = `engine ${cls}`; engineEl.replaceChildren(icon, h("span", {}, text)); };
engine.addEventListener("status", (e) => setEngine("", h("i", { class: "fa-solid fa-circle-notch fa-spin" }), e.detail.phase === "python" ? "Loading engine" : e.detail.phase === "wheels" ? "Installing yt-dlp" : "Starting yt-dlp"));
engine.addEventListener("ready", (e) => { setEngine("ready", fa("circle-check"), `yt-dlp ${e.detail.version}`); maybeProbe(); });
engine.addEventListener("fatal", () => setEngine("bad", fa("triangle-exclamation"), "Engine failed"));

// ------------------------------------------------------------------ live log
const logLines = [];
let logEl = null;
function log(text, cls = "") {
  logLines.push([text, cls]);
  if (logLines.length > 400) logLines.shift();
  if (logEl) {
    logEl.append(h("div", { class: cls }, text));
    while (logEl.childElementCount > 400) logEl.firstElementChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }
}
setRetryLogger((m) => log(`! ${m}`, "w"));
engine.addEventListener("log", (e) => {
  const { level, msg } = e.detail;
  if (level === "debug") return;
  log(msg.replace(/^\[debug\] /, ""), level === "warning" ? "w" : level === "error" ? "e" : "");
});

// ------------------------------------------------------------------ video source
bridge.addEventListener("status", (e) => {
  if (e.detail.connected) {
    log(`[bridge] connected to ${e.detail.host}`, "d");
    if (videoIdOf(e.detail.page || "")) setUrl(e.detail.page);
    else if (!state.url) showUrlBox();
    maybeProbe();
  } else if (!state.ctrl) {
    renderNotice("Lost connection to YouTube", "The YouTube tab was closed or reloaded. Tap your ytdlp bookmark on YouTube again.");
  }
});
bridge.addEventListener("page", (e) => {
  // The user navigated to another video on YouTube while the card was open.
  if (!state.ctrl && videoIdOf(e.detail.page) && videoIdOf(e.detail.page) !== state.vid) setUrl(e.detail.page);
});

function showUrlBox() {
  $("#urlBox").hidden = false;
  $("#urlInput").focus();
}
$("#urlForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const u = $("#urlInput").value.trim();
  if (videoIdOf(u)) setUrl(u);
  else $("#urlInput").animate([{ transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "none" }], { duration: 220 });
});

function setUrl(url) {
  const vid = videoIdOf(url);
  if (!vid) return;
  if (vid === state.vid && state.video) return;
  Object.assign(state, { url: `https://www.youtube.com/watch?v=${vid}`, vid, video: null, title: null, probeError: null, height: null, result: null, error: null });
  $("#urlBox").hidden = true;
  $("#video").hidden = false;
  $("#vThumb").src = `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;
  $("#vTitle").textContent = "Loading…";
  $("#vSub").replaceChildren();
  $("#vDur").textContent = "";
  // oEmbed answers any origin, so the title shows instantly while yt-dlp warms up.
  fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(state.url)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && state.vid === vid && !state.video) { $("#vTitle").textContent = j.title; $("#vSub").replaceChildren(fa("circle-user"), j.author_name); } })
    .catch(() => {});
  go(state.kind ? "type" : "type");
  maybeProbe();
}

async function maybeProbe() {
  if (!state.url || state.video || state.probing || !engine.ready || !bridge.connected) return;
  state.probing = true;
  const vid = state.vid;
  log(`$ yt-dlp "${state.url}"`, "s");
  const opts = {};
  if (bridge.mobileSite && bridge.visitorData) opts.visitor_data = bridge.visitorData;
  const res = await engine.probe(state.url, opts).catch((e) => ({ ok: false, error: e.message }));
  state.probing = false;
  if (state.vid !== vid) return;
  if (!res.ok) {
    state.probeError = res.error.replace(/^ERROR: (\[youtube\] [\w-]+: )?/, "").split(" Use --cookies")[0];
    log(res.error, "e");
    render();
    return;
  }
  res._probedAt = Date.now();
  state.video = res;
  $("#vTitle").textContent = res.title;
  $("#vSub").replaceChildren(fa("circle-user"), res.channel || "", res.view_count ? `  ·  ${Intl.NumberFormat("en", { notation: "compact" }).format(res.view_count)} views` : "");
  $("#vDur").textContent = fmtDur(res.duration);
  if (res.thumbnail) $("#vThumb").src = res.thumbnail;
  render();
}

// ------------------------------------------------------------------ stream options
function bestAudio(v) {
  const a = v.formats.filter((f) => hasAudio(f) && !hasVideo(f));
  return a.sort((x, y) => (y.abr || y.tbr || 0) - (x.abr || x.tbr || 0))[0] || null;
}
function sizeOf(f, dur) {
  return f.filesize || f.filesize_approx || (f.tbr && dur ? (f.tbr * 1000 * dur) / 8 : 0);
}
// Which stream yt-dlp will most likely pick at a height for a container
// (its codec preference is AV1 > VP9 > H.264, within what the container prefers).
const CODEC_RANK = (f) => { const c = (f.vcodec || ""); return c.startsWith("av01") ? 3 : /^vp0?9/.test(c) ? 2 : c.startsWith("avc1") ? 1 : 0; };
function likelyPick(cands, container) {
  const pref = container === "webm" ? cands.filter((f) => f.ext === "webm") : container === "mp4" ? cands.filter((f) => f.ext === "mp4") : cands;
  const pool = (pref.length ? pref : cands).filter((f) => !f.dynamic_range || f.dynamic_range === "SDR");
  const list = pool.length ? pool : cands;
  return list.sort((x, y) => CODEC_RANK(y) - CODEC_RANK(x) || (y.fps || 0) - (x.fps || 0) || (y.tbr || 0) - (x.tbr || 0))[0];
}
function videoOptions(v) {
  const dur = v.duration || 0;
  const a = bestAudio(v);
  const aSize = a ? sizeOf(a, dur) : 0;
  const by = new Map();
  for (const f of v.formats) {
    if (!hasVideo(f) || !f.height || /storyboard/i.test(f.format_note || "")) continue;
    const g = by.get(f.height) || { height: f.height, fps: 0, size: 0, hdr: false, sdr: false, codecs: new Set(), cands: [] };
    g.cands.push(f);
    g.fps = Math.max(g.fps, f.fps || 0);
    g.size = sizeOf(likelyPick(g.cands, state.container), dur);
    if (f.dynamic_range && f.dynamic_range !== "SDR") g.hdr = true; else g.sdr = true;
    g.codecs.add((f.vcodec || "").split(".")[0].replace("avc1", "H.264").replace("av01", "AV1").replace("vp09", "VP9").replace("vp9", "VP9"));
    by.set(f.height, g);
  }
  return [...by.values()].sort((x, y) => y.height - x.height).map((g) => ({ ...g, total: g.size + aSize }));
}
const RES_TAG = { 4320: "8K", 2160: "4K", 1440: "2K", 1080: "FHD", 720: "HD" };

const AUDIO_FMTS = {
  mp3: { label: "MP3", rows: ["320", "256", "192", "128", "96"] },
  m4a: { label: "M4A", rows: ["original", "256", "192", "128"] },
  opus: { label: "OPUS", rows: ["original", "128", "96", "64"] },
  flac: { label: "FLAC", rows: ["lossless"] },
  wav: { label: "WAV", rows: ["lossless"] },
};
function audioRow(fmt, choice, v) {
  const dur = v?.duration || 0;
  const src = v ? bestAudio(v) : null;
  const srcKbps = Math.round(src?.abr || src?.tbr || 160);
  if (choice === "original") {
    const want = fmt === "m4a" ? /^mp4a/ : /^opus/;
    const s = v?.formats.filter((f) => hasAudio(f) && !hasVideo(f) && want.test(f.acodec || "")).sort((x, y) => (y.abr || 0) - (x.abr || 0))[0];
    const kb = Math.round(s?.abr || s?.tbr || srcKbps);
    return { label: `${kb} kbps`, tag: "ORIGINAL", note: "Untouched stream", size: s ? sizeOf(s, dur) : (kb * 125 * dur) };
  }
  if (choice === "lossless") {
    const kb = fmt === "wav" ? 1536 : 900;
    return { label: "Lossless", tag: fmt === "wav" ? "PCM" : "24-BIT", note: `From the ${srcKbps} kbps source`, size: kb * 125 * dur };
  }
  return { label: `${choice} kbps`, tag: null, note: Number(choice) > srcKbps ? "Above source quality" : "", size: Number(choice) * 125 * dur };
}

// ------------------------------------------------------------------ views
const STEPS = ["type", "quality", "extras", "confirm"];
function go(step) { state.step = step; render(); }
function setSteps() {
  const i = STEPS.indexOf(state.step);
  const shown = state.url && !["notice"].includes(state.step);
  $("#steps").hidden = !shown;
  [...$("#steps").children].forEach((s, k) => s.classList.toggle("on", i === -1 ? true : k <= i));
}
function view(...kids) {
  const v = $("#view");
  v.classList.remove("swap"); void v.offsetWidth; // restart the enter animation
  v.replaceChildren(...kids);
}
const back = (to) => h("button", { class: "back", onclick: () => go(to) }, fa("arrow-left"), "Back");

// yt-dlp's Python needs WebAssembly JSPI to wait on network requests.
const JSPI = typeof WebAssembly === "object" && (typeof WebAssembly.Suspending === "function" || typeof WebAssembly.Function === "function");

function render() {
  setSteps();
  if (!JSPI) {
    setEngine("bad", fa("triangle-exclamation"), "Not supported");
    return renderNotice("This browser can't run yt-dlp yet",
      "It needs WebAssembly JSPI: current Chrome, Edge, Brave or Opera, Firefox 153+, or a recent Safari. Update your browser, or try Edge or Firefox.");
  }
  if (!state.url) {
    if (!bridge.connected && !inFrame) {
      return renderNotice("Open this from YouTube", "Go to a YouTube video and tap your ytdlp bookmark. It opens right there, no new tabs.", true);
    }
    return view(h("div", { class: "notice info" }, fa("link"), h("div", {}, h("b", {}, "Open a video"), "Go to any YouTube video and the card picks it up, or paste a link above.")));
  }
  ({ type: renderType, quality: renderQuality, extras: renderExtras, confirm: renderConfirm, progress: renderProgress, done: renderDone, error: renderError }[state.step] || renderType)();
}

function renderNotice(title, text, landing = false) {
  $("#steps").hidden = true;
  view(h("div", { class: "notice info" }, fa("circle-info"), h("div", {}, h("b", {}, title), text,
    landing ? h("div", { style: "margin-top:8px" }, h("a", { href: "./", style: "color:var(--accent);font-weight:600" }, "Get the bookmark →")) : null)));
}

function renderType() {
  const v = state.video;
  const maxH = v ? Math.max(0, ...v.formats.filter(hasVideo).map((f) => f.height || 0)) : 0;
  const pick = (kind) => { state.kind = kind; savePrefs(); go("quality"); };
  view(
    h("div", { class: "q" }, "What do you want?"),
    h("div", { class: "qs" }, "Pick one. You can change everything before downloading."),
    h("div", { class: "choices" },
      h("button", { class: "choice", onclick: () => pick("video") },
        h("div", { class: "ic" }, fa("film")), h("div", { class: "ct" }, "Video"),
        h("div", { class: "cs" }, maxH ? `MP4 · MKV · up to ${RES_TAG[maxH] || maxH + "p"}` : "MP4 · MKV · WebM")),
      h("button", { class: "choice alt", onclick: () => pick("audio") },
        h("div", { class: "ic" }, fa("music")), h("div", { class: "ct" }, "Audio"),
        h("div", { class: "cs" }, "MP3 · M4A · Opus · FLAC · WAV"))),
    addonTip(),
  );
}

// Opened from the bookmark: suggest the extension / userscript, which adds a native Download button.
function addonTip() {
  if (bridge.via !== "bookmark" || state.tipDismissed) return null;
  const mobile = bridge.mobileSite;
  const tip = h("div", { class: "tip" },
    h("div", { class: "tip-ic" }, fa(mobile ? "mobile-screen-button" : "puzzle-piece")),
    h("div", { class: "tip-tx" },
      h("b", {}, mobile ? "Skip the bookmark" : "Get a Download button on YouTube"),
      mobile ? "Install the userscript once and a download icon appears next to Dislike on every video."
             : "Install the extension and a Download button appears next to Like on every video."),
    h("a", { class: "tip-go", href: new URL(`./#${mobile ? "android" : "desktop"}`, location.href).href, target: "_blank", rel: "noopener" }, "Install"),
    h("button", { class: "tip-x", "aria-label": "Dismiss", onclick: () => { state.tipDismissed = true; savePrefs(); tip.remove(); } }, fa("xmark")));
  return tip;
}

function renderQuality() {
  const v = state.video;
  const kids = [back("type")];
  if (state.probeError) {
    return view(...kids, h("div", { class: "notice" }, fa("triangle-exclamation"), h("div", {}, h("b", {}, "YouTube didn't return this video"), state.probeError)),
      h("div", { class: "actions" }, h("button", { class: "btn ghost", onclick: () => { state.probeError = null; state.video = null; maybeProbe(); render(); } }, fa("rotate-right"), "Try again")));
  }
  if (state.kind === "video") {
    kids.push(h("div", { class: "q" }, "Video quality"), h("div", { class: "qs" }, "Straight from YouTube's streams, highest first."));
    kids.push(h("div", { class: "seg" }, ["mp4", "mkv", "webm"].map((c) =>
      h("button", { class: state.container === c ? "on" : "", onclick: () => { state.container = c; savePrefs(); render(); } }, c.toUpperCase()))));
    if (!v) kids.push(skeleton());
    else {
      const opts = videoOptions(v);
      if (!state.height || !opts.some((o) => o.height === state.height)) state.height = opts[0]?.height;
      kids.push(h("div", { class: "list" }, opts.map((o, i) => h("button", {
        class: `opt${state.height === o.height ? " on" : ""}`, onclick: () => { state.height = o.height; render(); },
      },
        h("span", { class: "radio" }),
        h("span", { class: "ol" }, h("b", {}, `${o.height}p`),
          o.fps > 30 ? h("span", { class: "badge" }, `${Math.round(o.fps)}FPS`) : null,
          RES_TAG[o.height] ? h("span", { class: "badge" }, RES_TAG[o.height]) : null,
          o.hdr && !o.sdr ? h("span", { class: "badge hdr" }, "HDR") : null,
          i === 0 ? h("span", { class: "badge max" }, "MAX") : null),
        h("span", { class: "or" }, o.total ? `~${fmtBytes(o.total)}` : "", h("small", {}, [...o.codecs].filter(Boolean).join(" / ")))))));
    }
  } else {
    kids.push(h("div", { class: "q" }, "Audio quality"));
    const src = v ? bestAudio(v) : null;
    kids.push(h("div", { class: "qs" }, src
      ? h("span", {}, "YouTube's best stream: ", h("b", { style: "color:var(--text)" }, `${(src.acodec || "").split(".")[0].replace("mp4a", "AAC").toUpperCase()} ${Math.round(src.abr || src.tbr || 0)} kbps`))
      : "Reading YouTube's streams…"));
    kids.push(h("div", { class: "seg" }, Object.entries(AUDIO_FMTS).map(([k, f]) =>
      h("button", { class: state.aFormat === k ? "on" : "", onclick: () => { state.aFormat = k; state.aChoice = null; savePrefs(); render(); } }, f.label))));
    const rows = AUDIO_FMTS[state.aFormat].rows;
    if (!rows.includes(state.aChoice)) state.aChoice = rows[0];
    kids.push(h("div", { class: "list" }, rows.map((r, i) => {
      const a = audioRow(state.aFormat, r, v);
      return h("button", { class: `opt${state.aChoice === r ? " on" : ""}`, onclick: () => { state.aChoice = r; savePrefs(); render(); } },
        h("span", { class: "radio" }),
        h("span", { class: "ol" }, h("b", {}, a.label), a.tag ? h("span", { class: "badge" }, a.tag) : null, i === 0 ? h("span", { class: "badge max" }, "MAX") : null),
        h("span", { class: "or" }, v && a.size ? `~${fmtBytes(a.size)}` : "", a.note ? h("small", {}, a.note) : null));
    })));
  }
  kids.push(h("div", { class: "actions" }, h("button", { class: "btn primary", disabled: !v, onclick: () => go("extras") }, "Continue", fa("arrow-right"))));
  view(...kids);
}

function skeleton() {
  return h("div", {}, h("div", { class: "skel" }), h("div", { class: "skel" }), h("div", { class: "skel" }),
    h("div", { class: "src-note" }, h("i", { class: "fa-solid fa-circle-notch fa-spin" }), engine.ready ? "Reading available streams…" : "Starting the engine…"));
}

function swRow(key, icon, title, sub) {
  const row = h("div", { class: `sw-row${state[key] ? " on" : ""}`, role: "switch", "aria-checked": String(!!state[key]), tabindex: "0",
    onclick: () => { state[key] = !state[key]; savePrefs(); row.classList.toggle("on", state[key]); row.setAttribute("aria-checked", String(state[key])); },
    onkeydown: (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); row.click(); } },
  }, h("span", { class: "si" }, fa(icon)), h("span", { class: "st" }, h("b", {}, title), h("small", {}, sub)), h("span", { class: "tg" }));
  return row;
}

function renderExtras() {
  const audio = state.kind === "audio";
  const thumbOk = audio ? !["wav"].includes(state.aFormat) : state.container !== "webm";
  view(back("quality"),
    h("div", { class: "q" }, "Extras"),
    h("div", { class: "qs" }, "Toggle what goes into the file."),
    h("div", { class: "switches" },
      swRow("thumb", "image", "Thumbnail", thumbOk ? (audio ? "Embed as cover art" : "Embed in the video") : "Saved as a separate image (this format can't embed it)"),
      audio ? swRow("square", "crop-simple", "Square cover", "Album-art style 1:1 crop") : null,
      swRow("meta", "tags", "Metadata", "Title, artist, date, link"),
      swRow("chapters", "list-ul", "Chapters", "When the video has them")),
    h("details", { class: "more" }, h("summary", {}, fa("chevron-right"), "More"),
      h("div", { class: "switches" },
        audio ? null : swRow("subs", "closed-captioning", "English subtitles", "Embedded, auto-captions if needed"),
        swRow("sponsor", "forward", "Skip sponsors", "Cut sponsor segments (SponsorBlock)"))),
    h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: () => go("confirm") }, "Review", fa("arrow-right"))));
}

function qualityLabel() {
  if (state.kind === "video") return `${state.height}p · ${state.container.toUpperCase()}`;
  const a = audioRow(state.aFormat, state.aChoice, state.video);
  return `${AUDIO_FMTS[state.aFormat].label} · ${a.label}`;
}
function estSize() {
  const v = state.video;
  if (!v) return 0;
  if (state.kind === "video") return videoOptions(v).find((o) => o.height === state.height)?.total || 0;
  return audioRow(state.aFormat, state.aChoice, v).size;
}

function renderConfirm() {
  const on = [state.meta && "metadata", state.chapters && "chapters", state.kind === "video" && state.subs && "subtitles", state.sponsor && "no sponsors"].filter(Boolean);
  const row = (icon, k, val) => h("div", { class: "srow" }, fa(icon), h("span", {}, k), h("b", {}, val));
  view(back("extras"),
    h("div", { class: "q" }, "Ready to download?"),
    h("div", { class: "qs" }, "Check everything, then confirm."),
    h("div", { class: "summary" },
      row(state.kind === "video" ? "film" : "music", "Type", state.kind === "video" ? "Video" : "Audio"),
      row("sliders", "Quality", qualityLabel()),
      row("image", "Thumbnail", state.thumb ? (state.kind === "audio" && state.square ? "Square cover" : "Included") : "None"),
      row("wand-magic-sparkles", "Extras", on.length ? on.join(", ") : "None")),
    h("div", { class: "total" }, h("span", {}, "Estimated size"), h("b", {}, `~${fmtBytes(estSize())}`)),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", onclick: start }, fa("bolt"), "Confirm & download")));
}

// ------------------------------------------------------------------ run
function buildOptions() {
  const base = {
    ...DEFAULTS,
    thumbnail: state.thumb ? "embed" : "none",
    thumbSquare: state.kind === "audio" && state.square,
    metadata: state.meta, chapters: state.chapters,
    subs: state.kind === "video" && state.subs ? "embed" : "none", subLangs: "en.*", autoSubs: true,
    sponsorblock: state.sponsor ? "remove" : "off",
    playerClient: "",
  };
  if (state.kind === "video") {
    const o = videoOptions(state.video).find((x) => x.height === state.height);
    return { ...base, mode: "av", quality: String(state.height), container: state.container, vcodec: "any", fps: "any", hdr: !!(o && o.hdr && !o.sdr), recode: "none" };
  }
  const f = state.aFormat, c = state.aChoice;
  if (c === "original") {
    return { ...base, mode: "audio", audioFormat: "best", formatOverride: f === "m4a" ? "ba[acodec^=mp4a]/ba" : "ba[acodec^=opus]/ba" };
  }
  if (c === "lossless") return { ...base, mode: "audio", audioFormat: f };
  return { ...base, mode: "audio", audioFormat: f, audioBitrateMode: "cbr", audioBitrate: c };
}

// Progress: driven directly by progress events; the bar eases via a CSS transition.
const prog = { target: 0, seg: [0, 0.04], phase: 0, label: "Starting", downloads: 0 };
function setTarget(t) {
  prog.target = Math.min(1, Math.max(prog.target, t));
  const pct = $("#pct"), fill = $("#fill");
  if (pct) pct.replaceChildren(String(Math.floor(prog.target * 100)), h("small", {}, "%"));
  if (fill) fill.style.width = `${(prog.target * 100).toFixed(2)}%`;
}
function setPhase(i, label) {
  prog.phase = i;
  if (label) prog.label = label;
  document.querySelectorAll(".ph").forEach((p, k) => { p.classList.toggle("done", k < i); p.classList.toggle("active", k === i); });
  const pl = $("#phaseLabel");
  if (pl) pl.replaceChildren(h("b", {}, ["Finding streams", "Downloading", "Processing", "Done"][i]), prog.label);
}

function renderProgress() {
  $("#steps").hidden = true;
  logEl = h("div", { class: "log" });
  logLines.slice(-80).forEach(([t, c]) => logEl.append(h("div", { class: c }, t)));
  view(
    h("div", { class: "prog-head" }, h("div", { class: "pct", id: "pct" }, "0", h("small", {}, "%")), h("div", { class: "phase-label", id: "phaseLabel" })),
    h("div", { class: "bar" }, h("div", { class: "fill", id: "fill" })),
    h("div", { class: "stats" }, h("span", { id: "statL" }, ""), h("span", { id: "statR" }, "")),
    h("div", { class: "phases" },
      [["magnifying-glass", "Extract"], ["cloud-arrow-down", "Download"], ["wand-magic-sparkles", "Process"], ["check", "Ready"]].map(([i, t]) => h("div", { class: "ph" }, fa(i), t))),
    logEl,
    h("div", { class: "actions" }, h("button", { class: "btn ghost", style: "flex:1", onclick: () => state.ctrl?.abort() }, fa("xmark"), "Cancel")));
  logEl.scrollTop = logEl.scrollHeight;
  setPhase(prog.phase);
  const t = prog.target; prog.target = 0; setTarget(t);
}

function onStep(text) {
  log(`▸ ${text}`, "s");
  if (/^Selecting formats/.test(text)) { prog.seg = [0.02, 0.04]; setTarget(0.03); setPhase(0, text); }
  else if (/^Downloading/.test(text)) {
    prog.downloads++;
    const isVideo = state.kind === "video";
    prog.seg = !isVideo ? [0.04, 0.88] : prog.downloads === 1 ? [0.04, 0.76] : [0.76, 0.88];
    setTarget(prog.seg[0]);
    setPhase(1, text.replace(/^Downloading /, ""));
  } else if (/^Fetching|^Querying/.test(text)) { setPhase(1, text); }
  else { prog.seg = [0.88, 0.995]; setTarget(0.88); setPhase(2, text); }
}
function onProgress(f, text) {
  if (f != null) setTarget(prog.seg[0] + f * (prog.seg[1] - prog.seg[0]));
  const l = $("#statL"), r = $("#statR");
  if (!text || !l) return;
  const m = text.match(/([\d.]+) MiB(?: \/ ([\d.]+) MiB)? · ([\d.]+) MiB\/s/);
  if (m) {
    const [, got, tot, spd] = m.map(Number);
    l.textContent = `${fmtBytes(got * 1048576)}${tot ? " / " + fmtBytes(tot * 1048576) : ""}`;
    const eta = tot && spd ? Math.max(0, (tot - got) / spd) : null;
    r.textContent = `${fmtBytes(spd * 1048576)}/s${eta != null ? " · " + fmtDur(eta) + " left" : ""}`;
  } else { l.textContent = text; r.textContent = ""; }
}

async function start() {
  if (state.ctrl) return;
  state.ctrl = new AbortController();
  state.result = null; state.error = null;
  Object.assign(prog, { target: 0, phase: 0, downloads: 0, label: "Preparing" });
  go("progress");
  setTarget(0.01);
  const opts = buildOptions();
  log(`$ yt-dlp ${state.kind === "audio" ? "-x " : ""}[${qualityLabel()}] "${state.url}"`, "s");
  const warns = [];
  const reextract = async (client = "") => {
    onStep(client ? `Getting links from the ${client} client` : "Refreshing stream links");
    const o = { player_client: client };
    if (bridge.mobileSite && bridge.visitorData) o.visitor_data = bridge.visitorData;
    const res = await engine.probe(state.url, o);
    if (!res.ok) throw new Error(res.error);
    res._probedAt = Date.now();
    state.video = res;
  };
  const attempt = () => { prog.downloads = 0; return runJob({ engine, bridge, video: state.video, options: opts, signal: state.ctrl.signal, onStep, onProgress, onLog: (m) => { if (/^\[(select|sponsorblock|thumb)\]/.test(m)) log(m, "d"); }, onWarn: (w) => { warns.push(w); log(`! ${w}`, "w"); } }); };
  try {
    if (!state.video._probedAt || Date.now() - state.video._probedAt > 45000) await reextract();
    // If YouTube refuses the stream links (403, or a rejection the browser reports as
    // "Failed to fetch"), get fresh links, then try other YouTube clients.
    const fallbacks = ["", "android_vr", "visionos"];
    let outs;
    for (let i = 0; ; i++) {
      try { outs = await attempt(); break; }
      catch (e) {
        if (!/HTTP 403|Refused by server/.test(e.message) || state.ctrl.signal.aborted) throw e;
        if (i >= fallbacks.length) throw new Error(`${e.message}\nYouTube refused every stream link it gave this device. On mobile data or a VPN? Try Wi-Fi or turn the VPN off.`);
        log(`! YouTube refused the stream; ${i === 0 ? "fetching fresh links" : `trying the ${fallbacks[i]} client`}`, "w");
        await reextract(fallbacks[i]);
      }
    }
    setTarget(1);
    setPhase(3, "Ready");
    log(`✓ ${outs[0].name} (${fmtBytes(outs[0].blob.size)})`, "s");
    state.result = { files: outs.map((o) => ({ name: o.name, size: o.blob.size, url: URL.createObjectURL(o.blob) })), warns };
    setTimeout(() => go("done"), 650);
  } catch (e) {
    const cancelled = e.name === "AbortError";
    log(cancelled ? "✗ Cancelled" : `✗ ${e.message}`, "e");
    state.error = cancelled ? null : e.message;
    go(cancelled ? "confirm" : "error");
  } finally {
    state.ctrl = null;
  }
}

function saveFile(f) {
  const a = h("a", { href: f.url, download: f.name });
  document.body.append(a);
  a.click();
  a.remove();
}

function renderDone() {
  $("#steps").hidden = true;
  const [main, ...rest] = state.result.files;
  const ext = main.name.split(".").pop().toUpperCase();
  const svgNS = "http://www.w3.org/2000/svg";
  const check = document.createElementNS(svgNS, "svg");
  check.setAttribute("viewBox", "0 0 80 80");
  check.setAttribute("class", "check");
  const c = document.createElementNS(svgNS, "circle"); c.setAttribute("cx", "40"); c.setAttribute("cy", "40"); c.setAttribute("r", "34");
  const p = document.createElementNS(svgNS, "path"); p.setAttribute("d", "M26 41 l10 10 l19 -21");
  check.append(c, p);
  view(h("div", { class: "done" },
    check,
    h("div", { class: "fname" }, main.name),
    h("div", { class: "fmeta" }, h("span", {}, ext), h("span", {}, fmtBytes(main.size)), state.video?.duration ? h("span", {}, fmtDur(state.video.duration)) : null),
    rest.length ? h("div", { class: "extras" }, rest.map((f) => h("a", { href: f.url, download: f.name, onclick: (e) => { e.preventDefault(); saveFile(f); } }, fa("paperclip"), " ", f.name.split(".").slice(-2).join(".")))) : null,
    state.result.warns.length ? h("div", { class: "warn-note" }, fa("triangle-exclamation"), " ", state.result.warns.join(" · ")) : null),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", onclick: () => saveFile(main) }, fa("download"), "Download now"),
      h("button", { class: "btn ghost", title: "Download something else", onclick: () => go("type") }, fa("rotate-left"))));
}

function renderError() {
  $("#steps").hidden = true;
  const msg = (state.error || "Something went wrong").replace(/^ERROR: /, "");
  logEl = h("div", { class: "log", style: "margin-top:10px;height:150px" });
  logLines.slice(-120).forEach(([t, c]) => logEl.append(h("div", { class: c }, t)));
  const copyBtn = h("button", { class: "back", style: "margin:8px 0 0", onclick: async () => {
    const text = `ytdlp ${location.origin}${location.pathname} | ${navigator.userAgent}\nbridge: ${bridge.host}\n\n` + logLines.map(([t]) => t).join("\n");
    try { await navigator.clipboard.writeText(text); copyBtn.replaceChildren(fa("check"), " Copied"); }
    catch { copyBtn.replaceChildren(fa("xmark"), " Clipboard blocked"); }
  } }, fa("copy"), " Copy log");
  view(h("div", { class: "notice" }, fa("triangle-exclamation"), h("div", {}, h("b", {}, "Download failed"), h("code", { style: "white-space:pre-wrap" }, msg.split("\n").slice(0, 5).join("\n")))),
    logEl, copyBtn,
    h("div", { class: "actions" },
      h("button", { class: "btn ghost", onclick: () => go("confirm") }, fa("arrow-left"), "Back"),
      h("button", { class: "btn primary", onclick: start }, fa("rotate-right"), "Try again")));
}

// ------------------------------------------------------------------ boot
const qp = new URLSearchParams(location.search).get("url");
if (qp) setUrl(qp);
render();
window.addEventListener("beforeunload", (e) => { if (state.ctrl) { e.preventDefault(); e.returnValue = ""; } });
