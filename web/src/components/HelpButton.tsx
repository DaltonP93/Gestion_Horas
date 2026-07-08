'use client'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { HelpCircle, X, ChevronRight, BookOpen } from 'lucide-react'
import { getHelpContent, type HelpContent } from '@/data/helpContent'

/**
 * HelpButton — botón flotante "?" con panel de ayuda contextual.
 * Se monta en el AppLayout y muestra documentación del módulo actual.
 */
export default function HelpButton() {
  const pathname  = usePathname()
  const [open, setOpen]       = useState(false)
  const [content, setContent] = useState<HelpContent | null>(null)
  const [pulse, setPulse]     = useState(false)

  // Actualizar contenido cuando cambia la ruta
  useEffect(() => {
    const c = getHelpContent(pathname)
    setContent(c)
    setOpen(false)
    // Pulsar el botón brevemente al cambiar de página si hay contenido
    if (c) {
      setPulse(true)
      const t = setTimeout(() => setPulse(false), 2000)
      return () => clearTimeout(t)
    }
  }, [pathname])

  // Cerrar con Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // No mostrar si no hay contenido para este módulo
  if (!content) return null

  return (
    <>
      {/* Botón flotante */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Ayuda del módulo"
        className={`
          fixed bottom-20 right-4 z-40 md:bottom-6
          w-11 h-11 rounded-full shadow-lg flex items-center justify-center
          bg-blue-600 hover:bg-blue-700 active:scale-95
          text-white transition-all duration-200
          ${pulse ? 'ring-4 ring-blue-300 ring-opacity-60 animate-pulse' : ''}
        `}
      >
        <HelpCircle size={22} />
      </button>

      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      {/* Panel lateral */}
      <aside
        className={`
          fixed top-0 right-0 z-50 h-full w-full max-w-sm bg-white shadow-2xl
          flex flex-col transition-transform duration-300 ease-in-out
          ${open ? 'translate-x-0' : 'translate-x-full'}
        `}
        aria-label="Panel de ayuda"
        role="complementary"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-blue-600 text-white flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <BookOpen size={20} />
            <div>
              <p className="text-xs font-medium text-blue-200 uppercase tracking-wide">Ayuda</p>
              <h2 className="text-base font-semibold leading-tight">{content.title}</h2>
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-lg hover:bg-blue-500 transition-colors"
            aria-label="Cerrar ayuda"
          >
            <X size={18} />
          </button>
        </div>

        {/* Contenido scrolleable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Intro */}
          <p className="text-slate-600 text-sm leading-relaxed border-l-4 border-blue-100 pl-3 bg-blue-50 py-2 pr-2 rounded-r-lg dark:text-white/60">
            {content.intro}
          </p>

          {/* Secciones */}
          {content.sections.map((section, si) => (
            <div key={si}>
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5 dark:text-white/40">
                <span className="w-4 h-0.5 bg-blue-300 rounded" />
                {section.heading}
              </h3>
              <ul className="space-y-2">
                {section.items.map((item, ii) => (
                  <li key={ii} className="flex items-start gap-2 text-sm text-slate-700 dark:text-white/80">
                    <ChevronRight size={13} className="text-blue-400 flex-shrink-0 mt-0.5" />
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 flex-shrink-0 dark:border-white/[0.06]">
          <p className="text-xs text-slate-400 text-center dark:text-white/30">
            Sistema de Asistencia — Documentación interna
          </p>
        </div>
      </aside>
    </>
  )
}
