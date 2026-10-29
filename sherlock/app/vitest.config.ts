// ============================================================================
// VITEST CONFIGURATION
// ============================================================================
// Configuración de testing para Sherlock
// Usa jsdom para simular el DOM del navegador
// ============================================================================

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    // ===== ENTORNO DE TESTING =====
    environment: 'jsdom',

    // ===== SETUP FILES =====
    setupFiles: ['./src/__tests__/local-storage-setup.ts', './src/__tests__/setup.ts'],

    // ===== INCLUIR/EXCLUIR =====
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    exclude: ['node_modules', '.next'],

    // ===== GLOBALS (para no importar describe, it, expect) =====
    globals: true,

    // ===== TIMEOUTS =====
    // El default de vitest (5s) se calibró contra el runner macOS, que ya no
    // está en la flota. Hoy los tres runners self-hosted son instancias WSL2
    // sobre una sola Lenovo LOQ, así que hasta tres jobs pesados comparten una
    // laptop y los tests de componente con userEvent pierden la carrera:
    // `VdrDashboardStudio` murió con "Test timed out in 5000ms" en el run
    // saturado y pasó en el siguiente, más tranquilo.
    // Esto es holgura de reloj para hardware compartido — NO relaja ninguna
    // aserción: un test que de verdad se cuelga sigue fallando, sólo tarda más
    // en reportarlo.
    testTimeout: 20000,
    hookTimeout: 20000,

    // ===== SERVER DEPS =====
    // Inline zod (ESM-only v4) so vitest SSR transform resolves named exports.
    // Inline @effect/vitest too: bun hoists it to the root node_modules, where it
    // binds the ROOT copy of @vitest/runner while the suite runs on the app copy.
    // Two collector states, so `it.effect` read `undefined.config` and 11 test
    // files collected zero tests without ever going red. Inlining routes it
    // through Vite's resolver, which lands on the app copy.
    server: {
      deps: {
        inline: ['zod', '@effect/vitest'],
      },
    },

    // ===== COVERAGE =====
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html', 'lcov'],
      // ===== COVERAGE THRESHOLDS =====
      // Ratchet policy: these numbers must never decrease; only raise them.
      // Updated 2026-03-25: raised after adding 17 new test files (~390 tests).
      // Measured: lines 24.35%, statements 24.12%, branches 17.62%, functions 18.66%.
      // Updated 2026-07-24 (post Tier B de-embed): the untested engine surface left
      // the repo, so the same suite now covers a much smaller denominator.
      // Measured: lines 35.51%, statements 35.00%, branches 29.34%, functions 28.31%.
      // Updated 2026-07-28: ratchet re-tightened after the test additions of PRs #160-#175.
      // Measured: lines 45.64%, statements 45.03%, branches 37.92%, functions 37.39%.
      // Updated 2026-09-08 ([F]): the drift margin is gone. The wave of Effect
      // tests left real coverage more than thirty points above the old pins,
      // and nothing defended that gain — a PR could have given it all back
      // without turning the ratchet red. The pins are now the measured floor.
      // Measured: lines 81.48%, statements 79.02%, branches 71.66%, functions 79.90%.
      // The cost [F] accepted expressly: a PR that drops a single point below
      // any of these goes red. That is the point.
      thresholds: {
        lines: 81,
        functions: 79,
        branches: 71,
        statements: 79,
      },
      // ===== EXCLUDE FROM COVERAGE =====
      exclude: [
        'node_modules/',
        '.next/',
        'src/__tests__/',
        'convex/_generated/', // Auto-generated Convex files
        'src/components/ui/', // shadcn/ui primitives (already tested by library)
        '**/*.d.ts', // Type definitions
        '**/types.ts', // Pure type files
        '**/*.config.ts', // Config files
        '**/*.config.js',
      ],
      // ===== INCLUDE IN COVERAGE =====
      include: ['src/**/*.ts', 'src/**/*.tsx', 'convex/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
