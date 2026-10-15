# gdrive_down — Google Drive PDF/PPT Downloader

![GDrive Down web app — dark console UI with a paste field, pipeline rail and download history](docs/preview.png)

Download PDF / PPT / PPTX files from a Google Drive link — including
**view-only files whose download option has been disabled** — with an
automatic browser-capture mode.

- **Web app (recommended)** — a local web UI: paste a link, watch the
  pipeline, click save. The view-only capture is fully automatic.
- **CLI** — `gdrive_down.py` for the terminal.

---

## Web app

### Run it

Double-click **`GDrive Down.bat`** (or run `python server.py`).

- First launch installs Python dependencies (one time, a few minutes).
- The app opens at `http://127.0.0.1:8756` in your browser automatically.

### Daily use

1. Paste a Drive link (single-file links only) and press **Get file**.
2. Watch the pipeline: **Direct** → **Export** → **Capture**.
3. Press **Save file** when it finishes. A copy also stays in the
   `downloads/` folder next to the app.

### How the automatic capture works

The backend drives a real browser (Edge or Chrome, whichever is
installed) with Playwright: it opens the Drive preview, scrolls through
every page, collects the rendered page images and stitches them into a
single PDF. If Google asks for a sign-in, a browser window opens once —
sign in and the capture continues by itself; the sign-in is kept in
`.browser_profile/` for next time.

---

## CLI

```text
python gdrive_down.py "https://drive.google.com/file/d/FILE_ID/view?usp=sharing"
python gdrive_down.py              (interactive mode — just paste links)
```

Options: `-o OUT`, `-n NAME`, `--mode auto|direct|export|capture`,
`--port N`, `--keep-images`, `-v`, `--self-test`.

In CLI capture mode the tool starts a local receiver and prints
`capture_script.js` — you paste it once into the browser console on the
preview tab (Chrome needs `allow pasting` typed once). The web app
automates this whole step.

---

## Deploying the UI to Vercel

**Live now:** https://gdrivedown.vercel.app — UI-only until a backend is
attached (see below); file downloads need a backend that is reachable
from the browser.

This repo ships a `vercel.json`, so the **frontend** can be deployed to
Vercel directly: import the repository on Vercel and deploy — no extra
settings. Vercel runs `npm --prefix webapp install`,
`npm --prefix webapp run build` and serves `webapp/dist`.

**What Vercel can and cannot host:**

| Part | Vercel? | Why |
| --- | --- | --- |
| React UI | ✅ | Static build, no server needed |
| Direct / export downloads | ⚠️ | Only if you point the UI at a reachable backend (below) |
| Browser capture (view-only files) | ❌ | Needs a real browser and long-running jobs — not possible on serverless |

The download engine (`server.py`) is a long-running service with
WebSockets and a headless browser; serverless functions can't run it.
Recommended setups:

- **Run locally** — full features, nothing to host.
- **Host the UI on Vercel + a backend somewhere reachable** (home server
  with a tunnel, small VPS, …) — set the build-time env var in the
  Vercel project:

```text
VITE_API_BASE=https://your-backend.example.com
```

The UI reads `VITE_API_BASE` at build time. Without it, the deployed UI
stays usable as a UI preview but shows a clear "server unreachable"
state when you press Get file.

---

## Repo layout

```text
gdrive_down.py    CLI downloader (direct / export / capture strategies)
server.py         FastAPI backend for the web app (jobs + WebSocket + capture)
webapp/           React UI (Vite). dist/ is committed so local clones work without Node
tests/            E2E checks (python tests/test_e2e.py) + preview fixture
vercel.json       Static UI deployment config
GDrive Down.bat   one-click launcher (Windows)
```

## How it works

1. **direct** — public files, downloaded from
   `drive.usercontent.google.com`, handling the large-file virus-scan
   confirm interstitial automatically.
2. **export** — native Google formats via docs.google.com export
   endpoints (Docs → PDF, Slides → PPTX, Sheets → XLSX).
3. **capture** — view-only / download-disabled files: page images
   captured from the browser preview, stitched into a single PDF.

Accepted link shapes: `drive.google.com/file/d/<ID>/…`, `/open?id=`,
`/uc?id=`, `drive.usercontent.google.com/download?id=`,
`docs.google.com/document|presentation|spreadsheets/d/<ID>/…`, or a raw
file ID.

## Limitations

- Capture output is rebuilt from preview images: visual quality matches
  the on-screen preview; there is no text layer.
- Files that are completely private can't be retrieved (capture needs
  the file to at least open for you in a browser).
- "Quota exceeded" files need a retry later.
- Folder links are not supported.

## Requirements

- Python 3.10+ (CLI + web app backend)
- Node 18+ — only to rebuild the frontend, not needed for normal use
- Edge or Chrome — used for automatic capture

## Fair use

Only download content you have the right to access and keep. Respect
copyright and the file owner's restrictions; intended for personal /
archival use of material you are legitimately allowed to view.
