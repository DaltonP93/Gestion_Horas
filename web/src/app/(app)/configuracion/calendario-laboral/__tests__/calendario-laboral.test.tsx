/**
 * Calendario laboral — autoría + excepciones (FASE F+, UI de writers fail-closed).
 *
 *   1. Un rol de gestión ve "Nuevo calendario"; uno sin gestión, no.
 *   2. La lista muestra el alcance (Global / Empresa / Sucursal).
 *   3. El writer fail-closed (503) al crear muestra el aviso de sólo lectura.
 *   4. Abrir "Excepciones" carga y lista las excepciones del calendario.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CalendarioLaboralPage from '../page'

const apiGet = jest.fn()
const apiPost = jest.fn()
jest.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => apiGet(...a), post: (...a: unknown[]) => apiPost(...a) },
}))
let role = 'admin'
jest.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ role }) }))

const CALS = [
  { id: 1, code: 'STD', name: 'Estándar', company_id: null, branch_id: null, timezone: 'America/Asuncion', week_start: 0, work_days: '1,2,3,4,5', active: 1, valid_from: '2026-01-01', valid_to: null },
  { id: 2, code: 'SUC-A', name: 'Sucursal A', company_id: 3, branch_id: 5, timezone: 'America/Asuncion', week_start: 0, work_days: '1,2,3,4,5,6', active: 1, valid_from: '2026-01-01', valid_to: null },
]
const EXCEPTIONS = [
  { id: 11, calendar_id: 1, day: '2026-05-01', kind: 'nonworking', label: 'Día del trabajador' },
]

function baseGet(url: string) {
  if (url === '/api/labor-calendars') return Promise.resolve({ data: { data: CALS } })
  if (url === '/api/companies') return Promise.resolve({ data: { data: [] } })
  if (url === '/api/branches') return Promise.resolve({ data: [] })
  if (url.endsWith('/exceptions')) return Promise.resolve({ data: { calendar_id: 1, data: EXCEPTIONS } })
  return Promise.reject(new Error('unexpected ' + url))
}

beforeEach(() => {
  role = 'admin'
  apiGet.mockReset(); apiPost.mockReset()
  apiGet.mockImplementation((url: string) => baseGet(url))
})

test('rol de gestión ve Nuevo calendario y el alcance en la lista', async () => {
  render(<CalendarioLaboralPage />)
  expect(await screen.findByRole('button', { name: /Nuevo calendario/ })).toBeInTheDocument()
  expect(await screen.findByText('Estándar')).toBeInTheDocument()
  expect(screen.getByText('Global')).toBeInTheDocument()
  expect(screen.getByText('Sucursal #5')).toBeInTheDocument()
})

test('un rol sin gestión no ve acciones de escritura', async () => {
  role = 'employee'
  render(<CalendarioLaboralPage />)
  await screen.findByText('Estándar')
  expect(screen.queryByRole('button', { name: /Nuevo calendario/ })).not.toBeInTheDocument()
})

test('el writer fail-closed (503) al crear muestra el aviso de sólo lectura', async () => {
  apiPost.mockRejectedValue({ response: { status: 503, data: { code: 'CALENDAR_WRITES_DISABLED' } } })
  render(<CalendarioLaboralPage />)
  await userEvent.click(await screen.findByRole('button', { name: /Nuevo calendario/ }))
  await userEvent.type(screen.getByPlaceholderText('ej: STD-2026'), 'NUEVO')
  await userEvent.type(screen.getByPlaceholderText('ej: Estándar 2026'), 'Nuevo cal')
  const dates = document.querySelectorAll('input[type="date"]')
  await userEvent.type(dates[0] as HTMLInputElement, '2026-06-01')
  await userEvent.click(screen.getByRole('button', { name: /Crear calendario/ }))
  expect(await screen.findByText(/modo sólo lectura durante el rollout/i)).toBeInTheDocument()
})

test('abrir Excepciones carga y lista las excepciones del calendario', async () => {
  render(<CalendarioLaboralPage />)
  await screen.findByText('Estándar')
  await userEvent.click(screen.getAllByRole('button', { name: /Excepciones/ })[0])
  expect(await screen.findByText('Día del trabajador')).toBeInTheDocument()
  expect(screen.getByText('2026-05-01')).toBeInTheDocument()
})
