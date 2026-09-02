/**
 * Candidatos — selector de alcance (FASE F+).
 *
 *   1. La lista muestra el alcance por fila (Sucursal / Empresa / Global).
 *   2. El formulario de alta incluye selects de empresa y sucursal, y los envía.
 *   3. Un 403 OUT_OF_SCOPE del writer se muestra sin romper el formulario.
 */

import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CandidatosPage from '../page'

const apiGet = jest.fn()
const apiPost = jest.fn()
const apiPatch = jest.fn()
jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
  },
}))

const CANDIDATES = [
  { id: 1, first_name: 'Ana', last_name: 'López', email: null, phone: null, position_applied: 'Analista', status: 'new', company_id: 3, branch_id: 5, converted_employee_id: null },
  { id: 2, first_name: 'Beto', last_name: 'Díaz', email: null, phone: null, position_applied: null, status: 'new', company_id: null, branch_id: null, converted_employee_id: null },
]
const COMPANIES = [{ id: 3, name: 'ACME' }]
const BRANCHES = [{ id: 5, name: 'Central' }]

function baseGet(url: string) {
  if (url === '/api/candidates') return Promise.resolve({ data: { data: CANDIDATES } })
  if (url === '/api/companies') return Promise.resolve({ data: { data: COMPANIES } })
  if (url === '/api/branches') return Promise.resolve({ data: BRANCHES })
  return Promise.reject(new Error('unexpected ' + url))
}

beforeEach(() => {
  apiGet.mockReset(); apiPost.mockReset(); apiPatch.mockReset()
  apiGet.mockImplementation((url: string) => baseGet(url))
})

test('la lista muestra el alcance por fila', async () => {
  render(<CandidatosPage />)
  expect(await screen.findByText('Ana López')).toBeInTheDocument()
  expect(screen.getByText('Suc.: Central')).toBeInTheDocument()
  expect(screen.getByText('Global')).toBeInTheDocument()
})

test('el alta envía company_id y branch_id seleccionados', async () => {
  apiPost.mockResolvedValue({ data: { id: 9 } })
  render(<CandidatosPage />)
  await screen.findByText('Ana López')
  await userEvent.click(screen.getByRole('button', { name: /^Nuevo$/ }))
  const dialog = await screen.findByText('Nuevo candidato')
  const modal = dialog.closest('div')!.parentElement as HTMLElement
  await userEvent.type(within(modal).getAllByRole('textbox')[0], 'Carla')
  await userEvent.type(within(modal).getAllByRole('textbox')[1], 'Ruiz')
  const selects = within(modal).getAllByRole('combobox')
  // Orden de selects: Estado, Empresa, Sucursal.
  await userEvent.selectOptions(selects[1], '3')
  await userEvent.selectOptions(selects[2], '5')
  await userEvent.click(within(modal).getByRole('button', { name: /Guardar/ }))

  await waitFor(() => expect(apiPost).toHaveBeenCalled())
  const payload = apiPost.mock.calls[0][1]
  expect(payload).toMatchObject({ company_id: 3, branch_id: 5, first_name: 'Carla', last_name: 'Ruiz' })
})

test('un 403 OUT_OF_SCOPE se muestra sin romper el formulario', async () => {
  apiPost.mockRejectedValue({ response: { status: 403, data: { code: 'OUT_OF_SCOPE', error: 'Un rol con alcance no puede crear un candidato sin empresa/sucursal' } } })
  render(<CandidatosPage />)
  await screen.findByText('Ana López')
  await userEvent.click(screen.getByRole('button', { name: /^Nuevo$/ }))
  const dialog = await screen.findByText('Nuevo candidato')
  const modal = dialog.closest('div')!.parentElement as HTMLElement
  await userEvent.type(within(modal).getAllByRole('textbox')[0], 'Carla')
  await userEvent.type(within(modal).getAllByRole('textbox')[1], 'Ruiz')
  await userEvent.click(within(modal).getByRole('button', { name: /Guardar/ }))
  expect(await screen.findByText(/no puede crear un candidato sin empresa/i)).toBeInTheDocument()
})
