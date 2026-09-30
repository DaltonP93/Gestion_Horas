import { canAdministerOnboarding, canManageOnboardingTasks } from '../onboardingRoles'

describe('roles de onboarding (espeja api/src/routes/onboarding.js)', () => {
  test('gestión global: administra y opera tareas', () => {
    for (const r of ['super_admin', 'admin', 'gth', 'hr']) {
      expect([r, canAdministerOnboarding(r), canManageOnboardingTasks(r)]).toEqual([r, true, true])
    }
  })
  test('gestión con alcance: opera tareas pero no administra procesos ni plantillas', () => {
    for (const r of ['manager', 'coordinator', 'gestor']) {
      expect([r, canAdministerOnboarding(r), canManageOnboardingTasks(r)]).toEqual([r, false, true])
    }
  })
  test('supervisor, employee y sin rol: nada', () => {
    for (const r of ['supervisor', 'employee', '', null, undefined]) {
      expect([r, canAdministerOnboarding(r), canManageOnboardingTasks(r)]).toEqual([r, false, false])
    }
  })
})
