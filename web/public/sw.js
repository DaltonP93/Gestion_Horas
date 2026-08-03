// SisHoras Service Worker — cache estático mínimo + navegación network-first
//
// Cambios de esta versión (v4):
//
//  1. Allowlist en lugar de lista negra. Antes se cacheaba TODO lo que no
//     estuviera explícitamente excluido, así que cada ruta nueva de la
//     aplicación nacía cacheada y había que acordarse de excluirla. Ahora
//     sólo se cachea lo que está declarado como estático; el resto ni
//     siquiera lo intercepta el SW.
//
//  2. Nunca se llama a respondWith(undefined). Las dos ramas de fallback
//     podían resolver a undefined —`caches.match('/')` sin '/' cacheado, y
//     `.catch(() => hit)` con hit undefined—, y eso hace que el navegador
//     falle la petición con TypeError en vez de degradar. Toda rama devuelve
//     una Response de verdad.
//
//  3. El precache ya no es todo-o-nada. `addAll` es atómico: un solo asset
//     que devuelva 404 —un deploy a medias, un ícono renombrado— hacía
//     rechazar la promesa entera y el `.catch(() => {})` se lo tragaba en
//     silencio, quedando el SW sin precachear nada. Ahora cada asset se
//     cachea por separado y el que falle no arrastra a los demás.
//
//  4. '/manifest.webmanifest' sale del cacheo. No es un archivo estático:
//     lo genera Next en `src/app/manifest.ts` y refleja el ícono que se
//     configura en Apariencia. Guardarlo bajo un cache versionado dejaría
//     el branding viejo pegado hasta el siguiente bump de versión.

const CACHE = 'sishoras-v4'

// Assets que el SW sí guarda. Cada uno se precachea de forma independiente.
const PRECACHE = ['/icons/icon.svg']

/**
 * Allowlist de lo cacheable: sólo estáticos propios servidos desde public/.
 * Nada de rutas de la aplicación, nada de /api, nada de /uploads.
 * `/_next/static/` queda afuera a propósito —lleva hash en el nombre y lo
 * gobierna la caché HTTP (Cache-Control: immutable)—; si lo guardara el SW,
 * un deploy dejaría chunks viejos atrapados mezclándose con el HTML nuevo.
 */
function isCacheable(url) {
  if (url.origin !== self.location.origin) return false
  return url.pathname.startsWith('/icons/')
}

/** Respuesta de último recurso: siempre una Response, nunca undefined. */
function offlineResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8">' +
    '<title>Sin conexión</title>' +
    '<body style="font-family:system-ui;padding:2rem;text-align:center">' +
    '<h1>Sin conexión</h1>' +
    '<p>No se pudo contactar al servidor. Verificá la conexión y volvé a intentar.</p>' +
    '</body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // Uno por uno: un asset ausente no debe tumbar el precache entero.
      Promise.all(PRECACHE.map(path => c.add(path).catch(() => {})))
    ).catch(() => {})
  )
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .catch(() => {})
  )
})

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return

  let url
  try { url = new URL(e.request.url) } catch { return }

  // ── Navegaciones: network-first, con fallback que siempre responde ──
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .catch(() => caches.match(e.request).then(hit => hit || offlineResponse()))
    )
    return
  }

  // ── Estáticos de la allowlist: cache-first ──────────────────────────
  if (!isCacheable(url)) return

  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit
      return fetch(e.request).then(res => {
        // Sólo se guardan respuestas propias y correctas. Las opacas
        // (cross-origin, type 'opaque') no se pueden inspeccionar, así que
        // no se cachean.
        if (res && res.ok && res.type !== 'opaque') {
          const clone = res.clone()
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {})
        }
        return res
      }).catch(() => offlineResponse())
    })
  )
})

// Web Push (requiere VAPID en backend)
self.addEventListener('push', e => {
  let data = {}
  try { data = e.data ? e.data.json() : {} } catch {}
  const title = data.title || 'SisHoras'
  const body  = data.body  || 'Nueva notificación'
  e.waitUntil(self.registration.showNotification(title, {
    body,
    // icon.svg es el único ícono que existe en public/; el .png que se
    // referenciaba antes no está y el navegador caía al ícono por defecto.
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    data: data.url || '/',
  }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const target = typeof e.notification.data === 'string' ? e.notification.data : '/'
  e.waitUntil(self.clients.openWindow(target))
})
