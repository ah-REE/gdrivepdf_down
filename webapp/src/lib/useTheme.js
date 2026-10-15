import { useCallback, useEffect, useState } from 'react'

// Theme source of truth: <html data-theme="dark|light">, set pre-paint by
// an inline script in index.html. This hook keeps React in sync and
// persists user overrides to localStorage (v2 key: the redesigned dark
// theme is the default).

const KEY = 'gdd-theme-v2'

function current() {
  const t = document.documentElement.dataset.theme
  return t === 'light' ? 'light' : 'dark'
}

export function useTheme() {
  const [theme, setTheme] = useState(current)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* private mode: ignore */
    }
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, toggle }
}
