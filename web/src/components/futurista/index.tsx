'use client'
/**
 * Sistema de diseño "Futurista · Liquid Glass" — componentes atómicos.
 * Estilo: vidrio líquido (glassmorphism refinado) + toques claymórficos +
 * profundidad y micro-interacciones. Tema claro/oscuro.
 */
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'

// ─── Bento: la unidad visual base (ahora vidrio líquido) ───────
export function Bento({
  children,
  className = '',
  span = '',
  delay = 0,
  hover = true,
  onClick,
}: {
  children: React.ReactNode
  className?: string
  span?: string
  delay?: number
  hover?: boolean
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      style={{ animationDelay: `${delay}ms` }}
      className={clsx(
        'bento-enter glass relative overflow-hidden rounded-bento md:rounded-bento-lg',
        'transition-all duration-300 ease-out',
        hover && 'lift',
        onClick && 'cursor-pointer',
        span,
        className,
      )}
    >
      {children}
    </div>
  )
}

// ─── ClayTile: contenedor claymórfico para íconos/acciones ─────
export function ClayTile({
  children,
  className = '',
  tone = 'cyan',
  size = 40,
  interactive = false,
  onClick,
}: {
  children: React.ReactNode
  className?: string
  tone?: 'cyan' | 'amber' | 'rose' | 'violet' | 'emerald' | 'neutral'
  size?: number
  interactive?: boolean
  onClick?: () => void
}) {
  const tones: Record<string, string> = {
    cyan: 'text-cyan-500 dark:text-cyan-400',
    amber: 'text-amber-500 dark:text-amber-400',
    rose: 'text-rose-500 dark:text-rose-400',
    violet: 'text-violet-500 dark:text-violet-400',
    emerald: 'text-emerald-500 dark:text-emerald-400',
    neutral: 'text-slate-500 dark:text-white/60',
  }
  return (
    <div
      onClick={onClick}
      style={{ width: size, height: size }}
      className={clsx(
        'clay rounded-2xl flex items-center justify-center shrink-0',
        tones[tone],
        interactive && 'clay-btn cursor-pointer',
        className,
      )}
    >
      {children}
    </div>
  )
}

// ─── GlassButton: botón de vidrio líquido con sheen ────────────
export function GlassButton({
  children,
  onClick,
  className = '',
  primary = false,
  type = 'button',
  disabled = false,
}: {
  children: React.ReactNode
  onClick?: () => void
  className?: string
  primary?: boolean
  type?: 'button' | 'submit'
  disabled?: boolean
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'sheen relative inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2.5',
        'text-[13px] font-bold tracking-tight transition-all duration-300',
        primary
          ? 'text-white bg-gradient-to-br from-cyan-400 to-blue-600 shadow-[0_10px_28px_-8px_rgba(34,211,238,0.5)] hover:-translate-y-0.5 hover:shadow-[0_16px_36px_-8px_rgba(34,211,238,0.7)] active:translate-y-0'
          : 'glass text-slate-700 dark:text-white/80 hover:-translate-y-0.5',
        disabled && 'opacity-50 cursor-not-allowed hover:translate-y-0',
        className,
      )}
    >
      {children}
    </button>
  )
}

// ─── GlowDot: indicador con halo ───────────────────────────────
const DOT_COLORS: Record<string, string> = {
  cyan: 'bg-cyan-400 shadow-[0_0_12px_2px_rgba(34,211,238,0.6)]',
  green: 'bg-emerald-400 shadow-[0_0_12px_2px_rgba(52,211,153,0.6)]',
  amber: 'bg-amber-400 shadow-[0_0_12px_2px_rgba(251,191,36,0.6)]',
  red: 'bg-rose-400 shadow-[0_0_12px_2px_rgba(251,113,133,0.6)]',
}
export function GlowDot({ color = 'cyan', pulse = true }: { color?: keyof typeof DOT_COLORS; pulse?: boolean }) {
  return <span className={clsx('inline-block w-2 h-2 rounded-full', DOT_COLORS[color], pulse && 'animate-pulse')} />
}

// ─── Ring: progreso radial ─────────────────────────────────────
export function Ring({
  pct,
  size = 120,
  stroke = 10,
  color = '#22d3ee',
  label,
  sublabel,
}: {
  pct: number
  size?: number
  stroke?: number
  color?: string
  label?: React.ReactNode
  sublabel?: string
}) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const [animPct, setAnimPct] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setAnimPct(pct), 300)
    return () => clearTimeout(t)
  }, [pct])
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-slate-100 dark:stroke-white/[0.06]" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke={color}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - animPct / 100)}
          style={{ transition: 'stroke-dashoffset 1.4s cubic-bezier(0.16, 1, 0.3, 1)', filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">{label}</span>
        {sublabel && <span className="text-[10px] font-medium text-slate-400 dark:text-white/40 mt-0.5">{sublabel}</span>}
      </div>
    </div>
  )
}

// ─── Spark: mini gráfica de área ───────────────────────────────
export function Spark({ data, color = '#22d3ee', height = 48, filled = true }: { data: number[]; color?: string; height?: number; filled?: boolean }) {
  const w = 100
  const h = height
  const safe = data.length ? data : [0, 0]
  const max = Math.max(...safe)
  const min = Math.min(...safe)
  const range = max - min || 1
  const pts = safe.map((v, i) => [(i / (safe.length - 1 || 1)) * w, h - 6 - ((v - min) / range) * (h - 14)])
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  const gid = useMemo(() => 'g' + Math.random().toString(36).slice(2, 8), [])
  const last = pts[pts.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {filled && <path d={area} fill={`url(#${gid})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 4px ${color}88)` }} />
      {last && <circle cx={last[0]} cy={last[1]} r="3" fill={color} style={{ filter: `drop-shadow(0 0 6px ${color})` }} />}
    </svg>
  )
}

// ─── Avatar con iniciales ──────────────────────────────────────
export function Avatar({ name, size = 36, hue }: { name: string; size?: number; hue?: number }) {
  const safe = name?.trim() || '?'
  const initials = safe.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
  const h = hue ?? (safe.charCodeAt(0) * 37) % 360
  return (
    <div
      className="rounded-2xl flex items-center justify-center font-bold text-white shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        background: `linear-gradient(135deg, hsl(${h},70%,55%), hsl(${(h + 40) % 360},75%,45%))`,
        boxShadow: `0 4px 14px -4px hsla(${h},70%,50%,0.5)`,
      }}
    >
      {initials}
    </div>
  )
}

// ─── useCountUp: contador animado ──────────────────────────────
export function useCountUp(target: number, duration = 1200, delay = 0) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    let raf = 0
    let start: number | undefined
    const t = setTimeout(() => {
      const step = (ts: number) => {
        if (start === undefined) start = ts
        const p = Math.min((ts - start) / duration, 1)
        const eased = 1 - Math.pow(1 - p, 3)
        setVal(Math.round(target * eased))
        if (p < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    }, delay)
    return () => {
      clearTimeout(t)
      cancelAnimationFrame(raf)
    }
  }, [target, duration, delay])
  return val
}

// ─── StatCard: tarjeta KPI reutilizable ────────────────────────
export function StatCard({
  icon,
  value,
  label,
  tone = 'cyan',
  delay = 0,
  span = '',
  className = '',
}: {
  icon: React.ReactNode
  value: React.ReactNode
  label: string
  tone?: 'cyan' | 'amber' | 'rose' | 'violet' | 'emerald'
  delay?: number
  span?: string
  className?: string
}) {
  return (
    <Bento delay={delay} span={span} className={clsx('p-4 md:p-5 flex flex-col justify-between gap-6', className)}>
      <ClayTile tone={tone} size={36} className="rounded-xl">{icon}</ClayTile>
      <div>
        <div className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white tabular-nums">{value}</div>
        <div className="text-[11px] font-medium text-slate-400 dark:text-white/40">{label}</div>
      </div>
    </Bento>
  )
}
