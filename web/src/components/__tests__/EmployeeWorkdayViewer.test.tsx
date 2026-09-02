/**
 * EmployeeWorkdayViewer — jornada efectiva por fecha (FASE F3, read-only).
 *
 *   1. schema_state 'complete' con horario → muestra origen y campos conocidos.
 *   2. schema_state 'incomplete' → muestra el mensaje controlado (no un error crudo).
 *   3. schema_state 'missing'/fallback → indica cálculo histórico.
 *   4. 404 (fuera de alcance) → aviso controlado, no rompe.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EmployeeWorkdayViewer from '../EmployeeWorkdayViewer'

const apiGet = jest.fn()
jest.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => apiGet(...a) } }))

function renderAndConsult() {
  render(<EmployeeWorkdayViewer employeeId={5} />)
  return userEvent.click(screen.getByRole('button', { name: /Consultar/ }))
}

beforeEach(() => apiGet.mockReset())

test('complete: muestra origen y campos conocidos', async () => {
  apiGet.mockResolvedValue({ data: {
    employee_id: 5, date: '2026-05-04', schema_state: 'complete',
    workday: { source: 'schedule_history', work_regime: 'full_time', daily_target_minutes: 480, check_in: '08:00:00', check_out: '17:00:00' },
  } })
  await renderAndConsult()
  expect(await screen.findByText('Horario con vigencia')).toBeInTheDocument()
  expect(screen.getByText('8:00 h')).toBeInTheDocument()
  expect(screen.getByText('08:00')).toBeInTheDocument()
})

test('incomplete: muestra el mensaje controlado, no un error crudo', async () => {
  apiGet.mockResolvedValue({ data: {
    employee_id: 5, date: '2026-05-04', schema_state: 'incomplete', workday: null,
    message: 'Esquema de jornada parcialmente migrado (falta alguna columna de 072/073/075).',
  } })
  await renderAndConsult()
  expect(await screen.findByText(/parcialmente migrado/i)).toBeInTheDocument()
})

test('missing/fallback: indica cálculo histórico', async () => {
  apiGet.mockResolvedValue({ data: {
    employee_id: 5, date: '2026-05-04', schema_state: 'missing',
    workday: { source: 'historical_fallback', config: null },
  } })
  await renderAndConsult()
  expect(await screen.findByText('Histórico (fallback)')).toBeInTheDocument()
  expect(screen.getByText(/cálculo histórico/i)).toBeInTheDocument()
})

test('404 fuera de alcance: aviso controlado', async () => {
  apiGet.mockRejectedValue({ response: { status: 404 } })
  await renderAndConsult()
  expect(await screen.findByText(/fuera de tu alcance/i)).toBeInTheDocument()
})
