// ============================================================================
// CONVEX AUTH AUDIT TEST SUITE
// ============================================================================
// ES: Audita mecánicamente que cada mutation de Convex declare su guarda de
//     auth + su chequeo de ownership/rol. Antes este archivo documentaba los
//     guards en comentarios con `expect(true).toBe(true)`, así que reportaba
//     verde aunque alguien borrara `requireAuth(ctx)`. Ahora cada test lee la
//     fuente real y afirma sobre el bloque del export.
// EN: Every assertion reads the actual Convex source; the suite fails if a
//     named guard disappears from a mutation.
//
// Cierra además con un test de barrido que enumera TODAS las mutations
// públicas de convex/**/*.ts y exige una guarda reconocida, con una allowlist
// explícita y comentada. Eso mantiene el audit vivo sin lista manual.
// ============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

import {
  collectEffectPrograms,
  delegatedProgramNames,
  reachableSource,
} from '../utils/convex-effect-seam'

const CONVEX_ROOT = join(process.cwd(), 'convex')

type ExportKind = 'mutation' | 'internalMutation' | 'query'

function readConvexModule(relativePath: string): string {
  return readFileSync(join(CONVEX_ROOT, relativePath), 'utf8')
}

/**
 * Extrae el bloque completo de `export const <name> = <kind>({ ... })`.
 * El cierre es `\n})` a columna 0, que es el formato que impone Prettier.
 */
function extractExportBlock(
  relativePath: string,
  exportName: string,
  kind: ExportKind = 'mutation'
): string | undefined {
  const source = readConvexModule(relativePath)
  const pattern = new RegExp(`export const ${exportName} = ${kind}\\(\\{[\\s\\S]*?\\n\\}\\)`)
  return source.match(pattern)?.[0]
}

/**
 * Extrae una función exportada completa hasta la siguiente declaración de
 * función. Se usa para auditar los helpers centrales sin aceptar que los
 * tokens esperados sobrevivan como código muerto en otra parte del módulo.
 */
function extractExportedFunctionBlock(
  relativePath: string,
  exportName: string
): string | undefined {
  const source = readConvexModule(relativePath)
  const pattern = new RegExp(
    `export (?:async )?function ${exportName}\\([\\s\\S]*?(?=\\n(?:export )?(?:async )?function \\w+\\(|\\nexport const \\w+|$)`
  )
  const block = source.match(pattern)?.[0]
  if (block === undefined) return undefined

  // Con la costura de Convex una función exportada puede haber quedado como
  // envoltura de una línea (`return runConvex(fooEffect(ctx, ...))`) y su
  // cuerpo real vive en el programa. Lo que se audita es lo que corre.
  return reachableSource(block, collectEffectPrograms(source))
}

/**
 * Una guarda puede estar escrita de dos maneras que verifican lo mismo: la que
 * lanza el `AppError` y la que lo pone en el canal de error tipado de Effect
 * (`requireAuthEffect` es `requireAuth` en la segunda forma,
 * convex/_helpers/auth.identity.ts). Un array quiere decir "cualquiera de
 * estas escrituras sirve"; lo que se exige es que autentique, no por cuál
 * canal viaja el error.
 */
const AUTH = ['requireAuth(ctx)', 'requireAuthEffect(ctx)'] as const

/**
 * «Este perfil es ADMIN», en sus dos escrituras: la comparación suelta y el
 * predicado nombrado (`isAdminRole = Schema.is(Schema.Literals(['ADMIN']))`).
 *
 * Aceptar la segunda no afloja nada por sí sola, porque un predicado nombrado
 * podría estar definido contra el literal equivocado y esto no lo vería. Lo que
 * cierra ese hueco es el test «pins every named role predicate to its literal»,
 * más abajo: sin él, esta tolerancia sería una escalada de privilegios
 * esperando a pasar.
 */
const IS_ADMIN = ["profile.role === 'ADMIN'", 'isAdminRole(profile.role)'] as const
const IS_NOT_ADMIN = ["profile.role !== 'ADMIN'", '!isAdminRole(profile.role)'] as const
const AUTH_ADMIN = ['requireAuthAdmin(ctx)', 'requireAuthAdminEffect(ctx)'] as const

/**
 * Guardas reconocidas como "esta mutation autentica al caller".
 * `ctx.auth.getUserIdentity()` cubre las mutations que resuelven la identidad
 * a mano (users.ts) en vez de usar el helper.
 */
const RECOGNIZED_AUTH_GUARDS: string[] = [
  ...AUTH,
  ...AUTH_ADMIN,
  'ctx.auth.getUserIdentity()',
  'requireVdrGuestServerProof({',
  'consumeIntakeServerProof({',
  // VDR read MCP: HMAC-SHA256 con VDR_MCP_SERVER_SECRET, fail-closed
  // (convex/_vdrRead/serverProof.ts) — misma clase, secreto propio.
  'requireVdrReadServerProof({',
  // Indirección local de requireAuth + COMPANY owner o ADMIN (convex/vdrExport.ts).
  'loadExportCompany(ctx',
]

function hasRecognizedGuard(block: string): boolean {
  return RECOGNIZED_AUTH_GUARDS.some((guard) => block.includes(guard))
}

/**
 * Cuántos saltos de programa sigue el barrido antes de rendirse. Cuatro cubre
 * el registro, su programa, y dos niveles de programa que delega en otro.
 */
const MAX_PROGRAM_HOPS = 4

/**
 * ¿Autentica este bloque, contando los programas Effect a los que delega?
 *
 * Falla cerrado por diseño: un nombre que no se puede resolver cuenta como sin
 * guarda. Es preferible un falso rojo, que alguien investiga, a un falso verde,
 * que nadie mira.
 */
function hasGuardThroughSeam(
  block: string,
  programs: ReadonlyMap<string, string>,
  visited: ReadonlySet<string> = new Set()
): boolean {
  if (hasRecognizedGuard(block)) return true
  if (visited.size >= MAX_PROGRAM_HOPS) return false

  return delegatedProgramNames(block, programs).some((name) => {
    if (visited.has(name)) return false

    const body = programs.get(name)
    if (body === undefined) return false

    return hasGuardThroughSeam(body, programs, new Set([...visited, name]))
  })
}

type Guard = string | readonly string[]

/**
 * Dónde aparece una guarda, tomando la primera de sus escrituras que exista.
 * Devuelve -1 si no está ninguna. Sirve para los asertos de orden: primero se
 * autoriza, después se lee el objetivo, después se escribe.
 */
function guardIndexIn(source: string, guard: Guard): number {
  const spellings = typeof guard === 'string' ? [guard] : guard
  const hits = spellings.map((spelling) => source.indexOf(spelling)).filter((index) => index >= 0)

  return hits.length === 0 ? -1 : Math.min(...hits)
}

/**
 * Afirma que un trozo de código contiene una guarda, aceptando cualquiera de
 * sus escrituras válidas.
 */
function expectGuard(source: string | undefined, guard: Guard, label: string): void {
  const spellings = typeof guard === 'string' ? [guard] : guard
  const found = spellings.some((spelling) => source?.includes(spelling) === true)

  expect(found, `${label} debe contener ${spellings.map((s) => `"${s}"`).join(' o ')}`).toBe(true)
}

function expectGuards(
  relativePath: string,
  exportName: string,
  guards: readonly Guard[],
  kind: ExportKind = 'mutation'
): void {
  const block = extractExportBlock(relativePath, exportName, kind)
  expect(block, `${relativePath}::${exportName} (${kind}) no encontrado`).toBeDefined()

  const programs = collectEffectPrograms(readConvexModule(relativePath))
  const source = reachableSource(block as string, programs)

  for (const guard of guards) {
    expectGuard(source, guard, `${relativePath}::${exportName}`)
  }
}

// ============================================================================
// P0 CRITICAL
// ============================================================================

describe('AUDIT: P0 Critical Mutations - Auth Guards', () => {
  describe('companies.ts - Company Mutations (7 guards)', () => {
    it('createCompany requires auth and delegates owner/org verification to the central boundary', () => {
      expectGuards('companies.ts', 'createCompany', [
        AUTH,
        'resolveCompanyWorkosOrgBindingForCreation(ctx, auth, args.ownerId)',
      ])
    })

    it('ensureCompanyWorkspace gates first-login provisioning on identity and org binding', () => {
      // `requireAuth` acá se llama dentro de un manejo de error: el substring
      // solo prueba que se llama, no que se respete. Lo que hay que fijar es que
      // ese manejo atrape ÚNICAMENTE lo recuperable y propague el resto, y que
      // devolver una empresa existente pase por la misma evaluación de lectura
      // que la query.
      //
      // La propagación se escribe distinto según el canal. Con `try`/`catch` es
      // `throw error`; dentro de un programa Effect es `Effect.fail(error)`.
      // Las dos dicen lo mismo: lo no recuperable sube y no se provisiona nada.
      expectGuards('companies.ts', 'ensureCompanyWorkspace', [
        AUTH,
        'resolveCompanyWorkosOrgBindingForSelfProvisioning(',
        'ctx.auth.getUserIdentity()',
        'notAuthenticated()',
        'isBootstrapRecoverableAuthError(error)',
        ['throw error', 'Effect.fail(error)'],
        'evaluateCompanyManagementAuthorization(',
      ])
    })

    it('updateCompany requires auth and exact company management authorization', () => {
      expectGuards('companies.ts', 'updateCompany', [
        AUTH,
        'requireCompanyManagementAuthorization(',
      ])
    })

    it('updateManagementTeam requires auth and exact company management authorization', () => {
      expectGuards('companies.ts', 'updateManagementTeam', [
        AUTH,
        'requireCompanyManagementAuthorization(',
      ])
    })

    it('completeOnboardingStep requires auth and exact company management authorization', () => {
      expectGuards('companies.ts', 'completeOnboardingStep', [
        AUTH,
        'requireCompanyManagementAuthorization(',
      ])
    })
  })

  describe('users.ts - User Mutations (2 guards)', () => {
    it('deactivateOwnAccount requires auth and verifies profileId matches caller', () => {
      expectGuards('users.ts', 'deactivateOwnAccount', [
        AUTH,
        'profile._id !== args.profileId',
        'unauthorized(',
      ])
    })

    it('makeAdmin centrally rejects non-admin callers before target reads or writes', () => {
      const block = extractExportBlock('users.ts', 'makeAdmin')

      expect(block).toBeDefined()

      // Todo se mide sobre el código que de verdad corre: con la costura de
      // Convex los tres pasos viven en el programa, no en el registro.
      const programs = collectEffectPrograms(readConvexModule('users.ts'))
      const source = reachableSource(block as string, programs)

      expectGuard(source, AUTH_ADMIN, 'users.ts::makeAdmin')
      expect(source).not.toContain('ctx.auth.getUserIdentity()')

      const guardIndex = guardIndexIn(source, AUTH_ADMIN)
      const targetReadIndex = source.indexOf("q.eq('email', args.email)")
      const firstWriteIndex = source.indexOf("ctx.db.patch(profile._id, { role: 'ADMIN' })")

      expect(guardIndex).toBeGreaterThanOrEqual(0)
      expect(targetReadIndex).toBeGreaterThan(guardIndex)
      expect(firstWriteIndex).toBeGreaterThan(targetReadIndex)
    })

    it('users.ts exposes no self-service role mutation', () => {
      // `updateMyRole` era el bootstrap del selector de rol: duplicaba el alta de
      // primer login sin el gate de binding de organización y dejaba que un ADMIN
      // se auto-degradara. El alta vive sólo en `companies.ensureCompanyWorkspace`.
      const source = readConvexModule('users.ts')

      expect(source).not.toContain('updateMyRole')
    })
  })

  describe('_documents - Document Mutations (3 guards)', () => {
    it('create requires auth and verifies caller owns the company', () => {
      expectGuards('_documents/mutations.ts', 'create', [AUTH, 'requireCompanyOwnerOrAdmin('])
    })

    it("update requires auth and verifies caller owns the document's company", () => {
      expectGuards('_documents/mutations.ts', 'update', [AUTH, 'requireCompanyOwnerOrAdmin('])
    })

    it("remove requires auth and verifies caller owns the document's company", () => {
      expectGuards('_documents/mutations.ts', 'remove', [AUTH, 'requireCompanyOwnerOrAdmin('])
    })
  })
})

// ============================================================================
// P1 HIGH
// ============================================================================

describe('AUDIT: P1 High Priority Mutations - Auth Guards', () => {
  describe('analysis engine modules stay de-embedded (Tier B)', () => {
    it('convex/analyses.ts no longer exists', () => {
      // Los motores de análisis salieron del repo en el de-embed Tier B
      // (2026-07-24). Este test evita que se re-embeban sin auditoría.
      expect(() => readConvexModule('analyses.ts')).toThrow()
    })
  })
})

// ============================================================================
// P2 MEDIUM
// ============================================================================

describe('AUDIT: P2 Medium Priority Mutations - Auth Guards', () => {
  describe('guestAccess.ts - retained company room invitation mutations', () => {
    it('inviteToCompany requires auth and exact company management authorization', () => {
      expectGuards('guestAccess.ts', 'inviteToCompany', [AUTH, 'requireCompanyGuestManager('])
    })
  })
})

// ============================================================================
// AUTH HELPER PATTERNS
// ============================================================================

describe('AUTH: Standard Auth Guard Patterns', () => {
  describe('_helpers/auth.ts - Centralized Auth Functions', () => {
    it('auth.ts keeps the shared entrypoints while the specialized guard stays in its owner module', () => {
      const source = readConvexModule('_helpers/auth.ts')

      for (const name of [
        'requireAuth',
        'requireAdmin',
        'hasOwnership',
        'requireOwnership',
        'requireAuthAdmin',
      ]) {
        expect(source, `auth.ts debe re-exportar ${name}`).toContain(name)
      }

      // El guarda especializado vive en su módulo dueño; desde la adopción de
      // Effect ([F] 2026-09-08) su implementación es el programa
      // `requireAuthAdminEffect` y la función `requireAuthAdmin` es el borde
      // Promise que conservan los handlers todavía sin convertir.
      expect(readConvexModule('_helpers/auth.guards.ts')).toMatch(
        /\bconst\s+requireAuthAdminEffect\b/
      )
      expect(readConvexModule('_helpers/auth.guards.ts')).toMatch(
        /export\s+function\s+requireAuthAdmin\b/
      )
    })

    it('requireAuth() fails when there is no identity and no dev bypass', () => {
      const source = readConvexModule('_helpers/auth.identity.ts')

      // El programa lee la identidad y, sin ella, manda el fallo a la decisión
      // única del bypass.
      const program = source.match(/export const requireAuthEffect = [\s\S]*?\n\}\)/)?.[0]

      expect(program).toBeDefined()
      expect(program).toContain('ctx.auth.getUserIdentity()')
      expect(program).toContain('devAuthOr(ctx, notAuthenticated())')

      // Y esa decisión es la que sigue siendo fail-closed: sin deployment `dev`
      // declarado, el AppError sale por el canal de error.
      const bypass = source.match(/function devAuthOr\([\s\S]*?\n\}/)?.[0]

      expect(bypass).toBeDefined()
      expect(bypass).toContain('isDevAuthBypassed()')
      expect(bypass).toContain('Effect.fail(liveFailure)')
    })

    it('requireOwnership() allows only the owner or an ADMIN', () => {
      const block = readConvexModule('_helpers/auth.ownership.ts').match(
        /export function requireOwnership\([\s\S]*?\n\}/
      )?.[0]

      expect(block).toBeDefined()
      expectGuard(block, IS_ADMIN, '_helpers/auth.ownership.ts::requireOwnership')
      expect(block).toContain('profile._id === resourceOwnerId')
      expect(block).toContain('throw unauthorized(message)')
    })

    it('requireAuthAdmin() composes requireAuth + requireAdmin', () => {
      const block = readConvexModule('_helpers/auth.guards.ts').match(
        /\bconst requireAuthAdminEffect = [\s\S]*?\n\}\)/
      )?.[0]

      expect(block).toBeDefined()
      expect(block).toContain('yield* requireAuthEffect(ctx)')
      expect(block).toContain('requireAdmin(result.profile)')
    })

    it('pins every named role predicate to its literal', () => {
      // Este test es lo que hace segura la tolerancia de IS_ADMIN / IS_NOT_ADMIN.
      // Aceptar `isAdminRole(profile.role)` como chequeo de admin solo vale si
      // `isAdminRole` está definido contra 'ADMIN'. Un predicado nombrado contra
      // el literal equivocado es una escalada de privilegios que ningún otro
      // test de este archivo vería.
      const expected: Record<string, string> = {
        isAdminRole: "['ADMIN']",
        isCompanyRole: "['COMPANY']",
      }

      const declared: Array<{ where: string; name: string; literals: string }> = []

      for (const filePath of listConvexSourceFiles(CONVEX_ROOT)) {
        const source = readFileSync(filePath, 'utf8')
        const declaration = /const (is\w*Role) = Schema\.is\(Schema\.Literals\((\[[^\]]*\])\)\)/g
        let match: RegExpExecArray | null

        while ((match = declaration.exec(source)) !== null) {
          declared.push({
            where: filePath.slice(CONVEX_ROOT.length + 1),
            name: match[1],
            literals: match[2].replace(/\s+/g, ' ').trim(),
          })
        }
      }

      const wrong = declared.filter(({ name, literals }) => expected[name] !== literals)

      expect(
        wrong,
        `Predicados de rol contra el literal equivocado: ${wrong
          .map(({ where, name, literals }) => `${where}::${name} = ${literals}`)
          .join(', ')}`
      ).toEqual([])
    })

    it('requireAdmin() rejects non-ADMIN profiles', () => {
      const block = readConvexModule('_helpers/auth.roles.ts').match(
        /export function requireAdmin\([\s\S]*?\n\}/
      )?.[0]

      expect(block).toBeDefined()
      expectGuard(block, IS_NOT_ADMIN, '_helpers/auth.roles.ts::requireAdmin')
      expect(block).toContain('throw adminRequired()')
    })
  })

  describe('_helpers/companyAuthorization.ts - Exact Company Management Boundary', () => {
    it('evaluates the live provider, exact owner, WorkOS binding, and active membership', () => {
      const block = extractExportedFunctionBlock(
        '_helpers/companyAuthorization.ts',
        'evaluateCompanyManagementAuthorization'
      )

      expect(block).toBeDefined()
      expect(block).toContain("auth.profile.role === 'ADMIN'")
      expect(block).toContain('auth.profile._id !== company.ownerId')
      expect(block).toContain('auth.profile.isActive === false')
      expect(block).toContain('inspectCompanyWorkosOrgBinding(ctx, company)')
      expect(block).toContain("auth.identity.authProvider === 'clerk'")
      expect(block).toContain('isCurrentCompanyAuthorizationSession(auth)')
      expect(block).toContain("binding.status !== 'MISSING'")
      expect(block).toContain("binding.status === 'BOUND'")
      expect(block).toContain('loadUsableOwnerMemberships(')
      expect(block).toContain('binding.providerOrgId')
      expect(block).toContain("binding.status === 'INVALID'")
      expect(block).toContain('isCompanyOrganizationBindingEnforced(ctx)')
      expect(block).toContain(
        'loadCompanyOwnerMembershipEvidence(ctx, auth.user, auth.profile._id)'
      )
      expect(block).toContain('evidence.unambiguousProviderOrgId')
      expect(block).toContain('!evidence.hasMembershipHistory')
      expect(block).toContain("query('organizationMembershipTombstones')")
      expect(block).toContain('memberships.every(')
      expect(block).toContain('!tombstone')
    })

    it('fails closed when the central management decision is not authorized', () => {
      const block = extractExportedFunctionBlock(
        '_helpers/companyAuthorization.ts',
        'requireCompanyManagementAuthorization'
      )

      expect(block).toBeDefined()
      expect(block).toContain('evaluateCompanyManagementAuthorization(ctx, auth, company)')
      expect(block).toContain('if (!decision.authorized) throw denied(denialMessage)')
    })

    it('binds company creation to the requested owner and live organization authority', () => {
      const block = extractExportedFunctionBlock(
        '_helpers/companyAuthorization.ts',
        'resolveCompanyWorkosOrgBindingForCreation'
      )

      expect(block).toBeDefined()
      expect(block).toContain("ownerProfile.role !== 'COMPANY'")
      expect(block).toContain('ownerProfile.isActive === false')
      expect(block).toContain('auth.profile._id === ownerProfile._id')
      expect(block).toContain("auth.profile.role !== 'ADMIN'")
      expect(block).toContain('isCurrentCompanyAuthorizationSession(auth)')
      expect(block).toContain(
        'loadCompanyOwnerMembershipEvidence(ctx, ownerUser, ownerProfile._id)'
      )
      expect(block).toContain('evidence.unambiguousProviderOrgId')
      expect(block).toContain('usableMemberships.length === 1')
      expect(block).toContain('isCompanyOrganizationBindingEnforced(ctx)')
      expect(block).toContain("isSelf && auth.identity.authProvider === 'workos'")
    })

    it('keeps the company room guest manager behind the same central boundary', () => {
      const block = extractExportedFunctionBlock(
        '_guests/companyRoom.ts',
        'requireCompanyGuestManager'
      )

      expect(block).toBeDefined()
      expect(block).toContain('requireCompanyOwnerOrAdmin(')
      expect(block).toContain('ctx,')
      expect(block).toContain('actor,')
      expect(block).toContain('company,')
    })
  })
})

// ============================================================================
// SWEEP: every public mutation must declare a recognized guard
// ============================================================================

/**
 * Mutations públicas SIN guarda de identidad, justificadas una por una.
 * Añadir aquí exige una razón explícita — no es un cajón de sastre.
 */
const AUTH_GUARD_ALLOWLIST: Record<string, string> = {
  'devAuth.ts::bootstrapUsers':
    'Development-only identity bootstrap: isDevAuthBypassedViaEnv returns false before any database operation unless BYPASS_AUTH=true and CONVEX_ENV=dev; production-denial tests cover this path.',
  // Roadmap público: /roadmap no pide sesión, así que el votante no tiene
  // identidad que ofrecer. Lo acotan el registry cerrado de features, el tope
  // de 3 votos por dispositivo, los breakers de total y de cola, y la curaduría
  // manual. Ninguna de las dos lee ni escribe datos sensibles.
  'roadmap.ts::vote': 'isVotableKey + isValidDeviceToken + tope por dispositivo + breaker',
  'roadmap.ts::submitFeatureRequest':
    'isValidDeviceToken + cupo diario por dispositivo + breaker global + curaduría',
}

function listConvexSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '_generated' || entry === 'node_modules') continue

    const fullPath = join(dir, entry)

    if (statSync(fullPath).isDirectory()) {
      listConvexSourceFiles(fullPath, out)
    } else if (entry.endsWith('.ts')) {
      out.push(fullPath)
    }
  }

  return out.sort()
}

interface PublicMutation {
  id: string
  block: string
  programs: ReadonlyMap<string, string>
}

function collectPublicMutations(): PublicMutation[] {
  const found: PublicMutation[] = []

  for (const filePath of listConvexSourceFiles(CONVEX_ROOT)) {
    const relativePath = filePath.slice(CONVEX_ROOT.length + 1)
    const source = readFileSync(filePath, 'utf8')
    const programs = collectEffectPrograms(source)
    const declaration = /export const (\w+) = mutation\(\{/g
    let match: RegExpExecArray | null

    while ((match = declaration.exec(source)) !== null) {
      const rest = source.slice(match.index)
      const block = rest.match(/^export const \w+ = mutation\(\{[\s\S]*?\n\}\)/)?.[0] ?? rest

      found.push({ id: `${relativePath}::${match[1]}`, block, programs })
    }
  }

  return found
}

describe('SWEEP: every public Convex mutation declares an auth guard', () => {
  const publicMutations = collectPublicMutations()

  it('finds the public mutation surface', () => {
    // Sanity: si el barrido deja de encontrar mutations, el regex se rompió y
    // el test de abajo pasaría vacío.
    expect(publicMutations.length).toBeGreaterThan(50)
  })

  it('flags a synthetic unguarded mutation (detector self-test)', () => {
    // Sin esto el barrido podría pasar por construcción; aquí probamos que el
    // detector realmente distingue guardada de no guardada.
    const unguardedBlock = `export const evil = mutation({\n  args: {},\n  handler: async (ctx) => {\n    await ctx.db.insert('companies', {})\n  },\n})`
    const guardedBlock = `export const ok = mutation({\n  args: {},\n  handler: async (ctx) => {\n    const { profile } = await requireAuth(ctx)\n    return profile\n  },\n})`

    expect(hasRecognizedGuard(unguardedBlock)).toBe(false)
    expect(hasRecognizedGuard(guardedBlock)).toBe(true)
  })

  it('follows the Effect seam to the program that holds the guard', () => {
    // El mismo test que el de arriba, un nivel más abajo. Con la costura de
    // Convex el registro no contiene la guarda: la contiene el programa al que
    // delega. Sin esto, seguir el salto podría estar aceptando cualquier cosa.
    const source = [
      `const guardedProgram = Effect.fn('X.guarded')(function* (ctx: MutationCtx) {`,
      `  const { profile } = yield* requireAuthEffect(ctx)`,
      `  return profile`,
      `})`,
      ``,
      `const openProgram = Effect.fn('X.open')(function* (ctx: MutationCtx) {`,
      `  return yield* convexPromise(() => ctx.db.insert('companies', {}))`,
      `})`,
      ``,
      `const relayProgram = Effect.fn('X.relay')(function* (ctx: MutationCtx) {`,
      `  return yield* guardedProgram(ctx)`,
      `})`,
    ].join('\n')

    const programs = collectEffectPrograms(source)
    expect([...programs.keys()]).toEqual(['guardedProgram', 'openProgram', 'relayProgram'])

    const registration = (name: string) =>
      `export const x = mutation({\n  args: {},\n  handler: (ctx, args) => runConvex(${name}(ctx, args)),\n})`

    expect(hasGuardThroughSeam(registration('guardedProgram'), programs)).toBe(true)
    expect(hasGuardThroughSeam(registration('openProgram'), programs)).toBe(false)

    // Un programa que delega en otro guardado también cuenta.
    expect(hasGuardThroughSeam(registration('relayProgram'), programs)).toBe(true)

    // Falla cerrado: un nombre que no se resuelve NO cuenta como guarda.
    expect(hasGuardThroughSeam(registration('programaQueNoExiste'), programs)).toBe(false)
  })

  it('has no unguarded public mutation outside the documented allowlist', () => {
    const unguarded = publicMutations
      .filter(({ block, programs }) => !hasGuardThroughSeam(block, programs))
      .map(({ id }) => id)
      .filter((id) => !(id in AUTH_GUARD_ALLOWLIST))

    expect(unguarded, `Mutations públicas sin guarda de auth: ${unguarded.join(', ')}`).toEqual([])
  })

  it('keeps the allowlist tight (no stale entries)', () => {
    const ids = new Set(publicMutations.map(({ id }) => id))
    const stale = Object.keys(AUTH_GUARD_ALLOWLIST).filter((id) => !ids.has(id))

    expect(stale, `Entradas obsoletas en la allowlist: ${stale.join(', ')}`).toEqual([])
  })
})
