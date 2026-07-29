import {
  parseSecuritySection,
  securitySectionHref,
  collapseDuplicateHashes,
  DEFAULT_SECURITY_SECTION,
} from '@/lib/accountSection'

describe('parseSecuritySection', () => {
  test('extrae `section` del query', () => {
    expect(parseSecuritySection('/cuenta/seguridad?section=password')).toBe('password')
    expect(parseSecuritySection('/cuenta/seguridad?section=sessions')).toBe('sessions')
    expect(parseSecuritySection('/cuenta/seguridad?section=2fa')).toBe('2fa')
  })

  test('tolera hash legado `#password`', () => {
    expect(parseSecuritySection('/cuenta/seguridad#password')).toBe('password')
    expect(parseSecuritySection('/cuenta/seguridad#sessions')).toBe('sessions')
    expect(parseSecuritySection('/cuenta/seguridad#2fa')).toBe('2fa')
  })

  test('normaliza `#password#password` a `password`', () => {
    expect(parseSecuritySection('/cuenta/seguridad#password#password')).toBe('password')
    expect(parseSecuritySection('/cuenta/seguridad#foo#sessions')).toBe('sessions')
  })

  test('query gana sobre hash', () => {
    expect(parseSecuritySection('/cuenta/seguridad?section=2fa#password')).toBe('2fa')
  })

  test('desconocido o vacío → default password', () => {
    expect(parseSecuritySection('/cuenta/seguridad')).toBe(DEFAULT_SECURITY_SECTION)
    expect(parseSecuritySection('/cuenta/seguridad?section=xxx')).toBe(DEFAULT_SECURITY_SECTION)
    expect(parseSecuritySection('/cuenta/seguridad#nope')).toBe(DEFAULT_SECURITY_SECTION)
    expect(parseSecuritySection(undefined)).toBe(DEFAULT_SECURITY_SECTION)
    expect(parseSecuritySection('')).toBe(DEFAULT_SECURITY_SECTION)
  })

  test('mayúsculas y espacios se normalizan', () => {
    expect(parseSecuritySection('/cuenta/seguridad?section=Password')).toBe('password')
    expect(parseSecuritySection('/cuenta/seguridad#  SESSIONS  ')).toBe('sessions')
  })
})

describe('securitySectionHref', () => {
  test('genera la URL canónica con query param', () => {
    expect(securitySectionHref('password')).toBe('/cuenta/seguridad?section=password')
    expect(securitySectionHref('sessions')).toBe('/cuenta/seguridad?section=sessions')
    expect(securitySectionHref('2fa')).toBe('/cuenta/seguridad?section=2fa')
  })
})

describe('collapseDuplicateHashes', () => {
  test('reduce hashes duplicados', () => {
    expect(collapseDuplicateHashes('/cuenta/seguridad#password#password')).toBe('/cuenta/seguridad#password')
    expect(collapseDuplicateHashes('/cuenta/seguridad#sessions#password')).toBe('/cuenta/seguridad#sessions')
    expect(collapseDuplicateHashes('/cuenta/seguridad')).toBe('/cuenta/seguridad')
  })

  test('preserva ancla desconocida si no hay conocidas', () => {
    expect(collapseDuplicateHashes('/otro#foo#bar')).toBe('/otro#foo')
  })
})
