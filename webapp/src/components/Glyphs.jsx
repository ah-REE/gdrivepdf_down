// Monoline 1.7px SVG glyphs. All stroke=currentColor, no fills
// (brand mark excepted). No emoji anywhere — per design system rules.

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path
        d="M16 7v12m0 0l-5-5m5 5l5-5M9.5 25h13"
        stroke="var(--accent-ink)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

export function IconLink({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.7" {...base}>
      <path d="M10.6 13.4a4.2 4.2 0 0 0 5.9 0l2.6-2.6a4.2 4.2 0 1 0-5.9-5.9l-1.1 1.1" />
      <path d="M13.4 10.6a4.2 4.2 0 0 0-5.9 0l-2.6 2.6a4.2 4.2 0 1 0 5.9 5.9l1.1-1.1" />
    </svg>
  )
}

export function IconPaste({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.7" {...base}>
      <rect x="6.5" y="4.5" width="11" height="15" rx="2" />
      <path d="M9.5 4.5v-1A1.5 1.5 0 0 1 11 2h2a1.5 1.5 0 0 1 1.5 1.5v1" />
      <path d="M9.5 11.5h5M9.5 14.5h5" />
    </svg>
  )
}

export function IconArrowRight({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.8" {...base}>
      <path d="M4 12h15" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  )
}

export function IconDownload({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.8" {...base}>
      <path d="M12 3.5v11.5" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4.5 20h15" />
    </svg>
  )
}

export function IconCheck({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.9" {...base}>
      <path d="M4.5 12.5l5 5L20 6.5" />
    </svg>
  )
}

export function IconX({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.9" {...base}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function IconMinus({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.7" {...base}>
      <path d="M6 12h12" />
    </svg>
  )
}

export function IconDot({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.4" fill="currentColor" />
    </svg>
  )
}

export function IconAlert({ size = 17 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="1.7" {...base}>
      <path d="M12 3.8l9.2 15.7H2.8z" />
      <path d="M12 9.5v5" />
      <circle cx="12" cy="17.4" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

const FAMILY_LABEL = {
  pdf: 'PDF',
  pptx: 'PPT',
  docx: 'DOC',
  xlsx: 'XLS',
  zip: 'ZIP',
  bin: 'FILE',
}

export function FileGlyph({ family = 'bin', size = 44 }) {
  const label = FAMILY_LABEL[family] || 'FILE'
  return (
    <svg width={size * 0.84} height={size} viewBox="0 0 42 50" aria-hidden="true">
      <path
        d="M7 4h16l12 12v28a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M23 4v12h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <text
        x="20.5"
        y="38"
        textAnchor="middle"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="9.5"
        letterSpacing="1"
        fill="currentColor"
      >
        {label}
      </text>
    </svg>
  )
}
