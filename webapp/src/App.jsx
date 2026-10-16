import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import LinkComposer from './components/LinkComposer.jsx'
import PipelineRail from './components/PipelineRail.jsx'
import ResultCard from './components/ResultCard.jsx'
import HistoryList from './components/HistoryList.jsx'
import WakeBanner from './components/WakeBanner.jsx'
import { BrandMark, IconAlert, IconMoon, IconSun } from './components/Glyphs.jsx'
import { apiHealth, apiListJobs, apiStartJob, openJobSocket } from './lib/api.js'
import { useTheme } from './lib/useTheme.js'
import { MODE } from './config.js'
import { detect } from './lib/link.js'
import StaticApp from './components/StaticApp.jsx'

export default function App() {
  return MODE === 'static' ? <StaticApp /> : <BackendApp />
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

function BackendApp() {
  const [link, setLink] = useState('')
  const [mode, setMode] = useState('auto')
  const [job, setJob] = useState(null)
  const [history, setHistory] = useState([])
  const [now, setNow] = useState(Date.now())
  const [server, setServer] = useState({ status: 'unknown', since: null })
  const [pendingStart, setPendingStart] = useState(null)

  const wsRef = useRef(null)
  const wsRetryRef = useRef(0)
  const lastSeqRef = useRef(0)
  const wasWakingRef = useRef(false)
  const reconnectTimerRef = useRef(null)
  const jobRunningRef = useRef(false)
  const serverStatusRef = useRef('unknown')
  const startRef = useRef(null)

  const { theme, toggle } = useTheme()

  const detectInfo = useMemo(() => detect(link), [link])
  const running = Boolean(job && (job.status === 'queued' || job.status === 'running'))
  const waking = server.status === 'waking'

  useEffect(() => {
    jobRunningRef.current = running
  }, [running])

  useEffect(() => {
    serverStatusRef.current = server.status
  }, [server.status])

  useEffect(() => {
    if (!running && !waking) return undefined
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [running, waking])

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await apiListJobs())
    } catch {
      /* server restarting; keep the last known list */
    }
  }, [])

  const checkHealth = useCallback(async () => {
    const ok = await apiHealth()
    if (ok) {
      if (wasWakingRef.current) refreshHistory()
      wasWakingRef.current = false
      setServer((prev) => (prev.status === 'awake' ? prev : { status: 'awake', since: null }))
    } else {
      wasWakingRef.current = true
      setServer((prev) =>
        prev.status === 'waking' ? prev : { status: 'waking', since: Date.now() },
      )
    }
    return ok
  }, [refreshHistory])

  useEffect(() => {
    checkHealth()
    refreshHistory()
    const onVis = () => {
      if (document.visibilityState === 'visible' && serverStatusRef.current !== 'awake') {
        checkHealth()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      if (wsRef.current) wsRef.current.close()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    }
  }, [checkHealth])

  useEffect(() => {
    if (server.status !== 'waking') return undefined
    const iv = setInterval(() => {
      checkHealth()
    }, 3000)
    return () => clearInterval(iv)
  }, [server.status, checkHealth])

  function applyEvent(ev) {
    if (typeof ev.seq === 'number') {
      if (ev.seq <= lastSeqRef.current) return
      lastSeqRef.current = ev.seq
    }
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

  const connectSocketRef = useRef(null)
  connectSocketRef.current = (id) => {
    wsRef.current = openJobSocket(id, applyEvent, () => {
      if (jobRunningRef.current && wsRetryRef.current < 6) {
        wsRetryRef.current += 1
        reconnectTimerRef.current = setTimeout(() => {
          connectSocketRef.current?.(id)
        }, 1800)
      }
      refreshHistory()
    })
  }

  const start = useCallback(
    async (linkArg = link, modeArg = mode) => {
      const info = detect(linkArg)
      if (!info || !info.id || jobRunningRef.current) return
      if (serverStatusRef.current === 'waking') {
        setPendingStart({ link: linkArg, mode: modeArg })
        return
      }
      if (wsRef.current) {
        try {
          wsRef.current.close()
        } catch {
          /* noop */
        }
        wsRef.current = null
      }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      lastSeqRef.current = 0
      wsRetryRef.current = 0
      setPendingStart(null)
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
        connectSocketRef.current?.(id)
      } catch (e) {
        if (e.isNetwork) {
          wasWakingRef.current = true
          setServer({ status: 'waking', since: Date.now() })
          setPendingStart({ link: linkArg, mode: modeArg })
          setJob(null)
        } else {
          setJob((prev) => ({
            ...(prev || {}),
            status: 'error',
            finishedAt: Date.now(),
            error: {
              message: e.message,
              hint: 'Check that the server is still reachable.',
            },
          }))
        }
      }
    },
    [link, mode],
  )
  startRef.current = start

  useEffect(() => {
    if (server.status === 'awake' && pendingStart) {
      const ps = pendingStart
      setPendingStart(null)
      startRef.current?.(ps.link, ps.mode)
    }
  }, [server.status, pendingStart])

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
        <div className="topbar-right">
          <span className="topbar-version">v1.6</span>
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
          Public files download directly from Google. View-only PDFs and decks are captured
          in a real browser and rebuilt as one PDF.
        </p>
      </section>

      <LinkComposer
        link={link}
        setLink={setLink}
        mode={mode}
        setMode={setMode}
        onSubmit={() => start()}
        running={running}
        waking={waking}
        demoteCta={demoteCta}
        detectInfo={detectInfo}
      />

      {waking ? (
        <WakeBanner since={server.since} now={now} onRetryNow={checkHealth} />
      ) : null}

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
        <span>Runs on this machine or hosted. Requests go to Google and your own backend only.</span>
        <span className="mono">python gdrive_down.py for the CLI</span>
      </footer>
    </div>
  )
}
