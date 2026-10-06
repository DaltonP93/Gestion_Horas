import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import SincronizacionPage from '../page'
import { api } from '@/lib/api'

jest.mock('@/lib/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }))
jest.mock('@/lib/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'admin', role: 'admin' }),
  hasRole: (user: { role: string }, ...roles: string[]) => roles.includes(user.role),
}))

const get = api.get as jest.Mock
const post = api.post as jest.Mock
const batch = '0123456789abcdef'
let jobs: Record<number, any>
let failStatus: boolean

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  failStatus = false
  jobs = {
    101: { id: 101, batch_id: batch, device_id: 1, device_name: 'Comedor', status: 'queued' },
    102: { id: 102, batch_id: batch, device_id: 2, device_name: 'Oficina', status: 'queued' },
  }
  get.mockImplementation((url: string) => {
    if (/\/sync-jobs\/\d+$/.test(url)) {
      if (failStatus) return Promise.reject(new Error('Sin conexión'))
      return Promise.resolve({ data: { ok: true, job: jobs[Number(url.split('/').pop())] } })
    }
    if (url === '/api/devices/unmapped') return Promise.resolve({ data: { items: [], totals: { marks: 0, today: 0 } } })
    if (url === '/api/devices/sync-status') return Promise.resolve({ data: { items: [] } })
    if (url === '/api/attendance/live') return Promise.resolve({ data: { stats: {} } })
    return Promise.resolve({ data: {} })
  })
  post.mockImplementation((url: string) => {
    if (url.endsWith('/cancel')) return Promise.resolve({ data: { ok: true } })
    if (url === '/api/devices/sync-jobs') return Promise.resolve({ status: 202, data: {
      ok: true, batch_id: batch, jobs: Object.values(jobs).map(({ id, device_id }) => ({ id, device_id })),
    } })
    // Control del camino anterior: termina sin error, pero no ofrece seguimiento.
    return Promise.resolve({ data: { ok: true, devices: 2, totals: {}, results: [] } })
  })
})

afterEach(() => { cleanup(); jest.useRealTimers() })

async function openPage() {
  render(<SincronizacionPage />)
  await screen.findByRole('button', { name: 'Leer relojes del rango' })
  const section = screen.getByText('Lectura manual y recuperación').closest('section')!
  const inputs = section.querySelectorAll('input[type="date"]')
  fireEvent.change(inputs[0], { target: { value: '2026-10-01' } })
  fireEvent.change(inputs[1], { target: { value: '2026-10-03' } })
  // Terminan las consultas iniciales antes de medir las actualizaciones del lote.
  await act(async () => {})
  return section
}

async function startRead() {
  const section = await openPage()
  fireEvent.click(screen.getByRole('button', { name: 'Leer relojes del rango' }))
  await act(async () => {})
  return section
}

async function poll() { await act(async () => { jest.advanceTimersByTime(3000) }) }

describe('Lectura manual: cola persistente existente (reproducciones sobre 40e86e0)', () => {
  it('encola una sola vez y muestra pendiente; aceptar el trabajo no significa completar la lectura', async () => {
    const section = await startRead()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/api/devices/sync-jobs', {
      from: '2026-10-01', to: '2026-10-03', attempts: 2,
    }, { timeout: 15000 })
    expect(within(section).getAllByText('En cola')).toHaveLength(2)
    expect(within(section).queryByText('Lectura finalizada')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Leyendo relojes/ })).toBeDisabled()
  })

  it('muestra resultados independientes: éxito, parcial y error; refresca estado y pendientes', async () => {
    jobs[101] = { ...jobs[101], status: 'partial', result: { total_read: 20, in_range: 8, imported: 5, skipped: 1, notFound: 2 } }
    jobs[102] = { ...jobs[102], status: 'success', result: { total_read: 0, in_range: 0, imported: 0, skipped: 0, notFound: 0 } }
    jobs[103] = { id: 103, batch_id: batch, device_id: 3, device_name: 'Portería', status: 'error', error: 'No respondió el reloj' }
    const section = await startRead()
    expect(within(section).getByText('Lectura parcial')).toBeInTheDocument()
    expect(within(section).getByText('Lectura finalizada')).toBeInTheDocument()
    expect(within(section).getByText('Error de lectura')).toBeInTheDocument()
    expect(within(section).getByText('No respondió el reloj')).toBeInTheDocument()
    expect(within(section).getByText(/No se confirma la cobertura completa del período/)).toBeInTheDocument()
    const comedor = within(section).getByRole('listitem', { name: 'Comedor' })
    expect(within(comedor).getByText(/Importadas: 5/)).toBeInTheDocument()
    expect(within(comedor).getByText(/Sin empleado: 2/)).toBeInTheDocument()
    expect(get.mock.calls.filter(([url]) => url === '/api/devices/sync-status')).toHaveLength(2)
    expect(get.mock.calls.filter(([url]) => url === '/api/attendance/live')).toHaveLength(2)
    expect(get.mock.calls.filter(([url]) => url === '/api/sync/diagnostics')).toHaveLength(2)
    expect(get).toHaveBeenCalledWith('/api/devices/unmapped')
  })

  it('una consulta fallida no cambia el trabajo a error ni vuelve a encolar', async () => {
    failStatus = true
    const section = await startRead()
    expect(within(section).getByText(/No se pudo actualizar el estado/)).toBeInTheDocument()
    expect(within(section).queryByText('Error de lectura')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Leyendo relojes/ })).toBeDisabled()
    failStatus = false
    jobs[101] = { ...jobs[101], status: 'running', progress: 'Recibiendo marcaciones…' }
    await poll()
    expect(within(section).getByText('Recibiendo marcaciones…')).toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('solicitar cancelación no la declara terminada hasta que el servidor lo confirme', async () => {
    jobs[102] = { ...jobs[102], status: 'success' }
    const section = await startRead()
    fireEvent.click(within(section).getByRole('button', { name: 'Cancelar lectura de Comedor' }))
    await act(async () => {})
    expect(post).toHaveBeenLastCalledWith('/api/devices/sync-jobs/101/cancel')
    expect(within(section).getByText('Cancelación solicitada')).toBeInTheDocument()
    expect(within(section).queryByText('Lectura cancelada')).not.toBeInTheDocument()
    jobs[101] = { ...jobs[101], status: 'cancelled' }
    await poll()
    expect(within(section).getByText('Lectura cancelada')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Leer relojes del rango' })).toBeEnabled()
  })

  it('al salir detiene las consultas, sin cancelar trabajos del servidor', async () => {
    await startRead()
    expect(get.mock.calls.some(([url]) => url === '/api/devices/sync-jobs/101')).toBe(true)
    cleanup()
    const queries = get.mock.calls.length
    await poll()
    expect(get).toHaveBeenCalledTimes(queries)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('un rango invertido se rechaza sin enviar una lectura', async () => {
    const section = await openPage()
    const inputs = section.querySelectorAll('input[type="date"]')
    fireEvent.change(inputs[1], { target: { value: '2026-09-30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Leer relojes del rango' }))
    await act(async () => {})
    expect(within(section).getByText(/Desde debe ser anterior o igual a Hasta/)).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('un rechazo al encolar se informa y no inicia consultas ni se reintenta solo', async () => {
    post.mockResolvedValue({ data: { ok: false, error: 'No hay relojes con IP configurada' } })
    const section = await startRead()
    expect(within(section).getByText('No hay relojes con IP configurada')).toBeInTheDocument()
    await poll()
    expect(post).toHaveBeenCalledTimes(1)
    expect(get.mock.calls.some(([url]) => /\/sync-jobs\/\d+$/.test(url))).toBe(false)
  })

  it('no transforma un resultado sin contadores en cero marcaciones', async () => {
    jobs[101] = { ...jobs[101], status: 'success' }
    const section = await startRead()
    const comedor = within(section).getByRole('listitem', { name: 'Comedor' })
    expect(within(comedor).getByText(/Leídas: — · En rango: — · Importadas: —/)).toBeInTheDocument()
    expect(within(comedor).queryByText(/Importadas: 0/)).not.toBeInTheDocument()
  })

  it('una respuesta de otro trabajo no se acepta como confirmación de éxito', async () => {
    jobs[101] = { ...jobs[101], id: 999, status: 'success' }
    const section = await startRead()
    expect(within(section).getByText(/No se pudo actualizar el estado/)).toBeInTheDocument()
    expect(within(section).queryByText('Lectura finalizada')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Leyendo relojes/ })).toBeDisabled()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('si se pierde la respuesta del alta no encola automáticamente de nuevo', async () => {
    post.mockRejectedValue({ code: 'ECONNABORTED' })
    const section = await startRead()
    expect(within(section).getByText(/Verifique si ya hay una lectura en curso antes de repetirla/)).toBeInTheDocument()
    await poll()
    expect(post).toHaveBeenCalledTimes(1)
  })
})
