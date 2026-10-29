import { Effect, Schema } from 'effect'

import { normalizeContactPhone } from '@/../convex/_helpers/contactPhone'
import type { Id } from '@/../convex/_generated/dataModel'

class ContactPhoneInvalid extends Schema.TaggedError<ContactPhoneInvalid>()(
  'ContactPhoneInvalid',
  {}
) {}

class ContactPhoneSaveFailed extends Schema.TaggedError<ContactPhoneSaveFailed>()(
  'ContactPhoneSaveFailed',
  { cause: Schema.Defect() }
) {}

/**
 * Son dos programas, no uno. La normalización no espera a nadie: corre síncrona
 * y el número que no sirve se marca en el mismo tick del submit. Meterla en el
 * programa asíncrono retrasaba ese aviso un microtask, y un aviso de validación
 * que llega tarde es un aviso que el cliente no asocia con lo que acaba de
 * hacer.
 *
 * Viven fuera de los componentes y reciben la mutation por argumento: definidos
 * adentro serían una función nueva por render. La sala y el panel de preparación
 * son el mismo guardado.
 */
export const normalizeSubmittedPhone = Effect.fn('ContactPhone.normalize')(function* (
  raw: string
): Effect.fn.Return<string, ContactPhoneInvalid> {
  const normalized = normalizeContactPhone(raw)
  if (normalized === null) return yield* new ContactPhoneInvalid()
  return normalized
})

export const saveContactPhone = Effect.fn('ContactPhone.save')(function* (
  savePhone: (args: { companyId: Id<'companies'>; phone: string }) => Promise<unknown>,
  args: { companyId: Id<'companies'>; phone: string }
): Effect.fn.Return<void, ContactPhoneSaveFailed> {
  yield* Effect.tryPromise({
    try: () => savePhone(args),
    catch: (cause) => new ContactPhoneSaveFailed({ cause }),
  })
})
