/**
 * Reglas de la vista previa de documentos.
 */

import {
  resolveMime, previewKind, previewErrorMessage, isEmptyBlob,
} from '../documentPreview'

describe('resolveMime', () => {
  it('prefiere el tipo del blob', () => {
    expect(resolveMime('application/pdf', 'image/png', 'x.docx')).toBe('application/pdf')
  })

  it('cae al mime registrado cuando el blob viene genérico', () => {
    expect(resolveMime('application/octet-stream', 'image/png', 'x.docx')).toBe('image/png')
    expect(resolveMime('', 'image/png', 'x.docx')).toBe('image/png')
    expect(resolveMime(null, 'image/png', null)).toBe('image/png')
  })

  it('cae a la extensión cuando no hay mime en ningún lado', () => {
    // Documentos viejos guardados sin `mime`.
    expect(resolveMime(null, null, 'recibo.pdf')).toBe('application/pdf')
    expect(resolveMime('application/octet-stream', null, 'foto.JPEG')).toBe('image/jpeg')
    expect(resolveMime(null, null, 'planilla.xlsx'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('descarta parámetros del content-type y normaliza a minúsculas', () => {
    expect(resolveMime('APPLICATION/PDF; charset=binary', null, null)).toBe('application/pdf')
  })

  it('sin datos suficientes devuelve null', () => {
    expect(resolveMime(null, null, null)).toBeNull()
    expect(resolveMime(null, null, 'archivo_sin_extension')).toBeNull()
    expect(resolveMime(null, null, 'raro.zip')).toBeNull()
  })
})

describe('previewKind', () => {
  it('reconoce PDF', () => {
    expect(previewKind('application/pdf')).toBe('pdf')
  })

  it.each(['image/jpeg', 'image/png', 'image/webp'])('reconoce la imagen %s', (m) => {
    expect(previewKind(m)).toBe('image')
  })

  it.each([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/html',
    'image/svg+xml',
    null,
    undefined,
    '',
  ])('no intenta renderizar %s', (m) => {
    expect(previewKind(m as string)).toBe('unsupported')
  })

  it('svg queda fuera a propósito: puede traer script embebido', () => {
    expect(previewKind('image/svg+xml')).toBe('unsupported')
  })
})

describe('previewErrorMessage', () => {
  const withStatus = (status: number) => ({ response: { status } })

  it('401 habla de sesión expirada', () => {
    expect(previewErrorMessage(withStatus(401))).toMatch(/sesión/i)
  })
  it('403 habla de permiso', () => {
    expect(previewErrorMessage(withStatus(403))).toMatch(/permiso/i)
  })
  it('404 dice que ya no existe', () => {
    expect(previewErrorMessage(withStatus(404))).toMatch(/no existe/i)
  })
  it('410 distingue el archivo físico ausente', () => {
    const msg = previewErrorMessage(withStatus(410))
    expect(msg).toMatch(/no está disponible/i)
    expect(msg).toMatch(/administrador/i)
  })
  it('5xx sugiere reintentar', () => {
    expect(previewErrorMessage(withStatus(500))).toMatch(/intentá de nuevo/i)
  })
  it('timeout de axios tiene su propio mensaje', () => {
    expect(previewErrorMessage({ code: 'ECONNABORTED' })).toMatch(/tardó demasiado/i)
  })
  it('error de red cae al mensaje genérico', () => {
    expect(previewErrorMessage(new Error('Network Error'))).toMatch(/conexión/i)
  })
  it('nunca filtra rutas del servidor ni detalles internos', () => {
    const msg = previewErrorMessage({
      response: { status: 410 },
      message: 'ENOENT: /var/www/sishoras/uploads/docs/459/recibo.pdf',
    })
    expect(msg).not.toMatch(/\/var\/|uploads|ENOENT/)
  })
})

describe('isEmptyBlob', () => {
  it('detecta el blob de tamaño cero', () => {
    expect(isEmptyBlob({ size: 0 })).toBe(true)
    expect(isEmptyBlob(null)).toBe(true)
    expect(isEmptyBlob(undefined)).toBe(true)
  })
  it('un blob con contenido no es vacío', () => {
    expect(isEmptyBlob({ size: 1024 })).toBe(false)
  })
})
