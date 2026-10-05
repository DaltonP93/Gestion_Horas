/**
 * REPRODUCCIÓN (falla sobre ee70c72): tras un DELETE/PUT de plantilla RECHAZADO,
 * toggleTemplate llama a loadTemplates(); un GET exitoso hace setTemplatesErr(null)
 * y BORRA el error de la operación fallida. El error de la operación debe quedar
 * visible aunque el refresco (GET) tenga éxito. Se cubre 404 y 500, en DELETE
 * (desactivar) y PUT (reactivar).
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import EvaluacionesPage from '../page'
import { api } from '@/lib/api'

jest.mock('@/lib/api', () => ({ api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() } }))
jest.mock('@/lib/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'admin', role: 'admin', employee_id: null }),
}))

const g = api.get as jest.Mock
const del = api.delete as jest.Mock
const put = api.put as jest.Mock

function mockTemplates(active: number) {
  g.mockImplementation((url: string) => {
    if (url.startsWith('/api/appraisals?')) return Promise.resolve({ data: { data: [], total: 0 } })
    if (url.includes('/templates')) {
      return Promise.resolve({ data: { data: [{ id: 7, name: 'Plantilla T', scale_min: 1, scale_max: 5, criteria_count: 2, active }] } })
    }
    return Promise.resolve({ data: { data: [] } })
  })
}

async function openTemplatesTabAndToggle(label: string) {
  render(<EvaluacionesPage />)
  fireEvent.click(await screen.findByText('Plantillas'))        // cambia de pestaña
  fireEvent.click(await screen.findByText(label))               // botón de la plantilla (Activa/Inactiva)
}

beforeEach(() => jest.clearAllMocks())

describe('toggleTemplate — el error de la operación fallida persiste tras un GET exitoso (ee70c72)', () => {
  it('DELETE rechazado 404 + GET exitoso → sigue visible "La plantilla ya no existe"', async () => {
    mockTemplates(1)
    del.mockRejectedValue({ response: { status: 404 } })
    await openTemplatesTabAndToggle('Activa')
    await waitFor(() => expect(del).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('La plantilla ya no existe')).toBeInTheDocument())
  })

  it('DELETE rechazado 500 + GET exitoso → sigue visible el error de la operación', async () => {
    mockTemplates(1)
    del.mockRejectedValue({ response: { status: 500 } })
    await openTemplatesTabAndToggle('Activa')
    await waitFor(() => expect(del).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Error al guardar')).toBeInTheDocument())
  })

  it('PUT (reactivar) rechazado 500 + GET exitoso → sigue visible el error de la operación', async () => {
    mockTemplates(0)
    put.mockRejectedValue({ response: { status: 500 } })
    await openTemplatesTabAndToggle('Inactiva')
    await waitFor(() => expect(put).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Error al guardar')).toBeInTheDocument())
  })

  // ── Control positivo: una operación EXITOSA no deja error visible ──
  it('control positivo: DELETE exitoso + GET exitoso → sin error visible', async () => {
    mockTemplates(1)
    del.mockResolvedValue({ data: { ok: true } })
    await openTemplatesTabAndToggle('Activa')
    await waitFor(() => expect(del).toHaveBeenCalled())
    await waitFor(() => expect(g).toHaveBeenCalledWith('/api/appraisals/templates?all=1'))
    expect(screen.queryByText('La plantilla ya no existe')).not.toBeInTheDocument()
    expect(screen.queryByText('Error al guardar')).not.toBeInTheDocument()
  })
})
