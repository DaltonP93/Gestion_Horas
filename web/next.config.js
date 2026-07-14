/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { remotePatterns: [{ protocol: 'http', hostname: 'localhost' }] },

  /**
   * Headers de seguridad — respaldo en `next dev` y por si nginx no procesa la
   * request (ej. al usar `pm2 logs web` directamente sin nginx delante).
   *
   * En producción, nginx-sishoras.conf agrega los mismos headers; estos no
   * sobreescriben los de nginx, simplemente actúan como respaldo.
   */
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        // Permite GPS y cámara solo desde el mismo origen (necesario para /marcar).
        // Si llegás a empaquetar con Capacitor, el WebView nativo respeta este header igual.
        { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    }]
  },
}

module.exports = nextConfig
