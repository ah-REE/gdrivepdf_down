// Icon layer. Glyphs come from Phosphor Icons (one family, one weight);
// only the product mark is custom, per the design rules.
import {
  ArrowRight,
  CaretDown,
  Check,
  Circle,
  ClipboardText,
  DownloadSimple,
  File,
  FileDoc,
  FilePdf,
  FilePpt,
  FileXls,
  FileZip,
  LinkSimple,
  Minus,
  Moon,
  Sun,
  Warning,
  X,
} from '@phosphor-icons/react'

const bold = (Icon) =>
  function Glyph(props) {
    return <Icon weight="bold" {...props} />
  }

export const IconArrowRight = bold(ArrowRight)
export const IconChevron = bold(CaretDown)
export const IconCheck = bold(Check)
export const IconDot = (props) => <Circle weight="fill" {...props} />
export const IconPaste = bold(ClipboardText)
export const IconDownload = bold(DownloadSimple)
export const IconLink = bold(LinkSimple)
export const IconMinus = bold(Minus)
export const IconX = bold(X)
export const IconAlert = bold(Warning)
export const IconSun = bold(Sun)
export const IconMoon = bold(Moon)

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" fill="var(--red)" />
      <path
        d="M16 7v12m0 0l-5-5m5 5l5-5M9.5 25h13"
        stroke="var(--ink)"
        strokeWidth="2.6"
        strokeLinecap="square"
        strokeLinejoin="miter"
        fill="none"
      />
    </svg>
  )
}

const FILE_ICONS = {
  pdf: FilePdf,
  pptx: FilePpt,
  docx: FileDoc,
  xlsx: FileXls,
  zip: FileZip,
}

export function FileGlyph({ family = 'bin', size = 30 }) {
  const Icon = FILE_ICONS[family] || File
  return <Icon size={size} weight="bold" />
}
