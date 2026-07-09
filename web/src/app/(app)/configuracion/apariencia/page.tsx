'use client'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Palette, Upload, RefreshCw, Save, Sun, Moon, Monitor, Check as CheckIcon, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { applyUiConfig, type UiStyle } from '@/components/theme/UiStyleProvider'

// Catálogo de estilos de interfaz (los 7 del sistema de diseño).
const UI_STYLES: { id: UiStyle; name: string; desc: string; swatch: string }[] = [
  { id: 'liquidglass',  name: 'Liquid Glass',  desc: 'Vidrio líquido que refleja y se deforma (estilo Apple iOS 26).', swatch: 'linear-gradient(135deg, rgba(34,211,238,.5), rgba(99,102,241,.35))' },
  { id: 'glassmorphism',name: 'Glassmorphism', desc: 'Transparencia y blur con sensación de vidrio esmerilado.',       swatch: 'linear-gradient(135deg, rgba(255,255,255,.6), rgba(34,211,238,.25))' },
  { id: 'maximalismo',  name: 'Maximalismo',   desc: 'Colores y capas sin miedo al exceso.',                           swatch: 'linear-gradient(135deg, #f97316, #db2777 55%, #7c3aed)' },
  { id: 'minimalismo',  name: 'Minimalismo',   desc: 'Menos es más: solo lo esencial en pantalla.',                    swatch: 'linear-gradient(135deg, #ffffff, #e2e8f0)' },
  { id: 'spatial',      name: 'UI Espacial',   desc: 'Profundidad y movimiento en 3D, como si flotara.',               swatch: 'linear-gradient(135deg, #38bdf8, #6366f1)' },
  { id: 'claymorphism', name: 'Claymorphism',  desc: 'Formas suaves e infladas, como de plastilina.',                  swatch: 'linear-gradient(135deg, #a78bfa, #f0abfc)' },
  { id: 'brutalismo',   name: 'Brutalismo',    desc: 'Sin adornos: bordes duros y tipografía gigante.',                swatch: 'linear-gradient(135deg, #eef264, #22d3ee)' },
]
const DENSITIES = [
  { id: 'compact',     label: 'Compacta' },
  { id: 'comfortable', label: 'Cómoda' },
  { id: 'spacious',    label: 'Amplia' },
]

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
  // Estilo global de interfaz (personalización)
  system_ui_style: string; system_ui_accent: string
  system_ui_density: string; system_ui_motion: string
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

  // Cambia un ajuste de UI y lo previsualiza al instante (sin guardar).
  function setUi<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS(prev => {
      const next = prev ? ({ ...prev, [k]: v }) : prev
      if (next) applyUiConfig({
        style: (next.system_ui_style || 'liquidglass') as UiStyle,
        density: (next.system_ui_density || 'comfortable') as any,
        accent: next.system_ui_accent || next.system_primary_color || undefined,
        accent2: next.system_secondary_color || undefined,
        motion: next.system_ui_motion !== '0',
      })
      return next
    })
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

      {/* ═══ Estilo de interfaz (personalización global) ═══ */}
      <Section title="Estilo de interfaz">
        <div className="space-y-5">
          <p className="text-sm text-slate-500 dark:text-white/40 flex items-center gap-2">
            <Sparkles size={15} className="text-cyan-500" />
            Elegí el estilo visual de todo el sistema. El cambio se previsualiza al instante; tocá <b>Guardar</b> para aplicarlo a todos los usuarios.
          </p>

          {/* Selector de 7 estilos */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {UI_STYLES.map(st => {
              const active = (s.system_ui_style || 'liquidglass') === st.id
              return (
                <button key={st.id} type="button" onClick={() => setUi('system_ui_style', st.id)}
                  className={`relative text-left rounded-2xl p-4 border transition-all ${
                    active
                      ? 'border-cyan-400 ring-2 ring-cyan-400/40 bg-cyan-50/50 dark:bg-cyan-400/[0.08] dark:border-cyan-400/50'
                      : 'border-slate-200 hover:border-slate-300 hover:-translate-y-0.5 dark:border-white/[0.08] dark:hover:border-white/[0.16]'
                  }`}>
                  {active && (
                    <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-cyan-500 text-white flex items-center justify-center">
                      <CheckIcon size={12} strokeWidth={3} />
                    </span>
                  )}
                  <div className="w-full h-14 rounded-xl mb-3 shadow-inner" style={{ background: st.swatch }} />
                  <div className="font-bold text-sm text-slate-900 dark:text-white">{st.name}</div>
                  <div className="text-[11.5px] text-slate-500 dark:text-white/40 mt-0.5 leading-snug">{st.desc}</div>
                </button>
              )
            })}
          </div>

          {/* Acento, densidad, movimiento */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 dark:text-white/40">Color de acento</label>
              <div className="flex items-center gap-3">
                <input type="color" value={s.system_ui_accent || s.system_primary_color || '#22d3ee'}
                  onChange={e => setUi('system_ui_accent', e.target.value)}
                  className="w-11 h-11 rounded-xl border border-slate-200 cursor-pointer dark:border-white/[0.08]" aria-label="Color de acento" />
                <input value={s.system_ui_accent || ''} onChange={e => setUi('system_ui_accent', e.target.value)}
                  placeholder="#22d3ee"
                  className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 dark:text-white/40">Densidad</label>
              <div className="flex gap-1.5 p-1 rounded-xl bg-slate-100 dark:bg-white/[0.05]">
                {DENSITIES.map(d => {
                  const active = (s.system_ui_density || 'comfortable') === d.id
                  return (
                    <button key={d.id} type="button" onClick={() => setUi('system_ui_density', d.id)}
                      className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
                        active ? 'bg-white shadow-sm text-slate-900 dark:bg-white/[0.12] dark:text-white' : 'text-slate-500 dark:text-white/40'
                      }`}>{d.label}</button>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 dark:text-white/40">Animaciones</label>
              <button type="button" onClick={() => setUi('system_ui_motion', s.system_ui_motion === '0' ? '1' : '0')}
                className={`w-full py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                  s.system_ui_motion !== '0'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-400/[0.08] dark:border-emerald-400/30 dark:text-emerald-400'
                    : 'bg-slate-50 border-slate-200 text-slate-500 dark:bg-white/[0.04] dark:border-white/[0.08] dark:text-white/40'
                }`}>
                {s.system_ui_motion !== '0' ? 'Activadas' : 'Desactivadas'}
              </button>
            </div>
          </div>
        </div>
      </Section>

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
