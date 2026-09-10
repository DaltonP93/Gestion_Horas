/**
 * Consola de activación FASE E — contrato del dry-run (P1-A, 2ª auditoría Codex).
 *
 * El backend `getImpact` ya NO devuelve `stored`/`motor` por celda. Devuelve
 * conteos agregados + `dates_outside_range` (spillover del escritor por fecha,
 * que toca {d-1, d}) + `plan_digest` (paridad exacta con el apply) + ejemplos con
 * SÓLO `changed_fields` (nombres de campos, sin valores ni PII). Esta prueba fija
 * ese contrato:
 *   1. Con ≥1 ejemplo que difiere y spillover fuera del rango pedido, la consola
 *      RENDERIZA sin excepción (antes explotaba leyendo `ex.motor.status`).
 *   2. Se muestran cells_evaluated, rows_differ_outside_range, dates_outside_range
 *      y los changed_fields de cada ejemplo.
 *   3. El botón "Aplicar recálculo" reenvía el `plan_digest` del dry-run (P1-F).
 *   4. La consola ya NO ofrece "Aplicar migraciones" (paso movido a OPS).
 */

import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ActivacionMotorPage from '../page'

// super_admin: pasa la compuerta RBAC del componente.
jest.mock('@/lib/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'root', role: 'super_admin' }),
  isSuperAdmin: (u: any) => u?.role === 'super_admin',
}))

const apiGet = jest.fn()
const apiPost = jest.fn()
jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}))

// master-flag ACTIVO, para poder ejercer el botón de apply y su plan_digest.
const STATUS = {
  migrations: [
    { filename: '072_employee_schedule_history.sql', recorded: true },
    { filename: '083_fase_e_activation_console.sql', recorded: true },
  ],
  engine_migrations_applied: true,
  console_migration_applied: true,
  daily_summary_status_has_074: true,
  backup_tables_ready: true,
  employee_schedule_history: { exists: true, rows: 3 },
  gates: {
    master_flag_enabled: true,
    forward_env_kill_switch: false,
    forward_db_setting: false,
    forward_effective: false,
    status_074_env: true,
    workday_config_write_env: false,
  },
  go_no_go: { schema_ready: true, forward_ready_to_flip: false, note: 'ok' },
}

// Dry-run con ≥1 ejemplo que DIFIERE y spillover: una celda cae FUERA del rango
// pedido (2025-01-31 es el d-1 spillover del recálculo que arranca en 2025-02-01…
// aquí simplemente marcamos una fecha fuera de [from,to]).
const IMPACT = {
  read_only: true,
  period: { from: '2025-02-01', to: '2025-02-28' },
  scope: { kind: 'all', id: null },
  employees: 4,
  cells_evaluated: 120,
  rows_differ: 3,
  rows_new: 1,
  rows_differ_outside_range: 1,
  dates_outside_range: ['2025-01-31'],
  plan_digest: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  examples: [
    // dentro del rango, actualiza (existía)
    { employee_id: 11, date: '2025-02-10', outside_requested_range: false, existed: 1, changed_fields: ['worked_minutes', 'status'] },
    // spillover: fuera del rango pedido
    { employee_id: 12, date: '2025-01-31', outside_requested_range: true, existed: 1, changed_fields: ['last_out'] },
    // crea (no existía)
    { employee_id: 13, date: '2025-02-15', outside_requested_range: false, existed: 0, changed_fields: ['first_in', 'last_out', 'worked_minutes', 'status'] },
  ],
}

beforeEach(() => {
  apiGet.mockReset(); apiPost.mockReset()
  apiGet.mockImplementation((url: string) => {
    if (url === '/api/fase-e/status') return Promise.resolve({ data: STATUS })
    if (url === '/api/fase-e/batches') return Promise.resolve({ data: { batches: [] } })
    return Promise.reject(new Error('unexpected GET ' + url))
  })
  apiPost.mockImplementation((url: string) => {
    if (url === '/api/fase-e/recalc/dryrun') return Promise.resolve({ data: IMPACT })
    if (url === '/api/fase-e/recalc/apply') return Promise.resolve({ data: { batch_id: 'B-XYZ' } })
    return Promise.reject(new Error('unexpected POST ' + url))
  })
})

async function renderAndDryRun() {
  render(<ActivacionMotorPage />)
  // Espera a que cargue el preflight (status).
  await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/fase-e/status'))
  // Completa el rango y dispara el dry-run.
  const dateInputs = document.querySelectorAll('input[type="date"]')
  await userEvent.type(dateInputs[0] as HTMLElement, '2025-02-01')
  await userEvent.type(dateInputs[1] as HTMLElement, '2025-02-28')
  await userEvent.click(screen.getByRole('button', { name: /dry-run/i }))
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/fase-e/recalc/dryrun', expect.any(Object)))
}

test('renderiza el impacto (ejemplo que difiere + spillover) sin excepción', async () => {
  await renderAndDryRun()

  // Conteos agregados del nuevo contrato.
  expect(await screen.findByText('120')).toBeInTheDocument()      // cells_evaluated
  expect(screen.getByText('Celdas evaluadas')).toBeInTheDocument()

  // Spillover explícito: 1 celda fuera de rango + la fecha exacta.
  expect(screen.getByText(/celda\(s\) diferirían/i)).toBeInTheDocument()
  const outside = screen.getByTestId('dates-outside-range')
  expect(outside).toHaveTextContent('2025-01-31')

  // Ejemplos: sólo nombres de campos, sin valores. La celda spillover se marca.
  const examples = screen.getByTestId('impact-examples')
  expect(within(examples).getByText(/emp 11/)).toHaveTextContent('worked_minutes, status')
  expect(within(examples).getByText(/emp 12/)).toHaveTextContent('(fuera de rango)')
  expect(within(examples).getByText(/emp 13/)).toHaveTextContent('crea')
})

test('el apply reenvía el plan_digest del dry-run (paridad P1-F)', async () => {
  await renderAndDryRun()

  // plan_digest visible (recortado) en la UI.
  expect(screen.getByTestId('plan-digest')).toHaveTextContent('abcdef012345')

  // Confirma backup + frase tipeada, luego aplica.
  await userEvent.click(screen.getByRole('checkbox'))
  await userEvent.type(screen.getByPlaceholderText(/RECALCULAR/i), 'RECALCULAR')
  await userEvent.click(screen.getByRole('button', { name: /aplicar recálculo/i }))

  await waitFor(() => expect(apiPost).toHaveBeenCalledWith(
    '/api/fase-e/recalc/apply',
    expect.objectContaining({ plan_digest: IMPACT.plan_digest, confirm: 'RECALCULAR', backup_confirmed: true }),
  ))
})

test('la consola ya no ofrece aplicar migraciones desde HTTP', async () => {
  render(<ActivacionMotorPage />)
  await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/fase-e/status'))
  expect(screen.queryByRole('button', { name: /aplicar migraciones/i })).not.toBeInTheDocument()
  expect(screen.queryByText(/APLICAR MIGRACIONES/)).not.toBeInTheDocument()
})
