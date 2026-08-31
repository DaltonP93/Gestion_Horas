'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { employeesApi } from '@/lib/api'
import { hasRole, useCurrentUser } from '@/lib/useCurrentUser'

export default function ConfiguracionLaboralIndexPage() {
  const user = useCurrentUser()
  const [search, setSearch] = useState('')
  const allowed = hasRole(user, 'admin', 'gth', 'hr')

  const employeesQ = useQuery({
    queryKey: ['employees', 'workday-config-index'],
    queryFn: () => employeesApi.list({ status: 'active' }),
    enabled: allowed,
  })

  const employees = Array.isArray(employeesQ.data)
    ? employeesQ.data
    : (employeesQ.data?.data || employeesQ.data?.items || [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return employees
    return employees.filter((e: any) =>
      String(e.code || '').toLowerCase().includes(q)
      || String(e.full_name || `${e.first_name || ''} ${e.last_name || ''}`).toLowerCase().includes(q)
      || String(e.department || e.department_name || '').toLowerCase().includes(q)
    )
  }, [employees, search])

  if (!user) return <div className="p-6 text-slate-400">Cargando permisos...</div>
  if (!allowed) {
    return <div className="p-6 text-amber-700">No tenés permiso para administrar configuración laboral.</div>
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <Link href="/configuracion" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft size={16} /> Volver a Configuración
      </Link>

      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 dark:text-white">
          <SlidersHorizontal size={24} className="text-indigo-600" /> Configuración laboral por empleado
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-white/40">
          Horarios históricos, carga semanal, descansos, régimen y políticas con vigencia explícita.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        <ShieldCheck size={20} className="mt-0.5 shrink-0 text-blue-600" />
        <div>
          <p className="font-semibold">Configurar es opt-in y no modifica marcaciones.</p>
          <p className="mt-1">
            Un empleado sin vigencia completa continúa usando el motor histórico. No se aplica automáticamente el turno actual ni la Turnera al pasado.
          </p>
        </div>
      </div>

      <div className="relative">
        <Search size={17} className="absolute left-3 top-3 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por nombre, código o departamento…"
          className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]">
        {employeesQ.isLoading ? (
          <div className="p-8 text-center text-sm text-slate-400">Cargando empleados…</div>
        ) : employeesQ.isError ? (
          <div className="p-5 text-sm text-red-600">No se pudo cargar el padrón.</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">Sin resultados.</div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {filtered.map((e: any) => (
              <div key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900 dark:text-white">
                    {e.full_name || `${e.first_name || ''} ${e.last_name || ''}`.trim()}
                  </p>
                  <p className="text-xs text-slate-500">
                    #{e.code} · {e.department || e.department_name || 'Sin departamento'}
                    {e.schedule_name ? ` · turno actual: ${e.schedule_name}` : ''}
                  </p>
                </div>
                <Link
                  href={`/empleados/${e.id}/configuracion-laboral`}
                  className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                >
                  Administrar vigencias
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
