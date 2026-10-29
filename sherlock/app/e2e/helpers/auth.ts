/// <reference types="node" />
// ============================================================================
// E2E TEST HELPERS: AUTHENTICATION
// ============================================================================
// Utilidades reutilizables para manejar autenticación en tests E2E
// Estas funciones simulan login/logout para diferentes roles de usuario
// ============================================================================

import type { Page } from '@playwright/test'

// ===== TIPOS =====
export type UserRole = 'company' | 'admin' | 'guest'

// ===== DEMO MODE FLAG =====
// ES: Detecta si el bypass de auth está activo en tests.
// EN: Detects if auth bypass is active in tests.
export const IS_DEMO_AUTH =
  process.env.BYPASS_AUTH === 'true' ||
  process.env.NEXT_PUBLIC_BYPASS_AUTH === 'true' ||
  process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED === 'true'

/**
 * Login rápido usando Dev Login (demo mode)
 */
export async function loginAsDemoUser(page: Page, role: Exclude<UserRole, 'guest'>): Promise<void> {
  if (!IS_DEMO_AUTH) {
    throw new Error('Demo auth is disabled. Set BYPASS_AUTH=true for demo login.')
  }

  const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
  const roleConfig =
    role === 'admin'
      ? { id: 'dev_admin_001', role: 'ADMIN' as const }
      : { id: 'dev_company_001', role: 'COMPANY' as const }

  // Seed dev auth state directly to avoid flaky UI flows.
  await page.context().addCookies([
    {
      name: 'sherlock_dev_user',
      value: roleConfig.id,
      url: baseUrl,
      sameSite: 'Lax',
    },
    {
      name: 'sherlock_dev_role',
      value: roleConfig.role,
      url: baseUrl,
      sameSite: 'Lax',
    },
  ])

  await page.addInitScript(
    (payload) => {
      localStorage.setItem(
        'sherlock_dev_auth',
        JSON.stringify({ userId: payload.userId, currentRole: payload.currentRole })
      )
    },
    { userId: roleConfig.id, currentRole: roleConfig.role }
  )

  // Locale servido ([F] 2026-09-01, DECISIONS): `/en/*` responde 308 a `/es`,
  // así que el destino estable es siempre la ruta en español.
  const settledPath = role === 'company' ? '/es/my-company/documents' : '/es/admin'

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(settledPath, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForURL(
        (url) =>
          url.pathname === settledPath &&
          (role !== 'company' ||
            (url.searchParams.get('room') === 'company' &&
              url.searchParams.get('view') === 'documents' &&
              url.searchParams.get('category') === 'all')),
        { timeout: 10000 }
      )
      return
    } catch (error) {
      if (attempt === 2) {
        throw error
      }
      await page.waitForTimeout(1000)
    }
  }
}
