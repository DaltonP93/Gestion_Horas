'use client'
import { useState, useRef, useEffect } from 'react'
import { Languages, Check } from 'lucide-react'
import { useI18n, type Locale } from '@/i18n/I18nProvider'
import { PopoverSurface, popoverItemClass } from '@/components/ui/Popover'

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
        className="flex items-center gap-1.5 text-slate-600 hover:bg-slate-100 transition-colors rounded-lg px-2.5 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-white/70 dark:hover:bg-white/[0.06]"
        title="Idioma / Language"
        aria-label="Cambiar idioma"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Languages size={16} />
        <span className="text-xs font-medium uppercase">{current.code}</span>
      </button>

      {open && (
        <PopoverSurface role="menu" aria-label="Idioma" className="right-0 mt-2 w-44 py-1">
          {LANGS.map(l => {
            const isCurrent = l.code === locale
            return (
              <button key={l.code}
                role="menuitem"
                onClick={() => { setLocale(l.code); setOpen(false) }}
                aria-current={isCurrent ? 'true' : undefined}
                className={
                  popoverItemClass('') +
                  (isCurrent ? ' text-blue-600 font-medium dark:text-blue-300' : '')
                }>
                <span className="text-lg" aria-hidden="true">{l.flag}</span>
                <span className="flex-1">{l.label}</span>
                {isCurrent && <Check size={14} />}
              </button>
            )
          })}
        </PopoverSurface>
      )}
    </div>
  )
}
