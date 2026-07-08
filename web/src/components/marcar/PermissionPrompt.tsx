'use client'
import { MapPin, Camera, AlertCircle, ExternalLink } from 'lucide-react'

interface Props {
  type: 'gps' | 'camera'
  state: 'denied' | 'prompt' | 'unsupported'
  onRequest?: () => void
  loading?: boolean
}

/**
 * Tarjeta CTA cuando un permiso está denegado, pendiente, o no soportado.
 * - 'denied'     → instrucciones específicas por navegador
 * - 'prompt'     → botón "Activar GPS/Cámara" (dispara el flujo nativo)
 * - 'unsupported'→ aviso (solo Safari iOS para cámara)
 */
export default function PermissionPrompt({ type, state, onRequest, loading }: Props) {
  const Icon = type === 'gps' ? MapPin : Camera
  const labelGrant = type === 'gps' ? 'Activar GPS' : 'Activar cámara'
  const labelTopic = type === 'gps' ? 'ubicación'   : 'cámara'

  if (state === 'unsupported') {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 flex items-start gap-3 dark:bg-white/[0.03] dark:border-white/[0.08]">
        <AlertCircle className="text-slate-500 shrink-0 mt-0.5 dark:text-white/40" size={18} />
        <div className="text-sm text-slate-700 dark:text-white/80">
          <p className="font-semibold mb-0.5">{type === 'gps' ? 'GPS no disponible' : 'Cámara no disponible'}</p>
          <p className="text-xs text-slate-600 dark:text-white/60">
            Tu navegador no soporta este permiso. Probá con Chrome (Android) o Safari (iOS).
          </p>
        </div>
      </div>
    )
  }

  if (state === 'denied') {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4 space-y-2">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-red-600 shrink-0 mt-0.5" size={18} />
          <div className="text-sm text-red-900">
            <p className="font-semibold mb-1">Permiso de {labelTopic} bloqueado</p>
            <p className="text-xs leading-relaxed">
              Para reactivarlo:
            </p>
          </div>
        </div>
        <ul className="text-xs text-red-900 list-disc pl-9 space-y-1">
          <li>
            <strong>iOS Safari:</strong> Ajustes → Safari → {type === 'gps' ? 'Ubicación' : 'Cámara'} → Permitir
          </li>
          <li>
            <strong>Android Chrome:</strong> tocá el candado en la barra de URL → Permisos → {labelTopic}
          </li>
        </ul>
        <a href="javascript:location.reload()"
          className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-900 mt-1">
          <ExternalLink size={12} /> Recargar la página después de cambiar
        </a>
      </div>
    )
  }

  // state === 'prompt'
  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 flex items-center gap-3">
      <Icon className="text-blue-600 shrink-0" size={20} />
      <div className="flex-1 text-sm text-blue-900">
        <p className="font-semibold mb-0.5">Permiso de {labelTopic} requerido</p>
        <p className="text-xs">Para marcar asistencia, primero activá el permiso.</p>
      </div>
      {onRequest && (
        <button onClick={onRequest} disabled={loading}
          className="px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold disabled:opacity-50">
          {loading ? '...' : labelGrant}
        </button>
      )}
    </div>
  )
}
