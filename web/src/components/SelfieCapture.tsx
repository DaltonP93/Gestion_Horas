'use client'
import { useRef, useState, useEffect } from 'react'
import { Camera, RotateCcw, Check, X, AlertCircle } from 'lucide-react'

interface Props {
  onCapture: (dataUrl: string | null) => void
  required?: boolean
  width?: number
  height?: number
}

/**
 * Captura selfie via getUserMedia (cámara frontal del dispositivo).
 * Devuelve PNG dataURL al confirmar.
 */
export default function SelfieCapture({ onCapture, required = false, width = 320, height = 240 }: Props) {
  const videoRef  = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stream, setStream]   = useState<MediaStream | null>(null)
  const [shot, setShot]       = useState<string | null>(null)
  const [error, setError]     = useState<string | null>(null)
  const [active, setActive]   = useState(false)

  async function start() {
    setError(null)
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      setStream(s)
      setActive(true)
      setShot(null)
      onCapture(null)
      if (videoRef.current) {
        videoRef.current.srcObject = s
        await videoRef.current.play()
      }
    } catch (e: any) {
      setError(e?.name === 'NotAllowedError'
        ? 'Permiso de cámara denegado'
        : e?.message || 'No se pudo acceder a la cámara')
    }
  }

  function stop() {
    stream?.getTracks().forEach(t => t.stop())
    setStream(null)
    setActive(false)
  }

  function snap() {
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c) return
    const w = v.videoWidth || 320
    const h = v.videoHeight || 240
    c.width = w; c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) return
    // Voltear horizontal (efecto espejo natural de selfie)
    ctx.save()
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(v, 0, 0, w, h)
    ctx.restore()
    const dataUrl = c.toDataURL('image/jpeg', 0.85)
    setShot(dataUrl)
    onCapture(dataUrl)
    stop()
  }

  function retake() {
    setShot(null)
    onCapture(null)
    start()
  }

  // Cleanup al desmontar
  useEffect(() => () => { stream?.getTracks().forEach(t => t.stop()) }, [stream])

  return (
    <div className="space-y-3">
      <div className="relative rounded-2xl overflow-hidden bg-slate-900 border-2 border-slate-200 dark:border-white/[0.08]"
        style={{ width, height }}>
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-rose-300 text-sm p-4 text-center">
            <div>
              <AlertCircle size={28} className="mx-auto mb-2 opacity-60" />
              <p>{error}</p>
            </div>
          </div>
        )}
        {!active && !shot && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-white/30">
            <div className="text-center">
              <Camera size={36} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm">{required ? 'Selfie requerido' : 'Tomar selfie (opcional)'}</p>
            </div>
          </div>
        )}
        {shot ? (
          <img src={shot} alt="Selfie" className="w-full h-full object-cover" />
        ) : (
          <video ref={videoRef} muted playsInline
            className="w-full h-full object-cover transform scale-x-[-1]"
            style={{ display: active ? 'block' : 'none' }} />
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>

      <div className="flex gap-2">
        {!active && !shot && (
          <button type="button" onClick={start}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
            <Camera size={14} /> Activar cámara
          </button>
        )}
        {active && (
          <>
            <button type="button" onClick={snap}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
              <Check size={14} /> Capturar
            </button>
            <button type="button" onClick={stop}
              className="flex items-center gap-2 border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium transition-colors dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
              <X size={14} /> Cancelar
            </button>
          </>
        )}
        {shot && (
          <button type="button" onClick={retake}
            className="flex items-center gap-2 border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium transition-colors dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
            <RotateCcw size={14} /> Repetir
          </button>
        )}
      </div>
    </div>
  )
}
