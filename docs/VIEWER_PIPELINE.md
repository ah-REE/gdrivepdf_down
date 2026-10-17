# Viewer pipeline - server-side fetch of Google Drive files (incl. view-only)

How `python gdrive_down.py --mode viewer "https://drive.google.com/file/d/<ID>/view"`
gets bytes without a browser, without cookies, and without logging in.

## The chain

1. `GET https://drive.google.com/file/d/<ID>/preview`
   The HTML embeds a one-scope bootstrap token: `viewer/upload?ds\u003d<token>`
   (the `= ` is JSON-escaped in the page; parse accordingly).
2. `GET https://drive.google.com/viewer/upload?ds=<token>&ck=drive&dsmi=texmex&p=proj&fssid=<session-id>`
   Returns XSSI-guarded JSON (` )]}'` prefix) that carries signed resources:
   - `pdf` - signed URL to the original file bytes
   - `meta` - `{"pages": N, "maxPageWidth": 3200}`
   - `page` - template for page renders (`img?id=<doc-token>&dsmi=texmex`)
   - `presspage` / `press` - text-layer glyph boxes (not used by the CLI)
   `fssid` is a client-side generated session id (29 chars); any fresh value works.
3. Preferred route: `GET <pdf>` - the original file, byte-for-byte.
4. Fallback route (used when Google withholds `pdf`, e.g. download-restricted
   shares): loop
   `GET https://drive.google.com/viewer/img?id=<doc-token>&dsmi=texmex&auditContext=forDisplay&page=N&w=3200&webp=true&fssid=<session-id>`
   and stitch the returned pages with img2pdf (Pillow fallback). Pages come
   back as PNG or WEBP at up to 3200 px wide.

## Verified live (2026-10-17)

| file id | route | result |
| --- | --- | --- |
| `0B51DeR2gtuAidzI2N3N6cm1CNmM` (PDF) | original bytes via `pdf` | 486,149 bytes, 126 pages |
| `0B51DeR2gtuAidzI2N3N6cm1CNmM` | page renders, first 3 pages | 3-page PDF, 2.51 MB, page 1 = 3200x4526 px |
| `1MUicxnZccK3UOX8XAwAwKcqaEJK3WdTE` (1079-page PDF) | original bytes via `pdf` | 41,333,316 bytes, 1079 pages |

All requests were plain `requests` calls with no cookies, no login, no browser.

## Constraints and risks

- Works for links a signed-out browser can open ("anyone with the link").
  Files that require sign-in cannot be fetched anonymously; use capture mode
  from your own signed-in browser for those.
- This rides on Drive's internal viewer API. It is undocumented and can change
  without notice; the direct/export/capture strategies remain as fallbacks.
- Page renders are capped at 3200 px wide (`maxPageWidth` from `meta`).
- Pages are fetched strictly one at a time. Do not parallelize - it is the
  fastest way to get rate-limited.
- The CLI treats a `pdf` key that returns an HTML/JSON error body as a miss
  and silently falls through to the page route.

## Knobs (environment)

| variable | effect |
| --- | --- |
| `GDD_VIEWER_WIDTH` | page render width in px (default 3200) |
| `GDD_VIEWER_PAGES_ONLY=1` | skip the original-bytes attempt |
| `GDD_VIEWER_MAX_PAGES=N` | stop after N pages (sampling/tests) |
| `GDD_VIEWER_BASE` | override the base host (used by the self-test mocks) |

## Try it

```text
python gdrive_down.py --mode viewer "https://drive.google.com/file/d/FILE_ID/view"
python gdrive_down.py --mode viewer -o out "https://drive.google.com/file/d/FILE_ID/view"
GDD_VIEWER_PAGES_ONLY=1 GDD_VIEWER_MAX_PAGES=5 python gdrive_down.py --mode viewer LINK
```

`--mode auto` runs direct -> export -> viewer -> capture.
