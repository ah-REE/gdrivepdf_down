const ITEMS = [
  'PASTE A LINK',
  'GET THE FILE',
  'RUNS LOCALLY',
  'NO BOOKMARKS',
  'NO WAITING',
  'DRIVE → PDF',
]

export default function Ticker() {
  const row = (key) => (
    <div className="ticker-row" key={key} aria-hidden={key === 'b'}>
      {ITEMS.map((t) => (
        <span key={t} className="ticker-item">
          {t} <i aria-hidden="true">✱</i>
        </span>
      ))}
    </div>
  )
  return (
    <div className="ticker" role="presentation">
      <div className="ticker-track">
        {row('a')}
        {row('b')}
      </div>
    </div>
  )
}
