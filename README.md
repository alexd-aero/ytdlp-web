# ytdlp.web

**The real yt-dlp, running entirely in your browser.** CPython 3.14 + yt-dlp + FFmpeg are compiled to WebAssembly, and the whole thing is a static site. You can host it on GitHub Pages, Cloudflare Pages, Netlify, or any file server. There is no backend, no relay and no browser extension.

## How it works

1. **Get the bookmark** from the landing page (`index.html`). It's a tiny loader.
2. **Tap it on any YouTube video.** The loader pulls `js/bridge-inject.js` from wherever this
   site is hosted (your GitHub Pages), so you can update the bridge any time without anyone
   re-saving their bookmark. If that load is ever blocked, the bookmark runs an inlined copy.
3. **The bridge floats the card** (`card.html`, an iframe) over the YouTube page as a dark glass
   card. On phones it docks as a bottom sheet in the same tab, so nothing is frozen in the background.
4. **The card asks:** Video or audio → quality (YouTube's real streams, max first) → extras
   (thumbnail, metadata, chapters, subtitles, SponsorBlock) → review → confirm.
5. **yt-dlp runs in the card** (CPython/WebAssembly). Every HTTP request is sent to the bridge,
   which performs it *as youtube.com*, the only origin YouTube's servers answer. FFmpeg.wasm
   then merges, converts and embeds, with a live log and progress bar.
6. **Download now** saves the finished file, which is already in memory, instantly.

```
 youtube.com tab
 ┌───────────────────────────────────────────────────────────────┐
 │ bridge-inject.js (runs as youtube.com)                         │
 │   fetch() YouTube API / googlevideo  ◄──── postMessage ────┐   │
 │                                                            │   │
 │   ┌──────────── floating card (iframe: card.html) ─────────┴┐  │
 │   │ yt-dlp (Pyodide) · ffmpeg.wasm · wizard UI              │  │
 │   └─────────────────────────────────────────────────────────┘  │
 └───────────────────────────────────────────────────────────────┘
```

On `m.youtube.com` the desktop watch page isn't readable cross-origin, so the bridge reads the
page's own visitor token and player ID (`ytcfg`) and yt-dlp uses its documented
`visitor_data` + `player_skip=webpage,configs` mode.

The bridge only accepts messages from the card's origin and its own frame, only fetches
YouTube/Google video hosts, and never sends cookies (`credentials: "omit"`).

## Features

| Step | What you choose |
|---|---|
| Type | Video or Audio |
| Quality | Video: every resolution YouTube offers (max first, with FPS/HDR/size/codec) in MP4, MKV or WebM. Audio: MP3 320–96 kbps, M4A (original or 256–128), Opus (original or 128–64), FLAC, WAV, with YouTube's source bitrate shown |
| Extras | Thumbnail (embedded cover art), square cover, metadata, chapters, English subtitles, SponsorBlock skipping |
| Confirm | Summary plus estimated size, then a live engine log, progress bar, speed and ETA, then **Download now** |

The format selection, sorting, output templates and YouTube extraction are yt-dlp's own code, not a reimplementation. YouTube's JS challenges are solved by yt-dlp's official EJS solver, executed by the browser's JS engine through a custom challenge provider (`BrowserJCP`).

## Deploy (GitHub Pages)

1. Push this folder to a repo (it contains `index.html` at the root).
2. Repo → Settings → Pages → *Deploy from a branch* → `main` / root.
3. Open `https://<you>.github.io/<repo>/` and follow the steps for your platform.
   The bookmark points at that URL, so get it from the deployed page (not from localhost).

Any static host works. No special headers are required: the single-threaded FFmpeg core is used on purpose, since cross-origin isolation (COOP/COEP) would cut the window link to the bridge tab.

**Don't deploy `tools/`.** It's a local development helper (see below). Deleting it is fine.

## Requirements

* A browser with WebAssembly **JSPI** (lets synchronous Python wait on async fetches): current Chrome, Edge or Opera, and recent Firefox.
* Desktop is recommended. Bookmarklets work on Android Chrome (type the bookmark's name into the address bar and tap it) but are awkward on iOS.
* Files are assembled in memory: practical limit ≈ 1.5–2 GB per output.

## Known limits

* **FFmpeg.wasm 0.12 quirks:** its `libopus` encoder crashes, so the native Opus encoder is used. It cannot decode AV1, so AV1 is automatically avoided whenever re-encoding is needed (precise cuts, H.264 recode). Re-encoding video is CPU-heavy in WASM; stream-copy paths are fast.
* Cover art can't be embedded in WAV, WebM or MOV (it's saved as a file instead, like yt-dlp).
* Age-restricted, members-only and other login-gated videos aren't supported (the bridge deliberately sends no cookies).
* Encrypted HLS / DRM streams aren't supported (yt-dlp doesn't support DRM either).
* Sites other than YouTube would each need the bridge running on *their* origin; the allowlist is YouTube-only for now.

## Project layout

```
index.html            landing page: get the bookmark (per-platform steps)
card.html             the floating card (wizard + engine)
css/app.css           landing styles
css/card.css          card styles (dark glass, glowing border)
js/app.js             landing logic (builds the bookmark)
js/card.js            card wizard: type → quality → extras → confirm → progress → download
js/bridge-inject.js   runs on youtube.com: floats the card, performs fetches
js/bridge.js          bookmark loader builder + card-side bridge client
js/engine.js          main-thread handle on the yt-dlp worker
js/engine-worker.js   Pyodide worker: installs yt-dlp, routes network to the bridge
py/webytdlp.py        BridgeRH (yt-dlp RequestHandler), BrowserJCP (challenge solver), probe/select API
js/download.js        chunked, parallel, retrying downloader (https, DASH fragments, HLS)
js/pipeline.js        merge → cut → convert/embed with ffmpeg.wasm
js/options.js         option model → yt-dlp format spec / sort
vendor/py/            yt-dlp + yt-dlp-ejs wheels
vendor/ffmpeg/        ffmpeg.wasm 0.12 (single-thread core)
tools/devserver.py    DEV ONLY: local server + stand-in bridge for automated testing
```

Pyodide 314.0.8 is loaded from the jsDelivr CDN.

### Local development

```
python tools/devserver.py 8765
```

* `http://localhost:8765/` is the landing page.
* `http://localhost:8765/card.html?devproxy&url=<youtube link>` runs the card with the dev server as a stand-in for the bridge. It's **only** honored on localhost and exists so the pipeline can be tested in headless or embedded browsers that can't click a bookmarklet. The production site never uses it.

## Legal

Only download content you have the right to download. Respect creators and YouTube's Terms of Service.
yt-dlp is released under the Unlicense, Pyodide under MPL-2.0, and FFmpeg/ffmpeg.wasm under LGPL/GPL (the bundled core includes GPL components such as x264).
