import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// ============================================================================
// i18n HARDCODE GUARD (W6) — the mechanical done-criterion
// ============================================================================
// User-facing attribute strings (placeholder / aria-label / title) must not be
// hardcoded literals in source; they must flow through next-intl. This is the
// same recon pattern used to scope W6.
//
// Documented narrow allowlist (excluded from the sweep):
//   - src/components/ui       shadcn/ui primitives (upstream vendored code)
//   - src/__tests__           test fixtures intentionally use literal strings
//   - src/components/dev      dev-only tooling (DevToolbar, UserImpersonator);
//                             never rendered in production, English-only by design
//
// STATUS (2026-07-21): the full sweep landed — 44 files across onboarding,
// admin, agents, valuacion/analisis/nda, ai-finance/fusion/screener/news, and
// deals/profile/search/navbar migrated to next-intl (es/en). The guard is now
// ACTIVE and merge-blocking: new hardcoded attribute strings fail this test.
// ============================================================================

describe('i18n hardcode guard (W6)', () => {
  it('keeps user-facing attribute strings out of source literals', () => {
    const cmd =
      String.raw`grep -rln 'placeholder="[A-Z]\|aria-label="[A-Z]\|title="[A-Z]' src ` +
      `--include='*.tsx' | grep -v __tests__ | grep -v components/ui | grep -v components/dev ` +
      // dev-viewers es el banco dev-only (notFound() en produccion) — misma
      // razon que components/dev: nunca se renderiza a usuarios.
      `| grep -v 'dev-viewers' || true`
    const out = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8' }).trim()
    expect(out === '' ? [] : out.split('\n')).toEqual([])
  })
})
