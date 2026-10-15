// Thin API client.
// Locally, API_BASE is empty: requests go to the same origin (the FastAPI
// server serves this UI). When the UI is hosted elsewhere (e.g. Vercel),
// build with VITE_API_BASE=https://your-backend.example.com to point at a
// remotely running backend.

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

export function apiPath(path) {
  return `${API_BASE}${path}`
}

function wsUrl(path) {
  if (API_BASE) return `${API_BASE.replace(/^http/, 'ws')}${path}`
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${path}`
}

export async function apiStartJob(link, mode) {
  const res = await fetch(apiPath('/api/jobs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link, mode }),
  })
  if (!res.ok) {
    let detail = 'Could not start the job.'
    try {
      const body = await res.json()
      if (body && body.detail) detail = body.detail
    } catch {
      /* keep default */
    }
    throw new Error(detail)
  }
  return res.json()
}

export async function apiListJobs() {
  const res = await fetch(apiPath('/api/jobs'))
  if (!res.ok) throw new Error('Could not load history.')
  const data = await res.json()
  return data.jobs || []
}

export function openJobSocket(jobId, onEvent, onClose) {
  const ws = new WebSocket(wsUrl(`/ws/jobs/${jobId}`))
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data))
    } catch {
      /* ignore malformed frame */
    }
  }
  ws.onclose = () => {
    if (onClose) onClose()
  }
  ws.onerror = () => {
    /* close event follows; nothing else to do */
  }
  return ws
}
