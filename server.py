#!/usr/bin/env python3
"""
GDrive Down — local web app backend.

Serves a single-page React UI plus a small job API:

  POST /api/jobs            start a download job  {link, mode, name?}
  GET  /api/jobs            list jobs (history)
  GET  /api/jobs/{id}       job snapshot (events included)
  GET  /api/jobs/{id}/file  download the produced file
  WS   /ws/jobs/{id}        live event stream (snapshot + updates)
  GET  /api/health

Pipeline mirrors the CLI (gdrive_down.py): direct download -> native
export -> assisted capture. Capture is fully automated here: a Playwright
browser loads the Drive preview, scrolls through every page, collects the
rendered page images and stitches them into a PDF. No console pasting.

Local only: binds to 127.0.0.1, no telemetry, no external calls besides
Google endpoints and the local browser.
"""

import argparse
import asyncio
import base64
import os
import platform
import sys
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path

import requests
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

# This machine's Python runs with safe-path enabled (the script directory
# is not auto-added to sys.path), so make sibling modules importable here.
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import gdrive_down as gd

VERSION = "1.1.0"
HOST = os.environ.get("GDD_HOST", "127.0.0.1")
DEFAULT_PORT = 8756
# Tuning knobs for low-memory hosts (Render free tier) via env vars.
DEVICE_SCALE = float(os.environ.get("GDD_DEVICE_SCALE", "2"))
VIEWPORT_H = int(os.environ.get("GDD_VIEWPORT_H", "2000"))

ROOT = Path(__file__).resolve().parent
DOWNLOADS = ROOT / "downloads"
DIST = ROOT / "webapp" / "dist"

app = FastAPI(title="GDrive Down", version=VERSION)

# The UI can be hosted on another origin (e.g. Vercel) and call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Only one browser capture at a time (keeps RAM sane on small hosts).
CAPTURE_LOCK = threading.Lock()

MEDIA_TYPES = {
    "pdf": "application/pdf",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "zip": "application/zip",
}


# --------------------------------------------------------------------------
# Job registry
# --------------------------------------------------------------------------

@dataclass
class Job:
    id: str
    link: str
    mode: str
    name: str | None = None
    created: float = field(default_factory=time.time)
    stages: dict = field(default_factory=lambda: {
        "direct": "idle", "export": "idle", "capture": "idle"})
    events: list = field(default_factory=list)
    result: dict | None = None
    error: dict | None = None
    status: str = "queued"  # queued | running | done | error
    lock: threading.Lock = field(default_factory=threading.Lock)
    seq: int = 0

    def emit(self, ev: dict):
        with self.lock:
            ev["t"] = round(time.time() - self.created, 3)
            self.seq += 1
            ev["seq"] = self.seq
            if ev.get("type") == "stage":
                self.stages[ev["stage"]] = ev["state"]
            elif ev.get("type") == "done":
                self.status = "done"
                self.result = ev["result"]
            elif ev.get("type") == "error":
                self.status = "error"
                self.error = {
                    "message": ev.get("message", "Download failed"),
                    "hint": ev.get("hint", ""),
                }
            self.events.append(ev)

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "id": self.id,
                "link": self.link,
                "mode": self.mode,
                "status": self.status,
                "stages": dict(self.stages),
                "result": self.result,
                "error": self.error,
                "created": self.created,
                "events": list(self.events),
            }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()


def get_job(job_id: str) -> Job | None:
    with JOBS_LOCK:
        return JOBS.get(job_id)


# --------------------------------------------------------------------------
# Pipeline (runs in a worker thread per job)
# --------------------------------------------------------------------------

def _safe_title(session, file_id: str):
    try:
        return gd.title_from_view_page(session, file_id)
    except Exception:
        return None


def _make_progress_cb(job: Job, stage: str):
    last = [0.0]

    def cb(done, total):
        now = time.time()
        if now - last[0] < 0.12 and not (total and done >= total):
            return
        last[0] = now
        job.emit({"type": "progress", "stage": stage,
                  "done": int(done), "total": int(total) if total else 0})

    return cb


def _finish_ok(job: Job, path: str):
    family, _ext = gd.sniff_type(path)
    p = Path(path)
    job.emit({"type": "done", "result": {
        "name": p.name,
        "size": p.stat().st_size,
        "family": family,
        "job_id": job.id,
    }})


def run_job(job: Job):
    job.status = "running"
    DOWNLOADS.mkdir(exist_ok=True)
    last_reason = "unknown"
    try:
        file_id, kind = gd.parse_file_id(job.link)
        if not file_id:
            job.emit({"type": "error", "message": "Could not find a Drive file id in that link.",
                      "hint": "Paste a Google Drive file link (file/d/... or open?id=...)."})
            return
        session = gd.new_session()
        title = _safe_title(session, file_id)
        job.emit({"type": "meta", "file_id": file_id, "kind": kind, "title": title})

        order = ["direct", "export", "capture"] if job.mode == "auto" else [job.mode]
        ran_any = False
        for stage in order:
            if stage == "direct":
                ran_any = True
                job.emit({"type": "stage", "stage": "direct", "state": "running"})
                status, payload = gd.strategy_direct(
                    session, file_id, str(DOWNLOADS), job.name,
                    progress_cb=_make_progress_cb(job, "direct"))
                if status == "ok":
                    _finish_ok(job, payload)
                    return
                last_reason = payload
                job.emit({"type": "stage", "stage": "direct", "state": "failed",
                          "reason": payload})
            elif stage == "export":
                if kind not in gd.EXPORT_FORMATS:
                    job.emit({"type": "stage", "stage": "export", "state": "skipped"})
                    continue
                ran_any = True
                job.emit({"type": "stage", "stage": "export", "state": "running"})
                status, payload = gd.strategy_export(
                    session, kind, file_id, str(DOWNLOADS), job.name,
                    progress_cb=_make_progress_cb(job, "export"))
                if status == "ok":
                    _finish_ok(job, payload)
                    return
                last_reason = payload
                job.emit({"type": "stage", "stage": "export", "state": "failed",
                          "reason": payload})
            elif stage == "capture":
                ran_any = True
                job.emit({"type": "stage", "stage": "capture", "state": "running"})
                ok = run_capture_stage(job, file_id, title)
                if ok:
                    return
                # run_capture_stage emitted the error (or we fall through)
                return

        if not ran_any:
            job.emit({"type": "error", "message": "Nothing to do (unknown mode)."})
            return
        job.emit({"type": "error",
                  "message": "Download failed (%s)." % last_reason,
                  "hint": gd.REASON_HINTS.get(last_reason, "")})
    except Exception as e:  # noqa: BLE001 - surface everything to the UI
        job.emit({"type": "error", "message": "Unexpected error: %s" % e})


# --------------------------------------------------------------------------
# Automated capture (Playwright)
# --------------------------------------------------------------------------

class CaptureAuthNeeded(Exception):
    pass


class CaptureNoPages(Exception):
    pass


INJECT_PAGES_JS = r"""
() => {
  window.__GDD_pages = function () {
    const imgs = Array.from(document.querySelectorAll('img[src^="blob:"]'));
    if (!imgs.length) return [];
    try {
      const first = imgs[0].parentElement;
      const cls = first.className;
      if (cls && !/\s/.test(cls)) {
        const ps = Array.from(
          first.parentElement.querySelectorAll(':scope > .' + CSS.escape(cls)));
        if (ps.length) return ps;
      }
    } catch (e) { /* fall through */ }
    const seen = [];
    for (const img of imgs) {
      const p = img.parentElement;
      if (p && seen.indexOf(p) === -1) seen.push(p);
    }
    seen.sort((a, b) =>
      (a.getBoundingClientRect().top + window.scrollY) -
      (b.getBoundingClientRect().top + window.scrollY));
    return seen;
  };
  return window.__GDD_pages().length;
}
"""

CAPTURE_PAGE_JS = r"""
async (i) => {
  const pages = window.__GDD_pages ? window.__GDD_pages() : [];
  const container = pages[i];
  if (!container) return null;
  container.scrollIntoView({ block: 'center', behavior: 'instant' });
  const getImg = () => container.querySelector('img[src^="blob:"]');
  let img = getImg();
  if (!img) {
    img = await new Promise((resolve) => {
      const t0 = Date.now();
      const obs = new MutationObserver(() => {
        const found = getImg();
        if (found) { obs.disconnect(); resolve(found); }
        else if (Date.now() - t0 > 15000) { obs.disconnect(); resolve(null); }
      });
      obs.observe(container, { childList: true, subtree: true });
    });
  }
  if (!img) return null;
  if (!(img.complete && img.naturalWidth)) {
    await new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (img.complete && img.naturalWidth) { clearInterval(iv); resolve(); }
        else if (Date.now() - t0 > 15000) { clearInterval(iv); resolve(); }
      }, 100);
    });
  }
  if (!(img.complete && img.naturalWidth)) return null;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.94);
}
"""


def _browser_args():
    """Extra Chromium flags for containers (root, small /dev/shm, no GPU)."""
    if platform.system() == "Linux":
        return ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    return []


def _launch_browser(pw, headless: bool):
    """Prefer browsers already installed on the machine (no extra download)."""
    errors = []
    for channel in ("msedge", "chrome"):
        try:
            return pw.chromium.launch(
                channel=channel, headless=headless, args=_browser_args()), channel
        except Exception as e:  # noqa: BLE001
            errors.append("%s: %s" % (channel, str(e).splitlines()[0] if str(e) else "?"))
    try:
        return pw.chromium.launch(headless=headless, args=_browser_args()), "chromium"
    except Exception as e:  # noqa: BLE001
        errors.append("chromium: %s" % (str(e).splitlines()[0] if str(e) else "?"))
    raise RuntimeError(
        "No usable browser found. Install Edge/Chrome, or run: "
        "python -m playwright install chromium  (" + " | ".join(errors) + ")")


def capture_all_pages(page, on_progress, page_wait_ms: int = 45000):
    """Drive the open preview page: wait for render, capture every page."""
    try:
        page.wait_for_selector('img[src^="blob:"]', timeout=page_wait_ms)
    except Exception as e:  # noqa: BLE001
        if "accounts.google.com" in page.url:
            raise CaptureAuthNeeded() from e
        raise CaptureNoPages(
            "The preview never rendered page images (file may be empty, "
            "quota-limited, or not a page-based document).") from e
    count = page.evaluate(INJECT_PAGES_JS)
    if not isinstance(count, int) or count <= 0:
        raise CaptureNoPages("No page containers detected in the preview.")
    on_progress(0, count)
    pages: dict[int, bytes] = {}
    for i in range(count):
        data_url = page.evaluate(CAPTURE_PAGE_JS, i)
        if data_url and "," in data_url:
            try:
                pages[i] = base64.b64decode(data_url.split(",", 1)[1])
            except Exception:  # noqa: BLE001
                pass
        on_progress(len(pages), count)
        page.wait_for_timeout(120)
    if not pages:
        raise CaptureNoPages("Pages were found but no image could be captured.")
    return [pages[i] for i in sorted(pages)], count


def capture_with_browser(job: Job, file_id: str, title: str | None,
                         headful_persistent: bool = False):
    """Run the automated capture; returns the output PDF path."""
    from playwright.sync_api import sync_playwright

    DOWNLOADS.mkdir(exist_ok=True)
    preview = "https://drive.google.com/file/d/%s/preview" % file_id
    profile_dir = ROOT / ".browser_profile"

    def on_progress(done, total):
        job.emit({"type": "progress", "stage": "capture",
                  "done": int(done), "total": int(total)})

    with sync_playwright() as pw:
        ctx = None
        browser = None
        if headful_persistent:
            profile_dir.mkdir(exist_ok=True)
            # persistent + headful: keeps the sign-in between runs
            for channel in ("msedge", "chrome"):
                try:
                    ctx = pw.chromium.launch_persistent_context(
                        str(profile_dir), channel=channel, headless=False,
                        args=_browser_args(),
                        viewport={"width": 1360, "height": VIEWPORT_H})
                    break
                except Exception:  # noqa: BLE001
                    ctx = None
            if ctx is None:
                ctx = pw.chromium.launch_persistent_context(
                    str(profile_dir), headless=False, args=_browser_args(),
                    viewport={"width": 1360, "height": VIEWPORT_H})
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
        else:
            browser, _channel = _launch_browser(pw, headless=True)
            ctx = browser.new_context(
                viewport={"width": 1360, "height": VIEWPORT_H},
                device_scale_factor=DEVICE_SCALE)
            page = ctx.new_page()

        try:
            page.goto(preview, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(800)
            if "accounts.google.com" in page.url:
                raise CaptureAuthNeeded()
            wait_ms = 300000 if headful_persistent else 45000
            if headful_persistent:
                job.emit({"type": "log",
                          "message": "Waiting for sign-in / preview (up to 5 min)…"})
            page_pages, count = capture_all_pages(page, on_progress, wait_ms)
            job.emit({"type": "log", "message": "Captured %d of %d pages."
                      % (len(page_pages), count)})
        finally:
            try:
                if ctx is not None:
                    ctx.close()
                if browser is not None:
                    browser.close()
            except Exception:  # noqa: BLE001
                pass

    base = gd.sanitize_filename(title or file_id)
    if base.lower().endswith(".pdf"):
        base = base[:-4]
    out_path = gd.unique_path(str(DOWNLOADS / (base + ".pdf")))
    n = gd.stitch_pdf(page_pages, out_path)
    job.emit({"type": "log", "message": "Stitched %d pages into %s"
              % (n, Path(out_path).name)})
    return out_path


def run_capture_stage(job: Job, file_id: str, title: str | None) -> bool:
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        job.emit({"type": "stage", "stage": "capture", "state": "failed"})
        job.emit({"type": "error",
                  "message": "Playwright is not installed.",
                  "hint": "Run: python -m pip install playwright"})
        return False
    if CAPTURE_LOCK.locked():
        job.emit({"type": "log",
                  "message": "Another capture is running — this one starts when it finishes."})
    if not CAPTURE_LOCK.acquire(timeout=900):
        job.emit({"type": "stage", "stage": "capture", "state": "failed"})
        job.emit({"type": "error",
                  "message": "The capture queue stayed busy for 15 minutes.",
                  "hint": "Try again shortly."})
        return False
    try:
        return _capture_stage_locked(job, file_id, title)
    finally:
        CAPTURE_LOCK.release()


def _capture_stage_locked(job: Job, file_id: str, title: str | None) -> bool:
    try:
        job.emit({"type": "log", "message": "Launching browser for automatic capture…"})
        out = capture_with_browser(job, file_id, title, headful_persistent=False)
        _finish_ok(job, out)
        return True
    except CaptureAuthNeeded:
        if os.environ.get("GDD_HEADLESS_ONLY") == "1":
            job.emit({"type": "stage", "stage": "capture", "state": "failed"})
            job.emit({"type": "error",
                      "message": "This file needs a signed-in browser.",
                      "hint": "The hosted backend can't sign in to Google accounts. "
                              "Link-shared files capture automatically; for private "
                              "files, run the app locally."})
            return False
        job.emit({"type": "log",
                  "message": "Google asked for sign-in. A browser window will open — "
                             "sign in there once; capture continues automatically "
                             "(remembered for next time)."})
        try:
            out = capture_with_browser(job, file_id, title, headful_persistent=True)
            _finish_ok(job, out)
            return True
        except CaptureAuthNeeded:
            job.emit({"type": "stage", "stage": "capture", "state": "failed"})
            job.emit({"type": "error",
                      "message": "Sign-in did not complete.",
                      "hint": "Run again and sign in when the browser window opens."})
            return False
        except Exception as e:  # noqa: BLE001
            job.emit({"type": "stage", "stage": "capture", "state": "failed"})
            job.emit({"type": "error", "message": "Capture failed: %s" % e})
            return False
    except CaptureNoPages as e:
        job.emit({"type": "stage", "stage": "capture", "state": "failed"})
        job.emit({"type": "error", "message": "Capture failed: %s" % e,
                  "hint": "If the file is quota-limited try again later; "
                          "if it is private, share it as 'Anyone with the link -> Viewer'."})
        return False
    except Exception as e:  # noqa: BLE001
        job.emit({"type": "stage", "stage": "capture", "state": "failed"})
        job.emit({"type": "error", "message": "Capture failed: %s" % e})
        return False


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION}


@app.post("/api/jobs")
def create_job(payload: dict = Body(...)):
    link = (payload.get("link") or "").strip()
    mode = payload.get("mode") or "auto"
    name = payload.get("name") or None
    if mode not in ("auto", "direct", "export", "capture"):
        raise HTTPException(400, "invalid mode")
    file_id, _kind = gd.parse_file_id(link)
    if not file_id:
        raise HTTPException(400, "No Google Drive file id found in that link.")
    job = Job(id=uuid.uuid4().hex[:12], link=link, mode=mode, name=name)
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return {"id": job.id, "status": job.status}


@app.get("/api/jobs")
def list_jobs():
    with JOBS_LOCK:
        jobs = sorted(JOBS.values(), key=lambda j: j.created, reverse=True)[:100]
    out = []
    for j in jobs:
        with j.lock:
            out.append({
                "id": j.id, "link": j.link, "mode": j.mode,
                "status": j.status, "stages": dict(j.stages),
                "result": j.result, "error": j.error,
                "created": j.created, "elapsed": round(time.time() - j.created, 1),
            })
    return {"jobs": out}


@app.get("/api/jobs/{job_id}")
def job_snapshot(job_id: str):
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return job.snapshot()


@app.get("/api/jobs/{job_id}/file")
def job_file(job_id: str):
    job = get_job(job_id)
    if not job or not job.result:
        raise HTTPException(404, "file not ready")
    path = DOWNLOADS / job.result["name"]
    if not path.is_file():
        raise HTTPException(404, "file missing on disk")
    media = MEDIA_TYPES.get(job.result.get("family"), "application/octet-stream")
    return FileResponse(str(path), media_type=media, filename=job.result["name"])


@app.websocket("/ws/jobs/{job_id}")
async def ws_job(ws: WebSocket, job_id: str):
    job = get_job(job_id)
    if not job:
        await ws.close(code=4004)
        return
    await ws.accept()
    idx = 0
    try:
        while True:
            with job.lock:
                batch = job.events[idx:]
                finished = job.status in ("done", "error")
            for ev in batch:
                await ws.send_json(ev)
            idx += len(batch)
            if finished and idx >= len(job.events):
                with job.lock:
                    if idx >= len(job.events):
                        break
            await asyncio.sleep(0.15)
    except WebSocketDisconnect:
        return
    try:
        await ws.close()
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------------------
# Static frontend
# --------------------------------------------------------------------------

if DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="app")
else:
    @app.get("/", response_class=HTMLResponse)
    def no_frontend():
        return ("<h1>GDrive Down</h1><p>Frontend not built yet. Run:</p>"
                "<pre>npm --prefix webapp install\nnpm --prefix webapp run build</pre>")


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(prog="server", description="GDrive Down web app")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    DOWNLOADS.mkdir(exist_ok=True)

    import uvicorn
    port = args.port
    for p in range(args.port, args.port + 21):
        try:
            import socket
            s = socket.socket()
            s.bind((HOST, p))
            s.close()
            port = p
            break
        except OSError:
            continue

    url = "http://%s:%d" % (HOST, port)
    print("=" * 60)
    print(" GDrive Down v%s  —  %s" % (VERSION, url))
    print(" Press Ctrl+C to stop.")
    print("=" * 60)
    if not args.no_browser:
        threading.Timer(1.2, webbrowser.open, [url]).start()
    uvicorn.run(app, host=HOST, port=port, log_level="warning")


if __name__ == "__main__":
    main()
