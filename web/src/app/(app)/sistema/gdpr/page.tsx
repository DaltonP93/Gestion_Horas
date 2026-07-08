'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Shield, AlertTriangle, Download, Trash2, Search, Clock } from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { api, downloadUrl } from '@/lib/api'
import BackButton from '@/components/BackButton'

export default function GdprPage() {
  const [search, setSearch] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [working, setWorking] = useState(false)

  const { data: emps } = useQuery<any>({
    queryKey: ['employees-gdpr', search],
    queryFn: () => api.get('/api/employees', { params: { search, limit: 50, status: 'all' } }).then(r => r.data),
    enabled: search.length >= 2,
  })

  const { data: history } = useQuery<any>({
    queryKey: ['gdpr-exports'],
    queryFn: () => api.get('/api/gdpr/exports').then(r => r.data),
  })

  const [selected, setSelected] = useState<any>(null)

  function downloadExport(empId: number) {
    window.open(downloadUrl(`/api/gdpr/export/${empId}`), '_blank')
  }

  async function anonymize(empId: number) {
    if (confirmText !== 'ANONIMIZAR') {
      return alert('Escribí "ANONIMIZAR" exactamente para confirmar')
    }
    if (!confirm('Esta acción es IRREVERSIBLE. ¿Continuar?')) return
    setWorking(true)
    try {
      const r = await api.post(`/api/gdpr/anonymize/${empId}`, { confirm: 'ANONIMIZAR' })
      alert(`✅ ${r.data.message}\nIdentificador: ${r.data.placeholder}`)
      setSelected(null)
      setConfirmText('')
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al anonimizar')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <BackButton href="/sistema" label="Sistema" />

      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center">
          <Shield className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Cumplimiento GDPR</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">
            Portabilidad de datos personales y "derecho al olvido". Acciones auditadas.
          </p>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
        <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-900">
          <p className="font-semibold mb-1">Anonimización IRREVERSIBLE</p>
          <p>El nombre y datos personales del empleado se reemplazan por valores genéricos. Los datos históricos (asistencia, permisos) se conservan vinculados al ID anónimo para mantener la integridad estadística.</p>
        </div>
      </div>

      {/* Búsqueda */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-white/30" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar empleado por nombre, código o legajo (mín. 2 caracteres)..."
            className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm dark:border-white/[0.08]" />
        </div>

        {search.length >= 2 && (
          <div className="mt-4 divide-y divide-slate-100 max-h-96 overflow-y-auto dark:divide-white/[0.06]">
            {(emps?.data || []).map((e: any) => {
              const isAnon = !!e.anonymized_at
              return (
                <div key={e.id} className="flex items-center gap-4 py-2.5">
                  <div className="flex-1">
                    <p className={`font-medium ${isAnon ? 'text-slate-400 italic' : 'text-slate-800'}`}>
                      {e.full_name} <span className="text-xs text-slate-400 dark:text-white/30">[{e.code}]</span>
                    </p>
                    <p className="text-xs text-slate-500 dark:text-white/40">{e.department || '—'} · {e.email || 'sin email'}</p>
                  </div>
                  {isAnon ? (
                    <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full dark:bg-white/[0.06] dark:text-white/40">Anonimizado</span>
                  ) : (
                    <>
                      <button onClick={() => downloadExport(e.id)}
                        className="flex items-center gap-1 text-blue-600 hover:bg-blue-50 px-3 py-1.5 rounded-lg text-xs font-medium">
                        <Download size={12} /> Exportar
                      </button>
                      <button onClick={() => setSelected(e)}
                        className="flex items-center gap-1 text-rose-600 hover:bg-rose-50 px-3 py-1.5 rounded-lg text-xs font-medium">
                        <Trash2 size={12} /> Anonimizar
                      </button>
                    </>
                  )}
                </div>
              )
            })}
            {emps?.data?.length === 0 && (
              <p className="text-center text-slate-400 py-4 text-sm dark:text-white/30">Sin resultados</p>
            )}
          </div>
        )}
      </div>

      {/* Modal de confirmación */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => { setSelected(null); setConfirmText('') }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4 dark:bg-white/[0.04]"
            onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-rose-600 flex items-center gap-2">
              <AlertTriangle size={20} /> Anonimizar empleado
            </h3>
            <div className="text-sm text-slate-700 space-y-2 dark:text-white/80">
              <p>Vas a anonimizar a:</p>
              <p className="font-bold text-slate-900 dark:text-white">{selected.full_name} [{selected.code}]</p>
              <p className="text-rose-600">Esta acción es <strong>IRREVERSIBLE</strong>.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1 dark:text-white/40">
                Escribí <code className="bg-slate-100 px-1.5 rounded text-rose-600 dark:bg-white/[0.06]">ANONIMIZAR</code> para confirmar:
              </label>
              <input value={confirmText} onChange={e => setConfirmText(e.target.value)}
                placeholder="ANONIMIZAR"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setSelected(null); setConfirmText('') }}
                className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={() => anonymize(selected.id)}
                disabled={working || confirmText !== 'ANONIMIZAR'}
                className="bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white px-4 py-2 rounded-xl text-sm font-medium">
                {working ? 'Anonimizando...' : 'Anonimizar definitivamente'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Historial de exportaciones */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2 dark:border-white/[0.06]">
          <Clock size={16} className="text-slate-500 dark:text-white/40" />
          <h3 className="font-semibold text-slate-700 text-sm dark:text-white/80">Historial de exportaciones</h3>
          <span className="text-xs text-slate-400 dark:text-white/30">({history?.count ?? 0})</span>
        </div>
        <div className="divide-y divide-slate-50 max-h-72 overflow-y-auto dark:divide-white/[0.05]">
          {(history?.data || []).map((x: any) => (
            <div key={x.id} className="px-5 py-3 flex items-center justify-between text-sm">
              <div>
                <p className="text-slate-800 font-medium dark:text-white/90">{x.employee_name} <span className="text-xs text-slate-400 dark:text-white/30">[{x.code}]</span></p>
                <p className="text-xs text-slate-500 dark:text-white/40">
                  Solicitado por {x.requested_by_name || x.requested_by_username}
                  {x.reason && ` · ${x.reason}`}
                </p>
              </div>
              <span className="text-xs text-slate-400 font-mono dark:text-white/30">
                {format(new Date(x.export_date), "d MMM yyyy HH:mm", { locale: es })}
              </span>
            </div>
          ))}
          {history?.count === 0 && (
            <p className="text-center text-slate-400 py-6 text-sm dark:text-white/30">Sin exportaciones registradas</p>
          )}
        </div>
      </div>
    </div>
  )
}
