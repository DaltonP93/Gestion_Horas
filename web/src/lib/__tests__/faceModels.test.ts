/**
 * faceModels.test.ts — los pesos de face-api están disponibles y el script
 * que los copia falla ruidosamente si falta alguno.
 *
 * El bug original: FaceEnroll pedía los modelos a `.../dist/models`, pero el
 * paquete los publica en `model/` (singular, fuera de dist). El CDN devolvía
 * 404 y el enrolamiento nunca funcionó. Peor: el error se tragaba y el build
 * pasaba igual.
 */

import { execFileSync } from 'child_process'
import { existsSync, statSync, readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const PUBLIC_MODELS = join(ROOT, 'public', 'face-models')
const SCRIPT = join(ROOT, 'scripts', 'sync-face-models.js')

const REQUIRED = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
  'face_landmark_68_tiny_model-weights_manifest.json',
  'face_landmark_68_tiny_model.bin',
]

describe('modelos de face-api servidos por la aplicación', () => {
  it('el script de sincronización existe y corre sin error', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' })
    expect(out).toMatch(/6 archivo\(s\)/)
  })

  it.each(REQUIRED)('%s está presente y no está vacío', (name) => {
    const p = join(PUBLIC_MODELS, name)
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).size).toBeGreaterThan(0)
  })

  it('cada manifiesto referencia a un .bin que también está copiado', () => {
    const manifests = REQUIRED.filter(n => n.endsWith('.json'))
    for (const m of manifests) {
      const parsed = JSON.parse(readFileSync(join(PUBLIC_MODELS, m), 'utf8'))
      const paths: string[] = parsed.flatMap((g: { paths: string[] }) => g.paths)
      for (const rel of paths) {
        // Si el manifiesto y su binario se desincronizan, el navegador falla
        // al resolver los pesos y no hay forma de verlo hasta producción.
        expect(existsSync(join(PUBLIC_MODELS, rel))).toBe(true)
      }
    }
  })

  it('la versión de la biblioteca está fijada de forma exacta', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const dep = pkg.dependencies?.['@vladmandic/face-api']
    expect(dep).toBeDefined()
    // Sin ^ ni ~: el JS y los pesos tienen que ser de la misma versión.
    expect(dep).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('el build ejecuta la sincronización antes de compilar', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts.prebuild).toContain('sync:face-models')
  })

  it('el build de exportación también sincroniza', () => {
    // Los hooks pre/post de npm sólo aplican al script del mismo nombre: el
    // `next build` embebido en build:export no dispara `prebuild`, así que
    // la app exportada (Capacitor) saldría sin modelos.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.scripts['build:export']).toContain('sync:face-models')
  })

  it('los modelos generados no se versionan', () => {
    const ignore = readFileSync(join(ROOT, '..', '.gitignore'), 'utf8')
    expect(ignore).toMatch(/web\/public\/face-models/)
  })
})

describe('el código no depende del CDN en runtime', () => {
  /**
   * Lee el archivo sin comentarios: acá se afirma sobre el código que corre,
   * no sobre la documentación, que sí menciona el CDN viejo para explicar
   * por qué se lo sacó.
   */
  const leer = (p: string) =>
    readFileSync(join(ROOT, p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('FaceEnroll no menciona jsdelivr ni inyecta scripts', () => {
    const src = leer('src/components/FaceEnroll.tsx')
    expect(src).not.toMatch(/jsdelivr/)
    expect(src).not.toMatch(/cdn\./)
    expect(src).not.toMatch(/createElement\(['"]script['"]\)/)
    expect(src).not.toMatch(/faceapi_ready/)
    expect(src).not.toMatch(/window\.faceapi/)
  })

  it('el cargador apunta a la ruta local de modelos', () => {
    const src = leer('src/lib/faceApi.ts')
    expect(src).toMatch(/MODELS_URL = '\/face-models'/)
    expect(src).not.toMatch(/jsdelivr/)
  })

  it('el descriptor no se guarda en localStorage ni se registra', () => {
    const src = leer('src/components/FaceEnroll.tsx')
    expect(src).not.toMatch(/localStorage/)
    expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/)
  })
})
