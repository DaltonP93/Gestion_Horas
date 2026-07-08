'use client'
import { useState, useRef, useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Plus, UserCheck, UserX, TrendingUp, Download, Upload, ChevronDown, Users, CheckCircle, AlertCircle, X, FileText, Pencil, Check, Settings2 } from 'lucide-react'
import { employeesApi, api } from '@/lib/api'
import Link from 'next/link'
import { format } from 'date-fns'
import { useDisplayMode } from '@/lib/useSettings'
import { formatEmployee, formatEmployeeInitials } from '@/lib/displayMode'
import { useI18n } from '@/i18n/I18nProvider'

// ─── Columnas esperadas y sus alias ──────────────────────────────
const FIELD_MAP: Record<string, string[]> = {
  code:            ['código', 'codigo', 'code', 'id reloj', 'zk', 'cód'],
  employee_number: ['legajo', 'cedula', 'cédula', 'dni', 'documento', 'employee_number', 'ci'],
  first_name:      ['nombre', 'name', 'first_name', 'firstname', 'primer nombre'],
  last_name:       ['apellido', 'last_name', 'lastname', 'surname', 'segundo nombre'],
  email:           ['email', 'correo', 'mail', 'e-mail'],
  phone:           ['teléfono', 'telefono', 'phone', 'celular', 'tel'],
  position:        ['cargo', 'puesto', 'position', 'role', 'ocupación'],
  department:      ['departamento', 'department', 'area', 'área', 'sector'],
  hire_date:       ['fecha ingreso', 'fecha_ingreso', 'hire_date', 'ingreso', 'alta'],
  status:          ['estado', 'status', 'activo'],
}

const FIELD_LABELS: Record<string, string> = {
  code: 'Código *', employee_number: 'Legajo/Cédula',
  first_name: 'Nombre *', last_name: 'Apellido',
  email: 'Email', phone: 'Teléfono', position: 'Cargo', department: 'Departamento',
  hire_date: 'Fecha ingreso', status: 'Estado',
}

// Detectar separador automáticamente
function detectSep(line: string) {
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 }
  for (const c of line) if (c in counts) counts[c as keyof typeof counts]++
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
}

// Parsear CSV/TXT en array de objetos
function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim())
  if (!lines.length) return { headers: [], rows: [] }
  const sep = detectSep(lines[0])
  const parseRow = (line: string) =>
    line.split(sep).map(v => v.trim().replace(/^["']|["']$/g, '').trim())
  const headers = parseRow(lines[0])
  const rows = lines.slice(1).map(parseRow)
  return { headers, rows }
}

// Mapear header de archivo a campo del sistema
function autoMapHeaders(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const h of headers) {
    const hl = h.toLowerCase().trim()
    for (const [field, aliases] of Object.entries(FIELD_MAP)) {
      if (aliases.some(a => hl.includes(a))) { map[h] = field; break }
    }
  }
  return map
}

// ─── Exportar CSV/TXT ─────────────────────────────────────────────
function exportData(employees: any[], fmt: 'csv' | 'txt') {
  const filename = `empleados_${format(new Date(), 'yyyyMMdd')}.${fmt}`

  if (fmt === 'csv') {
    const header = ['Código','Nombre','Apellido','Nombre Completo','Departamento','Cargo','Email','Teléfono','Horario Entrada','Horario Salida','Estado']
    const rows = employees.map(e => [
      e.code, `"${e.first_name || ''}"`, `"${e.last_name || ''}"`, `"${e.full_name || ''}"`,
      `"${e.department || ''}"`, `"${e.position || ''}"`, e.email || '',
      e.phone || '', e.check_in || '', e.check_out || '',
      e.status === 'active' ? 'Activo' : 'Inactivo',
    ].join(','))
    const csv = [header.join(','), ...rows].join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url)
  } else {
    const lines = [
      `LISTADO DE EMPLEADOS — ${format(new Date(), 'dd/MM/yyyy HH:mm')}`,
      '═'.repeat(70),
      ...employees.map((e, i) => [
        `${String(i + 1).padStart(3, '0')}. [${e.code}] ${e.full_name}`,
        `     Departamento: ${e.department || 'Sin asignar'}  |  Cargo: ${e.position || '—'}`,
        `     Horario: ${e.check_in ? e.check_in.slice(0,5) + ' – ' + (e.check_out?.slice(0,5) || '') : '—'}`,
        e.email ? `     Email: ${e.email}` : '',
      ].filter(Boolean).join('\n')),
      '═'.repeat(70),
      `Total: ${employees.length} empleados`,
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url)
  }
}

// Descargar plantilla CSV
function downloadTemplate() {
  const csv = 'Código,Legajo,Nombre,Apellido,Email,Teléfono,Cargo,Departamento,Fecha ingreso,Estado\n3081,12345678,Juan,García,juan@empresa.com,0981123456,Operario,Producción,2024-03-15,activo\n3082,87654321,María,López,maria@empresa.com,,Administrativo,Administración,01/06/2023,activo'
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'plantilla_empleados.csv'; a.click(); URL.revokeObjectURL(url)
}

// ─── Dropdown exportar ─────────────────────────────────────────────
function ExportDropdown({ employees }: { employees: any[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} disabled={employees.length === 0}
        className="flex items-center gap-2 border border-slate-200 text-slate-600 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 disabled:opacity-40 transition-colors dark:text-white/60 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
        <Download size={15} /> Exportar <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg z-20 overflow-hidden min-w-[160px] dark:bg-white/[0.04] dark:border-white/[0.08]">
            <button onClick={() => { exportData(employees, 'csv'); setOpen(false) }}
              className="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 border-b border-slate-100 flex items-center gap-2 dark:border-white/[0.06] dark:hover:bg-white/[0.04]">
              <span className="text-green-600 font-bold text-xs w-8">CSV</span>
              <span className="text-slate-700 dark:text-white/80">Exportar CSV</span>
            </button>
            <button onClick={() => { exportData(employees, 'txt'); setOpen(false) }}
              className="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 flex items-center gap-2 dark:hover:bg-white/[0.04]">
              <span className="text-slate-600 font-bold text-xs w-8 dark:text-white/60">TXT</span>
              <span className="text-slate-700 dark:text-white/80">Exportar TXT</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Modal importar empleados ──────────────────────────────────────
function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'upload' | 'map' | 'preview' | 'result'>('upload')
  const [parsed, setParsed]   = useState<{ headers: string[]; rows: string[][] } | null>(null)
  const [colMap, setColMap]   = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<any[]>([])
  const [updateExisting, setUpdateExisting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult]   = useState<any>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase()

    if (ext === 'xlsx' || ext === 'xls') {
      // Parsear Excel con xlsx (SheetJS)
      try {
        const XLSX = await import('xlsx')
        const buf = await file.arrayBuffer()
        const wb  = XLSX.read(buf, { type: 'array' })
        const ws  = wb.Sheets[wb.SheetNames[0]]
        const data: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][]
        if (data.length < 2) return alert('El archivo Excel está vacío')
        const headers = data[0].map(String)
        const rows    = data.slice(1).map(r => r.map(String))
        const p = { headers, rows }
        setParsed(p)
        setColMap(autoMapHeaders(headers))
        setStep('map')
      } catch {
        alert('No se pudo leer el archivo Excel. Instale la dependencia xlsx o convierta a CSV.')
      }
      return
    }

    // CSV / TXT
    const text = await file.text()
    const p = parseCSV(text)
    if (!p.headers.length) return alert('El archivo está vacío o no tiene cabeceras')
    setParsed(p)
    setColMap(autoMapHeaders(p.headers))
    setStep('map')
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function buildPreview() {
    if (!parsed) return
    const rows = parsed.rows.slice(0, 5).map(row => {
      const obj: any = { _update: updateExisting }
      for (const [header, field] of Object.entries(colMap)) {
        if (!field) continue
        const idx = parsed.headers.indexOf(header)
        obj[field] = idx >= 0 ? row[idx] : ''
      }
      return obj
    })
    setPreview(rows)
    setStep('preview')
  }

  async function doImport() {
    if (!parsed) return
    setImporting(true)
    const employees = parsed.rows.map(row => {
      const obj: any = { _update: updateExisting }
      for (const [header, field] of Object.entries(colMap)) {
        if (!field) continue
        const idx = parsed.headers.indexOf(header)
        obj[field] = idx >= 0 ? row[idx] : ''
      }
      return obj
    }).filter(e => e.code)

    try {
      const r = await api.post('/api/employees/import', { employees })
      setResult(r.data)
      setStep('result')
      onDone()
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al importar')
    } finally { setImporting(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col dark:bg-white/[0.04]">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-t-2xl px-6 py-4 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white">Importar Empleados</h2>
            <p className="text-blue-200 text-xs mt-0.5">CSV, TXT, Excel (.xlsx) • Auto-detección de columnas</p>
          </div>
          <button onClick={onClose} className="text-blue-200 hover:text-white p-1 rounded-lg"><X size={18} /></button>
        </div>

        {/* Steps indicator */}
        <div className="flex border-b border-slate-100 px-6 py-3 gap-4 shrink-0 dark:border-white/[0.06]">
          {[
            { id: 'upload',  label: '1. Archivo' },
            { id: 'map',     label: '2. Columnas' },
            { id: 'preview', label: '3. Vista previa' },
            { id: 'result',  label: '4. Resultado' },
          ].map((s, i) => (
            <div key={s.id} className={`flex items-center gap-1.5 text-xs font-medium ${
              step === s.id ? 'text-blue-600' : 'text-slate-400'
            }`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                step === s.id ? 'bg-blue-600 text-white' :
                ['upload','map','preview','result'].indexOf(step) > i ? 'bg-green-500 text-white' : 'bg-slate-100 text-slate-400'
              }`}>{i + 1}</span>
              {s.label}
            </div>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">

          {/* STEP 1: Upload */}
          {step === 'upload' && (
            <div className="space-y-4">
              {/* Zona drag & drop */}
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all ${
                  dragOver ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50'
                }`}>
                <Upload size={36} className="mx-auto mb-3 text-slate-300" />
                <p className="font-semibold text-slate-600 dark:text-white/60">Arrastra el archivo aquí o haz click para seleccionar</p>
                <p className="text-xs text-slate-400 mt-1 dark:text-white/30">Soporta CSV, TXT (separado por ; o ,) y Excel (.xlsx)</p>
                <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx,.xls"
                  className="hidden" onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]) }} />
              </div>

              {/* Plantilla */}
              <div className="bg-slate-50 rounded-xl px-4 py-3 flex items-center justify-between dark:bg-white/[0.03]">
                <div>
                  <p className="text-sm font-medium text-slate-700 dark:text-white/80">¿Primera vez importando?</p>
                  <p className="text-xs text-slate-400 mt-0.5 dark:text-white/30">Descargue la plantilla CSV con el formato correcto</p>
                </div>
                <button onClick={downloadTemplate}
                  className="flex items-center gap-2 text-blue-600 text-sm font-medium hover:underline">
                  <FileText size={15} /> Descargar plantilla
                </button>
              </div>

              {/* Formatos soportados */}
              <div className="grid grid-cols-3 gap-3 text-xs">
                {[
                  { ext: 'CSV', desc: 'Separado por coma o punto y coma. Primera fila = cabeceras.' },
                  { ext: 'TXT', desc: 'Separado por tab, pipe (|), coma o punto y coma.' },
                  { ext: 'XLSX', desc: 'Excel Microsoft. Primera hoja, primera fila = cabeceras.' },
                ].map(f => (
                  <div key={f.ext} className="border border-slate-100 rounded-xl p-3 dark:border-white/[0.06]">
                    <p className="font-bold text-blue-600 mb-1">.{f.ext}</p>
                    <p className="text-slate-500 dark:text-white/40">{f.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 2: Mapear columnas */}
          {step === 'map' && parsed && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm text-blue-700">
                Se detectaron <strong>{parsed.headers.length}</strong> columnas y <strong>{parsed.rows.length}</strong> filas.
                Asigne cada columna del archivo al campo correspondiente.
              </div>

              <div className="grid grid-cols-2 gap-3">
                {parsed.headers.map(h => (
                  <div key={h} className="flex items-center gap-2">
                    <span className="text-xs font-mono bg-slate-100 px-2 py-1 rounded-lg text-slate-600 truncate flex-1 min-w-0 dark:bg-white/[0.06] dark:text-white/60">{h}</span>
                    <span className="text-slate-400 text-xs dark:text-white/30">→</span>
                    <select value={colMap[h] || ''}
                      onChange={e => setColMap(p => ({ ...p, [h]: e.target.value }))}
                      className="border border-slate-200 rounded-xl px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[120px] dark:border-white/[0.08]">
                      <option value="">(ignorar)</option>
                      {Object.entries(FIELD_LABELS).map(([f, l]) => (
                        <option key={f} value={f}>{l}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={updateExisting} onChange={e => setUpdateExisting(e.target.checked)}
                  className="accent-blue-600 w-4 h-4" />
                <span className="text-sm text-slate-700 dark:text-white/80">Actualizar empleados existentes (mismo código)</span>
              </label>

              <button onClick={buildPreview}
                className="w-full bg-blue-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors">
                Ver vista previa →
              </button>
            </div>
          )}

          {/* STEP 3: Vista previa */}
          {step === 'preview' && (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-sm text-amber-700">
                <strong>Vista previa</strong> — primeras 5 filas de {parsed?.rows.length} total.
                Verifique que los datos sean correctos antes de importar.
              </div>

              <div className="overflow-x-auto border border-slate-100 rounded-xl dark:border-white/[0.06]">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 dark:bg-white/[0.03]">
                    <tr>
                      {Object.entries(colMap).filter(([,v]) => v).map(([h]) => (
                        <th key={h} className="px-3 py-2 text-left text-slate-500 font-medium whitespace-nowrap dark:text-white/40">
                          {FIELD_LABELS[colMap[h]] || colMap[h]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
                    {preview.map((row, i) => (
                      <tr key={i} className="hover:bg-slate-50 dark:hover:bg-white/[0.04]">
                        {Object.entries(colMap).filter(([,v]) => v).map(([h]) => (
                          <td key={h} className="px-3 py-2 text-slate-700 whitespace-nowrap dark:text-white/80">
                            {row[colMap[h]] || <span className="text-slate-300">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex gap-3">
                <button onClick={() => setStep('map')}
                  className="flex-1 border border-slate-200 text-slate-700 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50 dark:text-white/80 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">
                  ← Volver
                </button>
                <button onClick={doImport} disabled={importing}
                  className="flex-1 bg-blue-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors">
                  {importing ? 'Importando...' : `Importar ${parsed?.rows.length} empleados`}
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: Resultado */}
          {step === 'result' && result && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-green-50 border border-green-100 rounded-2xl px-4 py-5">
                  <CheckCircle size={24} className="mx-auto text-green-600 mb-2" />
                  <p className="text-3xl font-bold text-green-700">{result.created}</p>
                  <p className="text-xs text-green-600 font-medium mt-1">Creados</p>
                </div>
                <div className="bg-blue-50 border border-blue-100 rounded-2xl px-4 py-5">
                  <CheckCircle size={24} className="mx-auto text-blue-600 mb-2" />
                  <p className="text-3xl font-bold text-blue-700">{result.updated || 0}</p>
                  <p className="text-xs text-blue-600 font-medium mt-1">Actualizados</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-2xl px-4 py-5 dark:bg-white/[0.03] dark:border-white/[0.08]">
                  <AlertCircle size={24} className="mx-auto text-slate-400 mb-2 dark:text-white/30" />
                  <p className="text-3xl font-bold text-slate-500 dark:text-white/40">{result.skipped}</p>
                  <p className="text-xs text-slate-500 font-medium mt-1 dark:text-white/40">Omitidos</p>
                </div>
              </div>

              {result.errors?.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <p className="text-sm font-semibold text-red-700 mb-2">{result.errors.length} errores:</p>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {result.errors.map((e: any, i: number) => (
                      <p key={i} className="text-xs text-red-600 font-mono">[{e.code}] {e.error}</p>
                    ))}
                  </div>
                </div>
              )}

              <button onClick={onClose}
                className="w-full bg-blue-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors">
                Cerrar
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Edición inline de un campo ───────────────────────────────────
function InlineEdit({
  value, onSave, className = '', placeholder = '—',
}: { value: string; onSave: (v: string) => Promise<void>; className?: string; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value || '')
  const [busy, setBusy] = useState(false)

  async function commit() {
    if (v === (value || '')) { setEditing(false); return }
    setBusy(true)
    try { await onSave(v); setEditing(false) }
    catch (e: any) { alert(e?.response?.data?.error || 'Error'); setV(value || '') }
    finally { setBusy(false) }
  }

  if (!editing) {
    return (
      <span onClick={() => setEditing(true)}
        className={`cursor-pointer hover:bg-blue-50 rounded px-1 -mx-1 transition-colors ${className}`}
        title="Click para editar">
        {value || <span className="text-slate-300 italic">{placeholder}</span>}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input autoFocus value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setV(value || ''); setEditing(false) } }}
        onBlur={commit} disabled={busy}
        className="border border-blue-300 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[140px]" />
      {busy && <span className="text-xs text-slate-400 dark:text-white/30">…</span>}
    </span>
  )
}

// ─── Barra de acciones masivas ────────────────────────────────────
function BulkActionsBar({
  selected, onClear, onApplied, departments,
}: { selected: number[]; onClear: () => void; onApplied: () => void; departments: any[] }) {
  const [field, setField] = useState<'department_id' | 'status' | 'position'>('department_id')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function apply() {
    if (!value && field !== 'position') { alert('Elija un valor'); return }
    if (!confirm(`¿Aplicar cambio a ${selected.length} empleado(s)?`)) return
    setBusy(true)
    try {
      const changes: any = { [field]: value }
      await api.patch('/api/employees/bulk', { ids: selected, changes })
      onApplied(); onClear(); setValue('')
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Error al aplicar cambios')
    } finally { setBusy(false) }
  }

  if (!selected.length) return null
  return (
    <div className="sticky top-0 z-10 bg-blue-600 text-white rounded-2xl shadow-lg px-5 py-3 flex items-center gap-3 flex-wrap">
      <span className="font-semibold text-sm">{selected.length} seleccionado(s)</span>
      <select value={field} onChange={e => { setField(e.target.value as any); setValue('') }}
        className="bg-blue-700 text-white border border-blue-400 rounded-lg px-2 py-1 text-sm">
        <option value="department_id">Cambiar departamento</option>
        <option value="status">Cambiar estado</option>
        <option value="position">Cambiar cargo</option>
      </select>

      {field === 'department_id' && (
        <select value={value} onChange={e => setValue(e.target.value)}
          className="bg-white text-slate-800 border border-blue-400 rounded-lg px-2 py-1 text-sm dark:bg-white/[0.04] dark:text-white/90">
          <option value="">(seleccionar)</option>
          {departments.map((d: any) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      )}
      {field === 'status' && (
        <select value={value} onChange={e => setValue(e.target.value)}
          className="bg-white text-slate-800 border border-blue-400 rounded-lg px-2 py-1 text-sm dark:bg-white/[0.04] dark:text-white/90">
          <option value="">(seleccionar)</option>
          <option value="active">Activo</option>
          <option value="inactive">Inactivo</option>
          <option value="suspended">Suspendido</option>
        </select>
      )}
      {field === 'position' && (
        <input value={value} onChange={e => setValue(e.target.value)} placeholder="Cargo"
          className="bg-white text-slate-800 border border-blue-400 rounded-lg px-2 py-1 text-sm dark:bg-white/[0.04] dark:text-white/90" />
      )}

      <button onClick={apply} disabled={busy}
        className="bg-white text-blue-700 px-3 py-1 rounded-lg text-sm font-semibold hover:bg-blue-50 disabled:opacity-60 dark:bg-white/[0.04]">
        {busy ? 'Aplicando...' : 'Aplicar'}
      </button>
      <button onClick={onClear} className="text-blue-200 hover:text-white text-sm">
        Cancelar
      </button>
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────
export default function EmpleadosPage() {
  const qc = useQueryClient()
  const { t } = useI18n()
  const [search, setSearch]       = useState('')
  const [status, setStatus]       = useState('active')
  const [dept, setDept]           = useState('')
  const [showImport, setImport]   = useState(false)
  const [selected, setSelected]   = useState<number[]>([])
  const displayMode = useDisplayMode()

  async function quickUpdate(id: number, field: string, value: string) {
    await api.patch(`/api/employees/${id}/quick`, { field, value })
    qc.invalidateQueries({ queryKey: ['employees'] })
  }

  const { data: deptsData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/employees/departments').then(r => r.data),
    staleTime: 300_000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['employees', search, status, dept],
    queryFn: () => employeesApi.list({
      search: search || undefined,
      status: status || 'all',
      dept:   dept   || undefined,
      limit:  500,
    }),
    staleTime: 30_000,
  })

  const employees = data?.data || []
  const active    = employees.filter((e: any) => e.status === 'active').length
  const inactive  = employees.filter((e: any) => e.status === 'inactive').length

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center text-white shadow-[0_8px_24px_-6px_rgba(34,211,238,0.5)]">
            <Users size={20} />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white tracking-tight">{t('nav.employees')}</h1>
            <p className="text-sm text-slate-500 dark:text-white/40">{data?.total || 0} · {active} {t('common.active').toLowerCase()}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <ExportDropdown employees={employees} />
          <button onClick={() => setImport(true)}
            className="flex items-center gap-2 border border-blue-200 text-blue-600 bg-blue-50 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-blue-100 transition-colors">
            <Upload size={15} /> {t('common.import')}
          </button>
          <Link href="/empleados/nuevo"
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors">
            <Plus size={16} /> {t('employees.new')}
          </Link>
        </div>
      </div>

      {/* Stats rápidas */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-slate-100 rounded-2xl px-5 py-4 shadow-sm dark:bg-white/[0.04] dark:border-white/[0.06]">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide dark:text-white/40">{t('common.all')}</p>
          <p className="text-3xl font-bold text-slate-700 mt-1 dark:text-white/80">{data?.total || 0}</p>
        </div>
        <div className="bg-green-50 border border-green-100 rounded-2xl px-5 py-4">
          <p className="text-xs font-medium text-green-600 uppercase tracking-wide">{t('common.active')}</p>
          <p className="text-3xl font-bold text-green-700 mt-1">{active}</p>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-2xl px-5 py-4 dark:bg-white/[0.03] dark:border-white/[0.08]">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide dark:text-white/40">{t('common.inactive')}</p>
          <p className="text-3xl font-bold text-slate-500 mt-1 dark:text-white/40">{inactive}</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3 items-center bg-white border border-slate-100 shadow-sm rounded-2xl px-5 py-4 dark:bg-white/[0.04] dark:border-white/[0.06]">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-white/30" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('employees.search_placeholder')}
            className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]" />
        </div>
        <select value={dept} onChange={e => setDept(e.target.value)}
          className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
          <option value="">{t('common.all')} {t('employees.department').toLowerCase()}</option>
          {(deptsData || []).map((d: any) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-white/[0.08]">
          <option value="">{t('common.all')}</option>
          <option value="active">{t('common.active')}</option>
          <option value="inactive">{t('common.inactive')}</option>
        </select>
      </div>

      {/* Barra de acciones masivas */}
      <BulkActionsBar selected={selected} onClear={() => setSelected([])}
        onApplied={() => qc.invalidateQueries({ queryKey: ['employees'] })}
        departments={deptsData || []} />

      {/* Tabla */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden dark:bg-white/[0.04] dark:border-white/[0.06]">
        {isLoading ? (
          <div className="text-center py-16 text-slate-400 dark:text-white/30">
            <Users size={32} className="mx-auto mb-3 opacity-40 animate-pulse" />
            Cargando empleados...
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-100 dark:bg-white/[0.03] dark:border-white/[0.06]">
              <tr>
                <th className="px-3 py-3 w-10">
                  <input type="checkbox"
                    checked={selected.length > 0 && selected.length === employees.length}
                    ref={el => { if (el) el.indeterminate = selected.length > 0 && selected.length < employees.length }}
                    onChange={e => setSelected(e.target.checked ? employees.map((e: any) => e.id) : [])}
                    className="w-4 h-4 accent-blue-600 cursor-pointer" />
                </th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium text-xs uppercase dark:text-white/60">Código</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium text-xs uppercase dark:text-white/60">Nombre</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium text-xs uppercase dark:text-white/60">Legajo</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium text-xs uppercase dark:text-white/60">Departamento</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium text-xs uppercase dark:text-white/60">Cargo</th>
                <th className="text-left px-4 py-3 text-slate-600 font-medium text-xs uppercase dark:text-white/60">Horario</th>
                <th className="text-center px-4 py-3 text-slate-600 font-medium text-xs uppercase dark:text-white/60">Estado</th>
                <th className="px-4 py-3 text-right text-slate-600 font-medium text-xs uppercase dark:text-white/60">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-white/[0.05]">
              {employees.map((emp: any) => {
                const isSel = selected.includes(emp.id)
                return (
                  <tr key={emp.id} className={`transition-colors ${isSel ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={isSel}
                        onChange={e => setSelected(prev => e.target.checked ? [...prev, emp.id] : prev.filter(x => x !== emp.id))}
                        className="w-4 h-4 accent-blue-600 cursor-pointer" />
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400 text-xs dark:text-white/30">{emp.code}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center text-blue-600 font-bold text-sm shrink-0">
                          {formatEmployeeInitials(emp, displayMode)}
                        </div>
                        <div>
                          {displayMode === 'code_only' ? (
                            <p className="font-mono font-semibold text-slate-900 dark:text-white">{emp.code}</p>
                          ) : (
                            <p className="font-semibold text-slate-900 flex items-center gap-1 dark:text-white">
                              {displayMode === 'code_name' && <span className="font-mono text-xs text-slate-400 dark:text-white/30">[{emp.code}]</span>}
                              <InlineEdit value={emp.first_name || ''} placeholder="Nombre"
                                onSave={v => quickUpdate(emp.id, 'first_name', v)} />
                              <InlineEdit value={emp.last_name || ''} placeholder="Apellido"
                                onSave={v => quickUpdate(emp.id, 'last_name', v)} />
                            </p>
                          )}
                          {emp.email && <p className="text-xs text-slate-400 dark:text-white/30">{emp.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-500 font-mono text-xs dark:text-white/40">
                      <InlineEdit value={emp.employee_number || ''} placeholder="—"
                        onSave={v => quickUpdate(emp.id, 'employee_number', v)} />
                    </td>
                    <td className="px-4 py-3 text-slate-600 text-sm dark:text-white/60">{emp.department || '—'}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs dark:text-white/40">
                      <InlineEdit value={emp.position || ''} placeholder="—"
                        onSave={v => quickUpdate(emp.id, 'position', v)} />
                    </td>
                    <td className="px-4 py-3 text-slate-500 font-mono text-xs dark:text-white/40">
                      {emp.check_in && emp.check_out
                        ? `${emp.check_in.slice(0,5)} – ${emp.check_out.slice(0,5)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${
                        emp.status === 'active'
                          ? 'bg-green-50 text-green-700 border border-green-200'
                          : 'bg-slate-100 text-slate-600 border border-slate-200'
                      }`}>
                        {emp.status === 'active' ? <UserCheck size={11} /> : <UserX size={11} />}
                        {emp.status === 'active' ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center gap-1.5 justify-end">
                        <Link href={`/analytics/${emp.id}`}
                          className="p-1.5 text-purple-400 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition-colors" title="Analytics">
                          <TrendingUp size={14} />
                        </Link>
                        <Link href={`/empleados/${emp.id}`}
                          className="px-3 py-1.5 text-blue-600 hover:text-blue-800 text-xs font-semibold hover:bg-blue-50 rounded-xl transition-colors">
                          Ver perfil →
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-14 text-slate-400 dark:text-white/30">
                    <Users size={36} className="mx-auto mb-3 opacity-30" />
                    <p className="font-medium">Sin resultados</p>
                    <p className="text-xs mt-1">Ajuste los filtros o importe empleados</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-slate-400 dark:text-white/30">{employees.length} empleados mostrados</p>

      {showImport && (
        <ImportModal
          onClose={() => setImport(false)}
          onDone={() => qc.invalidateQueries({ queryKey: ['employees'] })}
        />
      )}
    </div>
  )
}
