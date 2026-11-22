// Downloads a yt-dlp "requested format" through the bridge.
// Supports: progressive/DASH https (chunked, parallel, resumable per chunk),
// fragmented DASH (fragments list) and plain HLS (m3u8 / m3u8_native).

// googlevideo intermittently refuses large ranges requested from a browser (seen live: 1 MB
// requests kept working while 4 MB+ were refused). Request small pieces in parallel like
// YouTube's own player does.
const CHUNK_GV = 1024 * 1024;
const PARALLEL_GV = 6;
const CHUNK = 10 * 1024 * 1024;     // other hosts
const PARALLEL = 3;
const RETRIES = 4;
const REQUEST_TIMEOUT = 60000;

// Optional hook so the UI can show retries instead of looking frozen.
let retryLogger = null;
export function setRetryLogger(fn) { retryLogger = fn; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isGoogleVideo = (u) => /^https:\/\/[^/]+\.googlevideo\.com\//.test(u);

function cleanHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const l = k.toLowerCase();
    if (["user-agent", "referer", "origin", "cookie", "accept-encoding", "sec-fetch-mode", "accept-language", "accept"].includes(l)) continue;
    out[k] = v;
  }
  return out;
}

async function fetchRetry(bridge, req, signal, label) {
  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const res = await bridge.fetch(req, { timeout: REQUEST_TIMEOUT });
    if (!res.error && res.status >= 200 && res.status < 300) return res;
    lastErr = res.error || `HTTP ${res.status} ${res.statusText || ""}`.trim();
    // 403 on googlevideo usually means the URL expired, is bound to another IP, or needs a PO token:
    // one retry, then give up so the caller can re-extract fresh links.
    const giveUp = (res.status === 403 && attempt >= 1) || res.status === 404 || res.status === 410 || attempt === RETRIES - 1;
    if (retryLogger) retryLogger(`${label}: ${lastErr}${giveUp ? "" : `, retrying (${attempt + 2}/${RETRIES})`}`);
    if (giveUp) break;
    await sleep(800 * 2 ** attempt);
  }
  throw new Error(`${label}: ${lastErr}`);
}

function totalSizeOf(fmt) {
  if (fmt.filesize) return fmt.filesize;
  try {
    const clen = new URL(fmt.url).searchParams.get("clen");
    if (clen) return Number(clen);
  } catch {}
  return null;
}

/** Ranged download of one URL. Returns an array of ArrayBuffers in order. */
async function downloadRanged(bridge, fmt, { onBytes, signal }) {
  const url = fmt.url;
  const gv = isGoogleVideo(url);
  const headers = gv ? {} : cleanHeaders(fmt.http_headers);
  const total = totalSizeOf(fmt);

  const getRange = async (start, end) => {
    const req = gv
      ? { url: `${url}&range=${start}-${end}`, method: "GET", headers }
      : { url, method: "GET", headers: { ...headers, Range: `bytes=${start}-${end}` } };
    const res = await fetchRetry(bridge, req, signal, `bytes ${start}-${end}`);
    return res;
  };

  if (total) {
    const ranges = [];
    const chunk = gv ? CHUNK_GV : CHUNK;
    for (let s = 0; s < total; s += chunk) ranges.push([s, Math.min(s + chunk, total) - 1]);
    const parts = new Array(ranges.length);
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        const i = next++;
        const [s, e] = ranges[i];
        const res = await getRange(s, e);
        if (res.status === 200 && !gv && res.buf.byteLength >= total) {
          // Server ignored Range and sent the whole file.
          parts.length = 0;
          parts.push(res.buf);
          next = ranges.length;
          onBytes(res.buf.byteLength, total);
          return;
        }
        parts[i] = res.buf;
        onBytes(res.buf.byteLength, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(gv ? PARALLEL_GV : PARALLEL, ranges.length) }, worker));
    return parts.filter(Boolean);
  }

  // Unknown size: walk forward until a short chunk.
  const parts = [];
  let start = 0;
  for (;;) {
    const chunk = gv ? CHUNK_GV : CHUNK;
    const res = await getRange(start, start + chunk - 1);
    parts.push(res.buf);
    onBytes(res.buf.byteLength, null);
    if (res.buf.byteLength < chunk || (!gv && res.status === 200)) break;
    start += res.buf.byteLength;
  }
  return parts;
}

async function downloadFragments(bridge, fmt, { onBytes, signal }) {
  const base = fmt.fragment_base_url || "";
  const urls = fmt.fragments.map((f) => f.url || new URL(f.path, base).href);
  const parts = new Array(urls.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const res = await fetchRetry(bridge, { url: urls[i], method: "GET", headers: cleanHeaders(fmt.http_headers) }, signal, `fragment ${i + 1}/${urls.length}`);
      parts[i] = res.buf;
      done++;
      onBytes(res.buf.byteLength, null, done / urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, urls.length) }, worker));
  return parts;
}

async function downloadHls(bridge, fmt, { onBytes, signal }) {
  const res = await fetchRetry(bridge, { url: fmt.url, method: "GET", headers: cleanHeaders(fmt.http_headers) }, signal, "HLS playlist");
  const text = new TextDecoder().decode(res.buf);
  const base = res.url || fmt.url;
  if (/#EXT-X-STREAM-INF/.test(text)) throw new Error("Got an HLS master playlist where a media playlist was expected");
  if (/#EXT-X-KEY:(?!.*METHOD=NONE)/.test(text)) throw new Error("Encrypted HLS streams are not supported");
  const segs = [];
  for (const line of text.split(/\r?\n/)) {
    const map = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/);
    if (map) segs.push(new URL(map[1], base).href);
    else if (line && !line.startsWith("#")) segs.push(new URL(line.trim(), base).href);
  }
  return downloadFragments(bridge, { ...fmt, fragments: segs.map((url) => ({ url })) }, { onBytes, signal });
}

/**
 * Download a format. onProgress({ loaded, total, fraction }).
 * Returns a Uint8Array with the complete file.
 */
export async function downloadFormat(bridge, fmt, { onProgress = () => {}, signal } = {}) {
  let loaded = 0;
  const t0 = performance.now();
  const onBytes = (n, total, frac) => {
    loaded += n;
    const secs = (performance.now() - t0) / 1000;
    onProgress({ loaded, total, fraction: frac ?? (total ? loaded / total : null), speed: loaded / Math.max(secs, 0.001) });
  };
  let parts;
  const proto = fmt.protocol || "https";
  if (proto.startsWith("m3u8")) parts = await downloadHls(bridge, fmt, { onBytes, signal });
  else if (fmt.fragments?.length) parts = await downloadFragments(bridge, fmt, { onBytes, signal });
  else if (proto === "https" || proto === "http") parts = await downloadRanged(bridge, fmt, { onBytes, signal });
  else throw new Error(`Protocol "${proto}" is not supported in the browser yet`);
  const blob = new Blob(parts);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Small one-shot fetch (thumbnails, subtitles, playlists). */
export async function fetchSmall(bridge, url, signal) {
  const res = await fetchRetry(bridge, { url, method: "GET", headers: {} }, signal, url.split("?")[0]);
  return res;
}
