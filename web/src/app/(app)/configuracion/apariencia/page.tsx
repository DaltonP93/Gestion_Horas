'use client'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Palette, Upload, RefreshCw, Save, Sun, Moon, Monitor } from 'lucide-react'
import { api } from '@/lib/api'

interface Settings {
  system_name: string; system_company: string
  system_logo_url: string; system_favicon_url: string
  system_pwa_icon_url: string
  system_login_bg: string; system_login_bg_image: string
  system_login_title: string; system_login_subtitle: string; system_login_footer: string
  system_login_layout: 'center' | 'left' | 'right' | 'split'
  system_login_show_datetime: string; system_login_glass: string

  system_primary_color: string; system_secondary_color: string; system_accent_color: string
  system_sidebar_bg: string; system_sidebar_text: string; system_sidebar_active: string
  system_theme_mode: 'light' | 'dark' | 'auto'
  system_font_family: string; system_border_radius: string
}

const FONTS = ['Inter', 'Roboto', 'Poppins', 'Nunito', 'system-ui']
const RADII: Record<string, string> = { sm: '6px', md: '10px', lg: '14px', xl: '20px' }
const LAYOUTS = [
  { k: 'center', label: 'Centrado' },
  { k: 'left',   label: 'Izquierda' },
  { k: 'right',  label: 'Derecha' },
  { k: 'split',  label: 'Dividido' },
]

export default function AparienciaPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string>('')
  const [err, setErr] = useState<string>('')
  const logoRef = useRef<HTMLInputElement>(null)
  const favRef  = useRef<HTMLInputElement>(null)
  const bgRef   = useRef<HTMLInputElement>(null)
  const pwaRef  = useRef<HTMLInputElement>(null)

  async function load() {
    setLoading(true); setErr('')
    try {
      const res = await api.get('/api/settings')
      setS(res.data)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al cargar configuración')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS(prev => prev ? ({ ...prev, [k]: v }) : prev)
  }

  async function save() {
    if (!s) return
    setSaving(true); setMsg(''); setErr('')
    try {
      await api.put('/api/settings', s)
      setMsg('Cambios guardados. Refresca la página para ver los colores aplicados.')
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  async function reset() {
    if (!confirm('¿Restaurar apariencia por defecto?')) return
    setSaving(true); setMsg(''); setErr('')
    try {
      await api.post('/api/settings/reset')
      await load()
      setMsg('Apariencia restaurada.')
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al restaurar')
    } finally { setSaving(false) }
  }

  async function upload(kind: 'logo' | 'favicon' | 'login_bg' | 'pwa_icon', file: File | null) {
    if (!file) return
    const fd = new FormData(); fd.append('file', file)
    try {
      const res = await api.post(`/api/settings/upload?kind=${kind}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      if (kind === 'logo')     set('system_logo_url',       res.data.url)
      if (kind === 'favicon')  set('system_favicon_url',    res.data.url)
      if (kind === 'login_bg') set('system_login_bg_image', res.data.url)
      if (kind === 'pwa_icon') set('system_pwa_icon_url',   res.data.url)
      setMsg('Archivo subido correctamente.')
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Error al subir')
    }
  }

  if (loading || !s) return <div className="p-10 text-center text-slate-400 dark:text-white/30">Cargando...</div>

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <a href="/configuracion" className="text-slate-500 hover:text-slate-700 flex items-center gap-1 text-sm dark:text-white/40">
          <ArrowLeft size={16} /> Volver
        </a>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
            <Palette className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Apariencia</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Branding, tema, sidebar y pantalla de login.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={reset} disabled={saving}
            className="px-3 py-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm flex items-center gap-1 disabled:opacity-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
            <RefreshCw size={14} /> Restaurar
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm flex items-center gap-2 disabled:opacity-50">
            <Save size={14} /> {saving ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </div>

      {msg && <div role="status" className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3">{msg}</div>}
      {err && <div role="alert" className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-xl px-4 py-3">{err}</div>}

      <Section title="Marca e identidad">
        <Row label="Logo">
          <div className="flex items-center gap-3">
            {s.system_logo_url && <img src={s.system_logo_url} alt="logo" className="h-12 rounded bg-slate-100 p-1 dark:bg-white/[0.06]" />}
            <input value={s.system_logo_url} onChange={e => set('system_logo_url', e.target.value)}
              placeholder="URL del logo o sube archivo →"
              className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            <button onClick={() => logoRef.current?.click()}
              className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm flex items-center gap-1 dark:bg-white/[0.06]">
              <Upload size={14} /> Subir
            </button>
            <input ref={logoRef} type="file" accept="image/*" className="hidden"
              onChange={e => upload('logo', e.target.files?.[0] || null)} />
          </div>
        </Row>
        <Row label="Favicon">
          <div className="flex items-center gap-3">
            {s.system_favicon_url && <img src={s.system_favicon_url} alt="favicon" className="w-8 h-8 rounded bg-slate-100 p-1 dark:bg-white/[0.06]" />}
            <input value={s.system_favicon_url} onChange={e => set('system_favicon_url', e.target.value)}
              placeholder="URL del favicon .ico / .png"
              className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            <button onClick={() => favRef.current?.click()}
              className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm flex items-center gap-1 dark:bg-white/[0.06]">
              <Upload size={14} /> Subir
            </button>
            <input ref={favRef} type="file" accept="image/x-icon,image/png,image/svg+xml" className="hidden"
              onChange={e => upload('favicon', e.target.files?.[0] || null)} />
          </div>
        </Row>
        <Row label="Ícono PWA (app móvil)">
          <div className="space-y-2">
            <p className="text-xs text-slate-400 dark:text-white/30">
              Este ícono aparece cuando el usuario instala SisHoras como app desde Chrome/Safari.
              Se recomienda PNG cuadrado 512×512 px o SVG.
            </p>
            <div className="flex items-center gap-3">
              {s.system_pwa_icon_url ? (
                <img src={s.system_pwa_icon_url} alt="pwa icon"
                  className="w-12 h-12 rounded-xl bg-slate-100 p-1 object-contain dark:bg-white/[0.06]" />
              ) : (
                <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-slate-300 text-xs border border-dashed border-slate-300 dark:bg-white/[0.06]">
                  SVG
                </div>
              )}
              <input value={s.system_pwa_icon_url}
                onChange={e => set('system_pwa_icon_url', e.target.value)}
                placeholder="URL del ícono o sube archivo →"
                className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
              <button onClick={() => pwaRef.current?.click()}
                className="px-3 py-2 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-sm flex items-center gap-1">
                <Upload size={14} /> Subir
              </button>
              <input ref={pwaRef} type="file" accept="image/png,image/svg+xml,image/webp" className="hidden"
                onChange={e => upload('pwa_icon', e.target.files?.[0] || null)} />
            </div>
            {s.system_pwa_icon_url && (
              <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-1.5 border border-emerald-200">
                ✅ Ícono personalizado activo — se aplica en el manifest de la PWA automáticamente.
              </p>
            )}
          </div>
        </Row>
      </Section>

      <Section title="Tema y colores">
        <div className="grid md:grid-cols-3 gap-4">
          <Color label="Color primario"   v={s.system_primary_color}   onChange={v => set('system_primary_color', v)} />
          <Color label="Color secundario" v={s.system_secondary_color} onChange={v => set('system_secondary_color', v)} />
          <Color label="Acento"           v={s.system_accent_color}    onChange={v => set('system_accent_color', v)} />
          <Color label="Sidebar fondo"    v={s.system_sidebar_bg}      onChange={v => set('system_sidebar_bg', v)} />
          <Color label="Sidebar texto"    v={s.system_sidebar_text}    onChange={v => set('system_sidebar_text', v)} />
          <Color label="Sidebar activo"   v={s.system_sidebar_active}  onChange={v => set('system_sidebar_active', v)} />
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Modo</label>
            <div className="flex gap-2">
              {([['light', Sun, 'Claro'], ['dark', Moon, 'Oscuro'], ['auto', Monitor, 'Auto']] as const).map(([k, Icon, label]) => (
                <button key={k} onClick={() => set('system_theme_mode', k)}
                  className={`flex-1 px-3 py-2 rounded-xl border text-sm flex items-center justify-center gap-1 ${s.system_theme_mode === k ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Tipografía</label>
            <select value={s.system_font_family} onChange={e => set('system_font_family', e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" style={{ fontFamily: s.system_font_family }}>
              {FONTS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Radio de bordes</label>
            <div className="flex gap-2">
              {Object.keys(RADII).map(r => (
                <button key={r} onClick={() => set('system_border_radius', r)}
                  className={`flex-1 px-3 py-2 border text-sm ${s.system_border_radius === r ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200'}`}
                  style={{ borderRadius: RADII[r] }}>{r}</button>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title="Pantalla de login">
        <Row label="Título">
          <input value={s.system_login_title} onChange={e => set('system_login_title', e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
        </Row>
        <Row label="Subtítulo">
          <input value={s.system_login_subtitle} onChange={e => set('system_login_subtitle', e.target.value)}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
        </Row>
        <Row label="Pie de página">
          <input value={s.system_login_footer} onChange={e => set('system_login_footer', e.target.value)}
            placeholder="© 2026 Mi Empresa"
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
        </Row>
        <Row label="Layout">
          <div className="flex gap-2 flex-wrap">
            {LAYOUTS.map(l => (
              <button key={l.k} onClick={() => set('system_login_layout', l.k as any)}
                className={`px-3 py-2 rounded-xl border text-sm ${s.system_login_layout === l.k ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}>
                {l.label}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Imagen de fondo">
          <div className="flex items-center gap-3">
            {s.system_login_bg_image && <img src={s.system_login_bg_image} alt="bg" className="h-16 w-28 object-cover rounded" />}
            <input value={s.system_login_bg_image} onChange={e => set('system_login_bg_image', e.target.value)}
              placeholder="URL o sube archivo →"
              className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            <button onClick={() => bgRef.current?.click()}
              className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-sm flex items-center gap-1 dark:bg-white/[0.06]">
              <Upload size={14} /> Subir
            </button>
            <input ref={bgRef} type="file" accept="image/*" className="hidden"
              onChange={e => upload('login_bg', e.target.files?.[0] || null)} />
          </div>
        </Row>
        <div className="flex gap-4">
          <Check label="Mostrar reloj" checked={s.system_login_show_datetime === '1'} onChange={v => set('system_login_show_datetime', v ? '1' : '0')} />
          <Check label="Efecto glass"  checked={s.system_login_glass === '1'}         onChange={v => set('system_login_glass', v ? '1' : '0')} />
        </div>
      </Section>

      <Section title="Vista previa">
        <div className="rounded-2xl overflow-hidden border border-slate-200 grid grid-cols-[240px_1fr] dark:border-white/[0.08]" style={{ fontFamily: s.system_font_family }}>
          <div className="p-4 flex flex-col gap-2" style={{ backgroundColor: s.system_sidebar_bg, color: s.system_sidebar_text }}>
            <div className="flex items-center gap-2 mb-2">
              {s.system_logo_url
                ? <img src={s.system_logo_url} alt="" className="w-8 h-8 rounded" />
                : <div className="w-8 h-8 rounded" style={{ backgroundColor: s.system_primary_color }} />}
              <span className="text-white font-semibold text-sm">{s.system_name || 'Sistema'}</span>
            </div>
            <div className="px-3 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: s.system_sidebar_active }}>Dashboard</div>
            <div className="px-3 py-2 text-sm">Empleados</div>
            <div className="px-3 py-2 text-sm">Asistencia</div>
          </div>
          <div className="p-6 bg-white dark:bg-white/[0.04]">
            <div className="flex gap-2 mb-4">
              <button className="px-4 py-2 text-white text-sm" style={{ backgroundColor: s.system_primary_color, borderRadius: RADII[s.system_border_radius] }}>Primario</button>
              <button className="px-4 py-2 text-white text-sm" style={{ backgroundColor: s.system_secondary_color, borderRadius: RADII[s.system_border_radius] }}>Secundario</button>
              <button className="px-4 py-2 text-white text-sm" style={{ backgroundColor: s.system_accent_color, borderRadius: RADII[s.system_border_radius] }}>Acento</button>
            </div>
            <div className="text-slate-600 text-sm dark:text-white/60">Ejemplo de contenido con la tipografía y radio seleccionados.</div>
          </div>
        </div>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <h2 className="font-semibold text-slate-900 dark:text-white">{title}</h2>
      {children}
    </div>
  )
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">{label}</label>
      {children}
    </div>
  )
}
function Color({ label, v, onChange }: { label: string; v: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={v || '#000000'} onChange={e => onChange(e.target.value)}
          className="w-10 h-10 rounded border border-slate-200 cursor-pointer dark:border-white/[0.08]" />
        <input value={v} onChange={e => onChange(e.target.value)}
          className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
      </div>
    </div>
  )
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="w-4 h-4" />
      <span className="text-sm text-slate-700 dark:text-white/80">{label}</span>
    </label>
  )
}
