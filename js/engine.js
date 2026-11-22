// Main-thread handle on the yt-dlp worker. Routes the worker's network calls
// through the bridge and exposes probe()/select() as promises.
export class Engine extends EventTarget {
  constructor(bridge) {
    super();
    this.bridge = bridge;
    this.ready = false;
    this.info = null;
    this.seq = 0;
    this.calls = new Map();
    // Single-file build: worker source and Python payload are inlined in the page.
    const single = globalThis.__YTDLP_SINGLE__;
    const workerURL = single ? single.blobURL("engineWorker") : new URL("./engine-worker.js", import.meta.url);
    this.worker = new Worker(workerURL, { type: "module" });
    this.worker.onmessage = (ev) => this.#onMessage(ev.data);
    this.worker.onerror = (ev) => this.#emit("fatal", { error: ev.message || "Worker failed to start" });
    this.readyPromise = new Promise((res, rej) => { this._ready = res; this._fail = rej; });
    this.worker.postMessage({ t: "init", bundle: single ? { glue: single.glue, wheels: single.wheels } : undefined });
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async #onMessage(m) {
    switch (m.t) {
      case "status": this.#emit("status", m); break;
      case "log": this.#emit("log", m); break;
      case "ready":
        this.ready = true;
        this.info = m;
        this.#emit("ready", m);
        this._ready(m);
        break;
      case "fatal":
        this.#emit("fatal", m);
        this._fail(new Error(m.error));
        break;
      case "result": {
        const c = this.calls.get(m.id);
        if (!c) return;
        this.calls.delete(m.id);
        m.error ? c.reject(new Error(m.error)) : c.resolve(m.value);
        break;
      }
      case "net": {
        const res = await this.bridge.fetch(m.req);
        const transfer = res.buf ? [res.buf] : [];
        this.#emit("net", { url: m.req.url, status: res.status, error: res.error });
        this.worker.postMessage({ t: "netres", id: m.id, res }, transfer);
        break;
      }
    }
  }

  // Python calls are serialized: one yt-dlp operation at a time.
  #call(fn, ...args) {
    const run = async () => {
      await this.readyPromise;
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.calls.set(id, { resolve, reject });
        this.worker.postMessage({ t: "call", id, fn, args });
      });
    };
    const p = (this.chain || Promise.resolve()).then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  probe(url, opts = {}) { return this.#call("probe", url, JSON.stringify(opts)); }
  select(key, opts = {}) { return this.#call("select", key, JSON.stringify(opts)); }
}
