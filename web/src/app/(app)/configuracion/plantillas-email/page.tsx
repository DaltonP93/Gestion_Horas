'use client'
import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, Save, Eye, Send, X, Tag, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import BackButton from '@/components/BackButton'

export default function PlantillasEmailPage() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ subject: string; body_html: string; name: string; description: string }>({
    subject: '', body_html: '', name: '', description: '',
  })
  const [vars, setVars] = useState<Record<string, string>>({})
  const [showPreview, setShowPreview] = useState(false)
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null)
  const [testEmail, setTestEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const { data: list } = useQuery<any>({
    queryKey: ['email-templates'],
    queryFn: () => api.get('/api/email-templates').then(r => r.data),
  })

  const { data: detail } = useQuery<any>({
    queryKey: ['email-template', selected],
    queryFn: () => api.get(`/api/email-templates/${selected}`).then(r => r.data),
    enabled: !!selected,
  })

  // Sincronizar draft cuando cambia plantilla seleccionada
  useEffect(() => {
    if (detail?.data) {
      setDraft({
        subject: detail.data.subject,
        body_html: detail.data.body_html,
        name: detail.data.name,
        description: detail.data.description || '',
      })
      // Inicializar vars con strings vacíos
      const v: Record<string, string> = {}
      const list = detail.data.variables ?
        (typeof detail.data.variables === 'string' ? JSON.parse(detail.data.variables) : detail.data.variables) : []
      for (const k of list) v[k] = sampleValue(k)
      setVars(v)
      setPreview(null)
    }
  }, [detail])

  function sampleValue(k: string): string {
    const samples: Record<string, string> = {
      nombre: 'Juan Pérez', tipo: 'Permiso personal',
      desde: '01/05/2026', hasta: '03/05/2026',
      aprobador: 'María González', motivo: 'No se acreditó documentación',
      fecha: new Date().toLocaleDateString('es-PY'),
      cantidad: '3', tabla: '<ul><li>Empleado A — 15 min</li><li>Empleado B — 20 min</li></ul>',
      titulo: 'Reporte mensual', periodo: 'Abril 2026', contenido: '<p>Contenido del reporte aquí</p>',
      link: 'https://sishoras.saa.com.py/reset/abc123', expira_min: '60',
    }
    return samples[k] || `(${k})`
  }

  const variables: string[] = detail?.data?.variables ?
    (typeof detail.data.variables === 'string' ? JSON.parse(detail.data.variables) : detail.data.variables) : []

  async function save() {
    if (!selected) return
    setSaving(true)
    try {
      await api.put(`/api/email-templates/${selected}`, draft)
      qc.invalidateQueries({ queryKey: ['email-templates'] })
      qc.invalidateQueries({ queryKey: ['email-template', selected] })
      alert('Plantilla guardada ✅')
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error')
    } finally { setSaving(false) }
  }

  async function doPreview() {
    if (!selected) return
    try {
      const r = await api.post(`/api/email-templates/${selected}/preview`, { vars })
      setPreview({ subject: r.data.subject, html: r.data.html })
      setShowPreview(true)
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error')
    }
  }

  async function sendTest() {
    if (!selected || !testEmail) return alert('Email requerido')
    setTesting(true)
    try {
      await api.post(`/api/email-templates/${selected}/test`, { to: testEmail, vars })
      alert(`Email de prueba enviado a ${testEmail} ✅`)
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error al enviar')
    } finally { setTesting(false) }
  }

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <BackButton href="/configuracion" label="Configuración" />

      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
          <Mail className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Plantillas de email</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">
            Customizá el HTML y asunto que se envía con cada tipo de notificación.
            Las variables se reemplazan automáticamente con los datos del evento.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Lista */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700 dark:text-white/80 dark:border-white/[0.06]">
            Plantillas ({list?.data?.length || 0})
          </div>
          <div className="divide-y divide-slate-50 max-h-[70vh] overflow-y-auto dark:divide-white/[0.05]">
            {(list?.data || []).map((t: any) => (
              <button key={t.code} onClick={() => setSelected(t.code)}
                className={`w-full text-left px-4 py-3 transition-colors ${
                  selected === t.code ? 'bg-blue-50 border-l-4 border-blue-500' : 'hover:bg-slate-50'
                }`}>
                <p className="text-sm font-medium text-slate-800 dark:text-white/90">{t.name}</p>
                <p className="text-xs text-slate-500 mt-0.5 dark:text-white/40">{t.description}</p>
                <p className="text-[11px] font-mono text-slate-400 mt-1 dark:text-white/30">{t.code}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Editor */}
        <div className="md:col-span-2 space-y-4">
          {!selected ? (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-12 text-center text-slate-400 dark:bg-white/[0.04] dark:text-white/30 dark:border-white/[0.06]">
              <Mail size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">Seleccioná una plantilla para editarla</p>
            </div>
          ) : (
            <>
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 dark:text-white/40">Nombre</label>
                  <input value={draft.name}
                    onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 dark:text-white/40">Asunto</label>
                  <input value={draft.subject}
                    onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 dark:text-white/40">HTML del cuerpo</label>
                  <textarea value={draft.body_html} rows={12}
                    onChange={e => setDraft(d => ({ ...d, body_html: e.target.value }))}
                    className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono dark:border-white/[0.08]" />
                </div>
                {variables.length > 0 && (
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-3">
                    <p className="text-xs font-semibold text-blue-800 mb-2 flex items-center gap-1">
                      <Tag size={11} /> Variables disponibles
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {variables.map(v => (
                        <code key={v} className="bg-white border border-blue-200 text-blue-700 px-2 py-0.5 rounded text-xs dark:bg-white/[0.04]">
                          {`{{${v}}}`}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={save} disabled={saving}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-sm font-medium">
                    <Save size={14} /> {saving ? 'Guardando...' : 'Guardar cambios'}
                  </button>
                  <button onClick={doPreview}
                    className="flex items-center gap-2 border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                    <Eye size={14} /> Vista previa
                  </button>
                </div>
              </div>

              {/* Variables editables para preview/test */}
              {variables.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
                  <h3 className="font-semibold text-slate-700 text-sm flex items-center gap-2 dark:text-white/80">
                    <RefreshCw size={14} /> Datos de prueba
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-white/40">
                    Estos valores se usan para la vista previa y el envío de prueba.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {variables.map(v => (
                      <div key={v}>
                        <label className="block text-xs text-slate-500 mb-0.5 font-mono dark:text-white/40">{v}</label>
                        <input value={vars[v] || ''}
                          onChange={e => setVars(p => ({ ...p, [v]: e.target.value }))}
                          className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs dark:border-white/[0.08]" />
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-slate-100 pt-3 flex gap-2 dark:border-white/[0.06]">
                    <input type="email" value={testEmail} onChange={e => setTestEmail(e.target.value)}
                      placeholder="email@destino.com"
                      className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
                    <button onClick={sendTest} disabled={testing || !testEmail}
                      className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-sm font-medium">
                      <Send size={14} /> {testing ? 'Enviando...' : 'Enviar prueba'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Modal preview */}
      {showPreview && preview && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowPreview(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
              <h3 className="font-bold flex items-center gap-2"><Eye size={18} /> Vista previa</h3>
              <button onClick={() => setShowPreview(false)} className="text-slate-400 hover:text-slate-600 dark:text-white/30"><X size={18} /></button>
            </div>
            <div className="px-6 py-3 border-b border-slate-100 bg-slate-50 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <p className="text-xs text-slate-500 mb-1 dark:text-white/40">Asunto:</p>
              <p className="font-semibold text-slate-800 dark:text-white/90">{preview.subject}</p>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <iframe srcDoc={preview.html} title="Email preview"
                sandbox=""
                className="w-full h-[400px] border border-slate-200 rounded-xl bg-white dark:bg-white/[0.04] dark:border-white/[0.08]" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
