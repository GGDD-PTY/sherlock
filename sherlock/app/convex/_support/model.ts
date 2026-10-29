// ============================================================================
// SOPORTE — el mensaje que el cliente escribe y el equipo lee
// ============================================================================
// Las cotas del mensaje viven UNA vez, como `Schema`, y `normalizeSupportMessage`
// termina construyendo con `make`: los tres rechazos explícitos siguen dando su
// copy y su código estable al cliente, y el `make` de salida es el cinturón que
// prueba que esos tres guardas y las cotas declaradas dicen lo mismo. Si un día
// alguien afloja un guarda, el mensaje no llega a la tabla: revienta acá como
// defecto (un bug nuestro), no como error de negocio.
// ============================================================================

import { v } from 'convex/values'
import { Schema } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import { invalidState } from '../_helpers/errors'

export const SUPPORT_MESSAGE_MAX_LENGTH = 10_000
export const SUPPORT_MESSAGE_PAGE_MAX = 50
export const SUPPORT_INBOX_PAGE_MAX = 50
export const TEMPORARY_INTAKE_SUPPORT_AVAILABLE = true

// Los caracteres que un mensaje no puede traer, escritos UNA vez: el guarda que
// rechaza con copy propio y la cota del schema salen de la misma clase. El tab
// y el salto de línea quedan FUERA de la lista a propósito: el textarea los
// produce y un mensaje con sangría no es un mensaje malformado.
const CONTROL_CHARACTER_CLASS = '\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f'
const SUPPORT_MESSAGE_CONTROL_CHARACTERS = new RegExp(`[${CONTROL_CHARACTER_CLASS}]`)

/** Un cuerpo de mensaje ya normalizado. Las cotas se declaran acá y nada más. */
const SupportMessageBodySchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SUPPORT_MESSAGE_MAX_LENGTH),
    Schema.isPattern(new RegExp(`^[^${CONTROL_CHARACTER_CLASS}]*$`))
  )
)

// El alcance de un hilo y el autor de un mensaje son vocabularios cerrados. Se
// declaran como unión pelada —nada los decodifica— y la cota del final del
// archivo obliga a que el validador diga exactamente lo mismo: acá los
// literales se escriben a la vista —un candado de arquitectura los lee como
// texto— pero ya no pueden divergir en silencio, que era el problema real.
type SupportScopeKind = 'COMPANY' | 'INTAKE'
type SupportAuthorKind = 'COMPANY' | 'ADMIN' | 'INTAKE'

export const supportThreadScopeValidator = v.union(
  v.object({
    kind: v.literal('COMPANY'),
    companyId: v.id('companies'),
  }),
  v.object({
    kind: v.literal('INTAKE'),
    intakeSessionId: v.id('intakeSessions'),
  })
)

export const supportMessageAuthorValidator = v.union(
  v.object({
    kind: v.literal('COMPANY'),
    profileId: v.id('profiles'),
  }),
  v.object({
    kind: v.literal('ADMIN'),
    profileId: v.id('profiles'),
  }),
  v.object({
    kind: v.literal('INTAKE'),
  })
)

export type SupportThreadScope =
  | { kind: 'COMPANY'; companyId: Id<'companies'> }
  | { kind: 'INTAKE'; intakeSessionId: Id<'intakeSessions'> }

export function companySupportScope(companyId: Id<'companies'>): SupportThreadScope {
  return { kind: 'COMPANY', companyId }
}

export function intakeSupportScope(intakeSessionId: Id<'intakeSessions'>): SupportThreadScope {
  return { kind: 'INTAKE', intakeSessionId }
}

export function supportScopeKey(scope: SupportThreadScope): string {
  return scope.kind === 'COMPANY' ? `company:${scope.companyId}` : `intake:${scope.intakeSessionId}`
}

export function normalizeSupportMessage(value: string): string {
  const normalized = value.normalize('NFKC').replace(/\r\n?/g, '\n').trim()

  if (normalized.length === 0) {
    throw invalidState('Escribe un mensaje antes de enviarlo.', 'SUPPORT_MESSAGE_EMPTY')
  }
  if (normalized.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    throw invalidState(
      `El mensaje no puede superar ${SUPPORT_MESSAGE_MAX_LENGTH} caracteres.`,
      'SUPPORT_MESSAGE_TOO_LONG'
    )
  }
  if (SUPPORT_MESSAGE_CONTROL_CHARACTERS.test(normalized)) {
    throw invalidState('El mensaje contiene caracteres no permitidos.', 'SUPPORT_MESSAGE_INVALID')
  }

  // Lo que pasó los tres guardas tiene que satisfacer las cotas declaradas. Que
  // no las satisfaga no es un error del cliente: es un guarda que se aflojó.
  return SupportMessageBodySchema.make(normalized)
}

export function projectSupportMessage(message: Doc<'supportMessages'>) {
  return {
    messageId: message._id,
    sequence: message.sequence,
    authorKind: message.author.kind,
    body: message.body,
    createdAt: message.createdAt,
  }
}

// El validador y el vocabulario declarado no pueden divergir: si alguien agrega
// un tipo de alcance o de autor a uno y no al otro, esto deja de compilar.
/**
 * «Estos dos tipos son EXACTAMENTE el mismo», comprobado en las dos
 * direcciones y en una sola declaración.
 *
 * La forma anterior era `MustExtend<A, B> & MustExtend<B, A>`. Funcionaba, pero
 * cuando la comprobación tiene éxito los dos lados de la intersección son el
 * mismo tipo, y `no-duplicate-type-constituents` lo marca: el lint se disparaba
 * justo cuando el contrato se cumplía. Esta forma no interseca nada.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

/** Cota de una sola dirección: el dominio puede ser más ancho a propósito. */
type MustExtend<Wider, Narrower extends Wider> = Narrower

const _sameScopeVocabulary: Exact<
  SupportScopeKind,
  (typeof supportThreadScopeValidator.type)['kind']
> = true

const _sameAuthorVocabulary: Exact<
  SupportAuthorKind,
  (typeof supportMessageAuthorValidator.type)['kind']
> = true

type _ScopeValidatorFitsDomain = MustExtend<
  SupportThreadScope,
  typeof supportThreadScopeValidator.type
>
