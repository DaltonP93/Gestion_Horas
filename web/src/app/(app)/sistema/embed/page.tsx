'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  Code2, Plus, Copy, Trash2, Power, X, Eye, ExternalLink,
} from 'lucide-react'
import { api } from '@/lib/api'
import BackButton from '@/components/BackButton'

const WIDGET_LABELS: Record<string, string> = {
  kpis:   'KPIs del día (presentes, atrasos, ausentes)',
  trend:  'Tendencia 7 días',
  byDept: 'Distribución por departamento',
}

export default function EmbedTokensPage() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<any>({ name: '', widgets: ['kpis'], deptId: '', expires_at: '' })
  const [created, setCreated] = useState<{ token: string } | null>(null)

  const { data: list } = useQuery<any>({
    queryKey: ['embed-tokens'],
    queryFn: () => api.get('/api/embed-tokens').then(r => r.data),
  })

  const { data: depts } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  function origin() {
    return typeof window !== 'undefined' ? window.location.origin : ''
  }

  function embedUrl(token: string) {
    return `${origin()}/embed/${token}`
  }

  function dataUrl(token: string) {
    return `${origin()}/api/embed/data/${token}`
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text)
    alert('Copiado al portapapeles ✅')
  }

  async function createToken() {
    if (!form.name) return alert('Nombre requerido')
    try {
      const r = await api.post('/api/embed-tokens', {
        name: form.name,
        widgets: form.widgets,
        deptId: form.deptId || null,
        expires_at: form.expires_at || null,
      })
      qc.invalidateQueries({ queryKey: ['embed-tokens'] })
      setCreated({ token: r.data.token })
      setShowForm(false)
      setForm({ name: '', widgets: ['kpis'], deptId: '', expires_at: '' })
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error')
    }
  }

  async function toggleActive(t: any) {
    await api.put(`/api/embed-tokens/${t.id}`, { active: t.active ? 0 : 1 })
    qc.invalidateQueries({ queryKey: ['embed-tokens'] })
  }

  async function revoke(id: number) {
    if (!confirm('¿Revocar este token? La URL embebida dejará de funcionar.')) return
    await api.delete(`/api/embed-tokens/${id}`)
    qc.invalidateQueries({ queryKey: ['embed-tokens'] })
  }

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <BackButton href="/sistema" label="Sistema" />

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
            <Code2 className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Embed (dashboards públicos)</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">
              Tokens para insertar widgets en intranets, Oracle APEX o portales externos sin autenticación.
            </p>
          </div>
        </div>
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-2 bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium">
          <Plus size={14} /> Nuevo token
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
        <p className="font-semibold mb-1">⚠️ Datos read-only sin autenticación</p>
        <p>Cualquiera con el token puede consultar los datos configurados. No incluí información personal sensible. Revocá los tokens si se comprometen.</p>
      </div>

      {/* Lista */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
            <tr>
              <th className="text-left px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Nombre</th>
              <th className="text-left px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Widgets</th>
              <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Usos</th>
              <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Último uso</th>
              <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Expira</th>
              <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs w-44 dark:text-white/40">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
            {(list?.data || []).map((t: any) => {
              const scope = typeof t.scope === 'string' ? JSON.parse(t.scope) : t.scope
              return (
                <tr key={t.id} className={`hover:bg-slate-50 ${!t.active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-white/90">
                    {t.name}
                    <p className="text-[11px] font-mono text-slate-400 dark:text-white/30">{t.token.slice(0, 16)}...</p>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600 dark:text-white/60">
                    {scope.widgets?.join(', ') || '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-600 text-xs dark:text-white/60">{t.use_count}</td>
                  <td className="px-4 py-2.5 text-right text-xs text-slate-500 dark:text-white/40">
                    {t.last_used_at ? format(new Date(t.last_used_at), 'd MMM HH:mm', { locale: es }) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-slate-500 dark:text-white/40">
                    {t.expires_at ? format(new Date(t.expires_at), 'd MMM yyyy', { locale: es }) : 'Sin expiración'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => copy(embedUrl(t.token))}
                      title="Copiar URL embed"
                      className="text-blue-600 hover:bg-blue-50 p-1.5 rounded-lg">
                      <Copy size={13} />
                    </button>
                    <a href={embedUrl(t.token)} target="_blank" rel="noopener noreferrer"
                      title="Ver en nueva pestaña"
                      className="inline-flex text-slate-600 hover:bg-slate-100 p-1.5 rounded-lg dark:text-white/60 dark:hover:bg-white/[0.06]">
                      <ExternalLink size={13} />
                    </a>
                    <button onClick={() => toggleActive(t)}
                      title={t.active ? 'Desactivar' : 'Activar'}
                      className={`p-1.5 rounded-lg ${t.active ? 'text-amber-600 hover:bg-amber-50' : 'text-emerald-600 hover:bg-emerald-50'}`}>
                      <Power size={13} />
                    </button>
                    <button onClick={() => revoke(t.id)}
                      title="Revocar"
                      className="text-rose-600 hover:bg-rose-50 p-1.5 rounded-lg">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              )
            })}
            {(list?.data || []).length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-slate-400 dark:text-white/30">Sin tokens generados</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modal token recién creado */}
      {created && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setCreated(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full p-6 space-y-4 dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-emerald-600 flex items-center gap-2">✅ Token creado</h3>
            <p className="text-sm text-slate-600 dark:text-white/60">
              Guardá esta URL — no se volverá a mostrar el token completo.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">URL del dashboard embebido (iframe)</label>
                <div className="flex gap-2">
                  <input readOnly value={embedUrl(created.token)}
                    className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-white/[0.03] dark:border-white/[0.08]" />
                  <button onClick={() => copy(embedUrl(created.token))}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-3 rounded-xl">
                    <Copy size={14} />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">URL JSON (para integración custom)</label>
                <div className="flex gap-2">
                  <input readOnly value={dataUrl(created.token)}
                    className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-white/[0.03] dark:border-white/[0.08]" />
                  <button onClick={() => copy(dataUrl(created.token))}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-3 rounded-xl">
                    <Copy size={14} />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1 font-medium dark:text-white/40">Snippet HTML para insertar en intranet</label>
                <textarea readOnly rows={3}
                  value={`<iframe src="${embedUrl(created.token)}" width="100%" height="400" style="border:0"></iframe>`}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-white/[0.03] dark:border-white/[0.08]" />
              </div>
            </div>
            <button onClick={() => setCreated(null)}
              className="w-full bg-slate-800 hover:bg-slate-900 text-white py-2.5 rounded-xl text-sm font-medium">
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Modal nuevo */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4 dark:bg-white/[0.04]" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold flex items-center gap-2"><Code2 size={18} /> Nuevo token de embed</h3>
            <input placeholder="Nombre (ej: Intranet RRHH)" value={form.name}
              onChange={e => setForm((f: any) => ({ ...f, name: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2 dark:text-white/80">Widgets a exponer</label>
              <div className="space-y-1.5">
                {Object.entries(WIDGET_LABELS).map(([k, l]) => (
                  <label key={k} className="flex items-center gap-2 cursor-pointer px-2 py-1 hover:bg-slate-50 rounded dark:hover:bg-white/[0.04]">
                    <input type="checkbox" checked={form.widgets.includes(k)}
                      onChange={e => setForm((f: any) => ({
                        ...f,
                        widgets: e.target.checked ? [...f.widgets, k] : f.widgets.filter((x: string) => x !== k),
                      }))}
                      className="accent-violet-600 w-4 h-4" />
                    <span className="text-sm text-slate-700 dark:text-white/80">{l}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Departamento (opcional)</label>
              <select value={form.deptId} onChange={e => setForm((f: any) => ({ ...f, deptId: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
                <option value="">Todos</option>
                {(depts || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1 dark:text-white/80">Expira (opcional)</label>
              <input type="date" value={form.expires_at}
                onChange={e => setForm((f: any) => ({ ...f, expires_at: e.target.value }))}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={createToken} className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-xl text-sm font-medium">Crear token</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
