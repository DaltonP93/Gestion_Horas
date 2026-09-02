'use client'
/**
 * Nómina (base / sandbox) — vista mínima NO OFICIAL (FASE F4).
 *
 * Muestra períodos con su estado, adaptadores de integración (todos apagados) y
 * un banner que deja explícito que NO es una liquidación oficial ni un pago. La
 * escritura está protegida en la API por permiso y por PAYROLL_WRITE_ENABLED
 * (fail-closed).
 */
import { useEffect, useState } from 'react'
import { DollarSign, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'

interface Period { id: number; code: string; label: string; period_start: string; period_end: string; status: string; is_official: number }
interface Integration { key: string; label: string; enabled: boolean }

const STATUS_LABEL: Record<string, string> = { draft: 'Borrador', preview: 'Previsualización', locked: 'Bloqueado', closed: 'Cerrado' }

export default function NominaBasePage() {
  const [periods, setPeriods] = useState<Period[]>([])
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true); setError('')
    try {
      const [p, i] = await Promise.all([
        api.get('/api/payroll-base/periods').then(r => (r.data?.data ?? []) as Period[]),
        api.get('/api/payroll-base/integrations').then(r => (r.data?.data ?? []) as Integration[]).catch(() => [] as Integration[]),
      ])
      setPeriods(p); setIntegrations(i)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-green-600 flex items-center justify-center">
          <DollarSign className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Nómina — base (sandbox)</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Períodos, conceptos y previsualización agregada.</p>
        </div>
      </div>

      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-300">
        <AlertTriangle size={18} className="mt-0.5 shrink-0" />
        <p className="text-sm">
          <b>NO OFICIAL.</b> Esta base no calcula liquidación legal ni haberes, no realiza pagos ni integra con IPS/MTESS/bancos.
          Sólo estructura períodos y conceptos con trazabilidad para una etapa futura con fuente normativa y aprobación humana.
        </p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-white/70">Períodos</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
            <tr><th className="px-4 py-3">Código</th><th className="px-4 py-3">Período</th><th className="px-4 py-3">Rango</th><th className="px-4 py-3">Estado</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {loading && <tr><td colSpan={4} className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</td></tr>}
            {!loading && periods.length === 0 && !error && <tr><td colSpan={4} className="p-8 text-center text-slate-400 dark:text-white/30">Sin períodos</td></tr>}
            {periods.map(p => (
              <tr key={p.id}>
                <td className="px-4 py-2 font-medium text-slate-800 dark:text-white/80">{p.code}</td>
                <td className="px-4 py-2 text-slate-600 dark:text-white/60">{p.label}</td>
                <td className="px-4 py-2 text-slate-500 dark:text-white/50">{p.period_start} → {p.period_end}</td>
                <td className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-white/70">{STATUS_LABEL[p.status] || p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 dark:text-white/70">Integraciones (planificadas — apagadas)</h2>
        <div className="flex flex-wrap gap-2">
          {integrations.length === 0 && <span className="text-slate-400 text-sm dark:text-white/30">—</span>}
          {integrations.map(i => (
            <span key={i.key} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-white/60">
              <span className={`w-2 h-2 rounded-full ${i.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              {i.label} · {i.enabled ? 'activa' : 'apagada'}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
