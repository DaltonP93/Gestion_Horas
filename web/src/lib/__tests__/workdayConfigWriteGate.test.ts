import { readFileSync } from 'fs'
import { join } from 'path'

const pageSrc = readFileSync(
  join(__dirname, '../../app/(app)/empleados/[id]/configuracion-laboral/page.tsx'),
  'utf8',
)

describe('configuración laboral — kill switch de escritura en UI', () => {
  test('consulta /meta y deriva canWrite de writes_enabled', () => {
    expect(pageSrc).toMatch(/workdayConfigApi\.meta\(\)/)
    expect(pageSrc).toMatch(/writes_enabled\s*===\s*true/)
    expect(pageSrc).toMatch(/const canWrite = canUpdate && writesEnabled/)
  })

  test('los controles de mutación dependen de canWrite', () => {
    expect(pageSrc).toMatch(/\{canWrite && \(/)
    expect(pageSrc).toMatch(/canUpdate=\{canWrite\}/)
  })

  test('muestra modo sólo lectura cuando RRHH tiene permiso pero el kill switch está OFF', () => {
    expect(pageSrc).toMatch(/Modo sólo lectura/)
    expect(pageSrc).toMatch(/WORKDAY_CONFIG_WRITE_ENABLED/)
  })
})
