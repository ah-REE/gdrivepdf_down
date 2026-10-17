#!/usr/bin/env python3
"""
gdrive_down.py — Google Drive PDF/PPT downloader.

Downloads PDF / PPT / PPTX (and other) files from a Google Drive share link.

Strategies (mode=auto tries in order):
  direct  - public-file download via drive.usercontent.google.com,
            handling the virus-scan "confirm" interstitial used for
            larger files.
  export  - native Google formats (Docs -> PDF, Slides -> PPTX/PDF,
            Sheets -> XLSX) via docs.google.com export endpoints.
  viewer  - Google's own preview pipeline, server-side and browser-free:
            the preview page mints a one-scope token, viewer/upload
            returns signed URLs, then either the original bytes ('pdf'
            key) or Google-rendered page images (up to 3200px) are
            fetched. The page route covers view-only files.
  capture - view-only / download-disabled PDFs: starts a tiny local HTTP
            receiver; you paste a generated console script into the browser
            tab that shows the Drive preview; the script sends each rendered
            page image back to localhost and this tool stitches all pages
            into a single PDF.

Only content the link already lets a browser open can be retrieved.
Use responsibly and only for content you have the right to keep.
"""

import argparse
import base64
import html as html_mod
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import requests
except ImportError:
    print("Missing dependency: requests.  Install with:  pip install requests")
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    Image = None

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

ID_RE = re.compile(r"^[A-Za-z0-9_-]{25,}$")

# HTML markers (lowercased) that explain WHY a direct download did not work.
HTML_MARKERS = [
    ("accounts.google.com", "auth-required"),
    ("google drive: sign-in", "auth-required"),
    ("sign in to continue", "auth-required"),
    ("you need access", "needs-access"),
    ("request access", "needs-access"),
    ("can't view or download this file at this time", "download-blocked"),
    ("unable to download", "download-blocked"),
    ("download permission", "download-blocked"),
    ("does not exist", "not-found"),
    ("file not found", "not-found"),
    ("quota exceeded", "quota"),
    ("too many users have viewed or downloaded", "quota"),
]


# --------------------------------------------------------------------------
# Link parsing
# --------------------------------------------------------------------------

def parse_file_id(link):
    """Return (file_id, kind) for a Drive URL or raw id, else (None, None).

    kind is one of: 'file', 'document', 'presentation', 'spreadsheets',
    'forms'.
    """
    link = (link or "").strip().strip('"').strip("'")
    if not link:
        return None, None
    if ID_RE.match(link):
        return link, "file"

    # Native Google formats first (more specific than the generic /d/<ID>).
    m = re.search(
        r"docs\.google\.com/(document|presentation|spreadsheets|forms)"
        r"/d/([A-Za-z0-9_-]{25,})",
        link,
    )
    if m:
        return m.group(2), m.group(1)

    m = re.search(r"/file/d/([A-Za-z0-9_-]{25,})", link)
    if m:
        return m.group(1), "file"

    m = re.search(r"[?&]id=([A-Za-z0-9_-]{25,})", link)
    if m:
        return m.group(1), "file"

    # Generic docs.google.com/.../d/<ID>/ or drive.google.com/drive/.../d/<ID>
    m = re.search(r"/d/([A-Za-z0-9_-]{25,})", link)
    if m:
        return m.group(1), "file"

    return None, None


def is_folder_link(link):
    return bool(re.search(r"/folders/|/drive/(?:u/\d+/)?folders", link or ""))


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def new_session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
    return s


def sanitize_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "").strip(" .")
    return name[:180] or "download"


def unique_path(path):
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    for i in range(1, 1000):
        cand = "%s(%d)%s" % (stem, i, ext)
        if not os.path.exists(cand):
            return cand
    return path + ".new"


def parse_download_form(page_html):
    """Parse the virus-scan interstitial form.

    Returns (action_url_or_None, params_dict) or (None, None).
    """
    if not page_html or "<input" not in page_html.lower():
        return None, None
    params = {}
    for tag in re.findall(r"<input[^>]*>", page_html, flags=re.I):
        nm = re.search(r'name=["\']([^"\']+)["\']', tag, flags=re.I)
        vl = re.search(r'value=["\']([^"\']*)["\']', tag, flags=re.I)
        if nm:
            params[nm.group(1)] = vl.group(1) if vl else ""
    if "id" not in params or not ("confirm" in params or "uuid" in params):
        return None, None
    action = None
    fm = re.search(r'<form[^>]*action=["\']([^"\']+)["\']', page_html, flags=re.I)
    if fm:
        action = fm.group(1)
    return action, params


def classify_html(page_html):
    low = (page_html or "").lower()
    for marker, reason in HTML_MARKERS:
        if marker in low:
            return reason
    return "unknown"


def filename_from_headers(headers):
    cd = headers.get("Content-Disposition") or ""
    m = re.search(r"filename\*=UTF-8''([^;]+)", cd, flags=re.I)
    if m:
        from urllib.parse import unquote
        return html_mod.unescape(unquote(m.group(1))).strip('" ')
    m = re.search(r'filename=["\']?([^"\';]+)', cd, flags=re.I)
    if m:
        return html_mod.unescape(m.group(1)).strip('" ')
    return None


def title_from_view_page(session, file_id):
    """Best-effort file title from the Drive view page."""
    try:
        r = session.get(
            "https://drive.google.com/file/d/%s/view" % file_id,
            timeout=15,
        )
        m = re.search(r"<title>(.*?)</title>", r.text, flags=re.S | re.I)
        if not m:
            return None
        title = html_mod.unescape(m.group(1)).strip()
        title = re.sub(
            r"\s*-\s*Google (Drive|Docs|Sheets|Slides|Forms)\s*$", "", title
        )
        return title or None
    except Exception:
        return None


def sniff_type(path):
    """Return (family, ext) from file content.

    family: pdf | pptx | docx | xlsx | zip | bin
    """
    try:
        with open(path, "rb") as f:
            head = f.read(8)
    except OSError:
        return "bin", "bin"
    if head.startswith(b"%PDF-"):
        return "pdf", "pdf"
    if head.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as z:
                names = set(z.namelist())
            if any(n.startswith("ppt/") for n in names):
                return "pptx", "pptx"
            if any(n.startswith("word/") for n in names):
                return "docx", "docx"
            if any(n.startswith("xl/") for n in names):
                return "xlsx", "xlsx"
            return "zip", "zip"
        except zipfile.BadZipFile:
            return "zip", "zip"
    return "bin", "bin"


# --------------------------------------------------------------------------
# Strategy A: direct download
# --------------------------------------------------------------------------

def strategy_direct(session, file_id, dest_dir, name_hint=None, verbose=False,
                    progress_cb=None):
    """Try direct download.  Returns (status, payload).

    status 'ok'   -> payload = saved file path
    status 'fail' -> payload = reason string

    progress_cb(done_bytes, total_bytes_or_None) is called during streaming
    when provided (used by the web app for live progress events).
    """
    session = session or new_session()
    candidates = [
        ("https://drive.usercontent.google.com/download",
         {"id": file_id, "export": "download"}),
        ("https://drive.google.com/uc",
         {"id": file_id, "export": "download"}),
    ]
    last_reason = "unknown"
    for base_url, params in candidates:
        try:
            r = session.get(base_url, params=params, stream=True, timeout=(15, 120))
        except requests.RequestException:
            last_reason = "network-error"
            continue

        if r.status_code == 403:
            r.close()
            last_reason = "download-blocked"
            continue
        if r.status_code in (400, 404):
            r.close()
            last_reason = "not-found"
            continue
        if r.status_code != 200:
            r.close()
            last_reason = "http-%d" % r.status_code
            continue

        ctype = (r.headers.get("Content-Type") or "").lower()
        head = next(r.iter_content(chunk_size=1 << 16), b"")
        low_head = head[:256].lstrip().lower()
        looks_html = (
            ctype.startswith("text/html")
            or low_head.startswith(b"<html")
            or low_head.startswith(b"<!doctype")
        )
        if looks_html:
            page = head.decode("utf-8", "ignore") + r.content.decode("utf-8", "ignore")
            r.close()
            action, form = parse_download_form(page)
            if form:
                # Virus-scan interstitial: re-request with the form fields.
                url = action or base_url
                merged = dict(params)
                merged.update(form)
                try:
                    r2 = session.get(url, params=merged, stream=True, timeout=(15, 120))
                except requests.RequestException:
                    last_reason = "network-error"
                    continue
                if r2.status_code != 200:
                    r2.close()
                    last_reason = "http-%d" % r2.status_code
                    continue
                return _save_binary(r2, file_id, dest_dir, name_hint, verbose,
                                    progress_cb=progress_cb)
            last_reason = classify_html(page)
            continue

        # Binary response — save it, keeping the already-read head chunk.
        return _save_binary(r, file_id, dest_dir, name_hint, verbose,
                            pre_chunks=[head] if head else [],
                            progress_cb=progress_cb)

    return ("fail", last_reason)


def _save_binary(resp, file_id, dest_dir, name_hint, verbose, pre_chunks=None,
                 progress_cb=None):
    fname = filename_from_headers(resp.headers) or name_hint
    if not fname:
        fname = title_from_view_page(new_session(), file_id) or file_id
    dest = unique_path(os.path.join(dest_dir, sanitize_filename(fname)))
    total = resp.headers.get("Content-Length")
    total = int(total) if total and total.isdigit() else None
    done = 0
    next_report = 0
    with open(dest, "wb") as f:
        for chunk in (pre_chunks or []):
            f.write(chunk)
            done += len(chunk)
        for chunk in resp.iter_content(chunk_size=1 << 16):
            if chunk:
                f.write(chunk)
                done += len(chunk)
                if progress_cb:
                    progress_cb(done, total)
                if done >= next_report:
                    if total:
                        sys.stdout.write(
                            "\r  downloaded %.1f / %.1f MB"
                            % (done / 1e6, total / 1e6)
                        )
                    else:
                        sys.stdout.write("\r  downloaded %.1f MB" % (done / 1e6))
                    sys.stdout.flush()
                    next_report = done + (4 << 20)
    if done:
        sys.stdout.write("\n")
        sys.stdout.flush()
    if progress_cb:
        progress_cb(done, total)
    resp.close()
    return ("ok", dest)


# --------------------------------------------------------------------------
# Strategy B: native Google format export
# --------------------------------------------------------------------------

EXPORT_FORMATS = {
    "document": ["pdf"],
    "presentation": ["pptx", "pdf"],
    "spreadsheets": ["xlsx"],
}


def strategy_export(session, kind, file_id, dest_dir, name_hint=None, verbose=False,
                    progress_cb=None):
    formats = EXPORT_FORMATS.get(kind)
    if not formats:
        return ("fail", "not-a-native-doc")
    fmt = formats[0]
    if name_hint and name_hint.lower().endswith(".pdf") and kind == "presentation":
        fmt = "pdf"
    url = "https://docs.google.com/%s/d/%s/export?format=%s" % (
        kind, file_id, fmt
    )
    session = session or new_session()
    try:
        r = session.get(url, stream=True, timeout=(15, 120))
    except requests.RequestException:
        return ("fail", "network-error")
    if r.status_code != 200:
        r.close()
        return ("fail", "export-http-%d" % r.status_code)
    ctype = (r.headers.get("Content-Type") or "").lower()
    head = next(r.iter_content(chunk_size=1 << 16), b"")
    low_head = head[:256].lstrip().lower()
    if (
        ctype.startswith("text/html")
        or low_head.startswith(b"<html")
        or low_head.startswith(b"<!doctype")
    ):
        r.close()
        return ("fail", "export-blocked")
    fname = name_hint or (title_from_view_page(session, file_id) or file_id)
    if not fname.lower().endswith("." + fmt):
        fname = fname + "." + fmt
    dest = unique_path(os.path.join(dest_dir, sanitize_filename(fname)))
    done = 0
    total = r.headers.get("Content-Length")
    total = int(total) if total and total.isdigit() else None
    with open(dest, "wb") as f:
        if head:
            f.write(head)
            done += len(head)
        for chunk in r.iter_content(chunk_size=1 << 16):
            if chunk:
                f.write(chunk)
                done += len(chunk)
                if progress_cb:
                    progress_cb(done, total)
    r.close()
    return ("ok", dest)


# --------------------------------------------------------------------------
# Strategy C: viewer pipeline (Google's own preview renderer, server-side)
# --------------------------------------------------------------------------

def _viewer_base():
    return os.environ.get("GDD_VIEWER_BASE", "https://drive.google.com").rstrip("/")


def _rand_fssid():
    import random
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return "1" + "".join(random.choice(alphabet) for _ in range(28))


def _jparse_goog(text):
    """Strip Google's XSSI guard and parse the JSON body."""
    if text.startswith(")]}'"):
        text = text.split("\n", 1)[1]
    return json.loads(text)


def viewer_bootstrap(session, file_id, verbose=False):
    """Bootstrap the Drive viewer session for a file id.

    Returns (cfg, preview_url, fssid). cfg keys: pdf (signed original
    bytes URL), meta, page, presspage, ...  Raises RuntimeError(reason).
    """
    base = _viewer_base()
    prev = "%s/file/d/%s/preview" % (base, file_id)
    r = session.get(prev, timeout=(15, 60))
    if r.status_code != 200:
        raise RuntimeError("viewer-preview-http-%d" % r.status_code)
    m = re.search(r"viewer/upload\?ds\\u003d([A-Za-z0-9_%.-]+)", r.text)
    if not m:
        m = re.search(r"viewer/upload\?ds=([A-Za-z0-9_%.-]+)", r.text)
    if not m:
        raise RuntimeError("viewer-no-token")
    ds = m.group(1)
    fssid = _rand_fssid()
    url = ("%s/viewer/upload?ds=%s&ck=drive&dsmi=texmex&p=proj&fssid=%s"
           % (base, ds, fssid))
    u = session.get(url, headers={"Referer": base + "/"}, timeout=(15, 60))
    if u.status_code != 200:
        raise RuntimeError("viewer-upload-http-%d" % u.status_code)
    cfg = _jparse_goog(u.text)
    if verbose:
        print("  viewer bootstrap keys: %s" % ", ".join(sorted(cfg)))
    return cfg, prev, fssid


def _sniff_bytes(data):
    """Return (family, ext) for an in-memory blob."""
    if data.startswith(b"%PDF-"):
        return "pdf", "pdf"
    if data.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                names = set(z.namelist())
            if any(n.startswith("ppt/") for n in names):
                return "pptx", "pptx"
            if any(n.startswith("word/") for n in names):
                return "docx", "docx"
            if any(n.startswith("xl/") for n in names):
                return "xlsx", "xlsx"
            return "zip", "zip"
        except zipfile.BadZipFile:
            return "zip", "zip"
    return "bin", "bin"


def _ensure_extension(path, ext):
    if path.lower().endswith("." + ext.lower()):
        return path
    root, cur = os.path.splitext(path)
    if cur.lower() in ("", ".bin", ".download", ".tmp"):
        return unique_path(path + "." + ext)
    return unique_path(root + "." + ext)


def _write_viewer_page(tmp_dir, n, raw):
    """Persist one rendered page, normalising WEBP/odd PNG modes."""
    if raw[:2] == b"\xff\xd8":
        ext, data = "jpg", raw
    elif raw[:4] == b"\x89PNG":
        ext, data = "png", raw
        if Image is not None:
            try:
                im = Image.open(io.BytesIO(raw))
                if im.mode not in ("RGB", "L"):
                    buf = io.BytesIO()
                    im.convert("RGB").save(buf, "PNG")
                    data = buf.getvalue()
            except Exception:
                pass
    else:
        if Image is None:
            raise RuntimeError("Pillow is required to convert viewer page images.")
        im = Image.open(io.BytesIO(raw))
        im.load()
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=92)
        ext, data = "jpg", buf.getvalue()
    path = os.path.join(tmp_dir, "page_%05d.%s" % (n, ext))
    with open(path, "wb") as f:
        f.write(data)
    return path


def _stitch_image_files(paths, out_path):
    try:
        import img2pdf
        data = img2pdf.convert(paths)
        with open(out_path, "wb") as f:
            f.write(data)
        return len(paths)
    except ImportError:
        pass
    except Exception:
        pass
    if Image is None:
        raise RuntimeError("Pillow or img2pdf is required to stitch pages.")
    images = []
    for p in paths:
        im = Image.open(p)
        im.load()
        images.append(im.convert("RGB"))
    images[0].save(out_path, "PDF", save_all=True, append_images=images[1:],
                   resolution=192.0, quality=92)
    return len(images)


def strategy_viewer(session, file_id, dest_dir, name_hint=None, verbose=False,
                    progress_cb=None):
    """Fetch through Drive's own viewer endpoints, server-side (no browser).

    Preferred: the viewer's signed 'pdf' URL yields the original bytes.
    Download-restricted shares: Google-rendered page images (up to
    GDD_VIEWER_WIDTH px, default 3200) are stitched into a PDF.
    """
    session = session or new_session()
    base = _viewer_base()
    try:
        cfg, prev, fssid = viewer_bootstrap(session, file_id, verbose)
    except RuntimeError as e:
        return ("fail", str(e))
    except requests.RequestException:
        return ("fail", "network-error")

    # --- 1) original bytes via the viewer's signed URL ---
    pdf_url = cfg.get("pdf")
    if pdf_url and not os.environ.get("GDD_VIEWER_PAGES_ONLY"):
        try:
            r = session.get(pdf_url, stream=True, timeout=(15, 180))
        except requests.RequestException:
            r = None
        if r is not None and r.status_code == 200:
            total = r.headers.get("Content-Length")
            total = int(total) if total and total.isdigit() else None
            if total is not None and total > (400 << 20):
                r.close()
                return ("fail", "viewer-file-too-large")
            buf = io.BytesIO()
            head = b""
            try:
                for chunk in r.iter_content(chunk_size=(1 << 20)):
                    if not chunk:
                        continue
                    if not head:
                        head = chunk[:256]
                    buf.write(chunk)
                    if progress_cb:
                        progress_cb(buf.tell(), total)
            except requests.RequestException:
                head = b""
            finally:
                r.close()
            data = buf.getvalue()
            low = head.lstrip().lower()
            if data and not low.startswith((b"<", b"{")):
                family, ext = _sniff_bytes(data)
                if family != "bin":
                    fname = name_hint or (title_from_view_page(new_session(),
                                                               file_id) or file_id)
                    dest = unique_path(os.path.join(
                        dest_dir, sanitize_filename(fname)))
                    with open(dest, "wb") as f:
                        f.write(data)
                    dest = _ensure_extension(dest, ext)
                    return ("ok", dest)

    # --- 2) Google-rendered page images ---
    page_tpl = cfg.get("page")
    if not page_tpl:
        return ("fail", "viewer-no-pages")
    pages = None
    if cfg.get("meta"):
        try:
            mr = session.get(base + "/viewer/" + cfg["meta"],
                             headers={"Referer": prev}, timeout=(15, 60))
            if mr.status_code == 200:
                pages = _jparse_goog(mr.text).get("pages")
        except (requests.RequestException, ValueError):
            pass
    width = int(os.environ.get("GDD_VIEWER_WIDTH", "3200") or 3200)
    max_pages = int(os.environ.get("GDD_VIEWER_MAX_PAGES", "0") or 0)
    page_base = base + "/viewer/" + page_tpl
    fname = name_hint or (title_from_view_page(new_session(), file_id) or file_id)
    stem = sanitize_filename(fname)
    if stem.lower().endswith(".pdf"):
        stem = stem[:-4]
    out_path = unique_path(os.path.join(dest_dir, stem + ".pdf"))
    tmp_dir = tempfile.mkdtemp(prefix="gdd_viewer_")
    page_files = []
    missing = []
    n = 1
    while True:
        if pages and n > pages:
            break
        if max_pages and len(page_files) >= max_pages:
            break
        if n > 5000:
            break
        url = ("%s&auditContext=forDisplay&page=%d&w=%d&webp=true&fssid=%s"
               % (page_base, n, width, fssid))
        raw = None
        for _attempt in range(3):
            try:
                ir = session.get(url, headers={"Referer": prev},
                                 timeout=(15, 120))
            except requests.RequestException:
                time.sleep(0.4)
                continue
            if ir.status_code == 200 and len(ir.content) > 200:
                raw = ir.content
            break
        if raw is None:
            if pages:
                missing.append(n)
                n += 1
                continue
            break
        try:
            page_files.append(_write_viewer_page(tmp_dir, n, raw))
        except Exception as e:
            return ("fail", "viewer-page-%d: %s" % (n, e))
        if progress_cb:
            progress_cb(len(page_files), pages)
        if verbose or (pages and n % 10 == 0):
            sys.stdout.write("\r  page %d/%s" % (n, pages or "?"))
            sys.stdout.flush()
        n += 1
    if verbose or (pages and n > 1):
        sys.stdout.write("\n")
        sys.stdout.flush()
    if not page_files:
        return ("fail", "viewer-no-pages-fetched")
    try:
        count = _stitch_image_files(page_files, out_path)
    except Exception as e:
        return ("fail", "viewer-stitch: %s" % e)
    if missing:
        print("  [viewer] warning: %d page(s) unavailable: %s"
              % (len(missing), ", ".join(str(x) for x in missing[:12])))
    if pages and count < pages:
        print("  [viewer] %d of %d pages written." % (count, pages))
    return ("ok", out_path)


# --------------------------------------------------------------------------
# Strategy D: assisted capture for view-only / download-disabled PDFs
# --------------------------------------------------------------------------

class CaptureState:
    def __init__(self):
        self.pages = {}
        self.total = None
        self.total_hint = None
        self.lock = threading.Lock()
        self.done = threading.Event()


def make_capture_handler(state):
    class CaptureHandler(BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def _respond(self, code, body, ctype="application/json"):
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if self.path.startswith("/ping"):
                self._respond(200, b"ok", "text/plain")
            else:
                self._respond(404, b'{"ok":false}')

        def do_POST(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            raw = self.rfile.read(n) if n else b""
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:
                self._respond(400, b'{"ok":false,"error":"bad json"}')
                return

            if self.path.startswith("/page"):
                try:
                    idx = int(data.get("index", -1))
                except (TypeError, ValueError):
                    idx = -1
                data_url = data.get("dataUrl") or ""
                if idx < 0 or not data_url.startswith("data:image/"):
                    self._respond(400, b'{"ok":false,"error":"bad page"}')
                    return
                try:
                    img_bytes = base64.b64decode(data_url.split(",", 1)[1])
                except Exception:
                    self._respond(400, b'{"ok":false,"error":"bad base64"}')
                    return
                total = data.get("total")
                with state.lock:
                    state.pages[idx] = img_bytes
                    if isinstance(total, int) and total > 0 and not state.total_hint:
                        state.total_hint = total
                    count = len(state.pages)
                hint = state.total_hint or "?"
                print("  [capture] page %d received (%d of %s)"
                      % (idx + 1, count, hint))
                self._respond(200, b'{"ok":true}')

            elif self.path.startswith("/done"):
                total = data.get("total")
                with state.lock:
                    if isinstance(total, int) and total > 0:
                        state.total = total
                state.done.set()
                self._respond(200, b'{"ok":true}')

            else:
                self._respond(404, b'{"ok":false}')

        def log_message(self, fmt, *args):  # silence default request log
            pass

    return CaptureHandler


def start_capture_server(state, port):
    last_err = None
    server = None
    chosen = None
    for p in range(port, port + 21):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", p), make_capture_handler(state))
            server.daemon_threads = True
            chosen = p
            break
        except OSError as e:
            last_err = e
    if server is None:
        raise OSError("no free port near %d (%s)" % (port, last_err))
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server, chosen


def generate_capture_script(port):
    return r"""// gdrive_down capture script — paste into DevTools Console on the
// Google Drive PREVIEW tab of the view-only file, then press Enter.
// (Chrome may require typing: allow pasting   once before the first paste.)
(function () {
  'use strict';
  var PORT = __PORT__;
  var BASE = 'http://127.0.0.1:' + PORT;
  var TAG = '%c[gdrive_down]%c';
  var CSS = 'color:#0a7d3d;font-weight:bold', RST = 'color:inherit';
  function log() {
    var a = Array.prototype.slice.call(arguments);
    console.log.apply(console, [TAG + ' ' + a.shift(), CSS, RST].concat(a));
  }
  function err() {
    var a = Array.prototype.slice.call(arguments);
    console.error.apply(console, [TAG + ' ' + a.shift(), CSS, RST].concat(a));
  }
  if (window.__GDRIVE_CAPTURE_RUNNING__) { err('Already running.'); return; }
  window.__GDRIVE_CAPTURE_RUNNING__ = true;

  var IMG_SELECTOR = 'img[src^="blob:"]';

  function getPages() {
    var images = Array.prototype.slice.call(document.querySelectorAll(IMG_SELECTOR));
    if (!images.length) {
      throw new Error('No page images found. Open the file PREVIEW first and wait for page 1 to render.');
    }
    // Primary: derive page containers from the first image's parent class.
    try {
      var first = images[0].parentElement;
      var cls = first.className;
      if (cls && !cls.match(/\s/)) {
        var pages = Array.prototype.slice.call(
          first.parentElement.querySelectorAll(':scope > .' + window.CSS.escape(cls))
        );
        if (pages.length) return pages;
      }
    } catch (e) { /* fall through */ }
    // Fallback: unique image parents, sorted top-to-bottom.
    var parents = [];
    images.forEach(function (img) {
      var p = img.parentElement;
      if (p && parents.indexOf(p) === -1) parents.push(p);
    });
    parents.sort(function (a, b) {
      return (a.getBoundingClientRect().top + window.scrollY)
           - (b.getBoundingClientRect().top + window.scrollY);
    });
    return parents;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitImage(page) {
    return new Promise(function (resolve, reject) {
      var img = page.querySelector(IMG_SELECTOR);
      if (!img) {
        var obs = new MutationObserver(function () {
          var i = page.querySelector(IMG_SELECTOR);
          if (i) { obs.disconnect(); page.scrollIntoView(); resolve(i); }
        });
        obs.observe(page, { childList: true, attributes: true, subtree: true });
        page.scrollIntoView();
        return;
      }
      page.scrollIntoView();
      if (img.complete && img.naturalWidth) { resolve(img); return; }
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('An image failed to load.')); };
    });
  }

  function post(path, obj) {
    return fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj)
    }).then(function (r) { return r.json(); });
  }

  (async function main() {
    try {
      await fetch(BASE + '/ping');
    } catch (e) {
      err('Local receiver not reachable at ' + BASE +
          '. Keep the terminal running, then re-run this script.');
      window.__GDRIVE_CAPTURE_RUNNING__ = false;
      return;
    }
    var pages;
    try {
      pages = getPages();
    } catch (e) {
      err(e.message);
      window.__GDRIVE_CAPTURE_RUNNING__ = false;
      return;
    }
    var total = pages.length;
    log('Found ' + total + ' pages. Capturing — keep this tab visible and do not scroll manually.');
    for (var i = 0; i < total; i++) {
      try {
        var img = await waitImage(pages[i]);
        await sleep(150);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { throw new Error('Page ' + (i + 1) + ' has no size.'); }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0);
        var dataUrl = c.toDataURL('image/jpeg', 0.92);
        await post('/page', { index: i, total: total, dataUrl: dataUrl });
        log('Page ' + (i + 1) + '/' + total + ' sent.');
      } catch (e) {
        err('Page ' + (i + 1) + ' failed: ' + (e && e.message));
      }
    }
    await post('/done', { total: total });
    log('Done — ' + total + ' pages sent. Return to the terminal.');
    window.__GDRIVE_CAPTURE_RUNNING__ = false;
  })().catch(function (e) {
    err('Capture failed: ' + (e && e.message));
    window.__GDRIVE_CAPTURE_RUNNING__ = false;
  });
})();
""".replace("__PORT__", str(port))


def stitch_pdf(page_bytes_list, out_path, keep_dir=None):
    if keep_dir:
        os.makedirs(keep_dir, exist_ok=True)
        for i, b in enumerate(page_bytes_list):
            with open(os.path.join(keep_dir, "page_%03d.jpg" % (i + 1)), "wb") as f:
                f.write(b)
    # Preferred path: img2pdf embeds the JPEGs losslessly and streams,
    # keeping memory flat for 100-page decks on small hosts.
    try:
        import img2pdf
        data = img2pdf.convert(page_bytes_list)
        with open(out_path, "wb") as f:
            f.write(data)
        return len(page_bytes_list)
    except ImportError:
        pass
    except Exception:
        pass  # fall back to Pillow below
    if Image is None:
        raise RuntimeError(
            "Pillow or img2pdf is required to stitch captured pages into a PDF."
        )
    images = []
    bad = []
    for i, b in enumerate(page_bytes_list):
        try:
            im = Image.open(io.BytesIO(b))
            im.load()
            images.append(im.convert("RGB"))
        except Exception:
            bad.append(i)
    if bad:
        print("  [capture] warning: skipped %d unreadable page(s): %s"
              % (len(bad), ", ".join(str(i + 1) for i in bad)))
    if not images:
        raise RuntimeError("No readable page images were received.")
    images[0].save(
        out_path, "PDF", save_all=True, append_images=images[1:],
        resolution=192.0, quality=92,
    )
    return len(images)


def run_capture(session, file_id, dest_dir, name_hint=None, port=8931,
                keep_images=False, verbose=False):
    print("View-only file: assisted capture mode.")
    print("The file will be captured from your browser's preview and rebuilt as a PDF.")
    print()
    state = CaptureState()
    server, actual_port = start_capture_server(state, port)
    script = generate_capture_script(actual_port)
    script_path = os.path.join(dest_dir, "capture_script.js")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(script)

    if not name_hint:
        name_hint = title_from_view_page(session, file_id) or file_id
    base = sanitize_filename(name_hint)
    if base.lower().endswith(".pdf"):
        base = base[:-4]
    out_path = unique_path(os.path.join(dest_dir, base + ".pdf"))
    keep_dir = (os.path.splitext(out_path)[0] + "_pages") if keep_images else None

    print("  1. Open the Drive PREVIEW of the file in your browser:")
    print("       https://drive.google.com/file/d/%s/preview" % file_id)
    print("  2. Press F12 -> Console tab. (Chrome: type  allow pasting  once if paste is blocked.)")
    print("  3. Paste the capture script and press Enter. It scrolls and sends every page.")
    print("  Capture script: %s" % os.path.abspath(script_path))
    print("  Waiting for pages... (Ctrl+C finishes early with pages received so far)")

    interrupted = False
    try:
        while not state.done.is_set():
            time.sleep(0.2)
    except KeyboardInterrupt:
        interrupted = True
        print()
    finally:
        server.shutdown()
        server.server_close()

    with state.lock:
        ordered = [state.pages[i] for i in sorted(state.pages)]
        count_hint = state.total or state.total_hint
    if not ordered:
        print("  No pages were received — nothing to stitch.")
        return ("fail", "no-pages")
    if interrupted:
        print("  Finishing early with %d page(s) received." % len(ordered))
    try:
        pages_written = stitch_pdf(ordered, out_path, keep_dir)
    except Exception as e:
        return ("fail", "stitch-failed: %s" % e)
    size = os.path.getsize(out_path)
    if count_hint and pages_written < count_hint:
        print("  [capture] warning: %d of %s pages captured."
              % (pages_written, count_hint))
    print("  [OK] %s  (%d page(s), %.2f MB)"
          % (os.path.abspath(out_path), pages_written, size / 1e6))
    return ("ok", out_path)


# --------------------------------------------------------------------------
# Pipeline
# --------------------------------------------------------------------------

def report_result(path):
    family, ext = sniff_type(path)
    pretty = {"pdf": "PDF document", "pptx": "PowerPoint (.pptx)",
              "docx": "Word document (.docx)", "xlsx": "Excel workbook (.xlsx)",
              "zip": "zip archive", "bin": "binary file"}.get(family, family)
    size = os.path.getsize(path)
    print("  [OK] %s" % os.path.abspath(path))
    print("  Type: %s | Size: %.2f MB" % (pretty, size / 1e6))
    if family == "bin":
        print("  Note: unrecognized file type — verify the link and the content.")


REASON_HINTS = {
    "auth-required": "This file is not public: Google redirected to a sign-in page. Only link-viewable files work here (capture mode also needs the file to open in your signed-in browser).",
    "needs-access": "The file is private. Share it as 'Anyone with the link -> Viewer' and retry, or use capture mode (the file must at least be viewable).",
    "download-blocked": "The owner disabled downloads. The viewer pipeline rebuilds the file from Google's own page renders; capture mode is the last resort.",
    "viewer-no-token": "This file has no Drive preview bootstrap — it may not be previewable or may need sign-in.",
    "viewer-no-pages": "The viewer exposed neither the original file nor page renders for this link.",
    "viewer-preview-http-403": "Google refused the preview request — the file is likely not link-viewable.",
    "viewer-upload-http-400": "The viewer session was rejected — usually a non-previewable file.",
    "not-found": "The link is wrong or the file was deleted.",
    "quota": "Google temporarily limited this file's traffic. Try again later.",
    "export-blocked": "Export is blocked for this account/file.",
    "not-a-native-doc": "Export mode only applies to docs.google.com document/presentation/sheets links.",
    "network-error": "Network problem — check connectivity.",
}


def process_link(link, out_dir=".", name=None, mode="auto", port=8931,
                 keep_images=False, verbose=False):
    os.makedirs(out_dir, exist_ok=True)
    if is_folder_link(link):
        print("[!] Folder links are not supported — paste a single file link.")
        return 1
    file_id, kind = parse_file_id(link)
    if not file_id:
        print("[!] Could not find a Drive file id in: %r" % link)
        return 1
    print("File id: %s (kind: %s)" % (file_id, kind or "file"))

    reason = None
    if mode in ("auto", "direct"):
        print("[1/4] Direct download...")
        status, payload = strategy_direct(None, file_id, out_dir, name, verbose)
        if status == "ok":
            report_result(payload)
            return 0
        reason = payload
        print("  direct failed: %s" % payload)

    if mode in ("auto", "export"):
        if kind in EXPORT_FORMATS:
            print("[2/4] Native export (docs.google.com)...")
            status, payload = strategy_export(new_session(), kind, file_id,
                                              out_dir, name, verbose)
            if status == "ok":
                report_result(payload)
                return 0
            reason = payload
            print("  export failed: %s" % payload)
        else:
            print("[2/4] Native export skipped (not a docs.google.com native type).")

    if mode in ("auto", "viewer"):
        print("[3/4] Viewer pipeline (Google's own preview endpoints)...")
        status, payload = strategy_viewer(None, file_id, out_dir, name, verbose)
        if status == "ok":
            report_result(payload)
            return 0
        reason = payload
        print("  viewer failed: %s" % payload)

    if mode in ("auto", "capture"):
        print("[4/4] Assisted browser capture...")
        status, payload = run_capture(new_session(), file_id, out_dir, name,
                                      port, keep_images, verbose)
        if status == "ok":
            return 0
        print("[!] Capture failed: %s" % payload)
        return 1

    print("[!] Download failed: %s" % reason)
    hint = REASON_HINTS.get(reason)
    if hint:
        print("    %s" % hint)
    return 1


def interactive():
    print("=" * 64)
    print(" Google Drive PDF/PPT Downloader")
    print(" Paste a Drive link (file links only). Enter an empty line to quit.")
    print("=" * 64)
    while True:
        try:
            link = input("\nDrive link> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not link or link.lower() in ("q", "quit", "exit"):
            return 0
        out = input("Output directory [Enter = current folder]> ").strip() or "."
        try:
            process_link(link, out_dir=out)
        except Exception as e:
            print("[!] Unexpected error: %s" % e)


# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------

def _self_test():
    failures = []

    def check(label, fn):
        try:
            fn()
            print("  [PASS] %s" % label)
        except AssertionError as e:
            print("  [FAIL] %s — %s" % (label, e))
            failures.append(label)
        except Exception as e:
            print("  [FAIL] %s — unexpected: %s" % (label, e))
            failures.append(label)

    ID = "aB3xY9qLm2VtR7sK1pZ0wQ5nD"  # 25 chars

    def t_parse():
        cases = [
            ("https://drive.google.com/file/d/%s/view?usp=sharing" % ID, ID, "file"),
            ("https://drive.google.com/open?id=%s" % ID, ID, "file"),
            ("https://drive.google.com/uc?id=%s&export=download" % ID, ID, "file"),
            ("https://drive.usercontent.google.com/download?id=%s&export=download" % ID, ID, "file"),
            ("https://docs.google.com/document/d/%s/edit" % ID, ID, "document"),
            ("https://docs.google.com/presentation/d/%s/present" % ID, ID, "presentation"),
            ("https://docs.google.com/spreadsheets/d/%s/htmlview" % ID, ID, "spreadsheets"),
            ('"%s"' % ID, ID, "file"),
            (ID, ID, "file"),
            ("https://drive.google.com/file/d/%s/preview" % ID, ID, "file"),
        ]
        for link, want_id, want_kind in cases:
            got_id, got_kind = parse_file_id(link)
            assert (got_id, got_kind) == (want_id, want_kind), (link, got_id, got_kind)
        assert parse_file_id("https://example.com/nothing")[0] is None

    def t_magic():
        def make_zip(names):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                for n in names:
                    z.writestr(n, b"x")
            return buf.getvalue()

        with tempfile.TemporaryDirectory(prefix="gdrive_down_test_") as tmp:
            def write_and_sniff(data):
                p = os.path.join(tmp, "f.bin")
                with open(p, "wb") as f:
                    f.write(data)
                return sniff_type(p)

            assert write_and_sniff(b"%PDF-1.7 rest")[0] == "pdf"
            assert write_and_sniff(make_zip(["ppt/presentation.xml"]))[0] == "pptx"
            assert write_and_sniff(make_zip(["word/document.xml"]))[0] == "docx"
            assert write_and_sniff(make_zip(["xl/workbook.xml"]))[0] == "xlsx"
            assert write_and_sniff(make_zip(["other.txt"]))[0] == "zip"
            assert write_and_sniff(b"\x00\x01\x02")[0] == "bin"

    def t_interstitial():
        fixture = """
        <html><body>
        <form id="download-form" action="https://drive.usercontent.google.com/download">
          <input type="hidden" name="id" value="FILEID123">
          <input type="hidden" name="export" value="download">
          <input type="hidden" name="confirm" value="t">
          <input type="hidden" name="uuid" value="UUID-XYZ">
        </form></body></html>
        """
        action, params = parse_download_form(fixture)
        assert action == "https://drive.usercontent.google.com/download"
        assert params["id"] == "FILEID123" and params["confirm"] == "t"
        assert params["uuid"] == "UUID-XYZ"
        assert parse_download_form("<html>no form</html>") == (None, None)

    def t_classify():
        assert classify_html("<p>You need access</p>") == "needs-access"
        assert classify_html(
            "Sorry, you can't view or download this file at this time."
        ) == "download-blocked"
        assert classify_html("<p>hello</p>") == "unknown"

    def t_capture():
        if Image is None:
            raise AssertionError("Pillow not installed")

        def jpeg(color):
            buf = io.BytesIO()
            Image.new("RGB", (120, 160), color).save(buf, "JPEG")
            return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

        state = CaptureState()
        server, port = start_capture_server(state, 8931)
        try:
            base_url = "http://127.0.0.1:%d" % port
            pr = requests.get(base_url + "/ping", timeout=5)
            assert pr.status_code == 200 and pr.text == "ok"
            opts = requests.options(base_url + "/page", timeout=5)
            assert opts.status_code == 204
            assert opts.headers.get("Access-Control-Allow-Origin") == "*"
            for i, color in enumerate([(255, 0, 0), (0, 255, 0), (0, 0, 255)]):
                r = requests.post(
                    base_url + "/page",
                    json={"index": i, "total": 3, "dataUrl": jpeg(color)},
                    timeout=5,
                )
                assert r.status_code == 200 and r.json().get("ok") is True
            requests.post(base_url + "/done", json={"total": 3}, timeout=5)
            assert state.done.wait(10)
            with state.lock:
                ordered = [state.pages[i] for i in sorted(state.pages)]
            assert len(ordered) == 3
            with tempfile.TemporaryDirectory(prefix="gdrive_down_test_") as tmp:
                out_pdf = os.path.join(tmp, "stitched.pdf")
                n = stitch_pdf(ordered, out_pdf)
                assert n == 3
                with open(out_pdf, "rb") as f:
                    data = f.read()
                assert data.startswith(b"%PDF")
                pages = len(re.findall(rb"/Type\s*/Page\b", data))
                assert pages == 3, "expected 3 pages, found %d" % pages
        finally:
            server.shutdown()
            server.server_close()

    def t_viewer():
        """Viewer pipeline against a local mock of Google's endpoints."""
        from http.server import BaseHTTPRequestHandler

        if Image is None:
            raise AssertionError("Pillow not installed")
        TOKEN = "ACFrOgTESTTOKENabc123"

        def png(color):
            buf = io.BytesIO()
            Image.new("RGB", (80, 100), color).save(buf, "PNG")
            return buf.getvalue()

        class MockHandler(BaseHTTPRequestHandler):
            def _send(self, code, body, ctype="text/html; charset=utf-8"):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                port = self.server.server_address[1]
                path = self.path
                if "/file/d/" in path and path.endswith("/preview"):
                    body = ('<html><script>var u="http://127.0.0.1:%d/viewer/'
                            'upload?ds\\u003d%s&ck=drive";</script></html>'
                            % (port, TOKEN)).encode()
                    self._send(200, body)
                elif path.startswith("/viewer/upload"):
                    body = (')]}\'\n{"meta":"meta?id=%s&dsmi=texmex",'
                            '"page":"img?id=%s&dsmi=texmex"%s}'
                            % (TOKEN, TOKEN,
                               ',"pdf":"http://127.0.0.1:%d/file.bin"' % port
                               if self.server.include_pdf else ""))
                    self._send(200, body.encode(), "application/json")
                elif path.startswith("/viewer/meta"):
                    self._send(200, b')]}\'\n{"pages":3,"maxPageWidth":3200}',
                               "application/json")
                elif path.startswith("/viewer/img"):
                    m = re.search(r"page=(\d+)", path)
                    n = int(m.group(1)) if m else 0
                    colors = {1: (250, 10, 10), 2: (10, 250, 10),
                              3: (10, 10, 250)}
                    if n in colors:
                        self._send(200, png(colors[n]), "image/png")
                    else:
                        self._send(404, b"no")
                elif path.startswith("/file.bin"):
                    self._send(200, b"%PDF-1.4\n1 0 obj\n<</Type/Page>>\n"
                               b"endobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n",
                               "application/pdf")
                else:
                    self._send(404, b"nope")

            def log_message(self, *a):
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        httpd.include_pdf = True
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        port = httpd.server_address[1]
        old_base = os.environ.get("GDD_VIEWER_BASE")
        os.environ["GDD_VIEWER_BASE"] = "http://127.0.0.1:%d" % port
        try:
            with tempfile.TemporaryDirectory(prefix="gdrive_down_viewer_") as tmp:
                st, payload = strategy_viewer(new_session(), "aB3xY9qLm2VtR7sK1pZ0wQ5nD",
                                              tmp, "orig.pdf")
                assert st == "ok", (st, payload)
                with open(payload, "rb") as f:
                    data = f.read()
                assert data.startswith(b"%PDF-1.4"), data[:16]
                httpd.include_pdf = False
                st, payload = strategy_viewer(new_session(), "aB3xY9qLm2VtR7sK1pZ0wQ5nD",
                                              tmp, "pages")
                assert st == "ok", (st, payload)
                with open(payload, "rb") as f:
                    data = f.read()
                assert data.startswith(b"%PDF"), data[:16]
                pages = len(re.findall(rb"/Type\s*/Page\b", data))
                assert pages == 3, "expected 3 pages, found %d" % pages
        finally:
            httpd.shutdown()
            httpd.server_close()
            if old_base is None:
                os.environ.pop("GDD_VIEWER_BASE", None)
            else:
                os.environ["GDD_VIEWER_BASE"] = old_base

    print("Running self-test...")
    check("link parsing (10 shapes)", t_parse)
    check("magic-byte type sniffing", t_magic)
    check("virus-scan interstitial parsing", t_interstitial)
    check("blocked-page classification", t_classify)
    check("capture server + stitch pipeline", t_capture)
    check("viewer pipeline (mock endpoints)", t_viewer)
    if failures:
        print("SELF-TEST FAILED: %s" % ", ".join(failures))
        return 1
    print("All self-tests passed.")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="gdrive_down",
        description="Download PDF/PPT/PPTX files from a Google Drive link, "
                    "through Google's own viewer endpoints (including "
                    "view-only files) or assisted browser capture.",
    )
    ap.add_argument("link", nargs="?", help="Google Drive file link or file id")
    ap.add_argument("-o", "--out", default=".", help="output directory (default: current)")
    ap.add_argument("-n", "--name", default=None, help="output file name")
    ap.add_argument("--mode", choices=["auto", "direct", "export", "viewer", "capture"],
                    default="auto", help="download strategy (default: auto)")
    ap.add_argument("--port", type=int, default=8931,
                    help="local capture receiver port (default: 8931)")
    ap.add_argument("--keep-images", action="store_true",
                    help="keep captured page images next to the PDF")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--self-test", action="store_true",
                    help="run built-in self-tests and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return _self_test()

    if not args.link:
        return interactive()

    return process_link(
        args.link,
        out_dir=args.out,
        name=args.name,
        mode=args.mode,
        port=args.port,
        keep_images=args.keep_images,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    sys.exit(main())
