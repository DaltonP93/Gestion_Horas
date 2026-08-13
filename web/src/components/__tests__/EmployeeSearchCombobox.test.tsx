/**
 * EmployeeSearchCombobox — selector de empleado con búsqueda remota.
 *
 * El `<select>` anterior cargaba hasta 500 empleados de una vez: además de
 * incómodo, ese tope OCULTABA registros. Lo que estos tests protegen es que
 * la búsqueda sea remota (nunca se pide el padrón entero), que el debounce
 * evite perseguir cada tecla, y que el teclado y ARIA funcionen.
 */

import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmployeeSearchCombobox from '../EmployeeSearchCombobox'

const apiGet = jest.fn()
jest.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => apiGet(...a) } }))

const EMPLEADOS = [
  { id: 7,  code: 'E007', full_name: 'María Rodríguez', department: 'Administración' },
  { id: 42, code: 'E042', full_name: 'Juan Pérez',      department: 'Producción' },
]

function renderCombo(props: Partial<React.ComponentProps<typeof EmployeeSearchCombobox>> = {}) {
  const onChange = jest.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <QueryClientProvider client={client}>
      <EmployeeSearchCombobox value="" onChange={onChange} {...props} />
    </QueryClientProvider>,
  )
  return { onChange, ...utils }
}

/** Avanza los timers falsos para saltar el debounce. */
async function pasarDebounce() {
  await act(async () => { jest.advanceTimersByTime(400) })
}

beforeEach(() => {
  jest.useFakeTimers()
  apiGet.mockReset()
  apiGet.mockResolvedValue({ data: { data: EMPLEADOS } })
})
afterEach(() => { jest.useRealTimers() })

function user() {
  return userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
}

describe('EmployeeSearchCombobox', () => {
  test('busca por nombre y muestra nombre + código · departamento', async () => {
    const u = user()
    renderCombo()

    await u.type(screen.getByRole('combobox'), 'mar')
    await pasarDebounce()

    await waitFor(() => expect(screen.getByText('María Rodríguez')).toBeInTheDocument())
    expect(screen.getByText('Cód. E007 · Administración')).toBeInTheDocument()

    const params = apiGet.mock.calls.at(-1)![1].params
    expect(params.search).toBe('mar')
    expect(params.status).toBe('active')
  })

  test('busca por código, con un solo dígito', async () => {
    const u = user()
    renderCombo()

    await u.type(screen.getByRole('combobox'), '7')
    await pasarDebounce()

    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    expect(apiGet.mock.calls.at(-1)![1].params.search).toBe('7')
  })

  test('★ no consulta con una sola letra, ni pide el padrón entero', async () => {
    const u = user()
    renderCombo()

    await u.type(screen.getByRole('combobox'), 'm')
    await pasarDebounce()

    expect(apiGet).not.toHaveBeenCalled()
    expect(screen.getByText(/al menos 2 caracteres/i)).toBeInTheDocument()
  })

  test('★ el debounce agrupa las pulsaciones en una sola consulta', async () => {
    const u = user()
    renderCombo()

    const input = screen.getByRole('combobox')
    await u.type(input, 'm')
    await u.type(input, 'a')
    await u.type(input, 'r')
    expect(apiGet).not.toHaveBeenCalled()   // todavía nada, dentro de la ventana

    await pasarDebounce()
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1))
  })

  test('seleccionar con el mouse devuelve el employeeId', async () => {
    const u = user()
    const { onChange } = renderCombo()

    await u.type(screen.getByRole('combobox'), 'mar')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))

    await u.click(screen.getByText('María Rodríguez'))

    expect(onChange).toHaveBeenCalledWith('7')
    expect(screen.getByRole('combobox')).toHaveValue('María Rodríguez (E007)')
  })

  test('teclado: flechas mueven, Enter selecciona', async () => {
    const u = user()
    const { onChange } = renderCombo()

    const input = screen.getByRole('combobox')
    await u.type(input, 'e0')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))

    await u.keyboard('{ArrowDown}')        // → primera opción
    await u.keyboard('{ArrowDown}')        // → segunda
    await u.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith('42')
  })

  test('teclado: aria-activedescendant sigue a la opción activa', async () => {
    const u = user()
    renderCombo()

    const input = screen.getByRole('combobox')
    await u.type(input, 'e0')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))

    expect(input).not.toHaveAttribute('aria-activedescendant')
    await u.keyboard('{ArrowDown}')

    const activo = input.getAttribute('aria-activedescendant')
    expect(activo).toBeTruthy()
    expect(document.getElementById(activo!)).toHaveTextContent('María Rodríguez')
  })

  test('Escape cierra la lista', async () => {
    const u = user()
    renderCombo()

    const input = screen.getByRole('combobox')
    await u.type(input, 'mar')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))
    expect(input).toHaveAttribute('aria-expanded', 'true')

    await u.keyboard('{Escape}')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('María Rodríguez')).not.toBeInTheDocument()
  })

  test('limpiar deja la selección en vacío', async () => {
    const u = user()
    const { onChange } = renderCombo()

    await u.type(screen.getByRole('combobox'), 'mar')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))
    await u.click(screen.getByText('María Rodríguez'))
    onChange.mockClear()

    await u.click(screen.getByLabelText('Limpiar selección'))

    expect(onChange).toHaveBeenCalledWith('')
    expect(screen.getByRole('combobox')).toHaveValue('')
  })

  test('sin resultados lo dice, no se queda en blanco', async () => {
    apiGet.mockResolvedValue({ data: { data: [] } })
    const u = user()
    renderCombo()

    await u.type(screen.getByRole('combobox'), 'zzz')
    await pasarDebounce()

    // Visible en la lista, con el término buscado…
    await waitFor(() =>
      expect(screen.getByRole('listbox')).toHaveTextContent(/Sin resultados para/i))
    // …y anunciado por separado para lectores de pantalla.
    expect(screen.getByRole('status')).toHaveTextContent('Sin resultados')
  })

  test('★ escribir después de elegir invalida la selección', async () => {
    // Si no, el reporte seguiría filtrando por un empleado que ya no es el
    // que está escrito en el campo.
    const u = user()
    const { onChange } = renderCombo()

    await u.type(screen.getByRole('combobox'), 'mar')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))
    await u.click(screen.getByText('María Rodríguez'))
    expect(onChange).toHaveBeenLastCalledWith('7')

    await u.type(screen.getByRole('combobox'), 'x')
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  test('acota la búsqueda al departamento cuando hay uno elegido', async () => {
    const u = user()
    renderCombo({ deptId: '3' })

    await u.type(screen.getByRole('combobox'), 'mar')
    await pasarDebounce()

    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    expect(apiGet.mock.calls.at(-1)![1].params.department_id).toBe('3')
  })

  test('★ aria-activedescendant desaparece al cerrar la lista', async () => {
    // Al cerrar, el <ul> se desmonta. Si el atributo sobreviviera, apuntaría
    // a un id inexistente y rompería el foco virtual para lectores de
    // pantalla. Se verifica en los dos caminos que sólo cerraban: Tab y
    // clic fuera.
    const u = user()
    renderCombo()

    const input = screen.getByRole('combobox')
    await u.type(input, 'e0')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))
    await u.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant')

    await u.keyboard('{Tab}')
    expect(input).not.toHaveAttribute('aria-activedescendant')

    // …y con clic fuera.
    await u.click(input)
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))
    await u.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant')

    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  test('★ si el padre no acepta la selección, el campo no la muestra', async () => {
    // Componente controlado: la fuente de verdad es `value`. Un padre que
    // rechace o normalice el onChange y conserve el value anterior no debe
    // quedar con el campo mostrando un empleado que no está seleccionado.
    const u = user()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onChange = jest.fn()   // padre que ignora el cambio: value sigue en ''

    render(
      <QueryClientProvider client={client}>
        <EmployeeSearchCombobox value="" onChange={onChange} />
      </QueryClientProvider>,
    )

    await u.type(screen.getByRole('combobox'), 'mar')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))
    await u.click(screen.getByText('María Rodríguez'))

    expect(onChange).toHaveBeenCalledWith('7')
    // El padre no lo aceptó → el campo se reconcilia y queda vacío.
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue(''))
  })

  test('si el padre limpia el value, el campo se vacía', async () => {
    const u = user()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onChange = jest.fn()
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <EmployeeSearchCombobox value="7" onChange={onChange} />
      </QueryClientProvider>,
    )

    await u.type(screen.getByRole('combobox'), 'mar')
    await pasarDebounce()
    await waitFor(() => screen.getByText('María Rodríguez'))
    await u.click(screen.getByText('María Rodríguez'))
    expect(screen.getByRole('combobox')).toHaveValue('María Rodríguez (E007)')

    // El padre resetea (p. ej. al cambiar de departamento).
    rerender(
      <QueryClientProvider client={client}>
        <EmployeeSearchCombobox value="" onChange={onChange} />
      </QueryClientProvider>,
    )

    expect(screen.getByRole('combobox')).toHaveValue('')
  })
})
