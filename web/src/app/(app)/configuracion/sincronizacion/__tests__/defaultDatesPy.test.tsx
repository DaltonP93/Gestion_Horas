import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import SincronizacionPage from '../page'
import { api } from '@/lib/api'

/**
 * Valores iniciales de fecha de Sincronización: deben ser días del calendario
 * de Paraguay, sin importar la zona del navegador. Se verifica lo que la
 * pantalla REALMENTE envía (cuerpos de los POST), sin tocar los campos.
 *
 * CI corre este archivo con TZ=UTC, America/Asuncion y Asia/Tokyo (la zona del
 * proceso es la del «navegador» de jsdom). HTTP simulado: ni API ni att2000.
 */
jest.mock('@/lib/api', () => ({ api: { get: jest.fn(), post: jest.fn() } }))
jest.mock('@/lib/useCurrentUser', () => ({
  // super_admin: ve también la herramienta histórica (Desde/Hasta de att2000).
  useCurrentUser: () => ({ id: 1, username: 'root', role: 'super_admin' }),
  hasRole: (user: { role: string }, ...roles: string[]) => roles.includes(user.role),
}))

const get = api.get as jest.Mock
const post = api.post as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  get.mockImplementation((url: string) => {
    if (url === '/api/devices/unmapped') return Promise.resolve({ data: { ok: true, items: [], totals: { marks: 0, today: 0 } } })
    if (url === '/api/devices/sync-status') return Promise.resolve({ data: { items: [] } })
    if (url === '/api/attendance/live') return Promise.resolve({ data: { stats: {} } })
    return Promise.resolve({ data: {} })
  })
  post.mockImplementation((url: string) => {
    if (url === '/api/devices/sync-jobs') return Promise.resolve({ status: 202, data: { ok: true, batch_id: '0123456789abcdef', jobs: [] } })
    if (url === '/api/devices/reprocess-unmapped') return Promise.resolve({ data: { ok: true } })
    if (url === '/api/sync/attendance') return Promise.resolve({ data: { imported: 0, skipped: 0, notFound: 0, total: 0 } })
    return Promise.resolve({ data: {} })
  })
  jest.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => { cleanup(); jest.restoreAllMocks(); jest.useRealTimers() })

const bodyOf = (url: string) => post.mock.calls.find((c) => c[0] === url)?.[1]

async function sentAt(instant: string) {
  jest.useFakeTimers({ now: new Date(instant) })
  render(<SincronizacionPage />)
  await act(async () => {})
  const manual = screen.getByText('Lectura manual y recuperación').closest('section')!
  const [readFrom, readTo] = Array.from(manual.querySelectorAll('input[type="date"]')).map((i) => (i as HTMLInputElement).value)
  fireEvent.click(screen.getByRole('button', { name: 'Leer relojes del rango' }))
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Reprocesar rango' }))
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: /Importar rango/ }))
  await act(async () => {})
  return {
    shown: { readFrom, readTo },
    syncJobs: { from: bodyOf('/api/devices/sync-jobs')?.from, to: bodyOf('/api/devices/sync-jobs')?.to },
    reprocess: bodyOf('/api/devices/reprocess-unmapped'),
    att2000: { dateFrom: bodyOf('/api/sync/attendance')?.dateFrom, dateTo: bodyOf('/api/sync/attendance')?.dateTo },
  }
}

// [instante UTC, hora de Paraguay, lectura desde, lectura hasta, mes desde]
const CASES: [string, string, string, string, string][] = [
  ['2026-10-06T15:00:00Z', '2026-10-06 12:00', '2026-10-03', '2026-10-06', '2026-10-01'],
  ['2026-10-07T00:00:00Z', '2026-10-06 21:00', '2026-10-03', '2026-10-06', '2026-10-01'],
  ['2026-10-07T02:59:59Z', '2026-10-06 23:59', '2026-10-03', '2026-10-06', '2026-10-01'],
  ['2026-10-07T03:00:00Z', '2026-10-07 00:00', '2026-10-04', '2026-10-07', '2026-10-01'],
  // Cambio de mes: en UTC y en Tokio ya es noviembre; en Paraguay sigue octubre.
  ['2026-10-31T16:00:00Z', '2026-10-31 13:00', '2026-10-28', '2026-10-31', '2026-10-01'],
  ['2026-11-01T01:00:00Z', '2026-10-31 22:00', '2026-10-28', '2026-10-31', '2026-10-01'],
  ['2026-11-01T03:00:00Z', '2026-11-01 00:00', '2026-10-29', '2026-11-01', '2026-11-01'],
]

describe(`Sincronización: fechas iniciales en calendario de Paraguay (TZ del navegador=${process.env.TZ || 'sin definir'})`, () => {
  it.each(CASES)('a las %s (Paraguay %s) envía lectura %s..%s y att2000 desde %s', async (instant, _py, rFrom, rTo, mFrom) => {
    const out = await sentAt(instant)
    expect(out).toEqual({
      shown: { readFrom: rFrom, readTo: rTo },
      syncJobs: { from: rFrom, to: rTo },
      reprocess: { from: rFrom, to: rTo },
      att2000: { dateFrom: `${mFrom} 00:00:00`, dateTo: `${rTo} 23:59:59` },
    })
  })
})
