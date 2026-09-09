/**
 * Nómina base — ciclo de vida de períodos (FASE F+, UI de writers fail-closed).
 *
 * Verifica el contrato de la superficie sin fabricar montos:
 *   1. Un rol NO global de RR.HH. no ve las acciones de escritura.
 *   2. Un rol global ve las transiciones válidas según el estado (draft→preview).
 *   3. El writer fail-closed (503) muestra el aviso de sólo lectura sin romper.
 *   4. La previsualización muestra el disclaimer NO OFICIAL y los agregados.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NominaBasePage from '../page'

const apiGet = jest.fn()
const apiPost = jest.fn()
jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}))

let role = 'admin'
jest.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ role }) }))

const PERIODS = [
  { id: 1, code: '2026-03', label: 'Marzo 2026', period_start: '2026-03-01', period_end: '2026-03-31', status: 'draft', is_official: 0 },
  { id: 2, code: '2026-02', label: 'Febrero 2026', period_start: '2026-02-01', period_end: '2026-02-28', status: 'closed', is_official: 0, closed_at: '2026-03-05' },
]

function baseGet(url: string) {
  if (url === '/api/payroll-base/periods') return Promise.resolve({ data: { data: PERIODS } })
  if (url === '/api/payroll-base/integrations') return Promise.resolve({ data: { data: [] } })
  if (url.endsWith('/preview')) {
    return Promise.resolve({ data: {
      official: false,
      disclaimer: 'PREVISUALIZACIÓN NO OFICIAL. No es una liquidación legal ni un cálculo de haberes.',
      period: { id: 1, code: '2026-03', status: 'draft' },
      headcount: { by_status: { active: 42 }, active: 42 },
      active_concepts: { earnings: 3, deductions: 2 },
    } })
  }
  return Promise.reject(new Error('unexpected ' + url))
}

beforeEach(() => {
  role = 'admin'
  apiGet.mockReset(); apiPost.mockReset()
  apiGet.mockImplementation((url: string) => baseGet(url))
})

test('un rol NO global de RR.HH. no ve acciones de escritura', async () => {
  role = 'manager'
  render(<NominaBasePage />)
  expect(await screen.findByText('Marzo 2026')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Nuevo período/ })).not.toBeInTheDocument()
  // No hay botón de transición (Previsualización sí, es lectura).
  expect(screen.queryByRole('button', { name: /Previsualización$/ })).not.toBeInTheDocument()
})

test('un rol global ve la transición válida draft→preview', async () => {
  render(<NominaBasePage />)
  expect(await screen.findByRole('button', { name: /Nuevo período/ })).toBeInTheDocument()
  await screen.findByText('Marzo 2026') // esperar a que carguen las filas
  // La fila draft (única) ofrece pasar a Previsualización; la cerrada no ofrece ninguna.
  expect(screen.getAllByTitle('Pasar a Previsualización')).toHaveLength(1)
})

test('el writer fail-closed (503) muestra el aviso de sólo lectura', async () => {
  apiPost.mockRejectedValue({ response: { status: 503, data: { code: 'PAYROLL_WRITES_DISABLED' } } })
  render(<NominaBasePage />)
  await screen.findByText('Marzo 2026')
  await userEvent.click(screen.getByTitle('Pasar a Previsualización'))
  expect(await screen.findByText(/modo sólo lectura durante el rollout/i)).toBeInTheDocument()
})

test('la previsualización muestra el disclaimer NO OFICIAL y los agregados', async () => {
  render(<NominaBasePage />)
  await screen.findByText('Marzo 2026')
  await userEvent.click(screen.getAllByTitle('Previsualización NO OFICIAL')[0])
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/NO OFICIAL/i)).toBeInTheDocument()
  expect(within(dialog).getByText('42')).toBeInTheDocument()
  expect(within(dialog).getByText('3')).toBeInTheDocument()
})
