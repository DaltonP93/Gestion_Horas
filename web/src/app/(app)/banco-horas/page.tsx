'use client'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { PiggyBank, Plus, Minus, RefreshCw, ArrowDownCircle, ArrowUpCircle, Search, X, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { downloadCsv } from '@/lib/csvExport'

function minsToHM(m: number) {
  const sign = m < 0 ? '-' : ''
  const abs = Math.abs(m)
  const h = Math.floor(abs / 60)
  const min = abs % 60
  return `${sign}${h}:${String(min).padStart(2, '0')}`
}

export default function BancoHorasPage() {
  const qc = useQueryClient()
  const user = useCurrentUser()
  const [search, setSearch] = useState('')
  const [dept, setDept] = useState('')
  const [selectedEmp, setSelectedEmp] = useState<any>(null)
  const [showSync, setShowSync] = useState(false)
  const [syncFrom, setSyncFrom] = useState('')
  const [syncTo, setSyncTo] = useState('')
  const [txMode, setTxMode] = useState<'deposit' | 'redeem' | null>(null)
  const [txMinutes, setTxMinutes] = useState('')
  const [txReason, setTxReason] = useState('')

  const isAdmin = ['admin', 'gth', 'hr', 'super_admin'].includes(user?.role || '')

  const { data: summary } = useQuery({
    queryKey: ['overtime-summary'],
    queryFn: () => api.get('/api/overtime-bank/summary').then(r => r.data),
  })

  const { data: detail } = useQuery({
    queryKey: ['overtime-employee', selectedEmp?.id],
    queryFn: () => api.get(`/api/overtime-bank/employee/${selectedEmp.id}`).then(r => r.data),
    enabled: !!selectedEmp,
  })

  const departments = useMemo(() => {
    const s = new Set<string>()
    for (const r of (summary?.data || [])) if (r.department) s.add(r.department)
    return [...s].sort()
  }, [summary])

  const filtered = (summary?.data || []).filter((r: any) =>
    (!search ||
      r.employee_name?.toLowerCase().includes(search.toLowerCase()) ||
      r.code?.toLowerCase().includes(search.toLowerCase())) &&
    (!dept || r.department === dept)
  )

  function exportCsv() {
    if (!filtered.length) return
    downloadCsv(
      'banco-horas_saldos.csv',
      ['Código', 'Empleado', 'Departamento', 'Saldo (min)', 'Acumulado (min)', 'Canjeado (min)', 'Última actividad'],
      filtered.map((r: any) => [
        r.code, r.employee_name, r.department || '',
        r.balance_minutes, r.total_deposited, r.total_redeemed,
        r.last_activity ? String(r.last_activity).slice(0, 10) : '',
      ]),
    )
  }

  async function syncFromDaily() {
    if (!syncFrom || !syncTo) return alert('Ingresá rango de fechas')
    try {
      const r = await api.post('/api/overtime-bank/sync-from-daily', { date_from: syncFrom, date_to: syncTo })
      alert(`✅ ${r.data.deposited} día(s) acreditado(s) — ${r.data.total_minutes} min totales`)
      qc.invalidateQueries({ queryKey: ['overtime-summary'] })
      setShowSync(false)
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error en sincronización')
    }
  }

  async function submitTransaction() {
    if (!selectedEmp || !txMode || !txMinutes) return
    const mins = parseInt(txMinutes, 10)
    if (!mins || mins <= 0) return alert('Minutos inválidos')
    try {
      await api.post(`/api/overtime-bank/${txMode}`, {
        employee_id: selectedEmp.id,
        minutes: mins,
        reason: txReason || undefined,
      })
      qc.invalidateQueries({ queryKey: ['overtime-summary'] })
      qc.invalidateQueries({ queryKey: ['overtime-employee', selectedEmp.id] })
      setTxMode(null); setTxMinutes(''); setTxReason('')
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Error en la transacción')
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
            <PiggyBank className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Banco de horas</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">Acumulación y canje de horas extra por empleado</p>
          </div>
        </div>
        {isAdmin && (
          <button onClick={() => setShowSync(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
            <RefreshCw size={14} /> Sincronizar desde resumen diario
          </button>
        )}
      </div>

      {/* Lista de saldos */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2 flex-wrap dark:border-white/[0.06]">
          <Search size={16} className="text-slate-400 dark:text-white/30" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar empleado..."
            className="flex-1 min-w-[8rem] outline-none text-sm bg-transparent" />
          <select value={dept} onChange={e => setDept(e.target.value)}
            className="border border-slate-200 rounded-lg px-2 py-1 text-sm bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
            <option value="">Todos los deptos.</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <button onClick={exportCsv} disabled={!filtered.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-white/[0.04]">
            <Download size={13} /> CSV
          </button>
          <span className="text-xs text-slate-400 dark:text-white/30">{filtered.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <tr>
                <th className="text-left px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Empleado</th>
                <th className="text-left px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Departamento</th>
                <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Saldo</th>
                <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Acumulado</th>
                <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Canjeado</th>
                <th className="text-right px-4 py-2.5 text-slate-500 font-medium text-xs dark:text-white/40">Última actividad</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {filtered.map((r: any) => (
                <tr key={r.id} className="hover:bg-slate-50 cursor-pointer dark:hover:bg-white/[0.04]"
                  onClick={() => setSelectedEmp(r)}>
                  <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-white/90">
                    {r.employee_name} <span className="text-xs text-slate-400 dark:text-white/30">[{r.code}]</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs dark:text-white/40">{r.department || '—'}</td>
                  <td className={`px-4 py-2.5 text-right font-mono font-bold ${
                    r.balance_minutes > 0 ? 'text-emerald-600' :
                    r.balance_minutes < 0 ? 'text-rose-600' : 'text-slate-400'
                  }`}>
                    {minsToHM(r.balance_minutes)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-emerald-600 text-xs">
                    +{minsToHM(r.total_deposited)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-rose-600 text-xs">
                    {minsToHM(r.total_redeemed)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-slate-400 dark:text-white/30">
                    {r.last_activity ? format(new Date(r.last_activity), "d MMM yyyy", { locale: es }) : '—'}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="text-center py-8 text-slate-400 dark:text-white/30">Sin datos</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal detalle empleado */}
      {selectedEmp && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => { setSelectedEmp(null); setTxMode(null) }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col dark:bg-white/[0.04]"
            onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between dark:border-white/[0.06]">
              <div>
                <h3 className="font-bold text-slate-900 dark:text-white">{selectedEmp.employee_name}</h3>
                <p className="text-xs text-slate-500 dark:text-white/40">[{selectedEmp.code}] · {selectedEmp.department || 'Sin depto'}</p>
              </div>
              <button onClick={() => setSelectedEmp(null)} className="text-slate-400 hover:text-slate-600 dark:text-white/30">
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between dark:bg-white/[0.03] dark:border-white/[0.06]">
              <div>
                <p className="text-xs text-slate-500 uppercase dark:text-white/40">Saldo actual</p>
                <p className={`text-3xl font-bold font-mono ${
                  (detail?.balance_minutes || 0) > 0 ? 'text-emerald-600' :
                  (detail?.balance_minutes || 0) < 0 ? 'text-rose-600' : 'text-slate-400'
                }`}>
                  {minsToHM(detail?.balance_minutes || 0)}
                </p>
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <button onClick={() => setTxMode('deposit')}
                    className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-xl text-sm font-medium">
                    <Plus size={14} /> Acreditar
                  </button>
                  <button onClick={() => setTxMode('redeem')}
                    className="flex items-center gap-1.5 bg-rose-600 hover:bg-rose-700 text-white px-3 py-2 rounded-xl text-sm font-medium">
                    <Minus size={14} /> Canjear
                  </button>
                </div>
              )}
            </div>

            {txMode && (
              <div className="px-5 py-4 bg-blue-50 border-b border-blue-100 space-y-3">
                <h4 className="text-sm font-semibold text-blue-900">
                  {txMode === 'deposit' ? 'Acreditar horas al banco' : 'Canjear horas del banco'}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1 dark:text-white/60">Minutos</label>
                    <input type="number" min="1" value={txMinutes} onChange={e => setTxMinutes(e.target.value)}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1 dark:text-white/60">Motivo</label>
                    <input value={txReason} onChange={e => setTxReason(e.target.value)}
                      placeholder={txMode === 'deposit' ? 'Ej: hora extra autorizada' : 'Ej: día compensado'}
                      className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setTxMode(null)} className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
                  <button onClick={submitTransaction}
                    className={`text-white px-4 py-2 rounded-xl text-sm font-medium ${
                      txMode === 'deposit' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'
                    }`}>
                    Confirmar
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-white border-b border-slate-100 sticky top-0 dark:bg-white/[0.04] dark:border-white/[0.06]">
                  <tr>
                    <th className="text-left px-4 py-2 text-slate-500 font-medium text-xs dark:text-white/40">Fecha</th>
                    <th className="text-left px-4 py-2 text-slate-500 font-medium text-xs dark:text-white/40">Tipo</th>
                    <th className="text-right px-4 py-2 text-slate-500 font-medium text-xs dark:text-white/40">Minutos</th>
                    <th className="text-left px-4 py-2 text-slate-500 font-medium text-xs dark:text-white/40">Motivo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                  {(detail?.transactions || []).map((t: any) => (
                    <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                      <td className="px-4 py-2 text-xs">
                        {format(new Date(t.created_at), "d MMM yyyy HH:mm", { locale: es })}
                        {t.reference_date && (
                          <span className="block text-slate-400 dark:text-white/30">
                            (ref: {format(new Date(t.reference_date), "d MMM", { locale: es })})
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                          t.type === 'deposit' ? 'bg-emerald-50 text-emerald-700' :
                          t.type === 'redeem'  ? 'bg-rose-50 text-rose-700' :
                                                 'bg-slate-100 text-slate-600'
                        }`}>
                          {t.type === 'deposit' ? <ArrowDownCircle size={11} /> : <ArrowUpCircle size={11} />}
                          {t.type}
                        </span>
                      </td>
                      <td className={`px-4 py-2 text-right font-mono font-semibold ${
                        t.minutes > 0 ? 'text-emerald-600' : 'text-rose-600'
                      }`}>
                        {t.minutes > 0 ? '+' : ''}{minsToHM(t.minutes)}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-500 dark:text-white/40">{t.reason || '—'}</td>
                    </tr>
                  ))}
                  {(!detail?.transactions || detail.transactions.length === 0) && (
                    <tr><td colSpan={4} className="text-center py-6 text-slate-400 text-sm dark:text-white/30">Sin transacciones</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Modal sync */}
      {showSync && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setShowSync(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4 dark:bg-white/[0.04]"
            onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-slate-900 flex items-center gap-2 dark:text-white">
              <RefreshCw size={18} className="text-blue-600" /> Sincronizar desde resumen diario
            </h3>
            <p className="text-sm text-slate-600 dark:text-white/60">
              Acredita automáticamente al banco las horas extra registradas en el resumen diario para el rango seleccionado. Idempotente: cada día se acredita una sola vez.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1 dark:text-white/40">Desde</label>
                <input type="date" value={syncFrom} onChange={e => setSyncFrom(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1 dark:text-white/40">Hasta</label>
                <input type="date" value={syncTo} onChange={e => setSyncTo(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]" />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowSync(false)}
                className="border border-slate-200 hover:bg-slate-50 px-4 py-2 rounded-xl text-sm dark:border-white/[0.08] dark:hover:bg-white/[0.04]">Cancelar</button>
              <button onClick={syncFromDaily}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium">
                Sincronizar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
