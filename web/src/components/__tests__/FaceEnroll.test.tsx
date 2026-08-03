/**
 * FaceEnroll — carga de modelos, cámara y enrolamiento.
 *
 * La biblioteca se mockea: importarla de verdad traería TensorFlow entero a
 * jsdom. Lo que se verifica es el contrato del componente — cuántas veces
 * carga, qué estados muestra, y sobre todo que la cámara quede apagada en
 * todos los caminos de salida.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FaceEnroll from '../FaceEnroll'
import { __resetFaceApiCache } from '@/lib/faceApi'

const apiGet = jest.fn()
const apiPut = jest.fn()
const apiPost = jest.fn()
const apiDelete = jest.fn()

jest.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    put: (...a: unknown[]) => apiPut(...a),
    post: (...a: unknown[]) => apiPost(...a),
    delete: (...a: unknown[]) => apiDelete(...a),
  },
}))

const loadFromUri = jest.fn().mockResolvedValue(undefined)
const detectSingleFace = jest.fn()

const faceApiModule = {
  nets: {
    tinyFaceDetector:      { loadFromUri },
    faceRecognitionNet:    { loadFromUri },
    faceLandmark68TinyNet: { loadFromUri },
  },
  TinyFaceDetectorOptions: function () { return {} },
  detectSingleFace: (...a: unknown[]) => detectSingleFace(...a),
}

const importSpy = jest.fn().mockResolvedValue(faceApiModule)
jest.mock('@vladmandic/face-api', () => importSpy(), { virtual: true })

// ── Cámara simulada ─────────────────────────────────────────────
const stop = jest.fn()
let tracks: { stop: jest.Mock }[] = []
const getUserMedia = jest.fn()

function mkStream() {
  tracks = [{ stop }, { stop }]
  return { getTracks: () => tracks } as unknown as MediaStream
}

/** Detección con rostro: devuelve un descriptor de 128 dimensiones. */
function conRostro() {
  detectSingleFace.mockReturnValue({
    withFaceLandmarks: () => ({
      withFaceDescriptor: () => Promise.resolve({ descriptor: new Float32Array(128).fill(0.1) }),
    }),
  })
}
function sinRostro() {
  detectSingleFace.mockReturnValue({
    withFaceLandmarks: () => ({ withFaceDescriptor: () => Promise.resolve(undefined) }),
  })
}

beforeAll(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: (...a: unknown[]) => getUserMedia(...a) },
    writable: true, configurable: true,
  })
  // jsdom no implementa estos métodos de <video>/<canvas>.
  HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue(undefined)
  HTMLMediaElement.prototype.pause = jest.fn()
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({ drawImage: jest.fn() })) as never
  HTMLCanvasElement.prototype.toDataURL = jest.fn(() => 'data:image/jpeg;base64,AAA')
  global.fetch = jest.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob(['x'])) }) as never
  global.confirm = jest.fn(() => true) as never
})

beforeEach(() => {
  jest.clearAllMocks()
  __resetFaceApiCache()
  importSpy.mockResolvedValue(faceApiModule)
  loadFromUri.mockResolvedValue(undefined)
  getUserMedia.mockResolvedValue(mkStream())
  apiGet.mockResolvedValue({ data: { has_face: false } })
  apiPost.mockResolvedValue({ data: { url: '/uploads/face.jpg' } })
  apiPut.mockResolvedValue({ data: {} })
  conRostro()
})

const enrolar = () => screen.getByRole('button', { name: /enrolar rostro/i })

describe('FaceEnroll — carga de modelos', () => {
  it('carga los tres modelos desde la ruta local, no de un CDN', async () => {
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())

    await waitFor(() => expect(loadFromUri).toHaveBeenCalledTimes(3))
    for (const call of loadFromUri.mock.calls) {
      expect(call[0]).toBe('/face-models')
    }
  })

  it('clics repetidos no disparan varias descargas', async () => {
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)

    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /cancelar/i }))
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())

    // La promesa está cacheada: los tres modelos se cargan una sola vez en
    // total, no una vez por clic.
    expect(loadFromUri).toHaveBeenCalledTimes(3)
  })

  it('un manifiesto ausente se informa como archivos faltantes', async () => {
    loadFromUri.mockRejectedValue(new Error('failed to fetch manifest 404'))
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Faltan los archivos de modelo/i)
    )
  })

  it('un fallo de red al traer los pesos se distingue', async () => {
    loadFromUri.mockRejectedValue(new Error('Failed to fetch'))
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/No se pudieron descargar los modelos/i)
    )
  })

  it('tras un error se puede reintentar: la promesa fallida no queda cacheada', async () => {
    loadFromUri.mockRejectedValueOnce(new Error('Failed to fetch'))
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    loadFromUri.mockResolvedValue(undefined)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())
  })
})

describe('FaceEnroll — cámara', () => {
  it('el permiso denegado se explica y no deja la cámara abierta', async () => {
    const err = new Error('denied'); err.name = 'NotAllowedError'
    getUserMedia.mockRejectedValue(err)
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Permiso de cámara denegado/i)
    )
  })

  it('una cámara ocupada tiene su propio mensaje', async () => {
    const err = new Error('busy'); err.name = 'NotReadableError'
    getUserMedia.mockRejectedValue(err)
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/otra aplicación/i)
    )
  })

  it('cancelar detiene todos los tracks', async () => {
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /cancelar/i }))
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('desmontar mientras cargan los modelos no llega a pedir la cámara', async () => {
    const resolvers: ((v: unknown) => void)[] = []
    loadFromUri.mockImplementation(() => new Promise(res => { resolvers.push(res) }))
    const user = userEvent.setup()
    const { unmount } = render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(resolvers.length).toBe(3))

    unmount()
    resolvers.forEach(r => r(undefined))
    await new Promise(r => setTimeout(r, 0))

    // Encender la cámara para un componente que ya no existe la dejaría
    // prendida sin nadie que la apague.
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('un stream que llega después del desmontaje se apaga igual', async () => {
    let entregar: (s: MediaStream) => void = () => {}
    getUserMedia.mockImplementation(() => new Promise(res => { entregar = res as never }))
    const user = userEvent.setup()
    const { unmount } = render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())

    // El permiso se concede después de que el usuario navegó a otra parte.
    unmount()
    entregar(mkStream())
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(2))
  })

  it('desmontar con la cámara abierta la libera', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())

    unmount()
    expect(stop).toHaveBeenCalledTimes(2)
  })
})

describe('FaceEnroll — captura', () => {
  it('sin rostro vuelve a capturar sin apagar la cámara', async () => {
    sinRostro()
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /capturar/i }))
    await waitFor(() =>
      expect(screen.getByText(/No se detectó ningún rostro/i)).toBeInTheDocument()
    )
    expect(stop).not.toHaveBeenCalled()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('un enrolamiento correcto envía el descriptor y apaga la cámara', async () => {
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /capturar/i }))
    await waitFor(() => expect(apiPut).toHaveBeenCalled())

    const [url, body] = apiPut.mock.calls[0]
    expect(url).toBe('/api/face/459/enroll')
    expect(body.face_descriptor).toHaveLength(128)
    // La cámara no queda encendida después de enrolar.
    expect(stop).toHaveBeenCalledTimes(2)
    await waitFor(() =>
      expect(screen.getByText(/Rostro enrolado correctamente/i)).toBeInTheDocument()
    )
  })

  it('un fallo al guardar apaga la cámara y no filtra el error crudo', async () => {
    apiPut.mockRejectedValue(new Error('boom en /var/www/sishoras'))
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /capturar/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    expect(stop).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert').textContent).not.toMatch(/\/var\/www|boom/)
  })

  it('ni el descriptor ni la imagen se escriben en consola', async () => {
    const escrito: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
      jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        escrito.push(args.map(a => String(a)).join(' '))
      })
    )
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /capturar/i }))
    await waitFor(() => expect(apiPut).toHaveBeenCalled())

    // jsdom y React escriben avisos propios; lo que no puede aparecer nunca
    // es el dato biométrico.
    const todo = escrito.join('\n')
    expect(todo).not.toMatch(/data:image/)
    expect(todo).not.toMatch(/descriptor/i)
    expect(todo).not.toMatch(/0\.1{1,3},\s*0\.1/)
    for (const s of spies) s.mockRestore()
  })

  it('el descriptor no se guarda en localStorage', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem')
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())
    await waitFor(() => expect(screen.getByRole('button', { name: /capturar/i })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /capturar/i }))
    await waitFor(() => expect(apiPut).toHaveBeenCalled())

    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })
})

describe('FaceEnroll — estados visibles', () => {
  it('muestra el progreso de carga antes de pedir la cámara', async () => {
    // loadFromUri se llama una vez por modelo: hay que retener los tres
    // resolvers, o Promise.all queda colgado al liberar sólo el último.
    const resolvers: ((v: unknown) => void)[] = []
    loadFromUri.mockImplementation(() => new Promise(res => { resolvers.push(res) }))
    const user = userEvent.setup()
    render(<FaceEnroll employeeId={459} />)
    await user.click(enrolar())

    await waitFor(() => expect(screen.getAllByText(/Descargando modelos/i).length).toBeGreaterThan(0))
    expect(getUserMedia).not.toHaveBeenCalled()

    resolvers.forEach(r => r(undefined))
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled())
  })

  it('en modo lectura no ofrece enrolar', async () => {
    apiGet.mockResolvedValue({ data: { has_face: true, face_photo_url: null, face_enrolled_at: null } })
    render(<FaceEnroll employeeId={459} readOnly />)

    await waitFor(() => expect(screen.getByText(/Rostro registrado/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /enrolar/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /eliminar/i })).toBeNull()
  })
})
