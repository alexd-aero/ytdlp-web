"""
webytdlp — glue that lets the real yt-dlp run inside Pyodide in the browser.

* BridgeRH:   a yt-dlp RequestHandler that sends every HTTP request through the
              JS bridge (a youtube.com tab running the bookmarklet), so requests
              are same-origin for YouTube and CORS never gets in the way.
* BrowserJCP: a yt-dlp JS-challenge provider that solves YouTube's n/sig
              challenges with the browser's own JS engine instead of deno/node.
* probe / select: the API the web worker calls.
"""
from __future__ import annotations

import copy
import io
import json
import traceback

import js
from pyodide.ffi import run_sync, to_js

import yt_dlp
from yt_dlp.networking import common as _net
from yt_dlp.networking.common import Features, RequestHandler, Response
from yt_dlp.networking.exceptions import HTTPError, TransportError
from yt_dlp.extractor.youtube.jsc._builtin.ejs import EJSBaseJCP
from yt_dlp.extractor.youtube.jsc.provider import (
    register_preference as _jsc_register_preference,
    register_provider as _jsc_register_provider,
)
from yt_dlp.extractor.youtube.pot._provider import BuiltinIEContentProvider

# Headers the browser will refuse to let us set (or that would trigger a
# CORS preflight on googlevideo for no benefit).
_FORBIDDEN = {
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
    'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
    'user-agent', 'priority',
}


def _js_obj(d):
    return to_js(d, dict_converter=js.Object.fromEntries)


# --------------------------------------------------------------------------
# Networking
# --------------------------------------------------------------------------
class BridgeRH(RequestHandler):
    _SUPPORTED_URL_SCHEMES = ('http', 'https')
    _SUPPORTED_PROXY_SCHEMES = None
    _SUPPORTED_FEATURES = (Features.NO_PROXY, Features.ALL_PROXY)
    RH_NAME = 'browser-bridge'

    def _check_extensions(self, extensions):
        super()._check_extensions(extensions)
        for key in ('cookiejar', 'timeout', 'legacy_ssl', 'keep_header_casing', 'impersonate'):
            extensions.pop(key, None)

    def _send(self, request):
        headers = {
            k: v for k, v in self._merge_headers(request.headers).items()
            if k.lower() not in _FORBIDDEN and not k.lower().startswith(('sec-', 'proxy-'))
        }
        data = request.data
        if data is not None and not isinstance(data, (bytes, bytearray)):
            data = data.read() if hasattr(data, 'read') else b''.join(data)
        req = {
            'url': request.url,
            'method': request.method,
            'headers': _js_obj(headers),
        }
        if data is not None:
            req['body'] = to_js(bytes(data))
        res = run_sync(js.bridgeFetch(_js_obj(req)))
        if getattr(res, 'error', None):
            raise TransportError(msg=str(res.error))
        resp_headers = {}
        for pair in res.headers:
            name, value = pair[0], pair[1]
            if name.lower() in ('content-encoding', 'content-length', 'transfer-encoding'):
                continue
            resp_headers[name] = value
        body = res.buf.to_bytes() if res.buf else b''
        response = Response(io.BytesIO(body), res.url or request.url, resp_headers,
                            int(res.status), str(res.statusText or '') or None)
        if not 200 <= response.status < 300:
            raise HTTPError(response)
        return response


# Make the bridge the *only* transport: there are no sockets in a browser.
_net._REQUEST_HANDLERS.clear()
_net.register_rh(BridgeRH)


# --------------------------------------------------------------------------
# YouTube JS challenge solving with the browser's JS engine
# --------------------------------------------------------------------------
@_jsc_register_provider
class BrowserJCP(EJSBaseJCP, BuiltinIEContentProvider):
    PROVIDER_NAME = 'browser'
    JS_RUNTIME_NAME = 'browser'

    def is_available(self, /) -> bool:
        return self._available

    def _run_js_runtime(self, stdin: str, /) -> str:
        return str(js.runJsChallenge(stdin))


@_jsc_register_preference(BrowserJCP)
def _browser_jcp_preference(provider, requests):
    return 5000


# --------------------------------------------------------------------------
# Logging back to the UI
# --------------------------------------------------------------------------
class _Logger:
    def debug(self, msg):
        if msg.startswith('[debug] '):
            js.ytLog('debug', msg)
        else:
            js.ytLog('info', msg)

    def info(self, msg):
        js.ytLog('info', msg)

    def warning(self, msg):
        js.ytLog('warning', msg)

    def error(self, msg):
        js.ytLog('error', msg)


_RAW_CACHE: dict[str, dict] = {}


def _base_params(opts: dict) -> dict:
    params = {
        'logger': _Logger(),
        'quiet': False,
        'no_warnings': False,
        'verbose': bool(opts.get('verbose')),
        'noprogress': True,
        'skip_download': True,
        'cachedir': '/tmp/yt-dlp-cache',
        'noplaylist': not opts.get('playlist', False),
        'extract_flat': 'in_playlist',
        'check_formats': False,
        'format': 'bv*+ba/b',  # explicit, so yt-dlp doesn't warn about ffmpeg (merging happens in ffmpeg.wasm)
        'extractor_args': {},
        'remote_components': set(),
    }
    ea = {}
    yt = {}
    if opts.get('player_client'):
        yt['player_client'] = [c.strip() for c in opts['player_client'].split(',') if c.strip()]
    yt['formats'] = ['missing_pot']
    if opts.get('visitor_data'):
        # The bridge reads the YouTube page's own visitor token, so yt-dlp doesn't need to
        # download the watch page (which m.youtube.com can't read cross-origin).
        # This is yt-dlp's documented "visitor_data + player_skip=webpage,configs" setup.
        yt['visitor_data'] = [opts['visitor_data']]
        yt['player_skip'] = ['webpage', 'configs']
    elif opts.get('skip_webpage'):
        yt['player_skip'] = ['webpage']
    ea['youtube'] = yt
    for key, value in (opts.get('extractor_args') or {}).items():
        ea.setdefault(key, {}).update(value)
    params['extractor_args'] = ea
    if opts.get('subtitleslangs'):
        params['writesubtitles'] = True
        params['writeautomaticsub'] = bool(opts.get('autosubs', True))
        params['subtitleslangs'] = opts['subtitleslangs']
        params['subtitlesformat'] = 'vtt/srt/best'
    return params


def _sanitize(ydl, info):
    return json.loads(json.dumps(ydl.sanitize_info(info), default=str))


def _summary_format(f: dict) -> dict:
    keys = ('format_id', 'format_note', 'ext', 'protocol', 'vcodec', 'acodec', 'width', 'height',
            'fps', 'tbr', 'abr', 'vbr', 'asr', 'audio_channels', 'filesize', 'filesize_approx',
            'dynamic_range', 'language', 'container', 'resolution', 'format', 'quality',
            'has_drm', 'source_preference', 'audio_ext', 'video_ext')
    return {k: f.get(k) for k in keys if f.get(k) is not None}


def probe(url: str, opts_json: str) -> str:
    """Extract info for a URL. Returns JSON with either a video or a playlist."""
    opts = json.loads(opts_json or '{}')
    try:
        with yt_dlp.YoutubeDL(_base_params(opts)) as ydl:
            raw = ydl.extract_info(url, download=False, process=False)
            if raw.get('_type') in ('playlist', 'multi_video'):
                entries = []
                for e in list(raw.get('entries') or []):
                    if not e:
                        continue
                    entries.append({
                        'id': e.get('id'), 'title': e.get('title'), 'url': e.get('url') or e.get('webpage_url'),
                        'duration': e.get('duration'), 'channel': e.get('channel') or e.get('uploader'),
                        'thumbnail': (e.get('thumbnails') or [{}])[-1].get('url') if e.get('thumbnails') else e.get('thumbnail'),
                    })
                return json.dumps({'ok': True, 'kind': 'playlist', 'id': raw.get('id'), 'title': raw.get('title'),
                                   'channel': raw.get('channel') or raw.get('uploader'), 'entries': entries,
                                   'webpage_url': raw.get('webpage_url') or url})
            if raw.get('_type') == 'url':
                return probe(raw['url'], opts_json)
            key = f"{raw.get('extractor_key')}:{raw.get('id')}"
            _RAW_CACHE[key] = copy.deepcopy(raw)
            info = ydl.process_ie_result(copy.deepcopy(raw), download=False)
            info = _sanitize(ydl, info)
            out = {
                'ok': True, 'kind': 'video', 'key': key,
                'id': info.get('id'), 'title': info.get('title'), 'fulltitle': info.get('fulltitle'),
                'channel': info.get('channel') or info.get('uploader'), 'channel_url': info.get('channel_url'),
                'uploader': info.get('uploader'), 'duration': info.get('duration'),
                'duration_string': info.get('duration_string'), 'view_count': info.get('view_count'),
                'like_count': info.get('like_count'), 'upload_date': info.get('upload_date'),
                'description': info.get('description'), 'thumbnail': info.get('thumbnail'),
                'thumbnails': info.get('thumbnails') or [], 'chapters': info.get('chapters') or [],
                'webpage_url': info.get('webpage_url'), 'extractor': info.get('extractor_key'),
                'is_live': info.get('is_live'), 'age_limit': info.get('age_limit'),
                'formats': [_summary_format(f) for f in info.get('formats') or []],
                'subtitles': {k: [s.get('ext') for s in v] for k, v in (info.get('subtitles') or {}).items()},
                'automatic_captions': sorted((info.get('automatic_captions') or {}).keys()),
            }
            return json.dumps(out)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e), 'trace': traceback.format_exc()})


def select(key: str, opts_json: str) -> str:
    """Run yt-dlp's real format selector + output template on a probed video."""
    opts = json.loads(opts_json or '{}')
    raw = _RAW_CACHE.get(key)
    if raw is None:
        return json.dumps({'ok': False, 'error': 'Video not probed (or cache expired); fetch it again.'})
    try:
        params = _base_params(opts)
        params['format'] = opts.get('format') or 'bv*+ba/b'
        if opts.get('format_sort'):
            params['format_sort'] = opts['format_sort']
        if opts.get('merge_output_format'):
            params['merge_output_format'] = opts['merge_output_format']
        params['outtmpl'] = {'default': opts.get('outtmpl') or '%(title)s [%(id)s].%(ext)s'}
        params['restrictfilenames'] = bool(opts.get('restrictfilenames'))
        params['windowsfilenames'] = True
        with yt_dlp.YoutubeDL(params) as ydl:
            info = ydl.process_ie_result(copy.deepcopy(raw), download=False)
            requested = info.get('requested_formats') or [info]
            fmts = []
            for f in requested:
                fmts.append({
                    **_summary_format(f),
                    'url': f.get('url'),
                    'http_headers': f.get('http_headers') or {},
                    'fragments': [{'url': fr.get('url'), 'path': fr.get('path')} for fr in (f.get('fragments') or [])] or None,
                    'fragment_base_url': f.get('fragment_base_url'),
                    'downloader_options': f.get('downloader_options') or {},
                })
            subs = {}
            for lang, tracks in (info.get('requested_subtitles') or {}).items():
                subs[lang] = {'ext': tracks.get('ext'), 'url': tracks.get('url'), 'name': tracks.get('name')}
            filename = ydl.prepare_filename(info)
            meta = {
                'title': info.get('title'), 'artist': info.get('artist') or info.get('creator') or info.get('channel') or info.get('uploader'),
                'album': info.get('album'), 'track': info.get('track'), 'date': info.get('upload_date'),
                'description': info.get('description'), 'comment': info.get('webpage_url'),
                'genre': (info.get('genres') or info.get('categories') or [None])[0],
                'purl': info.get('webpage_url'),
            }
            return json.dumps({
                'ok': True, 'formats': fmts, 'filename': filename, 'ext': info.get('ext'),
                'format_id': info.get('format_id'), 'subtitles': subs, 'metadata': meta,
                'thumbnail': info.get('thumbnail'), 'chapters': info.get('chapters') or [],
                'duration': info.get('duration'),
            }, default=str)
    except Exception as e:
        return json.dumps({'ok': False, 'error': str(e), 'trace': traceback.format_exc()})


def version() -> str:
    return yt_dlp.version.__version__
