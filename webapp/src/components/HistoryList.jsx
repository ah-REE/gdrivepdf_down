import { apiPath } from '../lib/api.js'
import { fmtBytes, shortId, timeAgo } from '../lib/format.js'
import { IconCheck, IconDot, IconDownload, IconX } from './Glyphs.jsx'

const STATUS_LABEL = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  error: 'failed',
}

function StatusIcon({ status }) {
  if (status === 'done') {
    return (
      <span className="status-icon ok">
        <IconCheck size={15} />
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="status-icon err">
        <IconX size={15} />
      </span>
    )
  }
  if (status === 'running' || status === 'queued') {
    return (
      <span className="status-icon run pulse">
        <IconDot size={14} />
      </span>
    )
  }
  return (
    <span className="status-icon">
      <IconDot size={14} />
    </span>
  )
}

function displayLink(link) {
  const m = (link || '').match(/[A-Za-z0-9_-]{25,}/)
  if (m) return `drive ${shortId(m[0])}`
  const t = (link || '').trim()
  return t.length > 46 ? `${t.slice(0, 46)}…` : t
}

export default function HistoryList({ jobs, onRetry }) {
  return (
    <section className="history" aria-label="Recent downloads">
      <div className="history-head">
        <span className="caps">Recent</span>
        {jobs.length > 0 ? <span className="caps">{jobs.length}</span> : null}
      </div>

      {jobs.length === 0 ? (
        <div className="history-list">
          <div className="empty">
            <div className="empty-title">Nothing here yet.</div>
            <div className="empty-sub">
              Finished downloads list themselves here. Files land in the{' '}
              <span className="mono">downloads/</span> folder next to the app.
            </div>
            <div className="empty-steps">
              <span className="empty-step">
                <span className="step-num">1</span>
                <span>
                  <b>Paste</b> a Drive link
                </span>
              </span>
              <span className="empty-step">
                <span className="step-num">2</span>
                <span>
                  <b>Watch</b> the pipeline
                </span>
              </span>
              <span className="empty-step">
                <span className="step-num">3</span>
                <span>
                  <b>Save</b> the file
                </span>
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="history-list">
          {jobs.map((j) => (
            <div className="history-row" key={j.id}>
              <StatusIcon status={j.status} />
              <div className="history-main">
                <div className="history-name" title={j.result?.name || j.link}>
                  {j.result?.name || displayLink(j.link)}
                </div>
                <div className="history-sub">
                  {STATUS_LABEL[j.status] || j.status}
                  {j.result ? ` · ${fmtBytes(j.result.size)}` : ''} · {j.mode} ·{' '}
                  {timeAgo(j.created)}
                  {j.error?.message ? ` · ${j.error.message}` : ''}
                </div>
              </div>
              <div className="history-actions">
                {j.status === 'done' && j.result ? (
                  <a
                    className="mini-btn"
                    href={apiPath(`/api/jobs/${j.id}/file`)}
                    download={j.result.name}
                  >
                    <IconDownload size={13} /> Save
                  </a>
                ) : null}
                {j.status === 'error' ? (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => onRetry(j.link, j.mode)}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
