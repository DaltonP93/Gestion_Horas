'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Plug, Plus, Play, Trash2, Edit3, CheckCircle2, AlertCircle, Clock, X, Zap } from 'lucide-react'
import BackButton from '@/components/BackButton'

type HrSource = {
  id: number
  name: string
  type: 'http_json' | 'http_csv' | 'webhook'
  url: string
  method: 'GET' | 'POST'
  auth_type: 'none' | 'bearer' | 'basic' | 'api_key'
  auth_token?: string
  schedule_cron?: string | null
  enabled: 0 | 1
  json_root_path?: string
  headers_json?: Record<string, string>
  body_json?: any
  field_mapping?: Record<string, string>
  last_run_at?: string
  last_status?: 'success' | 'error' | 'running'
  last_result?: any
}

const EMPLOYEE_FIELDS = [
  { key: 'code', label: 'Código (ID en reloj) *', required: true },
  { key: 'employee_number', label: 'Legajo / Cédula' },
  { key: 'first_name', label: 'Nombre' },
  { key: 'last_name', label: 'Apellido' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Teléfono' },
  { key: 'position', label: 'Cargo' },
  { key: 'department', label: 'Departamento (nombre)' },
  { key: 'hire_date', label: 'Fecha ingreso' },
  { key: 'status', label: 'Estado' },
]

export default function IntegracionesHrPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<HrSource | null>(null)

  const { data: sources = [], isLoading } = useQuery<HrSource[]>({
    queryKey: ['hr-sources'],
    queryFn: () => api.get('/api/hr-sources').then(r => r.data),
  })

  async function runNow(id: number) {
    if (!confirm('¿Ejecutar sync ahora?')) return
    try {
      const r = await api.post(`/api/hr-sources/${id}/run`)
      alert(`Sync OK:\n• Creados: ${r.data.result.created}\n• Actualizados: ${r.data.result.updated}\n• Errores: ${r.data.result.errors?.length || 0}`)
      qc.invalidateQueries({ queryKey: ['hr-sources'] })
    } catch (err: any) {
      alert('Error: ' + (err?.response?.data?.error || err.message))
    }
  }

  async function testConnection(id: number) {
    try {
      const r = await api.post(`/api/hr-sources/${id}/test`)
      alert(`Conexión OK — ${r.data.total_preview} registros de muestra:\n\n${JSON.stringify(r.data.sample, null, 2).slice(0, 500)}`)
    } catch (err: any) {
      alert('Error: ' + (err?.response?.data?.error || err.message))
    }
  }

  async function remove(id: number) {
    if (!confirm('¿Eliminar esta fuente?')) return
    await api.delete(`/api/hr-sources/${id}`)
    qc.invalidateQueries({ queryKey: ['hr-sources'] })
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <BackButton href="/configuracion" label="Configuración" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
            <Plug className="text-purple-600" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Integraciones HR externas</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Sincronizar empleados desde SAP, Bejerman, Meta4, Workday, Odoo, CSV remoto, etc.</p>
          </div>
        </div>
        <button onClick={() => setEditing({ id: 0, name: '', type: 'http_json', url: '', method: 'GET', auth_type: 'none', enabled: 1, field_mapping: { code: '' } } as HrSource)}
          className="flex items-center gap-2 bg-purple-600 text-white px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-purple-700">
          <Plus size={16} /> Nueva fuente
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-20 text-slate-400 dark:text-white/30">Cargando...</div>
      ) : sources.length === 0 ? (
        <div className="bg-white rounded-2xl border-2 border-dashed border-slate-200 p-14 text-center dark:bg-white/[0.04] dark:border-white/[0.08]">
          <Plug size={42} className="mx-auto text-slate-300 mb-4" />
          <p className="font-semibold text-slate-600 dark:text-white/60">Aún no hay fuentes configuradas</p>
          <p className="text-sm text-slate-400 mt-1 dark:text-white/30">Añade tu primer ERP/HR API para sincronizar empleados automáticamente</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {sources.map(src => (
            <div key={src.id} className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-slate-900 dark:text-white">{src.name}</h3>
                    {src.enabled ? (
                      <span className="bg-green-50 text-green-700 border border-green-200 text-xs px-2 py-0.5 rounded-full font-semibold">Activa</span>
                    ) : (
                      <span className="bg-slate-100 text-slate-500 border border-slate-200 text-xs px-2 py-0.5 rounded-full font-semibold dark:bg-white/[0.06] dark:text-white/40 dark:border-white/[0.08]">Deshabilitada</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 font-mono mt-1 truncate dark:text-white/30">{src.method} {src.url}</p>
                </div>
                <span className="bg-purple-50 text-purple-700 text-xs px-2 py-1 rounded-lg font-mono">{src.type}</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs text-slate-500 mb-4 dark:text-white/40">
                <div>
                  <span className="block text-slate-400 uppercase tracking-wide text-[10px] dark:text-white/30">Auth</span>
                  <span className="font-semibold">{src.auth_type}</span>
                </div>
                <div>
                  <span className="block text-slate-400 uppercase tracking-wide text-[10px] dark:text-white/30">Schedule</span>
                  <span className="font-mono">{src.schedule_cron || 'manual'}</span>
                </div>
                <div>
                  <span className="block text-slate-400 uppercase tracking-wide text-[10px] dark:text-white/30">Última</span>
                  <span>{src.last_run_at ? new Date(src.last_run_at).toLocaleString() : 'Nunca'}</span>
                </div>
                <div>
                  <span className="block text-slate-400 uppercase tracking-wide text-[10px] dark:text-white/30">Estado</span>
                  {src.last_status === 'success' && <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={12}/>OK</span>}
                  {src.last_status === 'error' && <span className="text-red-600 flex items-center gap-1"><AlertCircle size={12}/>Error</span>}
                  {src.last_status === 'running' && <span className="text-blue-600 flex items-center gap-1"><Clock size={12}/>Ejecutando</span>}
                  {!src.last_status && <span className="text-slate-400 dark:text-white/30">—</span>}
                </div>
              </div>

              {src.last_result && (
                <div className="bg-slate-50 rounded-lg px-3 py-2 text-xs font-mono text-slate-600 mb-3 max-h-20 overflow-y-auto dark:bg-white/[0.03] dark:text-white/60">
                  {src.last_result.error
                    ? <span className="text-red-600">{src.last_result.error}</span>
                    : <span>✓ {src.last_result.created || 0} creados, {src.last_result.updated || 0} actualizados, {src.last_result.errors?.length || 0} errores</span>}
                </div>
              )}

              <div className="flex gap-2">
                <button onClick={() => testConnection(src.id)}
                  className="flex-1 flex items-center justify-center gap-1 border border-slate-200 text-slate-600 text-xs py-2 rounded-lg hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                  <Zap size={13}/> Probar
                </button>
                <button onClick={() => runNow(src.id)}
                  className="flex-1 flex items-center justify-center gap-1 bg-purple-600 text-white text-xs py-2 rounded-lg hover:bg-purple-700">
                  <Play size={13}/> Ejecutar
                </button>
                <button onClick={() => setEditing(src)}
                  className="border border-slate-200 text-slate-600 p-2 rounded-lg hover:bg-slate-50 dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                  <Edit3 size={13}/>
                </button>
                <button onClick={() => remove(src.id)}
                  className="border border-red-200 text-red-600 p-2 rounded-lg hover:bg-red-50">
                  <Trash2 size={13}/>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <EditSourceModal initial={editing} onClose={() => setEditing(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['hr-sources'] }); setEditing(null) }} />}
    </div>
  )
}

// ─── Modal de edición ─────────────────────────────────────────────
function EditSourceModal({ initial, onClose, onSaved }: { initial: HrSource; onClose: () => void; onSaved: () => void }) {
  const isNew = !initial.id
  const [form, setForm] = useState<any>({
    name: initial.name || '',
    type: initial.type || 'http_json',
    url: initial.url || '',
    method: initial.method || 'GET',
    auth_type: initial.auth_type || 'none',
    auth_token: initial.auth_token || '',
    headers_json: initial.headers_json ? JSON.stringify(initial.headers_json, null, 2) : '',
    body_json: initial.body_json ? JSON.stringify(initial.body_json, null, 2) : '',
    json_root_path: initial.json_root_path || '',
    field_mapping: initial.field_mapping || { code: '' },
    schedule_cron: initial.schedule_cron || '',
    enabled: initial.enabled ?? 1,
  })
  const [busy, setBusy] = useState(false)

  function setMap(k: string, v: string) {
    setForm((f: any) => ({ ...f, field_mapping: { ...f.field_mapping, [k]: v } }))
  }

  async function save() {
    if (!form.name || !form.url) { alert('Nombre y URL requeridos'); return }
    if (!form.field_mapping.code) { alert('Debe mapear al menos el campo "code"'); return }

    setBusy(true)
    try {
      const body: any = {
        ...form,
        headers_json: form.headers_json ? JSON.parse(form.headers_json) : null,
        body_json:    form.body_json    ? JSON.parse(form.body_json)    : null,
      }
      // Quitar mapeos vacíos
      body.field_mapping = Object.fromEntries(
        Object.entries(form.field_mapping).filter(([, v]) => v)
      )
      if (isNew) await api.post('/api/hr-sources', body)
      else       await api.put(`/api/hr-sources/${initial.id}`, body)
      onSaved()
    } catch (err: any) {
      alert('Error: ' + (err?.response?.data?.error || err.message))
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col dark:bg-white/[0.04]">
        <div className="bg-gradient-to-r from-purple-600 to-purple-700 rounded-t-2xl px-6 py-4 flex items-center justify-between shrink-0">
          <h2 className="text-lg font-bold text-white">{isNew ? 'Nueva fuente HR' : 'Editar fuente'}</h2>
          <button onClick={onClose} className="text-purple-200 hover:text-white p-1"><X size={18}/></button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* General */}
          <section>
            <h3 className="text-sm font-bold text-slate-700 mb-3 dark:text-white/80">General</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nombre *"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                className="input" placeholder="ERP Producción" /></Field>
              <Field label="Tipo"><select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className="input">
                <option value="http_json">HTTP JSON</option>
                <option value="http_csv">HTTP CSV</option>
              </select></Field>
              <Field label="URL *" full><input value={form.url} onChange={e => setForm({ ...form, url: e.target.value })}
                className="input" placeholder="https://api.empresa.com/v1/employees" /></Field>
              <Field label="Método"><select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="input">
                <option>GET</option><option>POST</option>
              </select></Field>
              <Field label="Habilitada">
                <label className="flex items-center gap-2 text-sm text-slate-700 mt-2 dark:text-white/80">
                  <input type="checkbox" checked={!!form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked ? 1 : 0 })} className="accent-purple-600 w-4 h-4"/>
                  Activa
                </label>
              </Field>
            </div>
          </section>

          {/* Autenticación */}
          <section>
            <h3 className="text-sm font-bold text-slate-700 mb-3 dark:text-white/80">Autenticación</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tipo"><select value={form.auth_type} onChange={e => setForm({ ...form, auth_type: e.target.value })} className="input">
                <option value="none">Ninguna</option>
                <option value="bearer">Bearer token</option>
                <option value="basic">Basic (user:pass)</option>
                <option value="api_key">API Key (header X-API-Key)</option>
              </select></Field>
              {form.auth_type !== 'none' && (
                <Field label="Token / credencial"><input type="password" value={form.auth_token}
                  onChange={e => setForm({ ...form, auth_token: e.target.value })} className="input"
                  placeholder={form.auth_type === 'basic' ? 'usuario:contraseña' : 'token...'} /></Field>
              )}
            </div>
          </section>

          {/* Request avanzado */}
          <section>
            <h3 className="text-sm font-bold text-slate-700 mb-3 dark:text-white/80">Request avanzado (opcional)</h3>
            <div className="grid grid-cols-1 gap-3">
              <Field label="Headers JSON" full><textarea value={form.headers_json} onChange={e => setForm({ ...form, headers_json: e.target.value })}
                className="input font-mono text-xs" rows={2} placeholder='{"X-Tenant":"acme"}' /></Field>
              {form.method === 'POST' && (
                <Field label="Body JSON" full><textarea value={form.body_json} onChange={e => setForm({ ...form, body_json: e.target.value })}
                  className="input font-mono text-xs" rows={3} placeholder='{"query":"active=true"}' /></Field>
              )}
              {form.type === 'http_json' && (
                <Field label="JSON root path" full><input value={form.json_root_path} onChange={e => setForm({ ...form, json_root_path: e.target.value })}
                  className="input" placeholder='data.employees  (deja vacío si el array está en la raíz)' /></Field>
              )}
            </div>
          </section>

          {/* Mapeo de campos */}
          <section>
            <h3 className="text-sm font-bold text-slate-700 mb-3 dark:text-white/80">Mapeo de campos</h3>
            <p className="text-xs text-slate-500 mb-3 dark:text-white/40">
              Indica cómo se llama cada campo en la respuesta del ERP/HR externo.
              Ejemplo: si el JSON externo tiene <code className="bg-slate-100 px-1 rounded dark:bg-white/[0.06]">userId</code>, mapea <strong>code</strong> → <code className="bg-slate-100 px-1 rounded dark:bg-white/[0.06]">userId</code>.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {EMPLOYEE_FIELDS.map(f => (
                <div key={f.key} className="flex items-center gap-2">
                  <span className={`text-xs font-medium min-w-[130px] ${f.required ? 'text-red-600' : 'text-slate-600'}`}>{f.label}</span>
                  <span className="text-slate-400 dark:text-white/30">→</span>
                  <input value={form.field_mapping[f.key] || ''}
                    onChange={e => setMap(f.key, e.target.value)}
                    className="input flex-1 font-mono text-xs"
                    placeholder={`campo en el JSON externo`} />
                </div>
              ))}
            </div>
          </section>

          {/* Scheduler */}
          <section>
            <h3 className="text-sm font-bold text-slate-700 mb-3 dark:text-white/80">Programación automática</h3>
            <Field label="Cron schedule (opcional)" full>
              <input value={form.schedule_cron} onChange={e => setForm({ ...form, schedule_cron: e.target.value })}
                className="input font-mono" placeholder="0 4 * * *  (todos los días 04:00)" />
            </Field>
            <p className="text-xs text-slate-500 mt-1 dark:text-white/40">
              Formato cron. Ejemplos:{' '}
              <code className="bg-slate-100 px-1 dark:bg-white/[0.06]">*/30 * * * *</code> cada 30 min,{' '}
              <code className="bg-slate-100 px-1 dark:bg-white/[0.06]">0 4 * * *</code> diario 4am,{' '}
              <code className="bg-slate-100 px-1 dark:bg-white/[0.06]">0 6 * * 1</code> lunes 6am.
              Dejar vacío = solo manual.
            </p>
          </section>
        </div>

        <div className="border-t border-slate-100 px-6 py-4 flex justify-end gap-2 shrink-0 dark:border-white/[0.06]">
          <button onClick={onClose} className="border border-slate-200 text-slate-600 px-4 py-2 rounded-xl text-sm dark:text-white/60 dark:border-white/[0.08]">Cancelar</button>
          <button onClick={save} disabled={busy}
            className="bg-purple-600 text-white px-5 py-2 rounded-xl text-sm font-semibold hover:bg-purple-700 disabled:opacity-60">
            {busy ? 'Guardando...' : (isNew ? 'Crear' : 'Guardar cambios')}
          </button>
        </div>
      </div>

      <style jsx>{`
        :global(.input) {
          width: 100%;
          border: 1px solid rgb(226 232 240);
          border-radius: 0.75rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          outline: none;
        }
        :global(.input:focus) { border-color: rgb(147 51 234); box-shadow: 0 0 0 2px rgb(233 213 255); }
      `}</style>
    </div>
  )
}

function Field({ label, children, full }: { label: string; children: any; full?: boolean }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <label className="text-xs font-semibold text-slate-600 mb-1 block dark:text-white/60">{label}</label>
      {children}
    </div>
  )
}
