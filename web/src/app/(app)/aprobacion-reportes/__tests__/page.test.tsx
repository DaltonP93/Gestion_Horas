/**
 * Aprobación de reportes — bandeja, acción de aprobar y descarga del firmado.
 *
 * Cubre el circuito de firma del reporte mensual desde la UI:
 *   - la bandeja lista los pendientes que trae el inbox;
 *   - "Aprobar" dispara el POST al endpoint correcto del ítem;
 *   - un período con estado "approved" ofrece descargar el PDF firmado.
 *
 * La API se mockea por completo (no hace falta backend). El ruteo de `api.get`
 * se resuelve por URL para poder devolver distinta forma según el endpoint.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AprobacionReportesPage from '../page'

const getMock = jest.fn()
const postMock = jest.fn()
const downloadUrlMock = jest.fn((p: string) => `https://x${p}`)

jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
  downloadUrl: (...a: unknown[]) => downloadUrlMock(...(a as [string])),
}))

jest.mock('@/lib/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, role: 'coordinator', username: 'coord' }),
  // hasRole real-ish: super_admin ve todo; si no, match por lista.
  hasRole: (u: any, ...roles: string[]) =>
    !!u && (u.role === 'super_admin' || roles.includes(u.role)),
}))

// Enruta api.get según el endpoint; cada test ajusta `statusResponse`.
let inboxResponse: any[] = []
let statusResponse: any = null

function routeGet(url: string) {
  if (url === '/api/reports/monthly/approvals/inbox') return Promise.resolve({ data: inboxResponse })
  if (url === '/api/reports/monthly/approvals/status') return Promise.resolve({ data: statusResponse })
  if (url === '/api/employees/departments') return Promise.resolve({ data: [] })
  return Promise.resolve({ data: null })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AprobacionReportesPage />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  inboxResponse = []
  statusResponse = null
  getMock.mockImplementation((url: string) => routeGet(url))
  postMock.mockResolvedValue({ data: { ok: true } })
})

describe('AprobacionReportesPage', () => {
  it('lista los pendientes de la bandeja', async () => {
    inboxResponse = [
      { id: 7, year: 2026, month: 8, department_id: 3, department_name: 'Producción',
        approval_state: 'pending', requested_by_name: 'Ana Gómez' },
    ]
    renderPage()

    await waitFor(() => expect(screen.getByText('Agosto 2026')).toBeInTheDocument())
    expect(screen.getByText('Producción')).toBeInTheDocument()
    expect(screen.getByText('Ana Gómez')).toBeInTheDocument()
    // Chip de nivel actual
    expect(screen.getByText(/Pendiente — Coordinador/)).toBeInTheDocument()
  })

  it('el botón Aprobar dispara el POST al endpoint del ítem', async () => {
    const promptSpy = jest.spyOn(window, 'prompt').mockReturnValue('')
    inboxResponse = [
      { id: 42, year: 2026, month: 5, department_id: null,
        approval_state: 'pending', requested_by_name: 'Luis' },
    ]
    renderPage()

    const btn = await screen.findByRole('button', { name: /Aprobar/ })
    await userEvent.click(btn)

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/reports/monthly/approvals/42/approve',
        expect.anything(),
      )
    )
    promptSpy.mockRestore()
  })

  it('un período approved muestra el botón de descarga del firmado', async () => {
    statusResponse = {
      id: 99, year: 2026, month: 7, approval_state: 'approved',
      signed_by_name: 'RR.HH.', signed_at: '2026-08-01T10:00:00Z',
    }
    renderPage()

    const dlBtn = await screen.findByRole('button', { name: /Descargar reporte firmado/ })
    expect(dlBtn).toBeInTheDocument()

    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null)
    await userEvent.click(dlBtn)
    expect(downloadUrlMock).toHaveBeenCalledWith('/api/reports/monthly/approvals/99/signed-pdf')
    expect(openSpy).toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('sin pendientes muestra el estado vacío amable', async () => {
    inboxResponse = []
    renderPage()
    await waitFor(() =>
      expect(screen.getByText(/No hay reportes pendientes para tu aprobación/)).toBeInTheDocument()
    )
  })
})
