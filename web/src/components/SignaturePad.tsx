'use client'
import { useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { PenLine, Eraser, Save, Trash2 } from 'lucide-react'

export interface SignaturePadHandle {
  clear: () => void
  isEmpty: () => boolean
  toDataUrl: () => string | null
}

interface Props {
  width?: number
  height?: number
  penColor?: string
  bgColor?: string
  onChange?: (dataUrl: string | null) => void
  className?: string
}

/**
 * Pad de firma manuscrita con HTML5 canvas.
 * Soporta mouse y touch (móviles/tablets). Devuelve PNG dataUrl.
 */
const SignaturePad = forwardRef<SignaturePadHandle, Props>(function SignaturePad(
  { width = 500, height = 180, penColor = '#1e293b', bgColor = '#fff', onChange, className = '' },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const empty = useRef(true)
  const [, force] = useState(0)

  // Inicializar y limpiar canvas
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width  = width * dpr
    c.height = height * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.fillStyle = bgColor
    ctx.fillRect(0, 0, width, height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = penColor
    ctx.lineWidth = 2.2
  }, [width, height, penColor, bgColor])

  function pos(e: React.MouseEvent | React.TouchEvent): { x: number; y: number } {
    const c = canvasRef.current!
    const rect = c.getBoundingClientRect()
    const ev: any = 'touches' in e ? e.touches[0] : e
    return {
      x: (ev.clientX - rect.left) * (width / rect.width),
      y: (ev.clientY - rect.top)  * (height / rect.height),
    }
  }

  function down(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault()
    drawing.current = true
    last.current = pos(e)
  }

  function move(e: React.MouseEvent | React.TouchEvent) {
    if (!drawing.current) return
    e.preventDefault()
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx || !last.current) return
    const p = pos(e)
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
    if (empty.current) { empty.current = false; force(n => n + 1) }
    onChange?.(canvasRef.current!.toDataURL('image/png'))
  }

  function up() {
    drawing.current = false
    last.current = null
  }

  function clear() {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = bgColor
    ctx.fillRect(0, 0, width, height)
    empty.current = true
    force(n => n + 1)
    onChange?.(null)
  }

  useImperativeHandle(ref, () => ({
    clear,
    isEmpty: () => empty.current,
    toDataUrl: () => empty.current ? null : canvasRef.current?.toDataURL('image/png') || null,
  }), [])

  return (
    <div className={className}>
      <div className="relative border-2 border-dashed border-slate-300 rounded-2xl bg-white overflow-hidden dark:bg-white/[0.04]">
        <canvas
          ref={canvasRef}
          style={{ width, height, display: 'block', touchAction: 'none' }}
          className="cursor-crosshair"
          onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={up}
          onTouchStart={down} onTouchMove={move} onTouchEnd={up}
        />
        {empty.current && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-slate-300">
            <PenLine size={20} className="mr-2" />
            <span className="text-sm font-medium">Firmá con el mouse o el dedo</span>
          </div>
        )}
      </div>
      <div className="flex justify-end mt-2">
        <button type="button" onClick={clear}
          className="flex items-center gap-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors dark:text-white/40">
          <Eraser size={13} /> Borrar firma
        </button>
      </div>
    </div>
  )
})

export default SignaturePad
