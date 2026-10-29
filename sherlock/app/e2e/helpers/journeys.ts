/// <reference types="node" />
// ============================================================================
// E2E HELPERS: LOS CINCO JOURNEYS CRONOMETRADOS
// ============================================================================
// El cronómetro, el recolector de errores de consola y los archivos de prueba
// que comparten `e2e/journeys/*.spec.ts`. El tiempo lo toma el script con
// `performance.now()` —tiempo de máquina, no el que reporta el navegador— y
// cada paso deja una fila que `scripts/journeys-local.mjs` convierte en el TSV
// de `~/Developer/sherlock-handoffs/journeys/`.
//
// Sin mocks de red: estos journeys corren contra el backend local real
// (`bun run dev:local`), que es justamente lo que se quiere medir.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { ConvexHttpClient } from 'convex/browser'
import { Effect } from 'effect'
import { expect, type Page } from '@playwright/test'

import { api } from '../../convex/_generated/api'
import { adminVdrTarget } from '../../convex/_adminVdr/capabilityFormat'
import { isNextDevTruncatedChunk } from './journey-rules'
import { createAdminVdrCapabilityProof } from '@/lib/auth/admin-vdr-capability-proof'
import { localConvexIdentity } from '@/lib/dev-auth/local-convex-identity'
import { devUserFromEmail } from '@/lib/dev-auth/seed-identity'
import { selectGuestShareableDocuments } from '@/lib/vdr/guest-documents'

// Las metas de la sección 6 del plan 10/10, en milisegundos de máquina.
export const JOURNEY_GOAL_MS = {
  J1: 90_000,
  J2: 60_000,
  J3: 120_000,
  J4: 90_000,
  J5: 60_000,
} as const

export type JourneyId = keyof typeof JOURNEY_GOAL_MS

// La empresa del banco de pruebas y sus dos identidades.
//
// `scripts/journeys-local.mjs` corre los cinco journeys una vez por empresa y
// le pasa a cada corrida la suya en el entorno; sin entorno se comporta como
// hasta hoy, sobre «Journeys, S. A.». El correo del dueño sale del slug del
// nombre (`slugifyCompanyName` en `scripts/convex-local.mjs`), y esa regla no
// se duplica aquí: el runner la aplica y manda el correo ya resuelto. Por eso
// los dos valores viajan juntos o no viajan: uno solo dejaría al journey
// entrando como el dueño de otra sala.
function benchCompany(): { name: string; ownerEmail: string } {
  const name = process.env.JOURNEYS_COMPANY?.trim()
  const ownerEmail = process.env.JOURNEYS_OWNER_EMAIL?.trim().toLowerCase()
  if (!name && !ownerEmail) {
    return { name: 'Journeys, S. A.', ownerEmail: 'journeys-s-a@dev.local' }
  }
  if (!name || !ownerEmail) {
    throw new Error(
      'JOURNEYS_COMPANY y JOURNEYS_OWNER_EMAIL van juntos: el dueño sale del slug del nombre y ' +
        '`bun run journeys:local` pasa los dos.'
    )
  }
  return { name, ownerEmail }
}

const bench = benchCompany()

export const JOURNEY_COMPANY_NAME = bench.name
export const JOURNEY_OWNER_EMAIL = bench.ownerEmail
export const JOURNEY_ADMIN_EMAIL = 'admin@dev.local'

/**
 * El slug de la empresa de esta corrida: el local part del correo del dueño.
 *
 * Es lo que distingue a dos empresas dentro de una misma corrida del portfolio
 * (el `JOURNEYS_RUN_ID` es el mismo para las diez), y sale del correo justo
 * para no repetir la regla del slug que aplicó el seed.
 */
export function journeyCompanySlug(): string {
  return JOURNEY_OWNER_EMAIL.split('@')[0] ?? ''
}

// Ruido del servidor de desarrollo, no del producto: cuando `next dev`
// reconstruye, el HTML que iba a medio transmitir se corta y el navegador
// reporta un error de sintaxis sin pila («The destination stream closed early»
// del otro lado). `waitForHydratedInput` lo cura con una recarga. Se cuenta en
// la tabla igual, pero no tumba la meta de «cero errores de consola», que es
// sobre el producto. Medido en el banco local el 2026-09-12.
const DEV_SERVER_NOISE = [
  /^Invalid or unexpected token$/,
  // `next dev` responde 500 mientras compila una ruta bajo demanda. Medido
  // en el banco local el 2026-09-12: el intake llega igual después.
  /^Failed to load resource: the server responded with a status of 500/,
]

type JourneyStepRow = {
  // La empresa de esta corrida: el runner mide el mismo recorrido en varias
  // salas y el TSV las separa por esta columna.
  empresa: string
  journey: JourneyId
  paso: string
  ms: number
  ok: boolean
  errores_consola: number
  recargas: number
  mensajes: string[]
}

/** Un PDF mínimo pero válido, generado en el spec (no hay fixture que mantener). */
export function journeyPdf(name: string): { name: string; mimeType: string; buffer: Buffer } {
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj`,
    `% ${name}`,
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n')
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(body, 'utf8') }
}

/**
 * La marca de esta corrida, para que los nombres de archivo no choquen con los
 * de la corrida anterior: el banco no se resetea entre corridas y dos
 * documentos con el mismo nombre harían ambigua la comprobación.
 */
export function journeyStamp(): string {
  return process.env.JOURNEYS_RUN_ID ?? `${Date.now()}`
}

/**
 * El entregable que J3 sube y que J5 lee por el MCP.
 *
 * Los dos lo necesitan con el mismo nombre: J3 lo empuja al slot MODEL y J5
 * tiene que pedir ESE documento por `documento_id`, porque una sala con dos
 * libros hace que `modelo_resumen` sin `documento_id` conteste
 * ARGUMENTO_INVALIDO (`resolveModelDocumentEffect`, `src/lib/vdr-mcp/tools.ts`)
 * y la segunda corrida del banco deja dos.
 */
export function journeyDeliverableName(): string {
  return `Modelo financiero ${journeyStamp()}`
}

/**
 * Una IP de visitante para esta corrida.
 *
 * El intake temporal cuenta sesiones por IP del cliente (`createIntakeAnonymousKey`,
 * tope 3 activas y 10 por día). En el banco local no hay proxy, así que
 * `getClientIp` devuelve `unknown` para TODOS: dos corridas seguidas chocan en
 * el mismo cupo aunque cada una sea un visitante distinto. El header le da a
 * cada corrida la identidad que la nube le daría; los topes siguen enteros
 * dentro de la corrida.
 */
export function newVisitorIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 254)
  return `10.${octet()}.${octet()}.${octet()}`
}

function appendRow(row: JourneyStepRow): void {
  const target = process.env.JOURNEYS_LOG
  if (!target) return
  mkdirSync(path.dirname(target), { recursive: true })
  appendFileSync(target, `${JSON.stringify(row)}\n`, 'utf8')
}

function appendIntakeHttp(entry: Record<string, unknown>): void {
  const target = process.env.JOURNEYS_LOG
  if (!target) return
  mkdirSync(path.dirname(target), { recursive: true })
  appendFileSync(`${target}.http`, `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Un journey en curso: cronometra sus pasos, escucha los `console.error` y los
 * errores de página del navegador, y escribe una fila por paso más la del
 * total. Una fila con `ok: false` es el paso que se cayó.
 */
export class JourneyRun {
  readonly journey: JourneyId
  private readonly errors: string[] = []
  private consumed = 0
  private recargasCount = 0
  private consumedRecargas = 0
  private readonly startedAt = performance.now()

  constructor(journey: JourneyId) {
    this.journey = journey
  }

  /** Los errores del navegador que este journey acumuló, en orden. */
  get consoleErrors(): readonly string[] {
    return this.errors
  }

  /** Los mismos, sin el ruido del servidor de desarrollo. */
  get productConsoleErrors(): readonly string[] {
    return this.errors.filter((message) => !DEV_SERVER_NOISE.some((noise) => noise.test(message)))
  }

  /** Engancha una página: sus `console.error` y sus errores no capturados. */
  watch(page: Page): void {
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      // «Failed to load resource» llega sin URL en el texto; la ubicación del
      // mensaje sí la trae. Sin ella, un 401 en la tabla no dice de qué recurso.
      const text = message.text()
      const url = message.location().url
      this.errors.push(text.startsWith('Failed to load resource') && url ? `${text} <${url}>` : text)
    })
    page.on('pageerror', (error) => {
      this.errors.push(error.message)
    })
    // Captura el POST del intent: si el 500 del tercer archivo manda cuerpo
    // vacío, aquí se ve; si el cuerpo salió completo, el vacío es del servidor.
    page.on('request', (request) => {
      try {
        const url = request.url()
        if (request.method() !== 'POST' || !url.includes('/api/intake/uploads')) return
        const postData = request.postData() ?? ''
        appendIntakeHttp({
          journey: this.journey,
          phase: 'request',
          url,
          contentType: request.headers()['content-type'] ?? '',
          contentLength: request.headers()['content-length'] ?? '',
          bodyBytes: Buffer.byteLength(postData),
          bodyEmpty: postData.length === 0,
          bodyPreview: postData.slice(0, 240),
        })
      } catch {
        // La captura no puede tumbar el journey.
      }
    })
    page.on('response', (response) => {
      try {
        const url = response.url()
        if (response.request().method() !== 'POST' || !url.includes('/api/intake/uploads')) return
        appendIntakeHttp({
          journey: this.journey,
          phase: 'response',
          url,
          status: response.status(),
        })
      } catch {
        // La captura no puede tumbar el journey.
      }
    })
  }

  /** Corre un paso, lo cronometra y deja su fila. Un fallo se registra y sube. */
  async step<T>(paso: string, body: () => Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try {
      const value = await body()
      this.record(paso, startedAt, true)
      return value
    } catch (error) {
      this.record(paso, startedAt, false)
      throw error
    }
  }

  /** Cierra el journey con la fila del total. */
  end(): void {
    this.record('total', this.startedAt, true)
  }

  /** Una recarga absorbida por ruido de `next dev` (chunk truncado). */
  noteReload(): void {
    this.recargasCount += 1
  }

  private record(paso: string, startedAt: number, ok: boolean): void {
    // Los errores nuevos son los que aparecieron durante este paso: la lista es
    // acumulativa y cada fila se lleva su tramo. Las recargas igual.
    const mensajes = this.errors.slice(this.consumed)
    const recargas =
      paso === 'total' ? this.recargasCount : this.recargasCount - this.consumedRecargas
    if (paso !== 'total') {
      this.consumed = this.errors.length
      this.consumedRecargas = this.recargasCount
    }
    appendRow({
      empresa: JOURNEY_COMPANY_NAME,
      journey: this.journey,
      paso,
      ms: Math.round(performance.now() - startedAt),
      ok,
      errores_consola: paso === 'total' ? this.errors.length : mensajes.length,
      recargas,
      mensajes: paso === 'total' ? [...this.errors] : mensajes,
    })
  }
}

/** El registro del journey que un spec abre al empezar. */
export function startJourney(journey: JourneyId, page: Page): JourneyRun {
  const run = new JourneyRun(journey)
  run.watch(page)
  return run
}

/** J5 no abre navegador: el cronómetro vive igual, sin consola de página. */
export function startHeadlessJourney(journey: JourneyId): JourneyRun {
  return new JourneyRun(journey)
}

/**
 * Cliente Convex local impersonando a un correo `*@dev.local` sembrado, con la
 * misma admin key y la misma identidad que usa la app (`src/lib/convex-auth.ts`).
 */
function impersonateConvex(email: string): ConvexHttpClient {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  const adminKey = process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY
  const user = devUserFromEmail(email)
  if (!convexUrl || !adminKey || !user) {
    throw new Error('El backend local y su admin key son necesarios para impersonar.')
  }
  const client = new ConvexHttpClient(convexUrl)
  const setAdminAuth = Reflect.get(client, 'setAdminAuth') as
    ((token: string, identity: Record<string, string>) => void) | undefined
  if (typeof setAdminAuth !== 'function') {
    throw new TypeError('El cliente de Convex no acepta identidad impersonada.')
  }
  const identity = localConvexIdentity(user)
  setAdminAuth.call(client, adminKey, {
    subject: identity.subject,
    issuer: identity.issuer,
    email: identity.email,
    name: identity.name,
    ...(identity.sid ? { sid: identity.sid } : {}),
  })
  return client
}

/**
 * Abre el enlace del invitado y espera el campo de email.
 *
 * Una sola recarga, y solo si la primera carga falló por un chunk truncado de
 * `next dev` (`ChunkLoadError` o `Unexpected end of JSON input`). Cualquier
 * otra falla deja el paso en rojo. La recarga se anota en la tabla.
 */
export async function openGuestInvitation(
  page: Page,
  url: string,
  journey: JourneyRun
): Promise<void> {
  const seen: string[] = []
  const onConsole = (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') seen.push(message.text())
  }
  const onPageError = (error: Error) => {
    seen.push(error.message)
  }
  page.on('console', onConsole)
  page.on('pageerror', onPageError)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    try {
      await waitForGuestEmailField(page)
    } catch (error) {
      if (!isNextDevTruncatedChunk(seen)) throw error
      journey.noteReload()
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await waitForGuestEmailField(page)
    }
  } finally {
    page.off('console', onConsole)
    page.off('pageerror', onPageError)
  }
}

async function waitForGuestEmailField(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const node = document.querySelector('h1')
      return Boolean(
        node &&
        Object.keys(node).some(
          (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$')
        )
      )
    },
    undefined,
    { timeout: 20_000 }
  )
  await page.getByLabel('Email invitado', { exact: true }).waitFor({ state: 'visible' })
}

/**
 * Espera a que React hidrate un input, y si no llega, recarga UNA vez.
 *
 * El SSR ya pintó el campo, pero hasta que React hidrata no hay `onChange` y
 * lo que se escriba se pierde en el primer render del cliente. La señal es el
 * fiber que React deja en el nodo, la misma que usa `waitForIntakeHydration`.
 *
 * La recarga es por el servidor de desarrollo, no por el producto: cuando
 * `convex dev` vuelve a empaquetar reescribe `convex/_generated/`, `next dev`
 * reconstruye y la página que iba a medio cargar se queda con un chunk
 * truncado (`Invalid or unexpected token` en la consola) que nunca hidrata.
 * Recargar pide los chunks nuevos. Medido en el banco local el 2026-09-12.
 */
export async function waitForHydratedInput(page: Page, selector: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.waitForFunction(
        (target) => {
          const input = document.querySelector(target)
          return (
            input !== null &&
            Object.keys(input).some(
              (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$')
            )
          )
        },
        selector,
        { timeout: 20_000 }
      )
      return
    } catch (error) {
      if (attempt === 2) throw error
      await page.reload({ waitUntil: 'domcontentloaded' })
    }
  }
}

/**
 * Manda el formulario del dev-login con un correo `*@dev.local` sembrado
 * (O3-01) y espera a que la pantalla de destino asiente.
 */
export async function submitDevLogin(
  page: Page,
  email: string,
  settledPath: RegExp
): Promise<void> {
  await waitForHydratedInput(page, 'input#email')
  const field = page.getByLabel('Email')
  await field.fill(email)
  await expect(field).toHaveValue(email)
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await page.waitForURL(settledPath, { timeout: 60_000 })
}

/** Abre el dev-login y entra como `email`. */
export async function devLogin(page: Page, email: string, settledPath: RegExp): Promise<void> {
  await page.goto('/es/dev-login', { waitUntil: 'domcontentloaded' })
  await submitDevLogin(page, email, settledPath)
}

const JOURNEY_NDA_TITLE = `NDA de ${JOURNEY_COMPANY_NAME}`
const JOURNEY_NDA_CONTENT =
  'Texto aprobado para el banco local de journeys. El invitado lee este NDA y acepta antes de ver los documentos publicados bajo NDA. No hay campos pendientes.'

const configureJourneyNdaProgram = Effect.fn('Journeys.configureNda')(function* () {
  const admin = yield* Effect.sync(() => impersonateConvex(JOURNEY_ADMIN_EMAIL))
  const companies = yield* Effect.tryPromise(() =>
    admin.query(api.companies.listAdminCompanies, {})
  )
  const company = companies.find((row) => row.name === JOURNEY_COMPANY_NAME)
  if (!company) {
    return yield* Effect.fail(new Error(`No está sembrada "${JOURNEY_COMPANY_NAME}".`))
  }

  const adminUser = devUserFromEmail(JOURNEY_ADMIN_EMAIL)
  const sessionId = adminUser?.convexIdentity.sessionId
  if (!adminUser || !sessionId) {
    return yield* Effect.fail(new Error('El admin local no trae sesión WorkOS.'))
  }

  const input = {
    companyId: company._id,
    title: JOURNEY_NDA_TITLE,
    content: JOURNEY_NDA_CONTENT,
    version: `j4-${journeyStamp()}`,
    locale: 'es' as const,
  }
  const proof = createAdminVdrCapabilityProof({
    subject: adminUser.convexIdentity.subject,
    sessionId,
    companyId: company._id,
    action: 'GUEST_INVITE',
    target: adminVdrTarget('COMPANY_NDA', company._id),
    input,
  })
  yield* Effect.tryPromise(() =>
    admin.mutation(api.adminVdrCapabilities.issue, {
      ...proof.issuance,
      companyId: company._id,
    })
  )
  yield* Effect.tryPromise(() =>
    admin.mutation(api.guestAccess.configureCompanyNda, {
      ...input,
      adminCapability: proof.capability,
    })
  )
  return company._id
})

/** Aprueba el NDA de la empresa del banco. Solo el equipo puede hacerlo. */
export function configureJourneyNda(): Promise<string> {
  return Effect.runPromise(configureJourneyNdaProgram())
}

/**
 * El dueño invita al invitado con el documento que ESTA corrida publicó. El
 * banco no se resetea entre corridas y la sala arrastra lo que publicaron las
 * anteriores: tomar el primero compartible invitaba con uno viejo.
 */
export async function inviteJourneyGuest(email: string, documentName: string): Promise<void> {
  const owner = impersonateConvex(JOURNEY_OWNER_EMAIL)
  const workspace = await owner.query(api.companies.getMyVdrWorkspace, {})
  const companyId = workspace?.company?._id
  if (!companyId) throw new Error(`El dueño de "${JOURNEY_COMPANY_NAME}" no tiene sala.`)
  const documents = await owner.query(api.documents.getByCompany, { companyId })
  const shared = selectGuestShareableDocuments(documents ?? [], Date.now()).find(
    (document) => document.name === documentName
  )
  if (!shared) {
    throw new Error(`"${documentName}" no está publicado bajo NDA: no se puede invitar con él.`)
  }
  await owner.mutation(api.guestAccess.inviteToCompany, {
    companyId,
    documentIds: [shared._id],
    email,
    expiresInDays: 7,
    locale: 'es',
  })
}

function convexBin(): string {
  const candidates = [
    path.join(process.cwd(), 'node_modules', '.bin', 'convex'),
    path.join(process.cwd(), '..', '..', 'node_modules', '.bin', 'convex'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('No encuentro el CLI de Convex.')
  return found
}

type ResendEmail = { to: unknown; subject: string; text: string; status: string }

function readResendEmails(): ResendEmail[] {
  const query = [
    'const emails = await ctx.db.query("emails").order("desc").take(30)',
    'const out = []',
    'for (const email of emails) {',
    '  let text = ""',
    '  if (email.text) {',
    '    const row = await ctx.db.get(email.text)',
    '    if (row?.content) text = new TextDecoder().decode(row.content)',
    '  }',
    '  out.push({ to: email.to, subject: email.subject ?? "", text, status: email.status })',
    '}',
    'return out',
  ].join('\n')
  const result = spawnSync(convexBin(), ['run', '--component', 'resend', '--inline-query', query], {
    cwd: path.join(process.cwd(), '.convex-local'),
    encoding: 'utf8',
    env: {
      ...process.env,
      CONVEX_AGENT_MODE: 'anonymous',
      CONVEX_DEPLOYMENT: 'anonymous:anonymous-agent',
      CONVEX_DEPLOY_KEY: '',
      CONVEX_SELF_HOSTED_URL: '',
      CONVEX_SELF_HOSTED_ADMIN_KEY: '',
    },
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'No pude leer los correos de Resend.')
  }
  const parsed = JSON.parse(result.stdout.trim() || '[]') as ResendEmail[]
  return Array.isArray(parsed) ? parsed : []
}

function emailMatchesRecipient(to: unknown, email: string): boolean {
  if (typeof to === 'string') return to.toLowerCase() === email.toLowerCase()
  if (Array.isArray(to)) {
    return to.some(
      (entry) => typeof entry === 'string' && entry.toLowerCase() === email.toLowerCase()
    )
  }
  return false
}

export async function waitForResendEmail(
  email: string,
  match: (row: ResendEmail) => boolean,
  timeoutMs = 30_000
): Promise<ResendEmail> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = readResendEmails().find(
      (row) => emailMatchesRecipient(row.to, email) && match(row)
    )
    if (found) return found
    await new Promise((resolve) => {
      setTimeout(resolve, 400)
    })
  }
  throw new Error(`No llegó el correo de Resend para ${email}.`)
}

export function invitationUrlFromEmail(row: ResendEmail): string {
  const match = row.text.match(/https?:\/\/\S+\/es\/vdr-guest#[A-Za-z0-9_-]{32,256}/)
  if (!match) throw new Error('El correo de invitación no trae el enlace.')
  return match[0]
}

export function otpFromEmail(row: ResendEmail): string {
  const match = row.text.match(/\b(\d{6})\b/)
  if (!match) throw new Error('El correo del OTP no trae el código.')
  return match[1]
}

export function mintJourneyMcpToken(email = JOURNEY_OWNER_EMAIL, scope = 'openid'): string {
  const base = process.env.E2E_BASE_URL ?? 'http://localhost:3116'
  const appPort = new URL(base).port || '80'
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(process.cwd(), 'scripts/convex-local.mjs'),
      'mcp-token',
      '--email',
      email,
      '--scope',
      scope,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PORT: appPort },
    }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || 'mcp-token falló')
  }
  const token = result.stdout.trim().split('\n')[0]
  if (!token || token.split('.').length !== 3) {
    throw new Error('mcp-token no imprimió un JWT')
  }
  return token
}

async function readMcpJsonRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  const raw = dataLine === undefined ? text : dataLine.slice('data: '.length)
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (cause) {
    throw new Error(`MCP no devolvió JSON (${response.status}): ${text.slice(0, 400)}`, {
      cause,
    })
  }
}

export async function journeyMcpCall(
  token: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<{ json: Record<string, unknown>; status: number }> {
  const base = (process.env.E2E_BASE_URL ?? 'http://localhost:3116').replace(/\/$/, '')
  const response = await fetch(`${base}/api/vdr-mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
  return { json: await readMcpJsonRpc(response), status: response.status }
}
