#!/usr/bin/env python3
"""
End-to-end checks for the GDrive Down web app.

Prereq: the server is running (python server.py --no-browser) on 127.0.0.1:8756.
Run:    python tests/test_e2e.py

Checks:
  1. /api/health responds.
  2. Full job flow through the real network: POST a public Drive file via
     the spam.txt id, listen on the WebSocket until 'done', then fetch
     the produced file from /api/jobs/{id}/file.
  3. capture_all_pages() against a local fixture that mimics the Drive
     preview DOM (lazy blob: page images) -> stitched into a 3-page PDF.
  4. Playwright can load a real drive.google.com preview page from this
     machine (live reachability smoke).
"""

import asyncio
import json
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

BASE = "http://127.0.0.1:8756"
WS_BASE = "ws://127.0.0.1:8756"
TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
sys.path.insert(0, str(ROOT))

# gdown's maintained public test file (spam.txt got quota-limited today)
FILE_ID = "1l_5RK28JRL19wpT22B-DY9We3TVXnnQQ"  # fcn8s_from_caffe.npz, tiny
FILE_LINK = "https://drive.google.com/file/d/%s/view?usp=sharing" % FILE_ID

RESULTS = []


def check(name, fn):
    try:
        fn()
        print("  [PASS] %s" % name)
        RESULTS.append(True)
    except Exception as e:  # noqa: BLE001
        print("  [FAIL] %s — %r" % (name, e))
        RESULTS.append(False)


def t_health():
    r = requests.get(BASE + "/api/health", timeout=10)
    assert r.status_code == 200 and r.json().get("ok") is True, r.text


def t_job_flow():
    r = requests.post(BASE + "/api/jobs", json={"link": FILE_LINK, "mode": "direct"}, timeout=30)
    assert r.status_code == 200, r.text
    jid = r.json()["id"]

    import websockets

    done_ev = {}

    async def listen():
        async with websockets.connect("%s/ws/jobs/%s" % (WS_BASE, jid)) as ws:
            t0 = time.time()
            while time.time() - t0 < 120:
                raw = await asyncio.wait_for(ws.recv(), timeout=120)
                ev = json.loads(raw)
                if ev.get("type") == "done":
                    done_ev.update(ev)
                    return
                if ev.get("type") == "error":
                    raise AssertionError("job error: %r" % ev)

    asyncio.run(listen())
    result = done_ev.get("result") or {}
    assert result.get("name", "").lower().startswith("fcn8s"), result

    fr = requests.get("%s/api/jobs/%s/file" % (BASE, jid), timeout=30)
    assert fr.status_code == 200, fr.status_code
    assert len(fr.content) > 0
    assert "fcn8s" in fr.headers.get("Content-Disposition", "").lower()


def t_capture_fixture():
    from playwright.sync_api import sync_playwright

    import server as srv

    handler = lambda *a, **kw: SimpleHTTPRequestHandler(*a, directory=str(TESTS), **kw)  # noqa: E731
    httpd = ThreadingHTTPServer(("127.0.0.1", 8899), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as pw:
            browser, _ = srv._launch_browser(pw, headless=True)
            try:
                ctx = browser.new_context(viewport={"width": 1360, "height": 2000})
                page = ctx.new_page()
                page.goto("http://127.0.0.1:8899/fixture_preview.html",
                          wait_until="domcontentloaded", timeout=30000)
                pages_data, count = srv.capture_all_pages(page, lambda d, t: None, 20000)
            finally:
                browser.close()
        assert count == 3, "expected 3 pages, got %s" % count
        assert len(pages_data) == 3
        out = TESTS / "fixture_out.pdf"
        n = srv.gd.stitch_pdf(pages_data, str(out))
        assert n == 3
        assert out.read_bytes().startswith(b"%PDF")
    finally:
        httpd.shutdown()
        httpd.server_close()


def t_capture_batched():
    import server as srv

    httpd = ThreadingHTTPServer(
        ("127.0.0.1", 8898),
        lambda *a, **kw: SimpleHTTPRequestHandler(*a, directory=str(TESTS), **kw),
    )
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        job = srv.Job(id="test", link="test", mode="capture")
        pages, total = srv.capture_via_sessions(
            job,
            "http://127.0.0.1:8898/fixture_preview.html",
            page_wait_ms=20000,
            batch=2,
        )
        assert total == 3, "expected 3 pages, got %s" % total
        assert len(pages) == 3, "captured %d of 3" % len(pages)
    finally:
        httpd.shutdown()
        httpd.server_close()


def t_live_preview_smoke():
    from playwright.sync_api import sync_playwright

    import server as srv

    with sync_playwright() as pw:
        browser, channel = srv._launch_browser(pw, headless=True)
        try:
            page = browser.new_context().new_page()
            page.goto("https://drive.google.com/file/d/%s/preview" % FILE_ID,
                      wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(2500)
            title = page.title() or ""
            url = page.url
        finally:
            browser.close()
    assert "drive.google.com" in url or "accounts.google.com" in url, url
    print("        (live preview loaded via %s; title=%r)" % (channel, title[:60]))


def main():
    print("Running GDrive Down web app E2E checks...")
    check("health endpoint", t_health)
    check("full job flow + websocket + file fetch", t_job_flow)
    check("capture pipeline against local preview fixture", t_capture_fixture)
    check("batched capture across browser sessions", t_capture_batched)
    check("playwright can load a real drive.google.com preview", t_live_preview_smoke)
    if all(RESULTS):
        print("All E2E checks passed.")
        return 0
    print("E2E FAILED: %d/%d" % (RESULTS.count(True), len(RESULTS)))
    return 1


if __name__ == "__main__":
    sys.exit(main())
