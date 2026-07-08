'use client'
import { useState, useRef, useEffect } from 'react'
import { Languages, Check } from 'lucide-react'
import { useI18n, type Locale } from '@/i18n/I18nProvider'

const LANGS: { code: Locale; flag: string; label: string }[] = [
  { code: 'es', flag: '🇪🇸', label: 'Español' },
  { code: 'en', flag: '🇺🇸', label: 'English' },
  { code: 'pt', flag: '🇧🇷', label: 'Português' },
]

export default function LanguageSwitcher() {
  const { locale, setLocale } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const current = LANGS.find(l => l.code === locale) || LANGS[0]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        className="flex items-center gap-1.5 text-slate-500 hover:bg-slate-100 transition-colors rounded-lg px-2.5 py-1.5 dark:text-white/40 dark:hover:bg-white/[0.06]"
        title="Idioma / Language"
        aria-label="Cambiar idioma"
      >
        <Languages size={16} />
        <span className="text-xs font-medium uppercase">{current.code}</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-44 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-50 dark:bg-white/[0.04] dark:border-white/[0.06]">
          {LANGS.map(l => (
            <button key={l.code}
              onClick={() => { setLocale(l.code); setOpen(false) }}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 transition-colors text-left ${
                l.code === locale ? 'text-blue-600 font-medium' : 'text-slate-700'
              }`}>
              <span className="text-lg">{l.flag}</span>
              <span className="flex-1">{l.label}</span>
              {l.code === locale && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
