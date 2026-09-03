'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, ShieldAlert, RefreshCw, Database, ToggleLeft, ToggleRight,
  PlayCircle, RotateCcw, CheckCircle2, XCircle, Lock, AlertTriangle,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrentUser, isSuperAdmin } from '@/lib/useCurrentUser'

// Consola de ACTIVACIÓN GUIADA de FASE E. TODO lo mutante exige, en el backend,
// la doble compuerta (super_admin + master-flag FASE_E_ACTIVATION_ENABLED) más
// confirmación tipeada y backup. Esta UI sólo guía; el backend es la autoridad.

type Status = {
  migrations: { filename: string; recorded: boolean }[]
  engine_migrations_applied: boolean
  console_migration_applied: boolean
  daily_summary_status_has_074: boolean
  backup_tables_ready: boolean
  employee_schedule_history: { exists: boolean; rows: number | null }
  gates: {
    master_flag_enabled: boolean
    forward_env_kill_switch: boolean
    forward_db_setting: boolean
    forward_effective: boolean
    status_074_env: boolean
    workday_config_write_env: boolean
  }
  go_no_go: { schema_ready: boolean; forward_ready_to_flip: boolean; note: string }
}

function errMsg(e: any): string {
  const d = e?.response?.data
  if (d?.code === 'FASE_E_ACTIVATION_DISABLED') return '503 — master-flag apagado: acción mutante bloqueada por el backend.'
  return d?.error || e?.message || 'Error'
}

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
      ok ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
         : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}`}>
      {ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {children}
    </span>
  )
}

function Card({ n, title, subtitle, disabled, children }: any) {
  return (
    <div className={`rounded-xl border p-5 ${disabled ? 'opacity-60' : ''} border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800`}>
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">{n}</div>
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-white">{title}</h3>
          {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  )
}

export default function ActivacionMotorPage() {
  const user = useCurrentUser()
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  // Estado del asistente.
  const [backupConfirmed, setBackupConfirmed] = useState(false)
  const [confMig, setConfMig] = useState('')
  const [confFwd, setConfFwd] = useState('')
  const [confRecalc, setConfRecalc] = useState('')
  const [confRestore, setConfRestore] = useState('')
  const [range, setRange] = useState({ from: '', to: '', scope_kind: 'all', scope_id: '' })
  const [impact, setImpact] = useState<any>(null)
  const [batches, setBatches] = useState<any[]>([])
  const [restoreId, setRestoreId] = useState('')
  const [busy, setBusy] = useState('')

  async function loadStatus() {
    setLoading(true); setErr('')
    try {
      const r = await api.get('/api/fase-e/status')
      setStatus(r.data)
    } catch (e: any) { setErr(errMsg(e)) } finally { setLoading(false) }
  }
  async function loadBatches() {
    try { const r = await api.get('/api/fase-e/batches'); setBatches(r.data.batches || []) } catch { /* noop */ }
  }
  useEffect(() => { if (isSuperAdmin(user)) { loadStatus(); loadBatches() } }, [user])

  if (user === null) return <div className="p-6 text-slate-400">Cargando…</div>
  if (!isSuperAdmin(user)) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-800">
          <ShieldAlert size={18} /> Esta consola es exclusiva de super-administradores.
        </div>
      </div>
    )
  }

  const masterOn = !!status?.gates.master_flag_enabled
  const mutableEnabled = (extra: boolean) => masterOn && backupConfirmed && extra

  async function run(path: string, body: any, ok: string) {
    setBusy(path); setErr(''); setNotice('')
    try {
      const r = await api.post(path, body)
      setNotice(`${ok} ${r.data?.batch_id ? `(batch ${r.data.batch_id})` : ''}`)
      await loadStatus(); await loadBatches()
      return r.data
    } catch (e: any) { setErr(errMsg(e)); return null } finally { setBusy('') }
  }

  async function runDryRun() {
    setBusy('dryrun'); setErr(''); setImpact(null)
    try {
      const r = await api.post('/api/fase-e/recalc/dryrun', {
        from: range.from, to: range.to, scope_kind: range.scope_kind,
        scope_id: range.scope_id ? Number(range.scope_id) : null,
      })
      setImpact(r.data)
    } catch (e: any) { setErr(errMsg(e)) } finally { setBusy('') }
  }

  const pendingEngine = (status?.migrations || []).filter(m =>
    m.filename !== '083_fase_e_activation_console.sql' && !m.recorded)

  return (
    <div className="max-w-4xl space-y-5 p-6">
      <Link href="/configuracion" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft size={16} /> Volver a Configuración
      </Link>

      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 dark:text-white">
          <Lock size={22} className="text-indigo-600" /> Activación del motor de jornada (FASE E)
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Asistente guiado, fail-closed y reversible. Cada paso mutante exige, en el servidor, el
          master-flag <code>FASE_E_ACTIVATION_ENABLED=true</code>, confirmación tipeada y backup.
          El primer click real en producción lo da el dueño.
        </p>
      </div>

      {err && <div className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700"><XCircle size={16} />{err}</div>}
      {notice && <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-700"><CheckCircle2 size={16} />{notice}</div>}

      {/* Banner master-flag */}
      <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${masterOn
        ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
        : 'border-amber-300 bg-amber-50 text-amber-800'}`}>
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <b>Master-flag {masterOn ? 'ACTIVO' : 'apagado'}.</b>{' '}
          {masterOn
            ? 'Las acciones mutantes están habilitadas en el backend. Procedé con doble confirmación.'
            : 'Todas las acciones mutantes responden 503. Sólo el preflight/impacto funciona. Para activar, el dueño exporta FASE_E_ACTIVATION_ENABLED=true y recarga el proceso, en el momento exacto de la activación.'}
        </div>
      </div>

      {/* Paso 0 — Preflight */}
      <Card n={0} title="Preflight (solo lectura)" subtitle="Estado de migraciones, cerrojos y GO/NO-GO. Nunca escribe.">
        <div className="flex items-center justify-between">
          <button onClick={loadStatus} disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-700 dark:text-slate-200">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refrescar estado
          </button>
        </div>
        {status && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Migraciones del motor</div>
              <div className="space-y-1">
                {status.migrations.map(m => (
                  <div key={m.filename} className="flex items-center gap-2 text-sm">
                    {m.recorded ? <CheckCircle2 size={14} className="text-emerald-500" /> : <XCircle size={14} className="text-slate-400" />}
                    <span className="font-mono text-xs text-slate-600 dark:text-slate-300">{m.filename.replace('.sql', '')}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Cerrojos y esquema</div>
              <div className="flex flex-wrap gap-1.5">
                <Pill ok={status.gates.forward_env_kill_switch}>env kill-switch</Pill>
                <Pill ok={status.gates.forward_db_setting}>setting BD</Pill>
                <Pill ok={status.gates.forward_effective}>motor escribe</Pill>
                <Pill ok={status.daily_summary_status_has_074}>ENUM 074</Pill>
                <Pill ok={status.backup_tables_ready}>tablas backup</Pill>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Pill ok={status.go_no_go.schema_ready}>esquema listo</Pill>
                <Pill ok={status.go_no_go.forward_ready_to_flip}>listo para flip</Pill>
              </div>
              <p className="text-xs text-slate-400">{status.go_no_go.note}</p>
            </div>
          </div>
        )}
      </Card>

      {/* Paso 1 — Backup */}
      <Card n={1} title="Confirmar backup verificable" subtitle="Requisito para cualquier paso que sobrescriba datos.">
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={backupConfirmed} onChange={e => setBackupConfirmed(e.target.checked)} className="h-4 w-4" />
          Confirmo que existe un backup verificable de MySQL tomado recién.
        </label>
      </Card>

      {/* Paso 2 — Migraciones */}
      <Card n={2} title="Aplicar migraciones del motor (hasta 075)" disabled={!mutableEnabled(true)}
        subtitle="Corre el runner real acotado con --upto=075. No arrastra 083 ni posteriores.">
        {pendingEngine.length === 0
          ? <p className="text-sm text-emerald-600">No hay migraciones del motor pendientes.</p>
          : <div className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              Pendientes que se aplicarían:
              <ul className="ml-4 mt-1 list-disc font-mono text-xs">{pendingEngine.map(m => <li key={m.filename}>{m.filename}</li>)}</ul>
            </div>}
        <div className="flex flex-wrap items-center gap-2">
          <input value={confMig} onChange={e => setConfMig(e.target.value)} placeholder='Escribí: APLICAR MIGRACIONES'
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:bg-slate-900 dark:border-slate-600" />
          <button
            disabled={!mutableEnabled(confMig === 'APLICAR MIGRACIONES') || busy !== ''}
            onClick={() => run('/api/fase-e/migrations/apply', { confirm: confMig, backup_confirmed: backupConfirmed }, 'Migraciones aplicadas.')}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
            <Database size={14} /> Aplicar migraciones
          </button>
        </div>
      </Card>

      {/* Paso 3 — Activación hacia adelante */}
      <Card n={3} title="Activar el motor hacia adelante (reversible)" disabled={!masterOn}
        subtitle="Flip del setting fase_e_forward_enabled. El env kill-switch de ops debe estar en true además.">
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Pill ok={!!status?.gates.forward_env_kill_switch}>env kill-switch (ops)</Pill>
          <Pill ok={!!status?.gates.forward_db_setting}>setting BD</Pill>
          <Pill ok={!!status?.gates.forward_effective}>motor escribe</Pill>
        </div>
        {!status?.gates.forward_env_kill_switch && (
          <p className="mb-2 text-xs text-amber-600">El env kill-switch está apagado: aun activando el setting, el motor NO escribirá hasta que ops habilite WORKDAY_ENGINE_DAILY_SUMMARY_WRITE_ENABLED=true.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input value={confFwd} onChange={e => setConfFwd(e.target.value)} placeholder='Escribí: ACTIVAR MOTOR'
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:bg-slate-900 dark:border-slate-600" />
          <button
            disabled={!mutableEnabled(confFwd === 'ACTIVAR MOTOR') || busy !== ''}
            onClick={() => run('/api/fase-e/forward/enable', { confirm: confFwd, backup_confirmed: backupConfirmed }, 'Motor activado hacia adelante.')}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
            <ToggleRight size={14} /> Activar
          </button>
          <button
            disabled={!masterOn || busy !== ''}
            onClick={() => run('/api/fase-e/forward/disable', {}, 'Motor desactivado (reversa segura).')}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-300 disabled:opacity-40 dark:bg-slate-700 dark:text-slate-200">
            <ToggleLeft size={14} /> Desactivar
          </button>
        </div>
      </Card>

      {/* Paso 4 — Recálculo histórico acotado */}
      <Card n={4} title="Recálculo histórico acotado (reversible)"
        subtitle="Dry-run → preview → confirmación tipeada. Respalda cada fila antes de sobrescribirla.">
        <div className="grid gap-2 sm:grid-cols-4">
          <input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:bg-slate-900 dark:border-slate-600" />
          <input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:bg-slate-900 dark:border-slate-600" />
          <select value={range.scope_kind} onChange={e => setRange({ ...range, scope_kind: e.target.value })}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:bg-slate-900 dark:border-slate-600">
            <option value="all">Todos (activos)</option>
            <option value="department">Departamento</option>
            <option value="employee">Empleado</option>
          </select>
          <input value={range.scope_id} onChange={e => setRange({ ...range, scope_id: e.target.value })}
            placeholder={range.scope_kind === 'all' ? '—' : 'id'} disabled={range.scope_kind === 'all'}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-40 dark:bg-slate-900 dark:border-slate-600" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={runDryRun} disabled={!range.from || !range.to || busy !== ''}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-40 dark:bg-slate-700 dark:text-slate-200">
            <PlayCircle size={14} /> Dry-run (solo lectura)
          </button>
        </div>
        {impact && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-900">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><div className="text-xs text-slate-400">Empleados</div><div className="font-semibold">{impact.employees}</div></div>
              <div><div className="text-xs text-slate-400">Filas evaluadas</div><div className="font-semibold">{impact.rows_evaluated}</div></div>
              <div><div className="text-xs text-slate-400">Diferirían</div><div className="font-semibold text-amber-600">{impact.rows_differ}</div></div>
              <div><div className="text-xs text-slate-400">Filas nuevas</div><div className="font-semibold">{impact.rows_new}</div></div>
            </div>
            {impact.examples?.length > 0 && (
              <div className="mt-2 max-h-40 overflow-auto text-xs">
                <div className="text-slate-400">Ejemplos (sin PII):</div>
                {impact.examples.slice(0, 20).map((ex: any, i: number) => (
                  <div key={i} className="font-mono">emp {ex.employee_id} · {ex.date}: {ex.stored?.status ?? '∅'} → {ex.motor.status} ({ex.stored?.worked_minutes ?? 0}→{ex.motor.worked_minutes}m)</div>
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
              <input value={confRecalc} onChange={e => setConfRecalc(e.target.value)} placeholder='Escribí: RECALCULAR'
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:bg-slate-900 dark:border-slate-600" />
              <button
                disabled={!mutableEnabled(confRecalc === 'RECALCULAR') || busy !== ''}
                onClick={() => run('/api/fase-e/recalc/apply', {
                  confirm: confRecalc, backup_confirmed: backupConfirmed,
                  from: range.from, to: range.to, scope_kind: range.scope_kind,
                  scope_id: range.scope_id ? Number(range.scope_id) : null,
                }, 'Recálculo aplicado con respaldo.')}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                <PlayCircle size={14} /> Aplicar recálculo (con respaldo)
              </button>
              {!masterOn && <span className="text-xs text-amber-600">Requiere master-flag activo.</span>}
            </div>
          </div>
        )}
      </Card>

      {/* Paso 5 — Restore */}
      <Card n={5} title="Restaurar un lote (rollback)" subtitle="Repone el estado previo por batch_id. Reversible.">
        <button onClick={loadBatches} className="mb-3 inline-flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200">
          <RefreshCw size={14} /> Refrescar lotes
        </button>
        <div className="max-h-48 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900">
              <tr><th className="p-2">batch_id</th><th className="p-2">rango</th><th className="p-2">alcance</th><th className="p-2">filas</th><th className="p-2">estado</th></tr>
            </thead>
            <tbody>
              {batches.length === 0 && <tr><td colSpan={5} className="p-3 text-center text-slate-400">Sin lotes.</td></tr>}
              {batches.map(b => (
                <tr key={b.batch_id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="p-2 font-mono">{b.batch_id.slice(0, 8)}…</td>
                  <td className="p-2">{b.from_date}→{b.to_date}</td>
                  <td className="p-2">{b.scope_kind}{b.scope_id ? ` #${b.scope_id}` : ''}</td>
                  <td className="p-2">{b.rows_written}</td>
                  <td className="p-2">{b.status === 'restored'
                    ? <span className="text-slate-400">restaurado</span>
                    : <button onClick={() => setRestoreId(b.batch_id)} className="text-indigo-600 hover:underline">seleccionar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={restoreId} onChange={e => setRestoreId(e.target.value)} placeholder='batch_id'
            className="rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-xs dark:bg-slate-900 dark:border-slate-600" />
          <input value={confRestore} onChange={e => setConfRestore(e.target.value)} placeholder='Escribí: RESTAURAR'
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:bg-slate-900 dark:border-slate-600" />
          <button
            disabled={!masterOn || !restoreId || confRestore !== 'RESTAURAR' || busy !== ''}
            onClick={() => run('/api/fase-e/recalc/restore', { confirm: confRestore, batch_id: restoreId }, 'Lote restaurado.')}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-40">
            <RotateCcw size={14} /> Restaurar lote
          </button>
        </div>
      </Card>

      <p className="pb-8 text-center text-xs text-slate-400">
        Consola fail-closed. Nada se ejecuta sin doble compuerta, confirmación tipeada y backup. att2000 permanece READ-ONLY.
      </p>
    </div>
  )
}
