'use client'
/**
 * FaceEnroll — enrola la foto facial de un empleado.
 *
 * El descriptor de 128 dimensiones se calcula en el navegador y se envía a la
 * API. No se guarda en localStorage ni se escribe en consola: es un dato
 * biométrico, y un log de sesión no es lugar para eso.
 *
 * La biblioteca y los modelos vienen de `@/lib/faceApi`, que los sirve desde
 * la propia aplicación en lugar de un CDN externo (ver el comentario de ese
 * módulo para el porqué).
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import { Camera, CheckCircle, Loader2, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { loadFaceModels, faceLoadErrorMessage, cameraErrorMessage, type FaceApi } from '@/lib/faceApi'

interface Props {
  employeeId: number | string
  onEnrolled?: () => void
  readOnly?: boolean
}

type Status =
  | 'idle'
  | 'loading_library'
  | 'loading_models'
  | 'models_ready'
  | 'requesting_camera'
  | 'capturing'
  | 'processing'
  | 'ok'
  | 'error'

const STATUS_TEXT: Partial<Record<Status, string>> = {
  loading_library:   'Cargando el motor de reconocimiento…',
  loading_models:    'Descargando modelos…',
  models_ready:      'Modelos listos.',
  requesting_camera: 'Solicitando acceso a la cámara…',
  processing:        'Procesando la imagen…',
}

export default function FaceEnroll({ employeeId, onEnrolled, readOnly = false }: Props) {
  const videoRef  = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const faRef     = useRef<FaceApi | null>(null)
  // Evita que dos clics rápidos arranquen dos flujos en paralelo.
  const busyRef   = useRef(false)

  const [status, setStatus] = useState<Status>('idle')
  const [msg, setMsg] = useState('')
  const [enrolled, setEnrolled] = useState<{ photo_url: string | null; at: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get(`/api/face/${employeeId}/descriptor`).then(r => {
      if (cancelled) return
      if (r.data.has_face) {
        setEnrolled({ photo_url: r.data.face_photo_url, at: r.data.face_enrolled_at })
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [employeeId])

  /** Suelta la cámara. Idempotente: se llama desde todos los caminos de salida. */
  const stopCamera = useCallback(() => {
    const stream = streamRef.current
    if (stream) {
      stream.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    const video = videoRef.current
    if (video) {
      video.pause?.()
      video.srcObject = null
    }
  }, [])

  // La cámara se libera también si el componente desaparece con la vista abierta.
  useEffect(() => stopCamera, [stopCamera])

  const start = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setMsg('')

    try {
      // 1) Biblioteca y modelos. La promesa está cacheada: repetir el clic
      //    no vuelve a descargar nada.
      if (!faRef.current) {
        setStatus('loading_library')
        faRef.current = await loadFaceModels(stage => {
          setStatus(stage === 'library' ? 'loading_library' : 'loading_models')
        })
        setStatus('models_ready')
      }

      // 2) Cámara.
      setStatus('requesting_camera')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 320, height: 240 },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play?.()
      }
      setStatus('capturing')
      setMsg('Posicioná el rostro frente a la cámara y presioná Capturar.')
    } catch (err) {
      // Si falló después de abrir la cámara, no queda encendida.
      stopCamera()
      setStatus('error')
      setMsg(faRef.current ? cameraErrorMessage(err) : faceLoadErrorMessage(err))
    } finally {
      busyRef.current = false
    }
  }, [stopCamera])

  const cancel = useCallback(() => {
    stopCamera()
    setStatus('idle')
    setMsg('')
  }, [stopCamera])

  const capture = useCallback(async () => {
    if (busyRef.current) return
    const video  = videoRef.current
    const canvas = canvasRef.current
    const fa     = faRef.current
    if (!video || !canvas || !fa) return

    busyRef.current = true
    setStatus('processing')
    setMsg(STATUS_TEXT.processing || '')

    try {
      canvas.width  = video.videoWidth || 320
      canvas.height = video.videoHeight || 240
      canvas.getContext('2d')?.drawImage(video, 0, 0)

      const opts = new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
      const det = await fa.detectSingleFace(canvas, opts).withFaceLandmarks(true).withFaceDescriptor()
      if (!det) {
        setStatus('capturing')
        setMsg('No se detectó ningún rostro. Acercate y volvé a intentar.')
        return
      }

      const descriptor = Array.from(det.descriptor)
      const photoUrl   = canvas.toDataURL('image/jpeg', 0.8)

      const blob = await (await fetch(photoUrl)).blob()
      const fd   = new FormData()
      fd.append('photo', blob, `face_${employeeId}.jpg`)
      const uploadRes = await api.post(`/api/employees/${employeeId}/photo`, fd).catch(() => null)
      const savedUrl  = uploadRes?.data?.url || null

      await api.put(`/api/face/${employeeId}/enroll`, {
        face_descriptor: descriptor,
        face_photo_url: savedUrl,
      })

      // La cámara se apaga apenas deja de hacer falta, no al desmontar.
      stopCamera()
      setEnrolled({ photo_url: savedUrl || photoUrl, at: new Date().toISOString() })
      setStatus('ok')
      setMsg('Rostro enrolado correctamente.')
      onEnrolled?.()
    } catch {
      // El error no se registra: podría arrastrar el descriptor o la imagen.
      stopCamera()
      setStatus('error')
      setMsg('No se pudo completar el enrolamiento. Intentá de nuevo.')
    } finally {
      busyRef.current = false
    }
  }, [employeeId, stopCamera, onEnrolled])

  const deleteEnroll = useCallback(async () => {
    if (!confirm('¿Eliminar el descriptor facial de este empleado?')) return
    try {
      await api.delete(`/api/face/${employeeId}/enroll`)
      setEnrolled(null)
      setStatus('idle')
      setMsg('')
    } catch {
      setStatus('error')
      setMsg('No se pudo eliminar el registro facial.')
    }
  }, [employeeId])

  const loading = status === 'loading_library' || status === 'loading_models' || status === 'requesting_camera'
  const canStart = status === 'idle' || status === 'ok' || status === 'error' || status === 'models_ready'

  return (
    <div className="min-w-0 border border-slate-200 rounded-2xl p-4 space-y-3 bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-sm text-slate-700 flex items-center gap-2 dark:text-white/80">
          <Camera size={15} className="text-blue-500" />
          Reconocimiento facial
        </h3>
        {enrolled && !readOnly && (
          <button onClick={deleteEnroll} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1">
            <Trash2 size={12} /> Eliminar
          </button>
        )}
      </div>

      {enrolled && (
        <div className="flex min-w-0 items-center gap-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          <CheckCircle size={16} className="shrink-0" />
          <span className="min-w-0 truncate">
            Rostro registrado {enrolled.at ? `— ${new Date(enrolled.at).toLocaleDateString('es')}` : ''}
          </span>
          {enrolled.photo_url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={enrolled.photo_url} alt="Rostro registrado" className="ml-auto h-10 w-10 shrink-0 rounded-full object-cover" />
          )}
        </div>
      )}

      {status === 'capturing' && (
        <div className="relative min-w-0">
          <video ref={videoRef} className="w-full rounded-xl bg-black" style={{ maxHeight: 240 }} autoPlay muted playsInline />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-40 w-40 rounded-full border-2 border-blue-400 opacity-60" />
          </div>
        </div>
      )}
      <canvas ref={canvasRef} className="hidden" />

      {(msg || STATUS_TEXT[status]) && (
        <p
          role={status === 'error' ? 'alert' : 'status'}
          className={`text-xs ${status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-white/40'}`}
        >
          {msg || STATUS_TEXT[status]}
        </p>
      )}

      {!readOnly && (
        <div className="flex gap-2">
          {canStart && (
            <button onClick={start}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-blue-600 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700">
              <Camera size={14} />
              {enrolled ? 'Re-enrolar' : 'Enrolar rostro'}
            </button>
          )}
          {loading && (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500 dark:text-white/40">
              <Loader2 size={14} className="animate-spin" /> {STATUS_TEXT[status]}
            </div>
          )}
          {status === 'capturing' && (
            <>
              <button onClick={capture}
                className="flex-1 rounded-xl bg-emerald-600 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700">
                Capturar
              </button>
              <button onClick={cancel}
                className="rounded-xl border border-slate-200 px-4 text-sm text-slate-500 hover:text-slate-700 dark:border-white/[0.08] dark:text-white/40">
                Cancelar
              </button>
            </>
          )}
          {status === 'processing' && (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-slate-500 dark:text-white/40">
              <Loader2 size={14} className="animate-spin" /> Procesando…
            </div>
          )}
        </div>
      )}
    </div>
  )
}
