'use client'
import { useState, useEffect } from 'react'
import { Webhook, Slack, MessageSquare, TestTube, Save, Check } from 'lucide-react'
import { api } from '@/lib/api'
import BackButton from '@/components/BackButton'

interface WebhookConfig {
  slack_webhook_url: string
  teams_webhook_url: string
  webhook_notify_absences: string
  webhook_notify_late: string
  webhook_notify_device_down: string
  webhook_notify_backup: string
}

const DEFAULTS: WebhookConfig = {
  slack_webhook_url: '',
  teams_webhook_url: '',
  webhook_notify_absences: '1',
  webhook_notify_late: '1',
  webhook_notify_device_down: '1',
  webhook_notify_backup: '0',
}

export default function WebhooksPage() {
  const [cfg, setCfg] = useState<WebhookConfig>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    api.get('/api/settings/webhooks').then(r => {
      setCfg({ ...DEFAULTS, ...r.data })
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true); setError(''); setSaved(false)
    try {
      await api.put('/api/settings/webhooks', cfg)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Error al guardar')
    } finally { setSaving(false) }
  }

  async function test() {
    setTesting(true); setTestMsg('')
    try {
      const r = await api.post('/api/settings/webhooks/test')
      setTestMsg(r.data.message || 'Enviado')
    } catch (e: any) {
      setTestMsg(e?.response?.data?.error || 'Error al enviar test')
    } finally { setTesting(false) }
  }

  const set = (k: keyof WebhookConfig) => (v: string) => setCfg(p => ({ ...p, [k]: v }))
  const toggle = (k: keyof WebhookConfig) => () => setCfg(p => ({ ...p, [k]: p[k] === '1' ? '0' : '1' }))

  if (loading) return <div className="p-6 text-slate-400 text-sm dark:text-white/30">Cargando...</div>

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3">
        <BackButton href="/configuracion" />
        <div className="w-10 h-10 rounded-xl bg-violet-600 flex items-center justify-center">
          <Webhook className="text-white" size={20} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Webhooks — Slack / Teams</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">Notificaciones automáticas en canales de comunicación</p>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>}

      {/* Slack */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Slack size={16} className="text-[#4A154B]" />
          <h2 className="font-semibold text-slate-800 text-sm dark:text-white/90">Slack Incoming Webhook</h2>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block dark:text-white/40">URL del Webhook</label>
          <input type="url" value={cfg.slack_webhook_url} onChange={e => set('slack_webhook_url')(e.target.value)}
            placeholder="https://hooks.slack.com/services/..."
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
          <p className="text-xs text-slate-400 mt-1 dark:text-white/30">
            Crea un Incoming Webhook en <strong>api.slack.com/apps</strong> → tu app → Incoming Webhooks.
          </p>
        </div>
      </div>

      {/* Teams */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <MessageSquare size={16} className="text-[#6264A7]" />
          <h2 className="font-semibold text-slate-800 text-sm dark:text-white/90">Microsoft Teams Webhook</h2>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block dark:text-white/40">URL del Connector</label>
          <input type="url" value={cfg.teams_webhook_url} onChange={e => set('teams_webhook_url')(e.target.value)}
            placeholder="https://xxx.webhook.office.com/webhookb2/..."
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono dark:border-white/[0.08]" />
          <p className="text-xs text-slate-400 mt-1 dark:text-white/30">
            En Teams: canal → … → Connectors → Incoming Webhook → configurar.
          </p>
        </div>
      </div>

      {/* Eventos */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-3 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <h2 className="font-semibold text-slate-800 text-sm mb-1 dark:text-white/90">Eventos a notificar</h2>
        {([
          ['webhook_notify_absences',    'Ausencias del día (cron 10:00 AM)'],
          ['webhook_notify_late',        'Llegadas tarde (cron 9:30 AM)'],
          ['webhook_notify_device_down', 'Reloj biométrico offline'],
          ['webhook_notify_backup',      'Backup completado'],
        ] as [keyof WebhookConfig, string][]).map(([k, label]) => (
          <label key={k} className="flex items-center gap-3 cursor-pointer select-none">
            <button type="button" onClick={toggle(k)}
              className={`w-10 h-6 rounded-full transition-colors flex items-center px-0.5 ${cfg[k] === '1' ? 'bg-blue-600 justify-end' : 'bg-slate-200 justify-start'}`}>
              <span className="w-5 h-5 bg-white rounded-full shadow block dark:bg-white/[0.04]" />
            </button>
            <span className="text-sm text-slate-700 dark:text-white/80">{label}</span>
          </label>
        ))}
      </div>

      {/* Acciones */}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving}
          className="flex-1 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-60 flex items-center justify-center gap-2">
          {saved ? <Check size={14} /> : <Save size={14} />}
          {saved ? 'Guardado' : saving ? 'Guardando...' : 'Guardar configuración'}
        </button>
        <button onClick={test} disabled={testing || (!cfg.slack_webhook_url && !cfg.teams_webhook_url)}
          className="px-5 bg-slate-100 text-slate-700 rounded-xl py-2.5 text-sm font-medium hover:bg-slate-200 disabled:opacity-40 flex items-center gap-2 dark:bg-white/[0.06] dark:text-white/80">
          <TestTube size={14} />
          Probar
        </button>
      </div>

      {testMsg && (
        <div className={`text-sm rounded-xl px-4 py-3 ${testMsg.includes('Error') || testMsg.includes('error') ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
          {testMsg}
        </div>
      )}
    </div>
  )
}
