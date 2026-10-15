import { fmtClock } from '../lib/format.js'

// Shown when the backend is unreachable or slow to answer — typical on
// Render's free tier, which sleeps after ~15 minutes of inactivity and
// takes up to a minute to wake on the next request.
export default function WakeBanner({ since, now, onRetryNow }) {
  const elapsed = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0

  return (
    <section className="wake" role="status" aria-live="polite" aria-label="Server is waking up">
      <div className="wake-row">
        <span className="wake-dot pulse" aria-hidden="true" />
        <div className="wake-text">
          <div className="wake-title">Waking the server up…</div>
          {elapsed > 150 ? (
            <div className="wake-sub">
              Unusually slow. Check the service on{' '}
              <a href="https://dashboard.render.com" target="_blank" rel="noreferrer">
                the Render dashboard
              </a>
              .
            </div>
          ) : elapsed > 60 ? (
            <div className="wake-sub">
              Still waking — a cold start after a long sleep can take a little longer.
              Hang tight, it retries on its own.
            </div>
          ) : (
            <div className="wake-sub">
              The hosted backend sleeps after idle time (Render free tier). The first
              request usually takes up to ~60 seconds.
            </div>
          )}
        </div>
        <div className="wake-right">
          <span className="mono wake-elapsed">{fmtClock(elapsed)}</span>
          <button type="button" className="mini-btn" onClick={onRetryNow}>
            Check now
          </button>
        </div>
      </div>
      <div className="progress-track wake-track">
        <div className="progress-fill indeterminate" />
      </div>
    </section>
  )
}
