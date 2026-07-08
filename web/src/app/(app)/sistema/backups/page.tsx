'use client'
import { useState, useEffect } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Archive, RefreshCw, Download, Trash2, Plus, AlertTriangle, HardDrive, Cloud, Save, TestTube } from 'lucide-react'
import { api, downloadUrl } from '@/lib/api'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import BackButton from '@/components/BackButton'

function OffsiteConfig() {
  const [cfg, setCfg] = useState<any>({ provider: '', s3_endpoint: '', s3_bucket: '', s3_access_key: '', s3_secret_key: '', s3_region: 'us-east-1', s3_prefix: 'sishoras/', sftp_host: '', sftp_port: '22', sftp_user: '', sftp_password: '', sftp_remote_dir: '/backups/' })
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!open) return
    api.get('/api/backups/offsite-config').then(r => {
      const d = r.data
      setCfg({
        provider: d.provider || '',
        s3_endpoint: d.s3?.endpoint || '', s3_bucket: d.s3?.bucket || '',
        s3_access_key: d.s3?.accessKey || '', s3_secret_key: d.s3?.secretKey || '',
        s3_region: d.s3?.region || 'us-east-1', s3_prefix: d.s3?.prefix || 'sishoras/',
        sftp_host: d.sftp?.host || '', sftp_port: d.sftp?.port || '22',
        sftp_user: d.sftp?.user || '', sftp_password: d.sftp?.password || '',
        sftp_remote_dir: d.sftp?.remoteDir || '/backups/',
      })
    }).catch(() => {})
  }, [open])

  async function save() {
    setSaving(true); setMsg('')
    try { await api.put('/api/backups/offsite-config', cfg); setMsg('✅ Guardado') }
    catch (e: any) { setMsg('❌ ' + (e?.response?.data?.error || 'Error')) }
    finally { setSaving(false) }
  }

  async function testUpload() {
    setTesting(true); setMsg('')
    try { const r = await api.post('/api/backups/offsite-test'); setMsg('✅ ' + JSON.stringify(r.data.result)) }
    catch (e: any) { setMsg('❌ ' + (e?.response?.data?.error || 'Error')) }
    finally { setTesting(false) }
  }

  const set = (k: string) => (v: string) => setCfg((p: any) => ({ ...p, [k]: v }))
  const inp = (k: string, label: string, type = 'text', ph = '') => (
    <div key={k}>
      <label className="text-xs text-slate-500 mb-1 block dark:text-white/40">{label}</label>
      <input type={type} value={cfg[k]} onChange={e => set(k)(e.target.value)} placeholder={ph}
        className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
    </div>
  )

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm dark:bg-white/[0.04] dark:border-white/[0.06]">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 rounded-2xl transition-colors dark:text-white/80 dark:hover:bg-white/[0.04]">
        <div className="flex items-center gap-2"><Cloud size={16} className="text-blue-500" /> Backup off-site (S3 / MinIO / SFTP)</div>
        <span className="text-xs text-slate-400 dark:text-white/30">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-slate-100 pt-4 dark:border-white/[0.06]">
          <div>
            <label className="text-xs text-slate-500 mb-1 block dark:text-white/40">Proveedor</label>
            <select value={cfg.provider} onChange={e => set('provider')(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm dark:border-white/[0.08]">
              <option value="">Deshabilitado</option>
              <option value="s3">S3 / MinIO</option>
              <option value="sftp">SFTP</option>
            </select>
          </div>
          {cfg.provider === 's3' && (
            <div className="grid grid-cols-2 gap-3">
              {inp('s3_endpoint', 'Endpoint (vacío = AWS)', 'url', 'https://play.min.io')}
              {inp('s3_bucket', 'Bucket', 'text', 'mis-backups')}
              {inp('s3_access_key', 'Access Key')}
              {inp('s3_secret_key', 'Secret Key', 'password')}
              {inp('s3_region', 'Región', 'text', 'us-east-1')}
              {inp('s3_prefix', 'Prefijo', 'text', 'sishoras/')}
            </div>
          )}
          {cfg.provider === 'sftp' && (
            <div className="grid grid-cols-2 gap-3">
              {inp('sftp_host', 'Host', 'text', 'sftp.miservidor.com')}
              {inp('sftp_port', 'Puerto', 'number')}
              {inp('sftp_user', 'Usuario')}
              {inp('sftp_password', 'Contraseña', 'password')}
              {inp('sftp_remote_dir', 'Directorio remoto', 'text', '/backups/')}
            </div>
          )}
          {msg && <p className={`text-xs ${msg.startsWith('❌') ? 'text-red-600' : 'text-emerald-600'}`}>{msg}</p>}
          <div className="flex gap-2">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 bg-blue-600 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60">
              <Save size={13} /> {saving ? 'Guardando...' : 'Guardar'}
            </button>
            {cfg.provider && (
              <button onClick={testUpload} disabled={testing}
                className="flex items-center gap-2 border border-slate-200 text-slate-700 rounded-xl px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-60 dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                <TestTube size={13} /> {testing ? 'Probando...' : 'Test upload'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function bytesToHuman(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function BackupsPage() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get('/api/backups').then(r => r.data),
    refetchInterval: 30_000,
  })

  const createMut = useMutation({
    mutationFn: () => api.post('/api/backups').then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backups'] })
      alert('Backup generado correctamente ✅')
    },
    onError: (e: any) => alert(e?.response?.data?.error || 'Error al generar backup'),
  })

  const purgeMut = useMutation({
    mutationFn: () => api.post('/api/backups/purge').then(r => r.data),
    onSuccess: (d: any) => {
      qc.invalidateQueries({ queryKey: ['backups'] })
      alert(`Purga completada: ${d.removed} backup(s) viejos eliminados`)
    },
  })

  async function deleteBackup(filename: string) {
    if (!confirm(`¿Eliminar backup "${filename}"? Esta acción no se puede deshacer.`)) return
    try {
      await api.delete(`/api/backups/${encodeURIComponent(filename)}`)
      qc.invalidateQueries({ queryKey: ['backups'] })
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al eliminar')
    }
  }

  const backups: any[] = data?.backups || []
  const totalSize = backups.reduce((a, b) => a + (b.size || 0), 0)

  async function handleCreate() {
    setCreating(true)
    try { await createMut.mutateAsync() }
    finally { setCreating(false) }
  }

  return (
    <div className="p-6 space-y-6">
      <BackButton href="/sistema" label="Sistema" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-rose-500 flex items-center justify-center">
            <Archive className="text-white" size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Backups de Base de Datos</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">
              Backups comprimidos (gzip) de MySQL.
              {' '}Retención: {data?.retention_days || 14} días.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()}
            className="flex items-center gap-2 border border-slate-200 text-slate-600 px-3 py-2 rounded-xl text-sm hover:bg-slate-50 transition-colors dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
            <RefreshCw size={14} /> Actualizar
          </button>
          <button onClick={handleCreate} disabled={creating || createMut.isPending}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
            <Plus size={14} /> {creating ? 'Generando...' : 'Backup manual'}
          </button>
          <button onClick={() => purgeMut.mutate()} disabled={purgeMut.isPending}
            className="flex items-center gap-2 border border-rose-200 text-rose-600 px-3 py-2 rounded-xl text-sm hover:bg-rose-50 transition-colors">
            <Trash2 size={14} /> Purgar viejos
          </button>
        </div>
      </div>

      {/* Aviso */}
      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 flex items-start gap-3">
        <AlertTriangle size={20} className="shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold mb-0.5">Backup automático diario</p>
          <p>Por defecto el sistema genera un backup todos los días a las 02:00 AM. Configurable con la variable de entorno <code className="bg-amber-100 px-1.5 rounded text-xs">BACKUP_CRON</code>. Los backups se almacenan en <code className="bg-amber-100 px-1.5 rounded text-xs">api/backups/</code> y se eliminan automáticamente después de la retención.</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <p className="text-xs text-slate-500 uppercase font-medium mb-1 dark:text-white/40">Total backups</p>
          <p className="text-3xl font-bold text-slate-900 dark:text-white">{backups.length}</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <p className="text-xs text-slate-500 uppercase font-medium mb-1 dark:text-white/40">Espacio usado</p>
          <p className="text-3xl font-bold text-slate-900 dark:text-white">{bytesToHuman(totalSize)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <p className="text-xs text-slate-500 uppercase font-medium mb-1 dark:text-white/40">Último backup</p>
          <p className="text-sm font-bold text-slate-900 dark:text-white">
            {backups[0] ? format(new Date(backups[0].created_at), "d 'de' MMM 'a las' HH:mm", { locale: es }) : '—'}
          </p>
        </div>
      </div>

      {/* Off-site config */}
      <OffsiteConfig />

      {/* Lista */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        {isLoading && (
          <div className="text-center py-12 text-slate-400 dark:text-white/30">
            <RefreshCw size={20} className="mx-auto mb-2 animate-spin opacity-40" />
            Cargando backups...
          </div>
        )}
        {!isLoading && backups.length === 0 && (
          <div className="text-center py-12 text-slate-400 dark:text-white/30">
            <HardDrive size={36} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Sin backups disponibles</p>
            <p className="text-xs mt-1">Genera el primero con el botón "Backup manual"</p>
          </div>
        )}
        {!isLoading && backups.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <tr>
                <th className="text-left px-4 py-3 text-slate-500 font-medium text-xs dark:text-white/40">Archivo</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium text-xs dark:text-white/40">Generado</th>
                <th className="text-right px-4 py-3 text-slate-500 font-medium text-xs dark:text-white/40">Tamaño</th>
                <th className="text-right px-4 py-3 text-slate-500 font-medium text-xs w-44 dark:text-white/40">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {backups.map((b: any) => (
                <tr key={b.filename} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                  <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-white/80">{b.filename}</td>
                  <td className="px-4 py-3 text-slate-600 dark:text-white/60">
                    {format(new Date(b.created_at), "d MMM yyyy HH:mm:ss", { locale: es })}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-600 dark:text-white/60">{bytesToHuman(b.size)}</td>
                  <td className="px-4 py-3 text-right">
                    <a href={downloadUrl(`/api/backups/${encodeURIComponent(b.filename)}`)} download
                      className="inline-flex items-center gap-1 text-blue-600 hover:bg-blue-50 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors">
                      <Download size={13} /> Descargar
                    </a>
                    <button onClick={() => deleteBackup(b.filename)}
                      className="inline-flex items-center gap-1 text-rose-600 hover:bg-rose-50 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ml-1">
                      <Trash2 size={13} /> Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
