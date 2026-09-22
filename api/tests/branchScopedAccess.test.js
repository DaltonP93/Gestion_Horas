jest.mock('../src/config/database', () => ({
  sequelize: { query: jest.fn() },
}))

const { sequelize } = require('../src/config/database')
const {
  getVisibleDepartmentIds,
  isScoped,
  isUnrestricted,
} = require('../src/services/departmentScope')

beforeEach(() => {
  jest.clearAllMocks()
})

describe('branch-scoped access', () => {
  test('supervisor resuelve sede desde users.branch_id, no desde employee_id', async () => {
    sequelize.query
      .mockResolvedValueOnce([[{ branch_id: 1 }]])
      .mockResolvedValueOnce([[{ id: 1 }, { id: 2 }, { id: 11 }]])

    const scope = await getVisibleDepartmentIds({
      id: 4,
      role: 'supervisor',
      employee_id: 999,
    })

    expect(scope).toEqual({
      unrestricted: false,
      ids: [1, 2, 11],
      branchIds: [1],
    })
    const sql = sequelize.query.mock.calls.map(c => String(c[0])).join('\n')
    expect(sql).toMatch(/FROM users/i)
    expect(sql).toMatch(/FROM departments/i)
    expect(sql).not.toMatch(/FROM employees/i)
  })

  test('rol scoped sin sede queda fail-closed', async () => {
    sequelize.query.mockResolvedValueOnce([[{ branch_id: null }]])

    const scope = await getVisibleDepartmentIds({
      id: 4,
      role: 'supervisor',
      employee_id: 88,
    })

    expect(scope).toEqual({
      unrestricted: false,
      ids: [],
      branchIds: [],
    })
    expect(sequelize.query).toHaveBeenCalledTimes(1)
  })

  test('error de lectura de sede queda fail-closed', async () => {
    sequelize.query.mockRejectedValueOnce(new Error('db unavailable'))
    const scope = await getVisibleDepartmentIds({ id: 4, role: 'supervisor' })
    expect(scope.ids).toEqual([])
    expect(scope.branchIds).toEqual([])
  })
  test('roles globales siguen unrestricted sin consultar DB', async () => {
    for (const role of ['super_admin', 'admin', 'gth', 'hr']) {
      await expect(getVisibleDepartmentIds({ id: 1, role })).resolves.toEqual({
        unrestricted: true,
      })
    }
    expect(sequelize.query).not.toHaveBeenCalled()
  })

  test('employee no recibe alcance de gestión aunque tenga sede', async () => {
    const scope = await getVisibleDepartmentIds({
      id: 99,
      role: 'employee',
      employee_id: 88,
    })
    expect(scope).toEqual({
      unrestricted: false,
      ids: [],
      branchIds: [],
    })
    expect(sequelize.query).not.toHaveBeenCalled()
  })

  test('clasificación de roles se conserva', () => {
    expect(isScoped('supervisor')).toBe(true)
    expect(isScoped('manager')).toBe(true)
    expect(isUnrestricted('hr')).toBe(true)
    expect(isUnrestricted('supervisor')).toBe(false)
  })
})
