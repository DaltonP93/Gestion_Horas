/**
 * relojes-rbac.test.tsx — El módulo "Relojes ZKTeco" de Configuración es visible
 * para admin y super_admin, pero el rol `admin` OPERA/DIAGNOSTICA sin ver los
 * controles sensibles (alta/edición/borrado de relojes, limpiar/habilitar/
 * deshabilitar y el asistente de sincronización/autopolling), que quedan sólo
 * para super_admin. Los roles sin acceso técnico no ven el tab.
 *
 * Esta guarda es de UI: la API además sigue exigiendo requireSuperAdmin en las
 * rutas sensibles (fail-safe).
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Mocks de infraestructura ─────────────────────────────────────────────────
const apiGet = jest.fn((url: string) => {
  if (typeof url === 'string' && url.includes('sync-status')) return Promise.resolve({ data: { items: [] } })
  return Promise.resolve({ data: [] })
})
jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...(a as [string])),
    post: jest.fn().mockResolvedValue({ data: {} }),
    put: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
  },
}))
jest.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}))
// El asistente de sincronización (autopolling) — marcador para asserts.
jest.mock('@/components/config/SyncWizard', () => ({
  __esModule: true,
  default: () => <div data-testid="sync-wizard" />,
}))
jest.mock('@/components/VincularEmpleadoModal', () => ({
  __esModule: true,
  default: () => null,
}))

import ConfiguracionPage from '../page'

function setUser(role: string) {
  window.localStorage.setItem('user', JSON.stringify({ id: 1, username: role, role }))
}

afterEach(() => {
  window.localStorage.clear()
  jest.clearAllMocks()
})

describe('Configuración → Relojes ZKTeco (RBAC de UI)', () => {
  test('gestor NO ve el tab Relojes ZKTeco', async () => {
    setUser('gestor')
    render(<ConfiguracionPage />)
    await screen.findByText('Configuración')       // montado; usuario ya cargado
    await screen.findByText(/Personalización del Sistema/) // tab Sistema activo
    expect(screen.queryByText(/Relojes ZKTeco/)).not.toBeInTheDocument()
  })

  test('admin ve y OPERA el módulo, pero NO gestiona ni ve autopolling', async () => {
    setUser('admin')
    render(<ConfiguracionPage />)
    // El tab aparece cuando el usuario (async) queda cargado; luego se abre.
    const tab = await screen.findByText(/⌚ Relojes ZKTeco/)
    await userEvent.click(tab)
    expect(await screen.findByText('Relojes Biométricos ZKTeco')).toBeInTheDocument()
    // Operar/diagnosticar sí:
    expect(screen.getByText('Verificar estado')).toBeInTheDocument()
    // Gestión sensible y autopolling NO:
    expect(screen.queryByText('Agregar reloj')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sync-wizard')).not.toBeInTheDocument()
  })

  test('super_admin ve gestión completa y el asistente de sincronización', async () => {
    setUser('super_admin')
    render(<ConfiguracionPage />)
    const tab = await screen.findByText(/⌚ Relojes ZKTeco/)
    await userEvent.click(tab)
    expect(await screen.findByText('Relojes Biométricos ZKTeco')).toBeInTheDocument()
    expect(screen.getByText('Agregar reloj')).toBeInTheDocument()
    expect(screen.getByTestId('sync-wizard')).toBeInTheDocument()
  })
})
