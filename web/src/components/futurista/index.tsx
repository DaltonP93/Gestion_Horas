'use client'
/**
 * Sistema de diseño "Futurista" — componentes atómicos.
 * Portado del prototipo de Claude Design (base.jsx) a React + TypeScript.
 * Estilo: bento glassmorphism, acentos cyan/blue, tema claro/oscuro.
 */
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'

// ─── Bento: la unidad visual base ──────────────────────────────
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
        'bento-enter relative overflow-hidden rounded-bento md:rounded-bento-lg',
        'bg-white dark:bg-white/[0.04]',
        'border border-slate-200/80 dark:border-white/[0.08]',
        'shadow-[0_8px_40px_-12px_rgba(15,23,42,0.12)] dark:shadow-none',
        'backdrop-blur-2xl transition-all duration-300 ease-out',
        hover &&
          'hover:-translate-y-1 hover:shadow-[0_20px_60px_-15px_rgba(37,99,235,0.25)] dark:hover:border-cyan-400/30 dark:hover:shadow-[0_0_40px_-10px_rgba(34,211,238,0.15)]',
        onClick && 'cursor-pointer',
        span,
        className,
      )}
    >
      {children}
    </div>
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
  const tones: Record<string, string> = {
    cyan: 'bg-cyan-50 dark:bg-cyan-400/10 text-cyan-500 dark:text-cyan-400',
    amber: 'bg-amber-50 dark:bg-amber-400/10 text-amber-500 dark:text-amber-400',
    rose: 'bg-rose-50 dark:bg-rose-400/10 text-rose-500 dark:text-rose-400',
    violet: 'bg-violet-50 dark:bg-violet-400/10 text-violet-500 dark:text-violet-400',
    emerald: 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-500 dark:text-emerald-400',
  }
  return (
    <Bento delay={delay} span={span} className={clsx('p-4 md:p-5 flex flex-col justify-between gap-6', className)}>
      <div className={clsx('w-8 h-8 rounded-xl flex items-center justify-center', tones[tone])}>{icon}</div>
      <div>
        <div className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white tabular-nums">{value}</div>
        <div className="text-[11px] font-medium text-slate-400 dark:text-white/40">{label}</div>
      </div>
    </Bento>
  )
}
