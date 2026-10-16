import { useEffect, useMemo, useRef, useState } from 'react'

import {
  BrandMark,
  IconDownload,
  IconLink,
  IconPaste,
} from './Glyphs.jsx'
import { detect, directDownloadUrl } from '../lib/link.js'
import bookmarkletSrc from '../capture/bookmarklet.min.js?raw'

// The bookmarklet link is set imperatively so React never sees a
// javascript: URL in its render output.
const BOOKMARKLET_HREF = 'javascript:' + bookmarkletSrc.trim()

export default function StaticApp() {
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

  // ----- extension bridge -----
  const [ext, setExt] = useState({
    present: false,
    phase: null,
    done: 0,
    total: 0,
    name: null,
    pages: null,
    error: null,
  })

  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== window || !e.data || e.data.source !== 'gdd-ext') return
      const d = e.data
      if (d.type === 'gdd-pong' || d.type === 'gdd-hello') {
        setExt((x) => (x.present ? x : { ...x, present: true }))
      } else if (d.type === 'gdd-status') {
        if (d.phase === 'starting' || d.phase === 'started') {
          setExt((x) => ({ ...x, phase: 'starting', done: 0, total: 0, error: null, name: null }))
        } else if (d.phase === 'page') {
          setExt((x) => ({ ...x, phase: 'capturing', done: d.done, total: d.total }))
        } else if (d.phase === 'building') {
          setExt((x) => ({ ...x, phase: 'building', done: d.done, total: d.total }))
        } else if (d.phase === 'done') {
          setExt((x) => ({ ...x, phase: 'done', name: d.name, pages: d.pages }))
        } else if (d.phase === 'error') {
          setExt((x) => ({ ...x, phase: 'error', error: d.message }))
        }
      }
    }
    window.addEventListener('message', onMsg)
    const ping = () => window.postMessage({ source: 'gdd-site', type: 'gdd-ping' }, '*')
    ping()
    const t1 = setTimeout(ping, 900)
    const t2 = setTimeout(ping, 2600)
    return () => {
      window.removeEventListener('message', onMsg)
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])

  function startExtCapture() {
    if (!info?.id) return
    setExt((x) => ({ ...x, phase: 'starting', done: 0, total: 0, error: null, name: null }))
    window.postMessage({ source: 'gdd-site', type: 'gdd-start', link }, '*')
  }

  return (
    <div className="shell">
      <header className="topbar reveal">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">GDrive Down</span>
        </div>
        <div className="topbar-right">
          <span className="topbar-version">v3.0</span>
        </div>
      </header>

      <section className="hero reveal reveal-1">
        <h1>
          Paste a link. <span className="r">Get the file.</span>
        </h1>
        <p>
          Public files download straight from Google. View-only files are captured page by
          page and rebuilt as one PDF, right in this browser.
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

        {ext.present ? (
          <>
            <p className="capture-sub">
              Extension detected. Paste the link above and press Capture: the preview opens in
              a new tab, every page is captured and the PDF saves itself. No bookmark needed.
            </p>
            <div className="capture-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={startExtCapture}
                disabled={
                  !info?.id ||
                  ext.phase === 'starting' ||
                  ext.phase === 'capturing' ||
                  ext.phase === 'building'
                }
              >
                Capture automatically
              </button>
              {ext.phase === 'done' ? (
                <span className="capture-note">
                  Saved {ext.name} · {ext.pages} pages. Check your downloads.
                </span>
              ) : null}
            </div>
            {ext.phase === 'starting' || ext.phase === 'capturing' || ext.phase === 'building' ? (
              <div className="ext-progress">
                <div className="progress-track">
                  <div
                    className={'progress-fill' + (ext.total > 0 ? '' : ' indeterminate')}
                    style={
                      ext.total > 0
                        ? { width: Math.round((ext.done / ext.total) * 100) + '%' }
                        : undefined
                    }
                  />
                </div>
                <div className="progress-meta">
                  <span>{ext.phase === 'building' ? 'building the PDF' : 'capturing'}</span>
                  <span>{ext.total > 0 ? `page ${ext.done} / ${ext.total}` : ''}</span>
                </div>
              </div>
            ) : null}
            {ext.phase === 'error' ? (
              <p className="capture-note error">{ext.error}</p>
            ) : null}
          </>
        ) : (
          <>
            <p className="capture-sub">
              Fully automatic: install the GDrive Down extension once (open{' '}
              <span className="mono">chrome://extensions</span>, turn on Developer mode, press
              Load unpacked, pick the <span className="mono">extension</span> folder in the
              project). The Capture button then appears right here. No installs? Use the
              bookmark instead:
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
                Click the bookmark. If the preview is not open, it captures and saves the PDF
                on its own.
              </li>
            </ol>
            <div className="capture-actions">
              <button type="button" className="btn-ghost" onClick={copyBookmark}>
                {copied ? 'Copied' : 'Copy the bookmark code'}
              </button>
              <span className="capture-note">
                {dragTip
                  ? 'Create a new bookmark in your browser and paste the copied code as its URL.'
                  : 'Extension files: github.com/ah-REE/gdrivepdf_down → extension folder.'}
              </span>
            </div>
          </>
        )}
      </section>

      <footer className="footer reveal reveal-3">
        <span>Runs in your browser. Nothing passes through any server of ours.</span>
        <span className="mono">full auto? run the app locally</span>
      </footer>
    </div>
  )
}
