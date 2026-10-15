# gdrive_down — Google Drive PDF/PPT Downloader

![GDrive Down web app — dark console UI with a paste field, pipeline rail and download history](docs/preview.png)

Download PDF / PPT / PPTX files from a Google Drive link — including
**view-only files whose download option has been disabled** — with an
automatic browser-capture mode.

- **Web app (recommended)** — a web UI: paste a link, watch the
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

## Hosted setup: UI on Vercel + backend on Render (free)

**Live now:** https://gdrivedown.vercel.app — fully wired: Vercel UI +
Render API. Open it and paste a link; the free tier wakes on demand.

### The UI (Vercel)

This repo ships a `vercel.json`: import the repository on Vercel and
deploy — no extra settings. Vercel runs `npm --prefix webapp install`,
`npm --prefix webapp run build` and serves `webapp/dist`.

**What Vercel can and cannot host:**

| Part | Vercel? | Why |
| --- | --- | --- |
| React UI | ✅ | Static build, no server needed |
| Direct / export downloads | ✅ with a backend | Works when the UI points at a reachable backend |
| Browser capture (view-only files) | ✅ with a backend | Runs on the backend host — not on Vercel itself |

The download engine (`server.py`) is a long-running service with
WebSockets and a headless browser; serverless functions can't run it.

### The backend (Render free tier)

The repo ships a `render.yaml` Blueprint and a `Dockerfile`:

1. Create a free account at [render.com](https://render.com) (GitHub sign-in is easiest).
2. **New +** → **Blueprint** → pick this repository → **Apply**.
3. Render builds the Docker image and deploys `gdrive-down-api` (Singapore).

Then point the UI at it: in the Vercel project set
`VITE_API_BASE=https://gdrive-down-api.onrender.com`
(Settings → Environment Variables) and redeploy.

Render free-tier notes:

- The service **sleeps after ~15 min idle**. The UI shows a
  “Waking the server up…” banner with a progress bar on first contact
  (~60 s cold start) and starts your job automatically once it's awake.
- 512 MB RAM: only one capture runs at a time and pages render at a
  reduced scale; unusually large decks may run out of memory.
- Fully-private files (Google sign-in required) can't be captured on the
  hosted backend — run locally for those. Link-shared files work fully.

### Alternative backends

- **Run locally** — full features, nothing to host.
- **Any other host** — set the build-time env var in the Vercel project:

```text
VITE_API_BASE=https://your-backend.example.com
```

The UI reads `VITE_API_BASE` at build time.

---

## Repo layout

```text
gdrive_down.py    CLI downloader (direct / export / capture strategies)
server.py         FastAPI backend for the web app (jobs + WebSocket + capture)
webapp/           React UI (Vite). dist/ is committed so local clones work without Node
tests/            E2E checks (python tests/test_e2e.py) + preview fixture
vercel.json       Static UI deployment config (Vercel)
render.yaml       Render Blueprint — free-tier backend deployment
Dockerfile        Backend image (API + Playwright browser)
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
- “Quota exceeded” files need a retry later.
- Folder links are not supported.

## Requirements

- Python 3.10+ (CLI + web app backend)
- Node 18+ — only to rebuild the frontend, not needed for normal use
- Edge or Chrome — used for automatic capture (local runs)

## Fair use

Only download content you have the right to access and keep. Respect
copyright and the file owner's restrictions; intended for personal /
archival use of material you are legitimately allowed to view.
