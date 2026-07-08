'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Search, X, User, Calendar, FileText, Clock, Users, BarChart2, Settings, Cake, Building2, Shield, Server, TrendingUp, DollarSign, CheckSquare, Activity } from 'lucide-react'
import { api } from '@/lib/api'

type Result = {
  type: 'employee' | 'page' | 'department'
  id?: string | number
  title: string
  subtitle?: string
  href: string
  icon: any
}

const PAGES: { label: string; href: string; icon: any; keywords: string }[] = [
  { label: 'Dashboard',       href: '/dashboard',       icon: BarChart2,    keywords: 'dashboard inicio kpi metricas' },
  { label: 'Empleados',       href: '/empleados',       icon: Users,        keywords: 'empleados personal' },
  { label: 'Asistencia',      href: '/asistencia',      icon: Clock,        keywords: 'asistencia presencia marcacion' },
  { label: 'Permisos',        href: '/permisos',        icon: Calendar,     keywords: 'permisos solicitudes ausencia' },
  { label: 'Aprobaciones',    href: '/aprobaciones',    icon: CheckSquare,  keywords: 'aprobaciones revisar' },
  { label: 'Reportes',        href: '/reportes',        icon: BarChart2,    keywords: 'reportes marcadas mensual' },
  { label: 'Mi equipo',       href: '/supervisor',      icon: Users,        keywords: 'supervisor equipo subordinados' },
  { label: 'Ejecutivo',       href: '/ejecutivo',       icon: TrendingUp,   keywords: 'ejecutivo gerencia kpi' },
  { label: 'Nómina SAA',      href: '/nomina',          icon: DollarSign,   keywords: 'nomina saa planilla' },
  { label: 'Calendario',      href: '/calendario',      icon: Cake,         keywords: 'calendario cumpleanos aniversarios' },
  { label: 'Departamentos',   href: '/departamentos',   icon: Building2,    keywords: 'departamentos areas' },
  { label: 'Usuarios',        href: '/usuarios',        icon: Shield,       keywords: 'usuarios permisos roles' },
  { label: 'Auditoría',       href: '/auditoria',       icon: FileText,     keywords: 'auditoria logs eventos' },
  { label: 'Configuración',   href: '/configuracion',   icon: Settings,     keywords: 'configuracion ajustes smtp relojes' },
  { label: 'Sistema',         href: '/sistema',         icon: Server,       keywords: 'sistema admin' },
  { label: 'Backups',         href: '/sistema/backups', icon: Server,       keywords: 'backup respaldo bd' },
  { label: 'Salud sistema',   href: '/sistema/salud',   icon: Activity,     keywords: 'salud health monitor estado' },
  { label: 'Mi perfil',       href: '/mi-perfil',       icon: User,         keywords: 'perfil cuenta' },
  { label: 'Mi asistencia',   href: '/mi-asistencia',   icon: Clock,        keywords: 'mi asistencia' },
  { label: 'Mis permisos',    href: '/mis-permisos',    icon: Calendar,     keywords: 'mis permisos' },
]

export default function GlobalSearch() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [empResults, setEmpResults] = useState<any[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<any>(null)

  // Cmd/Ctrl+K para abrir
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape' && open) setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  // Focus al abrir
  useEffect(() => {
    if (open) {
      setQ('')
      setActiveIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Buscar empleados con debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim() || q.length < 2) {
      setEmpResults([])
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await api.get('/api/employees', { params: { search: q, limit: 8 } })
        setEmpResults(r.data?.data || [])
      } catch {
        setEmpResults([])
      }
    }, 250)
  }, [q])

  // Resultados combinados
  const results: Result[] = useMemo(() => {
    const out: Result[] = []
    const ql = q.toLowerCase().trim()

    if (ql) {
      // Páginas que matchean
      for (const p of PAGES) {
        if (p.label.toLowerCase().includes(ql) || p.keywords.includes(ql)) {
          out.push({ type: 'page', title: p.label, href: p.href, icon: p.icon })
        }
      }
      // Empleados
      for (const e of empResults) {
        out.push({
          type: 'employee',
          id: e.id,
          title: e.full_name,
          subtitle: `[${e.code}] ${e.department || 'Sin depto'}`,
          href: `/empleados/${e.id}`,
          icon: User,
        })
      }
    } else {
      // Default: páginas principales
      for (const p of PAGES.slice(0, 8)) {
        out.push({ type: 'page', title: p.label, href: p.href, icon: p.icon })
      }
    }
    return out
  }, [q, empResults])

  function go(href: string) {
    setOpen(false)
    router.push(href)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[activeIdx]) {
      e.preventDefault()
      go(results[activeIdx].href)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="hidden md:flex items-center gap-2 text-slate-500 bg-slate-100 hover:bg-slate-200 transition-colors rounded-lg px-3 py-1.5 text-xs dark:bg-white/[0.06] dark:text-white/40"
        aria-label="Búsqueda global"
      >
        <Search size={14} />
        <span>Buscar...</span>
        <kbd className="ml-2 bg-white text-slate-400 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] font-mono dark:bg-white/[0.04] dark:text-white/30 dark:border-white/[0.08]">⌘K</kbd>
      </button>
      <button
        onClick={() => setOpen(true)}
        className="md:hidden p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg dark:text-white/40 dark:hover:bg-white/[0.06]"
        aria-label="Búsqueda global"
      >
        <Search size={18} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-[10vh] px-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xl flex flex-col max-h-[70vh] overflow-hidden dark:bg-white/[0.04]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 dark:border-white/[0.06]">
              <Search size={18} className="text-slate-400 dark:text-white/30" />
              <input
                ref={inputRef}
                value={q}
                onChange={e => { setQ(e.target.value); setActiveIdx(0) }}
                onKeyDown={onKeyDown}
                placeholder="Buscar empleados, páginas..."
                className="flex-1 bg-transparent outline-none text-sm"
              />
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 dark:text-white/30">
                <X size={18} />
              </button>
            </div>

            <div className="overflow-y-auto flex-1">
              {results.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-sm dark:text-white/30">
                  {q.length < 2 ? 'Escribí al menos 2 caracteres' : 'Sin resultados'}
                </div>
              ) : (
                <div className="py-1">
                  {results.map((r, i) => {
                    const Icon = r.icon
                    return (
                      <button key={`${r.type}-${r.id ?? r.href}-${i}`}
                        onClick={() => go(r.href)}
                        onMouseEnter={() => setActiveIdx(i)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          i === activeIdx ? 'bg-blue-50' : 'hover:bg-slate-50'
                        }`}>
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          r.type === 'employee' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'
                        }`}>
                          <Icon size={15} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate dark:text-white/90">{r.title}</p>
                          {r.subtitle && <p className="text-xs text-slate-500 truncate dark:text-white/40">{r.subtitle}</p>}
                        </div>
                        <span className="text-xs text-slate-400 capitalize dark:text-white/30">
                          {r.type === 'employee' ? 'Empleado' : 'Página'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-slate-100 bg-slate-50 px-4 py-2 flex items-center gap-3 text-xs text-slate-400 dark:bg-white/[0.03] dark:text-white/30 dark:border-white/[0.06]">
              <span>↑↓ navegar</span>
              <span>↵ ir</span>
              <span>esc cerrar</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
