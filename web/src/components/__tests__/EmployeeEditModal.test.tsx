/**
 * Pruebas de interacción del modal de edición del empleado.
 *
 * Cubren los tres defectos que motivaron el hotfix:
 *   1. Pérdida de foco al tipear (componentes redefinidos en cada render).
 *   2. Salario multiplicado ×100 por ciclo (DECIMAL "3500000.00" tratado
 *      como si el punto fuera separador de miles).
 *   3. Estructura del modal: portal, viewport contenido, un solo scroll.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EmployeeEditModal from '../EmployeeEditModal'

const updateMock = jest.fn()
const getMock = jest.fn()

// Los catálogos quedan pendientes a propósito: estas pruebas son sobre el
// formulario, y una resolución asíncrona fuera de `act` sólo añadiría ruido.
jest.mock('@/lib/api', () => ({
  api: { get: jest.fn(() => new Promise(() => {})) },
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
  email: 'ana@example.com',
  phone: '0981 111222',
  birth_date: '1990-04-12',
  hire_date: '2020-01-15',
  position: 'Analista',
  department_id: 3,
  branch_id: 1,
  schedule_id: 2,
  document_number: '1234567',
  ips_number: '99887',
  // MySQL devuelve DECIMAL como string con parte decimal explícita.
  salary_base: '3500000.00',
  pay_type: 'mensualizado',
  gender: 'F',
  children_count: 2,
}

function renderModal(props: Partial<React.ComponentProps<typeof EmployeeEditModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = jest.fn()
  const onSaved = jest.fn()
  const utils = render(
    <QueryClientProvider client={qc}>
      <EmployeeEditModal
        open
        onClose={onClose}
        employee={EMPLOYEE}
        caps={FULL_CAPS}
        currentUserRole="admin"
        onSaved={onSaved}
        {...props}
      />
    </QueryClientProvider>
  )
  return { ...utils, onClose, onSaved, qc }
}

beforeEach(() => {
  updateMock.mockReset()
  getMock.mockReset()
  updateMock.mockResolvedValue({ message: 'Empleado actualizado', changed: [], employee: EMPLOYEE })
})

describe('foco estable al tipear', () => {
  it.each([
    ['emp-field-first_name', 'Dalton'],
    ['emp-field-phone', '0985123456'],
    ['emp-field-document_number', '4567890'],
  ])('%s conserva el foco carácter por carácter', async (id, text) => {
    renderModal()
    const input = document.getElementById(id) as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '' } })

    let typed = ''
    for (const ch of text) {
      typed += ch
      const el = document.getElementById(id) as HTMLInputElement
      fireEvent.change(el, { target: { value: typed } })
      expect(document.activeElement).toBe(input)
    }

    expect((document.getElementById(id) as HTMLInputElement).value).toBe(text)
    expect(document.activeElement).toBe(input)
  })

  it('el input mantiene el mismo nodo DOM entre pulsaciones', async () => {
    renderModal()
    const before = document.getElementById('emp-field-last_name')
    fireEvent.change(before as HTMLInputElement, { target: { value: 'Perez' } })
    expect(document.getElementById('emp-field-last_name')).toBe(before)
  })

  it('un rerender del padre no reinicia lo ya escrito', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const Wrapper = ({ employee }: { employee: any }) => (
      <QueryClientProvider client={qc}>
        <EmployeeEditModal
          open
          onClose={jest.fn()}
          employee={employee}
          caps={FULL_CAPS}
          currentUserRole="admin"
          onSaved={jest.fn()}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(<Wrapper employee={EMPLOYEE} />)

    const input = document.getElementById('emp-field-first_name') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: 'Dalton' } })

    // React Query devuelve un objeto nuevo con los mismos datos.
    rerender(<Wrapper employee={{ ...EMPLOYEE }} />)

    expect((document.getElementById('emp-field-first_name') as HTMLInputElement).value).toBe('Dalton')
  })

  it('cambiar de empleado sí vuelve a tomar el snapshot', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const Wrapper = ({ employee }: { employee: any }) => (
      <QueryClientProvider client={qc}>
        <EmployeeEditModal
          open
          onClose={jest.fn()}
          employee={employee}
          caps={FULL_CAPS}
          currentUserRole="admin"
          onSaved={jest.fn()}
        />
      </QueryClientProvider>
    )
    const { rerender } = render(<Wrapper employee={EMPLOYEE} />)
    fireEvent.change(document.getElementById('emp-field-first_name') as HTMLInputElement, {
      target: { value: 'Dalton' },
    })
    rerender(<Wrapper employee={{ ...EMPLOYEE, id: 460, first_name: 'Luis' }} />)
    expect((document.getElementById('emp-field-first_name') as HTMLInputElement).value).toBe('Luis')
  })
})

describe('salario idempotente', () => {
  it('muestra el DECIMAL del backend como 3.500.000, no 350.000.000', () => {
    renderModal()
    expect((document.getElementById('emp-field-salary_base') as HTMLInputElement).value)
      .toBe('3.500.000')
  })

  it('abrir y guardar tres veces conserva 3500000', async () => {
    for (let i = 0; i < 3; i++) {
      const { unmount } = renderModal()
      expect((document.getElementById('emp-field-salary_base') as HTMLInputElement).value)
        .toBe('3.500.000')
      fireEvent.submit(screen.getByRole('dialog'))
      await waitFor(() => expect(updateMock).toHaveBeenCalled())
      const payload = updateMock.mock.calls[updateMock.mock.calls.length - 1][1] as Record<string, unknown>
      expect(payload.salary_base).toBe(3500000)
      unmount()
    }
  })

  it('lo tipeado con separadores se envía como entero limpio', async () => {
    renderModal()
    const input = document.getElementById('emp-field-salary_base') as HTMLInputElement
    fireEvent.change(input, { target: { value: '3.500.000' } })
    expect(input.value).toBe('3.500.000')
    fireEvent.submit(screen.getByRole('dialog'))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    expect((updateMock.mock.calls[0][1] as Record<string, unknown>).salary_base).toBe(3500000)
  })

  it('un salario negativo no dispara el request', async () => {
    renderModal()
    const input = document.getElementById('emp-field-salary_base') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-1000' } })
    fireEvent.submit(screen.getByRole('dialog'))
    expect(await screen.findByRole('alert')).toHaveTextContent('salario debe ser ≥ 0')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('editar otro campo no altera el salario enviado', async () => {
    renderModal()
    fireEvent.change(document.getElementById('emp-field-first_name') as HTMLInputElement, {
      target: { value: 'Anabel' },
    })
    fireEvent.submit(screen.getByRole('dialog'))
    await waitFor(() => expect(updateMock).toHaveBeenCalled())
    const payload = updateMock.mock.calls[0][1] as Record<string, unknown>
    expect(payload.first_name).toBe('Anabel')
    expect(payload.salary_base).toBe(3500000)
  })
})

describe('estructura del modal', () => {
  it('se monta con portal directamente bajo document.body', () => {
    const { container } = renderModal()
    expect(container).toBeEmptyDOMElement()
    const dialog = screen.getByRole('dialog')
    expect(document.body.contains(dialog)).toBe(true)
  })

  it('el overlay cubre el viewport con 100dvh', () => {
    renderModal()
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement
    expect(overlay.className).toContain('fixed')
    expect(overlay.className).toContain('inset-0')
    expect(overlay.className).toContain('h-[100dvh]')
    expect(overlay.className).toContain('overflow-hidden')
  })

  it('sólo el cuerpo del modal tiene scroll vertical y ninguno horizontal', () => {
    renderModal()
    const dialog = screen.getByRole('dialog')
    const scrollers = Array.from(dialog.querySelectorAll('div'))
      .filter(el => el.className.includes('overflow-y-auto'))
    expect(scrollers).toHaveLength(1)
    expect(scrollers[0].className).toContain('overflow-x-hidden')
    expect(scrollers[0].className).toContain('flex-1')
    expect(scrollers[0].className).toContain('min-h-0')
  })

  it('las secciones son de una columna y sólo se abren a dos desde sm', () => {
    renderModal()
    const grids = Array.from(screen.getByRole('dialog').querySelectorAll('div'))
      .filter(el => el.className.includes('grid-cols-1'))
    expect(grids.length).toBeGreaterThan(0)
    for (const g of grids) expect(g.className).toContain('sm:grid-cols-2')
  })

  it('los botones del pie se apilan en móvil', () => {
    renderModal()
    const cancel = screen.getByRole('button', { name: 'Cancelar' })
    expect((cancel.parentElement as HTMLElement).className).toContain('flex-col-reverse')
    expect((cancel.parentElement as HTMLElement).className).toContain('sm:flex-row')
  })

  it('declara aria-modal, título y descripción', () => {
    renderModal()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toBeInTheDocument()
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)).toBeInTheDocument()
  })

  it('bloquea el scroll del documento mientras está abierto y lo restaura al cerrar', () => {
    const { unmount } = renderModal()
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('')
  })
})

describe('cierre y guardado', () => {
  it('Escape cierra cuando no está guardando', () => {
    const { onClose } = renderModal()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape no cierra mientras hay un guardado en curso', async () => {
    let resolve!: (v: unknown) => void
    updateMock.mockReturnValue(new Promise(r => { resolve = r }))
    const { onClose } = renderModal()

    fireEvent.submit(screen.getByRole('dialog'))
    await waitFor(() => expect(screen.getByText('Guardando…')).toBeInTheDocument())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => { resolve({ employee: EMPLOYEE }) })
  })

  it('restaura el foco al botón que abrió el modal', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Editar empleado'
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = renderModal()
    unmount()

    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('guarda y cierra devolviendo la ficha del backend', async () => {
    const { onClose, onSaved } = renderModal()
    fireEvent.submit(screen.getByRole('dialog'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(EMPLOYEE))
    expect(onClose).toHaveBeenCalled()
    expect(getMock).not.toHaveBeenCalled()
  })

  it('un error por campo del backend resalta ese campo', async () => {
    updateMock.mockRejectedValue({
      response: { status: 400, data: { error: 'Tipo de pago inválido o inactivo', field: 'pay_type' } },
    })
    renderModal()
    fireEvent.submit(screen.getByRole('dialog'))
    await waitFor(() => {
      expect(document.getElementById('emp-field-pay_type')).toHaveAttribute('aria-invalid', 'true')
    })
  })

  it('enfoca el primer campo al abrir', () => {
    renderModal()
    expect(document.activeElement).toBe(document.getElementById('emp-field-first_name'))
  })

  it('Tab desde el último foco vuelve al primero (focus trap)', async () => {
    const user = userEvent.setup()
    renderModal()
    const dialog = screen.getByRole('dialog')
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    last.focus()
    await user.tab()
    expect(document.activeElement).toBe(first)
  })

  it('el trap no roba el foco al submodal de tipos de pago', async () => {
    const user = userEvent.setup()
    renderModal()

    await user.click(screen.getByRole('button', { name: /Nuevo tipo de pago/i }))
    const sub = screen.getByRole('dialog', { name: /Nuevo tipo de pago/i })
    const subInput = sub.querySelector('input') as HTMLInputElement
    subInput.focus()

    // Shift+Tab desde el submodal antes satisfacía `!root.contains(active)`
    // y mandaba el foco al formulario de atrás.
    await user.tab({ shift: true })
    expect(sub.contains(document.activeElement)).toBe(true)

    // Y Escape dentro del submodal no debe cerrar el modal del empleado.
    fireEvent.keyDown(subInput, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: /Editar empleado/i })).toBeInTheDocument()
  })
})
