// Shared link helpers (used by both the backend mode and the static mode).

export function detect(link) {
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

// A URL the browser can download directly by navigation (no CORS needed:
// the response carries Content-Disposition: attachment).
export function directDownloadUrl(kind, id) {
  if (kind === 'document') {
    return `https://docs.google.com/document/d/${id}/export?format=pdf`
  }
  if (kind === 'presentation') {
    return `https://docs.google.com/presentation/d/${id}/export?format=pptx`
  }
  if (kind === 'spreadsheets') {
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`
  }
  if (kind === 'forms') return null
  return `https://drive.usercontent.google.com/download?id=${id}&export=download`
}
