import { fmtBytes, fmtClock } from '../lib/format.js'
import { IconCheck, IconDot, IconMinus, IconX } from './Glyphs.jsx'

const STAGE_DEFS = [
  { key: 'direct', name: 'Direct', idle: 'server download' },
  { key: 'export', name: 'Export', idle: 'docs export' },
  { key: 'capture', name: 'Capture', idle: 'browser to PDF' },
]

const STAGE_LABEL = {
  direct: 'direct download',
  export: 'native export',
  capture: 'browser capture',
}

function firstRunning(stages) {
  for (const k of ['direct', 'export', 'capture']) {
    if (stages[k] === 'running') return k
  }
  return null
}

function stageDetail(key, state, progress) {
  const p = progress[key]
  if (key === 'capture') {
    if (state === 'running' && p) return `page ${p.done} / ${p.total || '…'}`
    if (state === 'ok') return 'rebuilt'
    if (state === 'failed') return 'failed'
    if (state === 'skipped') return 'skipped'
    return null
  }
  if (state === 'running' && p) {
    return p.total ? `${fmtBytes(p.done)} / ${fmtBytes(p.total)}` : fmtBytes(p.done)
  }
  if (state === 'ok') return key === 'direct' ? 'downloaded' : 'exported'
  if (state === 'failed') return 'failed'
  if (state === 'skipped') return 'skipped'
  return null
}

function StageIcon({ state }) {
  if (state === 'running') {
    return (
      <span className="pulse">
        <IconDot size={14} />
      </span>
    )
  }
  if (state === 'ok') return <IconCheck size={15} />
  if (state === 'failed') return <IconX size={15} />
  return <IconMinus size={15} />
}

export default function PipelineRail({ job, now }) {
  const stages = job?.stages || { direct: 'idle', export: 'idle', capture: 'idle' }
  const progress = job?.progress || {}
  const running = Boolean(job && (job.status === 'queued' || job.status === 'running'))
  const elapsed = job ? Math.max(0, ((job.finishedAt || now) - job.startedAt) / 1000) : 0

  const active = running ? job.activeStage || firstRunning(stages) : null
  const ap = active ? progress[active] : null
  const determinate = Boolean(ap && ap.total > 0)
  const pct = determinate ? Math.min(100, (ap.done / ap.total) * 100) : 0
  const slow = running && elapsed > 15

  const statusText = !job
    ? 'Waiting for a link'
    : running
      ? `Running · ${fmtClock(elapsed)}`
      : job.status === 'done'
        ? `Finished in ${fmtClock(elapsed)}`
        : `Failed · ${fmtClock(elapsed)}`

  const liveText = !job
    ? 'Waiting for a link.'
    : running
      ? `Working: ${STAGE_LABEL[active] || 'starting'}, ${Math.round(elapsed)} seconds elapsed.`
      : job.status === 'done'
        ? 'Download finished.'
        : 'Download failed.'

  const lastLog = job && job.logs.length > 0 ? job.logs[job.logs.length - 1] : null

  return (
    <section className="pipeline reveal reveal-3" aria-label="Download pipeline">
      <div className="pipeline-head">
        <span className="caps">Pipeline</span>
        <span className="pipeline-status">{statusText}</span>
      </div>

      <div className="rail">
        {STAGE_DEFS.map((s) => {
          const state = stages[s.key] || 'idle'
          const detail = stageDetail(s.key, state, progress)
          return (
            <div
              key={s.key}
              className={`stage s-${state}${state === 'ok' ? ' passed' : ''}`}
            >
              <div className="stage-head">
                <span className="stage-name">{s.name}</span>
                <span className="stage-icon">
                  <StageIcon state={state} />
                </span>
              </div>
              <div
                className={`stage-detail${state === 'idle' || state === 'skipped' ? ' dim' : ''}`}
              >
                {detail || s.idle}
              </div>
            </div>
          )
        })}
      </div>

      {running ? (
        <div className="progress-area">
          <div className="progress-track">
            <div
              className={`progress-fill${determinate ? '' : ' indeterminate'}`}
              style={determinate ? { width: `${pct}%` } : undefined}
            />
          </div>
          <div className="progress-meta">
            <span>{active ? STAGE_LABEL[active] : 'starting'}</span>
            <span>
              {determinate && active === 'capture'
                ? `page ${ap.done} / ${ap.total}`
                : determinate
                  ? `${fmtBytes(ap.done)} / ${fmtBytes(ap.total)}`
                  : 'negotiating…'}
            </span>
          </div>
          {lastLog ? <div className="log-line">{lastLog}</div> : null}
          {slow ? (
            <div className="slow-note">
              Taking longer than expected. Large captures can take several minutes; leave
              this tab open.
            </div>
          ) : null}
        </div>
      ) : null}

      {!running && lastLog ? (
        <div className="progress-area">
          <div className="log-line">{lastLog}</div>
        </div>
      ) : null}

      <p className="sr-only" role="status">
        {liveText}
      </p>
    </section>
  )
}
