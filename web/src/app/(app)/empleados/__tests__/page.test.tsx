/**
 * Listado de empleados — filtro inicial y contadores.
 *
 * Antes el filtro de estado arrancaba en "Activos" y las tarjetas se
 * derivaban de la página cargada, así que "Inactivos" mostraba 0 de entrada
 * y "Todos" repetía el total ya filtrado. Ahora el filtro arranca en "Todos"
 * y las tres tarjetas leen `counts` del backend.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmpleadosPage from '../page'

const listMock = jest.fn()

jest.mock('@/lib/api', () => ({
  api: { get: jest.fn(() => new Promise(() => {})), patch: jest.fn() },
  employeesApi: { list: (...args: unknown[]) => listMock(...args) },
}))

jest.mock('@/lib/useSettings', () => ({ useDisplayMode: () => 'full' }))

jest.mock('@/i18n/I18nProvider', () => ({
  useI18n: () => ({
    t: (k: string) => ({
      'nav.employees': 'Empleados',
      'common.all': 'Todos',
      'common.active': 'Activos',
      'common.inactive': 'Inactivos',
      'common.import': 'Importar',
      'employees.new': 'Nuevo',
      'employees.department': 'Departamento',
      'employees.search_placeholder': 'Buscar',
    }[k] ?? k),
  }),
}))

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EmpleadosPage />
    </QueryClientProvider>
  )
}

/**
 * Lee el número de una tarjeta de stats por su rótulo. Va acotado a la grilla
 * porque "Todos"/"Inactivos" también son opciones de los selects de filtro.
 */
function cardValue(label: string) {
  const grid = screen.getByTestId('stats-empleados')
  const heading = within(grid).getByText(label)
  return heading.parentElement?.querySelector('p:last-child')?.textContent
}

beforeEach(() => {
  jest.clearAllMocks()
  listMock.mockResolvedValue({
    data: [{ id: 1, code: '3081', full_name: 'Ana Gómez', status: 'active' }],
    total: 42,
    counts: { all: 50, active: 42, inactive: 8 },
  })
})

describe('EmpleadosPage — filtro y contadores', () => {
  it('arranca con el filtro de estado en Todos', async () => {
    renderPage()
    await waitFor(() => expect(listMock).toHaveBeenCalled())

    const select = screen.getByDisplayValue('Todos') as HTMLSelectElement
    expect(select.value).toBe('')
    // Y la primera consulta pide todos los estados, no sólo activos.
    expect(listMock.mock.calls[0][0]).toMatchObject({ status: 'all' })
  })

  it('las tarjetas leen counts del backend, no la página cargada', async () => {
    renderPage()
    await waitFor(() => expect(listMock).toHaveBeenCalled())

    // La página trae 1 empleado activo; las tarjetas deben mostrar el padrón.
    await waitFor(() => expect(cardValue('Todos')).toBe('50'))
    expect(cardValue('Activos')).toBe('42')
    expect(cardValue('Inactivos')).toBe('8')
  })

  it('filtrar por activos no pone Inactivos en 0', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(listMock).toHaveBeenCalled())

    listMock.mockResolvedValue({
      data: [{ id: 1, code: '3081', full_name: 'Ana Gómez', status: 'active' }],
      total: 42,
      counts: { all: 50, active: 42, inactive: 8 },
    })
    await user.selectOptions(screen.getByDisplayValue('Todos'), 'active')

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }))
    )
    await waitFor(() => expect(cardValue('Inactivos')).toBe('8'))
    expect(cardValue('Todos')).toBe('50')
  })

  it('avisa cuando el listado quedó truncado por el límite', async () => {
    listMock.mockResolvedValue({
      data: new Array(500).fill(0).map((_, i) => ({ id: i, code: String(i), full_name: `E${i}`, status: 'active' })),
      total: 1200,
      counts: { all: 1200, active: 1100, inactive: 100 },
    })
    renderPage()

    await waitFor(() =>
      expect(screen.getByText(/500 de 1200 empleados mostrados/)).toBeInTheDocument()
    )
  })

  it('sin counts en la respuesta muestra ceros, no NaN', async () => {
    listMock.mockResolvedValue({ data: [], total: 0 })
    renderPage()
    await waitFor(() => expect(listMock).toHaveBeenCalled())

    await waitFor(() => expect(cardValue('Todos')).toBe('0'))
    expect(cardValue('Activos')).toBe('0')
    expect(cardValue('Inactivos')).toBe('0')
  })
})
