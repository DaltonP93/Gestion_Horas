/**
 * EmployeeAssignments — historial organizativo (FASE F2, UI del writer append-only).
 *
 * Verifica el contrato de la superficie, no fabrica datos:
 *   1. Renderiza la línea de tiempo y marca la vigencia abierta como "Vigente".
 *   2. Se auto-oculta si el GET de historial falla (sin permiso / fuera de alcance).
 *   3. El writer fail-closed (503 PEOPLE_WRITES_DISABLED) muestra el aviso de sólo
 *      lectura sin romper la vista.
 *   4. El 409 ASSIGNMENT_OUT_OF_ORDER se traduce a un mensaje de fechas.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmployeeAssignments from '../EmployeeAssignments'

const apiGet = jest.fn()
const apiPost = jest.fn()

jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}))

jest.mock('@/lib/useCurrentUser', () => ({
  useCurrentUser: () => ({ role: 'admin' }),
}))

const HISTORY = {
  employee_id: 7,
  data: [
    {
      id: 22, branch_id: 1, department_id: 2, cost_center_id: null,
      job_title: 'Supervisor', reference_salary: 5000000,
      valid_from: '2026-03-01', valid_to: null, change_reason: 'promoción',
      branch_name: 'Central', department_name: 'Operaciones', cost_center_name: null,
    },
    {
      id: 21, branch_id: 1, department_id: 3, cost_center_id: null,
      job_title: 'Analista', reference_salary: 3500000,
      valid_from: '2025-01-01', valid_to: '2026-02-28', change_reason: null,
      branch_name: 'Central', department_name: 'Soporte', cost_center_name: null,
    },
  ],
}

// GET de catálogos de referencia (branches/departments/cost-centers/job-titles):
// devolvemos vacíos; no son el foco de estas pruebas.
function routeGet(url: string) {
  if (url.startsWith('/api/assignments/employee/')) return Promise.resolve({ data: HISTORY })
  if (url === '/api/branches') return Promise.resolve({ data: [] })
  if (url === '/api/departments') return Promise.resolve({ data: [] })
  if (url === '/api/cost-centers') return Promise.resolve({ data: { data: [] } })
  if (url === '/api/catalogs/job-titles') return Promise.resolve({ data: { data: [] } })
  return Promise.reject(new Error('unexpected url ' + url))
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EmployeeAssignments employeeId={7} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  apiGet.mockReset()
  apiPost.mockReset()
})

test('renderiza el historial y marca la vigencia abierta como Vigente', async () => {
  apiGet.mockImplementation((url: string) => routeGet(url))
  renderPanel()

  expect(await screen.findByText('Historial organizativo')).toBeInTheDocument()
  expect(screen.getByText('Supervisor')).toBeInTheDocument()
  expect(screen.getByText('Analista')).toBeInTheDocument()
  // La vigencia abierta muestra "Vigente"; la cerrada muestra su valid_to.
  expect(screen.getByText('Vigente')).toBeInTheDocument()
  expect(screen.getByText(/01\/03\/2026 → Vigente/)).toBeInTheDocument()
  expect(screen.getByText(/01\/01\/2025 → 28\/02\/2026/)).toBeInTheDocument()
})

test('se auto-oculta si el GET de historial falla (403/404)', async () => {
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/api/assignments/employee/')) {
      return Promise.reject({ response: { status: 404 } })
    }
    return routeGet(url)
  })
  const { container } = renderPanel()
  await waitFor(() => expect(container).toBeEmptyDOMElement())
})

test('el writer fail-closed (503) muestra el aviso de sólo lectura', async () => {
  apiGet.mockImplementation((url: string) => routeGet(url))
  apiPost.mockRejectedValue({ response: { status: 503, data: { code: 'PEOPLE_WRITES_DISABLED' } } })
  renderPanel()

  await screen.findByText('Historial organizativo')
  await userEvent.click(screen.getByRole('button', { name: /Nueva asignación/ }))
  const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
  await userEvent.type(dateInput, '2026-04-01')
  await userEvent.type(screen.getByPlaceholderText(/Analista, Supervisor/), 'Jefe')
  await userEvent.click(screen.getByRole('button', { name: /Registrar vigencia/ }))

  expect(await screen.findByText(/modo sólo lectura/i)).toBeInTheDocument()
})

test('el 409 fuera de orden se traduce a un mensaje de fechas', async () => {
  apiGet.mockImplementation((url: string) => routeGet(url))
  apiPost.mockRejectedValue({ response: { status: 409, data: { code: 'ASSIGNMENT_OUT_OF_ORDER' } } })
  renderPanel()

  await screen.findByText('Historial organizativo')
  await userEvent.click(screen.getByRole('button', { name: /Nueva asignación/ }))
  const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
  await userEvent.type(dateInput, '2026-04-01')
  await userEvent.type(screen.getByPlaceholderText(/Analista, Supervisor/), 'Jefe')
  await userEvent.click(screen.getByRole('button', { name: /Registrar vigencia/ }))

  expect(await screen.findByText(/posterior a la vigencia actualmente abierta/i)).toBeInTheDocument()
})
