'use client'
import Link from 'next/link'
import { Server, Calculator, FileCog, Archive, Shield, Code2, History, AlertTriangle, type LucideIcon } from 'lucide-react'
import { useCurrentUser, isSuperAdmin } from '@/lib/useCurrentUser'
import { visibleSistemaCards } from '@/lib/sistemaNav'

const ICONS: Record<string, LucideIcon> = {
  Calculator, FileCog, Archive, Shield, Code2, History,
}

export default function SistemaPage() {
  const user = useCurrentUser()
  const cards = visibleSistemaCards(isSuperAdmin(user))

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-slate-900 flex items-center justify-center">
          <Server className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Módulo Sistema</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Operaciones técnicas.</p>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 flex items-start gap-3">
        <AlertTriangle size={20} className="shrink-0 mt-0.5" />
        <div className="text-sm">
          Las acciones aquí pueden afectar datos en producción. Usá con cuidado fuera de horarios
          de alta actividad.
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {cards.map(({ href, iconKey, title, desc, color }) => {
          const Icon = ICONS[iconKey] || Server
          return (
          <Link key={href} href={href}
            className="group bg-white rounded-2xl border border-slate-100 shadow-sm hover:shadow-md hover:border-slate-200 transition-all p-5 flex flex-col dark:bg-white/[0.04] dark:border-white/[0.06]"
          >
            <div className={`w-11 h-11 rounded-xl ${color} flex items-center justify-center mb-4 group-hover:scale-105 transition-transform`}>
              <Icon className="text-white" size={22} />
            </div>
            <h3 className="font-semibold text-slate-900 mb-1 dark:text-white">{title}</h3>
            <p className="text-sm text-slate-500 leading-relaxed dark:text-white/40">{desc}</p>
          </Link>
          )
        })}
      </div>
    </div>
  )
}
