// Thin wrapper around ffmpeg.wasm (single-threaded core: no SharedArrayBuffer /
// cross-origin isolation needed, which keeps the bridge's window link intact).
import { FFmpeg } from "../vendor/ffmpeg/index.js";

let instance = null;
let loading = null;
const listeners = { log: new Set(), progress: new Set() };

export async function getFFmpeg() {
  if (instance) return instance;
  if (!loading) {
    loading = (async () => {
      const ff = new FFmpeg();
      ff.on("log", (e) => listeners.log.forEach((fn) => fn(e.message)));
      ff.on("progress", (e) => listeners.progress.forEach((fn) => fn(e)));
      const single = globalThis.__YTDLP_SINGLE__;
      if (single) {
        // Single-file build: inlined ffmpeg.wasm worker, core from the jsDelivr CDN.
        const cdn = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/";
        await ff.load({ classWorkerURL: single.blobURL("ffWorker"), coreURL: cdn + "ffmpeg-core.js", wasmURL: cdn + "ffmpeg-core.wasm" });
      } else {
        const base = new URL("../vendor/ffmpeg/core/", import.meta.url).href;
        await ff.load({ coreURL: base + "ffmpeg-core.js", wasmURL: base + "ffmpeg-core.wasm" });
      }
      instance = ff;
      return ff;
    })();
  }
  return loading;
}

/** Run ffmpeg; returns { code, log }. */
export async function run(args, { onLog, onProgress } = {}) {
  const ff = await getFFmpeg();
  const log = [];
  const l = (m) => { log.push(m); onLog && onLog(m); };
  const p = (e) => onProgress && onProgress(e);
  listeners.log.add(l);
  listeners.progress.add(p);
  try {
    const code = await ff.exec(args);
    return { code, log };
  } catch (e) {
    // A WASM trap (e.g. "memory access out of bounds") leaves the instance unusable:
    // throw it away so the next job gets a fresh ffmpeg.
    try { ff.terminate(); } catch {}
    instance = null;
    loading = null;
    throw e instanceof Error ? e : new Error(`ffmpeg.wasm crashed: ${String(e)}`);
  } finally {
    listeners.log.delete(l);
    listeners.progress.delete(p);
  }
}

export async function writeFile(name, data) { return (await getFFmpeg()).writeFile(name, data); }
export async function readFile(name) { return (await getFFmpeg()).readFile(name); }
export async function rm(...names) {
  const ff = await getFFmpeg();
  for (const n of names) { try { await ff.deleteFile(n); } catch {} }
}
