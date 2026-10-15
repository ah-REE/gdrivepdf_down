import { useCallback, useEffect, useState } from 'react'

// Theme source of truth: <html data-theme="light|dark">, set pre-paint by
// an inline script in index.html. This hook keeps React in sync and
// persists user overrides to localStorage.

function current() {
  const t = document.documentElement.dataset.theme
  return t === 'dark' ? 'dark' : 'light'
}

export function useTheme() {
  const [theme, setTheme] = useState(current)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('gdd-theme', theme)
    } catch {
      /* private mode: ignore */
    }
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, toggle }
}
