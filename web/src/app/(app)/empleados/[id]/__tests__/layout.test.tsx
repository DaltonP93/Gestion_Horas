/**
 * Composición de la ficha del empleado.
 *
 * El defecto que motiva estas pruebas era de layout, no de datos: la página
 * usaba dos grillas hermanas. La primera emparejaba el Historial (limitado a
 * max-h-80) con la columna de biometría, bastante más alta, así que la fila
 * quedaba con un hueco grande debajo del historial; Contacto y Datos
 * salariales vivían en la grilla siguiente, o sea debajo de ese hueco.
 *
 * Lo que se fija acá es la estructura, que es lo que se puede afirmar sin un
 * navegador real: qué secciones viven en la columna principal, cuáles en la
 * lateral, y en qué orden aparecen en el DOM —que es el orden de lectura para
 * teclado y lectores de pantalla, porque no se usa grid-auto-flow:dense.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmpleadoDetallePage from '../page'

const getMock = jest.fn()
const historyMock = jest.fn()

jest.mock('next/navigation', () => ({ useParams: () => ({ id: '459' }) }))

jest.mock('@/lib/api', () => ({
  api: { get: jest.fn(() => new Promise(() => {})), post: jest.fn() },
  employeesApi: {
    get: (...a: unknown[]) => getMock(...a),
    history: (...a: unknown[]) => historyMock(...a),
  },
}))

jest.mock('@/lib/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, role: 'admin', username: 'admin' }),
}))

// Los paneles pesados se sustituyen por marcadores: acá importa dónde caen,
// no lo que renderizan por dentro.
jest.mock('@/components/EmployeeNotes', () => ({
  __esModule: true,
  default: () => <div data-testid="panel-notas">Notas</div>,
}))
jest.mock('@/components/EmployeeDocuments', () => ({
  __esModule: true,
  default: () => <div data-testid="panel-documentos">Documentos</div>,
}))
jest.mock('@/components/BiometriaRelojes', () => ({
  __esModule: true,
  default: () => <div data-testid="panel-biometria">Biometría</div>,
}))
jest.mock('@/components/FaceEnroll', () => ({
  __esModule: true,
  default: () => <div data-testid="panel-rostro">Rostro</div>,
}))
jest.mock('@/components/EmployeeEditModal', () => ({
  __esModule: true,
  default: () => null,
}))

const FULL_CAPS = {
  personal_update: true, legal_view: true, legal_update: true,
  biometrics_link: true, status_change: true,
}

const EMPLEADO = {
  id: 459,
  first_name: 'Ana',
  last_name: 'Gómez',
  code: '3081',
  email: 'ana@example.com',
  phone: '0981 111222',
  birth_date: '1990-04-12',
  hire_date: '2020-01-15',
  position: 'Analista',
  status: 'active',
  salary_base: '3500000.00',
  pay_type: 'mensualizado',
  ips_number: '99887',
  gender: 'F',
  children_count: 2,
  _caps: FULL_CAPS,
}

function renderFicha() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EmpleadoDetallePage />
    </QueryClientProvider>
  )
}

const principal = () => screen.getByTestId('ficha-principal')
const lateral   = () => screen.getByTestId('ficha-lateral')

/** Posición de un nodo en el recorrido del DOM (orden de lectura). */
function domOrder(container: HTMLElement, nodes: HTMLElement[]) {
  const all = Array.from(container.querySelectorAll('*'))
  return nodes.map(n => all.indexOf(n))
}

beforeEach(() => {
  jest.clearAllMocks()
  getMock.mockResolvedValue(EMPLEADO)
  historyMock.mockResolvedValue([])
})

describe('ficha del empleado — áreas de la composición', () => {
  it('la columna principal concentra historial, tarjetas, documentos y notas', async () => {
    renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-principal')).toBeInTheDocument())

    const main = principal()
    expect(within(main).getByText('Historial de asistencia')).toBeInTheDocument()
    expect(within(main).getByText('Contacto')).toBeInTheDocument()
    expect(within(main).getByText('Datos salariales')).toBeInTheDocument()
    expect(within(main).getByTestId('panel-documentos')).toBeInTheDocument()
    expect(within(main).getByTestId('panel-notas')).toBeInTheDocument()
  })

  it('la columna lateral sólo lleva biometría y rostro', async () => {
    renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-lateral')).toBeInTheDocument())

    const aside = lateral()
    expect(within(aside).getByTestId('panel-biometria')).toBeInTheDocument()
    expect(within(aside).getByTestId('panel-rostro')).toBeInTheDocument()
    // Y nada de lo que pertenece a la principal.
    expect(within(aside).queryByText('Contacto')).toBeNull()
    expect(within(aside).queryByText('Datos salariales')).toBeNull()
    expect(within(aside).queryByTestId('panel-documentos')).toBeNull()
  })

  it('Contacto y Datos salariales van justo después del historial', async () => {
    const { container } = renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-principal')).toBeInTheDocument())

    const [hist, contacto, salario, docs, notas] = domOrder(container, [
      screen.getByText('Historial de asistencia'),
      screen.getByText('Contacto'),
      screen.getByText('Datos salariales'),
      screen.getByTestId('panel-documentos'),
      screen.getByTestId('panel-notas'),
    ])

    expect(hist).toBeLessThan(contacto)
    expect(contacto).toBeLessThan(salario)
    expect(salario).toBeLessThan(docs)
    expect(docs).toBeLessThan(notas)
  })

  it('documentos y notas quedan después de las tarjetas informativas', async () => {
    const { container } = renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-principal')).toBeInTheDocument())

    const tarjetas = screen.getByTestId('ficha-tarjetas-info')
    const [info, docs] = domOrder(container, [
      tarjetas,
      screen.getByTestId('panel-documentos'),
    ])
    expect(info).toBeLessThan(docs)
    // Y no están dentro de la grilla de dos columnas: van a ancho completo.
    expect(within(tarjetas).queryByTestId('panel-documentos')).toBeNull()
    expect(within(tarjetas).queryByTestId('panel-notas')).toBeNull()
  })

  it('la grilla no usa grid-auto-flow dense', async () => {
    const { container } = renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-principal')).toBeInTheDocument())

    const grids = Array.from(container.querySelectorAll('[class*="grid"]'))
    for (const g of grids) {
      expect(g.className).not.toMatch(/dense/)
    }
  })
})

describe('ficha del empleado — responsive y ancho', () => {
  it('las tarjetas informativas se apilan por defecto y sólo abren a dos desde md', async () => {
    renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-tarjetas-info')).toBeInTheDocument())

    const cls = screen.getByTestId('ficha-tarjetas-info').className
    expect(cls).toContain('grid-cols-1')
    expect(cls).toContain('md:grid-cols-2')
    // Nada de dos columnas antes de 768px.
    expect(cls).not.toMatch(/\bsm:grid-cols-2\b/)
  })

  it('la columna lateral sólo existe desde xl', async () => {
    renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-lateral')).toBeInTheDocument())

    const grid = principal().parentElement as HTMLElement
    expect(grid.className).toContain('grid-cols-1')
    expect(grid.className).toContain('xl:grid-cols-3')
    expect(principal().className).toContain('xl:col-span-2')
    expect(lateral().className).toContain('xl:col-span-1')
  })

  it('las columnas se alinean arriba, sin estirarse a la altura de la fila', async () => {
    renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-principal')).toBeInTheDocument())

    const grid = principal().parentElement as HTMLElement
    expect(grid.className).toContain('items-start')
  })

  it('las áreas y las tarjetas declaran min-w-0 para no desbordar en horizontal', async () => {
    renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-principal')).toBeInTheDocument())

    expect(principal().className).toContain('min-w-0')
    expect(lateral().className).toContain('min-w-0')
  })
})

describe('ficha del empleado — casos de datos', () => {
  it('sin permiso legal no hay tarjeta salarial y Contacto toma el ancho completo', async () => {
    getMock.mockResolvedValue({
      ...EMPLEADO,
      _caps: { ...FULL_CAPS, legal_view: false, legal_update: false },
    })
    renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-tarjetas-info')).toBeInTheDocument())

    expect(screen.queryByText('Datos salariales')).toBeNull()
    // Sin la segunda tarjeta, dos columnas dejarían media fila vacía.
    expect(screen.getByTestId('ficha-tarjetas-info').className).not.toContain('md:grid-cols-2')
  })

  it('sin registros de asistencia el historial muestra su estado vacío sin alto fijo', async () => {
    historyMock.mockResolvedValue([])
    const { container } = renderFicha()
    await waitFor(() => expect(screen.getByText('Sin registros en este período')).toBeInTheDocument())

    // El contenedor scrolleable acota con max-height, nunca con min-height:
    // un min-height reintroduciría el hueco que este PR elimina.
    const scroll = container.querySelector('.overflow-y-auto') as HTMLElement
    expect(scroll.className).toContain('max-h-80')
    expect(scroll.className).not.toMatch(/\bmin-h-/)
  })

  it('con registros el historial los lista dentro de la columna principal', async () => {
    historyMock.mockResolvedValue([
      { date: '2026-08-01', status: 'present', first_in: null, last_out: null, worked_minutes: 480, late_minutes: 0 },
    ])
    renderFicha()
    await waitFor(() => expect(screen.getByText('Presente')).toBeInTheDocument())

    expect(within(principal()).getByText('Presente')).toBeInTheDocument()
  })

  it('un empleado inactivo conserva la misma composición', async () => {
    getMock.mockResolvedValue({ ...EMPLEADO, status: 'inactive' })
    renderFicha()
    await waitFor(() => expect(screen.getByTestId('ficha-principal')).toBeInTheDocument())

    const main = principal()
    expect(within(main).getByText('Historial de asistencia')).toBeInTheDocument()
    expect(within(main).getByText('Contacto')).toBeInTheDocument()
    expect(within(lateral()).getByTestId('panel-biometria')).toBeInTheDocument()
  })
})
