import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function read(relativePath: string) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8')
}

function exportSection(source: string, name: string, nextName?: string): string {
  const start = source.indexOf(`export const ${name}`)
  const end = nextName ? source.indexOf(`export const ${nextName}`, start) : source.length
  return source.slice(start, end)
}

const SUPPORT_RUNTIME_FILES = [
  'convex/_support/model.ts',
  'convex/support.ts',
  'src/components/company/SupportThread.tsx',
  'src/components/admin/AdminSupportInbox.tsx',
  'src/components/admin/AdminIntakeQueue.tsx',
  'src/app/[locale]/(app)/admin/support/page.tsx',
]

function importedModules(source: string): string[] {
  return Array.from(
    source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g),
    (match) => match[1]
  )
}

describe('fresh support architecture boundary', () => {
  it('does not import the archived marketplace messaging or connections domains', () => {
    for (const relativePath of SUPPORT_RUNTIME_FILES) {
      const imports = importedModules(read(relativePath))
      expect(imports, relativePath).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/(?:^|\/)messages?(?:$|\/)|_messages|(?:^|\/)connections?(?:$|\/)/),
        ])
      )
    }
  })

  it('models one exact room scope and deterministic, paginated text messages', () => {
    const schema = read('convex/schema.ts')
    const model = read('convex/_support/model.ts')
    const facade = read('convex/support.ts')

    expect(schema).toContain('supportThreads: defineTable({')
    expect(schema).toContain('scope: supportThreadScopeValidator')
    expect(schema).toContain('supportMessages: defineTable({')
    expect(schema).toContain(".index('by_scopeKey'")
    expect(schema).toContain(".index('by_thread_sequence'")
    expect(model).toContain("v.literal('COMPANY')")
    expect(model).toContain("v.literal('INTAKE')")
    expect(model).toContain('SUPPORT_MESSAGE_MAX_LENGTH')
    expect(facade).toContain('paginationOptsValidator')
    expect(facade).not.toMatch(/\.collect\(\)/)
    expect(facade).not.toMatch(/\.\.\.(?:thread|message|row)/)
  })

  it('keeps company and admin authorization on their central boundaries', () => {
    const facade = read('convex/support.ts')

    expect(facade).toContain('requireCompanyReadAuthorization')
    expect(facade).toContain("authorization.access !== 'MANAGE'")
    expect(facade.match(/requireAuthAdmin\(ctx\)/g)?.length).toBeGreaterThanOrEqual(5)
    expect(facade).toContain('logAdminAction')
    expect(facade).toContain("action: 'SUPPORT_MESSAGE_SEND'")
    expect(facade).toContain("action: 'SUPPORT_THREAD_READ'")
    expect(facade).toContain("targetType: 'SUPPORT_THREAD'")
    expect(facade).toContain('enforceRateLimit')
    expect(facade).not.toContain('sessionToken')
    expect(facade).not.toMatch(/throw new Error\(/)
  })

  it('validates the exact intake-session selector on every admin support operation', () => {
    const facade = read('convex/support.ts')
    const intakeSelector = "intakeSessionId: v.optional(v.id('intakeSessions'))"

    expect(exportSection(facade, 'getAdminThread', 'listAdminMessages')).toContain(intakeSelector)
    expect(exportSection(facade, 'listAdminMessages', 'sendAdminMessage')).toContain(intakeSelector)
    expect(exportSection(facade, 'sendAdminMessage', 'markAdminThreadRead')).toContain(
      intakeSelector
    )
  })

  it('keeps temporary support behind the intake server-proof and CSRF boundary', () => {
    const intake = read('convex/intake.ts')
    const proof = read('convex/_intake/proofFormat.ts')
    const route = read('src/app/api/intake/support/route.ts')
    const proxy = read('src/proxy.ts')
    const model = read('convex/_support/model.ts')

    expect(model).toContain('TEMPORARY_INTAKE_SUPPORT_AVAILABLE = true')
    expect(proof).toContain("'SUPPORT_READ'")
    expect(proof).toContain("'SUPPORT_SEND'")
    expect(intake).toContain("operation: 'SUPPORT_READ'")
    expect(intake).toContain("operation: 'SUPPORT_SEND'")
    expect(route).toContain('rejectIntakeMutation')
    expect(route).toContain('createIntakeServerProof')
    expect(proxy).toContain("'/api/intake/support'")
  })

  it('renders support text inertly and keeps the admin route server-authorized', () => {
    const companyThread = read('src/components/company/SupportThread.tsx')
    const adminInbox = read('src/components/admin/AdminSupportInbox.tsx')
    const page = read('src/app/[locale]/(app)/admin/support/page.tsx')

    expect(`${companyThread}\n${adminInbox}`).not.toMatch(
      /dangerouslySetInnerHTML|ReactMarkdown|DOMParser|innerHTML/
    )
    expect(companyThread).toContain('{message.body}')
    expect(adminInbox).toContain('{message.body}')
    expect(page).toContain("requireRole(['ADMIN']")
    expect(page).toContain("getTranslations({ locale, namespace: 'support' })")
  })

  it('ships the exact support nav entry against a populated Spanish namespace', () => {
    // O1-02: `AdminMobileNav.tsx` se borró. La barra del bloque `sidebar-07`
    // pinta la misma lista en escritorio y dentro del Sheet móvil, así que el
    // enlace se declara una sola vez. Desde el catálogo único del panel ([F]
    // 2026-09-17) ese sitio es `product/admin-routes.ts`: la barra ya no
    // inyecta la bandeja a mano dentro de «Principal».
    const catalog = read('src/lib/product/admin-routes.ts')
    const nav = read('src/components/admin/AdminSidebar.tsx')
    const es = JSON.parse(read('src/messages/es.json')) as Record<string, unknown>

    expect(catalog.match(/'\/admin\/support'/g)).toHaveLength(1)
    expect(catalog).toContain("nav: { label: 'Soporte'")
    expect(nav).not.toContain('/admin/support')
    // El sitio ships un solo catálogo, así que lo que se pinnea ya no es la
    // paridad es/en sino que las dos namespaces existen y traen su copy.
    expect(Object.keys(es.support as object).length).toBeGreaterThan(0)
    expect(Object.keys(es.adminIntakeQueue as object).length).toBeGreaterThan(0)
    expect(JSON.stringify(es.support)).not.toMatch(/marketplace|inversionista|deal desk/i)
    expect(JSON.stringify(es.adminIntakeQueue)).not.toMatch(/marketplace|inversionista|deal desk/i)
  })
})
