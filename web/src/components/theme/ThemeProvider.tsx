'use client'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

type ThemeCtx = { dark: boolean; setDark: (v: boolean) => void; toggle: () => void }

const Ctx = createContext<ThemeCtx>({ dark: true, setDark: () => {}, toggle: () => {} })

/**
 * Gestiona el tema Futurista (Onyx & Glow / Soft Arctic).
 * Aplica la clase `dark` sobre <html> y persiste la preferencia.
 * Por defecto arranca en oscuro, fiel al prototipo.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [dark, setDarkState] = useState(true)

  // Hidratar desde localStorage / preferencia del sistema en el cliente
  useEffect(() => {
    let initial = true
    try {
      const saved = localStorage.getItem('sish_theme')
      if (saved) initial = saved !== 'light'
      else if (window.matchMedia) initial = window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch {}
    setDarkState(initial)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try { localStorage.setItem('sish_theme', dark ? 'dark' : 'light') } catch {}
  }, [dark])

  const setDark = useCallback((v: boolean) => setDarkState(v), [])
  const toggle = useCallback(() => setDarkState(v => !v), [])

  return <Ctx.Provider value={{ dark, setDark, toggle }}>{children}</Ctx.Provider>
}

export function useTheme() {
  return useContext(Ctx)
}
