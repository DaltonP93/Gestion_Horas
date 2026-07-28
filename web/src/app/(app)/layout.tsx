import Sidebar from '@/components/layout/Sidebar'
import TopBar from '@/components/layout/TopBar'
import Breadcrumbs from '@/components/layout/Breadcrumbs'
import DeviceAlertBanner from '@/components/layout/DeviceAlertBanner'
import MobileBottomNav from '@/components/layout/MobileBottomNav'
import HelpButton from '@/components/HelpButton'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-orbs flex min-h-screen bg-slate-50 dark:bg-[#050505] transition-colors duration-300">
      <Sidebar />
      <main className="relative z-10 flex-1 overflow-auto flex flex-col pb-20 md:pb-0">
        <TopBar />
        <Breadcrumbs />
        <div className="flex-1">{children}</div>
      </main>
      <DeviceAlertBanner />
      {/* MobileBottomNav decide internamente si renderizar (solo employee en móvil) */}
      <MobileBottomNav />
      {/* Botón flotante de ayuda contextual — se muestra en todos los módulos */}
      <HelpButton />
    </div>
  )
}
