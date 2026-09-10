'use client'
/**
 * Centros de costo — ABM mínimo (FASE F1).
 *
 * Igual postura que Empresas: la escritura está protegida en la API por
 * permiso granular y por el flag fail-closed GOVERNANCE_WRITE_ENABLED. La
 * lectura siempre funciona; el guardado muestra el error de la API (incluido
 * el 503 de modo sólo lectura) sin romper la pantalla.
 */
import { useEffect, useState } from 'react'
import { PiggyBank, Plus, Save, X } from 'lucide-react'
import { api } from '@/lib/api'

interface CostCenter {
  id: number
  company_id: number | null
  company_name: string | null
  code: string
  name: string
  active: number
}
interface CompanyRef { id: number; legal_name: string }

export default function CentrosCostoPage() {
  const [rows, setRows] = useState<CostCenter[]>([])
  const [companies, setCompanies] = useState<CompanyRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<CostCenter | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const [cc, co] = await Promise.all([
        api.get('/api/cost-centers').then(r => (r.data?.data ?? []) as CostCenter[]),
        api.get('/api/companies').then(r => (r.data?.data ?? []) as CompanyRef[]).catch(() => [] as CompanyRef[]),
      ])
      setRows(cc); setCompanies(co)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-amber-600 flex items-center justify-center">
            <PiggyBank className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Centros de costo</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">Unidades de imputación de costos, opcionalmente ligadas a una empresa.</p>
          </div>
        </div>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium">
          <Plus size={16} /> Nuevo
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
            <tr>
              <th className="px-4 py-3">Nombre</th>
              <th className="px-4 py-3">Código</th>
              <th className="px-4 py-3">Empresa</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3 w-24"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {loading && (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</td></tr>
            )}
            {!loading && rows.length === 0 && !error && (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-white/30">Sin centros de costo cargados</td></tr>
            )}
            {rows.map(cc => (
              <tr key={cc.id} className={cc.active ? '' : 'opacity-50'}>
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{cc.name}</td>
                <td className="px-4 py-3 text-slate-500 dark:text-white/40">{cc.code}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-white/60">{cc.company_name || '—'}</td>
                <td className="px-4 py-3">
                  {cc.active
                    ? <span className="text-emerald-600 text-xs font-medium">Activo</span>
                    : <span className="text-slate-400 text-xs">Inactivo</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setEditing(cc)} className="text-blue-600 hover:underline text-sm font-medium">Editar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <CostCenterFormModal
          costCenter={editing}
          creating={creating}
          companies={companies}
          onClose={() => { setEditing(null); setCreating(false) }}
          onSaved={() => { setEditing(null); setCreating(false); load() }}
        />
      )}
    </div>
  )
}

function CostCenterFormModal({ costCenter, creating, companies, onClose, onSaved }: {
  costCenter: CostCenter | null
  creating: boolean
  companies: CompanyRef[]
  onClose: () => void
  onSaved: () => void
}) {
  const [code, setCode] = useState(costCenter?.code || '')
  const [name, setName] = useState(costCenter?.name || '')
  const [companyId, setCompanyId] = useState<string>(costCenter?.company_id?.toString() || '')
  const [active, setActive] = useState<boolean>(costCenter ? !!costCenter.active : true)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setSaving(true); setError('')
    try {
      const payload = {
        code, name,
        company_id: companyId ? parseInt(companyId) : null,
        active, reason: reason || null,
      }
      if (creating) await api.post('/api/cost-centers', payload)
      else          await api.patch(`/api/cost-centers/${costCenter!.id}`, payload)
      onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al guardar')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-4 dark:bg-white/[0.04]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {creating ? 'Nuevo centro de costo' : `Editar: ${costCenter?.name}`}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Código *</label>
            <input value={code} onChange={e => setCode(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Nombre *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Empresa</label>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-white/[0.08]">
              <option value="">— Sin empresa —</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.legal_name}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-white/70">
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
            Activo
          </label>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Motivo del cambio</label>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Opcional — queda en la auditoría"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-white/[0.08]" />
          </div>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={handleSave} disabled={saving || !code || !name}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-60">
            <Save size={16} /> {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}
