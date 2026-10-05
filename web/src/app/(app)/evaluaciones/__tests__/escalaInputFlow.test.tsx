/**
 * REPRODUCCIÓN (falla sobre ee70c72): los inputs de escala de la plantilla usan
 * parseInt antes de validar, de modo que una escala FRACCIONARIA (o en notación
 * exponencial) se TRUNCA y se envía igual. Se prueba el flujo del input hasta el
 * envío (no sólo el validador puro): se escribe en el <input> y se pulsa "Crear
 * plantilla", verificando si se llama (o no) a api.post.
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
const p = api.post as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  g.mockImplementation((url: string) => {
    if (url.startsWith('/api/appraisals?')) return Promise.resolve({ data: { data: [], total: 0 } })
    if (url.includes('/templates')) return Promise.resolve({ data: { data: [] } })
    if (url.includes('/employees')) return Promise.resolve({ data: { data: [] } })
    return Promise.resolve({ data: { data: [] } })
  })
  p.mockResolvedValue({ data: { ok: true, id: 1 } })
})

/** Abre el modal de nueva plantilla y rellena nombre + un criterio válidos. */
async function openModalWithValidNameAndCriterion() {
  render(<EvaluacionesPage />)
  fireEvent.click(await screen.findByText('Nueva plantilla'))
  fireEvent.change(await screen.findByPlaceholderText(/Evaluación anual/), { target: { value: 'Plantilla X' } })
  fireEvent.change(screen.getByPlaceholderText('Criterio 1 *'), { target: { value: 'Calidad' } })
}

/** spinbuttons del modal: [scale_min, scale_max, weight(criterio 1)]. */
const scaleInputs = () => screen.getAllByRole('spinbutton')

describe('TemplateModal — flujo del input de escala hasta el envío (ee70c72)', () => {
  it('escala mínima "1.5" → debe RECHAZARSE sin POST (hoy se trunca a 1 y se envía)', async () => {
    await openModalWithValidNameAndCriterion()
    fireEvent.change(scaleInputs()[0], { target: { value: '1.5' } }) // min; max queda en 5
    fireEvent.click(screen.getByText('Crear plantilla'))
    await waitFor(() => expect(screen.getByText(/enteros entre/i)).toBeInTheDocument())
    expect(p).not.toHaveBeenCalled()
  })

  it('escala máxima "4.5" → debe RECHAZARSE sin POST (hoy se trunca a 4 y se envía)', async () => {
    await openModalWithValidNameAndCriterion()
    fireEvent.change(scaleInputs()[1], { target: { value: '4.5' } }) // max; min queda en 1
    fireEvent.click(screen.getByText('Crear plantilla'))
    await waitFor(() => expect(screen.getByText(/enteros entre/i)).toBeInTheDocument())
    expect(p).not.toHaveBeenCalled()
  })

  it('escala mínima "1e1" → debe RECHAZARSE sin POST (hoy parseInt la vuelve 1)', async () => {
    await openModalWithValidNameAndCriterion()
    fireEvent.change(scaleInputs()[0], { target: { value: '1e1' } }) // min; max queda en 5
    fireEvent.click(screen.getByText('Crear plantilla'))
    await waitFor(() => expect(screen.getByText(/enteros entre/i)).toBeInTheDocument())
    expect(p).not.toHaveBeenCalled()
  })

  // ── Controles positivos (deben seguir funcionando tras el arreglo) ──
  it('control positivo: enteros válidos (min=2, max=6) → POST con esos valores', async () => {
    await openModalWithValidNameAndCriterion()
    fireEvent.change(scaleInputs()[0], { target: { value: '2' } })
    fireEvent.change(scaleInputs()[1], { target: { value: '6' } })
    fireEvent.click(screen.getByText('Crear plantilla'))
    await waitFor(() => expect(p).toHaveBeenCalledTimes(1))
    expect(p).toHaveBeenCalledWith('/api/appraisals/templates', expect.objectContaining({ scale_min: 2, scale_max: 6 }))
  })

  it('control de campo vacío: escala máxima "" → sin POST y con mensaje de escala', async () => {
    await openModalWithValidNameAndCriterion()
    fireEvent.change(scaleInputs()[1], { target: { value: '' } })
    fireEvent.click(screen.getByText('Crear plantilla'))
    await waitFor(() => expect(screen.getByText(/enteros entre/i)).toBeInTheDocument())
    expect(p).not.toHaveBeenCalled()
  })
})
