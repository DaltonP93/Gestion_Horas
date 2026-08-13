'use client'
/**
 * EmployeeSearchCombobox — selector de empleado con búsqueda remota.
 *
 * Reemplaza al `<select>` que cargaba hasta 500 empleados de una vez: además
 * de incómodo, ese tope OCULTABA registros — con más de 500 activos, los
 * restantes no aparecían en la lista y no había forma de elegirlos.
 *
 * No descarga el padrón: consulta `/api/employees?search=` con debounce, que
 * ya filtra por nombre, apellido, código, legajo, documento y nombre completo.
 * No hace falta API nueva.
 *
 * Accesibilidad: patrón combobox de APG — `role="combobox"` sobre el input,
 * `aria-expanded`, `aria-controls`, `aria-autocomplete="list"` y
 * `aria-activedescendant` apuntando a la opción activa, que es lo que permite
 * a un lector de pantalla anunciar el movimiento sin sacar el foco del input.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, X, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  shouldSearch, employeeLabel, employeeMeta, employeeInputText,
  type EmpleadoOpcion,
} from '@/lib/employeeSearch'

/** Ventana de debounce. Suficiente para no perseguir cada tecla. */
export const DEBOUNCE_MS = 300

interface Props {
  /** id del empleado seleccionado; '' = todos */
  value: string
  onChange: (employeeId: string) => void
  /** acota la búsqueda al departamento elegido, si hay uno */
  deptId?: string
  placeholder?: string
  disabled?: boolean
  /** cuántos resultados pedir por búsqueda */
  limit?: number
}

export default function EmployeeSearchCombobox({
  value, onChange, deptId, disabled,
  placeholder = 'Buscar por nombre o código...',
  limit = 20,
}: Props) {
  const [term, setTerm]         = useState('')
  const [debounced, setDeb]     = useState('')
  const [open, setOpen]         = useState(false)
  const [activeIdx, setActive]  = useState(-1)
  const [selected, setSelected] = useState<EmpleadoOpcion | null>(null)

  const rootRef  = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = `emp-combobox-${useId()}`

  // El padre puede limpiar la selección (p. ej. al cambiar de departamento).
  useEffect(() => {
    if (!value) { setSelected(null); setTerm('') }
  }, [value])

  // Debounce del término.
  useEffect(() => {
    const t = setTimeout(() => setDeb(term), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [term])

  const buscar = shouldSearch(debounced)

  const { data, isFetching } = useQuery({
    queryKey: ['employee-search', debounced, deptId || ''],
    queryFn: ({ signal }) => api.get('/api/employees', {
      params: {
        search: debounced.trim(),
        status: 'active',
        limit,
        ...(deptId ? { department_id: deptId } : {}),
      },
      signal,
    }).then(r => r.data),
    enabled: open && buscar,
    staleTime: 30_000,
  })

  const opciones: EmpleadoOpcion[] = useMemo(() => data?.data || [], [data])

  // Cerrar al hacer clic fuera.
  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [])

  function elegir(emp: EmpleadoOpcion) {
    setSelected(emp)
    setTerm(employeeInputText(emp))
    setOpen(false)
    setActive(-1)
    onChange(String(emp.id))
  }

  function limpiar() {
    setSelected(null)
    setTerm('')
    setDeb('')
    setOpen(false)
    setActive(-1)
    onChange('')
    inputRef.current?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setActive(i => (opciones.length ? (i + 1) % opciones.length : -1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return
      setActive(i => (opciones.length ? (i <= 0 ? opciones.length - 1 : i - 1) : -1))
    } else if (e.key === 'Enter') {
      if (open && activeIdx >= 0 && opciones[activeIdx]) {
        e.preventDefault()
        elegir(opciones[activeIdx])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setActive(-1)
    } else if (e.key === 'Home' && open) {
      e.preventDefault(); setActive(opciones.length ? 0 : -1)
    } else if (e.key === 'End' && open) {
      e.preventDefault(); setActive(opciones.length - 1)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  const sinResultados = open && buscar && !isFetching && opciones.length === 0
  const pidiendoMas   = open && !buscar && term.trim().length > 0

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Search
          size={14} aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none dark:text-white/30"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIdx >= 0 ? `${listboxId}-opt-${activeIdx}` : undefined}
          aria-label="Buscar empleado"
          autoComplete="off"
          disabled={disabled}
          value={term}
          placeholder={placeholder}
          onChange={e => {
            setTerm(e.target.value)
            setOpen(true)
            setActive(-1)
            // Escribir invalida la selección: el reporte no debe seguir
            // filtrando por un empleado que ya no es el que se ve escrito.
            if (selected) { setSelected(null); onChange('') }
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-full border border-slate-200 rounded-xl pl-8 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 dark:border-white/[0.08] dark:bg-transparent"
        />
        {isFetching && (
          <Loader2
            size={14} aria-hidden="true"
            className="absolute right-8 top-1/2 -translate-y-1/2 animate-spin text-slate-400 dark:text-white/30"
          />
        )}
        {(term || selected) && !disabled && (
          <button
            type="button" onClick={limpiar} aria-label="Limpiar selección"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:text-white/30 dark:hover:text-white/60"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Estado de la búsqueda para lectores de pantalla. */}
      <span className="sr-only" role="status" aria-live="polite">
        {isFetching ? 'Buscando empleados' : (sinResultados ? 'Sin resultados' : '')}
      </span>

      {open && (
        <ul
          id={listboxId} role="listbox" aria-label="Empleados"
          className="absolute z-30 mt-1 w-full max-h-64 overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg dark:bg-slate-900 dark:border-white/[0.08]"
        >
          {pidiendoMas && (
            <li className="px-3 py-2 text-xs text-slate-400 dark:text-white/30">
              Escribí al menos 2 caracteres…
            </li>
          )}
          {isFetching && opciones.length === 0 && (
            <li className="px-3 py-2 text-xs text-slate-400 dark:text-white/30">Buscando…</li>
          )}
          {sinResultados && (
            <li className="px-3 py-2 text-xs text-slate-400 dark:text-white/30">
              Sin resultados para “{debounced.trim()}”
            </li>
          )}
          {opciones.map((emp, i) => (
            <li
              key={emp.id}
              id={`${listboxId}-opt-${i}`}
              role="option"
              aria-selected={String(emp.id) === value}
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => { e.preventDefault(); elegir(emp) }}
              className={`px-3 py-2 cursor-pointer ${i === activeIdx ? 'bg-blue-50 dark:bg-white/[0.06]' : ''}`}
            >
              <div className="text-sm text-slate-800 dark:text-white/80">{employeeLabel(emp)}</div>
              <div className="text-xs text-slate-500 dark:text-white/40">{employeeMeta(emp)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
