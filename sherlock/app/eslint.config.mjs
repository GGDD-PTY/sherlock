import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Allow underscore-prefixed variables to be unused (TypeScript convention)
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    // Local build artifacts (kept for reference, should not be linted):
    'BORRAR_.next/**',
    'BORRAR_.next2/**',
    'BORRAR_.next3/**',
    'BORRAR_.next_old/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Convex auto-generated files (should not be linted):
    'convex/_generated/**',
    // Playwright artifacts (report + traces)
    'playwright-report/**',
    'test-results/**',
    // Claude Code helper scripts (CommonJS, not app code)
    '.claude/**',
    // Assets generados de los visores del VDR: 51 MB del sidecar Mog y 6 MB de
    // pdfjs. Lintearlos agota la memoria de Node (SIGABRT) y no son fuente.
    'public/mog/**',
    'public/pdfjs/**',
    'mog-sidecar/dist/**',
    'mog-sidecar/node_modules/**',
  ]),
])

export default eslintConfig
