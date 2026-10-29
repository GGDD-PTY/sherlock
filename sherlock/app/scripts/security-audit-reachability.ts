import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Duration, Effect, Schema } from 'effect'
import ts from 'typescript'

import { decodeBoundary, externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

type Severity = 'high' | 'critical'
type Classification =
  'runtime_reachable' | 'build_pipeline_only' | 'non_reachable_attacker_path' | 'unknown'

// Enum de severidades que emite el advisory DB detrás de `bun audit`. Es la
// única fuente: el schema de avisos y el mensaje de fallo salen de acá.
const SEVERITY_VALUES = ['low', 'moderate', 'high', 'critical'] as const

/**
 * Forma que devuelve `bun audit --json`: un mapa de nombre de paquete a la
 * lista de avisos que aplican a alguna versión instalada de ese paquete.
 * NO es la forma de `npm audit` (que anida todo bajo `vulnerabilities` y
 * `metadata`); el gate corría sobre npm sin package-lock y eso salía
 * ENOLOCK, se parseaba como audit vacío y reportaba PASS para siempre.
 */
const BunAdvisorySchema = Schema.StructWithRest(
  Schema.Struct({
    // `id` llega como número en el DB de avisos, pero solo se usa como clave
    // de texto: no se le impone forma más allá de existir.
    id: Schema.optionalKey(Schema.Unknown),
    url: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    severity: Schema.Literals(SEVERITY_VALUES),
    // Sin rango no hay nada que comparar contra el rango revisado: requerido,
    // y no vacío.
    vulnerable_versions: Schema.String.pipe(Schema.check(Schema.isPattern(/\S/))),
  }),
  // El auditor agrega campos entre versiones; las claves de más no invalidan
  // un aviso que sí trae lo que el gate necesita.
  [Schema.Record(Schema.String, Schema.Unknown)]
)

const BunAuditPayloadSchema = Schema.Record(Schema.String, Schema.Array(BunAdvisorySchema))

type BunAdvisory = typeof BunAdvisorySchema.Type

/**
 * El `id` del aviso solo se usa como texto: clave de `advisories` y etiqueta
 * del rationale. Llega sin forma impuesta (`Schema.Unknown`), y una forma que
 * no sea primitiva no nombra ningún aviso — no produce clave.
 */
function advisoryIdText(id: unknown): string | undefined {
  if (typeof id === 'string') return id
  if (typeof id === 'number' || typeof id === 'bigint' || typeof id === 'boolean') {
    return String(id)
  }
  return undefined
}

type BunAuditPayload = typeof BunAuditPayloadSchema.Type

type ReachabilityRule = {
  classification: Classification
  rationale: string
  reviewBy: string
  owner: string
  /**
   * Avisos concretos que este triaje cubre: URL (o id) del aviso → rango
   * `vulnerable_versions` revisado. Una regla solo exime lo que lista, y solo
   * mientras el aviso siga describiendo el rango revisado: un GHSA se puede
   * enmendar para cubrir otra copia instalada sin cambiar URL ni id ni
   * lockfile, así que un rango distinto al pinneado vuelve a bloquear como
   * untriaged hasta re-triar con el contenido nuevo del aviso.
   */
  advisories?: Record<string, string>
  /**
   * Copias del paquete revisadas en el triaje: clave de `bun.lock` (ruta de
   * hoisting, p.ej. "webpack-bundle-analyzer/ws") → versión exacta. El
   * rationale justifica ESAS copias en ESE camino de dependencia; si el
   * lockfile gana una copia nueva o cambia la versión de una pinneada, la
   * excepción deja de aplicar y el paquete vuelve a bloquear.
   */
  lockEntries?: Record<string, string>
  /**
   * Aristas de dependencia revisadas — el CIERRE TRANSITIVO de las entrantes,
   * no solo las directas: quiénes declaran depender del paquete o de alguno
   * de sus consumidores, recorriendo el grafo hasta los workspaces
   * (workspaces como "workspace:<ruta>" y paquetes por su clave de bun.lock),
   * con la sección que declara la arista ("<consumidor>#<sección>"). Un
   * consumidor nuevo que reutiliza una copia ya hoisted no cambia clave ni
   * versión; mover la MISMA arista de devDependencies a dependencies deja el
   * consumidor igual pero la declara runtime; y una arista nueva hacia un
   * intermediario (`runtime-framework -> glob -> minimatch`) ni siquiera toca
   * las aristas directas del paquete. Las tres cambian la reachability: la
   * excepción deja de aplicar hasta re-triar.
   */
  consumers?: string[]
  /**
   * Imports de runtime revisados: nombre de paquete — el propio paquete o un
   * ancestro de su cierre de consumidores — → los hits COMPLETOS observados
   * en el triaje, como "archivo -> specifier [bindings]" (p.ej.
   * "src/proxy.ts -> next-intl/middleware [default]"). Un import de runtime
   * nuevo de un ancestro revisado no cambia el lockfile ni el cierre pinneado
   * (`@parcel/watcher` ya es consumidor revisado de picomatch), pero vuelve
   * runtime un camino que el rationale declaró build-only. Y no basta
   * pinnear el nombre: un subpath nuevo del mismo ancestro
   * (`next-intl/otra-cosa`), un sitio de import nuevo o un BINDING nuevo del
   * mismo sitio también pueden exponer el camino vulnerable — un archivo ya
   * aprobado que importaba `captureException` de `@sentry/nextjs` y empieza
   * a importar el build-only `withSentryConfig` cambia la reachability sin
   * tocar archivo ni specifier. Los bindings pinnean los nombres EXPORTADOS
   * importados en el triaje; `*` significa acceso al módulo completo
   * (namespace import, `require`, import dinámico, o cualquier hit sin
   * evidencia estática de qué expone). Cualquier hit no listado bloquea
   * hasta re-triar.
   */
  runtimeImports?: Record<string, string[]>
}

type PolicyFile = {
  generatedOn: string
  rules: Record<string, ReachabilityRule>
}

const HIGH_OR_CRITICAL: Severity[] = ['high', 'critical']
// Enum de severidades que emite el advisory DB detrás de `bun audit`.
// Cualquier otro valor (p.ej. "HIGH", o un valor nuevo del tool) no es
// interpretable: filtrarlo en silencio sería otro camino false-green.
const KNOWN_SEVERITIES = new Set<string>(SEVERITY_VALUES)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * El gate no puede pasar por un camino que no entendió. Cualquier salida del
 * auditor que no sea un reporte interpretable termina aquí, y aquí se sale con
 * código distinto de cero — nunca con un veredicto.
 */
class AuditUnavailableError extends Error {}

// El gate puede fallar por dos razones distintas: el auditor no dio un
// reporte (se reporta y se sale con 1) o el gate mismo se rompió (sube tal
// cual). `unavailable` guarda esa distinción sin perder la causa.
class AuditGateError extends Schema.TaggedError<AuditGateError>()('AuditGateError', {
  message: Schema.String,
  unavailable: Schema.Boolean,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function unavailable(message: string): AuditGateError {
  return new AuditGateError({ message, unavailable: true })
}

function gateError(cause: unknown): AuditGateError {
  return new AuditGateError({
    message: cause instanceof Error ? cause.message : String(cause),
    unavailable: cause instanceof AuditUnavailableError,
    cause,
  })
}

// `bun audit` consulta el advisory DB por red sobre el árbol entero: minutos
// en el peor caso. Reintentar no cambia el veredicto y triplicaría el reloj.
const AUDIT_TIMEOUT = Duration.minutes(5)
const AUDIT_MAX_BUFFER = 20 * 1024 * 1024

type AuditProcess = { stdout: string; stderr: string; status: number | null; message: string }

/** Corre el auditor sin opinar del exit code: eso lo decide `runBunAudit`. */
function spawnBunAudit(signal: AbortSignal): Promise<AuditProcess> {
  return new Promise((resolvePromise) => {
    execFile(
      'bun',
      ['audit', '--json'],
      { encoding: 'utf8', maxBuffer: AUDIT_MAX_BUFFER, signal },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout, stderr, status: 0, message: '' })
          return
        }
        const code = (error as { code?: unknown }).code
        resolvePromise({
          stdout,
          stderr,
          status: typeof code === 'number' ? code : null,
          message: error.message,
        })
      }
    )
  })
}

const runBunAudit = Effect.fn('securityAudit.runBunAudit')(function* (): Effect.fn.Return<
  string,
  AuditGateError
> {
  const result = yield* externalCall({
    service: 'bun audit',
    operation: 'audit --json',
    run: spawnBunAudit,
    timeout: AUDIT_TIMEOUT,
    retries: 0,
  }).pipe(Effect.mapError((error) => unavailable(error.message)))

  if (result.status === 0) return result.stdout

  // `bun audit` sale con 1 cuando ENCUENTRA avisos: ese es el ÚNICO exit
  // distinto de cero cuyo stdout es un reporte. Cualquier otro status es un
  // fallo del tool (auditor caído, crash interno) y su stdout — aunque
  // parsee, p.ej. `{}` — no afirma nada sobre el árbol. Confiar en él sería
  // interpretar un audit indisponible como reporte limpio.
  const stderr = result.stderr.trim()
  if (result.stdout.trim().length > 0) {
    if (result.status === 1) return result.stdout
    return yield* Effect.fail(
      unavailable(
        `\`bun audit --json\` exited with unexpected status ${String(result.status)}; ` +
          `not trusting its output as a report. stderr: ${stderr || '(empty)'}`
      )
    )
  }

  return yield* Effect.fail(
    unavailable(
      `\`bun audit --json\` produced no report (${result.message}). stderr: ${stderr || '(empty)'}`
    )
  )
})

/**
 * Explica por qué el payload no es un reporte interpretable, en el mismo orden
 * en que el gate lo revisaba a mano: es el mensaje que lee quien lo arregla.
 */
function explainAuditPayload(parsed: unknown, detail: string): string {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '`bun audit --json` returned JSON that is not an object.'
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      // Esta es exactamente la forma del fallo del auditor: `{"error": {...}}`.
      // Tratarla como "cero vulnerabilidades" es el bug que este gate tuvo.
      return (
        `\`bun audit --json\` returned an error report instead of advisories ` +
        `(key "${key}"): ${JSON.stringify(value).slice(0, 300)}`
      )
    }
    for (const entry of value) {
      // Un elemento sin forma de advisory (sin `severity` string) no es un
      // reporte interpretable: aceptarlo dejaría pasar severidades que
      // `selectFindings` nunca vería. Mismo contrato fail-closed que arriba.
      if (
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof (entry as { severity?: unknown }).severity !== 'string'
      ) {
        return (
          `\`bun audit --json\` returned an advisory without a valid shape ` +
          `(key "${key}"): ${JSON.stringify(entry).slice(0, 300)}`
        )
      }
      const severity = (entry as { severity: string }).severity
      if (!KNOWN_SEVERITIES.has(severity)) {
        // `selectFindings` filtra por high/critical; una severidad desconocida
        // se descartaría en silencio. Fail closed: no es un reporte entendible.
        return (
          `\`bun audit --json\` returned an unrecognized severity "${severity}" ` +
          `(key "${key}"). Known severities: ${[...KNOWN_SEVERITIES].join(', ')}.`
        )
      }
      // Sin `vulnerable_versions` no hay rango que comparar contra el rango
      // revisado de la política: la cobertura degradaría a '' y una regla con
      // rango vacío eximiría el aviso para siempre. Fail closed: un aviso sin
      // rango no es un reporte interpretable.
      const range = (entry as { vulnerable_versions?: unknown }).vulnerable_versions
      if (typeof range !== 'string' || range.trim().length === 0) {
        return (
          `\`bun audit --json\` returned an advisory without a vulnerable_versions ` +
          `range (key "${key}"): ${JSON.stringify(entry).slice(0, 300)}`
        )
      }
    }
  }

  return `\`bun audit --json\` returned a report this gate cannot interpret: ${detail}`
}

export function parseAuditPayload(raw: string): BunAuditPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AuditUnavailableError(
      `\`bun audit --json\` did not return JSON. First 200 chars: ${raw.slice(0, 200)}`
    )
  }

  // La forma del reporte la decide el schema, no una torre de type guards; lo
  // que el schema rechaza se explica con el mensaje que corresponde.
  const decoded = Effect.runSync(
    decodeBoundary('bunAuditPayload', BunAuditPayloadSchema, parsed).pipe(
      Effect.match({
        onSuccess: (payload: BunAuditPayload) => ({ ok: true as const, payload }),
        onFailure: (error) => ({ ok: false as const, detail: error.message }),
      })
    )
  )
  if (decoded.ok) return decoded.payload

  throw new AuditUnavailableError(explainAuditPayload(parsed, decoded.detail))
}

/**
 * Vista del bun.lock que el gate verifica:
 * - `packages`: nombre de paquete → { clave de bun.lock → versión exacta }.
 *   La clave es la ruta de hoisting ("ws", "webpack-bundle-analyzer/ws"), así
 *   que identifica QUÉ copia existe y por dónde cuelga en el árbol.
 * - `consumers`: nombre de paquete → quiénes declaran una arista de dependencia
 *   hacia él (workspaces y paquetes), con la sección de la declaración
 *   ("<consumidor>#<sección>"). Una arista nueva hacia una copia ya hoisted no
 *   cambia clave ni versión, pero sí cambia quién lo consume; y una arista que
 *   se mueve de devDependencies a dependencies cambia su clase de reachability
 *   sin cambiar el consumidor.
 */
export type ParsedLockfile = {
  packages: Record<string, Record<string, string>>
  consumers: Record<string, string[]>
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

export function parseLockfile(raw: string): ParsedLockfile {
  let parsed: unknown
  try {
    // bun.lock es JSONC con comas finales; normalizarlas antes de parsear.
    parsed = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    throw new AuditUnavailableError('bun.lock could not be parsed as JSONC.')
  }
  const packages = (parsed as { packages?: unknown })?.packages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new AuditUnavailableError('bun.lock has no interpretable "packages" map.')
  }

  const consumerSets: Record<string, Set<string>> = {}
  const addEdges = (consumerId: string, meta: unknown) => {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return
    for (const section of DEPENDENCY_SECTIONS) {
      const deps = (meta as Record<string, unknown>)[section]
      if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue
      for (const depName of Object.keys(deps as Record<string, unknown>)) {
        // La sección es parte de la identidad de la arista: mover el paquete
        // de devDependencies a dependencies deja el mismo consumidor pero
        // convierte la arista en runtime — eso exige re-triaje.
        ;(consumerSets[depName] ??= new Set()).add(`${consumerId}#${section}`)
      }
    }
  }

  const workspaces = (parsed as { workspaces?: unknown })?.workspaces
  if (workspaces !== null && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
    for (const [key, meta] of Object.entries(workspaces as Record<string, unknown>)) {
      addEdges(`workspace:${key || 'root'}`, meta)
    }
  }

  const result: ParsedLockfile = { packages: {}, consumers: {} }
  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue
    // El primer elemento es "name@version" (el name real aunque la clave sea
    // una ruta anidada o un alias). El último @ separa versión de nombre.
    const spec = value[0]
    const at = spec.lastIndexOf('@')
    if (at <= 0) continue
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    ;(result.packages[name] ??= {})[key] = version
    addEdges(key, value[2])
  }

  for (const [name, set] of Object.entries(consumerSets)) {
    result.consumers[name] = [...set].sort()
  }
  return result
}

/**
 * Cierre transitivo de las aristas entrantes de un paquete: no basta pinnear
 * los consumidores directos. `runtime-framework -> glob -> minimatch` no toca
 * ninguna arista directa de minimatch (la arista nueva queda registrada bajo
 * glob), pero SÍ crea un camino runtime nuevo hacia minimatch. Se recorre el
 * grafo hacia arriba hasta los workspaces, con protección contra ciclos, y la
 * excepción pinnea el cierre completo: cualquier arista ancestro nueva o
 * movida de sección exige re-triaje.
 */
export function transitiveConsumers(lockfile: ParsedLockfile, packageName: string): string[] {
  const keyToName: Record<string, string> = {}
  for (const [name, copies] of Object.entries(lockfile.packages)) {
    for (const key of Object.keys(copies)) keyToName[key] = name
  }

  const edges = new Set<string>()
  const visited = new Set<string>([packageName])
  const queue = [packageName]
  while (queue.length > 0) {
    const current = queue.pop() as string
    for (const edge of lockfile.consumers[current] ?? []) {
      if (edges.has(edge)) continue
      edges.add(edge)
      const consumerId = edge.slice(0, edge.lastIndexOf('#'))
      if (consumerId.startsWith('workspace:')) continue
      const consumerName = keyToName[consumerId]
      if (consumerName !== undefined && !visited.has(consumerName)) {
        visited.add(consumerName)
        queue.push(consumerName)
      }
    }
  }
  return [...edges].sort()
}

/**
 * Nombres de paquete que el escaneo de imports de runtime debe vigilar para
 * un paquete de la política: él mismo más todos los ancestros de su cierre de
 * consumidores. Importar un intermediario ya revisado (`@parcel/watcher`, que
 * llega a picomatch) no cambia bun.lock ni el cierre pinneado, pero vuelve
 * runtime el camino completo hacia el paquete vulnerable.
 */
export function watchedImportNames(lockfile: ParsedLockfile, packageName: string): string[] {
  const keyToName: Record<string, string> = {}
  for (const [name, copies] of Object.entries(lockfile.packages)) {
    for (const key of Object.keys(copies)) keyToName[key] = name
  }
  const names = new Set<string>([packageName])
  for (const edge of transitiveConsumers(lockfile, packageName)) {
    const consumerId = edge.slice(0, edge.lastIndexOf('#'))
    if (consumerId.startsWith('workspace:')) continue
    const consumerName = keyToName[consumerId]
    if (consumerName !== undefined) names.add(consumerName)
  }
  return [...names].sort()
}

export function isRuleExpired(rule: ReachabilityRule, today: string): boolean {
  // Una regla sin fecha válida no es triaje, es una excepción abierta.
  if (!ISO_DATE.test(rule.reviewBy)) return true
  // La forma ISO no basta: "2026-99-99" pasa el regex y compara lexicográficamente
  // como futuro. Round-trip por Date para exigir una fecha de calendario real.
  const parsed = new Date(`${rule.reviewBy}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== rule.reviewBy) {
    return true
  }
  // Comparación lexicográfica: válida para ISO YYYY-MM-DD.
  return rule.reviewBy < today
}

// Forma de un hit revisado de runtime import: sitio, specifier y bindings
// pinneados. Los bindings van al final entre corchetes (`*` = módulo
// completo; vacío = side-effect import sin API expuesta).
const RUNTIME_IMPORT_HIT_SHAPE = /^.+ -> .+ \[[^\][]*\]$/

const CLASSIFICATION_VALUES = new Set<string>([
  'runtime_reachable',
  'build_pipeline_only',
  'non_reachable_attacker_path',
  'unknown',
])

export function validatePolicy(policy: PolicyFile): void {
  const rules = (policy as { rules?: unknown })?.rules
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
    throw new AuditUnavailableError('Policy has no interpretable "rules" map.')
  }
  for (const [name, rule] of Object.entries(rules as Record<string, unknown>)) {
    const classification = (rule as { classification?: unknown })?.classification
    // Una clasificación mal tipeada ("runtime-reachabl") no debe caer en el
    // camino permisivo del else: política malformada no emite veredicto.
    if (typeof classification !== 'string' || !CLASSIFICATION_VALUES.has(classification)) {
      throw new AuditUnavailableError(
        `Policy rule for "${name}" has an unrecognized classification ` +
          `${JSON.stringify(classification)}. Known classifications: ` +
          `${[...CLASSIFICATION_VALUES].join(', ')}.`
      )
    }
    // `runtimeImports` es un mapa nombre de paquete → hits revisados
    // ("archivo -> specifier [bindings]"). La forma legacy (lista de
    // nombres) colapsaba subpath y sitio, y la intermedia sin bindings
    // colapsaba QUÉ API del specifier usa el archivo: un sitio aprobado
    // podía empezar a importar un binding build-only nuevo sin drift.
    // Ninguna pinnea algo verificable, así que ambas son malformadas.
    const runtimeImports = (rule as { runtimeImports?: unknown })?.runtimeImports
    if (runtimeImports !== undefined) {
      const isMap =
        runtimeImports !== null &&
        typeof runtimeImports === 'object' &&
        !Array.isArray(runtimeImports) &&
        Object.values(runtimeImports).every(
          (entries) =>
            Array.isArray(entries) &&
            entries.every(
              (entry) => typeof entry === 'string' && RUNTIME_IMPORT_HIT_SHAPE.test(entry)
            )
        )
      if (!isMap) {
        throw new AuditUnavailableError(
          `Policy rule for "${name}" has malformed "runtimeImports": expected a map ` +
            `of package name to the reviewed "file -> specifier [imported bindings]" hits.`
        )
      }
    }
    // `advisories` es un mapa aviso → rango revisado. La forma legacy (array
    // de URLs) no pinnea rango: tratarla como "nada cubierto" en silencio
    // bloquearía sin explicar; política malformada no emite veredicto.
    const advisories = (rule as { advisories?: unknown })?.advisories
    if (advisories !== undefined) {
      // Un rango vacío no pinnea nada: igualaría a un aviso sin rango y la
      // "cobertura" sería vacua. Solo un rango revisado no vacío exime.
      const isMap =
        advisories !== null &&
        typeof advisories === 'object' &&
        !Array.isArray(advisories) &&
        Object.values(advisories).every(
          (range) => typeof range === 'string' && range.trim().length > 0
        )
      if (!isMap) {
        throw new AuditUnavailableError(
          `Policy rule for "${name}" has malformed "advisories": expected a map of ` +
            `advisory URL/id to the reviewed non-empty vulnerable_versions range.`
        )
      }
    }
  }
}

// La política vive en el repo y `validatePolicy` es su contrato: acá solo se
// parsea el texto que ya leyó el borde.
function loadPolicy(raw: string): PolicyFile {
  return JSON.parse(raw) as PolicyFile
}

// `src` y `convex` son los roots actuales, pero Next también acepta las
// convenciones de RAÍZ: si aparece un `app/` (App Router) o `pages/` (Pages
// Router) en la raíz de la app, Next lo usa como router activo e IGNORA
// `src/app`/`src/pages` (convención documentada en next/dist/docs
// .../project-structure y src-folder) — un import ahí es tan runtime como
// uno en src/, así que el gate debe escanearlos cuando existen en vez de
// quedarse en verde.
const RUNTIME_SOURCE_DIRS = ['src', 'convex', 'app', 'pages']
const RUNTIME_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
])
const RUNTIME_SCAN_SKIP_SEGMENTS = new Set(['node_modules', '_generated', '__tests__', '.next'])
// Un archivo de DECLARACIONES (`global.d.ts`, `.d.mts`, `.d.cts`) nunca se
// emite ni se ejecuta: su `import 'minimatch'` es augmentación de módulo que
// el compilador borra por completo, no reachability de runtime — `extname`
// lo clasifica como `.ts` y escanearlo rompería el gate requerido por una
// anotación legítima.
const DECLARATION_FILE_PATTERN = /\.d\.(?:ts|mts|cts)$/i
// Entrypoints de runtime que viven en la raíz de la app, fuera de src/:
// `src/instrumentation.ts` los carga con `await import('../sentry.*.config')`
// en producción (y Next carga el client config en el bundle). Un import ahí
// es tan runtime como uno en src/. `mdx-components` también cuenta: con
// `@next/mdx` habilitado, Next usa el `mdx-components.tsx` de la raíz como
// registro de componentes del App Router en runtime (convención documentada
// en next/dist/docs .../file-conventions/mdx-components.md), así que un
// import ahí carga en runtime aunque hoy la app no use MDX — si alguien lo
// añade, el gate debe verlo, no quedarse en verde. Los configs de build/test
// de la raíz (next.config, vitest.config, ...) NO son runtime y quedan fuera.
const RUNTIME_ROOT_ENTRYPOINTS =
  /^(?:sentry\.(?:server|edge|client)\.config|instrumentation(?:-client)?|middleware|proxy|mdx-components)\.[^.]+$/

// Specifiers de un archivo que NO parsea (fallback textual, mismo juego de
// aperturas que el escáner de paquetes): la travesía de módulos locales no
// puede depender solo del parser. Captura cualquier specifier literal; el
// caller filtra los locales (relativos o vía path alias).
const LOCAL_IMPORT_FALLBACK_PATTERN =
  /(?:\bfrom|\brequire\s*(?:\?\.\s*)?\(|\bimport\s*\(?)\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`)/g
// Resolución de bundler para un specifier relativo: el archivo exacto, el
// remap NodeNext (`./x.js` escrito para un `./x.ts` en disco), extensiones
// implícitas y `index.*` de directorio. Solo archivos con extensión de
// fuente de runtime cuentan: un `.css`/`.json`/asset no importa paquetes.
const LOCAL_SPECIFIER_EXTENSION_REMAP: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}

function resolveLocalModule(fromDir: string, specifier: string): string | undefined {
  const base = path.resolve(fromDir, specifier)
  const candidates: string[] = [base]
  const extension = path.extname(base)
  for (const remapped of LOCAL_SPECIFIER_EXTENSION_REMAP[extension] ?? []) {
    candidates.push(base.slice(0, -extension.length) + remapped)
  }
  for (const ext of RUNTIME_SOURCE_EXTENSIONS) candidates.push(base + ext)
  for (const ext of RUNTIME_SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`))
  for (const candidate of candidates) {
    if (!RUNTIME_SOURCE_EXTENSIONS.has(path.extname(candidate))) continue
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

// Alias de paths de tsconfig (`@/*` -> `./src/*`): un import vía el alias
// empaqueta el módulo destino igual que un import relativo, así que la
// travesía de módulos locales debe seguirlo — `src/x.ts ->
// @/../runtime-helper.ts -> minimatch` deja el helper fuera del walk inicial
// y sin la arista el import vigilado quedaría invisible con el gate en
// verde. Se leen los mapeos de `compilerOptions.paths` (resueltos contra
// `baseUrl`) del config EFECTIVO — la cadena de `extends` resuelta, no el
// JSON crudo del hijo: un `tsconfig.json` que solo hace `extends:
// "./tsconfig.base.json"` hereda el `baseUrl`/`paths` del padre y TypeScript
// y el bundler los aplican igual que si estuvieran inline, así que leer solo
// las opciones propias del hijo dejaría la arista por alias sin travesía con
// el gate en verde. Los COMODÍN (`@/*` -> `./src/*`) resuelven por prefijo y
// los EXACTOS (`"runtime-helper": ["./runtime-helper.ts"]`) por igualdad del
// specifier completo — ignorar los exactos dejaría su helper fuera de la
// travesía con el gate en verde. Los exactos ganan a los comodines y entre
// comodines gana el prefijo más largo, como TypeScript. Si el tsconfig no
// existe o no define mapeos utilizables, aplica la convención del repo
// (`@/*` -> `./src/*`) — la misma que ya asume el tratamiento de templates
// interpolados con head `@/`. Un alias que no resuelve a un archivo local
// escaneable no puede ocultar un paquete: igual que un relativo, el
// specifier no es un nombre de paquete npm.
type PathAlias = { prefix: string; exact: boolean; targets: string[] }

function loadPathAliases(sourceRoot: string): PathAlias[] {
  const fallback: PathAlias[] = [
    { prefix: '@/', exact: false, targets: [path.join(sourceRoot, 'src')] },
  ]
  const configPath = path.join(sourceRoot, 'tsconfig.json')
  if (!existsSync(configPath)) return fallback
  // `ts.getParsedCommandLineOfConfigFile` resuelve la cadena de `extends`
  // completa y tolera JSONC; `readDirectory` vacío porque solo interesan las
  // compilerOptions efectivas, no la enumeración de archivos del proyecto
  // (el diagnóstico "no inputs" resultante es recuperable y no afecta a las
  // opciones). Un tsconfig ilegible cae a la convención en vez de tumbar el
  // escaneo.
  let unrecoverable = false
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (fileName) => ts.sys.fileExists(fileName),
    readFile: (fileName) => ts.sys.readFile(fileName),
    readDirectory: () => [],
    getCurrentDirectory: () => sourceRoot,
    onUnRecoverableConfigFileDiagnostic: () => {
      unrecoverable = true
    },
  }
  let options: ts.CompilerOptions | undefined
  try {
    options = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)?.options
  } catch {
    return fallback
  }
  if (unrecoverable || options === undefined) return fallback
  const paths = options.paths
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) return fallback
  // El parser devuelve `baseUrl` ya resuelto (absoluto) contra el config que
  // lo declara. Sin `baseUrl` (TS >= 4.1), los targets de `paths` resuelven
  // contra el directorio del config que DECLARA `paths`: el parser lo
  // registra en `pathsBasePath`, interno y fuera del tipo público — de ahí
  // el cast. Si ninguno existe, el directorio del tsconfig del source root.
  const rawBase = options.baseUrl ?? (options as { pathsBasePath?: unknown }).pathsBasePath
  const baseDir = typeof rawBase === 'string' ? path.resolve(sourceRoot, rawBase) : sourceRoot
  const aliases: PathAlias[] = []
  for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(targets)) continue
    if (pattern.endsWith('/*')) {
      const resolved = targets
        .filter((target): target is string => typeof target === 'string' && target.endsWith('/*'))
        .map((target) => path.resolve(baseDir, target.slice(0, -2)))
      if (resolved.length > 0) {
        aliases.push({ prefix: pattern.slice(0, -1), exact: false, targets: resolved })
      }
    } else if (!pattern.includes('*')) {
      // Mapeo EXACTO: el specifier completo resuelve a un archivo concreto
      // (con o sin extensión — la resolución de bundler prueba extensiones e
      // `index.*` igual que para un relativo).
      const resolved = targets
        .filter((target): target is string => typeof target === 'string' && !target.includes('*'))
        .map((target) => path.resolve(baseDir, target))
      if (resolved.length > 0) aliases.push({ prefix: pattern, exact: true, targets: resolved })
    }
  }
  aliases.sort((a, b) => Number(b.exact) - Number(a.exact) || b.prefix.length - a.prefix.length)
  return aliases.length > 0 ? aliases : fallback
}

// Alias de `imports` de package.json (subpath imports de Node): con
// `{"#glob": "minimatch"}`, `import '#glob'` resuelve y EJECUTA minimatch sin
// tocar versiones ni aristas del lockfile — una copia vulnerable ya hoisted
// se vuelve runtime-reachable con el gate en verde si el escaneo no sigue el
// mapeo. Se leen las claves `#...` (exactas y con UN comodín `*`, como Node)
// y se recogen TODOS los targets string del árbol de condiciones/fallbacks:
// el gate no sabe qué condición elegirá el runtime, así que cualquier rama
// alcanzable cuenta. Un target `null` bloquea la carga y no aporta nada; un
// target que no es string/array/objeto/null (o una clave con más de un `*`,
// que Node ni siquiera admite) marca el mapeo como no acotable y el
// specifier que entre por él se rechaza con diagnóstico, nunca con un
// veredicto (fail closed).
type ImportsAlias = { pattern: string; wildcard: boolean; targets: string[]; unbounded: boolean }

function collectImportsTargets(target: unknown, out: string[]): boolean {
  if (target === null) return true
  if (typeof target === 'string') {
    out.push(target)
    return true
  }
  if (Array.isArray(target)) return target.every((entry) => collectImportsTargets(entry, out))
  if (typeof target === 'object') {
    return Object.values(target as Record<string, unknown>).every((entry) =>
      collectImportsTargets(entry, out)
    )
  }
  return false
}

function loadImportsAliases(sourceRoot: string): ImportsAlias[] {
  const packagePath = path.join(sourceRoot, 'package.json')
  if (!existsSync(packagePath)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(packagePath, 'utf8'))
  } catch {
    // Un package.json ilegible deja el gate SIN mapeos: todo specifier `#`
    // se rechaza con diagnóstico en vez de ignorarse en silencio.
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const imports = (parsed as { imports?: unknown }).imports
  if (imports === null || typeof imports !== 'object' || Array.isArray(imports)) return []
  const aliases: ImportsAlias[] = []
  for (const [pattern, target] of Object.entries(imports as Record<string, unknown>)) {
    if (!pattern.startsWith('#')) continue
    const targets: string[] = []
    const bounded = collectImportsTargets(target, targets)
    const wildcards = pattern.split('*').length - 1
    aliases.push({
      pattern,
      wildcard: wildcards === 1,
      targets,
      unbounded: !bounded || wildcards > 1,
    })
  }
  return aliases
}

// Resolución de un specifier `#` contra los mapeos: la clave exacta gana y
// entre comodines gana el prefijo más largo, como Node. `matched` es la
// porción capturada por `*` (se sustituye en cada target del mapeo).
type ImportsMatch = { alias: ImportsAlias; matched: string }

function matchImportsAlias(
  aliases: readonly ImportsAlias[],
  specifier: string
): ImportsMatch | undefined {
  let best: ImportsMatch | undefined
  let bestPrefixLength = -1
  for (const alias of aliases) {
    if (!alias.wildcard) {
      if (alias.pattern === specifier) return { alias, matched: '' }
      continue
    }
    const star = alias.pattern.indexOf('*')
    const prefix = alias.pattern.slice(0, star)
    const suffix = alias.pattern.slice(star + 1)
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      prefix.length > bestPrefixLength
    ) {
      best = { alias, matched: specifier.slice(prefix.length, specifier.length - suffix.length) }
      bestPrefixLength = prefix.length
    }
  }
  return best
}

/**
 * Borra comentarios (de línea y de bloque) preservando strings, template
 * literals y literales de REGEX, para que un import meramente documentado —
 * `// import x from 'minimatch'` — no marque el paquete como
 * runtime-reachable, y para que un `/*` dentro de un literal de regex
 * (`/[/*]/`) no blanquee imports reales que lo siguen. Reemplaza el
 * comentario por espacios para no alterar posiciones. No es un parser
 * completo: un string que CONTIENE sintaxis de import completa sigue
 * contando (falso positivo conservador, en la dirección fail-closed del
 * gate).
 */
// Un '/' abre un literal de regex solo en posición de expresión. Si el último
// token significativo puede TERMINAR una expresión (identificador, número,
// ')', ']', fin de string/regex), el '/' es división — salvo que ese token
// sea una keyword que NO puede terminar una expresión. Hay dos familias:
// keywords que preceden sintácticamente una expresión (`return`, `typeof`,
// ...) y keywords de sentencia/declaración tras las cuales un '/' solo puede
// ser regex — `debugger\n/re/` termina la sentencia por ASI y el '/' abre la
// siguiente (igual `break`/`continue`, cuya producción restringida prohíbe el
// label en otra línea), y `var`/`if`/`function`/... nunca admiten división
// detrás. Un nombre de propiedad igual a una keyword (`mod.default / 2`)
// puede misclasificarse como regex: eso solo puede dejar comentarios SIN
// borrar en esa línea (falso positivo conservador), nunca abrir un comentario
// de bloque fantasma que oculte imports — la dirección fail-closed.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  // Límites de sentencia / declaración: no pueden terminar una expresión.
  'debugger',
  'break',
  'continue',
  'var',
  'let',
  'const',
  'function',
  'class',
  'extends',
  'default',
  'export',
  'import',
  'enum',
  'try',
  'finally',
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'with',
])
// Tras el `)` que CIERRA una condición de control-flow — `if (ok) /re/` —
// sí empieza expresión: ese '/' abre regex, no división. Sin distinguirlo,
// el `/*` dentro del literal abriría un comentario de bloque fantasma.
const CONTROL_FLOW_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'with'])
// `break label` / `continue label` terminan la sentencia (producción
// restringida: el label debe ir en la misma línea, y tras él aplica ASI).
// Ahí `lastWord` es el LABEL, no la keyword, así que el lookup de arriba no
// alcanza: hace falta recordar la palabra anterior para reconocer que un '/'
// tras el label abre regex — si no, el `/*` de `break outer\n/[/*]/` abriría
// un comentario de bloque fantasma que oculta imports reales de runtime.
const LABELED_JUMP_KEYWORDS = new Set(['break', 'continue'])
const WORD_CHAR = /[A-Za-z0-9_$]/

export function stripComments(content: string): string {
  const out = content.split('')
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' | 'regexClass'
  let state: State = 'code'
  // Último char significativo y última palabra completa: deciden si un '/'
  // abre regex (posición de expresión) o es división (posición de operador).
  // Sin esto, el `/*` DENTRO de un literal como /[/*]/ se tomaría por
  // apertura de comentario de bloque y blanquearía imports reales de runtime
  // hasta el próximo `*/` — un falso negativo del gate.
  let lastSignificant = ''
  let lastWord = ''
  // Palabra completa inmediatamente anterior a `lastWord` (separadas solo por
  // whitespace). Solo se consulta para labels de `break`/`continue`.
  let prevWord = ''
  // Stack de paréntesis: cada '(' recuerda si lo precedía una keyword de
  // control-flow. Al cerrar, `lastCloseParenIsControl` decide si el ')' deja
  // posición de expresión (condición de `if`/`while`/...) o de operando
  // (llamada, agrupación).
  const parenStack: boolean[] = []
  let lastCloseParenIsControl = false
  // true mientras el string abierto es el module specifier de una declaración
  // de import/export (venía precedido por la keyword `from` o `import`).
  let stringIsModuleSpecifier = false
  // Stack de interpolaciones de template: cada `${` abierto recuerda la
  // profundidad de llaves de SU expresión. Sin él, el backtick que abre un
  // template anidado dentro de `${...}` se tomaría por el cierre del template
  // exterior, y un `/*` dentro del anidado (p. ej. `${`/*`}`) blanquearía el
  // resto del archivo como comentario de bloque — falso negativo del gate.
  const templateBraceDepths: number[] = []
  const regexCanStart = () => {
    if (lastSignificant === '') return true
    if (WORD_CHAR.test(lastSignificant))
      return REGEX_PRECEDING_KEYWORDS.has(lastWord) || LABELED_JUMP_KEYWORDS.has(prevWord)
    if (lastSignificant === ')') return lastCloseParenIsControl
    return !(lastSignificant === ']' || lastSignificant === '#')
  }
  // El whitespace separa palabras: sin este límite, dos tokens seguidos solo
  // por espacios/saltos se fusionarían (`export default` → "exportdefault",
  // `1\ndebugger` → "1debugger", `else if` → "elseif") y la keyword real
  // nunca matchearía en los lookups — un '/' siguiente se tomaría por
  // división y su `/*` interno abriría un comentario fantasma.
  let wordBoundary = false
  const trackSignificant = (ch: string) => {
    if (/\s/.test(ch)) {
      wordBoundary = true
      return
    }
    if (ch === '(') {
      parenStack.push(WORD_CHAR.test(lastSignificant) && CONTROL_FLOW_PAREN_KEYWORDS.has(lastWord))
    } else if (ch === ')') {
      lastCloseParenIsControl = parenStack.pop() ?? false
    }
    if (WORD_CHAR.test(ch)) {
      if (WORD_CHAR.test(lastSignificant) && !wordBoundary) {
        lastWord += ch
      } else {
        // Palabra nueva: la anterior queda como `prevWord` (solo es no-vacía
        // cuando ambas están separadas únicamente por whitespace).
        prevWord = lastWord
        lastWord = ch
      }
    } else {
      prevWord = ''
      lastWord = ''
    }
    lastSignificant = ch
    wordBoundary = false
  }
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        out[i] = ' '
      } else if (ch === '/' && next === '*') {
        state = 'block'
        out[i] = ' '
      } else if (ch === '/' && regexCanStart()) {
        state = 'regex'
      } else if (ch === "'") {
        // El string que sigue a `from` o `import` es un module specifier: su
        // cierre TERMINA la declaración (nada salvo `;` o una cláusula de
        // atributos puede seguir), así que un '/' después abre regex por ASI,
        // no división. Sin distinguirlo, `import x from 'foo'\n/[/*]/`
        // marcaría posición de operando y el `/*` interno abriría un
        // comentario fantasma que oculta imports reales.
        stringIsModuleSpecifier = lastWord === 'from' || lastWord === 'import'
        state = 'single'
        trackSignificant(ch)
      } else if (ch === '"') {
        stringIsModuleSpecifier = lastWord === 'from' || lastWord === 'import'
        state = 'double'
        trackSignificant(ch)
      } else if (ch === '`') {
        state = 'template'
        trackSignificant(ch)
      } else if (ch === '{' && templateBraceDepths.length > 0) {
        templateBraceDepths[templateBraceDepths.length - 1]++
        trackSignificant(ch)
      } else if (ch === '}' && templateBraceDepths.length > 0) {
        if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
          // Cierra la interpolación: volvemos al template que la contenía.
          templateBraceDepths.pop()
          state = 'template'
        } else {
          templateBraceDepths[templateBraceDepths.length - 1]--
          trackSignificant(ch)
        }
      } else {
        trackSignificant(ch)
      }
    } else if (state === 'line') {
      if (ch === '\n') state = 'code'
      else out[i] = ' '
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i++
        state = 'code'
      } else if (ch !== '\n') out[i] = ' '
    } else if (state === 'single') {
      if (ch === '\\') i++
      else if (ch === "'" || ch === '\n') {
        state = 'code'
        // Un string común es un operando ('/' siguiente = división); un
        // module specifier cierra la declaración ('/' siguiente = regex).
        lastSignificant = stringIsModuleSpecifier ? ';' : ')'
        lastWord = ''
        lastCloseParenIsControl = false
        stringIsModuleSpecifier = false
      }
    } else if (state === 'double') {
      if (ch === '\\') i++
      else if (ch === '"' || ch === '\n') {
        state = 'code'
        lastSignificant = stringIsModuleSpecifier ? ';' : ')'
        lastWord = ''
        lastCloseParenIsControl = false
        stringIsModuleSpecifier = false
      }
    } else if (state === 'template') {
      if (ch === '\\') i++
      else if (ch === '$' && next === '{') {
        // Interpolación: el contenido es código (puede anidar templates).
        templateBraceDepths.push(0)
        state = 'code'
        i++
        // Posición de expresión: un '/' inmediato abriría regex, no división.
        lastSignificant = '{'
        lastWord = ''
        lastCloseParenIsControl = false
      } else if (ch === '`') {
        state = 'code'
        lastSignificant = ')'
        lastWord = ''
        lastCloseParenIsControl = false
      }
    } else if (state === 'regex') {
      if (ch === '\\') i++
      else if (ch === '[') state = 'regexClass'
      else if (ch === '/') {
        state = 'code'
        // El literal completo es un operando: un '/' siguiente es división.
        lastSignificant = ')'
        lastWord = ''
        lastCloseParenIsControl = false
      } else if (ch === '\n') {
        // Un literal de regex no admite salto de línea sin escapar: si
        // llegamos aquí era división mal clasificada; volver a código para
        // no blanquear de más.
        state = 'code'
      }
    } else if (state === 'regexClass') {
      if (ch === '\\') i++
      else if (ch === ']') state = 'regex'
      else if (ch === '\n') state = 'code'
    }
  }
  return out.join('')
}

// Un `import type ... from 'x'` / `export type ... from 'x'` se borra
// completo en compilación: no carga el módulo en runtime y no es
// reachability. Cubre todas las formas statement-level borradas: named,
// namespace, default, default + cláusula (`import type Foo, { Bar } from 'x'`)
// e import-equals (`import type Foo = require('x')`).
//
// FALLBACK textual, SOLO para archivos que no parsean: cuando el archivo
// parsea, los rangos type-only vienen del parser (`collectImportBindings`
// los blanquea vía `erasedImports`). Aplicar este regex sobre código
// parseable es fail-open: puede arrancar DENTRO de un string
// (`"import type Foo from " + require('minimatch')`), tomar su comilla de
// cierre como apertura del module specifier y blanquear un require real que
// SÍ ejecuta — el paquete vulnerable quedaría runtime-reachable con el gate
// requerido en verde.
const MODULE_SPECIFIER_LITERAL = String.raw`(?:'[^'\n]*'|"[^"\n]*"|` + '`[^`]*`)'
const TYPE_ONLY_IMPORT_PATTERN = new RegExp(
  String.raw`\b(?:import|export)\s+type\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|[A-Za-z_$][\w$]*)\s*from\s*${MODULE_SPECIFIER_LITERAL}` +
    String.raw`|\bimport\s+type\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*${MODULE_SPECIFIER_LITERAL}\s*\)`,
  'g'
)

// Una cláusula named cuyos specifiers son TODOS inline type
// (`import { type Metadata } from 'next'`) también se borra completa: los
// tsconfig de este repo no habilitan `verbatimModuleSyntax` (solo
// `isolatedModules`), así que el compilador elide el import entero y el
// módulo nunca se carga — verificado transpilando con la config real. Solo
// se borra cuando NADA de la cláusula sobrevive en runtime: un specifier de
// valor (`{ type A, b }`), un default de valor delante
// (`import Foo, { type A } from 'x'`, que no matchea porque exige `{` tras
// la keyword), un binding de VALOR llamado `type` (`{ type }`, `{ type as
// alias }`) o una cláusula vacía (`import {} from 'x'`, que SÍ ejecuta el
// módulo) siguen contando — dirección fail-closed.
const INLINE_TYPE_CLAUSE_PATTERN = new RegExp(
  String.raw`\b(?:import|export)\s*\{([^}]*)\}\s*from\s*${MODULE_SPECIFIER_LITERAL}`,
  'g'
)
const INLINE_TYPE_SPECIFIER = /^type\s+[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?$/

export function stripTypeOnlyImports(content: string): string {
  return content
    .replace(TYPE_ONLY_IMPORT_PATTERN, (match) => match.replace(/[^\n]/g, ' '))
    .replace(INLINE_TYPE_CLAUSE_PATTERN, (match, clause: string) => {
      const specifiers = clause
        .split(',')
        .map((specifier) => specifier.trim())
        .filter((specifier) => specifier.length > 0)
      const allTypeOnly =
        specifiers.length > 0 &&
        specifiers.every((specifier) => INLINE_TYPE_SPECIFIER.test(specifier))
      return allTypeOnly ? match.replace(/[^\n]/g, ' ') : match
    })
}

/**
 * Borra comentarios usando el parser REAL de TypeScript en vez del lexer
 * a mano: `ts.createSourceFile` modela JSX, así que el texto JSX
 * `<span>/*</span>` en un `.tsx` es un token JsxText — no trivia — y no abre
 * un comentario de bloque fantasma que blanquee imports reales de runtime
 * (el lexer a mano no modela JSX y sí caía ahí). Todo comentario es trivia
 * previa de ALGÚN token (los del final del archivo, del token EOF), así que
 * recorrer todos los tokens hoja y blanquear sus rangos de comentario cubre
 * el archivo completo. Igual que el lexer, reemplaza por espacios y conserva
 * los saltos de línea para no alterar posiciones. NO se usa el emit del
 * transpiler para esto: el emit elide imports de valor no usados,
 * `import {} from 'x'` y `import Foo = require('x')`, que SÍ cargan el
 * módulo en runtime — dirección fail-open inaceptable para el gate.
 * Si el archivo no parsea, cae al lexer a mano (mejor esfuerzo, y un archivo
 * roto ya no compila en CI por otro lado).
 */
export function stripCommentsWithParser(content: string, fileName: string): string {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false)
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] })
    .parseDiagnostics
  if (!Array.isArray(parseDiagnostics) || parseDiagnostics.length > 0) {
    return stripComments(content)
  }
  const out = content.split('')
  const blank = (pos: number, end: number) => {
    for (let i = pos; i < end; i++) {
      if (out[i] !== '\n') out[i] = ' '
    }
  }
  const seen = new Set<number>()
  const visit = (node: ts.Node) => {
    const children = node.getChildren(sourceFile)
    if (children.length === 0) {
      // Token hoja: su trivia previa contiene los comentarios entre el token
      // anterior y este. Hacen falta AMBAS lecturas: `getTrailingCommentRanges`
      // devuelve los comentarios en la misma línea antes del primer salto
      // (`foo() // c` o `{/* c */}`), y `getLeadingCommentRanges` los que
      // vienen después de ese salto. Solo una de las dos deja comentarios
      // vivos que contarían como imports — falso positivo, pero ruido.
      // Los scanners de rangos leen texto CRUDO sin contexto: solo se llaman
      // cuando existe hueco de trivia real (fullStart < inicio del token).
      // Un token JsxText no tiene hueco — su texto ES el token — y escanear
      // en su posición tomaría `<span>/*` por apertura de comentario y
      // blanquearía el resto del archivo, el bug exacto que motiva el parser.
      const fullStart = node.getFullStart()
      if (node.getStart(sourceFile) <= fullStart) return
      for (const range of [
        ...(ts.getTrailingCommentRanges(content, fullStart) ?? []),
        ...(ts.getLeadingCommentRanges(content, fullStart) ?? []),
      ]) {
        if (!seen.has(range.pos)) {
          seen.add(range.pos)
          blank(range.pos, range.end)
        }
      }
      return
    }
    for (const child of children) visit(child)
  }
  visit(sourceFile)
  return out.join('')
}

/**
 * Bindings importados por specifier, extraídos con el parser real de
 * TypeScript. El hit "archivo -> specifier" no basta como identidad: un
 * archivo YA aprobado puede empezar a importar un binding build-only del
 * MISMO specifier (`withSentryConfig` de `@sentry/nextjs` junto al
 * `captureException` revisado) y el hit quedaría byte-idéntico — la
 * dependencia build-only se volvería runtime-reachable sin drift de lock ni
 * de import. Se pinnean los nombres EXPORTADOS (no el alias local: `import
 * { Linter as L }` alcanza `Linter`). Un namespace import (`import * as
 * Sentry`) no se colapsa a `*` de entrada: eso pre-autorizaría para siempre
 * TODA la superficie del módulo y el caso citado — instrumentation.ts que
 * empieza a llamar el build-only `withSentryConfig` — quedaría sin drift.
 * Se pinnean las propiedades ACCEDIDAS sobre el binding del namespace
 * (`Sentry.init` → `init`); solo si el objeto namespace escapa a un uso que
 * el análisis no acota (se pasa entero, se re-exporta, acceso computado no
 * literal, shorthand `{ Sentry }`) degrada a `*`. El objeto módulo de un
 * loader (`require(...)`, `import(...)` dinámico, alias) recibe el MISMO
 * tratamiento cuando su consumidor es estático: el parámetro del callback
 * de `.then` y la variable que recibe el módulo se siguen como un
 * namespace, un acceso directo o un destructuring simple pinnean esos
 * nombres — sin esto, el `import('@sentry/nextjs').then((Sentry) =>
 * Sentry.captureException(...))` de los error boundaries quedaba `[*]`,
 * un pin pre-aprobado que dejaba sin drift el cambio del callback al
 * build-only `withSentryConfig`. `export *`, `import = require` y todo
 * consumo que no seguimos (el módulo escapa a una llamada, se exporta,
 * `.catch`/promesa guardada) sí son `*`: entregan el objeto módulo entero.
 * Un side-effect import (`import 'x'`, `import {} from 'x'`) ejecuta el
 * módulo sin exponer API: lista vacía. Si el archivo no parsea devuelve
 * null: sin evidencia estática de qué expone cada specifier, el hit se
 * pinnea como `*` — fail closed.
 *
 * `requireAliasSpecifiers` devuelve los specifiers cargados vía ALIAS del
 * loader estándar de Node: `const localRequire = createRequire(import.meta.url)`
 * seguido de `localRequire('minimatch')` carga el paquete instalado igual
 * que `require(...)`, pero el escáner textual no ve ni `from`, ni `require`
 * ni `import` — el hit quedaría invisible y una copia hoisted High/Critical
 * se volvería runtime-reachable sin drift del lockfile. Se siguen los
 * bindings resolubles estáticamente: variables inicializadas con una
 * llamada a `createRequire` (el import nombrado de `module`/`node:module`,
 * cualquier alias de ese import, un acceso `.createRequire`/
 * `['createRequire']` sobre cualquier objeto, o un alias de la FÁBRICA
 * misma — `const cr = mod.createRequire`, `const { createRequire: cr } =
 * mod`, y sus re-alias — fail closed: no verificamos la procedencia), alias
 * directos de `require` (`const r = require`) y re-alias transitivos
 * (`const r2 = r`), más la forma directa `createRequire(...)('x')`. También
 * los BINDS del loader: un bind puro (`const r = require.bind(module)`, ≤1
 * argumento — solo liga `this`) devuelve el mismo loader y se sigue como
 * alias; un bind parcial (`require.bind(null, 'x')`) pre-liga el specifier,
 * y `require.call(...)`/`require.apply(...)` lo entregan fuera del primer
 * argumento — en los tres casos el specifier resoluble registra un hit `*`
 * y el no resoluble va al rechazo. El
 * análisis es léxico, sin scopes: un nombre que sombrea un alias puede
 * atribuir cargas de más (bloquear de más), nunca de menos.
 *
 * El ARGUMENTO de un loader también se resuelve estáticamente: en
 * `const packageName = 'minimatch'; require(packageName)` el specifier no
 * es un literal (specifierText devuelve undefined) y el escáner textual no
 * ve ninguna comilla tras `require(` — sin seguir el binding, Node carga la
 * copia hoisted con el gate en verde. Se resuelven constantes string únicas
 * del archivo (literal o re-alias transitivo de otra constante); cualquier
 * nombre re-asignado, re-declarado, o ligado por un parámetro, patrón de
 * destructuring, import u otra declaración queda ENVENENADO y no resuelve
 * (léxico sin scopes: resolver un nombre sombreado podría suprimir el
 * rechazo con el valor equivocado). Estos specifiers también van en
 * `requireAliasSpecifiers`: el escáner textual no puede verlos.
 *
 * `unresolvedLoaderCalls` lista las llamadas a un loader cuyo argumento NO
 * se pudo acotar estáticamente (variable no constante, expresión computada,
 * template con interpolaciones no resolubles — incluido uno RELATIVO, que
 * puede resolver a un helper local que importe un paquete vigilado, salvo
 * que su tail fije una extensión que no es fuente de runtime, y uno BARE
 * cuyo head no fija el nombre completo del paquete terminado en `/`: la
 * interpolación puede COMPONER un nombre vigilado, `\`mini${x}\`` →
 * `minimatch`; cuando el head sí lo fija, el paquete se registra como hit
 * `*`): una carga
 * así puede nombrar CUALQUIER módulo, así que el gate no puede emitir un
 * veredicto sobre el archivo — el caller debe rechazar, nunca pasar.
 * También lista las referencias a un loader (o a la fábrica
 * `createRequire`) que ESCAPAN del análisis estático — guardado en una
 * propiedad de objeto (`const loaders = { load: require }`), pasado como
 * argumento, re-exportado —: la llamada posterior carga sin `require(`
 * textual ni alias seguible, así que el archivo tampoco admite veredicto.
 *
 * `erasedImports` devuelve los rangos de las declaraciones de import de
 * VALOR cuyos bindings solo se referencian en posiciones de tipo (`import
 * { Metadata } from 'next'` usada únicamente como anotación): sin
 * `verbatimModuleSyntax` (ningún tsconfig del repo lo habilita) el
 * compilador elide la declaración completa y el módulo nunca se carga —
 * igual que un `import type` explícito, así que no es reachability y no
 * debe romper el gate requerido. El borrado es POR BINDING: en un import
 * mixto (`import { minimatch, MinimatchOptions } from 'minimatch'` donde
 * `MinimatchOptions` solo se usa como tipo) el compilador emite únicamente
 * los bindings de valor, así que el pin lista solo esos — pinnear el
 * type-only lo convertiría en falsa "API de runtime". Solo se borra con
 * prueba: cada binding necesita AL MENOS una referencia y TODAS en
 * contexto de tipo. Un binding sin referencias no se borra (la elisión del
 * import no usado depende del transpiler — dirección fail-open que el gate
 * no acepta), y cualquier ambigüedad del análisis léxico cuenta como uso
 * de valor. También incluye los rangos de las expresiones de TIPO
 * `import('x')` (ImportTypeNode: `type M = import('next').Metadata`,
 * `typeof import('x')`): el compilador las borra por completo y nunca
 * cargan el módulo, pero el patrón textual las leería como un import
 * dinámico y registraría un hit falso. Y las declaraciones type-only
 * statement-level (`import type ... from 'x'`, `export type ... from 'x'`,
 * `import type Foo = require('x')`, cláusula named all-inline-type): sus
 * rangos de NODO reemplazan al regex textual de type-only en archivos que
 * parsean, porque el regex puede arrancar dentro de un string y blanquear
 * un require real (fail-open).
 */
export type ImportBindingAnalysis = {
  bindings: Map<string, Set<string>>
  erasedImports: Array<{ pos: number; end: number }>
  requireAliasSpecifiers: Set<string>
  /**
   * Directorios (specifiers locales resueltos estáticamente) de los
   * `require.context(dir, ...)` del archivo: Webpack incluye en el bundle
   * TODOS los módulos del directorio que matcheen el filtro y `ctx(id)` los
   * carga en runtime, así que el caller debe recorrerlos como fuentes de
   * runtime. Un primer argumento no resoluble o no local va a
   * `unresolvedLoaderCalls`: rechazo, nunca veredicto.
   */
  contextDirectories: string[]
  unresolvedLoaderCalls: string[]
}

export function collectImportBindings(
  content: string,
  fileName: string,
  // Alias de paths configurados en el tsconfig del source root: un template
  // interpolado cuyo head entra por un alias (`import(\`~m/${name}\`)` con
  // `~m/*` -> `./modules/*`) es una carga LOCAL, no un paquete npm — sin
  // consultarlos, la rama de paquete bare inventaría el paquete ficticio
  // `~m` y seguiría en verde mientras el contexto de Webpack puede cargar un
  // helper que importe un paquete vigilado.
  pathAliases: readonly PathAlias[] = []
): ImportBindingAnalysis | null {
  // setParentNodes=true: la pasada de referencias clasifica cada uso de un
  // namespace binding por su nodo padre.
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true)
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] })
    .parseDiagnostics
  if (!Array.isArray(parseDiagnostics) || parseDiagnostics.length > 0) return null

  const bindings = new Map<string, Set<string>>()
  const add = (specifier: string, name: string | null) => {
    const set = bindings.get(specifier) ?? new Set<string>()
    if (name !== null) set.add(name)
    bindings.set(specifier, set)
  }
  const specifierText = (node: ts.Node): string | undefined =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined

  // Nombre local de cada namespace import → specifier. Sus propiedades
  // accedidas se pinnean por nombre; cualquier otro uso del binding degrada
  // ese specifier a `*` en la segunda pasada.
  const namespaceLocals = new Map<string, string>()
  // Locals que nombran `createRequire`: el nombre literal siempre cuenta
  // (fail closed, sin verificar procedencia) más cualquier alias del import
  // nombrado de `module`/`node:module` (`import { createRequire as cr }`).
  const createRequireLocals = new Set<string>(['createRequire'])
  // Locals que reciben una propiedad llamada `require` por destructuring
  // (`const { require: moduleRequire } = module`): alían el LOADER de
  // CommonJS igual que un acceso `module.require` — mismo criterio
  // fail-closed, sin verificar la procedencia del objeto. Se siembran en
  // `requireAliases` para que `moduleRequire.bind(module)` cuente como bind
  // puro del loader y `r('minimatch')` registre el hit en vez de cargar la
  // copia hoisted invisible con el gate en verde.
  const destructuredRequireLocals = new Set<string>()
  // Declaraciones `const x = <init>` y llamadas: se recogen en la pasada
  // principal y se resuelven después, para que un alias declarado tras su
  // uso (hoisting) también cuente.
  const aliasDeclarations: Array<{ name: string; initializer: ts.Expression }> = []
  const callSites: ts.CallExpression[] = []
  // Nombres que NO pueden resolverse como constante string: re-asignados,
  // ligados por parámetros/destructuring/imports/funciones, o declarados
  // sin initializer (`let x`, `for (const x of ...)`, catch). El análisis
  // es léxico, sin scopes: si un nombre tiene CUALQUIER otro binding además
  // de una única `const x = 'literal'`, resolverlo podría suprimir el
  // rechazo de un loader dinámico con el valor de la declaración equivocada
  // — dirección fail-open que el gate no acepta.
  const poisonedNames = new Set<string>()
  const poisonBindingName = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      poisonedNames.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        // Destructurar una propiedad llamada `createRequire`
        // (`const { createRequire: cr } = mod`) alía la FÁBRICA del loader:
        // el mismo criterio fail-closed que un acceso `.createRequire` — el
        // nombre literal cuenta sin verificar la procedencia del objeto.
        if (ts.isObjectBindingPattern(name) && ts.isIdentifier(element.name)) {
          const property = element.propertyName ?? element.name
          if (ts.isIdentifier(property) || ts.isStringLiteral(property)) {
            if (property.text === 'createRequire') {
              createRequireLocals.add(element.name.text)
            } else if (property.text === 'require') {
              // `const { require: r } = module` alía el LOADER mismo, no la
              // fábrica: sin registrarlo, ni `r('minimatch')` ni su bind
              // puro se reconocerían como un require real.
              destructuredRequireLocals.add(element.name.text)
            }
          }
        }
        poisonBindingName(element.name)
      }
    }
  }

  const unwrapExpression = (expression: ts.Expression): ts.Expression => {
    let current = expression
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression
    }
    return current
  }
  // Un patrón de destructuring en ASIGNACIÓN (no declaración):
  // `({ createRequire: cr } = require('node:module'))` alía la FÁBRICA igual
  // que la forma declarada — sin registrarlo, `cr(__filename)` no se
  // reconocería como un require real y `r('minimatch')` cargaría la copia
  // hoisted invisible para el escaneo textual con el gate en verde. El alias
  // registrado cae luego en el paso de escapes del loader (una
  // PropertyAssignment no es posición segura): rechazo con diagnóstico,
  // nunca un veredicto. Además TODOS los targets asignados quedan
  // envenenados: el valor que reciben no es estático para el análisis
  // léxico y resolverlos como constante string suprimiría un rechazo.
  const poisonAssignmentPattern = (pattern: ts.Expression) => {
    const target = unwrapExpression(pattern)
    if (ts.isIdentifier(target)) {
      poisonedNames.add(target.text)
      return
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isPropertyAssignment(property)) {
          // Con default (`{ createRequire: cr = f }`) el initializer es la
          // asignación anidada `cr = f`: el alias es su lado izquierdo.
          let value = unwrapExpression(property.initializer)
          if (
            ts.isBinaryExpression(value) &&
            value.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ) {
            value = unwrapExpression(value.left)
          }
          if (
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            ts.isIdentifier(value)
          ) {
            if (property.name.text === 'createRequire') {
              createRequireLocals.add(value.text)
            } else if (property.name.text === 'require') {
              // `({ require: r } = module)` alía el LOADER mismo por
              // asignación: mismo registro que la forma declarada.
              destructuredRequireLocals.add(value.text)
            }
          }
          poisonAssignmentPattern(property.initializer)
        } else if (ts.isShorthandPropertyAssignment(property)) {
          // `({ createRequire } = mod)`: el shorthand asigna el local
          // homónimo, que ya cuenta como fábrica por nombre literal.
          poisonedNames.add(property.name.text)
        } else if (ts.isSpreadAssignment(property)) {
          poisonAssignmentPattern(property.expression)
        }
      }
      return
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue
        poisonAssignmentPattern(ts.isSpreadElement(element) ? element.expression : element)
      }
      return
    }
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // Elemento con default (`[cr = f] = ...`): el target es el izquierdo.
      poisonAssignmentPattern(target.left)
    }
  }
  // Una llamada a `createRequire` produce un require real: identifier local
  // conocido o CUALQUIER acceso `.createRequire` (`mod.createRequire`,
  // `require('module').createRequire`) — no acotamos el receptor: la
  // ambigüedad bloquea de más, nunca de menos.
  const isCreateRequireCall = (expression: ts.Expression): boolean => {
    const call = unwrapExpression(expression)
    if (!ts.isCallExpression(call)) return false
    const callee = unwrapExpression(call.expression)
    return (
      (ts.isIdentifier(callee) && createRequireLocals.has(callee.text)) ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire') ||
      (ts.isElementAccessExpression(callee) &&
        specifierText(unwrapExpression(callee.argumentExpression)) === 'createRequire')
    )
  }
  // Declaraciones de import con solo bindings named/default: sus adds se
  // difieren hasta clasificar las referencias de cada binding local — si
  // todas caen en posiciones de tipo, el compilador elide la declaración
  // completa y no hay hit que registrar.
  type ImportCandidate = {
    node: ts.ImportDeclaration
    spec: string
    exportedNames: string[]
    locals: string[]
  }
  const candidates: ImportCandidate[] = []
  const importLocalRefs = new Map<string, { seen: boolean; valueUse: boolean }>()
  // Expresiones de tipo `import('x')`: se borran en compilación, así que su
  // rango se blanquea antes del escaneo textual (ver ImportBindingAnalysis).
  const erasedTypeExpressions: Array<{ pos: number; end: number }> = []

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = specifierText(node.moduleSpecifier)
      if (spec !== undefined) {
        const clause = node.importClause
        if (clause === undefined) {
          // Side-effect import: carga el módulo pero no expone API al archivo.
          add(spec, null)
        } else if (clause.isTypeOnly) {
          // `import type ... from 'x'` se borra completo en compilación y
          // nunca carga el módulo: se blanquea el rango del NODO para que el
          // escaneo textual no lo cuente. El blanqueo va por rangos del
          // parser, no por el regex textual: aplicado sobre el archivo
          // entero, el regex puede arrancar DENTRO de un string
          // (`"import type Foo from " + require('x')`), tomar su comilla de
          // cierre como apertura del specifier y blanquear un require real —
          // falso negativo del gate requerido.
          erasedTypeExpressions.push({ pos: node.getStart(sourceFile), end: node.end })
        } else {
          const exportedNames: string[] = []
          const locals: string[] = []
          if (clause.name !== undefined) {
            exportedNames.push('default')
            locals.push(clause.name.text)
          }
          let hasNamespace = false
          const named = clause.namedBindings
          if (named !== undefined) {
            if (ts.isNamespaceImport(named)) {
              hasNamespace = true
              const local = named.name.text
              if (namespaceLocals.has(local) && namespaceLocals.get(local) !== spec) {
                // Dos namespaces con el mismo nombre local no compilan, pero
                // si aparecen no podemos atribuir los accesos: ambos a `*`.
                add(namespaceLocals.get(local) as string, '*')
                add(spec, '*')
              } else {
                namespaceLocals.set(local, spec)
              }
            } else {
              for (const element of named.elements) {
                if (!element.isTypeOnly) {
                  const exported = (element.propertyName ?? element.name).text
                  exportedNames.push(exported)
                  locals.push(element.name.text)
                  if (
                    exported === 'createRequire' &&
                    (spec === 'module' || spec === 'node:module')
                  ) {
                    createRequireLocals.add(element.name.text)
                  }
                }
              }
            }
          }
          if (
            !hasNamespace &&
            locals.length === 0 &&
            named !== undefined &&
            !ts.isNamespaceImport(named) &&
            named.elements.length > 0
          ) {
            // Cláusula named cuyos specifiers son TODOS inline type
            // (`import { type A } from 'x'`): sin verbatimModuleSyntax el
            // compilador la elide completa y el módulo nunca se carga — se
            // blanquea el rango del nodo, igual que un `import type`
            // explícito. `import {} from 'x'` (cero elementos) SÍ ejecuta el
            // módulo y no entra aquí.
            erasedTypeExpressions.push({ pos: node.getStart(sourceFile), end: node.end })
          } else if (hasNamespace || locals.length === 0) {
            // Cláusula con namespace (nunca se borra aquí: fail closed) o
            // vacía (`import {} from 'x'`, que SÍ ejecuta el módulo).
            add(spec, null)
            for (const name of exportedNames) add(spec, name)
          } else {
            candidates.push({ node, spec, exportedNames, locals })
            for (const local of locals) {
              if (!importLocalRefs.has(local)) {
                importLocalRefs.set(local, { seen: false, valueUse: false })
              }
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      // Un re-export hace alcanzables los bindings para quien importe este
      // archivo: cuenta igual que importarlos.
      const spec = specifierText(node.moduleSpecifier)
      if (spec !== undefined && node.isTypeOnly) {
        // `export type { ... } from 'x'` / `export type * from 'x'` se
        // borran completos en compilación: se blanquea el rango del nodo
        // para que el `from 'x'` visible no registre un hit falso.
        erasedTypeExpressions.push({ pos: node.getStart(sourceFile), end: node.end })
      } else if (spec !== undefined) {
        const clause = node.exportClause
        if (clause === undefined || ts.isNamespaceExport(clause)) {
          add(spec, null)
          add(spec, '*')
        } else if (clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly)) {
          // `export { type Metadata } from 'next'`: `node.isTypeOnly` es
          // false, pero con TODOS los specifiers inline type el compilador
          // elide la declaración completa (sin verbatimModuleSyntax, igual
          // que la cláusula de import all-type) y el módulo nunca se carga.
          // Registrarla — o dejar el `from` visible al escaneo textual —
          // convertiría una anotación borrada en un hit falso del gate
          // requerido: se blanquea el rango entero. `export {} from 'x'`
          // (cero elementos) SÍ ejecuta el módulo y no entra aquí.
          erasedTypeExpressions.push({ pos: node.getStart(sourceFile), end: node.end })
        } else {
          add(spec, null)
          for (const element of clause.elements) {
            if (!element.isTypeOnly) add(spec, (element.propertyName ?? element.name).text)
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      poisonedNames.add(node.name.text)
      if (node.isTypeOnly) {
        // `import type Foo = require('x')` se borra en compilación y nunca
        // carga el módulo, pero su `require('x')` es textualmente idéntico a
        // uno real: se blanquea el rango del nodo.
        erasedTypeExpressions.push({ pos: node.getStart(sourceFile), end: node.end })
      } else if (ts.isExternalModuleReference(node.moduleReference)) {
        const spec = specifierText(node.moduleReference.expression)
        if (spec !== undefined) add(spec, '*')
      }
    } else if (ts.isImportTypeNode(node)) {
      // `import('x')` en posición de TIPO (`type M = import('next').Metadata`,
      // `typeof import('x')`) se borra por completo en compilación — el
      // emit es `export {};` — y nunca carga el módulo, pero el patrón
      // textual `import(` lo leería como un import dinámico y una anotación
      // legítima rompería el gate requerido en falso: su rango se blanquea
      // antes del escaneo, igual que un import de valor borrado.
      erasedTypeExpressions.push({ pos: node.getStart(sourceFile), end: node.end })
    } else if (ts.isCallExpression(node)) {
      // Todas las llamadas se resuelven tras la pasada, cuando los alias de
      // require y las constantes string declarados en el archivo (incluso
      // después de su uso, por hoisting) ya se conocen.
      callSites.push(node)
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        if (node.initializer !== undefined) {
          aliasDeclarations.push({ name: node.name.text, initializer: node.initializer })
        } else {
          // `let x` sin initializer, `for (const x of ...)`, catch: el
          // valor no es estático.
          poisonedNames.add(node.name.text)
        }
      } else {
        poisonBindingName(node.name)
      }
    } else if (ts.isParameter(node)) {
      poisonBindingName(node.name)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = unwrapExpression(node.left)
      if (ts.isIdentifier(target)) poisonedNames.add(target.text)
      else if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target))
      ) {
        poisonAssignmentPattern(target)
      }
    } else if (
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      const target = unwrapExpression(node.operand)
      if (ts.isIdentifier(target)) poisonedNames.add(target.text)
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      poisonedNames.add(node.name.text)
    } else if (ts.isImportClause(node) && node.name !== undefined) {
      poisonedNames.add(node.name.text)
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      poisonedNames.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  // Alias resolubles estáticamente del loader de Node: `require` mismo, el
  // resultado de `createRequire(...)`, los re-alias transitivos
  // (`const r = require; const r2 = r`) y los binds puros del loader
  // (`const r = require.bind(module)` — `Function.prototype.bind` con ≤1
  // argumento solo liga `this` y devuelve el MISMO loader). La FÁBRICA
  // también se puede aliar sin pasar por el import nombrado — `const cr =
  // mod.createRequire`, `const cr2 = cr` (la variante destructurada ya se
  // registró en la pasada principal), `createRequire.bind(...)` (pre-ligar
  // `this` o el filename no cambia que su resultado sea un require real):
  // sin seguir esos alias, `cr(import.meta.url)` o `r('minimatch')` no se
  // reconocerían como un require real y la carga quedaría invisible con el
  // gate en verde. Fixpoint sobre las declaraciones porque un alias puede
  // definirse en términos de otro en cualquier orden.
  const methodName = (callee: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text
    if (ts.isElementAccessExpression(callee)) {
      return specifierText(unwrapExpression(callee.argumentExpression))
    }
    return undefined
  }
  // `module.require` es el loader estándar de CommonJS: `module.require(id)`
  // carga igual que `require(id)`, y el escáner textual solo lo ve con
  // specifier literal — `const p = 'minimatch'; module.require(p)` cargaría
  // la copia hoisted con el gate en verde. Igual que con `.createRequire`,
  // no acotamos el receptor (cualquier `.require`/`['require']` cuenta): la
  // ambigüedad bloquea de más, nunca de menos.
  const isModuleRequireAccess = (expression: ts.Expression): boolean => {
    const ref = unwrapExpression(expression)
    return (
      (ts.isPropertyAccessExpression(ref) && ref.name.text === 'require') ||
      (ts.isElementAccessExpression(ref) &&
        specifierText(unwrapExpression(ref.argumentExpression)) === 'require')
    )
  }
  const isPureLoaderBind = (expression: ts.Expression): boolean => {
    const call = unwrapExpression(expression)
    if (!ts.isCallExpression(call) || call.arguments.length > 1) return false
    const callee = unwrapExpression(call.expression)
    return (
      methodName(callee) === 'bind' &&
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      isLoaderReference(callee.expression)
    )
  }
  const isLoaderReference = (expression: ts.Expression): boolean => {
    const ref = unwrapExpression(expression)
    return (
      (ts.isIdentifier(ref) && requireAliases.has(ref.text)) ||
      isModuleRequireAccess(ref) ||
      isCreateRequireCall(ref) ||
      isPureLoaderBind(ref)
    )
  }
  const isFactoryReference = (expression: ts.Expression): boolean =>
    (ts.isIdentifier(expression) && createRequireLocals.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) && expression.name.text === 'createRequire') ||
    (ts.isElementAccessExpression(expression) &&
      specifierText(unwrapExpression(expression.argumentExpression)) === 'createRequire')
  const aliasesCreateRequireFactory = (init: ts.Expression): boolean => {
    if (isFactoryReference(init)) return true
    if (!ts.isCallExpression(init)) return false
    const callee = unwrapExpression(init.expression)
    return (
      methodName(callee) === 'bind' &&
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      isFactoryReference(unwrapExpression(callee.expression))
    )
  }
  const requireAliases = new Set<string>(['require', ...destructuredRequireLocals])
  let aliasesChanged = true
  while (aliasesChanged) {
    aliasesChanged = false
    for (const { name, initializer } of aliasDeclarations) {
      const init = unwrapExpression(initializer)
      if (!createRequireLocals.has(name) && aliasesCreateRequireFactory(init)) {
        createRequireLocals.add(name)
        aliasesChanged = true
      }
      if (requireAliases.has(name)) continue
      if (
        (ts.isIdentifier(init) && requireAliases.has(init.text)) ||
        isModuleRequireAccess(init) ||
        isCreateRequireCall(init) ||
        isPureLoaderBind(init)
      ) {
        requireAliases.add(name)
        aliasesChanged = true
      }
    }
  }
  // Constantes string resolubles estáticamente, para argumentos de loader
  // no literales (`const packageName = 'minimatch'; require(packageName)`).
  // Solo resuelve un nombre con UNA declaración en el archivo y ningún otro
  // binding (los envenenados de la pasada principal): un duplicado — aunque
  // repita el valor — es ambigüedad de scopes que el análisis léxico no
  // puede arbitrar, y resolver mal suprimiría el rechazo fail-closed de un
  // loader dinámico. Fixpoint por los re-alias (`const b = a`).
  const aliasDeclarationCounts = new Map<string, number>()
  for (const { name } of aliasDeclarations) {
    aliasDeclarationCounts.set(name, (aliasDeclarationCounts.get(name) ?? 0) + 1)
  }
  for (const [name, count] of aliasDeclarationCounts) {
    if (count > 1) poisonedNames.add(name)
  }
  const stringConstants = new Map<string, string>()
  let constantsChanged = true
  while (constantsChanged) {
    constantsChanged = false
    for (const { name, initializer } of aliasDeclarations) {
      if (poisonedNames.has(name) || stringConstants.has(name)) continue
      const init = unwrapExpression(initializer)
      const value =
        specifierText(init) ??
        (ts.isIdentifier(init) && !poisonedNames.has(init.text)
          ? stringConstants.get(init.text)
          : undefined)
      if (value !== undefined) {
        stringConstants.set(name, value)
        constantsChanged = true
      }
    }
  }

  // El objeto módulo que entrega un loader (`require('x')`, `import('x')`
  // dinámico, un alias del loader, `createRequire(...)('x')`) se acota por
  // su CONSUMIDOR estático cuando existe: el parámetro del callback de
  // `.then` de un import dinámico y la variable que recibe el módulo se
  // siguen igual que un namespace import (sus propiedades accedidas se
  // pinnean por nombre; cualquier otro uso degrada a `*` en la segunda
  // pasada), un acceso directo (`require('x').foo`) o un destructuring de
  // propiedades simples pinnean esos nombres, y descartar el valor pinnea
  // la lista vacía (el módulo carga, ninguna API escapa). Sin esto, el hit
  // de los error boundaries (`import('@sentry/nextjs').then((Sentry) =>
  // Sentry.captureException(...))`) quedaba `[*]` — un pin que la política
  // ya aprueba — y cambiar el callback al build-only `withSentryConfig`
  // no producía drift. Cualquier consumo que el análisis no siga (el
  // módulo escapa a una llamada, se exporta, rest/computed en el patrón,
  // encadenados de promesa distintos de `.then(fn)`) sigue siendo `*`:
  // ningún listado de nombres acota qué se usa después. Los specifiers
  // que el escáner textual no puede ver — cualquier llamada vía alias, y un
  // argumento resuelto desde una constante (sin comilla tras `require(`) —
  // se devuelven aparte: el hit debe registrarse desde aquí. Un argumento de
  // loader que NO se pudo acotar estáticamente puede nombrar CUALQUIER
  // paquete: se reporta como no resoluble para que el gate rechace en vez de
  // emitir un veredicto (fail closed). Un template cuyas interpolaciones son
  // TODAS constantes string resolubles se compone y cuenta como un literal.
  // Uno NO resoluble con head relativo (`./`, `../`, `/`) no resuelve a un
  // paquete, pero SÍ puede resolver a un helper local fuera de los roots que
  // importe uno vigilado — y la travesía de módulos locales solo sigue
  // specifiers estáticos: solo queda exento cuando su tail fija una
  // extensión que no es fuente de runtime (`./messages/${l}.json` — un
  // JSON/asset no importa paquetes); el resto se rechaza. Uno con head de
  // paquete visible textualmente (`require(\`minimatch/${x}\`)`) ya lo
  // registra el escáner textual.
  const requireAliasSpecifiers = new Set<string>()
  const contextDirectories = new Set<string>()
  const unresolvedLoaderCalls: string[] = []

  // Sube por los envoltorios transparentes (paréntesis, `as`, `!`,
  // `satisfies`) hacia el nodo cuyo padre decide cómo se consume el valor.
  const walkUpWrappers = (node: ts.Node): ts.Node => {
    let current: ts.Node = node
    while (
      current.parent !== undefined &&
      (ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isNonNullExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent))
    ) {
      current = current.parent
    }
    return current
  }
  // Registra un local que HOLDS el objeto módulo de un specifier para que la
  // segunda pasada pinnee sus propiedades accedidas, con la misma regla de
  // colisión que un namespace import: dos locals homónimos de specifiers
  // distintos no se pueden atribuir → ambos `*`.
  const registerModuleLocal = (local: string, spec: string) => {
    const existing = namespaceLocals.get(local)
    if (existing !== undefined && existing !== spec) {
      add(existing, '*')
      add(spec, '*')
    } else {
      namespaceLocals.set(local, spec)
    }
  }
  type BoundedConsumer = { props: string[]; locals: string[] }
  // Un patrón `{ a, b: c }` acota el módulo a las propiedades nombradas.
  // Rest (`...resto`) captura el resto del módulo y un nombre computado no
  // es estático: ninguno acota → null (el caller degrada a `*`).
  const propsFromObjectPattern = (pattern: ts.ObjectBindingPattern): string[] | null => {
    const props: string[] = []
    for (const element of pattern.elements) {
      if (element.dotDotDotToken !== undefined) return null
      const propertyName = element.propertyName ?? element.name
      if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
        props.push(propertyName.text)
      } else {
        return null
      }
    }
    return props
  }
  // Acota cómo se consume una expresión que EVALÚA al objeto módulo. Solo
  // consumidores que el análisis entiende por completo devuelven un listado;
  // cualquier otro (el módulo pasa a una llamada, se exporta, se guarda en
  // algo que no es una variable simple) devuelve null → `*`, fail closed.
  const boundModuleObject = (expression: ts.Expression): BoundedConsumer | null => {
    const wrapped = walkUpWrappers(expression)
    const parent = wrapped.parent
    if (parent === undefined) return null
    // Valor descartado: el módulo carga por efecto y ninguna API escapa.
    if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) {
      return { props: [], locals: [] }
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === wrapped) {
      return { props: [parent.name.text], locals: [] }
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === wrapped) {
      const property = specifierText(unwrapExpression(parent.argumentExpression))
      return property !== undefined ? { props: [property], locals: [] } : null
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === wrapped) {
      if (ts.isIdentifier(parent.name)) {
        // `export const m = require('x')` publica el objeto módulo fuera
        // del archivo: nada acota qué usa el importador → `*`.
        const statement = parent.parent !== undefined ? parent.parent.parent : undefined
        const isExported =
          statement !== undefined &&
          ts.isVariableStatement(statement) &&
          (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
        if (isExported) return null
        return { props: [], locals: [parent.name.text] }
      }
      if (ts.isObjectBindingPattern(parent.name)) {
        const props = propsFromObjectPattern(parent.name)
        return props !== null ? { props, locals: [] } : null
      }
    }
    return null
  }
  // Acota el consumo de la PROMESA de un `import('x')` dinámico. Solo dos
  // caminos entregan el módulo a un consumidor estático: `await` (y ahí
  // decide boundModuleObject) y `.then(fn)` con un callback literal cuyo
  // primer parámetro recibe el módulo — un identifier se sigue como
  // namespace y un destructuring simple pinnea sus propiedades. El retorno
  // de `.then` es una promesa del RETORNO del callback, no del módulo: si
  // el callback lo devuelve o lo pasa entero, esa referencia de valor del
  // parámetro ya degrada a `*` en la segunda pasada. Cualquier otro
  // encadenado (`.catch`, `.finally`, guardar la promesa) → null → `*`.
  const boundDynamicImport = (call: ts.CallExpression): BoundedConsumer | null => {
    const wrapped = walkUpWrappers(call)
    const parent = wrapped.parent
    if (parent === undefined) return null
    if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) {
      return { props: [], locals: [] }
    }
    if (ts.isAwaitExpression(parent)) return boundModuleObject(parent)
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === wrapped &&
      parent.name.text === 'then' &&
      parent.parent !== undefined &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      parent.parent.arguments.length >= 1
    ) {
      const callback = unwrapExpression(parent.parent.arguments[0])
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return null
      if (callback.parameters.length === 0) return { props: [], locals: [] }
      const first = callback.parameters[0]
      if (first.dotDotDotToken !== undefined) return null
      if (ts.isIdentifier(first.name)) return { props: [], locals: [first.name.text] }
      if (ts.isObjectBindingPattern(first.name)) {
        const props = propsFromObjectPattern(first.name)
        return props !== null ? { props, locals: [] } : null
      }
      return null
    }
    return null
  }

  // Un template cuyas interpolaciones son TODAS constantes string resolubles
  // (`const n = 'x'; import(\`../helpers/${n}.ts\`)`) tiene un specifier
  // acotado estáticamente: se compone y se trata igual que un literal.
  const resolveTemplateSpecifier = (template: ts.TemplateExpression): string | undefined => {
    let resolved = template.head.text
    for (const span of template.templateSpans) {
      const expression = unwrapExpression(span.expression)
      const value =
        specifierText(expression) ??
        (ts.isIdentifier(expression) && !poisonedNames.has(expression.text)
          ? stringConstants.get(expression.text)
          : undefined)
      if (value === undefined) return undefined
      resolved += value + span.literal.text
    }
    return resolved
  }

  // Resuelve un argumento de specifier ya desenvuelto: literal, constante
  // string única del archivo, o template con interpolaciones resolubles.
  const resolveSpecifier = (argument: ts.Expression): string | undefined =>
    specifierText(argument) ??
    (ts.isIdentifier(argument) && !poisonedNames.has(argument.text)
      ? stringConstants.get(argument.text)
      : undefined) ??
    (ts.isTemplateExpression(argument) ? resolveTemplateSpecifier(argument) : undefined)

  for (const call of callSites) {
    const callee = unwrapExpression(call.expression)
    // `loader.bind(...)`, `loader.call(...)` y `loader.apply(...)` entregan
    // el specifier FUERA del primer argumento: el escáner textual no ve
    // comilla tras `require(` y el recorrido normal leería el thisArg. Un
    // bind puro (≤1 argumento) solo liga `this` — el alias resultante y la
    // invocación directa ya se siguen como loader. Un bind parcial
    // (`require.bind(null, 'x')`) pre-liga la carga (ocurre cuando el bound
    // se invoque) y call/apply cargan ya: specifier resoluble → hit `*` (la
    // indirección no deja consumidor estático que acotar), no resoluble →
    // rechazo, nunca veredicto.
    const method = methodName(callee)
    if (
      (method === 'bind' || method === 'call' || method === 'apply') &&
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      isLoaderReference(callee.expression)
    ) {
      if (method === 'bind' && call.arguments.length <= 1) continue
      let specifierArgument: ts.Expression | undefined
      if (method === 'apply') {
        const argsArray =
          call.arguments.length >= 2 ? unwrapExpression(call.arguments[1]) : undefined
        if (
          argsArray !== undefined &&
          ts.isArrayLiteralExpression(argsArray) &&
          argsArray.elements.length > 0 &&
          !ts.isOmittedExpression(argsArray.elements[0]) &&
          !ts.isSpreadElement(argsArray.elements[0])
        ) {
          specifierArgument = argsArray.elements[0]
        }
      } else if (call.arguments.length >= 2) {
        specifierArgument = call.arguments[1]
      }
      const boundSpec =
        specifierArgument === undefined
          ? undefined
          : resolveSpecifier(unwrapExpression(specifierArgument))
      if (boundSpec !== undefined) {
        add(boundSpec, '*')
        requireAliasSpecifiers.add(boundSpec)
      } else {
        const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile))
        unresolvedLoaderCalls.push(
          `\`${call.getText(sourceFile).slice(0, 120)}\` (line ${line + 1})`
        )
      }
      continue
    }
    // `require.context(dir, recursive?, filter?)` registra un contexto de
    // Webpack: el bundle incluye TODOS los módulos del directorio que
    // matcheen el filtro y `ctx(id)` los carga en runtime — sin `require(`
    // textual sobre ningún módulo concreto, el escaneo no vería nada. Un
    // directorio LOCAL resoluble estáticamente se devuelve para que el
    // caller lo recorra completo; cualquier otro primer argumento (no
    // resoluble, o un nombre de paquete cuyo path esconde la identidad)
    // puede alcanzar cualquier módulo: rechazo, nunca veredicto.
    if (
      method === 'context' &&
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      isLoaderReference(callee.expression)
    ) {
      const argument = call.arguments.length > 0 ? unwrapExpression(call.arguments[0]) : undefined
      const contextSpec = argument === undefined ? undefined : resolveSpecifier(argument)
      if (
        contextSpec !== undefined &&
        (contextSpec.startsWith('.') || contextSpec.startsWith('/'))
      ) {
        contextDirectories.add(contextSpec)
      } else {
        const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile))
        unresolvedLoaderCalls.push(
          `\`${call.getText(sourceFile).slice(0, 120)}\` (line ${line + 1})`
        )
      }
      continue
    }
    const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
    const isDynamicImport = call.expression.kind === ts.SyntaxKind.ImportKeyword
    const viaAlias =
      (ts.isIdentifier(callee) && !isRequire && requireAliases.has(callee.text)) ||
      isModuleRequireAccess(callee) ||
      isCreateRequireCall(callee) ||
      isPureLoaderBind(callee)
    if (!isRequire && !isDynamicImport && !viaAlias) continue
    if (call.arguments.length === 0) continue
    const argument = unwrapExpression(call.arguments[0])
    const literal = specifierText(argument)
    const spec = resolveSpecifier(argument)
    if (spec !== undefined) {
      const bounded = isDynamicImport ? boundDynamicImport(call) : boundModuleObject(call)
      if (bounded === null) {
        add(spec, '*')
      } else {
        add(spec, null)
        for (const prop of bounded.props) add(spec, prop)
        for (const local of bounded.locals) registerModuleLocal(local, spec)
      }
      if (viaAlias || literal === undefined) requireAliasSpecifiers.add(spec)
      continue
    }
    if (ts.isTemplateExpression(argument)) {
      const head = argument.head.text
      // Un head que entra por un alias configurado del tsconfig (`~m/...`
      // con `~m/*` -> `./modules/*`, o un mapeo exacto seguido de subpath)
      // es tan local como uno con punto: dejarlo caer a la rama de paquete
      // bare inventaría el paquete ficticio `~m` y el helper cargable por el
      // contexto de Webpack quedaría invisible con el gate en verde.
      const aliasedHead = pathAliases.some((alias) =>
        alias.exact
          ? head === alias.prefix || head.startsWith(`${alias.prefix}/`)
          : head.startsWith(alias.prefix)
      )
      if (head.startsWith('.') || head.startsWith('/') || head.startsWith('@/') || aliasedHead) {
        // Un template relativo no resoluble no nombra un paquete, pero puede
        // resolver a un helper local fuera de los roots que importe uno
        // vigilado (`import(\`../runtime/${name}.ts\`)`) — y la travesía de
        // módulos locales solo sigue specifiers estáticos, así que la carga
        // no se puede acotar. `@/` cuenta como relativo: es el path alias de
        // tsconfig hacia `src/` y NUNCA puede nombrar un paquete npm (un
        // scope vacío no es válido). Solo queda exenta cuando el tail fija
        // una extensión que no es fuente de runtime
        // (`./messages/${l}.json`, `@/messages/${l}.json`): un JSON/asset no
        // importa paquetes. Todo lo demás cae al rechazo.
        const spans = argument.templateSpans
        const tail = spans[spans.length - 1].literal.text
        const extension = /\.[^./\\]+$/.exec(tail)?.[0]
        if (extension !== undefined && !RUNTIME_SOURCE_EXTENSIONS.has(extension.toLowerCase())) {
          continue
        }
      } else if (isRequire || isDynamicImport) {
        // Un template BARE no resoluble puede COMPONER el nombre de un
        // paquete vigilado a través de la interpolación
        // (`require(\`mini${sufijo}\`)` → `minimatch`): el escáner textual
        // exige el nombre completo antes de la primera interpolación, así
        // que el hit quedaría invisible con el gate en verde. Solo cuando el
        // head estático ya contiene el nombre COMPLETO del paquete terminado
        // en `/` (`\`next-intl/${l}\``, `\`@scope/pkg/${x}\``) la identidad
        // del paquete es estática — la interpolación solo varía el subpath —
        // y se registra un hit `*` sobre ese paquete (la carga no se puede
        // acotar más). Todo lo demás cae al rechazo: sus valores posibles
        // pueden nombrar cualquier paquete.
        const packageName = head.startsWith('@')
          ? /^@[^/]+\/[^/]+(?=\/)/.exec(head)?.[0]
          : /^[^/]+(?=\/)/.exec(head)?.[0]
        if (packageName !== undefined) {
          add(packageName, '*')
          requireAliasSpecifiers.add(packageName)
          continue
        }
      }
    }
    const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile))
    unresolvedLoaderCalls.push(`\`${call.getText(sourceFile).slice(0, 120)}\` (line ${line + 1})`)
  }

  // Una referencia está en posición de TIPO cuando algún ancestro es un
  // TypeNode (anotaciones, `as`/`satisfies`, type arguments, `typeof` en un
  // type query), un type alias, una interface, un type parameter, una
  // cláusula `implements` (o el `extends` de una interface — el de una
  // clase es una expresión de VALOR), o un `export type { ... }` local.
  // Todo eso se borra en compilación. Cualquier otro contexto cuenta como
  // uso de valor — la ambigüedad resuelve hacia valor, nunca hacia borrar.
  const isTypePosition = (node: ts.Node): boolean => {
    if (ts.isExportSpecifier(node.parent)) {
      const declaration = node.parent.parent.parent
      return (
        node.parent.isTypeOnly || (ts.isExportDeclaration(declaration) && declaration.isTypeOnly)
      )
    }
    let current: ts.Node | undefined = node.parent
    while (current !== undefined && !ts.isSourceFile(current)) {
      // `isTypeNode` acepta ExpressionWithTypeArguments (el nodo de una
      // cláusula heritage), pero `class A extends B` evalúa B como VALOR:
      // se deja que la HeritageClause de arriba decida.
      if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true
      if (
        ts.isTypeAliasDeclaration(current) ||
        ts.isInterfaceDeclaration(current) ||
        ts.isTypeParameterDeclaration(current)
      ) {
        return true
      }
      if (ts.isHeritageClause(current)) {
        return (
          current.token === ts.SyntaxKind.ImplementsKeyword ||
          ts.isInterfaceDeclaration(current.parent)
        )
      }
      current = current.parent
    }
    return false
  }

  // Un loader (o la fábrica `createRequire`) que ESCAPA del análisis —
  // guardado en una propiedad de objeto (`const loaders = { load: require };
  // loaders.load('minimatch')`), pasado como argumento, re-exportado o
  // asignado a algo que no es una declaración simple — puede cargar
  // CUALQUIER paquete por un camino que el escaneo ya no ve: la llamada
  // posterior no tiene ni `require(` textual ni un alias seguible. Se
  // rechaza con diagnóstico, nunca con un veredicto (fail closed). Las
  // únicas posiciones seguras son las que el análisis SÍ sigue o que no
  // pueden cargar un módulo: callee de una llamada, receptor de un acceso a
  // propiedad/índice (`require.resolve`, `require.cache`, `.bind` — la
  // llamada resultante ya la clasifica el paso de callSites), el
  // initializer de un alias simple (`const r = require`, que el fixpoint
  // rastrea) y `typeof require` (solo observa existencia). Posiciones de
  // NOMBRE (`obj.require`, `{ require: x }`, un local que sombrea) no son
  // referencias al loader; el shorthand `{ require }` SÍ es un uso de
  // valor. El análisis es léxico, sin scopes: un local homónimo puede
  // rechazar de más, nunca de menos.
  const loaderEscapeNames = new Set<string>([...requireAliases, ...createRequireLocals])
  // El VALOR que produce una expresión de loader — el require REAL que
  // devuelve `createRequire(...)` (receptor identifier o `.createRequire`
  // sin acotar) o el MISMO loader que devuelve un bind puro
  // (`require.bind(module)`) — también puede escapar aunque el identifier
  // esté en posición segura de callee/receptor: `const loaders = { load:
  // createRequire(import.meta.url) }; loaders.load('minimatch')` carga la
  // copia hoisted sin `require(` textual ni alias seguible. El resultado
  // solo es seguible consumido donde el análisis ya lo sigue: invocado
  // directamente (callSites lo clasifica), receptor de un acceso a
  // propiedad/índice (`.resolve`; bind parcial y call/apply los clasifica
  // callSites, y un bind PURO encadenado devuelve el mismo loader y se
  // sigue recursivamente), el initializer de una declaración simple (el
  // fixpoint rastrea `isCreateRequireCall`/`isPureLoaderBind`), un valor
  // descartado o `typeof`. Todo lo demás — propiedad de objeto, argumento,
  // export, asignación — es un escape: rechazo, nunca un veredicto.
  const loaderValueEscapes = (value: ts.Node): boolean => {
    const wrapped = walkUpWrappers(value)
    const consumer = wrapped.parent
    if (consumer === undefined) return true
    if (ts.isCallExpression(consumer) && consumer.expression === wrapped) return false
    if (
      (ts.isPropertyAccessExpression(consumer) || ts.isElementAccessExpression(consumer)) &&
      consumer.expression === wrapped
    ) {
      const grand = consumer.parent
      if (
        methodName(consumer) === 'bind' &&
        grand !== undefined &&
        ts.isCallExpression(grand) &&
        grand.expression === consumer &&
        grand.arguments.length <= 1
      ) {
        return loaderValueEscapes(grand)
      }
      if (methodName(consumer) === 'context') {
        // `.context` sobre el loader producido solo es seguible invocado
        // inmediatamente (callSites acota el directorio): guardado como
        // fábrica (`const c = require.bind(m).context`), un contexto
        // posterior queda fuera del análisis — escape.
        const access = walkUpWrappers(consumer)
        const caller = access.parent
        return !(
          caller !== undefined &&
          ts.isCallExpression(caller) &&
          caller.expression === access
        )
      }
      return false
    }
    if (
      ts.isVariableDeclaration(consumer) &&
      consumer.initializer === wrapped &&
      ts.isIdentifier(consumer.name)
    ) {
      return false
    }
    if (
      ts.isExpressionStatement(consumer) ||
      ts.isVoidExpression(consumer) ||
      ts.isTypeOfExpression(consumer)
    ) {
      return false
    }
    return true
  }
  const visitLoaderEscapes = (node: ts.Node) => {
    if (ts.isIdentifier(node) && loaderEscapeNames.has(node.text)) {
      const parent = node.parent
      const isNamePosition =
        parent === undefined ||
        ts.isNamespaceImport(parent) ||
        ts.isImportSpecifier(parent) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node) ||
        (ts.isQualifiedName(parent) && parent.right === node) ||
        ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) &&
          parent.label === node) ||
        (!ts.isShorthandPropertyAssignment(parent) &&
          ts.getNameOfDeclaration(parent as ts.Declaration) === node)
      if (!isNamePosition && !isTypePosition(node)) {
        const wrapped = walkUpWrappers(node)
        const consumer = wrapped.parent
        // Receptor de un acceso a propiedad/índice: seguro (`require.resolve`,
        // `.cache`, `.bind` — la llamada resultante ya la clasifica el paso
        // de callSites), SALVO `.context` sin invocar inmediatamente: `const
        // c = require.context` alía la FÁBRICA de contextos y `c('../dir')`
        // registraría un contexto cuyo directorio el paso de callSites ya no
        // ve — escape, rechazo con diagnóstico.
        let safeMemberAccess = false
        if (
          consumer !== undefined &&
          (ts.isPropertyAccessExpression(consumer) || ts.isElementAccessExpression(consumer)) &&
          consumer.expression === wrapped
        ) {
          if (methodName(consumer) !== 'context') {
            safeMemberAccess = true
          } else {
            const access = walkUpWrappers(consumer)
            const caller = access.parent
            safeMemberAccess =
              caller !== undefined && ts.isCallExpression(caller) && caller.expression === access
          }
        }
        const isSafePosition =
          consumer !== undefined &&
          ((ts.isCallExpression(consumer) && consumer.expression === wrapped) ||
            safeMemberAccess ||
            (ts.isVariableDeclaration(consumer) &&
              consumer.initializer === wrapped &&
              ts.isIdentifier(consumer.name)) ||
            ts.isTypeOfExpression(consumer))
        if (!isSafePosition) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          unresolvedLoaderCalls.push(
            `loader \`${node.text}\` escapes the static analysis (line ${line + 1}): stored or ` +
              `passed outside a simple alias, it can load any package through calls the scan ` +
              `cannot see`
          )
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      (isCreateRequireCall(node) || isPureLoaderBind(node)) &&
      loaderValueEscapes(node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      unresolvedLoaderCalls.push(
        `loader produced by \`${node.getText(sourceFile).slice(0, 80)}\` escapes the static ` +
          `analysis (line ${line + 1}): stored or passed outside a simple alias, it can load ` +
          `any package through calls the scan cannot see`
      )
    }
    ts.forEachChild(node, visitLoaderEscapes)
  }
  visitLoaderEscapes(sourceFile)

  // Segunda pasada: usos de los bindings importados. Para un namespace
  // import, `Ns.prop` (incluye tags JSX `<Ns.Comp/>`) y `Ns['prop']`
  // literal pinnean la propiedad, y cualquier otro uso de valor significa
  // que el objeto namespace escapa entero → `*`. Para los bindings
  // named/default diferidos se registra si cada local tiene referencias y
  // si alguna es de valor. Posiciones de NOMBRE (`obj.Ns`, `{ Ns: x }`) no
  // son referencias; las posiciones de tipo se borran en compilación y no
  // alcanzan runtime. El análisis es léxico, sin scopes: un binding local
  // que sombrea el nombre puede atribuir usos de más (pin más ancho o
  // import conservado de más, nunca al revés).
  if (namespaceLocals.size > 0 || importLocalRefs.size > 0) {
    const visitReferences = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent
        const isReference =
          parent !== undefined &&
          !ts.isNamespaceImport(parent) &&
          !ts.isImportSpecifier(parent) &&
          !(ts.isImportClause(parent) && parent.name === node) &&
          // Posiciones de DECLARACIÓN, no de uso: el parámetro del callback
          // de un `.then` y la variable que recibe el módulo de un loader se
          // registran como locals del módulo — su propio nombre en la
          // declaración no es una referencia que haga escapar el objeto.
          !(ts.isParameter(parent) && parent.name === node) &&
          !(ts.isVariableDeclaration(parent) && parent.name === node) &&
          !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
          !(ts.isPropertyAssignment(parent) && parent.name === node) &&
          !(ts.isBindingElement(parent) && parent.propertyName === node) &&
          !(ts.isQualifiedName(parent) && parent.right === node)
        if (isReference) {
          const namespaceSpec = namespaceLocals.get(node.text)
          if (namespaceSpec !== undefined && !isTypePosition(node)) {
            if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
              add(namespaceSpec, parent.name.text)
            } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
              const property = specifierText(parent.argumentExpression)
              add(namespaceSpec, property ?? '*')
            } else {
              add(namespaceSpec, '*')
            }
          }
          const info = importLocalRefs.get(node.text)
          if (info !== undefined) {
            info.seen = true
            if (!isTypePosition(node)) info.valueUse = true
          }
        }
      }
      ts.forEachChild(node, visitReferences)
    }
    visitReferences(sourceFile)
  }

  // Resolver las declaraciones diferidas binding por binding: un binding con
  // al menos una referencia y todas en posición de tipo NO se emite (el
  // compilador lo elide del import clause), así que no se pinnea — pinnearlo
  // convertiría un tipo ordinario en "API de runtime" y agregar o quitar un
  // type-only en un import mixto rompería el gate en falso. Un binding sin
  // referencias se conserva (fail closed: la elisión del import no usado
  // depende del transpiler). Solo cuando TODOS los bindings se borran, la
  // declaración entera se elide y el módulo nunca se carga.
  const erasedImports: Array<{ pos: number; end: number }> = [...erasedTypeExpressions]
  for (const candidate of candidates) {
    const emittedNames: string[] = []
    for (let i = 0; i < candidate.locals.length; i++) {
      const info = importLocalRefs.get(candidate.locals[i]) as {
        seen: boolean
        valueUse: boolean
      }
      const bindingErased = info.seen && !info.valueUse
      if (!bindingErased) emittedNames.push(candidate.exportedNames[i])
    }
    if (emittedNames.length === 0) {
      erasedImports.push({ pos: candidate.node.getStart(sourceFile), end: candidate.node.end })
    } else {
      add(candidate.spec, null)
      for (const name of emittedNames) add(candidate.spec, name)
    }
  }
  return {
    bindings,
    erasedImports,
    requireAliasSpecifiers,
    contextDirectories: [...contextDirectories].sort(),
    unresolvedLoaderCalls,
  }
}

/**
 * Un import directo en el código de runtime no toca bun.lock (la copia ya
 * está hoisted y ESLint no exige dependencias declaradas), así que ni las
 * claves ni las aristas del lockfile lo delatan. Escanear los imports es la
 * evidencia que falta: si src/ o convex/ importan un paquete exceptuado, la
 * excepción build-only dejó de describir la realidad.
 */
export function scanRuntimeImports(
  sourceRoot: string,
  packageNames: string[]
): Record<string, string[]> {
  const patterns = packageNames.map((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Los tres delimitadores de specifier cuentan: comillas simples, dobles y
    // backticks. `import(\`minimatch\`)` o `require(\`minimatch\`)` con un
    // template literal estático cargan el paquete igual que con comillas;
    // aceptar solo ' y " los dejaría invisibles. Cada delimitador excluye
    // solo su propio cierre para que un template interpolado tras el nombre
    // (`minimatch/${x}`, que puede contener comillas dentro de `${}`) también
    // cuente: sigue siendo un import de runtime del paquete. La llamada
    // opcional `require?.('minimatch')` es sintaxis válida que carga el
    // paquete igual que `require(...)`: el `?.` opcional entre `require` y
    // `(` también cuenta.
    const subpath = (closer: string) => String.raw`${escaped}(?:/[^${closer}]*)?`
    return [
      name,
      new RegExp(
        String.raw`(?:\bfrom|\brequire\s*(?:\?\.\s*)?\(|\bimport\s*\(?)\s*` +
          String.raw`(?:'(${subpath(String.raw`'\n`)})'|"(${subpath(String.raw`"\n`)})"|` +
          '`' +
          `(${subpath('`')})` +
          '`)',
        'g'
      ),
    ] as const
  })

  // Cada hit conserva el sitio, el specifier completo Y los bindings
  // importados ("archivo -> subpath [bindings]"): colapsarlo al nombre del
  // paquete dejaría pasar un subpath nuevo de un ancestro ya revisado
  // (`next-intl/otra-cosa`) o un sitio de import nuevo, y colapsar los
  // bindings dejaría pasar un binding build-only nuevo del mismo sitio
  // (`withSentryConfig` junto al `captureException` revisado) — todos pueden
  // exponer el camino transitivo vulnerable.
  const hits: Record<string, string[]> = {}
  // Cargas cuyo specifier no se pudo acotar estáticamente: el gate no puede
  // emitir un veredicto sobre ellas (ver abajo).
  const unresolvedLoads: string[] = []
  // Un specifier es LOCAL cuando es relativo o entra por un path alias
  // configurado (comodín por prefijo, exacto por igualdad): todos resuelven
  // a un archivo del árbol, nunca a un paquete npm, y la travesía debe
  // seguirlos igual.
  const pathAliases = loadPathAliases(sourceRoot)
  // Specifiers `#` (subpath imports de package.json): Node los resuelve
  // ejecutando el target del mapeo, así que el escaneo debe seguirlos — un
  // target local se recorre como cualquier arista local, uno de paquete
  // registra el hit contra el nombre vigilado, y un specifier sin mapeo
  // acotable no se puede atribuir: rechazo con diagnóstico, nunca un
  // veredicto. Un target local que no resuelve a fuente de runtime
  // (css/json/assets) no puede importar paquetes, igual que un relativo.
  const importsAliases = loadImportsAliases(sourceRoot)
  type HashResolution = { locals: string[]; packages: string[]; failures: string[] }
  const hashResolutionCache = new Map<string, HashResolution>()
  const resolveHashSpecifier = (specifier: string): HashResolution => {
    const cached = hashResolutionCache.get(specifier)
    if (cached !== undefined) return cached
    const resolution: HashResolution = { locals: [], packages: [], failures: [] }
    const match = matchImportsAlias(importsAliases, specifier)
    if (match === undefined) {
      resolution.failures.push(
        'has no `imports` mapping in package.json; the gate cannot bound what it loads'
      )
    } else if (match.alias.unbounded) {
      resolution.failures.push(
        'has an `imports` mapping in package.json that the gate cannot bound statically'
      )
    } else {
      for (const rawTarget of match.alias.targets) {
        const target = match.alias.wildcard ? rawTarget.replaceAll('*', match.matched) : rawTarget
        if (target.startsWith('#')) {
          // Node no encadena mapeos `#` dentro de un target: no hay forma
          // estática de acotar lo que cargaría.
          resolution.failures.push(
            `has an \`imports\` target (\`${target}\`) that is itself a \`#\` specifier ` +
              'the gate cannot bound'
          )
        } else if (target.startsWith('.')) {
          const resolved = resolveLocalModule(sourceRoot, target)
          if (resolved !== undefined) resolution.locals.push(resolved)
        } else {
          resolution.packages.push(target)
        }
      }
    }
    hashResolutionCache.set(specifier, resolution)
    return resolution
  }
  const aliasMatches = (alias: PathAlias, specifier: string): boolean =>
    alias.exact ? specifier === alias.prefix : specifier.startsWith(alias.prefix)
  const isLocalSpecifier = (specifier: string): boolean =>
    specifier.startsWith('.') || pathAliases.some((alias) => aliasMatches(alias, specifier))
  const resolveLocalSpecifier = (fromDir: string, specifier: string): string | undefined => {
    if (specifier.startsWith('.')) return resolveLocalModule(fromDir, specifier)
    for (const alias of pathAliases) {
      if (!aliasMatches(alias, specifier)) continue
      if (alias.exact) {
        for (const target of alias.targets) {
          const resolved = resolveLocalModule(path.dirname(target), `./${path.basename(target)}`)
          if (resolved !== undefined) return resolved
        }
        return undefined
      }
      const rest = specifier.slice(alias.prefix.length)
      for (const targetDir of alias.targets) {
        const resolved = resolveLocalModule(targetDir, `./${rest}`)
        if (resolved !== undefined) return resolved
      }
      // El match más específico gana (como TypeScript): un alias que matchea
      // pero no resuelve no cae a otro más corto.
      return undefined
    }
    return undefined
  }
  // Cada archivo se escanea UNA vez aunque llegue por varias aristas (raíz,
  // recorrido de directorios, o travesía de imports relativos con ciclos).
  const scannedFiles = new Set<string>()
  const scanFile = (filePath: string) => {
    const resolvedPath = path.resolve(filePath)
    if (scannedFiles.has(resolvedPath)) return
    scannedFiles.add(resolvedPath)
    // Los archivos de declaraciones no cargan nada en runtime: el guard
    // vive aquí para cubrir todas las aristas (walk de roots, entrypoints
    // de raíz y travesía de módulos locales) por igual.
    if (DECLARATION_FILE_PATTERN.test(resolvedPath)) return
    // La identidad del pin ("archivo -> specifier [bindings]") se compara
    // literalmente contra la política committeada, que usa `/`: normalizar
    // el separador o el MISMO árbol produciría pins distintos por plataforma
    // (en Windows `path.relative` emite `\`) — drift falso en un lado y una
    // política regenerada allí rompería el gate de Linux en CI.
    const relative = path.relative(sourceRoot, resolvedPath).split(path.sep).join('/')
    const raw = readFileSync(resolvedPath, 'utf8')
    const analysis = collectImportBindings(raw, filePath, pathAliases)
    if (analysis !== null) {
      for (const call of analysis.unresolvedLoaderCalls) {
        unresolvedLoads.push(`${relative}: ${call}`)
      }
    }
    // Las declaraciones de import de valor usadas SOLO en posiciones de
    // tipo se eliden completas en compilación (igual que `import type`), y
    // las expresiones de tipo `import('x')` (ImportTypeNode) se borran
    // siempre: se blanquean antes del escaneo para que no registren un hit
    // de un módulo que nunca se carga en runtime.
    let scanSource = raw
    if (analysis !== null && analysis.erasedImports.length > 0) {
      const chars = raw.split('')
      for (const span of analysis.erasedImports) {
        for (let i = span.pos; i < span.end; i++) {
          if (chars[i] !== '\n') chars[i] = ' '
        }
      }
      scanSource = chars.join('')
    }
    // Los comentarios no importan nada: `// import x from 'minimatch'` es
    // documentación, no reachability. Los imports type-only tampoco: se
    // borran en compilación y nunca cargan el módulo — pero en un archivo
    // que parsea ya vienen blanqueados por rangos de NODO del parser
    // (`erasedImports`, arriba). El regex textual queda SOLO para el
    // fallback sin parse: aplicado sobre código parseable puede arrancar
    // dentro de un string (`"import type Foo from " + require('minimatch')`),
    // tomar su comilla de cierre como apertura del specifier y blanquear un
    // require real — falso negativo del gate requerido.
    const stripped = stripCommentsWithParser(scanSource, filePath)
    const content = analysis === null ? stripTypeOnlyImports(stripped) : stripped
    // Specifiers `#` del archivo (subpath imports de package.json): del
    // parser cuando el archivo parsea, con el fallback textual si no. Cada
    // uno se resuelve contra los mapeos de `imports`: los targets locales se
    // recorren, los de paquete registran hits, y los no acotables rechazan.
    const hashSpecifiers = new Set<string>()
    if (analysis !== null) {
      for (const specifier of analysis.bindings.keys()) {
        if (specifier.startsWith('#')) hashSpecifiers.add(specifier)
      }
      for (const specifier of analysis.requireAliasSpecifiers) {
        if (specifier.startsWith('#')) hashSpecifiers.add(specifier)
      }
    } else {
      for (const match of content.matchAll(LOCAL_IMPORT_FALLBACK_PATTERN)) {
        const specifier = match[1] ?? match[2] ?? match[3]
        if (specifier !== undefined && specifier.startsWith('#')) hashSpecifiers.add(specifier)
      }
    }
    // Target de paquete resuelto -> specifier `#` de origen (para heredar
    // sus bindings), o null cuando dos orígenes colisionan en el mismo
    // paquete: ninguna lista única acota → `*` (fail closed).
    const hashPackageOrigins = new Map<string, string | null>()
    const hashLocalTargets = new Set<string>()
    for (const specifier of [...hashSpecifiers].sort()) {
      const resolution = resolveHashSpecifier(specifier)
      for (const failure of resolution.failures) {
        unresolvedLoads.push(`${relative}: import \`${specifier}\` ${failure}`)
      }
      for (const target of resolution.locals) hashLocalTargets.add(target)
      for (const packageSpecifier of resolution.packages) {
        const existing = hashPackageOrigins.get(packageSpecifier)
        hashPackageOrigins.set(
          packageSpecifier,
          existing === undefined || existing === specifier ? specifier : null
        )
      }
    }
    // Un hit sin evidencia estática de bindings — archivo que no parsea, un
    // specifier que solo aparece via require/import dinámico no literal, o
    // el falso positivo conservador de un import dentro de un string — se
    // pinnea como acceso al módulo completo. Fail closed: nunca un listado
    // que acote menos de lo que el código puede usar.
    const bindingsFor = (specifier: string): string => {
      let set = analysis?.bindings.get(specifier)
      if (hashPackageOrigins.has(specifier)) {
        const origin = hashPackageOrigins.get(specifier)
        // Orígenes `#` colisionando en el mismo paquete, o el paquete además
        // importado directo en el archivo: ninguna lista única acota.
        if (origin === null || origin === undefined || set !== undefined) return '*'
        set = analysis?.bindings.get(origin)
      }
      if (set === undefined) return '*'
      if (set.has('*')) return '*'
      return [...set].sort().join(', ')
    }
    for (const [name, pattern] of patterns) {
      const specifiers = new Set<string>()
      for (const match of content.matchAll(pattern)) {
        // Un solo grupo queda definido por match: el del delimitador usado.
        const specifier = match[1] ?? match[2] ?? match[3]
        if (specifier !== undefined) specifiers.add(specifier)
      }
      // Cargas vía alias de require (`const localRequire = createRequire(...);
      // localRequire('minimatch')`): el escaneo textual no ve ni `from`, ni
      // `require`, ni `import`, así que estos hits solo existen en la
      // evidencia del parser. Sin fusionarlos, un paquete hoisted
      // High/Critical se volvería runtime-reachable con el gate en verde.
      if (analysis !== null) {
        for (const specifier of analysis.requireAliasSpecifiers) {
          if (specifier === name || specifier.startsWith(`${name}/`)) {
            specifiers.add(specifier)
          }
        }
      }
      // Cargas vía mapeo `#` de package.json cuyo target es un paquete: el
      // texto solo muestra `#glob`, nunca `minimatch` — el hit solo existe
      // en la resolución del mapeo. Sin fusionarlo, un paquete hoisted
      // High/Critical sería runtime-reachable con el gate en verde.
      for (const resolved of hashPackageOrigins.keys()) {
        if (resolved === name || resolved.startsWith(`${name}/`)) specifiers.add(resolved)
      }
      for (const specifier of [...specifiers].sort()) {
        ;(hits[name] ??= []).push(`${relative} -> ${specifier} [${bindingsFor(specifier)}]`)
      }
    }
    // Travesía de módulos LOCALES: un import relativo a un helper fuera de
    // src/, convex/ y los entrypoints de raíz (`src/entry.ts ->
    // ../runtime-helper.ts`) empaqueta el helper en el runtime igualmente —
    // sin seguir la arista, un import de paquete vigilado dentro del helper
    // quedaría invisible con el gate en verde. Se siguen los specifiers
    // locales estáticos — relativos Y vía path alias configurado
    // (`@/../runtime-helper.ts` resuelve al mismo helper que
    // `../runtime-helper.ts`) — del parser cuando el archivo parsea, con
    // fallback textual si no, y resolución de bundler. Un specifier local
    // nunca resuelve a un paquete, así que uno que no resuelve a un archivo
    // local escaneable (css, json, assets) no puede ocultar un import
    // vigilado.
    const localSpecifiers = new Set<string>()
    if (analysis !== null) {
      for (const specifier of analysis.bindings.keys()) {
        if (isLocalSpecifier(specifier)) localSpecifiers.add(specifier)
      }
      for (const specifier of analysis.requireAliasSpecifiers) {
        if (isLocalSpecifier(specifier)) localSpecifiers.add(specifier)
      }
    } else {
      for (const match of content.matchAll(LOCAL_IMPORT_FALLBACK_PATTERN)) {
        const specifier = match[1] ?? match[2] ?? match[3]
        if (specifier !== undefined && isLocalSpecifier(specifier)) {
          localSpecifiers.add(specifier)
        }
      }
    }
    for (const specifier of [...localSpecifiers].sort()) {
      const target = resolveLocalSpecifier(path.dirname(resolvedPath), specifier)
      if (target === undefined) continue
      // Las exclusiones de directorio aplican solo al DESCUBRIMIENTO inicial
      // (el walk de los roots): un import relativo EXPLÍCITO hacia un
      // segmento excluido (`src/x.ts -> ./__tests__/helper.ts`,
      // `./_generated/server`) se empaqueta en el runtime igualmente — sin
      // seguir la arista, un import vigilado dentro del helper quedaría
      // invisible con el gate en verde. La única excepción es node_modules:
      // un path relativo hacia dentro de un paquete instalado esconde la
      // identidad del paquete en el path (los hits se atribuyen por
      // specifier de paquete), así que la carga no se puede atribuir —
      // rechazo con diagnóstico, nunca un veredicto.
      if (path.relative(sourceRoot, target).split(path.sep).includes('node_modules')) {
        unresolvedLoads.push(
          `${relative}: local import \`${specifier}\` resolves into node_modules; ` +
            `the gate attributes hits by package specifier and cannot bound a package ` +
            `loaded through a local path`
        )
        continue
      }
      scanFile(target)
    }
    // Targets LOCALES de mapeos `#`: el mapeo empaqueta el archivo en el
    // runtime igual que un import relativo, así que la travesía debe
    // seguirlo — con la misma excepción fail-closed para node_modules (un
    // path local esconde la identidad del paquete).
    for (const target of [...hashLocalTargets].sort()) {
      if (path.relative(sourceRoot, target).split(path.sep).includes('node_modules')) {
        unresolvedLoads.push(
          `${relative}: a package.json \`imports\` target resolves into node_modules; ` +
            `the gate attributes hits by package specifier and cannot bound a package ` +
            `loaded through a local path`
        )
        continue
      }
      scanFile(target)
    }
    // Contextos de Webpack (`require.context('../runtime', ...)`): el bundle
    // incluye TODOS los módulos del directorio que matcheen el filtro, así
    // que cada fuente de runtime del directorio se escanea — una
    // sobre-aproximación deliberada que ignora el flag `recursive` y el
    // regex del filtro (bloquea de más, nunca de menos). Un contexto que
    // resuelve dentro de node_modules — o que alcanza un node_modules
    // anidado — esconde la identidad del paquete en el path: rechazo con
    // diagnóstico, nunca un veredicto. Un directorio inexistente no puede
    // cargar nada (Webpack fallaría el build) y se omite.
    if (analysis !== null) {
      for (const specifier of analysis.contextDirectories) {
        const contextDir = path.resolve(path.dirname(resolvedPath), specifier)
        if (path.relative(sourceRoot, contextDir).split(path.sep).includes('node_modules')) {
          unresolvedLoads.push(
            `${relative}: \`require.context('${specifier}', ...)\` resolves into ` +
              `node_modules; the gate attributes hits by package specifier and cannot ` +
              `bound a package loaded through a local path`
          )
          continue
        }
        if (!existsSync(contextDir) || !statSync(contextDir).isDirectory()) continue
        for (const dirent of readdirSync(contextDir, { recursive: true, withFileTypes: true })) {
          if (!dirent.isFile()) continue
          if (!RUNTIME_SOURCE_EXTENSIONS.has(path.extname(dirent.name))) continue
          const contextFile = path.join(dirent.parentPath, dirent.name)
          if (path.relative(sourceRoot, contextFile).split(path.sep).includes('node_modules')) {
            unresolvedLoads.push(
              `${relative}: \`require.context('${specifier}', ...)\` reaches into ` +
                `node_modules; the gate attributes hits by package specifier and cannot ` +
                `bound a package loaded through a local path`
            )
            continue
          }
          scanFile(contextFile)
        }
      }
    }
  }

  for (const dirent of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!dirent.isFile()) continue
    if (!RUNTIME_ROOT_ENTRYPOINTS.test(dirent.name)) continue
    if (!RUNTIME_SOURCE_EXTENSIONS.has(path.extname(dirent.name))) continue
    scanFile(path.join(sourceRoot, dirent.name))
  }

  for (const dir of RUNTIME_SOURCE_DIRS) {
    const root = path.join(sourceRoot, dir)
    if (!existsSync(root)) continue
    for (const dirent of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!dirent.isFile()) continue
      if (!RUNTIME_SOURCE_EXTENSIONS.has(path.extname(dirent.name))) continue
      const filePath = path.join(dirent.parentPath, dirent.name)
      const relative = path.relative(sourceRoot, filePath)
      if (relative.split(path.sep).some((segment) => RUNTIME_SCAN_SKIP_SEGMENTS.has(segment))) {
        continue
      }
      scanFile(filePath)
    }
  }
  // Un loader con argumento no resoluble estáticamente (`require(variable)`
  // donde la variable no es una constante string única del archivo,
  // `import(expresión)`, un template interpolado sin head de paquete —
  // incluido uno relativo hacia módulos de runtime, que la travesía local
  // no puede seguir) puede cargar CUALQUIER módulo, incluido un camino
  // hacia un paquete vigilado: ni el escáner textual ni el parser pueden
  // acotarlo, así que el gate no puede pasar por un camino que no entendió
  // — se rechaza con diagnóstico, nunca con un veredicto (mismo contrato
  // fail-closed que el audit).
  if (unresolvedLoads.length > 0) {
    throw new AuditUnavailableError(
      `Runtime import scan found module loads whose specifier cannot be resolved ` +
        `statically; the gate cannot bound what they load. Rewrite them with a ` +
        `static specifier: ${unresolvedLoads.join('; ')}`
    )
  }
  return hits
}

function markdownEscape(value: string): string {
  return value.replace(/\|/g, '\\|')
}

type Finding = {
  packageName: string
  severity: Severity
  classification: Classification | 'untriaged' | `expired:${Classification}`
  decision: 'block' | 'allow'
  rationale: string
  reviewBy: string
  owner: string
  advisories: string[]
}

export function selectFindings(
  payload: BunAuditPayload,
  policy: PolicyFile,
  today: string,
  lockfile: ParsedLockfile,
  runtimeImports: Record<string, string[]> = {}
): Finding[] {
  validatePolicy(policy)
  return Object.entries(payload)
    .map(([packageName, advisories]) => {
      const blocking = advisories.filter((advisory) =>
        HIGH_OR_CRITICAL.includes(advisory.severity as Severity)
      )
      if (blocking.length === 0) return undefined

      const severity: Severity = blocking.some((advisory) => advisory.severity === 'critical')
        ? 'critical'
        : 'high'
      const rule = policy.rules[packageName]
      const expired = rule ? isRuleExpired(rule, today) : false

      // Una regla solo cubre los avisos que lista (por URL o id), y solo
      // mientras cada aviso siga describiendo el rango revisado. Un aviso
      // nuevo NO hereda la excepción vieja, y un GHSA enmendado (misma URL,
      // `vulnerable_versions` distinto) tampoco: puede haber pasado a cubrir
      // una copia instalada que el triaje declaró fuera de rango, sin que el
      // lockfile cambie. El rationale justifica un contenido concreto del
      // aviso, no su URL para siempre.
      const covered = rule?.advisories ?? {}
      const reviewedRange = (advisory: BunAdvisory): string | undefined => {
        if (advisory.url !== undefined && Object.hasOwn(covered, advisory.url)) {
          return covered[advisory.url]
        }
        const idKey = advisoryIdText(advisory.id)
        if (idKey !== undefined && Object.hasOwn(covered, idKey)) {
          return covered[idKey]
        }
        return undefined
      }
      const uncovered = blocking.filter(
        (advisory) => reviewedRange(advisory) !== (advisory.vulnerable_versions ?? '')
      )
      const hasUncovered = rule !== undefined && !expired && uncovered.length > 0

      // La excepción está atada a las copias revisadas (clave de bun.lock →
      // versión). Una copia nueva del paquete (p.ej. una runtime dependency
      // que trae la misma versión vulnerable por otro camino) o un cambio de
      // versión de una copia pinneada no hereda el rationale viejo.
      const pinnedEntries = rule?.lockEntries ?? {}
      const observedEntries = lockfile.packages[packageName] ?? {}
      const driftedEntries = Object.entries(observedEntries)
        .filter(([lockKey, version]) => pinnedEntries[lockKey] !== version)
        .map(([lockKey, version]) => `${lockKey}@${version}`)
      if (Object.keys(observedEntries).length === 0) {
        // El audit reporta el paquete pero no encontramos su copia en el
        // lockfile: no podemos verificar el camino revisado. Fail closed.
        driftedEntries.push('(package not found in bun.lock)')
      }
      // Y a las aristas revisadas — el cierre transitivo, no solo las
      // directas: un consumidor nuevo que reutiliza la copia hoisted no
      // cambia clave ni versión, y una arista nueva hacia un intermediario
      // (`runtime-framework -> glob -> minimatch`) ni siquiera toca las
      // aristas directas del paquete, pero ambas cambian la reachability.
      const pinnedConsumers = new Set(rule?.consumers ?? [])
      for (const consumer of transitiveConsumers(lockfile, packageName)) {
        if (!pinnedConsumers.has(consumer)) driftedEntries.push(`consumer:${consumer}`)
      }
      const hasLockDrift = rule !== undefined && !expired && driftedEntries.length > 0

      // Un import directo en runtime no pasa por el lockfile — ni del paquete
      // ni de un ancestro de su cierre revisado: importar `@parcel/watcher`
      // vuelve runtime el camino build-only hacia picomatch sin tocar bun.lock
      // ni el grafo pinneado. Y la comparación es hit por hit ("archivo ->
      // specifier [bindings]"), no por nombre: un subpath nuevo de un
      // ancestro ya revisado, un sitio de import nuevo o un binding nuevo
      // del mismo sitio (un archivo aprobado que empieza a importar el
      // build-only `withSentryConfig` de un specifier ya revisado) también
      // exigen re-triaje.
      const pinnedImports = rule?.runtimeImports ?? {}
      const runtimeHits: string[] = []
      for (const watched of watchedImportNames(lockfile, packageName)) {
        const observed = runtimeImports[watched] ?? []
        const reviewed = new Set(pinnedImports[watched] ?? [])
        const drift = observed.filter((hit) => !reviewed.has(hit))
        if (drift.length > 0) runtimeHits.push(`${watched}: ${drift.join(', ')}`)
      }
      const hasRuntimeImport = rule !== undefined && !expired && runtimeHits.length > 0

      let classification: Finding['classification']
      if (!rule || hasUncovered || hasLockDrift || hasRuntimeImport) classification = 'untriaged'
      else if (expired) classification = `expired:${rule.classification}`
      else classification = rule.classification

      // Bloquea si: no hay regla, la regla venció, hay avisos que la regla no
      // lista, el árbol tiene copias/aristas no revisadas del paquete, el
      // código de runtime lo importa directamente, o el paquete está declarado
      // alcanzable en runtime (o sin clasificar).
      const isBlocking =
        !rule ||
        expired ||
        hasUncovered ||
        hasLockDrift ||
        hasRuntimeImport ||
        rule.classification === 'runtime_reachable' ||
        rule.classification === 'unknown'

      let rationale: string
      if (hasUncovered) {
        rationale =
          `Advisory not covered by the existing reachability rule (new advisory or ` +
          `amended vulnerable range; re-triage): ${uncovered
            .map(
              (advisory) =>
                `${advisory.url ?? advisoryIdText(advisory.id) ?? 'unknown'} ` +
                `(${advisory.vulnerable_versions ?? 'no range'})`
            )
            .join(', ')}`
      } else if (hasLockDrift) {
        rationale =
          `Lockfile copy or dependency edge not covered by the existing reachability ` +
          `rule (re-triage the dependency path): ${driftedEntries.join(', ')}`
      } else if (hasRuntimeImport) {
        rationale =
          `Runtime source imports this package or a reviewed dependency ancestor ` +
          `(re-triage reachability): ` +
          runtimeHits.join(', ')
      } else {
        rationale = rule?.rationale ?? 'No reachability rule found for this package.'
      }

      return {
        packageName,
        severity,
        classification,
        decision: isBlocking ? ('block' as const) : ('allow' as const),
        rationale,
        reviewBy: rule?.reviewBy ?? 'REQUIRED',
        owner: rule?.owner ?? 'REQUIRED',
        advisories: blocking
          .map((advisory) => advisory.url)
          .filter((url): url is string => Boolean(url)),
      }
    })
    .filter((finding): finding is Finding => finding !== undefined)
    .sort((a, b) => a.packageName.localeCompare(b.packageName))
}

function countBySeverity(payload: BunAuditPayload): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const advisories of Object.values(payload)) {
    for (const advisory of advisories) {
      counts[advisory.severity] = (counts[advisory.severity] ?? 0) + 1
    }
  }
  return counts
}

function buildMatrixMarkdown(params: {
  generatedOn: string
  gateResult: 'PASS' | 'FAIL'
  findings: Finding[]
}): string {
  const lines: string[] = []
  lines.push('# Dependency Reachability Matrix')
  lines.push('')
  lines.push(`Generated on: ${params.generatedOn}`)
  lines.push(`Gate result: **${params.gateResult}**`)
  lines.push('')
  lines.push(
    '| Package | Severity | Classification | Decision | Review By | Owner | Rationale | Advisories |'
  )
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const finding of params.findings) {
    lines.push(
      `| ${markdownEscape(finding.packageName)} | ${finding.severity.toUpperCase()} | ${finding.classification} | ${finding.decision.toUpperCase()} | ${finding.reviewBy} | ${finding.owner} | ${markdownEscape(finding.rationale)} | ${finding.advisories.map((link) => `[link](${link})`).join(', ') || '-'} |`
    )
  }
  lines.push('')
  lines.push('Policy source: `docs/security/dependency-reachability-policy.json`')
  lines.push('Command: `bun run security:audit:reachable`')
  return lines.join('\n')
}

function sameMatrixExceptDate(a: string, b: string): boolean {
  const strip = (text: string) =>
    text
      .split('\n')
      .filter((line) => !line.startsWith('Generated on: '))
      .join('\n')
  return strip(a) === strip(b)
}

const pathExists = Effect.fn('securityAudit.pathExists')(function* (
  target: string
): Effect.fn.Return<boolean> {
  return yield* Effect.tryPromise(() => stat(target)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )
})

const findLockfile = Effect.fn('securityAudit.findLockfile')(function* (
  startDir: string
): Effect.fn.Return<string, AuditGateError> {
  // El mismo walk-up que hace `bun audit`: el lockfile del workspace vive en
  // la raíz del repo, no en app/. Sin lockfile no hay camino verificable.
  let dir = startDir
  for (;;) {
    const candidate = path.join(dir, 'bun.lock')
    if (yield* pathExists(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) {
      return yield* Effect.fail(unavailable(`No bun.lock found walking up from ${startDir}.`))
    }
    dir = parent
  }
})

const readTextFile = Effect.fn('securityAudit.readTextFile')(function* (
  file: string
): Effect.fn.Return<string, AuditGateError> {
  return yield* Effect.tryPromise({
    try: () => readFile(file, 'utf8'),
    catch: gateError,
  })
})

/** La matriz se escribe con el descriptor cerrado por scope. */
const writeMatrix = Effect.fn('securityAudit.writeMatrix')(function* (
  outputPath: string,
  body: string
): Effect.fn.Return<void, AuditGateError> {
  yield* Effect.tryPromise({
    try: () => mkdir(path.dirname(outputPath), { recursive: true }),
    catch: gateError,
  })
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => open(outputPath, 'w'), catch: gateError }),
        (file) => Effect.promise(() => file.close())
      )
      yield* Effect.tryPromise({
        try: () => handle.writeFile(body, 'utf8'),
        catch: gateError,
      })
    })
  )
})

const main = Effect.fn('securityAudit.main')(function* (): Effect.fn.Return<
  number,
  AuditGateError
> {
  const appRoot = process.cwd()
  const docsSecurityDir = path.resolve(appRoot, '../docs/security')
  const policyPath =
    process.env.SECURITY_REACHABILITY_POLICY ||
    path.join(docsSecurityDir, 'dependency-reachability-policy.json')
  const outputPath =
    process.env.SECURITY_REACHABILITY_MATRIX_OUT ||
    path.join(docsSecurityDir, 'dependency-reachability-matrix-latest.md')
  const lockfilePath = process.env.SECURITY_REACHABILITY_LOCKFILE || (yield* findLockfile(appRoot))

  const today = new Date().toISOString().slice(0, 10)
  const sourceRoot = process.env.SECURITY_REACHABILITY_SOURCE_ROOT || appRoot

  const policyRaw = yield* readTextFile(policyPath)
  const policy = yield* Effect.try({ try: () => loadPolicy(policyRaw), catch: gateError })
  const lockfileRaw = yield* readTextFile(lockfilePath)
  const lockfile = yield* Effect.try({ try: () => parseLockfile(lockfileRaw), catch: gateError })
  // Vigilar también los ancestros revisados de cada paquete: importar un
  // intermediario ya hoisted vuelve runtime el camino sin tocar bun.lock.
  const watchedNames = new Set<string>()
  for (const packageName of Object.keys(policy.rules)) {
    for (const name of watchedImportNames(lockfile, packageName)) watchedNames.add(name)
  }
  const runtimeImports = yield* Effect.try({
    try: () => scanRuntimeImports(sourceRoot, [...watchedNames].sort()),
    catch: gateError,
  })
  const auditOutput = yield* runBunAudit()
  const payload = yield* Effect.try({
    try: () => parseAuditPayload(auditOutput),
    catch: gateError,
  })
  const findings = yield* Effect.try({
    try: () => selectFindings(payload, policy, today, lockfile, runtimeImports),
    catch: gateError,
  })

  const blocking = findings.filter((finding) => finding.decision === 'block')
  const gateResult: 'PASS' | 'FAIL' = blocking.length > 0 ? 'FAIL' : 'PASS'

  // Si solo cambia la fecha, el archivo commiteado se queda: el gate exige un
  // árbol limpio entre pasos y esta escritura corre en «Install dependencies».
  const nextMatrix = buildMatrixMarkdown({ generatedOn: today, gateResult, findings })
  const previousMatrix = (yield* pathExists(outputPath))
    ? yield* readTextFile(outputPath)
    : undefined
  if (previousMatrix === undefined || !sameMatrixExceptDate(previousMatrix, nextMatrix)) {
    yield* writeMatrix(outputPath, nextMatrix)
  }

  console.log('Security audit summary:', JSON.stringify(countBySeverity(payload)))
  console.log(`Packages with High/Critical advisories: ${findings.length}`)
  console.log(`Reachability matrix written to: ${outputPath}`)

  if (blocking.length > 0) {
    console.error('Blocking reachable/untriaged/expired High/Critical vulnerabilities:')
    for (const finding of blocking) {
      const expiry = finding.classification.startsWith('expired:')
        ? ` — reachability rule expired on ${finding.reviewBy}`
        : ''
      console.error(
        `- ${finding.packageName} [${finding.severity}] (${finding.classification})${expiry}`
      )
    }
    return 1
  }

  console.log('Reachability gate passed: no reachable/untriaged High/Critical vulnerabilities.')
  return 0
})

const reachabilityGateProgram = () =>
  main().pipe(
    Effect.catchTag('AuditGateError', (error) =>
      Effect.sync((): number => {
        // Un auditor caído se reporta; un bug del gate sube tal cual.
        if (!error.unavailable) throw error.cause ?? new Error(error.message)
        console.error(`Reachability gate could not run: ${error.message}`)
        return 1
      })
    )
  )

/** Corre el gate y devuelve el código de salida. Importar no dispara el CLI. */
export function runReachabilityGate(): Promise<number> {
  return runServerEffect(reachabilityGateProgram())
}

// Guard real, no solo comentario: importar este módulo (tests, otros scripts)
// no debe disparar `bun audit` ni escribir la matrix como efecto colateral.
const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectInvocation) {
  void runServerEffect(
    reachabilityGateProgram().pipe(
      // El código de salida se aplica dentro del efecto: `tsx` compila estos
      // scripts como CJS y no hay await de nivel superior.
      Effect.flatMap((code) => Effect.sync(() => process.exit(code)))
    )
  )
}
