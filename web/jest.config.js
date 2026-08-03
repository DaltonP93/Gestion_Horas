/**
 * Jest del frontend, en dos proyectos:
 *   - `node`: lógica pura (`*.test.ts`), sin DOM. Rápido.
 *   - `dom`:  componentes React con Testing Library (`*.test.tsx`).
 * Sólo transpila TS con ts-jest en modo aislado (sin type-check global; de
 * eso se encarga `tsc --noEmit` por separado).
 */
const shared = {
  roots: ['<rootDir>/src'],
  // Resuelve el alias `@/*` → `src/*` (igual que tsconfig).
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      isolatedModules: true,
      tsconfig: { module: 'commonjs', esModuleInterop: true, target: 'es2020', jsx: 'react-jsx' },
    }],
  },
}

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      ...shared,
      displayName: 'node',
      testEnvironment: 'node',
      testMatch: ['**/__tests__/**/*.test.ts'],
    },
    {
      ...shared,
      displayName: 'dom',
      testEnvironment: 'jsdom',
      testMatch: ['**/__tests__/**/*.test.tsx'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.dom.ts'],
    },
  ],
}
