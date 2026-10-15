import { apiPath } from '../lib/api.js'
import { fmtBytes } from '../lib/format.js'
import { FileGlyph, IconDownload } from './Glyphs.jsx'

export default function ResultCard({ result, fromCapture, onReset }) {
  return (
    <section className="result" aria-label="Download ready">
      <div className="result-glyph">
        <FileGlyph family={result.family} size={44} />
      </div>
      <div className="result-body">
        <div className="result-name" title={result.name}>
          {result.name}
        </div>
        <div className="result-meta">
          {fmtBytes(result.size)} · {(result.family || 'file').toUpperCase()}
          {fromCapture ? ' · rebuilt from preview' : ''}
        </div>
        {fromCapture ? (
          <div className="result-note">
            Captured page-by-page in the browser and stitched into a single PDF.
          </div>
        ) : null}
      </div>
      <div className="result-actions">
        <a
          className="btn-primary"
          href={apiPath(`/api/jobs/${result.job_id}/file`)}
          download={result.name}
        >
          <IconDownload size={17} /> Save file
        </a>
        <button type="button" className="btn-ghost" onClick={onReset}>
          New download
        </button>
      </div>
    </section>
  )
}
