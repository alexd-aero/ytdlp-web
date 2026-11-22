// Runs the real yt-dlp (CPython via Pyodide/WebAssembly) off the main thread.
// Network I/O is proxied to the main thread, which forwards it to the bridge tab.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.8/full/pyodide.mjs";

const WHEELS = ["yt_dlp-2026.10.26-py3-none-any.whl", "yt_dlp_ejs-0.8.0-py3-none-any.whl"];

let py = null;
let api = null;
let seq = 0;
const pendingNet = new Map();

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const status = (phase, detail) => post({ t: "status", phase, detail });

// ---- functions called *from Python* -------------------------------------
self.ytLog = (level, msg) => post({ t: "log", level, msg: String(msg) });

self.bridgeFetch = (req) => {
  const id = ++seq;
  const plain = {
    url: req.url,
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers || {})),
  };
  const transfer = [];
  if (req.body) {
    const body = req.body instanceof Uint8Array ? req.body.slice().buffer : req.body;
    plain.body = body;
    transfer.push(body);
  }
  return new Promise((resolve) => {
    pendingNet.set(id, resolve);
    post({ t: "net", id, req: plain }, transfer);
  });
};

// yt-dlp's EJS challenge solver writes its answer with console.log.
self.runJsChallenge = (code) => {
  const out = [];
  const sandboxConsole = {
    log: (...a) => out.push(a.map(String).join(" ")),
    info() {}, warn() {}, error() {}, debug() {},
  };
  // eslint-disable-next-line no-new-func
  new Function("console", code)(sandboxConsole);
  return out.join("\n");
};

// ---- boot ------------------------------------------------------------------
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// `bundle` is provided by the single-file build (inlined wheels + glue); otherwise load from ../vendor.
async function init(bundle) {
  const jspi = typeof WebAssembly.Suspending === "function" || typeof WebAssembly.Function === "function";
  status("python", "Loading CPython (WebAssembly)…");
  py = await loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/v314.0.8/full/",
    stdout: (s) => post({ t: "log", level: "debug", msg: s }),
    stderr: (s) => post({ t: "log", level: "warning", msg: s }),
  });
  status("wheels", "Installing yt-dlp…");
  if (bundle) {
    for (const b64 of Object.values(bundle.wheels)) py.unpackArchive(b64ToBytes(b64).buffer, "wheel");
  } else {
    for (const w of WHEELS) {
      const buf = await (await fetch(new URL(`../vendor/py/${w}`, import.meta.url))).arrayBuffer();
      py.unpackArchive(buf, "wheel");
    }
  }
  const glue = bundle ? bundle.glue : await (await fetch(new URL("../py/webytdlp.py", import.meta.url))).text();
  py.FS.mkdirTree("/home/pyodide/app");
  py.FS.writeFile("/home/pyodide/app/webytdlp.py", glue);
  status("import", "Importing yt-dlp…");
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide/app')");
  api = py.pyimport("webytdlp");
  const version = api.version();
  const pyVersion = py.runPython("import sys; sys.version.split()[0]");
  post({ t: "ready", version, pyVersion, jspi });
}

async function call(fn, args) {
  const f = api[fn];
  // callPromising enables stack switching so Python can run_sync() on fetches.
  const out = await f.callPromising(...args);
  return typeof out === "string" ? JSON.parse(out) : out;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.t === "init") await init(m.bundle);
    else if (m.t === "netres") {
      const resolve = pendingNet.get(m.id);
      pendingNet.delete(m.id);
      resolve && resolve(m.res);
    } else if (m.t === "call") {
      try {
        post({ t: "result", id: m.id, value: await call(m.fn, m.args) });
      } catch (e) {
        post({ t: "result", id: m.id, error: String(e && e.message || e) });
      }
    }
  } catch (e) {
    post({ t: "fatal", error: String(e && e.stack || e) });
  }
};
