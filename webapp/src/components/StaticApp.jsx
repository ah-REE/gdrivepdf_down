import { useEffect, useMemo, useRef, useState } from 'react'

import {
  BrandMark,
  IconDownload,
  IconLink,
  IconMoon,
  IconPaste,
  IconSun,
} from './Glyphs.jsx'
import { useTheme } from '../lib/useTheme.js'
import { detect, directDownloadUrl } from '../lib/link.js'
import bookmarkletSrc from '../capture/bookmarklet.min.js?raw'

// The bookmarklet link is set imperatively so React never sees a
// javascript: URL in its render output.
const BOOKMARKLET_HREF = 'javascript:' + bookmarkletSrc.trim()

export default function StaticApp() {
  const { theme, toggle } = useTheme()
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [dragTip, setDragTip] = useState(false)

  const inputRef = useRef(null)
  const bmRef = useRef(null)

  const info = useMemo(() => detect(link), [link])
  const url = info && info.id ? directDownloadUrl(info.kind, info.id) : null
  const canDownload = Boolean(url)

  useEffect(() => {
    if (bmRef.current) bmRef.current.setAttribute('href', BOOKMARKLET_HREF)
  }, [])

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setLink(text.trim())
      inputRef.current?.focus()
    } catch {
      inputRef.current?.focus()
    }
  }

  async function copyBookmark() {
    try {
      await navigator.clipboard.writeText(BOOKMARKLET_HREF)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setDragTip(true)
    }
  }

  return (
    <div className="shell">
      <header className="topbar reveal">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">GDrive Down</span>
        </div>
        <div className="topbar-right">
          <span className="topbar-version">v1.5</span>
          <button
            type="button"
            className="icon-btn"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
          </button>
        </div>
      </header>

      <section className="hero reveal reveal-1">
        <h1>Paste a link. Get the file.</h1>
        <p>
          Public files download straight from Google. For view-only files, one bookmark
          captures the pages and saves a PDF, right in this browser.
        </p>
      </section>

      <section className="composer reveal reveal-2" aria-label="Download a public file">
        <div className="composer-main">
          <div className="input-wrap">
            <span className="lead-glyph">
              <IconLink size={16} />
            </span>
            <label className="sr-only" htmlFor="drive-link">
              Google Drive link
            </label>
            <input
              id="drive-link"
              ref={inputRef}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://drive.google.com/file/d/…"
              spellCheck={false}
              autoComplete="off"
              inputMode="url"
              autoFocus
            />
            <button
              type="button"
              className="icon-btn"
              onClick={pasteFromClipboard}
              title="Paste from clipboard"
              aria-label="Paste from clipboard"
            >
              <IconPaste size={16} />
            </button>
          </div>
          <a
            className="btn-primary"
            href={canDownload ? url : undefined}
            aria-disabled={!canDownload}
            onClick={(e) => {
              if (!canDownload) e.preventDefault()
            }}
          >
            <IconDownload size={17} /> Download file
          </a>
        </div>

        <div className="chip-row" role="status">
          {info?.folder ? (
            <span className="chip warn">Folder link. Paste a single-file link instead.</span>
          ) : null}
          {info?.id && info.kind !== 'forms' ? (
            <span className="chip ok">
              Recognized {info.kind === 'file' ? 'Drive file' : info.kind}
            </span>
          ) : null}
          {info?.id && info.kind === 'forms' ? (
            <span className="chip warn">Forms links cannot be downloaded here.</span>
          ) : null}
          {link && info && !info.id && !info.folder ? (
            <span className="chip">No file id in that link yet</span>
          ) : null}
        </div>

        <p className="static-hint">
          Works for public PDF, PPT and PPTX files, and for Google Docs, Slides and Sheets
          links. If Google shows a scan notice for a very large file, press Download anyway.
        </p>
      </section>

      <section className="capture-card reveal reveal-3" aria-label="Capture a view-only file">
        <span className="caps">View-only file, download disabled?</span>
        <p className="capture-sub">
          Use the capture bookmark. Open the file's link in this browser, then click the
          bookmark: it opens the preview itself, captures every page and saves one PDF.
          Runs locally and works for private files too.
        </p>
        <ol className="capture-steps">
          <li>
            Drag{' '}
            <a
              ref={bmRef}
              className="drag-btn"
              href="#"
              onClick={(e) => {
                e.preventDefault()
                setDragTip(true)
              }}
            >
              Capture tool
            </a>{' '}
            to your bookmarks bar. No bar? Press Ctrl+Shift+B to show it.
          </li>
          <li>Open the file's link in this browser. Any shared Drive link works.</li>
          <li>
            Click the bookmark. If the preview is not open, it opens it, then captures and
            saves the PDF on its own.
          </li>
        </ol>
        <div className="capture-actions">
          <button type="button" className="btn-ghost" onClick={copyBookmark}>
            {copied ? 'Copied' : 'Copy the bookmark code'}
          </button>
          <span className="capture-note">
            {dragTip
              ? 'Create a new bookmark in your browser and paste the copied code as its URL.'
              : 'On Google Docs, Slides or Sheets editor pages a new tab opens: switch to it and click the bookmark there.'}
          </span>
        </div>
      </section>

      <footer className="footer reveal reveal-3">
        <span>Runs in your browser. Nothing passes through any server of ours.</span>
        <span className="mono">full auto? run the app locally</span>
      </footer>
    </div>
  )
}
