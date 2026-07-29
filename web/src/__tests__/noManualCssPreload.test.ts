/**
 * Guardia contra preloads de CSS MANUALES incorrectos.
 *
 * Contexto: los warnings de Chrome "The resource <chunk>.css was preloaded using
 * link preload but not used…" NO deben reintroducirse por código propio. El
 * build de Next 16 entrega el CSS como <link rel="stylesheet"> (verificado: 0
 * preloads de CSS en el HTML). Este test FALLA si alguien agrega manualmente un
 * preload de CSS —vía <link rel="preload" as="style">, ReactDOM.preload/preinit
 * de un .css, o un header Link de preload— en el código fuente del frontend.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..') // web/src

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...walk(p))
    } else if (/\.(tsx?|jsx?)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

// Patrones que indican un preload de CSS MANUAL (no el manejo automático de Next).
const PATTERNS: { re: RegExp; why: string }[] = [
  { re: /rel=["'`]preload["'`][^>]*as=["'`]style["'`]/i, why: '<link rel="preload" as="style"> manual' },
  { re: /as=["'`]style["'`][^>]*rel=["'`]preload["'`]/i, why: '<link as="style" rel="preload"> manual' },
  { re: /\b(?:ReactDOM\.)?(?:preload|preinit)\s*\(\s*[^)]*\.css/i, why: 'ReactDOM.preload/preinit de un .css' },
  { re: /Link:\s*<[^>]*\.css[^>]*>\s*;\s*rel=preload/i, why: 'header Link: <...css>; rel=preload' },
]

describe('sin preloads de CSS manuales en el código', () => {
  const files = walk(SRC)

  test('hay archivos fuente para revisar', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  test('ningún archivo introduce un preload de CSS manual', () => {
    const offenders: string[] = []
    for (const f of files) {
      const txt = readFileSync(f, 'utf8')
      for (const { re, why } of PATTERNS) {
        if (re.test(txt)) offenders.push(`${f.replace(SRC, 'src')}: ${why}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
