import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { exportBlockWithSeam } from '../utils/convex-effect-seam'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const APP_ROOT = path.resolve(PROJECT_ROOT, '..')
const SERVER_ROOTS = [path.join(PROJECT_ROOT, 'app'), path.join(PROJECT_ROOT, 'lib')]
const ALLOWLIST = new Set([path.join(PROJECT_ROOT, 'lib', 'auth', 'session.ts')])
const FORBIDDEN_SELF_LOOKUP =
  /fetchQuery\s*\(\s*api\.users\.(getProfileByClerkId|getProfileById|getProfile|getUserByClerkId|getUserByEmail|getUser)\b/

// Con la costura de Convex (`convex/_helpers/effect.ts`) el registro es una
// línea y el cuerpo vive en el programa que nombra. Además, entre un export y
// el siguiente viven los programas de OTROS exports, que son `const` sin
// `export`: cortar «hasta el siguiente export» se los tragaba. `exportBlockWithSeam`
// corta en la siguiente declaración de nivel superior y después sigue el salto.
function extractExportBlock(content: string, exportName: string): string {
  const block = exportBlockWithSeam(content, exportName)
  expect(block, `no se encontró export const ${exportName}`).toBeDefined()
  return block as string
}

// Fuera del `it` para que `vitest/no-conditional-in-test` no cuente el `||`.
// Devuelve los nombres: el `expect` del candado reporta cuál query quedó sin guarda.
function activityLogQueriesMissingAuthGuard(
  content: string,
  exportNames: readonly string[]
): string[] {
  return exportNames.filter((exportName) => {
    const block = extractExportBlock(content, exportName)
    const guard = block.search(/require(?:Auth|AuthAdmin)\s*\(\s*ctx\s*\)/)
    const read = block.indexOf(".query('activityLogs')")
    return guard === -1 || guard > read
  })
}

function assertInternalMutationExport(content: string, exportName: string): void {
  const block = extractExportBlock(content, exportName)
  expect(block).toMatch(
    new RegExp(`export\\s+const\\s+${exportName}\\s*=\\s*internalMutation\\s*\\(`)
  )
}

function collectFiles(dir: string, results: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['__tests__', 'api', 'components'].includes(entry.name) || entry.name.startsWith('.')) {
        if (entry.name === '__tests__') continue
      }
      collectFiles(fullPath, results)
      continue
    }

    if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(fullPath)
    }
  }
  return results
}

const RETIRED_SELF_LOOKUP_NAMES = [
  'getProfileByClerkId',
  'getProfileById',
  'getProfile',
  'getUserByClerkId',
  'getUserByEmail',
  'getUser',
] as const

describe('server auth boundary', () => {
  it('documents the retired self-lookups and the live session reads', () => {
    const doc = fs.readFileSync(path.join(APP_ROOT, 'docs/AUTH_SERVER_BOUNDARY.md'), 'utf8')
    const disallowed = doc.slice(doc.indexOf('## Disallowed pattern'))

    for (const name of RETIRED_SELF_LOOKUP_NAMES) {
      expect(disallowed).toContain(name)
    }
    expect(disallowed).toContain('getCurrentUserState')
    expect(disallowed).toContain('getCurrentProfileId')
    expect(disallowed).not.toContain('clerkId')
    expect(disallowed).not.toContain('profileId')
  })

  it('avoids server-side self-lookups through public users queries', () => {
    const violations: string[] = []

    for (const root of SERVER_ROOTS) {
      for (const file of collectFiles(root)) {
        if (ALLOWLIST.has(file)) continue

        const content = fs.readFileSync(file, 'utf8')
        if (FORBIDDEN_SELF_LOOKUP.test(content)) {
          violations.push(path.relative(PROJECT_ROOT, file).replaceAll(path.sep, '/'))
        }
      }
    }

    expect(violations).toEqual([])
  })

  // El contrato cambió con `activityLogs.create` (borrada: cero llamadores).
  // Ya no hay una mutation pública que escriba la bitácora; cada log lo
  // inserta inline el módulo que genera el evento, dentro de la mutation que
  // YA autenticó al actor y le atribuye su propio `profile._id`. Lo que se
  // fija ahora es esa forma: `activityLogs` es superficie de LECTURA, y toda
  // función que exporta pasa por la guarda de auth antes de leer la tabla. Si
  // alguien vuelve a abrir una puerta de escritura pública aquí, este test cae.
  it('keeps activity logs a read-only Convex surface behind auth guards', () => {
    const activityLogsPath = path.join(APP_ROOT, 'convex', 'activityLogs.ts')
    const content = fs.readFileSync(activityLogsPath, 'utf8')

    expect(content).not.toMatch(/export\s+const\s+\w+\s*=\s*mutation\s*\(/)

    const exportedQueries = [...content.matchAll(/export\s+const\s+(\w+)\s*=\s*query\s*\(/g)].map(
      (match) => match[1]
    )
    expect(exportedQueries).toEqual(['getByUserId', 'getAll', 'getStats'])
    expect(activityLogQueriesMissingAuthGuard(content, exportedQueries)).toEqual([])

    // La actividad de un perfil es del perfil: la guarda de dueño va ANTES de
    // tocar la tabla, no después de leerla.
    const getByUserIdBlock = extractExportBlock(content, 'getByUserId')
    expect(getByUserIdBlock).toMatch(/requireOwnership\s*\(/)
    expect(getByUserIdBlock.indexOf('requireOwnership')).toBeLessThan(
      getByUserIdBlock.indexOf(".query('activityLogs')")
    )
  })

  it('keeps the legacy Clerk webhook sync module removed (F2)', () => {
    const clerkPath = path.join(APP_ROOT, 'convex', 'clerk.ts')
    expect(fs.existsSync(clerkPath)).toBe(false)
  })

  it('keeps the operator purge exemption bound to an internalMutation export', () => {
    const purgePath = path.join(APP_ROOT, 'convex', 'operatorPurge.ts')
    const content = fs.readFileSync(purgePath, 'utf8')

    assertInternalMutationExport(content, 'deleteDocumentsHard')

    const publicMutation = content.replace(
      'export const deleteDocumentsHard = internalMutation(',
      'export const deleteDocumentsHard = mutation('
    )
    expect(publicMutation).not.toBe(content)
    expect(() => assertInternalMutationExport(publicMutation, 'deleteDocumentsHard')).toThrow()
  })

  // La purga por EMPRESA borra ~45 tablas de una sala completa y desactiva a su
  // dueño. La de un perfil huérfano borra `users`+`profiles` y el rastro GDPR
  // (`purgeOrphanUser`, 2026-09-04). Expuesta como `mutation` cualquiera de las
  // tres sería un botón de borrado direccionable por cualquier sesión
  // autenticada, y `confirmName` no lo frenaría: el nombre de la empresa lo ve
  // su propio dueño en pantalla.
  it('keeps the company purge, the seed-user sweep and the orphan-user purge bound to internalMutation exports', () => {
    const purgePath = path.join(APP_ROOT, 'convex', 'operatorPurge.ts')
    const content = fs.readFileSync(purgePath, 'utf8')

    for (const exportName of ['purgeCompany', 'deactivateSeedUsers', 'purgeOrphanUser']) {
      assertInternalMutationExport(content, exportName)

      const publicMutation = content.replace(
        `export const ${exportName} = internalMutation(`,
        `export const ${exportName} = mutation(`
      )
      expect(publicMutation).not.toBe(content)
      expect(() => assertInternalMutationExport(publicMutation, exportName)).toThrow()
    }

    // El inventario de candidatos revela el correo del dueño de CADA empresa.
    expect(content).toMatch(/export\s+const\s+listSeedSweepCandidates\s*=\s*internalQuery\s*\(/)
  })

  // Restaurar un documento archivado devuelve acceso a bytes que alguien decidió
  // retirar, y renombrar una empresa reescribe la identidad de la sala entera.
  // Expuestas como `mutation` serían dos botones direccionables por cualquier
  // sesión autenticada, y sus confirmaciones no las frenarían: el nombre de la
  // empresa lo ve su propio dueño en pantalla.
  it('keeps the operator restore and the operator rename bound to internalMutation exports', () => {
    const restorePath = path.join(APP_ROOT, 'convex', 'operatorRestore.ts')
    const content = fs.readFileSync(restorePath, 'utf8')

    for (const exportName of ['restoreArchivedDocuments', 'setCompanyName']) {
      assertInternalMutationExport(content, exportName)

      const publicMutation = content.replace(
        `export const ${exportName} = internalMutation(`,
        `export const ${exportName} = mutation(`
      )
      expect(publicMutation).not.toBe(content)
      // El matcher no es adorno: un `toThrow()` pelado se pone verde con
      // cualquier excepción —un `readFileSync` que reventó, un typo en el
      // nombre— y el candado diría que la declaración sigue siendo
      // `internalMutation` cuando nadie la miró. Se ancla en el nombre del
      // export porque el mensaje de vitest trunca la expresión esperada.
      expect(() => assertInternalMutationExport(publicMutation, exportName)).toThrow(
        new RegExp(exportName)
      )
    }
  })

  // El reporte de poda hoy solo cuenta, pero recorre el fleet entero y es el
  // lugar donde vivirá la corrida que sí borra. Expuesto como `mutation` sería
  // un inventario de storage por empresa (y mañana un borrado) direccionable
  // por cualquier sesión autenticada.
  it('keeps the prune report bound to an internalMutation export', () => {
    const prunePath = path.join(APP_ROOT, 'convex', 'operatorPrune.ts')
    const content = fs.readFileSync(prunePath, 'utf8')

    assertInternalMutationExport(content, 'pruneDryRun')

    const publicMutation = content.replace(
      'export const pruneDryRun = internalMutation(',
      'export const pruneDryRun = mutation('
    )
    expect(publicMutation).not.toBe(content)
    expect(() => assertInternalMutationExport(publicMutation, 'pruneDryRun')).toThrow()
  })

  // Cargar la fila antes de decidir el rol convierte cada mutation en un
  // oráculo de existencia: una fila ausente responde NOT_FOUND y una presente
  // responde AUTHZ_UNAUTHORIZED, así que el mismo llamador no autorizado
  // distingue las dos. Colapsar ambas en el mismo 403 es lo que lo cierra.
  //
  // Este barrido cubre TODO `convex/`: un guard acotado a un directorio ya
  // arreglado certifica una frontera que no cubre.
  //
  // El MARCADOR no se ancla a ninguna entidad: el defecto nunca fue cómo se
  // llama la fila, es "un id que el llamador eligió decide si la fila habla
  // antes de que se decida el rol". Por eso busca cualquier
  // `notFound(<lo que sea>, …args.<algo>…)`.
  //
  // Se agrega además la forma NULL-vs-THROW, que el marcador anclado en `throw`
  // es estructuralmente incapaz de ver: `ctx.db.get(args.X)` → `return null`
  // cuando falta la fila, y `unauthorized(...)` cuando existe y no te toca. El
  // diferencial es idéntico (dos respuestas distinguibles para el mismo
  // llamador), sólo que una de las dos es un `null` en vez de un código.
  // `_documents/queries.ts:get` es exactamente eso.
  it('sweeps the whole Convex tree for the load-then-authorize existence oracle', () => {
    const convexRoot = path.join(APP_ROOT, 'convex')

    // Exenciones INDIVIDUALES y justificadas, nunca una allowlist en bloque: la
    // clave es `ruta:declaración` y la prueba falla también cuando una exención
    // queda obsoleta (ver la aserción de exenciones vivas al final).
    //
    // Dos clases de entrada conviven aquí a propósito:
    //   1. JUSTIFICADAS de verdad — el hallazgo no es un oráculo y se explica por qué.
    //   2. BACKLOG — sí es el defecto, pero cerrarlo cae fuera de esta rama. Su
    //      prosa dice "backlog: oráculo de existencia repo-wide, PR aparte", así
    //      que esta lista ES el inventario y el PR que arregle cada superficie
    //      tiene que borrar su clave para que la prueba siga verde.
    // Dos entradas salieron de esta lista el 2026-09-09 y ninguna describía un
    // defecto: `_documents/mutations.ts:create` y `users.ts:submitKYCForReview`.
    // Las dos autorizan antes de leer la fila, y en el commit base
    // `submitKYCForReview` ya lo hacía. Estaban acá porque ADMIN_GATES conocía
    // `profile.role === 'ADMIN'` y no `callerProfile.role === 'ADMIN'`, que es
    // el mismo chequeo con el nombre que el código usa. Un inventario con
    // entradas falsas manda a alguien a arreglar lo que no está roto.
    const JUSTIFIED_EXEMPTIONS = new Map<string, string>([
      // ---- BACKLOG: mismo defecto, otra entidad. Un PR aparte los cierra. ----
      [
        '_documents/queries.ts:get',
        'backlog: oráculo de existencia repo-wide, PR aparte. Forma null-vs-throw: `ctx.db.get(args.documentId)` → `return null`, y `assertDocumentAccess` lanza cuando la fila sí existe.',
      ],
      [
        '_documents/storage.ts:issueDocumentAccessGrant',
        'backlog: oráculo de existencia repo-wide, PR aparte. Forma null-vs-throw sobre `args.documentId`.',
      ],
      [
        '_documents/storage.ts:consumeDownloadGrant',
        'backlog: oráculo de existencia repo-wide, PR aparte. Forma null-vs-throw sobre `args.grantId`.',
      ],
      [
        'admin.ts:setCompanyName',
        "`internalMutation` de operacion, no superficie publica: Convex no la expone al cliente y el unico llamador es el equipo con `bunx convex run`, que para invocarla ya necesita el deploy key y con el ya lee la tabla entera. El diferencial de existencia no le revela nada que no pueda consultar directo, asi que `notFound('Empresa', args.companyId)` es diagnostico para el operador. Exencion de alcance, la misma clase que `_documents/mutations.ts:createFromValidatedUpload`.",
      ],
      [
        'admin.ts:setUserRole',
        "`internalMutation` de operacion, misma clase que `admin.ts:repairUserEmail`: fija el rol de un usuario desde la CLI del operador (2026-09-01: ningun perfil de prod era ADMIN y `makeAdmin` exige admin llamante). `notFound('Usuario'|'Perfil', args.userId)` es diagnostico para quien ya tiene el deploy key; no hay llamador anonimo.",
      ],
      [
        'admin.ts:repairUserEmail',
        "`internalMutation` de operacion, no superficie publica: mismo alcance que `admin.ts:setCompanyName`. Repara el email de una fila `users` y `notFound('Usuario', args.userId)` sirve al operador que ya tiene el deploy key; no hay llamador anonimo a quien filtrarle existencia.",
      ],
      [
        'operatorDeliverables.ts:listCompanyDocuments',
        "`internalQuery` del carril de entregables: Convex no la expone al cliente y sus únicos llamadores son `scripts/operator/vdr-pull.mjs` y `vdr-push.mjs`, que para invocarla ya necesitan el deploy key — y con él leen la tabla entera. El diferencial de existencia no le revela nada que no pueda consultar directo, así que `notFound('Company', args.companyId)` es diagnóstico para el operador. Exención de alcance, la misma clase que `admin.ts:setCompanyName`.",
      ],
      [
        'operatorDeliverables.ts:publishDeliverable',
        '`internalMutation` del carril de entregables: mismo alcance que `operatorDeliverables.ts:listCompanyDocuments`. Escribe el entregable devuelto a mano desde Mycroft en la sala de `args.companyId`; el 404 de empresa es integridad referencial para quien ya tiene el deploy key, no una compuerta de rol frente a un llamador anónimo.',
      ],
      [
        'financialSnapshots.ts:publish',
        '`internalMutation` del carril manual de entregables: el operador ya entra con deploy key y confirma el perfil ADMIN y el nombre exacto de la empresa antes de publicar. El 404 es diagnóstico de integridad para ese operador, no una respuesta disponible a un cliente.',
      ],
      [
        'operatorPurge.ts:deleteDocumentsHard',
        '`internalMutation` destructiva de operador, invocable solo con deploy key. El contrato dedicado de este archivo muta esa declaración a `mutation` y exige que la exención falle. La empresa y los ids explícitos son confirmaciones de integridad para quien ya puede leer el deployment completo; el 404 no expone existencia a un llamador público.',
      ],
      [
        'operatorRestore.ts:restoreArchivedDocuments',
        '`internalMutation` de operador, invocable solo con deploy key: misma clase que `operatorPurge.ts:deleteDocumentsHard`, y el contrato dedicado de este archivo también muta su declaración a `mutation` y exige que la exención falle. El 404 de empresa es integridad referencial para quien ya lee el deployment completo, no un oráculo frente a un llamador anónimo.',
      ],
      [
        'operatorRestore.ts:setCompanyName',
        "`internalMutation` de operador, misma clase que `admin.ts:setCompanyName`: Convex no la expone al cliente y su único llamador es el equipo con `convex run`, que ya necesita el deploy key. El `notFound('Empresa', args.companyId)` es diagnóstico para el operador; `confirmCurrentName` es un oráculo humano, no una compuerta de rol.",
      ],
      [
        'admin.ts:createMockCompany',
        "backlog: oráculo de existencia repo-wide, PR aparte. `notFound('Owner profile', args.ownerId)`; superficie de seed/demo, prioridad baja.",
      ],
      [
        'companies.ts:getCompany',
        'backlog: oráculo de existencia repo-wide, PR aparte. Forma null-vs-throw sobre `args.companyId`.',
      ],
      [
        'companies.ts:updateCompany',
        "backlog: oráculo de existencia repo-wide, PR aparte. `notFound('Empresa', args.companyId)` antes de `requireCompanyManagementAuthorization`.",
      ],
      [
        'companies.ts:updateManagementTeam',
        "backlog: oráculo de existencia repo-wide, PR aparte. `notFound('Empresa', args.companyId)` antes de la decisión de rol.",
      ],
      [
        'companies.ts:completeOnboardingStep',
        "backlog: oráculo de existencia repo-wide, PR aparte. `notFound('Empresa', args.companyId)` antes de la decisión de rol.",
      ],
      [
        'gdpr.ts:exportUserData',
        "backlog: oráculo de existencia repo-wide, PR aparte. `notFound('Profile', args.profileId)` antes de la decisión de rol.",
      ],
      [
        'gdpr.ts:requestAccountDeletion',
        "backlog: oráculo de existencia repo-wide, PR aparte. `notFound('Profile', args.profileId)` antes de la decisión de rol.",
      ],
      [
        'gdpr.ts:cancelDeletionRequest',
        "backlog: oráculo de existencia repo-wide, PR aparte. `notFound('Deletion request', args.requestId)` antes de la decisión de rol.",
      ],
      [
        'gdpr.ts:processAccountDeletion',
        "backlog: oráculo de existencia repo-wide, PR aparte. `notFound('Deletion request', args.requestId)` antes de la decisión de rol.",
      ],
    ])

    // Sólo `profile.role` decide. La versión anterior usaba
    // `/\w*[Rr]ole\s*[!=]==\s*'ADMIN'/`, que aceptaba como compuerta un valor
    // ENVIADO POR EL LLAMADOR: casaba `args.uploaderRole !== 'ADMIN'`
    // (_documents/mutations.ts) y `args.role === 'ADMIN'` (users.ts). Ninguno de
    // los dos es explotable hoy, pero el guard habría dado por buena cualquier
    // mutation PÚBLICA futura que "decidiera el rol" leyendo `args`. Un guard que
    // acepta `args.` como autoridad de rol es peor que no tenerlo.
    const ADMIN_GATES = [
      /requireAuthAdmin\s*\(/,
      /requireAdmin\s*\(/,
      /\bprofile\.role\s*[!=]==\s*'ADMIN'/,
      // Las mismas guardas escritas como programa Effect. Se listan por nombre
      // y no con un comodín: `callerProfile` es quien llama, mientras que
      // `ownerProfile` es el objetivo, y aceptar el rol del objetivo como
      // compuerta sería justo el error que este barrido existe para cazar.
      /requireAuthAdminEffect\s*\(/,
      /requireCompanyOwnerOrAdmin(?:Effect)?\s*\(/,
      /\bcallerProfile\.role\s*[!=]==\s*'ADMIN'/,
    ]
    const TARGET_OWNER_AUTHORIZATION_GATES = [
      // Estos helpers deciden la autoridad sobre el perfil objetivo sin leer
      // la fila. Sólo se consultan cuando el oráculo detectado también apunta a
      // `args.ownerId`, para que un gate sobre otra entidad no pueda ocultarlo.
      /requireOwnership\s*\(\s*profile\s*,\s*args\.ownerId\b/,
      /requireInvestorAccess\s*\(\s*profile\s*,\s*args\.ownerId\b/,
      /requireInvestorPrincipal\s*\(\s*profile\s*,\s*args\.ownerId\b/,
    ]
    const OWNERSHIP_CHECKS = [
      /requireDealOwnership\s*\(/,
      /hasDealOwnership\s*\(/,
      /requireOwnership\s*\(/,
      /hasOwnership\s*\(/,
      /requireInvestorAccess\s*\(/,
      /requireInvestorPrincipal\s*\(/,
      /\bownerId\s*[!=]==\s*profile\._id/,
    ]

    // Los comentarios se enmascaran con espacios (no se borran) para conservar
    // los índices. Sin esto el barrido se disparaba con el `@example throw
    // notFound('Deal', dealId)` del JSDoc de `_helpers/errors.ts` — un guard que
    // reporta su propia documentación entrena a ignorarlo.
    function maskCommentsAndStrings(source: string) {
      const out = source.split('')
      let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'

      for (let i = 0; i < source.length; i++) {
        const char = source[i]
        const next = source[i + 1]

        if (mode === 'code') {
          if (char === '/' && next === '/') mode = 'line'
          else if (char === '/' && next === '*') mode = 'block'
          else if (char === "'") mode = 'single'
          else if (char === '"') mode = 'double'
          else if (char === '`') mode = 'template'
          continue
        }

        if (mode === 'line') {
          if (char === '\n') mode = 'code'
          else out[i] = ' '
          continue
        }

        if (mode === 'block') {
          if (char === '*' && next === '/') {
            out[i] = ' '
            out[i + 1] = ' '
            i++
            mode = 'code'
          } else if (char !== '\n') {
            out[i] = ' '
          }
          continue
        }

        // Dentro de literales sólo interesa salir en el cierre correcto; el
        // contenido se conserva porque `notFound('Deal'` vive precisamente ahí.
        const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`'
        if (char === '\\') {
          i++
          continue
        }
        if (char === closer) mode = 'code'
      }

      // El `//` de una URL dentro de un string ya no abre comentario porque el
      // modo string se entra antes; el `'` de un comentario tampoco abre string.
      return out.join('')
    }

    function collectConvexModules(dir: string, results: string[] = []) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          // `_generated/` lo escribe Convex; no es superficie nuestra.
          if (entry.name === '_generated') continue
          collectConvexModules(fullPath, results)
          continue
        }
        if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          results.push(fullPath)
        }
      }
      return results
    }

    const violations: string[] = []
    const exercisedExemptions: string[] = []

    for (const filePath of collectConvexModules(convexRoot).sort()) {
      const fileName = path.relative(convexRoot, filePath).replaceAll(path.sep, '/')
      const content = maskCommentsAndStrings(fs.readFileSync(filePath, 'utf8'))
      // Corta en cada declaración de nivel superior: exports de Convex y también
      // los helpers de módulo (donde vivían los defectos de `_deals/admin.ts`,
      // `milestones.ts` y `dueDiligence.ts`).
      const declaration = /^(?:export\s+)?(?:async\s+)?(?:const|function)\s+([A-Za-z0-9_]+)/gm
      const starts: Array<{ name: string; index: number }> = []
      for (const match of content.matchAll(declaration)) {
        starts.push({ name: match[1], index: match.index ?? 0 })
      }

      // Con la costura de Convex el cuerpo de `foo` vive en `fooProgram`, un
      // `const` de nivel superior que este corte ve como su propia declaración.
      // El hallazgo se sigue detectando, pero bajo el nombre del programa, y las
      // exenciones de arriba están escritas con el nombre del export.
      //
      // Sin esta traducción cada conversión rompería la aserción de «exenciones
      // vivas» y la salida diría `fooProgram` donde el inventario dice `foo`.
      // La dirección importa: se traduce el programa al export, nunca al revés,
      // así que exentar un export no exenta un programa que nadie registró.
      const exportForProgram = new Map<string, string>()
      // `internalMutation` lleva mayúscula, así que `(?:internal)?mutation` no
      // lo veía y diez hallazgos salían con el nombre del programa en vez del
      // export, sin coincidir con ninguna exención del inventario.
      const registration =
        /export const ([A-Za-z0-9_]+) = (?:internalMutation|internalQuery|internalAction|mutation|query|action)\(\{[\s\S]*?runConvex\(([A-Za-z0-9_]+)\(/g
      for (const match of content.matchAll(registration)) {
        exportForProgram.set(match[2], match[1])
      }

      starts.forEach(({ name: declaredName, index }, position) => {
        const name = exportForProgram.get(declaredName) ?? declaredName
        const block = content.slice(index, starts[position + 1]?.index ?? content.length)

        // Tres marcadores del MISMO defecto:
        //   1. el helper crudo de `_deals/`;
        //   2. el `throw notFound(<entidad>, …args.X…)` escrito a mano — la
        //      entidad no importa, lo que importa es que el id lo eligió el
        //      llamador;
        //   3. la forma null-vs-throw: `ctx.db.get(args.X)` en un bloque que
        //      puede contestar `null`. La condición del `return null` es lo que
        //      separa un oráculo de un simple `get` — sin ella, cargar la fila y
        //      lanzar el MISMO 403 en ambas ramas contaría como hallazgo y el
        //      inventario se llenaría de ruido (`createDeal`, ya colapsado, entre
        //      otros). Se acepta que es una heurística de bloque, no de flujo.
        // Los marcadores 2 y 3 se escriben distinto según el canal, y el
        // barrido tiene que ver los dos o se apaga solo.
        //
        // Con la costura de Convex (`convex/_helpers/effect.ts`) un fallo de
        // negocio no se lanza, se pone en el canal de error tipado:
        // `throw notFound(...)` pasa a ser `Effect.fail(notFound(...))`. Y una
        // lectura no se espera con `await`, cruza la costura:
        // `await ctx.db.get(args.X)` pasa a ser
        // `convexPromise(() => ctx.db.get(args.X))`.
        //
        // Anclar en las palabras `throw` y `await` dejaba este guard CIEGO en
        // cada handler convertido, sin un solo test rojo que lo dijera. Eso es
        // peor que un falso positivo: un oráculo de existencia nuevo entraría
        // sin que nadie se entere.
        const rawLoadIndex = block.search(/\bloadDealOrThrow\s*\(/)
        //
        // Los dos marcadores se escriben de muchas formas y anclarlos a una sola
        // deja el guard ciego sin ponerse rojo. La primera versión pedía la
        // palabra `throw`; la costura escribe `Effect.fail(notFound(...))`. La
        // segunda pedía `await ctx.db.get(`; la costura escribe
        // `convexPromise(() => ctx.db.get(` y también
        // `convexPromise(async () => ctx.db.get(`, que es la forma que de verdad
        // quedó en `_documents/queries.ts` y que la versión anterior ya no veía.
        //
        // Por eso ahora no se ancla en el prefijo: se busca la lectura y el
        // fallo en sí. Un falso positivo lo revisa alguien; un falso negativo
        // deja pasar un oráculo nuevo.
        // Un id que eligió el llamador sigue siendo suyo aunque el código lo
        // ligue a un local primero. La conversión hizo justamente eso
        // (`const { dealId } = args` y después `notFound('Deal', dealId)`), y
        // el marcador anclado en `args.` dejó de ver dos oráculos ya
        // inventariados. Se recogen esas ligaduras y el nombre local cuenta
        // igual que `args.<campo>`.
        const argsAliases = new Map<string, string>()
        for (const [, alias, field] of block.matchAll(
          /const\s+([A-Za-z0-9_]+)\s*=\s*args\.([A-Za-z0-9_]+)/g
        )) {
          argsAliases.set(alias, field)
        }
        for (const [, fields] of block.matchAll(/const\s*\{([^}]*)\}\s*=\s*args\b/g)) {
          for (const part of fields.split(',')) {
            const [left, right] = part.split(':').map((piece) => piece.trim())
            if (left === '') continue
            argsAliases.set(right ?? left, left)
          }
        }

        // `args.campo` o cualquiera de esos alias.
        const callerId = [
          'args\\.([A-Za-z0-9_]+)',
          ...[...argsAliases.keys()].map((a) => `(${a})`),
        ].join('|')

        const notFoundMatch = block.match(
          new RegExp(`notFound\\(\\s*'[^']*'\\s*,\\s*[^)]*\\b(?:${callerId})`)
        )
        const notFoundIndex = notFoundMatch?.index ?? -1
        const rowLoadMatch = block.match(new RegExp(`ctx\\.db\\.get\\(\\s*(?:${callerId})\\s*\\)`))
        const rowLoadIndex = rowLoadMatch?.index ?? -1

        // El grupo que capturó puede ser `args.campo` o un alias; las dos se
        // resuelven al mismo nombre de campo.
        const capturedField = (match: RegExpMatchArray | null | undefined): string | undefined => {
          const hit = match?.slice(1).find((group) => group !== undefined)
          return hit === undefined ? undefined : (argsAliases.get(hit) ?? hit)
        }
        const nullReturnIndex =
          rowLoadIndex >= 0 && /\breturn null\b/.test(block.slice(rowLoadIndex)) ? rowLoadIndex : -1
        const oracleIndex = [rawLoadIndex, notFoundIndex, nullReturnIndex]
          .filter((found) => found >= 0)
          .sort((a, b) => a - b)[0]
        if (oracleIndex === undefined) return

        const key = `${fileName}:${name}`
        const targetsOwnerProfile =
          (oracleIndex === notFoundIndex && capturedField(notFoundMatch) === 'ownerId') ||
          (oracleIndex === nullReturnIndex && capturedField(rowLoadMatch) === 'ownerId')
        const authorizationPatterns = targetsOwnerProfile
          ? [...ADMIN_GATES, ...TARGET_OWNER_AUTHORIZATION_GATES]
          : ADMIN_GATES
        const authorizationIndex = authorizationPatterns
          .map((pattern) => block.search(pattern))
          .filter((found) => found >= 0)
          .sort((a, b) => a - b)[0]

        const record = (reason: string) => {
          if (JUSTIFIED_EXEMPTIONS.has(key)) {
            exercisedExemptions.push(key)
            return
          }
          violations.push(`${key} ${reason}`)
        }

        if (authorizationIndex === undefined || authorizationIndex > oracleIndex) {
          record('expone la existencia de la fila antes de decidir el rol')
          return
        }

        // El helper crudo no colapsa el 404, así que verificar propiedad después
        // de llamarlo reabre el oráculo aunque haya un gate de admin arriba.
        if (rawLoadIndex >= 0) {
          const afterLoad = block.slice(rawLoadIndex)
          if (OWNERSHIP_CHECKS.some((pattern) => pattern.test(afterLoad))) {
            record('verifica propiedad DESPUÉS de cargar el deal')
          }
        }
      })
    }

    expect(violations).toEqual([])

    // Una exención que ya no corresponde a un hallazgo real es una allowlist
    // dormida: la prueba la borra obligando a que cada clave siga viva.
    expect([...new Set(exercisedExemptions)].sort()).toEqual(
      [...JUSTIFIED_EXEMPTIONS.keys()].sort()
    )
  })
})
