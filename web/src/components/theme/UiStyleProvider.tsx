'use client'
import { useEffect } from 'react'
import { apiUrl } from '@/lib/api'

export type UiStyle =
  | 'liquidglass' | 'glassmorphism' | 'maximalismo'
  | 'minimalismo' | 'spatial' | 'claymorphism' | 'brutalismo'

export type UiDensity = 'compact' | 'comfortable' | 'spacious'

export interface UiConfig {
  style?: UiStyle
  density?: UiDensity
  accent?: string
  accent2?: string
  motion?: boolean
}

const VALID_STYLES: UiStyle[] = [
  'liquidglass', 'glassmorphism', 'maximalismo',
  'minimalismo', 'spatial', 'claymorphism', 'brutalismo',
]

/**
 * Aplica la configuración de UI (estilo global, densidad y acento) sobre el
 * elemento <html>, para que toda la app la herede vía tokens CSS.
 * Exportado también para previsualizar en vivo desde el panel de apariencia.
 */
export function applyUiConfig(cfg: UiConfig) {
  const root = document.documentElement
  const style = cfg.style && VALID_STYLES.includes(cfg.style) ? cfg.style : 'liquidglass'
  root.setAttribute('data-ui-style', style)
  root.setAttribute('data-ui-density', cfg.density || 'comfortable')
  if (cfg.accent) root.style.setProperty('--accent', cfg.accent)
  if (cfg.accent2) root.style.setProperty('--accent-2', cfg.accent2)
  root.setAttribute('data-ui-motion', cfg.motion === false ? '0' : '1')
}

/**
 * Lee la configuración persistida (settings públicos) y la aplica al arrancar.
 * Cachea en localStorage para evitar "flash" del estilo por defecto.
 */
export function UiStyleProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // 1) Aplicar de inmediato lo cacheado (sin esperar red)
    try {
      const cached = localStorage.getItem('sish_ui')
      if (cached) applyUiConfig(JSON.parse(cached))
      else applyUiConfig({ style: 'liquidglass' })
    } catch { applyUiConfig({ style: 'liquidglass' }) }

    // 2) Refrescar desde el backend
    fetch(apiUrl('/api/settings'))
      .then(r => (r.ok ? r.json() : null))
      .then(s => {
        if (!s) return
        const cfg: UiConfig = {
          style: s.system_ui_style || 'liquidglass',
          density: s.system_ui_density || 'comfortable',
          accent: s.system_ui_accent || s.system_primary_color || undefined,
          accent2: s.system_secondary_color || undefined,
          motion: s.system_ui_motion !== '0',
        }
        applyUiConfig(cfg)
        try { localStorage.setItem('sish_ui', JSON.stringify(cfg)) } catch {}
      })
      .catch(() => {})
  }, [])

  return <>{children}</>
}
