import type { Metadata, Viewport } from 'next'
import { Inter, Space_Grotesk } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import { SwRegister } from '@/components/SwRegister'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-space-grotesk',
})

export const metadata: Metadata = {
  title: 'SisHoras — Sistema de Asistencia',
  description: 'Control de asistencia y marcación biométrica en tiempo real',
  manifest: '/manifest.webmanifest',
  applicationName: 'SisHoras',
  appleWebApp: {
    capable: true,
    title: 'SisHoras',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    apple: '/icons/icon.svg',
    icon:  '/icons/icon.svg',
  },
  other: {
    // iOS: permite instalación como app de pantalla completa
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'black-translucent',
  },
}

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',   // safe-area iPhone (notch / home indicator)
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className={inter.className}>
        <Providers>{children}</Providers>
        <SwRegister />
      </body>
    </html>
  )
}
