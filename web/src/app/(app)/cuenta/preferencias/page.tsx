'use client'
import { useEffect, useState } from 'react'
import { SlidersHorizontal, Save, CheckCircle, AlertCircle, Moon, Sun } from 'lucide-react'
import { api } from '@/lib/api'
import { useI18n, type Locale } from '@/i18n/I18nProvider'
import { useTheme } from '@/components/theme/ThemeProvider'

const LANGS: { value: Locale; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
  { value: 'pt', label: 'Português' },
]

// Zonas horarias frecuentes en la región (Paraguay por defecto).
const TIMEZONES = [
  'America/Asuncion', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'America/Montevideo', 'America/Santiago', 'America/La_Paz', 'UTC',
]

export default function PreferenciasPage() {
  const { locale, setLocale } = useI18n()
  const { dark, setDark } = useTheme()
  const [timezone, setTimezone] = useState('America/Asuncion')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    api.get('/api/me').then(({ data }) => {
      if (data.user?.timezone) setTimezone(data.user.timezone)
      if (data.user?.language && ['es','en','pt'].includes(data.user.language)) setLocale(data.user.language)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save() {
    setError(''); setMsg('')
    setSaving(true)
    try {
      await api.patch('/api/me/profile', {
        language: locale,
        timezone,
        ui_prefs: { theme: dark ? 'dark' : 'light' },
      })
      setMsg('Preferencias guardadas.')
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <header className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center">
          <SlidersHorizontal className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Preferencias</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Idioma, zona horaria y apariencia.</p>
        </div>
      </header>

      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-2 text-sm text-red-900"><AlertCircle size={18} /> {error}</div>}
      {msg && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-2 text-sm text-emerald-900"><CheckCircle size={16} /> {msg}</div>}

      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        {/* Idioma */}
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5 dark:text-white/60">Idioma</label>
          <div className="flex gap-2 flex-wrap">
            {LANGS.map(l => (
              <button key={l.value} onClick={() => setLocale(l.value)}
                className={`px-4 py-2 rounded-xl text-sm border transition ${
                  locale === l.value
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-500/10'
                    : 'border-slate-200 hover:bg-slate-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]'
                }`}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {/* Zona horaria */}
        <div>
          <label htmlFor="tz" className="text-xs font-medium text-slate-600 block mb-1.5 dark:text-white/60">Zona horaria</label>
          <select id="tz" value={timezone} onChange={e => setTimezone(e.target.value)}
            className="w-full md:w-80 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]">
            {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>

        {/* Apariencia */}
        <div>
          <label className="text-xs font-medium text-slate-600 block mb-1.5 dark:text-white/60">Apariencia</label>
          <div className="flex gap-2">
            <button onClick={() => setDark(false)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm border transition ${
                !dark ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 hover:bg-slate-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]'
              }`}>
              <Sun size={15} /> Claro
            </button>
            <button onClick={() => setDark(true)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm border transition ${
                dark ? 'border-blue-500 bg-blue-500/10 text-blue-300' : 'border-slate-200 hover:bg-slate-50'
              }`}>
              <Moon size={15} /> Oscuro
            </button>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
            <Save size={16} /> {saving ? 'Guardando…' : 'Guardar preferencias'}
          </button>
        </div>
      </section>
    </div>
  )
}
