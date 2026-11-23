"""Build the YouTube add-ons from js/bridge-inject.js + js/ytbutton.js.

    python tools/build-addons.py [SITE_URL]

SITE_URL is where this site is hosted (default: the GitHub Pages URL below). Writes:
    addon/ytdlp.user.js          userscript (Tampermonkey / Violentmonkey / Userscripts for iOS)
    addon/extension/             unpacked Chrome extension (Manifest V3)
    addon/ytdlp-extension.zip    the same, zipped for download from the landing page
Re-run after changing bridge-inject.js or ytbutton.js, then commit addon/.
"""
import io
import json
import shutil
import sys
import zipfile
from pathlib import Path

VERSION = "1.0.0"
DEFAULT_SITE = "https://alexd-aero.github.io/ytdlp-web/"
NAME = "ytdlp - Download button for YouTube"
DESC = "Adds a Download button to YouTube that opens ytdlp: real yt-dlp + FFmpeg running in your browser."
MATCHES = ["https://www.youtube.com/*", "https://m.youtube.com/*"]

root = Path(__file__).resolve().parent.parent
site = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SITE).rstrip("/") + "/"
card = site + "card.html"
out = root / "addon"
ext = out / "extension"


def config(via):
    return (
        "// ytdlp add-on config: where the card lives, and wait for the Download button before opening.\n"
        f"window.__ytdlpAppUrl = {json.dumps(card)};\n"
        f"window.__ytdlpVia = {json.dumps(via)};\n"
        "window.__ytdlpNoAutoOpen = true;\n"
    )


bridge = (root / "js" / "bridge-inject.js").read_text(encoding="utf-8")
button = (root / "js" / "ytbutton.js").read_text(encoding="utf-8")


def icon_png(size):
    """The ytdlp mark (green-cyan gradient tile with a bolt) as PNG bytes, or None without Pillow."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    s = 4 * size  # supersample, then downscale for smooth edges
    grad = Image.new("RGBA", (s, s))
    px = grad.load()
    for y in range(s):
        for x in range(s):
            t = (x + y) / (2 * s - 2)
            px[x, y] = (int(0x00 + t * 0x2E), int(0xFF - t * 0x19), int(0x88 + t * 0x77), 255)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.28), fill=255)
    tile = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)
    k = s / 32
    bolt = [(18, 5), (9, 18), (15, 18), (13, 27), (23, 13), (17, 13)]
    ImageDraw.Draw(tile).polygon([(x * k, y * k) for x, y in bolt], fill=(0, 20, 11, 255))
    buf = io.BytesIO()
    tile.resize((size, size), Image.LANCZOS).save(buf, "PNG")
    return buf.getvalue()


# ---------------------------------------------------------------- extension
if ext.exists():
    shutil.rmtree(ext)
ext.mkdir(parents=True)
(ext / "config.js").write_text(config("extension"), encoding="utf-8", newline="\n")
(ext / "bridge-inject.js").write_text(bridge, encoding="utf-8", newline="\n")
(ext / "ytbutton.js").write_text(button, encoding="utf-8", newline="\n")
manifest = {
    "manifest_version": 3,
    "name": NAME,
    "short_name": "ytdlp",
    "version": VERSION,
    "description": DESC,
    "homepage_url": site,
    # MAIN world: the bridge must fetch *as youtube.com* (the page's own origin), exactly like the
    # bookmark does. No extension permissions are needed for that.
    "content_scripts": [{
        "matches": MATCHES,
        "js": ["config.js", "bridge-inject.js", "ytbutton.js"],
        "run_at": "document_idle",
        "world": "MAIN",
    }],
}
icons = {}
for n in (16, 32, 48, 128):
    png = icon_png(n)
    if png:
        (ext / f"icon{n}.png").write_bytes(png)
        icons[str(n)] = f"icon{n}.png"
if icons:
    manifest["icons"] = icons
(ext / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")

zpath = out / "ytdlp-extension.zip"
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(ext.iterdir()):
        z.write(f, f"ytdlp-extension/{f.name}")

# ---------------------------------------------------------------- userscript
user_url = site + "addon/ytdlp.user.js"
header = "\n".join([
    "// ==UserScript==",
    f"// @name         {NAME}",
    f"// @namespace    {site}",
    f"// @version      {VERSION}",
    f"// @description  {DESC}",
    f"// @homepageURL  {site}",
    f"// @icon         {site}addon/extension/icon128.png",
    *[f"// @match        {m}" for m in MATCHES],
    "// @grant        none",
    "// @inject-into  page",
    "// @run-at       document-idle",
    "// @noframes",
    f"// @downloadURL  {user_url}",
    f"// @updateURL    {user_url}",
    "// ==/UserScript==",
    "",
])
(out / "ytdlp.user.js").write_text(
    header + "\n" + config("userscript") + "\n" + bridge + "\n" + button, encoding="utf-8", newline="\n")

print(f"site:        {site}")
print(f"extension:   {ext.relative_to(root)} ({len(list(ext.iterdir()))} files), {zpath.relative_to(root)} ({zpath.stat().st_size} bytes)")
print(f"userscript:  addon/ytdlp.user.js -> {user_url}")
