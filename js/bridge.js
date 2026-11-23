// The bridge: a tiny script that runs *as youtube.com* (via a bookmarklet) and
// performs fetches on behalf of the app. Requests made from a youtube.com page
// are same-origin for YouTube's API and CORS-approved by googlevideo.com, so the
// browser lets them through. No server, no relay, no extension.

export const BRIDGE_VERSION = 1;
export const BRIDGE_ORIGINS = /^https:\/\/(?:www|m|music)\.youtube\.com$/;

// ---------------------------------------------------------------------------
// Bookmark: a tiny loader that pulls js/bridge-inject.js from wherever this site
// is hosted (e.g. your GitHub Pages), so the bridge can be updated without anyone
// re-saving the bookmark. If loading is ever blocked, it runs an inlined copy.
// ---------------------------------------------------------------------------
export async function bookmarkletFor(cardUrl) {
  const injectUrl = new URL("js/bridge-inject.js", cardUrl).href;
  const inline = await (await fetch(injectUrl)).text();
  // Strip whole-line comments only (never touch "//" inside strings), then collapse whitespace.
  const fallback = inline.replace(/^\s*\/\/.*$/gm, "").replace(/\s*\n\s*/g, "\n").trim();
  // YouTube's CSP blocks <script src> from other origins, but allows fetch + eval (it lists
  // 'unsafe-eval'; a Trusted Types policy satisfies require-trusted-types-for). So the loader
  // fetches the latest bridge from this site and runs it; on any failure it runs the inlined copy.
  const loader = `(function(){var A=${JSON.stringify(cardUrl)};window.__ytdlpAppUrl=A;` +
    `if(window.__ytdlpWeb&&window.__ytdlpWeb.app===A){window.__ytdlpWeb.open();return;}` +
    `function F(){${fallback}}` +
    `var P;try{P=window.trustedTypes&&trustedTypes.createPolicy("ytdlp-loader-"+Date.now(),{createScript:function(x){return x;}});}catch(e){}` +
    `fetch(${JSON.stringify(injectUrl)}+"?v="+Date.now(),{cache:"no-store",credentials:"omit"}).then(function(r){if(!r.ok)throw 0;return r.text();})` +
    `.then(function(t){(0,eval)(P?P.createScript(t):t);if(!window.__ytdlpWeb)F();}).catch(function(){if(!window.__ytdlpWeb)F();});})()`;
  return "javascript:" + encodeURIComponent(`void ${loader}`);
}

// ---------------------------------------------------------------------------
// App side
// ---------------------------------------------------------------------------
export class Bridge extends EventTarget {
  constructor() {
    super();
    this.win = null;
    this.origin = null;
    this.host = null;
    this.seq = 0;
    this.pending = new Map();
    this.lastHello = 0;
    // DEV ONLY: on localhost with ?devproxy, use tools/devserver.py instead of a real bridge tab.
    // The production single-file build compiles this out entirely (__YTDLP_DEV__ = false).
    const devAllowed = typeof __YTDLP_DEV__ === "undefined" || __YTDLP_DEV__;
    this.dev = devAllowed && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && new URLSearchParams(location.search).has("devproxy");
    if (this.dev) {
      this.host = "devproxy (localhost)";
      queueMicrotask(() => this.dispatchEvent(new CustomEvent("status", { detail: { connected: true, host: this.host } })));
    }
    window.addEventListener("message", (ev) => this.#onMessage(ev));
    setInterval(() => this.#watch(), 1500);
  }

  get connected() {
    if (this.dev) return true;
    return !!this.win && Date.now() - this.lastHello < 5000;
  }

  async #devFetch(req) {
    let body = null;
    if (req.body) {
      const u8 = new Uint8Array(req.body);
      let s = "";
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      body = btoa(s);
    }
    try {
      const r = await fetch("/__devproxy", { method: "POST", body: JSON.stringify({ ...req, body }) });
      const meta = JSON.parse(atob(r.headers.get("X-Proxy-Meta")));
      if (meta.error) return { error: meta.error };
      return { ...meta, buf: await r.arrayBuffer() };
    } catch (e) {
      return { error: String(e) };
    }
  }

  get inOverlay() {
    return window.parent !== window && this.win === window.parent;
  }

  #onMessage(ev) {
    const d = ev.data;
    if (!d || d.__ytdlp !== BRIDGE_VERSION) return;
    if (!BRIDGE_ORIGINS.test(ev.origin)) return;
    if (d.t === "hello") {
      const wasConnected = this.connected;
      this.win = ev.source;
      this.origin = ev.origin;
      this.host = d.host;
      const prevPage = this.page;
      this.page = typeof d.page === "string" ? d.page : null;
      // Read from the YouTube page itself: lets yt-dlp skip the watch page (needed on m.youtube.com).
      this.visitorData = typeof d.vd === "string" ? d.vd : null;
      this.playerId = typeof d.pid === "string" && /^[0-9a-fA-F]{8}$/.test(d.pid) ? d.pid : null;
      this.via = typeof d.via === "string" ? d.via : "bookmark";
      this.lastHello = Date.now();
      ev.source.postMessage({ __ytdlp: BRIDGE_VERSION, t: "ack" }, ev.origin);
      if (!wasConnected) this.dispatchEvent(new CustomEvent("status", { detail: { connected: true, host: d.host, page: this.page } }));
      else if (prevPage !== this.page) this.dispatchEvent(new CustomEvent("page", { detail: { page: this.page } }));
    } else if (d.t === "res" && ev.source === this.win) {
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      clearTimeout(p.timer);
      p.resolve(d);
    }
  }

  #watch() {
    const alive = this.connected;
    if (this._wasAlive && !alive) {
      this.dispatchEvent(new CustomEvent("status", { detail: { connected: false } }));
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ id, error: "Bridge tab disconnected (was the YouTube tab closed or reloaded?)" });
      }
      this.pending.clear();
    }
    this._wasAlive = alive;
  }

  get mobileSite() { return /^m\./.test(this.host || ""); }

  // Frame-control messages (close / move / size) carry no data, so they may go to the
  // parent before the bridge handshake completes; the bridge only accepts them from its own frame.
  #toParent(msg) {
    if (window.parent === window) return;
    window.parent.postMessage({ __ytdlp: BRIDGE_VERSION, ...msg }, this.inOverlay ? this.origin : "*");
  }

  closeOverlay() { this.#toParent({ t: "close-overlay" }); }

  /** Drag the floating card by (dx, dy) screen pixels. */
  moveBy(dx, dy) { if (dx || dy) this.#toParent({ t: "move", dx, dy }); }

  /** Tell the floating card frame how tall our content is. */
  reportSize(h) { this.#toParent({ t: "size", h: Math.ceil(h) }); }

  /** Low-level fetch through the bridge. Resolves to {status, statusText, url, headers, buf} or {error}. */
  fetch(req, { timeout = 90000 } = {}) {
    if (this.dev) return this.#devFetch(req);
    // m.youtube.com can't read www.youtube.com/iframe_api (no CORS for it). yt-dlp only
    // needs the player ID from it, which the bridge read from the page's own ytcfg.
    if (this.mobileSite && this.playerId && /^https:\/\/www\.youtube\.com\/iframe_api/.test(req.url)) {
      const body = `var scriptUrl = 'https:\/\/www.youtube.com\/s\/player\/${this.playerId}\/www-widgetapi.vflset\/www-widgetapi.js';`;
      const buf = new TextEncoder().encode(body).buffer;
      return Promise.resolve({ status: 200, statusText: "OK", url: req.url, headers: [["content-type", "text/javascript"]], buf });
    }
    if (!this.connected) {
      return Promise.resolve({ error: "Not connected to the YouTube bridge. Open youtube.com and click the ytdlp.web bookmark." });
    }
    const id = ++this.seq;
    const msg = { __ytdlp: BRIDGE_VERSION, t: "fetch", id, ...req };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: `Bridge request timed out after ${timeout / 1000}s` });
      }, timeout);
      this.pending.set(id, { resolve, timer });
      this.win.postMessage(msg, this.origin, req.body ? [req.body] : []);
    });
  }
}
