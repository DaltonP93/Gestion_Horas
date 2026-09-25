/**
 * AuthImage — imágenes privadas por endpoint autenticado.
 * El token viaja por el cliente `api` (header), nunca en la URL; se muestra un
 * object URL local, se revoca al desmontar y ante error se ve el fallback.
 */
import { render, screen, waitFor } from '@testing-library/react'
import AuthImage from '../AuthImage'

const apiGet = jest.fn()
jest.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => apiGet(...a) } }))

const createObjectURL = jest.fn(() => 'blob:local-1')
const revokeObjectURL = jest.fn()
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
})
beforeEach(() => { apiGet.mockReset(); createObjectURL.mockClear(); revokeObjectURL.mockClear() })

test('pide la imagen como blob al endpoint autenticado y la muestra desde un object URL', async () => {
  apiGet.mockResolvedValue({ data: new Blob(['x'], { type: 'image/png' }) })
  render(<AuthImage src="/api/me/photo" version="/uploads/avatar_1_ab.png" alt="foto" />)
  const img = await screen.findByAltText('foto')
  expect(img.getAttribute('src')).toBe('blob:local-1')
  const [url, cfg] = apiGet.mock.calls[0]
  expect(url).toBe('/api/me/photo')
  expect(cfg.responseType).toBe('blob')
  // el token no va en la URL ni en los parámetros
  expect(JSON.stringify(cfg.params || {})).not.toMatch(/token/i)
  expect(String(url)).not.toMatch(/token/i)
})

test('error de la API → fallback, sin <img>', async () => {
  apiGet.mockRejectedValue(new Error('404'))
  render(<AuthImage src="/api/me/photo" alt="foto" fallback={<span>iniciales</span>} />)
  expect(await screen.findByText('iniciales')).toBeTruthy()
  expect(screen.queryByAltText('foto')).toBeNull()
})

test('sin src no hace pedidos y muestra el fallback', () => {
  render(<AuthImage src={null} alt="foto" fallback={<span>vacío</span>} />)
  expect(apiGet).not.toHaveBeenCalled()
  expect(screen.getByText('vacío')).toBeTruthy()
})

test('revoca el object URL al desmontar', async () => {
  apiGet.mockResolvedValue({ data: new Blob(['x']) })
  const { unmount } = render(<AuthImage src="/api/me/photo" alt="foto" />)
  await screen.findByAltText('foto')
  unmount()
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-1'))
})

test('cambiar version vuelve a pedir la imagen', async () => {
  apiGet.mockResolvedValue({ data: new Blob(['x']) })
  const { rerender } = render(<AuthImage src="/api/me/photo" version="a" alt="foto" />)
  await screen.findByAltText('foto')
  rerender(<AuthImage src="/api/me/photo" version="b" alt="foto" />)
  await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2))
})
