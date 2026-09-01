'use client'
/**
 * Empresas — ABM mínimo de personas jurídicas empleadoras (FASE F1).
 *
 * La escritura está protegida en la API por permiso granular y por el flag
 * fail-closed GOVERNANCE_WRITE_ENABLED. Si el flag está apagado, el guardado
 * devuelve 503 y esta pantalla muestra ese mensaje sin romperse (la lectura
 * siempre funciona).
 */
import { useEffect, useState } from 'react'
import { Building2, Plus, Save, X } from 'lucide-react'
import { api } from '@/lib/api'

interface Company {
  id: number
  code: string
  legal_name: string
  trade_name: string | null
  tax_id: string | null
  active: number
}

export default function EmpresasPage() {
  const [rows, setRows] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Company | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setLoading(true); setError('')
    try {
      const data = await api.get('/api/companies').then(r => (r.data?.data ?? []) as Company[])
      setRows(data)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Error al cargar')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-slate-600 flex items-center justify-center">
            <Building2 className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Empresas</h1>
            <p className="text-slate-500 text-sm dark:text-white/40">Personas jurídicas empleadoras. Las sucursales se asocian a una empresa.</p>
          </div>
        </div>
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-600 hover:bg-slate-700 text-white text-sm font-medium">
          <Plus size={16} /> Nueva
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase tracking-wide dark:bg-white/[0.03] dark:text-white/40">
            <tr>
              <th className="px-4 py-3">Razón social</th>
              <th className="px-4 py-3">Código</th>
              <th className="px-4 py-3">Nombre comercial</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3 w-24"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {loading && (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-white/30">Cargando...</td></tr>
            )}
            {!loading && rows.length === 0 && !error && (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400 dark:text-white/30">Sin empresas cargadas</td></tr>
            )}
            {rows.map(c => (
              <tr key={c.id} className={c.active ? '' : 'opacity-50'}>
                <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{c.legal_name}</td>
                <td className="px-4 py-3 text-slate-500 dark:text-white/40">{c.code}</td>
                <td className="px-4 py-3 text-slate-600 dark:text-white/60">{c.trade_name || '—'}</td>
                <td className="px-4 py-3">
                  {c.active
                    ? <span className="text-emerald-600 text-xs font-medium">Activa</span>
                    : <span className="text-slate-400 text-xs">Inactiva</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setEditing(c)} className="text-blue-600 hover:underline text-sm font-medium">Editar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <CompanyFormModal
          company={editing}
          creating={creating}
          onClose={() => { setEditing(null); setCreating(false) }}
          onSaved={() => { setEditing(null); setCreating(false); load() }}
        />
      )}
    </div>
  )
}

function CompanyFormModal({ company, creating, onClose, onSaved }: {
  company: Company | null
  creating: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [code, setCode] = useState(company?.code || '')
  const [legalName, setLegalName] = useState(company?.legal_name || '')
  const [tradeName, setTradeName] = useState(company?.trade_name || '')
  const [taxId, setTaxId] = useState(company?.tax_id || '')
  const [active, setActive] = useState<boolean>(company ? !!company.active : true)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setSaving(true); setError('')
    try {
      const payload = {
        code, legal_name: legalName,
        trade_name: tradeName || null, tax_id: taxId || null,
        active, reason: reason || null,
      }
      if (creating) await api.post('/api/companies', payload)
      else          await api.patch(`/api/companies/${company!.id}`, payload)
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
            {creating ? 'Nueva empresa' : `Editar: ${company?.legal_name}`}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.06]"><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Código *</label>
            <input value={code} onChange={e => setCode(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Razón social *</label>
            <input value={legalName} onChange={e => setLegalName(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Nombre comercial</label>
            <input value={tradeName} onChange={e => setTradeName(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 dark:border-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">RUC</label>
            <input value={taxId} onChange={e => setTaxId(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 dark:border-white/[0.08]" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-white/70">
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
            Activa
          </label>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1 dark:text-white/60">Motivo del cambio</label>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Opcional — queda en la auditoría"
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 dark:border-white/[0.08]" />
          </div>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm text-slate-600 hover:bg-slate-100 dark:text-white/60 dark:hover:bg-white/[0.06]">Cancelar</button>
          <button onClick={handleSave} disabled={saving || !code || !legalName}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-slate-600 hover:bg-slate-700 text-white disabled:opacity-60">
            <Save size={16} /> {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}
