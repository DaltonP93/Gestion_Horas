/**
 * Capacitaciones — edición de curso (cableado del PUT ya existente).
 *
 *   1. "Editar" abre el modal pre-cargado y guarda con PUT /api/courses/:id.
 *   2. "Nuevo curso" sigue creando con POST (no regresiona).
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CapacitacionesPage from '../page'

const apiGet = jest.fn()
const apiPost = jest.fn()
const apiPut = jest.fn()
jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    put: (...a: unknown[]) => apiPut(...a),
    delete: jest.fn(),
  },
}))
jest.mock('@/lib/useCurrentUser', () => ({ useCurrentUser: () => ({ role: 'admin' }) }))

const COURSE = {
  id: 7, title: 'Seguridad básica', description: 'Curso intro', category: 'seguridad',
  duration_hours: 2, mandatory: 1, valid_until: '2026-12-31T00:00:00.000Z', resource_url: 'http://x',
  total_assigned: 3, total_completed: 1,
}

function baseGet(url: string) {
  if (url === '/api/courses') return Promise.resolve({ data: { data: [COURSE] } })
  if (url === '/api/employees/departments') return Promise.resolve({ data: [] })
  return Promise.resolve({ data: { data: [] } })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><CapacitacionesPage /></QueryClientProvider>)
}

beforeEach(() => {
  apiGet.mockReset(); apiPost.mockReset(); apiPut.mockReset()
  apiGet.mockImplementation((url: string) => baseGet(url))
})

test('"Editar" abre el modal pre-cargado y guarda con PUT', async () => {
  apiPut.mockResolvedValue({ data: { ok: true } })
  renderPage()
  expect(await screen.findByText('Seguridad básica')).toBeInTheDocument()
  await userEvent.click(screen.getByTitle('Editar curso'))
  // Modal en modo edición, título pre-cargado.
  expect(await screen.findByText('Editar curso')).toBeInTheDocument()
  const titleInput = screen.getByDisplayValue('Seguridad básica') as HTMLInputElement
  await userEvent.clear(titleInput)
  await userEvent.type(titleInput, 'Seguridad avanzada')
  await userEvent.click(screen.getByRole('button', { name: /^Guardar$/ }))

  await waitFor(() => expect(apiPut).toHaveBeenCalled())
  expect(apiPut.mock.calls[0][0]).toBe('/api/courses/7')
  expect(apiPut.mock.calls[0][1]).toMatchObject({ title: 'Seguridad avanzada' })
  expect(apiPost).not.toHaveBeenCalled()
})

test('"Nuevo curso" sigue creando con POST', async () => {
  apiPost.mockResolvedValue({ data: { id: 9 } })
  renderPage()
  await screen.findByText('Seguridad básica')
  await userEvent.click(screen.getByRole('button', { name: /Nuevo curso/ }))
  expect(await screen.findByRole('heading', { name: 'Nuevo curso' })).toBeInTheDocument()
  await userEvent.type(screen.getByPlaceholderText('Título *'), 'Otro curso')
  await userEvent.click(screen.getByRole('button', { name: /^Crear$/ }))
  await waitFor(() => expect(apiPost).toHaveBeenCalled())
  expect(apiPost.mock.calls[0][0]).toBe('/api/courses')
})
