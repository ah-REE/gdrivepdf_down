export function fmtBytes(n) {
  if (!n && n !== 0) return '—'
  if (n < 1024) return `${n} B`
  const mb = n / 1e6
  if (mb < 0.995) return `${(n / 1024).toFixed(0)} KB`
  if (mb < 995) return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`
  return `${(mb / 1000).toFixed(2)} GB`
}

export function fmtClock(totalSec) {
  const s = Math.max(0, Math.floor(totalSec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function timeAgo(ts) {
  const sec = Math.max(0, (Date.now() / 1000) - ts)
  if (sec < 45) return 'just now'
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`
  return `${Math.round(sec / 86400)} d ago`
}

export function shortId(id) {
  if (!id) return ''
  return id.length > 12 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id
}
