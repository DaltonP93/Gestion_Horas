'use client'
/**
 * FaceEnroll — Enrola/verifica la foto facial de un empleado usando face-api.js.
 *
 * Carga los modelos TinyFaceDetector + FaceRecognitionNet desde CDN de jsdelivr.
 * El descriptor 128-d se calcula en el browser y se envía a la API.
 */
import { useRef, useState, useEffect, useCallback } from 'react'
import { Camera, CheckCircle, XCircle, Loader2, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'

declare global {
  interface Window { faceapi: any }
}

const CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/dist'
const MODELS_URL = `${CDN}/models`
const SCRIPT_URL  = `${CDN}/face-api.esm.js`

interface Props {
  employeeId: number | string
  onEnrolled?: () => void
  readOnly?: boolean
}

type Status = 'idle' | 'loading_models' | 'ready' | 'capturing' | 'processing' | 'ok' | 'error'

export default function FaceEnroll({ employeeId, onEnrolled, readOnly = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [status, setStatus] = useState<Status>('idle')
  const [msg, setMsg] = useState('')
  const [enrolled, setEnrolled] = useState<{ photo_url: string | null; at: string | null } | null>(null)
  const [modelsReady, setModelsReady] = useState(false)

  // Cargar info de enrolamiento existente
  useEffect(() => {
    api.get(`/api/face/${employeeId}/descriptor`).then(r => {
      if (r.data.has_face) {
        setEnrolled({ photo_url: r.data.face_photo_url, at: r.data.face_enrolled_at })
      }
    }).catch(() => {})
  }, [employeeId])

  // Cargar face-api.js desde CDN (dinámico)
  const loadModels = useCallback(async () => {
    setStatus('loading_models')
    setMsg('Cargando modelos de reconocimiento facial...')
    try {
      if (!window.faceapi) {
        await new Promise<void>((res, rej) => {
          const s = document.createElement('script')
          s.type = 'module'
          // Necesitamos importar y exponer en window
          s.textContent = `
            import * as faceapi from '${SCRIPT_URL}';
            window.faceapi = faceapi;
            window.dispatchEvent(new Event('faceapi_ready'));
          `
          document.head.appendChild(s)
          window.addEventListener('faceapi_ready', () => res(), { once: true })
          setTimeout(() => rej(new Error('Timeout cargando face-api.js')), 20000)
        })
      }
      const fa = window.faceapi
      await Promise.all([
        fa.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
        fa.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
        fa.nets.faceLandmark68TinyNet.loadFromUri(MODELS_URL),
      ])
      setModelsReady(true)
      setStatus('ready')
      setMsg('Modelos cargados. Listo para capturar.')
    } catch (e: any) {
      setStatus('error')
      setMsg('No se pudieron cargar los modelos: ' + e.message)
    }
  }, [])

  const startCamera = useCallback(async () => {
    if (!modelsReady) { await loadModels(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } })
      streamRef.current = stream
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play() }
      setStatus('capturing')
      setMsg('Posicioná tu cara frente a la cámara y presioná Capturar.')
    } catch {
      setStatus('error')
      setMsg('No se pudo acceder a la cámara.')
    }
  }, [modelsReady, loadModels])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  const capture = useCallback(async () => {
    const video  = videoRef.current
    const canvas = canvasRef.current
    const fa     = window.faceapi
    if (!video || !canvas || !fa) return

    setStatus('processing')
    setMsg('Detectando rostro...')

    canvas.width  = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)

    try {
      const opts = new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
      const det  = await fa.detectSingleFace(canvas, opts).withFaceLandmarks(true).withFaceDescriptor()
      if (!det) {
        setStatus('capturing')
        setMsg('No se detectó ningún rostro. Intentá de nuevo.')
        return
      }
      const descriptor = Array.from(det.descriptor) as number[]
      const photoUrl   = canvas.toDataURL('image/jpeg', 0.8)

      // Upload photo to server
      const blob = await (await fetch(photoUrl)).blob()
      const fd   = new FormData()
      fd.append('photo', blob, `face_${employeeId}.jpg`)
      const uploadRes = await api.post(`/api/employees/${employeeId}/photo`, fd).catch(() => null)
      const savedUrl  = uploadRes?.data?.url || null

      await api.put(`/api/face/${employeeId}/enroll`, { face_descriptor: descriptor, face_photo_url: savedUrl })

      stopCamera()
      setEnrolled({ photo_url: savedUrl || photoUrl, at: new Date().toISOString() })
      setStatus('ok')
      setMsg('Rostro enrolado correctamente.')
      onEnrolled?.()
    } catch (e: any) {
      setStatus('error')
      setMsg('Error procesando imagen: ' + e.message)
    }
  }, [employeeId, stopCamera, onEnrolled])

  const deleteEnroll = useCallback(async () => {
    if (!confirm('¿Eliminar el descriptor facial de este empleado?')) return
    await api.delete(`/api/face/${employeeId}/enroll`)
    setEnrolled(null)
    setStatus('idle')
    setMsg('')
  }, [employeeId])

  // Cleanup on unmount
  useEffect(() => () => stopCamera(), [stopCamera])

  return (
    <div className="border border-slate-200 rounded-2xl p-4 space-y-3 bg-white dark:bg-white/[0.04] dark:border-white/[0.08]">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-slate-700 flex items-center gap-2 dark:text-white/80">
          <Camera size={15} className="text-blue-500" />
          Reconocimiento Facial
        </h3>
        {enrolled && !readOnly && (
          <button onClick={deleteEnroll} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1">
            <Trash2 size={12} /> Eliminar
          </button>
        )}
      </div>

      {/* Estado enrolado */}
      {enrolled && (
        <div className="flex items-center gap-3 text-sm text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2">
          <CheckCircle size={16} />
          <span>Rostro registrado — {enrolled.at ? new Date(enrolled.at).toLocaleDateString('es') : ''}</span>
          {enrolled.photo_url && (
            <img src={enrolled.photo_url} alt="face" className="w-10 h-10 rounded-full object-cover ml-auto" />
          )}
        </div>
      )}

      {/* Cámara */}
      {status === 'capturing' && (
        <div className="relative">
          <video ref={videoRef} className="w-full rounded-xl bg-black" style={{ maxHeight: 240 }} autoPlay muted playsInline />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="border-2 border-blue-400 rounded-full w-40 h-40 opacity-60" />
          </div>
        </div>
      )}
      <canvas ref={canvasRef} className="hidden" />

      {/* Mensaje */}
      {msg && (
        <p className={`text-xs ${status === 'error' ? 'text-red-600' : 'text-slate-500'}`}>{msg}</p>
      )}

      {/* Botones */}
      {!readOnly && (
        <div className="flex gap-2">
          {(status === 'idle' || status === 'ok' || status === 'error') && (
            <button onClick={status === 'idle' && !modelsReady ? loadModels : startCamera}
              className="flex-1 bg-blue-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2">
              <Camera size={14} />
              {enrolled ? 'Re-enrolar' : 'Enrolar rostro'}
            </button>
          )}
          {status === 'loading_models' && (
            <div className="flex-1 flex items-center justify-center gap-2 text-slate-500 text-sm dark:text-white/40">
              <Loader2 size={14} className="animate-spin" /> Cargando modelos...
            </div>
          )}
          {status === 'capturing' && (
            <>
              <button onClick={capture}
                className="flex-1 bg-emerald-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-emerald-700 transition-colors">
                Capturar
              </button>
              <button onClick={() => { stopCamera(); setStatus('idle'); setMsg('') }}
                className="px-4 text-slate-500 hover:text-slate-700 border border-slate-200 rounded-xl text-sm dark:text-white/40 dark:border-white/[0.08]">
                Cancelar
              </button>
            </>
          )}
          {status === 'processing' && (
            <div className="flex-1 flex items-center justify-center gap-2 text-slate-500 text-sm dark:text-white/40">
              <Loader2 size={14} className="animate-spin" /> Procesando...
            </div>
          )}
        </div>
      )}
    </div>
  )
}
