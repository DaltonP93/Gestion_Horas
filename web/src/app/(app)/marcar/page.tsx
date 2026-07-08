'use client'
/**
 * /marcar — Pantalla de marcación mobile-first.
 *
 * Flujo principal:
 *   1. Mostrar estado de conexión / GPS / cámara (StatusChips, reactivo).
 *   2. Mostrar PermissionPrompt si GPS o cámara están denegados/pendientes.
 *   3. Botones grandes ENTRADA / SALIDA (PunchButtons).
 *   4. Al pulsar un botón:
 *      a. getCurrentPosition() — falla → mensaje claro
 *      b. Abrir SelfieModal (full-screen) → tomar foto, repetir si quiere, confirmar
 *      c. POST /api/self-checkin/mark con { type, lat, lng, selfie }
 *      d. Toast verde + actualización de "última marca"
 *   5. Sección colapsable: QR (cámara trasera + token manual)
 *   6. Sección colapsable: Face ID (verificación opcional, no bloquea)
 *
 * Offline: si la red falla, encolar el marcaje (con o sin selfie) y mostrarlo.
 */
import { useEffect, useState } from 'react'
import {
  CheckCircle2, AlertCircle, RefreshCw, ScanFace, Loader2,
  ChevronDown, MapPin, Building2, QrCode, Scan,
} from 'lucide-react'
import { api } from '@/lib/api'
import QrScanner from '@/components/QrScanner'
import StatusChips from '@/components/marcar/StatusChips'
import PunchButtons from '@/components/marcar/PunchButtons'
import SelfieModal from '@/components/marcar/SelfieModal'
import PermissionPrompt from '@/components/marcar/PermissionPrompt'
import { enqueue, listPending, flush, setupAutoRetry, type PendingPunch } from '@/lib/offlineQueue'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { useGeolocation } from '@/lib/hooks/useGeolocation'
import { usePermissionStatus } from '@/lib/hooks/usePermissionStatus'
import { useNetworkStatus } from '@/lib/hooks/useNetworkStatus'
import { GeoError } from '@/lib/native/geolocation'

// Face-api lazy loader (sección opcional, no bloquea)
const FACE_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js'
const FACE_MODELS_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model'
let faceApiLoading: Promise<any> | null = null
async function loadFaceApi(): Promise<any> {
  if ((window as any).faceapi?.nets) return (window as any).faceapi
  if (faceApiLoading) return faceApiLoading
  faceApiLoading = (async () => {
    if (!(window as any).faceapi) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.src = FACE_CDN
        s.crossOrigin = 'anonymous'
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('No se pudo cargar face-api.js'))
        document.head.appendChild(s)
      })
    }
    const fa = (window as any).faceapi
    await Promise.all([
      fa.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL),
      fa.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL),
      fa.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODELS_URL),
    ])
    return fa
  })()
  return faceApiLoading
}

interface PendingPunchData {
  type:   'in' | 'out'
  lat:    number
  lng:    number
}

export default function MarcarPage() {
  const user = useCurrentUser()
  const online = useNetworkStatus()
  const gpsState    = usePermissionStatus('geolocation')
  const cameraState = usePermissionStatus('camera')
  const geo = useGeolocation()

  const [loading, setLoading] = useState(false)
  const [msg,     setMsg]     = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [pending, setPending] = useState<PendingPunch[]>([])

  // Selfie modal
  const [selfieFor, setSelfieFor] = useState<PendingPunchData | null>(null)

  // QR scanner panel
  const [showQrPanel, setShowQrPanel] = useState(false)
  const [showQrScanner, setShowQrScanner] = useState(false)
  const [qrToken, setQrToken] = useState('')

  // Face ID panel
  const [showFacePanel, setShowFacePanel] = useState(false)

  // Offline queue init
  useEffect(() => {
    setPending(listPending())
    setupAutoRetry()
    const onFlushed = () => setPending(listPending())
    window.addEventListener('sishoras:queue-flushed', onFlushed as any)
    return () => {
      window.removeEventListener('sishoras:queue-flushed', onFlushed as any)
    }
  }, [])

  async function flushQueue() {
    setLoading(true)
    const r = await flush()
    setPending(listPending())
    setLoading(false)
    setMsg({
      type: r.failed > 0 ? 'err' : 'ok',
      text: `Cola sincronizada: ${r.sent} enviado(s), ${r.failed} fallido(s)`,
    })
  }

  // ─── Flujo principal de marcaje ────────────────────────────────
  async function startPunch(type: 'in' | 'out') {
    setMsg(null)

    // 1. Si el permiso está claramente denegado, mostrar prompt
    if (gpsState === 'denied') {
      setMsg({ type: 'err', text: 'Permiso de ubicación bloqueado. Activalo desde los ajustes del navegador.' })
      return
    }

    // 2. Pedir posición (esto dispara el prompt nativo si state==='prompt')
    setLoading(true)
    let coords
    try {
      coords = await geo.request()
    } catch (e) {
      setLoading(false)
      const err = e as GeoError
      if (err.code === 'PERMISSION_DENIED') {
        setMsg({ type: 'err', text: 'Permiso de ubicación denegado. No se puede marcar sin GPS.' })
      } else if (err.code === 'TIMEOUT') {
        setMsg({ type: 'err', text: 'Tiempo de espera agotado. Asegurate de tener buena señal GPS.' })
      } else if (err.code === 'POSITION_UNAVAILABLE') {
        setMsg({ type: 'err', text: 'No se pudo obtener tu ubicación. Verificá el GPS y la señal.' })
      } else {
        setMsg({ type: 'err', text: err.message || 'Error al obtener ubicación' })
      }
      return
    }
    setLoading(false)

    // 3. Abrir modal selfie
    setSelfieFor({ type, lat: coords.latitude, lng: coords.longitude })
  }

  async function handleSelfieConfirm(dataUrl: string) {
    if (!selfieFor) return
    const { type, lat, lng } = selfieFor
    setSelfieFor(null)
    setLoading(true); setMsg(null)
    try {
      const res = await api.post('/api/self-checkin/mark', { type, lat, lng, selfie: dataUrl })
      setMsg({
        type: 'ok',
        text: `${type === 'in' ? 'Entrada' : 'Salida'} registrada vía ${res.data.source}`,
      })
    } catch (netErr: any) {
      // Sin conexión — encolar
      if (!netErr?.response) {
        enqueue({ type, lat, lng, selfie: dataUrl })
        setPending(listPending())
        setMsg({ type: 'ok', text: 'Sin conexión — marcaje guardado, se enviará al volver online' })
      } else {
        setMsg({ type: 'err', text: netErr.response?.data?.error || 'Error al marcar' })
      }
    } finally { setLoading(false) }
  }

  async function markByQr(type: 'in' | 'out') {
    if (!qrToken.trim()) {
      setMsg({ type: 'err', text: 'Escaneá o pegá el código QR primero' })
      return
    }
    setLoading(true); setMsg(null)
    try {
      const body: any = { type, token: qrToken.trim() }
      if (geo.coords) {
        body.lat = geo.coords.latitude
        body.lng = geo.coords.longitude
      }
      const res = await api.post('/api/self-checkin/mark', body)
      setMsg({ type: 'ok', text: `${type === 'in' ? 'Entrada' : 'Salida'} registrada vía ${res.data.source}` })
      setQrToken('')
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.response?.data?.error || 'Error al marcar' })
    } finally { setLoading(false) }
  }

  // Disabled state — botones deshabilitados si no hay conexión Y no podemos encolar (encolamos siempre)
  // o si GPS está denied/unsupported
  const punchDisabled = gpsState === 'denied' || gpsState === 'unsupported'
  const punchDisabledReason =
    gpsState === 'denied'      ? 'Activá el permiso de ubicación para marcar'
    : gpsState === 'unsupported' ? 'Tu navegador no soporta GPS'
    : undefined

  return (
    <>
      <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-4">

        {/* ── Header ──────────────────────────────────────────── */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Marcar asistencia</h1>
          <p className="text-sm text-slate-500 dark:text-white/40">
            {user?.fullName ? `Hola, ${user.fullName.split(' ')[0]}.` : ''} Tu marcaje requiere GPS y selfie.
          </p>
        </div>

        {/* ── Status chips ────────────────────────────────────── */}
        <StatusChips online={online} gps={gpsState} camera={cameraState} />

        {/* ── Pending offline queue ───────────────────────────── */}
        {pending.length > 0 && (
          <button onClick={flushQueue}
            className="w-full flex items-center justify-center gap-2 text-sm text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl px-3 py-2 font-medium">
            <RefreshCw size={14} /> {pending.length} marcaje{pending.length !== 1 ? 's' : ''} pendiente{pending.length !== 1 ? 's' : ''} de sincronizar — sincronizar ahora
          </button>
        )}

        {/* ── Mensaje de resultado ────────────────────────────── */}
        {msg && (
          <div role={msg.type === 'err' ? 'alert' : 'status'}
            className={`rounded-xl px-4 py-3 text-sm flex items-start gap-2
              ${msg.type === 'ok'
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-red-50 border border-red-200 text-red-800'}`}>
            {msg.type === 'ok' ? <CheckCircle2 size={18} className="shrink-0 mt-0.5" /> : <AlertCircle size={18} className="shrink-0 mt-0.5" />}
            <span>{msg.text}</span>
          </div>
        )}

        {/* ── Permission prompts (solo si denied/unsupported) ─── */}
        {(gpsState === 'denied' || gpsState === 'unsupported') && (
          <PermissionPrompt type="gps" state={gpsState} />
        )}
        {(cameraState === 'denied' || cameraState === 'unsupported') && (
          <PermissionPrompt type="camera" state={cameraState} />
        )}

        {/* ── Botones principales ─────────────────────────────── */}
        <PunchButtons
          onPunch={startPunch}
          loading={loading && !selfieFor}
          disabled={punchDisabled}
          disabledReason={punchDisabledReason}
        />

        {/* ── Última posición + sede ──────────────────────────── */}
        {geo.coords && (
          <div className="rounded-2xl border border-slate-100 bg-white p-4 text-xs text-slate-600 space-y-1.5 dark:bg-white/[0.04] dark:text-white/60 dark:border-white/[0.06]">
            <div className="flex items-center gap-2">
              <MapPin size={14} className="text-blue-600" />
              <span className="font-medium text-slate-700 dark:text-white/80">Última ubicación detectada:</span>
              <span className="font-mono">
                {geo.coords.latitude.toFixed(5)}, {geo.coords.longitude.toFixed(5)} (±{Math.round(geo.coords.accuracy)}m)
              </span>
            </div>
            {user?.fullName && (
              <div className="flex items-center gap-2">
                <Building2 size={14} className="text-slate-400 dark:text-white/30" />
                <span className="text-slate-500 dark:text-white/40">El servidor valida que estés dentro del radio de tu sede.</span>
              </div>
            )}
          </div>
        )}

        {/* ── Sección colapsable: QR ──────────────────────────── */}
        <Collapsible
          icon={<QrCode size={18} className="text-indigo-600" />}
          title="Marcar por código QR"
          subtitle="Para sedes con QR fijo o rotativo de 5 min"
          open={showQrPanel}
          onToggle={() => setShowQrPanel(v => !v)}>
          <div className="space-y-3">
            {showQrScanner ? (
              <QrScanner onScan={t => { setQrToken(t); setShowQrScanner(false) }}
                onClose={() => setShowQrScanner(false)} />
            ) : (
              <button
                onClick={() => {
                  if (cameraState === 'denied') {
                    setMsg({ type: 'err', text: 'Cámara bloqueada. Activala desde los ajustes del navegador.' })
                    return
                  }
                  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
                    setMsg({ type: 'err', text: 'El escáner QR requiere HTTPS' })
                    return
                  }
                  setShowQrScanner(true)
                }}
                className="w-full flex items-center justify-center gap-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-xl px-3 py-2.5 text-sm font-medium">
                <Scan size={16} /> Escanear con la cámara
              </button>
            )}

            <input
              value={qrToken}
              onChange={e => setQrToken(e.target.value)}
              placeholder="…o pegá el token del QR aquí"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono dark:border-white/[0.08]" />

            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => markByQr('in')} disabled={loading || !qrToken.trim()}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded-xl py-2.5 text-sm font-semibold disabled:cursor-not-allowed">
                Entrada
              </button>
              <button onClick={() => markByQr('out')} disabled={loading || !qrToken.trim()}
                className="bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white rounded-xl py-2.5 text-sm font-semibold disabled:cursor-not-allowed">
                Salida
              </button>
            </div>
          </div>
        </Collapsible>

        {/* ── Sección colapsable: Face ID (opcional) ───────────── */}
        <Collapsible
          icon={<ScanFace size={18} className="text-purple-600" />}
          title="Verificación facial (opcional)"
          subtitle="Compara tu rostro contra el descriptor registrado por RRHH"
          open={showFacePanel}
          onToggle={() => setShowFacePanel(v => !v)}>
          <FaceVerificationSection />
        </Collapsible>
      </div>

      {/* ── Modal selfie en cascada ─────────────────────────── */}
      <SelfieModal
        open={!!selfieFor}
        punchType={selfieFor?.type || 'in'}
        onCancel={() => { setSelfieFor(null); setLoading(false) }}
        onConfirm={handleSelfieConfirm}
      />
    </>
  )
}

// ─── Sección de Face ID ─────────────────────────────────────────
function FaceVerificationSection() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ matched: boolean; distance: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function scan() {
    setLoading(true); setError(null); setResult(null)
    try {
      const fa = await loadFaceApi()
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' } } })
      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      video.playsInline = true
      await video.play()
      // Detectar
      const det = await fa.detectSingleFace(video, new fa.TinyFaceDetectorOptions())
        .withFaceLandmarks(true)
        .withFaceDescriptor()
      stream.getTracks().forEach(t => t.stop())
      if (!det) { setError('No se detectó rostro. Asegurate de tener buena iluminación.'); setLoading(false); return }
      const res = await api.post('/api/face/verify', { descriptor: Array.from(det.descriptor) })
      setResult(res.data)
    } catch (e: any) {
      setError(e?.message || 'Error al verificar rostro')
    } finally { setLoading(false) }
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-500 dark:text-white/40">
        Esta verificación es opcional y no reemplaza la selfie del marcaje.
        Solo confirma que sos la misma persona que se registró.
      </p>
      <button onClick={scan} disabled={loading}
        className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 text-white rounded-xl py-2.5 font-semibold flex items-center justify-center gap-2">
        {loading ? <Loader2 className="animate-spin" size={18} /> : <ScanFace size={18} />}
        {loading ? 'Verificando…' : 'Escanear mi rostro'}
      </button>
      {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
      {result && (
        <div className={`text-xs rounded-lg px-3 py-2 border ${
          result.matched
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-amber-50 border-amber-200 text-amber-800'
        }`}>
          {result.matched
            ? `✅ Rostro coincide (distancia ${result.distance.toFixed(2)})`
            : `⚠️ No coincide con el registro (distancia ${result.distance.toFixed(2)})`}
        </div>
      )}
    </div>
  )
}

// ─── Sección colapsable genérica ────────────────────────────────
function Collapsible({
  icon, title, subtitle, open, onToggle, children,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
      <button onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors dark:hover:bg-white/[0.04]">
        {icon}
        <div className="flex-1 text-left">
          <p className="font-semibold text-sm text-slate-900 dark:text-white">{title}</p>
          <p className="text-xs text-slate-500 dark:text-white/40">{subtitle}</p>
        </div>
        <ChevronDown size={18} className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-slate-100 dark:border-white/[0.06]">
          {children}
        </div>
      )}
    </div>
  )
}
