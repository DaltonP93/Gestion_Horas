/**
 * Jest para pruebas unitarias de lógica pura del frontend (sin React/DOM).
 * Sólo transpila TS con ts-jest en modo aislado (rápido, sin type-check global).
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Resuelve el alias `@/*` → `src/*` (igual que tsconfig) para poder importar
  // el registro real de módulos (navModules) en las pruebas.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      isolatedModules: true,
      tsconfig: { module: 'commonjs', esModuleInterop: true, target: 'es2020' },
    }],
  },
}
