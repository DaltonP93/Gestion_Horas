'use client'
import Link from 'next/link'
import { Server, HardDrive, Database, Calculator, AlertTriangle, FileCog, Archive, Activity, Shield, Code2, Webhook, Radar } from 'lucide-react'

const cards = [
  {
    href: '/configuracion?tab=relojes',
    icon: HardDrive,
    title: 'Relojes ZKTeco',
    desc: 'Configuración de dispositivos biométricos: alta, IP, modo de conexión, diagnóstico, backup manual.',
    color: 'bg-blue-500',
  },
  {
    href: '/configuracion?tab=sync',
    icon: Database,
    title: 'Importación att2000',
    desc: 'Sincronizar departamentos, empleados y marcajes desde la BD fuente (SQL Server ZKTeco).',
    color: 'bg-purple-500',
  },
  {
    href: '/sistema/procesar',
    icon: Calculator,
    title: 'Procesar Horas',
    desc: 'Recalcular el resumen diario (daily_summary) para un rango de fechas. Útil tras importaciones o correcciones manuales.',
    color: 'bg-emerald-500',
  },
  {
    href: '/configuracion/reglas-permisos',
    icon: FileCog,
    title: 'Reglas de Permisos',
    desc: 'Configurar qué niveles (coordinador, gerente, GTH) son requeridos por departamento y tipo de permiso.',
    color: 'bg-amber-500',
  },
  {
    href: '/sistema/backups',
    icon: Archive,
    title: 'Backups de BD',
    desc: 'Backups automáticos y manuales de MySQL. Listado, descarga, retención configurable.',
    color: 'bg-rose-500',
  },
  {
    href: '/sistema/salud',
    icon: Activity,
    title: 'Estado del sistema',
    desc: 'Salud en tiempo real de MySQL, Redis, Bridge, att2000. Auto-refresco cada 15s.',
    color: 'bg-cyan-500',
  },
  {
    href: '/sistema/gdpr',
    icon: Shield,
    title: 'Cumplimiento GDPR',
    desc: 'Exportar datos personales de un empleado o anonimizar (right to be forgotten).',
    color: 'bg-slate-700',
  },
  {
    href: '/sistema/embed',
    icon: Code2,
    title: 'Embed (dashboards públicos)',
    desc: 'Tokens read-only para insertar widgets en intranets, Oracle APEX o portales externos.',
    color: 'bg-violet-500',
  },
  {
    href: '/configuracion/webhooks',
    icon: Webhook,
    title: 'Webhooks Slack / Teams',
    desc: 'Notificaciones automáticas de ausencias, atrasos y alertas de relojes en Slack o Microsoft Teams.',
    color: 'bg-[#4A154B]',
  },
  {
    href: '/configuracion/discovery',
    icon: Radar,
    title: 'Descubrimiento de Relojes',
    desc: 'Escanea la LAN en busca de relojes ZKTeco respondiendo en el puerto 4370.',
    color: 'bg-blue-600',
  },
]

export default function SistemaPage() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-slate-900 flex items-center justify-center">
          <Server className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Módulo Sistema</h1>
          <p className="text-slate-500 text-sm dark:text-white/40">Operaciones técnicas — solo super_admin.</p>
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
        {cards.map(({ href, icon: Icon, title, desc, color }) => (
          <Link key={href} href={href}
            className="group bg-white rounded-2xl border border-slate-100 shadow-sm hover:shadow-md hover:border-slate-200 transition-all p-5 flex flex-col dark:bg-white/[0.04] dark:border-white/[0.06]"
          >
            <div className={`w-11 h-11 rounded-xl ${color} flex items-center justify-center mb-4 group-hover:scale-105 transition-transform`}>
              <Icon className="text-white" size={22} />
            </div>
            <h3 className="font-semibold text-slate-900 mb-1 dark:text-white">{title}</h3>
            <p className="text-sm text-slate-500 leading-relaxed dark:text-white/40">{desc}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
