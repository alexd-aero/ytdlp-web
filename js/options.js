// Option model: every knob in the UI, and how it maps onto real yt-dlp
// parameters (format spec, format sort, output template) and post-processing.

export const DEFAULTS = {
  mode: "av",                 // av | audio | video
  quality: "best",            // best | 4320 | 2160 | 1440 | 1080 | 720 | 480 | 360 | 240 | 144 | worst
  fps: "any",                 // any | 60 | 30
  vcodec: "any",              // any | avc1 | vp9 | av01
  hdr: false,
  container: "mp4",           // mp4 | mkv | webm | mov
  recode: "none",             // none | h264
  audioLang: "",              // preferred audio track language (e.g. "en")

  audioFormat: "mp3",         // best | mp3 | m4a | opus | ogg | flac | wav | alac
  audioBitrateMode: "cbr",    // cbr | vbr
  audioBitrate: "320",        // kbps for cbr
  audioVbr: "0",              // 0 (best) … 9 (worst) yt-dlp style
  sampleRate: "source",       // source | 44100 | 48000 | 96000
  channels: "source",         // source | 2 | 1
  normalize: false,           // EBU R128 loudnorm

  thumbnail: "embed",         // none | embed | file | both
  thumbSquare: false,
  thumbFormat: "jpg",         // jpg | png | webp (for saved file)
  metadata: true,
  chapters: true,
  subs: "none",               // none | embed | file | both
  subLangs: "en.*",
  autoSubs: true,
  subFormat: "srt",           // srt | vtt | ass (for saved files)

  sponsorblock: "off",        // off | mark | remove
  sbCategories: ["sponsor", "selfpromo", "interaction"],

  trimStart: "",
  trimEnd: "",
  preciseCuts: false,         // re-encode video so cuts land exactly (yt-dlp --force-keyframes-at-cuts)

  outtmpl: "%(title)s [%(id)s].%(ext)s",
  restrictFilenames: false,
  formatOverride: "",
  formatSort: "",
  playerClient: "",
  playlist: false,
  verbose: false,
};

export const AUDIO_FORMATS = {
  best: { label: "Original (no re-encode)", ext: null },
  mp3: { label: "MP3", ext: "mp3", codec: "libmp3lame", lossy: true },
  m4a: { label: "AAC (M4A)", ext: "m4a", codec: "aac", lossy: true },
  opus: { label: "Opus", ext: "opus", codec: "opus", lossy: true },  // native encoder: libopus crashes in ffmpeg.wasm 0.12
  ogg: { label: "Vorbis (OGG)", ext: "ogg", codec: "libvorbis", lossy: true },
  flac: { label: "FLAC (lossless)", ext: "flac", codec: "flac", lossy: false },
  alac: { label: "ALAC (lossless M4A)", ext: "m4a", codec: "alac", lossy: false },
  wav: { label: "WAV (PCM)", ext: "wav", codec: "pcm_s16le", lossy: false },
};

export const SB_CATEGORIES = {
  sponsor: "Sponsor", selfpromo: "Self-promo", interaction: "Interaction reminder",
  intro: "Intro", outro: "Outro / endcards", preview: "Preview / recap",
  music_offtopic: "Non-music section", filler: "Filler / tangent",
};

const STORE_KEY = "ytdlp-web.options.v1";

export function loadOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    for (const k of PER_VIDEO_KEYS) delete saved[k];
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

// Per-video settings: never remembered between visits.
export const PER_VIDEO_KEYS = ["trimStart", "trimEnd", "formatOverride"];

export function saveOptions(o) {
  const keep = { ...o };
  for (const k of PER_VIDEO_KEYS) delete keep[k];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(keep)); } catch {}
}

/** Build the params passed to webytdlp.select(). */
export function toYtdlp(o) {
  const sort = [];
  let format;
  const lang = o.audioLang ? `[language^=${o.audioLang}]` : "";

  if (o.formatOverride.trim()) {
    format = o.formatOverride.trim();
  } else if (o.mode === "audio") {
    format = lang ? `ba${lang}/ba/b` : "ba/b";
    if (o.audioFormat === "m4a" || o.audioFormat === "alac") sort.push("acodec:aac");
    if (o.audioFormat === "opus" || o.audioFormat === "best") sort.push("acodec:opus");
  } else {
    const worst = o.quality === "worst";
    // ffmpeg.wasm can copy AV1 but can't decode it, so avoid AV1 when we must re-encode.
    // MOV only holds H.264/HEVC-style codecs, so never pick AV1/VP9 for it.
    const nav1 = o.container === "mov" ? "[vcodec!^=av01][vcodec!^=vp]" : needsVideoDecode(o) ? "[vcodec!^=av01]" : "";
    const v = o.mode === "video" ? (worst ? `wv${nav1}/w` : `bv${nav1}/b`) : null;
    format = v || (worst ? `wv*${nav1}+wa/w` : lang ? `bv*${nav1}+ba${lang}/bv*${nav1}+ba/b` : `bv*${nav1}+ba/b`);
    if (!worst && o.quality !== "best") sort.push(`res:${o.quality}`);
    if (o.fps !== "any") sort.push(`fps:${o.fps}`);
    if (!o.hdr) sort.push("hdr:sdr");
    if (o.vcodec !== "any") sort.push(`vcodec:${o.vcodec}`);
    if (o.container === "webm") sort.push("vext:webm", "aext:webm");
    else if (o.container === "mp4" || o.container === "mov") {
      if (o.vcodec === "any") sort.push("vext:mp4");
      sort.push("aext:m4a");
    }
  }
  if (o.formatSort.trim()) sort.unshift(...o.formatSort.split(",").map((s) => s.trim()).filter(Boolean));

  const subtitleslangs = o.subs !== "none" ? o.subLangs.split(",").map((s) => s.trim()).filter(Boolean) : null;
  return {
    format,
    format_sort: sort.length ? sort : null,
    merge_output_format: o.mode === "audio" ? null : o.container,
    outtmpl: o.outtmpl,
    restrictfilenames: o.restrictFilenames,
    subtitleslangs,
    autosubs: o.autoSubs,
    player_client: o.playerClient,
    playlist: o.playlist,
    verbose: o.verbose,
  };
}

export function needsVideoDecode(o) {
  return o.mode !== "audio" && (o.recode === "h264" || (o.preciseCuts && (o.trimStart || o.trimEnd || o.sponsorblock === "remove")));
}

export function parseTime(s) {
  if (!s || !String(s).trim()) return null;
  const parts = String(s).trim().split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Final output extension for a job. */
export function outputExt(o, sel) {
  if (o.mode === "audio") {
    const af = AUDIO_FORMATS[o.audioFormat];
    if (af.ext) return af.ext;
    const a = sel.formats[0];
    const ac = (a.acodec || "").toLowerCase();
    if (ac.startsWith("opus")) return "opus";
    if (ac.startsWith("mp4a")) return "m4a";
    if (ac.startsWith("vorbis")) return "ogg";
    if (ac.startsWith("mp3")) return "mp3";
    if (ac.startsWith("flac")) return "flac";
    const e = a.audio_ext && a.audio_ext !== "none" ? a.audio_ext : a.ext;
    return e === "mp4" ? "m4a" : e;
  }
  return o.container;
}
