// One download job, end to end:
// yt-dlp format selection -> bridge download -> thumbnails/subs/SponsorBlock
// -> ffmpeg.wasm merge/convert/embed -> file(s) ready to save.
import { downloadFormat, fetchSmall } from "./download.js";
import * as FF from "./ffmpeg.js";
import { AUDIO_FORMATS, outputExt, parseTime, toYtdlp, SB_CATEGORIES } from "./options.js";

const VBR_KBPS = [256, 224, 192, 160, 128, 112, 96, 80, 64, 48];

// ---------------------------------------------------------------- helpers
// yt-dlp leaves acodec/vcodec undefined when unknown (e.g. HLS); "none" means absent.
export const hasVideo = (f) => !!f.vcodec && f.vcodec !== "none";
export const hasAudio = (f) => (f.acodec ? f.acodec !== "none" : !hasVideo(f));

function setExt(name, ext) {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, "") + "." + ext;
}

async function toImage(bytes, { square, type = "image/jpeg" }) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; }
  const c = new OffscreenCanvas(sw, sh);
  c.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await c.convertToBlob({ type, quality: 0.95 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: sw, height: sh, mime: type };
}

// FLAC METADATA_BLOCK_PICTURE (used to embed covers in Opus/Vorbis files).
function flacPictureBlock(jpeg, w, h, mime = "image/jpeg") {
  const enc = new TextEncoder();
  const m = enc.encode(mime), d = enc.encode("Cover (front)");
  const buf = new Uint8Array(32 + m.length + d.length + jpeg.length);
  const dv = new DataView(buf.buffer);
  let o = 0;
  const u32 = (v) => { dv.setUint32(o, v); o += 4; };
  u32(3); u32(m.length); buf.set(m, o); o += m.length;
  u32(d.length); buf.set(d, o); o += d.length;
  u32(w); u32(h); u32(24); u32(0); u32(jpeg.length); buf.set(jpeg, o);
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

function keepSegments(duration, trimStart, trimEnd, remove) {
  let keep = [[trimStart ?? 0, trimEnd ?? duration]];
  for (const [rs, re] of remove) {
    const next = [];
    for (const [s, e] of keep) {
      if (re <= s || rs >= e) { next.push([s, e]); continue; }
      if (rs > s) next.push([s, rs]);
      if (re < e) next.push([re, e]);
    }
    keep = next;
  }
  return keep.filter(([s, e]) => e - s > 0.05);
}

// Map a source timestamp to the output timeline after cutting.
function remapTime(t, keep) {
  let acc = 0;
  for (const [s, e] of keep) {
    if (t < s) return acc;
    if (t <= e) return acc + (t - s);
    acc += e - s;
  }
  return acc;
}

function buildChapters({ chapters, duration, sb, sbMode, keep }) {
  let list = (chapters || []).map((c) => ({ start: c.start_time, end: c.end_time, title: c.title || "" }));
  if (list.every((c) => !c.title.trim())) list = [];
  if (sbMode === "mark" && sb.length) {
    const bounds = new Set([0, duration]);
    list.forEach((c) => { bounds.add(c.start); bounds.add(c.end); });
    sb.forEach((s) => { bounds.add(s.segment[0]); bounds.add(s.segment[1]); });
    const pts = [...bounds].filter((x) => x >= 0 && x <= duration).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [s, e] = [pts[i], pts[i + 1]];
      if (e - s < 0.05) continue;
      const mid = (s + e) / 2;
      const hit = sb.find((x) => mid >= x.segment[0] && mid <= x.segment[1]);
      const ch = list.find((c) => mid >= c.start && mid <= c.end);
      const title = hit ? `[SponsorBlock]: ${SB_CATEGORIES[hit.category] || hit.category}` : (ch?.title || "");
      const prev = out[out.length - 1];
      if (prev && prev.title === title) prev.end = e; else out.push({ start: s, end: e, title });
    }
    list = out;
  }
  if (keep) {
    list = list.map((c) => ({ ...c, start: remapTime(c.start, keep), end: remapTime(c.end, keep) }))
      .filter((c) => c.end - c.start > 0.5);
  }
  return list;
}

function ffmetadata(chapters) {
  const esc = (s) => String(s).replace(/([=;#\\\n])/g, "\\$1");
  let t = ";FFMETADATA1\n";
  for (const c of chapters) {
    t += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round(c.end * 1000)}\ntitle=${esc(c.title)}\n`;
  }
  return t;
}

function metaArgs(meta, ext) {
  const a = [];
  const put = (k, v) => { if (v != null && String(v).trim() !== "") a.push("-metadata", `${k}=${v}`); };
  put("title", meta.title);
  put("artist", meta.artist);
  put("album_artist", meta.artist);
  put("album", meta.album);
  put("genre", meta.genre);
  if (meta.date && /^\d{8}$/.test(meta.date)) put("date", ["mp3"].includes(ext) ? meta.date.slice(0, 4) : `${meta.date.slice(0, 4)}-${meta.date.slice(4, 6)}-${meta.date.slice(6)}`);
  put("comment", meta.comment);
  put(ext === "mp4" || ext === "m4a" || ext === "mov" ? "description" : "DESCRIPTION", (meta.description || "").slice(0, 2000));
  put("purl", meta.purl);
  return a;
}

function audioCodecArgs(o, srcCodec) {
  let fmt = o.audioFormat;
  if (fmt === "best" && !o.normalize && o.sampleRate === "source" && o.channels === "source") return ["-c:a", "copy"];
  if (fmt === "best") {
    // Re-encode needed (normalize/resample) but keep the codec family.
    fmt = srcCodec.startsWith("mp4a") ? "m4a" : srcCodec.startsWith("vorbis") ? "ogg" : srcCodec.startsWith("mp3") ? "mp3" : "opus";
  }
  const af = AUDIO_FORMATS[fmt];
  const a = ["-c:a", af.codec];
  if (af.lossy) {
    if (o.audioBitrateMode === "vbr") {
      const q = Number(o.audioVbr);
      if (fmt === "mp3") a.push("-q:a", String(q));
      else if (fmt === "ogg") a.push("-q:a", String(10 - q));
      else a.push("-b:a", `${VBR_KBPS[q]}k`);
    } else {
      a.push("-b:a", `${o.audioBitrate}k`);
    }
  }
  if (fmt === "opus") a.push("-ar", "48000");  // Opus is always 48 kHz
  else if (o.sampleRate !== "source") a.push("-ar", o.sampleRate);
  if (o.channels !== "source") a.push("-ac", o.channels);
  if (o.normalize) a.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
  return a;
}

// ---------------------------------------------------------------- job
/**
 * ctx: { engine, bridge, video (probe result), options, signal, onStep(text), onProgress(frac|null, text), onLog }
 * returns [{ name, blob }]
 */
export async function runJob(ctx) {
  const { engine, bridge, video, options: o, signal } = ctx;
  const step = (t) => ctx.onStep?.(t);
  const prog = (f, t) => ctx.onProgress?.(f, t);
  const log = (m) => ctx.onLog?.(m);
  const warn = (m) => ctx.onWarn?.(m);
  const outputs = [];
  const tmp = [];

  // 1. Format selection by yt-dlp itself.
  step("Selecting formats");
  const sel = await engine.select(video.key, toYtdlp(o));
  if (!sel.ok) throw new Error(sel.error);
  const clientOf = (f) => { try { return new URL(f.url).searchParams.get("c") || "?"; } catch { return "?"; } };
  log(`[select] ${sel.formats.map((f) => `${f.format_id} (${clientOf(f)})`).join(" + ")} → ${sel.filename}`);

  let ext = outputExt(o, sel);
  const vfmt = sel.formats.find(hasVideo);
  const afmt = sel.formats.find((f) => hasAudio(f) && f !== vfmt) || (vfmt && hasAudio(vfmt) ? vfmt : null);
  if (o.mode !== "audio") {
    const vc = (vfmt?.vcodec || "").toLowerCase();
    if (ext === "webm" && !/^(vp0?8|vp0?9|av01)/.test(vc) && o.recode === "none") { warn(`WebM can't hold ${vc}; using MKV instead`); ext = "mkv"; }
    if (ext === "mov" && /^(vp0?9|vp0?8|av01)/.test(vc) && o.recode === "none") { warn(`MOV can't hold ${vc.split(".")[0]}; using MP4 instead`); ext = "mp4"; }
  }

  // 2. Download media through the bridge.
  const inputs = [];
  for (const [i, f] of sel.formats.entries()) {
    const kind = hasVideo(f) ? (hasAudio(f) ? "video+audio" : "video") : "audio";
    step(`Downloading ${kind} (${f.format_id}${f.height ? ` · ${f.height}p` : f.abr ? ` · ${Math.round(f.abr)}k` : ""})`);
    const data = await downloadFormat(bridge, f, {
      signal,
      onProgress: (p) => prog(p.fraction, `${(p.loaded / 1048576).toFixed(1)} MiB${p.total ? ` / ${(p.total / 1048576).toFixed(1)} MiB` : ""} · ${(p.speed / 1048576).toFixed(1)} MiB/s`),
    });
    const name = `in${i}.${f.ext || "bin"}`;
    await FF.writeFile(name, data);
    tmp.push(name);
    inputs.push({ name, fmt: f });
  }

  // 3. Extras.
  let thumb = null;
  if (o.thumbnail !== "none") {
    step("Fetching thumbnail");
    const cands = [...(video.thumbnails || [])].reverse().map((t) => t.url).filter(Boolean);
    if (sel.thumbnail) cands.unshift(sel.thumbnail);
    for (const url of [...new Set(cands)].slice(0, 6)) {
      try {
        const res = await fetchSmall(bridge, url, signal);
        thumb = await toImage(res.buf, { square: o.thumbSquare });
        break;
      } catch (e) { log(`[thumb] ${url}: ${e.message}`); }
    }
    if (!thumb) warn("Couldn't fetch a thumbnail");
  }

  const subs = [];
  if (o.subs !== "none") {
    for (const [lang, s] of Object.entries(sel.subtitles || {})) {
      if (!s.url) continue;
      step(`Fetching subtitles (${lang})`);
      try {
        const res = await fetchSmall(bridge, s.url, signal);
        const name = `sub_${subs.length}.${s.ext || "vtt"}`;
        const data = new Uint8Array(res.buf);
        await FF.writeFile(name, data.slice());
        tmp.push(name);
        subs.push({ lang, name, ext: s.ext, data });
      } catch (e) { warn(`Subtitles ${lang}: ${e.message}`); }
    }
    if (!subs.length) warn("No subtitles matched the requested languages");
  }

  let sb = [];
  if (o.sponsorblock !== "off" && video.extractor === "Youtube" && o.sbCategories.length) {
    step("Querying SponsorBlock");
    try {
      const r = await fetch(`https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(video.id)}&categories=${encodeURIComponent(JSON.stringify(o.sbCategories))}`, { signal });
      if (r.ok) sb = (await r.json()).filter((x) => x.actionType === "skip" || !x.actionType);
      else if (r.status !== 404) warn(`SponsorBlock: HTTP ${r.status}`);
      log(`[sponsorblock] ${sb.length} segment(s)`);
    } catch (e) { warn(`SponsorBlock: ${e.message}`); }
  }

  // 4. Combine the streams we need into one file (stream copy), then cut that,
  //    exactly like yt-dlp's ModifyChapters: cutting the merged file keeps A/V in sync.
  const isAudio = o.mode === "audio";
  const vin = !isAudio ? inputs.find((i) => i.fmt === vfmt) || inputs[0] : null;
  const ain = o.mode !== "video" && afmt ? inputs.find((i) => i.fmt === afmt) || null : null;
  let src = (vin || ain || inputs[0]).name;
  if (vin && ain && vin !== ain) {
    step("Merging streams");
    const r = await FF.run(["-hide_banner", "-i", vin.name, "-i", ain.name, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "mid.mkv"], { onLog: log });
    if (r.code !== 0) throw new Error("ffmpeg failed while merging:\n" + r.log.slice(-6).join("\n"));
    tmp.push("mid.mkv");
    src = "mid.mkv";
  }
  const duration = sel.duration || video.duration || 0;
  const tStart = parseTime(o.trimStart), tEnd = parseTime(o.trimEnd);
  const removeSegs = o.sponsorblock === "remove" ? sb.map((s) => s.segment) : [];
  let keep = null;
  if ((tStart != null || tEnd != null || removeSegs.length) && duration) {
    keep = keepSegments(duration, tStart, tEnd, removeSegs);
    if (!keep.length) throw new Error("Nothing left after trimming / SponsorBlock removal");
    step(`Cutting ${keep.length} segment(s)`);
    const list = "ffconcat version 1.0\n" + keep.map(([s, e]) => `file '${src}'\ninpoint ${s.toFixed(3)}\noutpoint ${e.toFixed(3)}\n`).join("");
    await FF.writeFile("cut.ffconcat", new TextEncoder().encode(list));
    const precise = o.preciseCuts && !isAudio;
    if (precise && ext === "webm") { warn("Precise cuts produce H.264, which WebM can't hold; using MKV"); ext = "mkv"; }
    const cutTotal = keep.reduce((a, [s, e]) => a + e - s, 0);
    const fail = (r) => {
      if (precise && r.log.some((l) => /\[av1 @/.test(l))) throw new Error("This FFmpeg build can't decode AV1, so it can't re-encode for precise cuts. Remove the custom AV1 format or turn off precise cuts.");
      throw new Error("ffmpeg failed while cutting:\n" + r.log.slice(-6).join("\n"));
    };
    if (precise) {
      // Frame-exact: re-encode each kept segment on its own (trim/atrim), then join
      // the identically-encoded pieces losslessly. (One big concat filter graph
      // crashes ffmpeg.wasm 0.12, so segments are processed one at a time.)
      const hasA = !!ain;
      const segFiles = [];
      let doneSecs = 0;
      for (const [i, [s, e]] of keep.entries()) {
        const fc = `[0:v:0]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=PTS-STARTPTS[v]` +
          (hasA ? `;[0:a:0]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[a]` : "");
        const seg = keep.length === 1 ? "cut.mkv" : `seg${i}.mkv`;
        const r = await FF.run(["-hide_banner", "-i", src, "-filter_complex", fc, "-map", "[v]",
          ...(hasA ? ["-map", "[a]", "-c:a", ["mp4", "mov"].includes(ext) ? "aac" : "opus", "-strict", "-2", "-b:a", "192k"] : []),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", seg], {
          onLog: log,
          onProgress: (ev) => ev.time && prog(Math.min(1, (doneSecs + ev.time / 1e6) / cutTotal), `Re-encoding segment ${i + 1}/${keep.length} for precise cuts`),
        });
        if (r.code !== 0) fail(r);
        doneSecs += e - s;
        segFiles.push(seg);
        tmp.push(seg);
      }
      if (keep.length > 1) {
        await FF.writeFile("join.ffconcat", new TextEncoder().encode("ffconcat version 1.0\n" + segFiles.map((f) => `file '${f}'\n`).join("")));
        const r = await FF.run(["-hide_banner", "-f", "concat", "-safe", "0", "-i", "join.ffconcat", "-map", "0", "-c", "copy", "cut.mkv"], { onLog: log });
        if (r.code !== 0) fail(r);
        tmp.push("join.ffconcat", "cut.mkv");
      }
    } else {
      const r = await FF.run(["-hide_banner", "-f", "concat", "-safe", "0", "-i", "cut.ffconcat", "-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero", "cut.mkv"], { onLog: log });
      if (r.code !== 0) fail(r);
    }
    tmp.push("cut.ffconcat", "cut.mkv");
    src = "cut.mkv";
  }

  // 5. Build the main ffmpeg command.
  step("Processing with ffmpeg.wasm");
  const args = ["-hide_banner"];
  const maps = [];
  let idx = 0;
  const addInput = (name, pre = []) => { args.push(...pre, "-i", name); return idx++; };

  const audioOnlyContainer = ext;
  const mainIdx = addInput(src);
  const aIdx = ain ? mainIdx : null;
  if (!isAudio) maps.push("-map", `${mainIdx}:v:0`);
  if (ain) maps.push("-map", `${mainIdx}:a:0${isAudio ? "" : "?"}`);
  else if (isAudio) maps.push("-map", `${mainIdx}:a:0`);

  // Thumbnail
  let embedThumb = o.thumbnail === "embed" || o.thumbnail === "both";
  const thumbCapable = isAudio ? ["mp3", "m4a", "flac", "opus", "ogg"].includes(audioOnlyContainer) : ["mp4", "mkv"].includes(ext);
  if (thumb && embedThumb && !thumbCapable) { warn(`Can't embed a thumbnail in .${ext}; saving it as a file instead`); embedThumb = false; }
  const codecArgs = [];
  if (thumb && embedThumb) {
    const tn = "cover.jpg";
    await FF.writeFile(tn, thumb.bytes.slice());
    tmp.push(tn);
    if (ext === "mkv") {
      codecArgs.push("-attach", tn, "-metadata:s:t", "mimetype=image/jpeg", "-metadata:s:t", "filename=cover.jpg");
    } else if (ext === "opus" || ext === "ogg") {
      codecArgs.push("-metadata", `METADATA_BLOCK_PICTURE=${flacPictureBlock(thumb.bytes, thumb.width, thumb.height)}`);
    } else {
      const tIdx = addInput(tn);
      maps.push("-map", `${tIdx}:0`);
      const vStream = isAudio ? 0 : 1;
      codecArgs.push(`-c:v:${vStream}`, "copy", `-disposition:v:${vStream}`, "attached_pic");
      if (ext === "mp3") codecArgs.push("-id3v2_version", "3", `-metadata:s:v:${vStream}`, "title=Album cover", `-metadata:s:v:${vStream}`, "comment=Cover (front)");
    }
  }

  // Subtitles
  if ((o.subs === "embed" || o.subs === "both") && subs.length) {
    if (isAudio) warn("Subtitles can't be embedded in audio files; saving them as files");
    else {
      const sc = ext === "mp4" || ext === "mov" ? "mov_text" : ext === "webm" ? "webvtt" : "srt";
      subs.forEach((s, i) => {
        const sIdx = addInput(s.name, keep ? ["-ss", keep[0][0].toFixed(3)] : []);
        maps.push("-map", `${sIdx}:0`);
        codecArgs.push(`-c:s:${i}`, sc, `-metadata:s:s:${i}`, `language=${s.lang.split("-")[0]}`);
      });
    }
  }

  // Chapters
  let chapterIdx = null;
  if (o.chapters || o.sponsorblock === "mark") {
    const chapters = buildChapters({ chapters: o.chapters ? sel.chapters : [], duration, sb, sbMode: o.sponsorblock, keep });
    if (chapters.length) {
      await FF.writeFile("chapters.txt", new TextEncoder().encode(ffmetadata(chapters)));
      tmp.push("chapters.txt");
      chapterIdx = addInput("chapters.txt");
    }
  }

  // Codecs
  if (!isAudio) {
    if (o.recode === "h264" && !(keep && o.preciseCuts)) codecArgs.unshift("-c:v:0", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
    else codecArgs.unshift("-c:v:0", "copy");
    if (aIdx != null) {
      const ac = (afmt.acodec || "").toLowerCase();
      if (ext === "webm" && !/^(opus|vorbis)/.test(ac)) codecArgs.push("-c:a", "opus", "-b:a", "160k", "-ar", "48000");
      else if ((ext === "mp4" || ext === "mov") && /^vorbis/.test(ac)) codecArgs.push("-c:a", "aac", "-b:a", "192k");
      else codecArgs.push("-c:a", "copy");
    }
  } else {
    codecArgs.unshift(...audioCodecArgs(o, (afmt?.acodec || "").toLowerCase()));
  }

  args.push(...maps, ...codecArgs);
  // Global metadata comes only from what we set below; chapters (with their titles) from our ffmetadata file.
  if (chapterIdx != null) args.push("-map_metadata", String(chapterIdx), "-map_chapters", String(chapterIdx));
  else args.push("-map_metadata", "-1", "-map_chapters", "-1");
  if (o.metadata) args.push(...metaArgs(sel.metadata || {}, ext));
  if (["mp4", "mov", "m4a"].includes(ext)) args.push("-movflags", "+faststart");
  args.push("-strict", "experimental");
  const outName = `out.${ext}`;
  args.push(outName);
  log("[ffmpeg] " + args.join(" ").replace(/METADATA_BLOCK_PICTURE=\S+/, "METADATA_BLOCK_PICTURE=…"));

  const total = keep ? keep.reduce((a, [s, e]) => a + e - s, 0) : duration;
  const r = await FF.run(args, {
    onLog: log,
    onProgress: (e) => {
      const t = e.time ? e.time / 1e6 : null;
      prog(total && t ? Math.min(1, t / total) : (e.progress > 0 && e.progress <= 1 ? e.progress : null), "Encoding / muxing");
    },
  });
  if (r.code !== 0) {
    await FF.rm(...tmp, outName);
    throw new Error("ffmpeg failed:\n" + r.log.slice(-8).join("\n"));
  }
  const data = await FF.readFile(outName);
  await FF.rm(...tmp, outName);
  const mainName = setExt(sel.filename, ext);
  outputs.push({ name: mainName, blob: new Blob([data]) });

  // 6. Side files.
  if (thumb && (o.thumbnail === "file" || o.thumbnail === "both" || (o.thumbnail === "embed" && !embedThumb))) {
    const type = o.thumbFormat === "png" ? "image/png" : o.thumbFormat === "webp" ? "image/webp" : "image/jpeg";
    const img = type === "image/jpeg" ? thumb : await toImage(thumb.bytes, { square: false, type });
    outputs.push({ name: setExt(mainName, o.thumbFormat), blob: new Blob([img.bytes], { type }) });
  }
  if (subs.length && (o.subs === "file" || o.subs === "both" || (o.subs === "embed" && isAudio))) {
    for (const s of subs) {
      await FF.writeFile(s.name, s.data.slice());
      const out = `subout.${o.subFormat}`;
      const pre = keep ? ["-ss", keep[0][0].toFixed(3)] : [];
      const rr = await FF.run(["-hide_banner", ...pre, "-i", s.name, out]);
      if (rr.code === 0) outputs.push({ name: setExt(mainName, `${s.lang}.${o.subFormat}`), blob: new Blob([await FF.readFile(out)]) });
      else warn(`Couldn't convert ${s.lang} subtitles to ${o.subFormat}`);
      await FF.rm(s.name, out);
    }
  }
  return outputs;
}
