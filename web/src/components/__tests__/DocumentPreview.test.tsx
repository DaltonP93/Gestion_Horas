/**
 * Vista previa de documentos del empleado.
 *
 * El ojo de la lista representaba `visible_to_employee` y no hacía nada,
 * pero se lee como "ver documento". Ahora la visibilidad es un badge —estado,
 * no acción— y el ojo es un botón que abre la vista previa.
 *
 * Lo que se fija acá:
 *  - El binario se pide con el cliente autenticado y responseType blob;
 *    nunca se arma un href directo al endpoint (perdería el Bearer y daría 401).
 *  - El object URL se crea al mostrar y se revoca siempre al cerrar.
 *  - Formatos sin vista previa muestran el fallback con Descargar, sin
 *    intentar renderizar nada.
 */

import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EmployeeDocuments from '../EmployeeDocuments'

const apiGet = jest.fn()
const apiPost = jest.fn()
const apiDelete = jest.fn()

jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    delete: (...a: unknown[]) => apiDelete(...a),
  },
}))

const DOC_PDF = {
  id: 11, category: 'payslip', period: '2026-07', title: 'Recibo julio',
  filename: 'recibo-julio.pdf', size_bytes: 2048, mime: 'application/pdf',
  uploaded_at: '2026-07-31T10:00:00Z', visible_to_employee: 1 as const,
  note: null, uploaded_by_username: 'admin',
}
const DOC_IMG = {
  ...DOC_PDF, id: 12, title: 'Cédula', filename: 'ci.png', mime: 'image/png',
  visible_to_employee: 0 as const,
}
const DOC_DOCX = {
  ...DOC_PDF, id: 13, title: 'Contrato', filename: 'contrato.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** Blob simulado: jsdom no implementa bien size/type en todos los casos. */
function mkBlob(type: string, size = 1024) {
  return { size, type } as Blob
}

const DOWNLOAD_RE = /\/documents\/\d+\/download$/

/** Lista los documentos indicados y responde la descarga con `blob`. */
function primeApi(items: unknown[], blob: Blob | null = mkBlob('application/pdf')) {
  apiGet.mockImplementation((url: string, opts?: { responseType?: string }) => {
    if (DOWNLOAD_RE.test(String(url))) {
      expect(opts?.responseType).toBe('blob')
      return blob ? Promise.resolve({ data: blob }) : new Promise(() => {})
    }
    return Promise.resolve({ data: { items } })
  })
}

const createObjectURL = jest.fn(() => 'blob:mock-url')
const revokeObjectURL = jest.fn()

beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true })
})

beforeEach(() => {
  jest.clearAllMocks()
  createObjectURL.mockReturnValue('blob:mock-url')
  primeApi([DOC_PDF])
})

const openPreview = async (user: ReturnType<typeof userEvent.setup>, nth = 0) => {
  const botones = await screen.findAllByTitle('Ver documento')
  await user.click(botones[nth])
}

describe('lista de documentos — visibilidad vs. acción', () => {
  it('la visibilidad es un badge de texto, no un control', async () => {
    render(<EmployeeDocuments employeeId={459} />)
    const badge = await screen.findByTestId('doc-visibilidad')

    expect(badge).toHaveTextContent('Visible al empleado')
    expect(badge.tagName).toBe('SPAN')
    // Ni botón, ni enlace, ni foco: es estado, no acción.
    expect(badge.closest('button')).toBeNull()
    expect(badge.closest('a')).toBeNull()
    expect(badge).not.toHaveAttribute('role', 'button')
    expect(badge).not.toHaveAttribute('tabindex')
    expect(badge).not.toHaveAttribute('onclick')
  })

  it('un documento no visible se rotula Privado', async () => {
    primeApi([DOC_IMG])
    render(<EmployeeDocuments employeeId={459} />)

    const badge = await screen.findByTestId('doc-visibilidad')
    expect(badge).toHaveTextContent('Privado')
  })

  it('Ver y Descargar son botones distintos', async () => {
    render(<EmployeeDocuments employeeId={459} />)
    await screen.findByTitle('Ver documento')

    expect(screen.getByTitle('Ver documento')).toBeInTheDocument()
    expect(screen.getByTitle('Descargar')).toBeInTheDocument()
  })
})

describe('vista previa — descarga autenticada', () => {
  it('el ojo pide el binario por el cliente api con responseType blob', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)

    await waitFor(() => expect(
      apiGet.mock.calls.some(([u]) => DOWNLOAD_RE.test(String(u)))
    ).toBe(true))

    const [url, opts] = apiGet.mock.calls.find(([u]) => DOWNLOAD_RE.test(String(u)))!
    expect(url).toBe('/api/employees/459/documents/11/download')
    expect(opts.responseType).toBe('blob')
  })

  it('no se arma ningún href directo al endpoint', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    await screen.findByRole('dialog')

    // Un href al endpoint sería una navegación sin el Bearer token.
    const conHref = Array.from(document.querySelectorAll('[src],[data],[href]'))
      .map(el => el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href'))
      .filter(Boolean) as string[]
    expect(conHref.some(h => h.includes('/api/employees/'))).toBe(false)
  })

  it('un PDF se muestra con el object URL creado', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    const obj = dialog.querySelector('object') as HTMLObjectElement
    expect(obj).toBeTruthy()
    expect(obj.getAttribute('data')).toBe('blob:mock-url')
    expect(obj.getAttribute('type')).toBe('application/pdf')
  })

  it('una imagen se muestra en un img con el object URL', async () => {
    primeApi([DOC_IMG], mkBlob('image/png'))
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('img')).toBeInTheDocument())
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', 'blob:mock-url')
  })

  it('un DOCX muestra el fallback y ofrece descargar, sin renderizar nada', async () => {
    primeApi([DOC_DOCX], mkBlob(DOC_DOCX.mime))
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)

    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(within(dialog).getByText(/Vista previa no disponible para este formato/i)).toBeInTheDocument()
    )
    // Hay dos: el ícono del encabezado y el del fallback. El del fallback es
    // el que lleva texto visible.
    const descargas = within(dialog).getAllByRole('button', { name: /descargar/i })
    expect(descargas.some(b => b.textContent?.trim() === 'Descargar')).toBe(true)
    expect(dialog.querySelector('object')).toBeNull()
    expect(dialog.querySelector('img')).toBeNull()
    // Y ni siquiera se retiene el blob de algo que no se va a mostrar.
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

describe('vista previa — descargar desde el modal', () => {
  it('reutiliza el binario ya descargado, sin una segunda petición', async () => {
    const user = userEvent.setup()
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())

    const antes = apiGet.mock.calls.filter(([u]) => DOWNLOAD_RE.test(String(u))).length
    await user.click(within(dialog).getByTitle('Descargar'))

    // Sin red no hay un segundo error que el usuario no vería: el banner del
    // padre queda tapado por el modal.
    const despues = apiGet.mock.calls.filter(([u]) => DOWNLOAD_RE.test(String(u))).length
    expect(despues).toBe(antes)
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })

  it('el fallback de formato no visualizable también descarga sin pedir de nuevo', async () => {
    primeApi([DOC_DOCX], mkBlob(DOC_DOCX.mime))
    const user = userEvent.setup()
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(within(dialog).getByText(/Vista previa no disponible/i)).toBeInTheDocument()
    )

    const antes = apiGet.mock.calls.filter(([u]) => DOWNLOAD_RE.test(String(u))).length
    const botones = within(dialog).getAllByRole('button', { name: /descargar/i })
    await user.click(botones.find(b => b.textContent?.trim() === 'Descargar')!)

    expect(apiGet.mock.calls.filter(([u]) => DOWNLOAD_RE.test(String(u))).length).toBe(antes)
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })

  it('si la descarga inicial falló no se ofrece descargar', async () => {
    apiGet.mockImplementation((url: string) => {
      if (DOWNLOAD_RE.test(String(url))) return Promise.reject({ response: { status: 410 } })
      return Promise.resolve({ data: { items: [DOC_PDF] } })
    })
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeInTheDocument())

    expect(within(dialog).queryByTitle('Descargar')).toBeNull()
  })
})

describe('vista previa — ciclo de vida del object URL', () => {
  it('se revoca al cerrar', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())

    await user.click(screen.getByLabelText('Cerrar vista previa'))
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url'))
  })

  it('se revoca al desmontar con la vista abierta', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })
})

describe('vista previa — errores', () => {
  async function abrirConError(status: number) {
    apiGet.mockImplementation((url: string) => {
      if (DOWNLOAD_RE.test(String(url))) {
        return Promise.reject({ response: { status } })
      }
      return Promise.resolve({ data: { items: [DOC_PDF] } })
    })
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    return screen.findByRole('dialog')
  }

  it('410 avisa que el archivo físico no está', async () => {
    const dialog = await abrirConError(410)
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/no está disponible/i)
    )
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('403 avisa de permisos', async () => {
    const dialog = await abrirConError(403)
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/permiso/i)
    )
  })

  it('404 avisa que ya no existe', async () => {
    const dialog = await abrirConError(404)
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/no existe/i)
    )
  })

  it('un blob vacío no se muestra en blanco', async () => {
    primeApi([DOC_PDF], mkBlob('application/pdf', 0))
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)

    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/vacío/i)
    )
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('sin MIME resuelve por la extensión del archivo', async () => {
    primeApi([{ ...DOC_PDF, mime: null }], mkBlob('application/octet-stream'))
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.querySelector('object')).toBeTruthy())
  })
})

describe('vista previa — modal accesible y responsive', () => {
  it('declara aria-modal y un título', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'doc-preview-title')
    expect(within(dialog).getByText('Recibo julio')).toBeInTheDocument()
  })

  it('Escape cierra', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    const dialog = await screen.findByRole('dialog')

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('restaura el foco al botón que lo abrió', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    const abrir = await screen.findByTitle('Ver documento')
    await user.click(abrir)
    await screen.findByRole('dialog')

    await user.click(screen.getByLabelText('Cerrar vista previa'))
    await waitFor(() => expect(document.activeElement).toBe(abrir))
  })

  it('el cuerpo es el único con scroll, y sólo vertical', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    const dialog = await screen.findByRole('dialog')

    const scrollables = Array.from(dialog.querySelectorAll('[class*="overflow-y-auto"]'))
    expect(scrollables).toHaveLength(1)
    expect(scrollables[0].className).toContain('overflow-x-hidden')
    expect(dialog.className).toContain('max-h-[90dvh]')
  })

  it('bloquea el scroll del documento mientras está abierto y lo restaura al cerrar', async () => {
    const user = userEvent.setup()
    render(<EmployeeDocuments employeeId={459} />)
    await openPreview(user)
    await screen.findByRole('dialog')
    expect(document.body.style.overflow).toBe('hidden')

    await user.click(screen.getByLabelText('Cerrar vista previa'))
    await waitFor(() => expect(document.body.style.overflow).not.toBe('hidden'))
  })
})
