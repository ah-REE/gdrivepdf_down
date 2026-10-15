import { useEffect, useMemo, useRef, useState } from 'react'

import LinkComposer from './components/LinkComposer.jsx'
import PipelineRail from './components/PipelineRail.jsx'
import ResultCard from './components/ResultCard.jsx'
import HistoryList from './components/HistoryList.jsx'
import { BrandMark, IconAlert } from './components/Glyphs.jsx'
import { apiListJobs, apiStartJob, openJobSocket } from './lib/api.js'

function detect(link) {
  const t = (link || '').trim()
  if (!t) return null
  if (/\/folders\//.test(t) || /\/drive\/(u\/\d+\/)?folders/.test(t)) return { folder: true }
  const native = t.match(
    /docs\.google\.com\/(document|presentation|spreadsheets|forms)\/d\/([A-Za-z0-9_-]{25,})/,
  )
  if (native) return { id: native[2], kind: native[1] }
  const m = t.match(/(?:file\/d\/|[?&]id=|\/d\/)([A-Za-z0-9_-]{25,})/)
  if (m) return { id: m[1], kind: 'file' }
  if (/^[A-Za-z0-9_-]{25,}$/.test(t)) return { id: t, kind: 'file' }
  return { invalid: true }
}

function ErrorCard({ error, onRetry }) {
  if (!error) return null
  return (
    <section className="error-card" aria-label="Download failed">
      <div className="error-title">
        <IconAlert size={17} />
        That one didn’t finish
      </div>
      <div className="error-msg">{error.message}</div>
      {error.hint ? <div className="error-hint">{error.hint}</div> : null}
      <div className="error-actions">
        <button type="button" className="btn-ghost" onClick={onRetry}>
          Try again
        </button>
      </div>
    </section>
  )
}

export default function App() {
  const [link, setLink] = useState('')
  const [mode, setMode] = useState('auto')
  const [job, setJob] = useState(null)
  const [history, setHistory] = useState([])
  const [now, setNow] = useState(Date.now())
  const wsRef = useRef(null)

  const detectInfo = useMemo(() => detect(link), [link])
  const running = Boolean(job && (job.status === 'queued' || job.status === 'running'))

  useEffect(() => {
    refreshHistory()
    return () => {
      if (wsRef.current) wsRef.current.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!running) return undefined
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [running])

  async function refreshHistory() {
    try {
      setHistory(await apiListJobs())
    } catch {
      /* server restarting — keep the last known list */
    }
  }

  function applyEvent(ev) {
    setJob((prev) => {
      if (!prev) return prev
      const next = {
        ...prev,
        stages: { ...prev.stages },
        progress: { ...prev.progress },
        logs: [...prev.logs],
      }
      if (ev.type === 'meta') {
        next.fileId = ev.file_id
        next.kind = ev.kind
        next.title = ev.title
      } else if (ev.type === 'stage') {
        next.stages[ev.stage] = ev.state
        if (ev.state === 'running') next.activeStage = ev.stage
      } else if (ev.type === 'progress') {
        next.progress[ev.stage] = { done: ev.done, total: ev.total }
      } else if (ev.type === 'log') {
        next.logs.push(ev.message)
        if (next.logs.length > 5) next.logs.shift()
      } else if (ev.type === 'done') {
        next.status = 'done'
        next.result = ev.result
        next.finishedAt = Date.now()
      } else if (ev.type === 'error') {
        next.status = 'error'
        next.error = { message: ev.message, hint: ev.hint }
        next.finishedAt = Date.now()
      }
      return next
    })
  }

  async function start(linkArg = link, modeArg = mode) {
    const info = detect(linkArg)
    if (!info || !info.id || running) return
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setJob({
      status: 'running',
      stages: { direct: 'idle', export: 'idle', capture: 'idle' },
      progress: {},
      logs: [],
      activeStage: null,
      result: null,
      error: null,
      startedAt: Date.now(),
      link: linkArg,
      mode: modeArg,
    })
    setNow(Date.now())
    try {
      const { id } = await apiStartJob(linkArg, modeArg)
      setJob((prev) => (prev ? { ...prev, id } : prev))
      wsRef.current = openJobSocket(id, applyEvent, () => refreshHistory())
    } catch (e) {
      setJob((prev) => ({
        ...(prev || {}),
        status: 'error',
        finishedAt: Date.now(),
        error: {
          message: e.message,
          hint: 'Check that the local server is still running.',
        },
      }))
    }
  }

  function retry() {
    start(job?.link || link, job?.mode || mode)
  }

  function retryFromHistory(l, m) {
    setLink(l)
    setMode(m)
    start(l, m)
  }

  function reset() {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setJob(null)
  }

  const demoteCta = job?.status === 'done'

  return (
    <div className="shell">
      <header className="topbar reveal">
        <div className="brand">
          <BrandMark />
          <span className="brand-name">GDrive Down</span>
        </div>
        <div className="topbar-meta">
          v1.1 <span className="dot">·</span> runs on 127.0.0.1
        </div>
      </header>

      <section className="hero reveal reveal-1">
        <h1>Paste a link. Get the file.</h1>
        <p>
          Public <span className="em">PDFs and decks</span> download straight from the Drive
          servers. View-only files are captured page-by-page in a real browser and rebuilt
          as a single PDF — <span className="em">no manual steps</span>.
        </p>
      </section>

      <LinkComposer
        link={link}
        setLink={setLink}
        mode={mode}
        setMode={setMode}
        onSubmit={() => start()}
        running={running}
        demoteCta={demoteCta}
        detectInfo={detectInfo}
      />

      <PipelineRail job={job} now={now} />

      {job?.status === 'done' && job.result ? (
        <ResultCard
          result={job.result}
          fromCapture={job.stages?.capture === 'ok'}
          onReset={reset}
        />
      ) : null}

      {job?.status === 'error' ? <ErrorCard error={job.error} onRetry={retry} /> : null}

      <HistoryList jobs={history} onRetry={retryFromHistory} />

      <footer className="footer reveal reveal-3">
        <span>Runs entirely on this machine. Nothing leaves it except requests to Google.</span>
        <span className="mono">prefer the terminal? python gdrive_down.py</span>
      </footer>
    </div>
  )
}
