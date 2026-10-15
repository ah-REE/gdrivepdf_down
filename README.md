# gdrive_down

Download Google Drive PDFs and presentation decks from a link.

Public files download directly in your browser. View-only files, where the
owner disabled downloading, are captured page by page and saved as one PDF.
No console pasting. No extensions. No server required.

**Live site:** https://gdrivedown.vercel.app

![GDrive Down web app](docs/preview.png)

## Use the hosted site

### Public files

Paste a Drive link, then press Download file. This works for public PDF, PPT
and PPTX files and for Google Docs, Slides and Sheets links. If Google shows a
scan notice for a very large file, press Download anyway.

### View-only files (download disabled)

Use the capture bookmark. One-time setup, then one click per file:

1. On the site, drag the "Capture tool" button to your browser's bookmarks
   bar (press Ctrl+Shift+B if the bar is hidden).
2. Open the file's link in that browser. Any shared Drive link works.
3. Click the bookmark. If the preview is not open yet, the bookmark opens it
   itself, then captures every page and saves the PDF.

The capture runs entirely in your browser: no server, no waiting, and it
works for any file you can view, including private ones. A small status box
in the corner shows progress; click it to cancel. On Google Docs, Slides or
Sheets editor pages a new tab opens; switch to it and click the bookmark
there to capture.

## Run the full app locally

The local app automates the capture with a real browser, so a view-only file
is just paste and click.

```text
GDrive Down.bat            (Windows, double-click)
python server.py           (any platform, then open http://127.0.0.1:8756)
```

The first launch installs Python dependencies once. Files land in the
`downloads/` folder next to the app.

## CLI

```text
python gdrive_down.py "https://drive.google.com/file/d/FILE_ID/view?usp=sharing"
python gdrive_down.py
```

Options: `-o OUT`, `-n NAME`, `--mode auto|direct|export|capture`,
`--port N`, `--keep-images`, `-v`, `--self-test`.

## How it works

1. Direct download: the browser performs a native download from Google's
   download endpoint, so no cross-origin restrictions apply.
2. Capture bookmark: reads the rendered page images from the Drive preview,
   builds a PDF locally (a tiny JPEG-in-PDF writer) and saves it. No network
   calls leave your browser.
3. Local app: automates the same capture with Playwright, handles large decks
   in memory-safe batches, and stitches pages with a lossless PDF writer.

## Optional backend

The repository also includes a FastAPI backend (`server.py`) with a Docker
image and a Render blueprint. The hosted site does not need it. Run or deploy
the backend only if you want fully automated capture on a machine you control.
Its API is documented at the top of `server.py`.

## Repo layout

```text
capture/              The capture bookmarklet (source and minified build)
gdrive_down.py        CLI downloader (direct, export and capture strategies)
server.py             Optional FastAPI backend (jobs, WebSocket, capture)
webapp/               React UI (Vite). dist/ is committed for local use without Node
tests/                End-to-end checks (python tests/test_e2e.py)
vercel.json           Static deployment config for Vercel
render.yaml           Optional Render blueprint for the backend
Dockerfile            Backend image (API plus Playwright Chromium)
GDrive Down.bat       One-click launcher for the local app
```

## Limitations

- Forms links cannot be downloaded.
- Very large files may require one extra press on Google's scan page.
- The capture bookmark needs a desktop browser (bookmarklets do not run on
  phones). Use the local app for mobile-heavy workflows.
- Captured PDFs are rebuilt from preview images: quality matches the preview
  and there is no text layer.
- Completely private files can only be captured where you are signed in, which
  the bookmark (running in your browser) supports by design.

## Requirements

- Python 3.10 or newer for the local app and CLI
- Node 18 or newer, only to rebuild the frontend
- Edge or Chrome for local capture

## Fair use

Only download content you have the right to access and keep. Respect
copyright and the file owner's restrictions. Intended for personal, archival
use of material you are allowed to view.
