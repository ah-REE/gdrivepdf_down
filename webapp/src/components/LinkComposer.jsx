import { useRef } from 'react'

import { IconArrowRight, IconLink, IconPaste } from './Glyphs.jsx'

const MODES = [
  ['auto', 'Auto', 'Try direct download, then export, then browser capture'],
  ['direct', 'Direct', 'Public files only — straight from the Drive servers'],
  ['export', 'Export', 'Native Google Docs / Slides / Sheets export'],
  ['capture', 'Capture', 'Rebuild a PDF from the browser preview (view-only files)'],
]

export default function LinkComposer({
  link,
  setLink,
  mode,
  setMode,
  onSubmit,
  running,
  waking,
  demoteCta,
  detectInfo,
}) {
  const inputRef = useRef(null)

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setLink(text.trim())
      inputRef.current?.focus()
    } catch {
      inputRef.current?.focus()
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    onSubmit()
  }

  const canSubmit = Boolean(detectInfo && detectInfo.id) && !running

  return (
    <section className="composer reveal reveal-2" aria-label="Start a download">
      <form onSubmit={handleSubmit}>
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
          <button
            type="submit"
            className={demoteCta ? 'btn-ghost' : 'btn-primary'}
            style={demoteCta ? { height: 44 } : undefined}
            disabled={!canSubmit}
          >
            {running ? (
              'Working…'
            ) : waking ? (
              'Waiting for server…'
            ) : (
              <>
                Get file <IconArrowRight size={16} />
              </>
            )}
          </button>
        </div>

        <div className="chip-row" role="status">
          {detectInfo?.folder ? (
            <span className="chip warn">folder link — paste a single-file link instead</span>
          ) : null}
          {detectInfo?.id ? (
            <span className="chip ok">
              detected · {detectInfo.kind === 'file' ? 'drive file' : detectInfo.kind}
            </span>
          ) : null}
          {link && detectInfo && !detectInfo.id && !detectInfo.folder ? (
            <span className="chip">no file id in that link yet</span>
          ) : null}
        </div>

        <div className="composer-foot">
          <div className="modes" role="group" aria-label="Download mode">
            {MODES.map(([value, label, tip]) => (
              <button
                key={value}
                type="button"
                className="mode"
                aria-pressed={mode === value}
                title={tip}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="kbd-hint">
            press <kbd>Enter</kbd> to start
          </span>
        </div>
      </form>
    </section>
  )
}
