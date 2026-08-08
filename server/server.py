#!/usr/bin/env python3
"""
Eilatan Lingo — local companion server.

Two jobs in one:

  1. /api/translate  — LIVE translation backend for the extension.
     The browser streams page text, typed input, form/fetch/WebSocket
     payloads here over HTTP. Pluggable engines:
        google  (default, free unofficial endpoint, no key)
        libre   (LibreTranslate — point at a public or self-hosted instance)
        deepl   (DeepL API key)
        offline (argos-translate, if installed)
     The extension auto-discovers this server and falls back to its
     built-in engine when it isn't running.

  2. /proxy?url=...  — "download the site, refeed it over localhost".
     Fetches a page, rewrites every href/src/action/srcset to loop back
     through this proxy, and translates the visible text server-side.
     Works for classic server-rendered sites. JS-heavy SPAs will fight you:
     their XHR/history/cookies assume the real origin. That's the nature
     of the beast — this is a PoC, not a universal proxy.

Usage:
  python3 server.py                                   # google, 127.0.0.1:8787
  python3 server.py --engine deepl --api-key XXX
  python3 server.py --engine libre --libre-url https://lt.example --api-key XXX
  python3 server.py --port 9000
"""

import argparse
import html
import json
import re
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser

DEFAULT_PORT = 8787
VERSION = "1.3.0"
GOOGLE_TLX = "https://translate.googleapis.com/translate_a/single?client=gtx"

# ---------------------------------------------------------------------------
# Small shared bits
# ---------------------------------------------------------------------------

def normalize_code(raw):
    if not raw:
        return ""
    l = str(raw).lower()
    if l.startswith(("zh-hans", "zh-cn")) or l == "zh":
        return "zh-CN"
    if l.startswith(("zh-hant", "zh-tw")):
        return "zh-TW"
    if l.startswith("pt"):
        return "pt"
    m = re.match(r"^[a-z]{2}", l)
    return m.group(0) if m else ""


class TTLCache:
    def __init__(self, ttl=24 * 3600, max_size=20000):
        self._d = OrderedDict()
        self._lock = threading.Lock()
        self.ttl = ttl
        self.max_size = max_size

    def get(self, key):
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                return None
            if time.time() - hit[0] > self.ttl:
                del self._d[key]
                return None
            self._d.move_to_end(key)
            return hit[1]

    def set(self, key, value):
        with self._lock:
            self._d[key] = (time.time(), value)
            self._d.move_to_end(key)
            while len(self._d) > self.max_size:
                self._d.popitem(last=False)

    def __len__(self):
        return len(self._d)


_SEM = threading.BoundedSemaphore(4)   # polite concurrency for engine calls
_GOOGLE_LOCK = threading.Lock()
_LAST_GOOGLE = [0.0]


def _google_rate_limit():
    with _GOOGLE_LOCK:
        wait = 0.06 - (time.time() - _LAST_GOOGLE[0])
        if wait > 0:
            time.sleep(wait)
        _LAST_GOOGLE[0] = time.time()


def _http_json(url, method="GET", payload=None, headers=None, timeout=20):
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", "Mozilla/5.0 EilatanLingo/" + VERSION)
    req.add_header("Accept-Encoding", "identity")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        try:
            return resp.status, resp.headers, json.loads(body.decode("utf-8"))
        except Exception:
            return resp.status, resp.headers, body


# ---------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------

class Engine:
    name = "base"

    def translate(self, texts, from_, to):
        raise NotImplementedError

    def detect(self, text):
        raise NotImplementedError


def _google_single(text, from_, to):
    _google_rate_limit()
    url = (GOOGLE_TLX + "&sl=" + urllib.parse.quote(from_) +
           "&tl=" + urllib.parse.quote(to) + "&dt=t&q=" + urllib.parse.quote(text))
    with _SEM:
        status, _h, data = _http_json(url)
    if status != 200 or not isinstance(data, list):
        raise RuntimeError("google translate failed: %s" % status)
    segs = data[0] if isinstance(data[0], list) else []
    tx = "".join((s[0] or "") if isinstance(s, list) else "" for s in segs)
    det = data[2] if len(data) > 2 else ""
    return tx, det


class GoogleEngine(Engine):
    name = "google"

    def translate(self, texts, from_, to):
        out = []
        for t in texts:
            tx, det = _google_single(t, from_, to)
            out.append((tx, det))
        return out

    def detect(self, text):
        _tx, det = _google_single(text[:900], "auto", "en")
        return normalize_code(det)


class LibreEngine(Engine):
    name = "libre"

    def __init__(self, base_url, api_key):
        self.base = base_url.rstrip("/")
        self.key = api_key or ""

    def _post(self, path, payload):
        headers = {"Content-Type": "application/json"}
        if self.key:
            payload = dict(payload, api_key=self.key)
        with _SEM:
            status, _h, data = _http_json(self.base + path, method="POST", payload=payload, headers=headers)
        if status != 200:
            raise RuntimeError("libre translate failed: %s" % status)
        return data

    def translate(self, texts, from_, to):
        data = self._post("/translate", {
            "q": list(texts), "source": from_ or "auto", "target": to, "format": "text",
        })
        out = []
        t = data.get("translatedText")
        if isinstance(t, list):
            for i, x in enumerate(t):
                out.append((str(x), ""))
        else:
            for i in range(len(texts)):
                out.append((str(t), ""))
        return out

    def detect(self, text):
        try:
            data = self._post("/detect", {"q": text})
            best = data.get("detectedLanguage") or []
            if best:
                return normalize_code(best[0].get("language", ""))
        except Exception:
            pass
        return ""


class DeepLEngine(Engine):
    name = "deepl"

    def __init__(self, api_key, url=None):
        self.key = api_key
        self.url = url or "https://api-free.deepl.com/v2/translate"

    def translate(self, texts, from_, to):
        payload = {"text": list(texts), "target_lang": to.upper()}
        if from_ and from_ != "auto":
            payload["source_lang"] = from_.upper()
        headers = {"Authorization": "DeepL-Auth-Key " + self.key, "Content-Type": "application/json"}
        with _SEM:
            status, _h, data = _http_json(self.url, method="POST", payload=payload, headers=headers)
        if status != 200:
            raise RuntimeError("deepl translate failed: %s" % status)
        trs = data.get("translations") or []
        return [(str(t.get("text", "")), "") for t in trs]

    def detect(self, text):
        return ""  # DeepL has no detection; falls back to google detect


class OfflineEngine(Engine):
    name = "offline"

    def __init__(self):
        self.ok = False
        try:
            from argostranslate import package, translate  # type: ignore
            self.pkg, self.tr = package, translate
            self.ok = True
        except Exception as e:
            self._err = str(e)

    def translate(self, texts, from_, to):
        if not self.ok:
            raise RuntimeError("argos-translate not installed")
        pair = self._find_pair(from_, to)
        out = []
        for t in texts:
            out.append((pair.translate(t), ""))
        return out

    def _find_pair(self, from_, to):
        langs = {l.code: l for l in self.tr.get_installed_languages()}
        if from_ and to and from_ in langs and to in langs:
            return langs[from_].get_translation(langs[to])
        raise RuntimeError("no offline language pair %s->%s" % (from_, to))

    def detect(self, text):
        return ""


def make_engine(args):
    eng = args.engine.lower()
    if eng == "libre":
        if not args.libre_url:
            sys.stderr.write("--engine libre requires --libre-url\n")
            sys.exit(2)
        return LibreEngine(args.libre_url, args.api_key)
    if eng == "deepl":
        if not args.api_key:
            sys.stderr.write("--engine deepl requires --api-key\n")
            sys.exit(2)
        return DeepLEngine(args.api_key, args.deepl_url)
    if eng == "offline":
        e = OfflineEngine()
        if not e.ok:
            sys.stderr.write("warning: argos-translate not installed; falling back to google\n")
            return GoogleEngine()
        return e
    return GoogleEngine()


# ---------------------------------------------------------------------------
# Translation API (with cache)
# ---------------------------------------------------------------------------

CACHE = TTLCache()
ENGINE = None


def translate_one(text, from_, to, want_detect):
    key = "%s|%s|%s|%s" % (ENGINE.name, from_, to, text)
    hit = CACHE.get(key)
    if hit:
        return hit
    try:
        with _SEM:
            results = ENGINE.translate([text], from_, to)
        tx, det = results[0]
        if want_detect and not det:
            det = google_detect(text)
        elif want_detect:
            det = normalize_code(det)
        entry = (tx, det)
        CACHE.set(key, entry)
        return entry
    except Exception as e:
        sys.stderr.write("translate error: %s\n" % e)
        return ("", "")


def google_detect(text):
    try:
        return GoogleEngine().detect(text)
    except Exception:
        return ""


def translate_batch(texts, from_, to, want_detect=True):
    out_tx, out_det = [], []
    for t in texts:
        tx, det = translate_one(t, from_, to, want_detect)
        out_tx.append(tx)
        out_det.append(det)
    return out_tx, out_det


# ---------------------------------------------------------------------------
# Proxy mode: download the site, rewrite it, refeed it
# ---------------------------------------------------------------------------

BLOCKED_HOST_RE = re.compile(
    r"^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|10(\.\d{1,3}){3}|"
    r"192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|"
    r"169\.254(\.\d{1,3}){2}|\[?fe80:)", re.I
)

REWRITE_ATTRS = {
    "href", "src", "action", "formaction", "poster", "data-src",
    "data-original", "data-lazy-src", "data-srcset", "srcset",
    "cite", "longdesc", "xlink:href", "background",
}
SKIP_TEXT_TAGS = {"script", "style", "textarea", "noscript", "pre", "code", "kbd", "samp", "var"}
LETTER_RE = re.compile(r"[\p{L}]", re.UNICODE)


def check_target(url):
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https"):
        raise ValueError("proxy only supports http/https")
    host = u.hostname or ""
    if BLOCKED_HOST_RE.match(host):
        raise ValueError("refusing to proxy private/loopback host: %s" % host)
    return u


def rewrite_srcset(value, base_url, prefix):
    out = []
    for cand in value.split(","):
        cand = cand.strip()
        if not cand:
            continue
        bits = cand.split()
        if not bits:
            continue
        url = bits[0]
        if not url.startswith(("#", "data:", "blob:")) and not re.match(r"^[a-z]+:", url):
            url = prefix + urllib.parse.quote(urllib.parse.urljoin(base_url, url), safe="")
        out.append(" ".join([url] + bits[1:]))
    return ", ".join(out)


def rewrite_attr(name, value, base_url, prefix):
    if not value:
        return value
    if value.startswith(("#", "data:", "blob:", "javascript:", "mailto:", "tel:", "about:", "file:")):
        return value
    if re.match(r"^[a-z][a-z0-9+.-]*:", value) and not value.startswith(("http://", "https://")):
        return value
    if name == "srcset":
        return rewrite_srcset(value, base_url, prefix)
    abs_url = urllib.parse.urljoin(base_url, value)
    if not abs_url.startswith(("http://", "https://")):
        return value
    return prefix + urllib.parse.quote(abs_url, safe="")


def build_attrs(attrs):
    out = ""
    for k, v in attrs:
        if v is None:
            out += ' %s' % k
        else:
            out += ' %s="%s"' % (k, html.escape(v, quote=True))
    return out


class PageRewriter(HTMLParser):
    def __init__(self, base_url, prefix):
        super().__init__(convert_charrefs=True)
        self.base = base_url
        self.prefix = prefix
        self.parts = []
        self.skip = 0
        self.head_done = False
        self._buf = []

    def _emit(self, s):
        self._buf.append(s)

    def flush_buf(self):
        if self._buf:
            self.parts.append(("raw", "".join(self._buf)))
            self._buf = []

    def _flush_text(self):
        if self._buf:
            chunk = "".join(self._buf).strip()
            self._buf = []
            if len(chunk) >= 2 and LETTER_RE.search(chunk) and len(chunk) <= 1500:
                self.parts.append(("text", chunk))
            elif chunk:
                self.parts.append(("raw", chunk))

    def handle_data(self, data):
        if self.skip:
            self._emit(data)
        else:
            self._buf.append(data)

    def handle_starttag(self, tag, attrs):
        self._flush_text()
        if tag in SKIP_TEXT_TAGS:
            self.skip += 1
        if tag == "head" and not self.head_done:
            self.head_done = True
            self._emit("<head" + build_attrs(attrs) + ">")
            self._emit('<base href="%s">' % html.escape(self.base, quote=True))
            return
        new_attrs = [(k, rewrite_attr(k, v, self.base, self.prefix)) for k, v in attrs]
        self._emit("<" + tag + build_attrs(new_attrs) + ">")

    def handle_startendtag(self, tag, attrs):
        self._flush_text()
        new_attrs = [(k, rewrite_attr(k, v, self.base, self.prefix)) for k, v in attrs]
        self._emit("<" + tag + build_attrs(new_attrs) + "/>")

    def handle_endtag(self, tag):
        self._flush_text()
        if tag in SKIP_TEXT_TAGS and self.skip > 0:
            self.skip -= 1
        self._emit("</%s>" % tag)


def rewrite_css(text, base_url, prefix):
    def sub(m):
        url = m.group(1)
        if url.startswith(("#", "data:", "/")):
            # absolute path /... still needs rewriting
            pass
        abs_url = urllib.parse.urljoin(base_url, url)
        if abs_url.startswith(("http://", "https://")):
            return 'url("%s")' % (prefix + urllib.parse.quote(abs_url, safe=""))
        return m.group(0)
    text = re.sub(r"url\(\s*['\"]?(.*?)['\"]?\s*\)", sub, text, flags=re.I)
    text = re.sub(r"@import\s+['\"](.*?)['\"]", lambda m: '@import "%s"' % (prefix + urllib.parse.quote(urllib.parse.urljoin(base_url, m.group(1)), safe="")), text, flags=re.I)
    return text


def proxy_fetch(url, to, method="GET", body=None, content_type=None):
    check_target(url)
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 EilatanLingo")
    req.add_header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    req.add_header("Accept-Encoding", "identity")
    if content_type:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=25) as resp:
        final_url = resp.geturl()
        ctype = resp.headers.get("Content-Type", "application/octet-stream").split(";")[0].lower()
        raw = resp.read(5 * 1024 * 1024 + 1)
        if len(raw) > 5 * 1024 * 1024:
            raise ValueError("response too large")
        return final_url, ctype, raw


def proxy_html(final_url, raw, to):
    charset = "utf-8"
    text = raw.decode(charset, errors="replace")
    parser = PageRewriter(final_url, "/proxy?url=")
    parser.feed(text)
    parser.flush_buf()
    parser._flush_text()

    texts = [p[1] for p in parser.parts if p[0] == "text"]
    unique = list(dict.fromkeys(texts))[:1500]
    mapping = {}
    if unique:
        try:
            with _SEM:
                results = ENGINE.translate(unique, "auto", to)
            for u, (tx, _det) in zip(unique, results):
                if tx and tx != u:
                    mapping[u] = tx
        except Exception as e:
            sys.stderr.write("proxy translate error: %s\n" % e)

    out = []
    for p in parser.parts:
        if p[0] == "raw":
            out.append(p[1])
        else:
            out.append(html.escape(mapping.get(p[1], p[1]), quote=False))
    return "".join(out).encode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "EilatanLingo/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _json(self, code, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, code, msg):
        try:
            payload = json.dumps({"error": msg}).encode("utf-8")
        except Exception:
            payload = str(msg).encode("utf-8", errors="replace")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            self._json(200, {
                "ok": True, "version": VERSION, "engine": ENGINE.name,
                "cache": len(CACHE), "uptime": int(time.time() - START_TIME),
            })
            return
        if parsed.path == "/proxy":
            q = urllib.parse.parse_qs(parsed.query)
            url = (q.get("url") or [""])[0]
            to = (q.get("to") or ["en"])[0][:8]
            if not url:
                self._error(400, "missing ?url=")
                return
            try:
                final_url, ctype, raw = proxy_fetch(url, to)
            except ValueError as e:
                self._error(400, str(e))
                return
            except Exception as e:
                self._error(502, "upstream error: %s" % e)
                return
            self._send_proxied(final_url, ctype, raw, to)
            return
        if parsed.path == "/":
            self._send_root()
            return
        self._error(404, "not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/translate":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if length > 2 * 1024 * 1024:
                    raise ValueError("too large")
                body = json.loads(self.rfile.read(length) or b"{}")
            except Exception as e:
                self._error(400, "bad json: %s" % e)
                return
            texts = body.get("texts")
            if not isinstance(texts, list):
                self._error(400, "texts must be a list")
                return
            texts = [str(t)[:4500] for t in texts][:50]
            from_ = str(body.get("from") or "auto")[:8]
            to = str(body.get("to") or "en")[:8]
            detect = bool(body.get("detect"))
            tx, det = translate_batch(texts, from_, to, detect)
            self._json(200, {"translations": tx, "detections": det})
            return
        if parsed.path == "/proxy":
            q = urllib.parse.parse_qs(parsed.query)
            url = (q.get("url") or [""])[0]
            to = (q.get("to") or ["en"])[0][:8]
            if not url:
                self._error(400, "missing ?url=")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else None
                final_url, ctype, raw = proxy_fetch(url, to, method="POST", body=body,
                                                    content_type=self.headers.get("Content-Type"))
            except ValueError as e:
                self._error(400, str(e))
                return
            except Exception as e:
                self._error(502, "upstream error: %s" % e)
                return
            self._send_proxied(final_url, ctype, raw, to)
            return
        self._error(404, "not found")

    def _send_proxied(self, final_url, ctype, raw, to):
        if ctype == "text/html" or ctype.endswith("+html"):
            try:
                raw = proxy_html(final_url, raw, to)
                ctype = "text/html"
            except Exception as e:
                sys.stderr.write("html rewrite error: %s\n" % e)
        elif ctype == "text/css":
            try:
                raw = rewrite_css(raw.decode("utf-8", errors="replace"), final_url, "/proxy?url=").encode("utf-8", errors="replace")
            except Exception:
                pass
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def _send_root(self):
        page = """<!doctype html><html><head><meta charset="utf-8">
<title>Eilatan Lingo — local server</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#e8e6f0;background:#16131f}
code{background:#221d31;padding:2px 6px;border-radius:6px;border:1px solid #322b45}
a{color:#c084fc}.ok{color:#6ee7b7}</style></head><body>
<h1>Eilatan Lingo local server</h1>
<p>Engine: <code>%s</code> · cache: <code>%d</code> entries · up %ds</p>
<h3>1. Live translation endpoint (used by the extension)</h3>
<p><code>POST /api/translate</code> with <code>{&quot;texts&quot;:[...],&quot;from&quot;:&quot;auto&quot;,&quot;to&quot;:&quot;en&quot;,&quot;detect&quot;:true}</code></p>
<h3>2. Download &amp; refeed proxy (classic sites)</h3>
<p><a href="/proxy?url=https://example.com/">/proxy?url=https://example.com/</a></p>
<p>Add <code>&amp;to=fr</code> to change the output language. Load it in the browser, or set it as your home page.</p>
<h3>Status</h3>
<p><span class="ok">●</span> <a href="/api/health">/api/health</a></p>
</body></html>""" % (ENGINE.name, len(CACHE), int(time.time() - START_TIME))
        raw = page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


START_TIME = time.time()


def main():
    ap = argparse.ArgumentParser(description="Eilatan Lingo local companion server")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--engine", default="google",
                    choices=["google", "libre", "deepl", "offline"])
    ap.add_argument("--api-key", default="")
    ap.add_argument("--libre-url", default="", help="LibreTranslate base URL, e.g. https://libretranslate.example")
    ap.add_argument("--deepl-url", default="", help="DeepL API URL (default: free tier)")
    args = ap.parse_args()

    global ENGINE
    ENGINE = make_engine(args)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    banner = "\n".join([
        "",
        "  Eilatan Lingo local server v%s" % VERSION,
        "  engine:      %s" % ENGINE.name,
        "  live API:    http://%s:%d/api/translate" % (args.host, args.port),
        "  proxy mode:  http://%s:%d/proxy?url=https://example.com/" % (args.host, args.port),
        "  Ctrl+C to stop",
        "",
    ])
    print(banner)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye~")
        server.shutdown()


if __name__ == "__main__":
    main()
