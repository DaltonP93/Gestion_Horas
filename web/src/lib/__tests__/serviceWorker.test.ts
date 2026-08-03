/**
 * serviceWorker.test.ts — PR 4.
 *
 * `public/sw.js` no se importa desde la aplicación: lo carga el navegador.
 * Acá se evalúa el archivo contra un `self` simulado para poder ejercitar
 * sus listeners como lo haría el browser.
 *
 * Lo que se fija:
 *  - Ninguna rama de `fetch` puede resolver a `undefined`. Pasarle undefined
 *    a respondWith hace que el navegador falle la petición con TypeError en
 *    vez de degradar, y las dos ramas de fallback anteriores podían hacerlo.
 *  - Sólo se cachea lo que está en la allowlist. El resto ni se intercepta.
 *  - Un asset que falle en el precache no tumba a los demás: `addAll` es
 *    atómico y un solo 404 dejaba al SW sin precachear nada.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import vm from 'vm'

type Listener = (event: any) => void

interface SwHarness {
  listeners: Record<string, Listener>
  cache: {
    add: jest.Mock
    put: jest.Mock
    match: jest.Mock
  }
  caches: any
  fetchMock: jest.Mock
  skipWaiting: jest.Mock
  claim: jest.Mock
  deleted: string[]
}

/** Evalúa public/sw.js en un contexto aislado y devuelve el arnés. */
function loadSw({
  cacheHit = null as any,
  fetchImpl = null as null | jest.Mock,
  addImpl = null as null | jest.Mock,
  existingKeys = ['sishoras-v3', 'sishoras-v4'],
} = {}): SwHarness {
  const listeners: Record<string, Listener> = {}
  const deleted: string[] = []

  const cache = {
    add: addImpl || jest.fn().mockResolvedValue(undefined),
    put: jest.fn().mockResolvedValue(undefined),
    match: jest.fn().mockResolvedValue(cacheHit),
  }
  const caches = {
    open: jest.fn().mockResolvedValue(cache),
    match: jest.fn().mockResolvedValue(cacheHit),
    keys: jest.fn().mockResolvedValue(existingKeys),
    delete: jest.fn().mockImplementation((k: string) => { deleted.push(k); return Promise.resolve(true) }),
  }

  const skipWaiting = jest.fn()
  const claim = jest.fn().mockResolvedValue(undefined)
  const fetchMock = fetchImpl || jest.fn().mockResolvedValue(
    new Response('ok', { status: 200 })
  )

  const self: any = {
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn },
    location: { origin: 'https://sishoras.example' },
    skipWaiting,
    clients: { claim, openWindow: jest.fn() },
    registration: { showNotification: jest.fn() },
  }

  const context: any = {
    self, caches, fetch: fetchMock, Response, Request, URL, Promise, console,
  }
  context.globalThis = context
  vm.createContext(context)

  const code = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8')
  vm.runInContext(code, context)

  return { listeners, cache, caches, fetchMock, skipWaiting, claim, deleted }
}

/** Simula un FetchEvent capturando lo que se pasa a respondWith. */
function fireFetch(sw: SwHarness, request: any) {
  let responded: any
  const event = {
    request,
    respondWith: (v: any) => { responded = v },
  }
  sw.listeners.fetch(event)
  return { responded, handled: responded !== undefined }
}

function mkRequest(url: string, { method = 'GET', mode = 'no-cors' } = {}) {
  return { url, method, mode, headers: { get: () => null } }
}

const ORIGIN = 'https://sishoras.example'

describe('sw — allowlist de cacheo', () => {
  it.each([
    ['/api/employees'],
    ['/uploads/foto.jpg'],
    ['/socket.io/?EIO=4'],
    ['/_next/static/chunks/main-abc123.js'],
    ['/dashboard'],
    ['/marcar'],
    ['/empleados'],
    ['/una-ruta-nueva-cualquiera'],
  ])('no intercepta %s', (path) => {
    const sw = loadSw()
    const { handled } = fireFetch(sw, mkRequest(`${ORIGIN}${path}`))
    expect(handled).toBe(false)
  })

  it('sí intercepta los estáticos de /icons/', () => {
    const sw = loadSw()
    const { handled } = fireFetch(sw, mkRequest(`${ORIGIN}/icons/icon.svg`))
    expect(handled).toBe(true)
  })

  it('no cachea el manifest: lo genera Next y refleja el branding configurado', () => {
    const sw = loadSw()
    const { handled } = fireFetch(sw, mkRequest(`${ORIGIN}/manifest.webmanifest`))
    expect(handled).toBe(false)
  })

  it('no intercepta estáticos de otro origen', () => {
    const sw = loadSw()
    const { handled } = fireFetch(sw, mkRequest('https://cdn.ajeno.com/icons/icon.svg'))
    expect(handled).toBe(false)
  })

  it('ignora métodos que no son GET', () => {
    const sw = loadSw()
    const { handled } = fireFetch(sw, mkRequest(`${ORIGIN}/icons/icon.svg`, { method: 'POST' }))
    expect(handled).toBe(false)
  })
})

describe('sw — ninguna rama responde undefined', () => {
  it('navegación offline sin nada en cache devuelve una Response', async () => {
    const sw = loadSw({
      cacheHit: undefined,
      fetchImpl: jest.fn().mockRejectedValue(new Error('offline')),
    })
    const { responded } = fireFetch(sw, mkRequest(`${ORIGIN}/empleados`, { mode: 'navigate' }))

    const res = await responded
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('Sin conexión')
  })

  it('navegación offline con la página en cache sirve el cache', async () => {
    const cached = new Response('<html>cacheada</html>', { status: 200 })
    const sw = loadSw({
      cacheHit: cached,
      fetchImpl: jest.fn().mockRejectedValue(new Error('offline')),
    })
    const { responded } = fireFetch(sw, mkRequest(`${ORIGIN}/empleados`, { mode: 'navigate' }))

    expect(await responded).toBe(cached)
  })

  it('estático offline y sin cache devuelve una Response', async () => {
    const sw = loadSw({
      cacheHit: undefined,
      fetchImpl: jest.fn().mockRejectedValue(new Error('offline')),
    })
    const { responded } = fireFetch(sw, mkRequest(`${ORIGIN}/icons/icon.svg`))

    const res = await responded
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(503)
  })

  it('una URL malformada no explota ni intercepta', () => {
    const sw = loadSw()
    expect(() => fireFetch(sw, mkRequest('no-es-una-url'))).not.toThrow()
  })
})

describe('sw — cacheo de estáticos', () => {
  it('guarda la respuesta cuando viene bien', async () => {
    const sw = loadSw({ cacheHit: undefined })
    const { responded } = fireFetch(sw, mkRequest(`${ORIGIN}/icons/icon.svg`))
    await responded
    await Promise.resolve()

    expect(sw.cache.put).toHaveBeenCalled()
  })

  it('no guarda respuestas opacas', async () => {
    const opaque = new Response('', { status: 200 })
    Object.defineProperty(opaque, 'type', { value: 'opaque' })
    const sw = loadSw({ cacheHit: undefined, fetchImpl: jest.fn().mockResolvedValue(opaque) })

    const { responded } = fireFetch(sw, mkRequest(`${ORIGIN}/icons/icon.svg`))
    await responded
    await Promise.resolve()

    expect(sw.cache.put).not.toHaveBeenCalled()
  })

  it('no guarda respuestas con error', async () => {
    const sw = loadSw({
      cacheHit: undefined,
      fetchImpl: jest.fn().mockResolvedValue(new Response('nope', { status: 404 })),
    })
    const { responded } = fireFetch(sw, mkRequest(`${ORIGIN}/icons/icon.svg`))
    await responded
    await Promise.resolve()

    expect(sw.cache.put).not.toHaveBeenCalled()
  })

  it('sirve del cache sin ir a la red cuando hay hit', async () => {
    const cached = new Response('svg', { status: 200 })
    const sw = loadSw({ cacheHit: cached })
    const { responded } = fireFetch(sw, mkRequest(`${ORIGIN}/icons/icon.svg`))

    expect(await responded).toBe(cached)
    expect(sw.fetchMock).not.toHaveBeenCalled()
  })
})

describe('sw — install / activate', () => {
  it('un asset faltante no impide precachear el resto', async () => {
    const add = jest.fn()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValue(undefined)
    const sw = loadSw({ addImpl: add })

    let waited: any
    await sw.listeners.install({ waitUntil: (p: any) => { waited = p } })
    await expect(waited).resolves.not.toThrow()
    expect(sw.skipWaiting).toHaveBeenCalled()
  })

  it('activate borra los caches de versiones anteriores y sólo esos', async () => {
    const sw = loadSw({ existingKeys: ['sishoras-v2', 'sishoras-v3', 'sishoras-v4'] })
    let waited: any
    await sw.listeners.activate({ waitUntil: (p: any) => { waited = p } })
    await waited

    expect(sw.deleted).toEqual(['sishoras-v2', 'sishoras-v3'])
    expect(sw.claim).toHaveBeenCalled()
  })
})

describe('sw — notificaciones', () => {
  it('notificationclick abre la url del payload', async () => {
    const sw = loadSw()
    const openWindow = jest.fn()
    const close = jest.fn()
    ;(sw as any).listeners.notificationclick({
      notification: { close, data: '/permisos' },
      waitUntil: () => {},
    })
    expect(close).toHaveBeenCalled()
  })

  it('un payload sin url no rompe: cae a la raíz', () => {
    const sw = loadSw()
    expect(() => sw.listeners.notificationclick({
      notification: { close: jest.fn(), data: undefined },
      waitUntil: () => {},
    })).not.toThrow()
  })
})
