import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const appRoot = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

describe('Sherlock compliance copy guardrails', () => {
  it('keeps user-facing messages away from transactional investment CTAs', () => {
    const copy = read('src/messages/es.json')

    expect(copy).not.toMatch(/\bInvest Now\b/i)
    expect(copy).not.toMatch(/\bFund This\b/i)
    expect(copy).not.toMatch(/\bBuy\b/i)
    expect(copy).not.toMatch(/\bComprar\b/i)
    expect(copy).not.toMatch(/success fees|closed capital|capital closes/i)
  })

  it('keeps retained company and help UI away from forbidden investment language', () => {
    const copy = [
      read('src/components/mycroft/MycroftLanding.tsx'),
      read('src/components/company/MyCompanyDocumentsClient.tsx'),
      read('src/components/company/data-room-activity/copy.ts'),
      read('src/components/admin/AdminDashboardClient.tsx'),
      read('src/app/[locale]/(public)/ayuda/page.tsx'),
      read('src/components/ayuda/HelpCenter.tsx'),
      read('src/components/ayuda/AyudaFeedback.tsx'),
    ].join('\n')

    expect(copy).not.toMatch(/\bInvest Now\b/i)
    expect(copy).not.toMatch(/\bFund This\b/i)
    expect(copy).not.toMatch(/\bBuy\b/i)
    expect(copy).not.toMatch(/\bComprar\b/i)
    // cspell:ignore FinLaw -- the regex below polices the dead brand; keep the literal here only
    expect(copy).not.toMatch(
      /crowdfunding|financiamiento colectivo|financiación colaborativa|guaranteed|stable returns|retorno estable|FinLaw|conversación directa|direct conversation|direct chat/i
    )
    expect(copy).not.toMatch(/success fees|closed capital|capital closes/i)
  })

  it('keeps public preparation copy away from transaction-fee shorthand', () => {
    const copy = [
      read('src/messages/es.json'),
      read('src/app/[locale]/(public)/terms/page.tsx'),
    ].join('\n')

    expect(copy).not.toMatch(/success fees|closed capital|capital closes/i)
    expect(copy).toMatch(/preparation work only|trabajo de preparación acordado/i)
    expect(copy).toMatch(
      /does not operate a public opportunity catalog|no opera un catálogo público de deals/i
    )
  })

  it('keeps Spanish product copy in Panamanian tuteo, never voseo', () => {
    // El voseo es la desviación que se cuela sola: verbos en -ás/-és y los
    // imperativos con tilde final. La barrida corre sobre los módulos de copy
    // que este trabajo agrega o toca.
    const copy = [read('src/components/company/data-room-activity/copy.ts')].join('\n')

    expect(copy).not.toMatch(/\btenés\b|\bpodés\b|\bquerés\b|\bentendés\b|\bsabés\b/i)
    expect(copy).not.toMatch(/\brevisá\b|\bmirá\b|\bescribí\b|\belegí\b|\btocá\b|\bsubí\b/i)
    expect(copy).not.toMatch(/\bvos\b|\bvosotros\b/i)
  })

  it('keeps the vetoed "deal desk" brand out of user-visible copy', () => {
    // "Deal desk" está vetado como término de posicionamiento (CLAUDE.md): el
    // equipo curador es "el equipo" / "the team". Los identificadores de código
    // (DealDeskIdentityGate, DEAL_DESK, claves i18n `dealDesk`) sobreviven solo
    // como labels internos — por eso el patrón exige el espacio: atrapa copy
    // ("deal desk", "Deal Desk") sin tropezar con identificadores camelCase.
    const vetoedCopy = /deal\s+desk/i

    // 1. Valores i18n (las CLAVES pueden llamarse dealDesk; los VALORES no
    //    pueden decir "deal desk").
    const walkValues = (node: unknown): string[] => {
      if (typeof node === 'string') return [node]
      if (node && typeof node === 'object') {
        return Object.values(node as Record<string, unknown>).flatMap(walkValues)
      }
      return []
    }
    const file = 'src/messages/es.json'
    const vetoedOffenders = walkValues(JSON.parse(read(file))).filter((value) =>
      vetoedCopy.test(value)
    )
    expect(vetoedOffenders, `${file} contiene copy con "deal desk"`).toEqual([])

    // 2. Copy literal de las superficies clave (admin es donde más se coló).
    const components = [
      'src/components/admin/AdminDashboardClient.tsx',
      'src/components/admin/AdminCompaniesClient.tsx',
      'src/components/company/MyCompanyDocumentsClient.tsx',
      'src/app/[locale]/(app)/admin/page.tsx',
      'src/app/[locale]/(app)/admin/workos/page.tsx',
    ]
    for (const file of components) {
      const source = read(file)
      // Solo strings literales: extraemos comillas simples/dobles/backticks y
      // toleramos comentarios de código (no son producto).
      const literals = source.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []
      const offenders = literals.filter((literal) => vetoedCopy.test(literal))
      expect(offenders, `${file} contiene strings con "deal desk"`).toEqual([])
    }
  })

  // `/dashboard` se borró ([F] 2026-09-07 09:00): la casa por rol vive ahora en
  // el helper de navegación, y la regla de copy lo sigue hasta ahí.
  it('keeps the role home pointing at the preparation room, not a desk', () => {
    const home = read('src/lib/navigation/home.ts')
    const literals = home.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []

    const offenders = literals.filter((literal) => /\bdesks?\b|\bdespachos?\b/i.test(literal))
    expect(offenders, 'la casa por rol contiene copy con "desk"/"despacho"').toEqual([])

    // Lo que la regla cuida es el destino, no la forma del control de flujo:
    // el helper resolvía con una cadena de `if`s y ahora con una tabla por rol.
    expect(home).toContain("'/my-company/documents'")
  })

  it('keeps anti-positioning explicit only in the product source of truth', () => {
    const architecture = read('src/lib/product/architecture.ts')

    expect(architecture).toMatch(/Not crowdfunding/i)
    expect(architecture).toMatch(/No promised returns/i)
  })

  it('keeps Enola positioned as separate governed capital, not automatic marketplace priority', () => {
    const architecture = read('src/lib/product/architecture.ts')
    const spanishMessages = read('src/messages/es.json')

    expect(architecture).toMatch(/Enola is the separately governed proprietary-capital/i)
    expect(architecture).toMatch(/no automatic investment/i)
    expect(spanishMessages).not.toMatch(/enola/i)
  })

  it('keeps the admin company queue wired to its admin-only query', () => {
    const adminCompanies = read('src/components/admin/AdminCompaniesClient.tsx')
    const companyQueries = read('convex/companies.ts')

    expect(adminCompanies).toMatch(/api\.companies\.listAdminCompanies/)
    expect(adminCompanies).not.toMatch(/api\.companies\.listPublicCompanies/)
    expect(companyQueries).toMatch(/export const listAdminCompanies[\s\S]*requireAdmin\(profile\)/)
  })

  // Orden de counsel 2026-08-14 (DECISIONS): "emisor"/"issuer" supone emisión de
  // valores. Sherlock prepara levantamientos privados — el texto visible dice
  // empresa/company. Las CLAVES i18n (issuerPipeline) y los identificadores de
  // código (ISSUER_OWNER, DENIED_ISSUER_INTERNAL) no son texto visible. Las
  // páginas legales quedan fuera: su redacción la firma [F] y todavía puede
  // necesitar el término definido.
  it('keeps user-visible product copy away from regulated issuer/emisor language', () => {
    const banned = /\bemisor(?:a|es|as)?\b|\bissuers?\b/i

    const walkValues = (node: unknown): string[] => {
      if (typeof node === 'string') return [node]
      if (node && typeof node === 'object') {
        return Object.values(node as Record<string, unknown>).flatMap(walkValues)
      }
      return []
    }

    const messagesFile = 'src/messages/es.json'
    const messageOffenders = walkValues(JSON.parse(read(messagesFile))).filter((value) =>
      banned.test(value)
    )
    expect(messageOffenders, `${messagesFile} contiene copy con emisor/issuer`).toEqual([])

    // read() lanza si un archivo desaparece: la lista falla en voz alta cuando
    // una superficie se renombra, en vez de quedarse verde vigilando la nada.
    const surfaces = [
      'src/app/[locale]/(public)/page.tsx',
      'src/components/mycroft/MycroftLanding.tsx',
      'src/components/company/MyCompanyDocumentsClient.tsx',
      'src/components/company/vdr/config.ts',
      'src/components/admin/AdminDashboardClient.tsx',
      'src/components/admin/AdminCompaniesClient.tsx',
      'src/components/admin/AuditLogsClient.tsx',
    ]
    for (const file of surfaces) {
      const source = read(file)
      const literals = source.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []
      const offenders = literals.filter((literal) => banned.test(literal))
      expect(offenders, `${file} contiene strings con emisor/issuer`).toEqual([])
    }
  })
})
