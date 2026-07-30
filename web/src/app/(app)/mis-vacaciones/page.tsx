'use client'
import { useEffect, useState } from 'react'
import { Calendar, AlertCircle, Send, Plane } from 'lucide-react'
import { api } from '@/lib/api'

interface Balance {
  year: number
  day_type: 'habiles' | 'corridos'
  hire_date: string | null
  antiguedad_years: number
  entitlement: number
  assigned: number
  adjustment: number
  taken: number
  available: number
  note: string | null
  overridden: boolean
}

interface PermissionRow {
  id: number
  type: string
  date_from: string
  date_to: string
  reason: string | null
  status: string
  approval_state: string
  created_at: string
  rejection_reason?: string | null
}

export default function MisVacacionesPage() {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [history, setHistory] = useState<PermissionRow[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ date_from: '', date_to: '', reason: '' })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    setError(''); setLoading(true)
    try {
      const [b, p] = await Promise.all([
        api.get<Balance>('/api/me/vacation-balance', { params: { year } }).then(r => r.data),
        api.get<PermissionRow[]>('/api/me/permissions').then(r => r.data),
      ])
      setBalance(b)
      setHistory(p.filter(x => x.type === 'vacation'))
    } catch (e: any) {
      setError(e.response?.data?.error || e.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [year])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setMsg('')
    if (!form.date_from || !form.date_to) return setError('Fechas requeridas')
    if (form.date_from > form.date_to) return setError('La fecha de inicio no puede ser posterior a la de fin')
    setSaving(true)
    try {
      await api.post('/api/me/permissions', { type: 'vacation', ...form })
      setMsg('Solicitud enviada. Queda pendiente de aprobación.')
      setForm({ date_from: '', date_to: '', reason: '' })
      await load()
    } catch (e: any) { setError(e.response?.data?.error || e.message) }
    finally { setSaving(false) }
  }

  const stateBadge = (s: string) => {
    const map: Record<string, string> = {
      approved:  'bg-emerald-100 text-emerald-800',
      pending:   'bg-amber-100 text-amber-800',
      level1_ok: 'bg-blue-100 text-blue-800',
      level2_ok: 'bg-indigo-100 text-indigo-800',
      rejected:  'bg-red-100 text-red-800',
      cancelled: 'bg-slate-100 text-slate-600',
    }
    return map[s] || 'bg-slate-100 text-slate-600'
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-teal-500 flex items-center justify-center">
          <Plane className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Mis vacaciones</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Tu saldo del año y tus solicitudes.</p>
        </div>
        <div className="ml-auto">
          <select value={year} onChange={e => setYear(parseInt(e.target.value, 10))}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
            {[currentYear - 1, currentYear, currentYear + 1].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-sm text-red-900">
          <AlertCircle size={16} className="shrink-0 mt-0.5" /> {error}
        </div>
      )}
      {msg && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-900">
          {msg}
        </div>
      )}

      {/* Tarjetas de saldo */}
      {loading ? (
        <div className="p-8 text-center text-slate-400">Cargando…</div>
      ) : balance ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Kpi label="Disponibles" value={balance.available} tone="teal" />
          <Kpi label="Asignados" value={balance.assigned + balance.adjustment} tone="indigo" />
          <Kpi label="Tomados" value={balance.taken} tone="amber" />
          <Kpi label="Antigüedad" value={`${balance.antiguedad_years} a.`} tone="slate" />
        </div>
      ) : null}

      {balance && (
        <p className="text-xs text-slate-500 dark:text-white/40">
          Conteo por días <strong>{balance.day_type}</strong>. Derecho vigente: <strong>{balance.entitlement}</strong> días.
          {balance.overridden && ' (Saldo asignado manualmente por RR.HH.)'}
        </p>
      )}

      {/* Solicitud */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Solicitar vacaciones</h2>
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Desde</label>
            <input type="date" value={form.date_from} onChange={e => setForm(f => ({ ...f, date_from: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Hasta</label>
            <input type="date" value={form.date_to} onChange={e => setForm(f => ({ ...f, date_to: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Motivo (opcional)</label>
            <input type="text" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]" />
          </div>
          <div className="md:col-span-3 flex justify-end">
            <button type="submit" disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium disabled:opacity-60">
              <Send size={14} /> {saving ? 'Enviando…' : 'Enviar solicitud'}
            </button>
          </div>
        </form>
      </section>

      {/* Historial */}
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Calendar size={14} /> Historial de solicitudes
          </h2>
        </div>
        {history.length === 0 ? (
          <div className="p-8 text-center text-slate-400 dark:text-white/30 text-sm">Sin solicitudes.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-white/[0.03] text-left text-xs text-slate-500 uppercase tracking-wide dark:text-white/40">
              <tr>
                <th className="px-4 py-3">Desde</th>
                <th className="px-4 py-3">Hasta</th>
                <th className="px-4 py-3">Motivo</th>
                <th className="px-4 py-3">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {history.map(r => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5 text-slate-900 dark:text-white">{r.date_from}</td>
                  <td className="px-4 py-2.5 text-slate-900 dark:text-white">{r.date_to}</td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-white/60">{r.reason || '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${stateBadge(r.approval_state || r.status)}`}>
                      {r.approval_state || r.status}
                    </span>
                    {r.rejection_reason && <div className="text-xs text-red-600 mt-1">{r.rejection_reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: number | string; tone: 'teal' | 'indigo' | 'amber' | 'slate' }) {
  const bg: Record<string, string> = {
    teal:   'bg-teal-500',
    indigo: 'bg-indigo-500',
    amber:  'bg-amber-500',
    slate:  'bg-slate-500',
  }
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
      <div className={`w-9 h-9 rounded-lg ${bg[tone]} flex items-center justify-center mb-2`}>
        <Calendar className="text-white" size={16} />
      </div>
      <p className="text-xs text-slate-500 uppercase tracking-wide dark:text-white/40">{label}</p>
      <p className="text-2xl font-bold text-slate-900 dark:text-white">{value}</p>
    </div>
  )
}
