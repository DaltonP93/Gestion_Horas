/**
 * Selector de cargo en la ficha del empleado (PR 3).
 *
 * El campo pasó de texto libre a un `<select>` alimentado por el catálogo
 * `job_titles`. El riesgo del cambio es silencioso: un `<select>` con un
 * value que no está entre sus opciones se renderiza en blanco, así que una
 * ficha cuyo cargo fue desactivado —o cargada antes de la migración—
 * perdería el cargo al guardar sin que nadie lo note.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmployeeEditModal from '../EmployeeEditModal'

const updateMock = jest.fn()
const getMock = jest.fn()
const apiGet = jest.fn()
const apiPost = jest.fn()

jest.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  employeesApi: {
    update: (...args: unknown[]) => updateMock(...args),
    get: (...args: unknown[]) => getMock(...args),
  },
}))

const FULL_CAPS = { personal_update: true, legal_view: true, legal_update: true }

const EMPLOYEE = {
  id: 459,
  first_name: 'Ana',
  last_name: 'Gómez',
  hire_date: '2020-01-15',
  position: 'Analista',
  salary_base: '3500000.00',
  pay_type: 'mensualizado',
}

const CATALOG = [
  { value: 'Analista', label: 'Analista', active: true },
  { value: 'Operario', label: 'Operario', active: true },
]

/** Responde cada catálogo por URL; el resto queda pendiente a propósito. */
function primeCatalogs(jobTitles: unknown[] = CATALOG) {
  apiGet.mockImplementation((url: string) => {
    if (String(url).includes('/api/catalogs/job-titles')) {
      return Promise.resolve({ data: { data: jobTitles } })
    }
    return new Promise(() => {})
  })
}

function renderModal(props: Partial<React.ComponentProps<typeof EmployeeEditModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EmployeeEditModal
        open
        onClose={jest.fn()}
        employee={EMPLOYEE}
        caps={FULL_CAPS}
        currentUserRole="admin"
        onSaved={jest.fn()}
        {...props}
      />
    </QueryClientProvider>
  )
}

const positionSelect = () => screen.getByLabelText('Cargo') as HTMLSelectElement

/** Espera a que el catálogo haya llegado (una opción concreta presente). */
async function awaitCatalog(label = 'Operario') {
  await waitFor(() =>
    expect(
      Array.from(positionSelect().options).some(o => o.textContent === label)
    ).toBe(true)
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  updateMock.mockResolvedValue({ message: 'ok', changed: [], employee: EMPLOYEE })
  primeCatalogs()
})

describe('selector de cargo', () => {
  it('ofrece los cargos activos del catálogo', async () => {
    renderModal()
    await awaitCatalog()

    const labels = Array.from(positionSelect().options).map(o => o.textContent)
    expect(labels).toEqual(['Sin cargo', 'Analista', 'Operario'])
    expect(positionSelect().value).toBe('Analista')
  })

  it('deja elegir otro cargo y lo envía al guardar', async () => {
    const user = userEvent.setup()
    renderModal()
    await awaitCatalog()

    await user.selectOptions(positionSelect(), 'Operario')
    await user.click(screen.getByRole('button', { name: /^guardar/i }))

    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    expect(updateMock.mock.calls[0][1]).toMatchObject({ position: 'Operario' })
  })

  it('conserva un cargo que ya no está en el catálogo', async () => {
    // El cargo de la ficha fue desactivado: no viene en la lista.
    primeCatalogs([{ value: 'Operario', label: 'Operario', active: true }])
    renderModal()

    await awaitCatalog()
    // Sigue seleccionado, y se marca como fuera del catálogo.
    expect(positionSelect().value).toBe('Analista')
    expect(
      Array.from(positionSelect().options).map(o => o.textContent)
    ).toContain('Analista (fuera del catálogo)')
  })

  it('con el catálogo vacío el cargo actual no se pierde', async () => {
    primeCatalogs([])
    renderModal()

    await awaitCatalog('Analista (fuera del catálogo)')
    expect(positionSelect().value).toBe('Analista')
  })

  it('permite dejar la ficha sin cargo', async () => {
    const user = userEvent.setup()
    renderModal()
    await awaitCatalog()

    await user.selectOptions(positionSelect(), '')
    await user.click(screen.getByRole('button', { name: /^guardar/i }))

    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    // Limpiar un campo viaja como null, no como cadena vacía.
    expect(updateMock.mock.calls[0][1]).toMatchObject({ position: null })
  })

  it('un rol sin permiso de catálogo no ve el botón de crear cargo', async () => {
    renderModal({ currentUserRole: 'supervisor' })
    await awaitCatalog()

    expect(screen.queryByRole('button', { name: /nuevo cargo/i })).toBeNull()
  })

  it('crear un cargo desde el modal lo deja seleccionado', async () => {
    const user = userEvent.setup()
    apiPost.mockResolvedValue({ data: { id: 9, name: 'Sereno' } })
    renderModal()
    await awaitCatalog()

    await user.click(screen.getByRole('button', { name: /nuevo cargo/i }))
    await user.type(screen.getByLabelText(/nombre del cargo/i), 'Sereno')
    await user.click(screen.getByRole('button', { name: /crear cargo/i }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
      '/api/job-titles',
      expect.objectContaining({ name: 'Sereno' })
    ))
    await waitFor(() => expect(positionSelect().value).toBe('Sereno'))
  })
})
