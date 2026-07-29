'use client'
import React, { forwardRef } from 'react'

/**
 * PopoverSurface — superficie compartida para popovers/menús flotantes.
 *
 * PR 2. Antes cada componente (NotificationBell, LanguageSwitcher,
 * AccountMenu, menús contextuales) definía sus propios fondos, con
 * resultado incoherente en modo oscuro: `dark:bg-white/[0.04]` era
 * demasiado translúcido para un menú flotante y el contraste caía por
 * debajo de AA.
 *
 * Reglas:
 * - Fondo SÓLIDO tanto en light como en dark: nunca `bg-white/[…]`.
 * - Borde y sombra fuertes para separarse del contenido.
 * - Mismo radio (rounded-2xl) y transición corta.
 *
 * Uso:
 *   <PopoverSurface className="w-64 right-0 mt-2">…</PopoverSurface>
 *
 * Para items del menú, usar `popoverItemClass()` para mantener hover y
 * focus consistentes en ambos modos.
 */
export const PopoverSurface = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function PopoverSurface({ className = '', children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        {...rest}
        className={
          'absolute z-50 rounded-2xl overflow-hidden ' +
          'bg-white border border-slate-200 shadow-xl ' +
          // Dark: fondo sólido (no translúcido) + borde y sombra que
          // aíslen el popover del fondo de la app.
          'dark:bg-[#111318] dark:border-white/10 dark:shadow-2xl ' +
          className
        }
      >
        {children}
      </div>
    )
  }
)

// Clase para un item genérico del popover (link o botón).
export function popoverItemClass(extra = ''): string {
  return (
    'w-full flex items-center gap-3 px-3 py-2 text-sm text-left ' +
    'text-slate-700 hover:bg-slate-50 focus-visible:bg-slate-50 focus:outline-none ' +
    'dark:text-white/80 dark:hover:bg-white/[0.06] dark:focus-visible:bg-white/[0.06] ' +
    extra
  )
}

// Fondo para una notificación NO leída — con contrastes definidos en ambos modos.
export function popoverUnreadBgClass(): string {
  return 'bg-indigo-50/60 dark:bg-indigo-500/15'
}

// Encabezado y separadores dentro del popover.
export function popoverHeaderClass(): string {
  return 'flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-white/10'
}
export function popoverDividerClass(): string {
  return 'border-t border-slate-100 dark:border-white/10'
}
