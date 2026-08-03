/**
 * faceApi.ts — carga de la biblioteca de reconocimiento facial y sus modelos.
 *
 * Antes esto se hacía inyectando un <script type="module"> con un import
 * remoto a jsdelivr, avisando por un evento en `window` y con un timeout de
 * 20s. Además pedía los pesos a `.../dist/models`, que no existe: el paquete
 * los publica en `model/`. El CDN devolvía 404 y el enrolamiento nunca
 * funcionó.
 *
 * Ahora la biblioteca entra por el bundler (import dinámico, se descarga sólo
 * al usarse) y los pesos se sirven desde `/face-models`, copiados en el build
 * desde la misma versión exacta instalada. Cero red externa en runtime.
 *
 * Las dos cargas se cachean en una promesa única: varios clics seguidos
 * comparten la misma descarga en lugar de disparar una por clic.
 */

export const MODELS_URL = '/face-models'

/** Superficie de face-api que usa la aplicación. */
export interface FaceApi {
  nets: {
    tinyFaceDetector: { loadFromUri: (url: string) => Promise<void> }
    faceRecognitionNet: { loadFromUri: (url: string) => Promise<void> }
    faceLandmark68TinyNet: { loadFromUri: (url: string) => Promise<void> }
  }
  TinyFaceDetectorOptions: new (opts: { inputSize: number; scoreThreshold: number }) => unknown
  detectSingleFace: (input: unknown, opts: unknown) => {
    withFaceLandmarks: (tiny: boolean) => {
      withFaceDescriptor: () => Promise<{ descriptor: Float32Array } | undefined>
    }
  }
}

let libPromise: Promise<FaceApi> | null = null
let modelsPromise: Promise<FaceApi> | null = null

/** Carga la biblioteca una sola vez. Reintenta si la carga anterior falló. */
export function loadFaceApi(): Promise<FaceApi> {
  if (!libPromise) {
    libPromise = import('@vladmandic/face-api')
      .then(m => ((m as unknown as { default?: FaceApi }).default ?? m) as unknown as FaceApi)
      .catch(err => {
        // Una promesa rechazada cacheada dejaría la función rota para siempre
        // en esa sesión; se suelta para permitir reintentar.
        libPromise = null
        throw err
      })
  }
  return libPromise
}

/**
 * Carga los tres modelos una sola vez. Devuelve la biblioteca ya lista para
 * detectar, de modo que quien llama no tiene que coordinar ambas cargas.
 */
export function loadFaceModels(onStage?: (stage: 'library' | 'models') => void): Promise<FaceApi> {
  if (!modelsPromise) {
    onStage?.('library')
    modelsPromise = loadFaceApi()
      .then(async fa => {
        onStage?.('models')
        await Promise.all([
          fa.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
          fa.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
          fa.nets.faceLandmark68TinyNet.loadFromUri(MODELS_URL),
        ])
        return fa
      })
      .catch(err => {
        modelsPromise = null
        throw err
      })
  }
  return modelsPromise
}

/** Sólo para pruebas: olvida las cargas cacheadas. */
export function __resetFaceApiCache() {
  libPromise = null
  modelsPromise = null
}

/**
 * Mensaje para el usuario. No se vuelca el error crudo, que puede traer URLs
 * internas y no le dice nada a quien está frente a la cámara.
 */
export function faceLoadErrorMessage(err: unknown): string {
  const msg = String((err as Error)?.message || '')
  if (/manifest/i.test(msg) || /404/.test(msg)) {
    return 'Faltan los archivos de modelo en el servidor. Avisá a un administrador.'
  }
  if (/fetch|network|Failed to fetch/i.test(msg)) {
    return 'No se pudieron descargar los modelos. Verificá la conexión.'
  }
  return 'No se pudo iniciar el reconocimiento facial.'
}

/** Mensaje para los fallos de `getUserMedia`. */
export function cameraErrorMessage(err: unknown): string {
  const name = (err as Error)?.name || ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Permiso de cámara denegado. Habilitalo en el navegador para continuar.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No se encontró una cámara disponible.'
    case 'NotReadableError':
      return 'La cámara está siendo usada por otra aplicación.'
    default:
      return 'No se pudo acceder a la cámara.'
  }
}
