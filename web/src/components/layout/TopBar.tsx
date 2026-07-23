'use client'
import { Moon, Sun } from 'lucide-react'
import NotificationBell from './NotificationBell'
import GlobalSearch from './GlobalSearch'
import LanguageSwitcher from './LanguageSwitcher'
import AccountMenu from './AccountMenu'
import { useTheme } from '@/components/theme/ThemeProvider'

export default function TopBar() {
  const { dark, toggle } = useTheme()
  return (
    <div className="sticky top-0 z-30 flex items-center justify-between gap-2 px-4 h-12
      bg-white/70 dark:bg-[#050505]/60 backdrop-blur-2xl
      border-b border-slate-100 dark:border-white/[0.05] transition-colors duration-300">
      <GlobalSearch />
      <div className="flex items-center gap-1">
        <button
          onClick={toggle}
          aria-label={dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          title={dark ? 'Onyx & Glow' : 'Soft Arctic'}
          className="w-9 h-9 rounded-xl flex items-center justify-center
            text-slate-500 dark:text-white/50 hover:text-slate-700 dark:hover:text-white/80
            hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors"
        >
          {dark ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <LanguageSwitcher />
        <NotificationBell />
        <div className="ml-1 pl-1 border-l border-slate-200 dark:border-white/10">
          <AccountMenu variant="avatar" />
        </div>
      </div>
    </div>
  )
}
