import { getFunctionName, makeFunctionReference } from 'convex/server'
import { Effect } from 'effect'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'

type ServerProof = {
  serverIssuedAt: number
  proofNonce: string
  serverProof: string
}

export type IntakeSupportMessage = {
  messageId: Id<'supportMessages'>
  sequence: number
  /** Quién escribió el mensaje. `INTAKE` es el propio sistema; el
   *  inversionista nunca aparece acá. */
  authorKind: 'COMPANY' | 'ADMIN' | 'INTAKE'
  body: string
  createdAt: number
}

// ============================================================================
// EL NOMBRE DE LA FUNCIÓN SALE DEL API GENERADO, NO DE UNA CADENA
// ============================================================================
// `makeFunctionReference` acepta cualquier cadena: `'intake:getIntakeSupport'`
// escrito a mano compila igual de bien después de que alguien renombre la
// mutation en `convex/intake.ts`, y el fallo aparece recién en runtime como un
// «Could not find public function». `getFunctionName(api.intake.X)` produce
// exactamente el mismo string y lo ata al módulo real: borrar o renombrar la
// mutation deja de compilar acá.
//
// La referencia sigue fabricándose a mano porque este lado declara los tipos
// que la ruta consume; lo único que cambia es de dónde viene el nombre. La
// construcción va en `Effect.sync` (último recurso del brief de llenado, paso
// 6): no hay frontera real que decodificar —`getFunctionName` y
// `makeFunctionReference` son puros y no fallan— así que envolverlos es
// ceremonia, no un guard nuevo. Candidato a recorte, ver reporte del lote.
export const getIntakeSupportRef = Effect.runSync(
  Effect.sync(() =>
    makeFunctionReference<
      'mutation',
      { sessionToken: string } & ServerProof,
      {
        threadId: Id<'supportThreads'> | null
        messages: IntakeSupportMessage[]
        truncated: boolean
      }
    >(getFunctionName(api.intake.getIntakeSupport))
  )
)

export const sendIntakeSupportMessageRef = Effect.runSync(
  Effect.sync(() =>
    makeFunctionReference<
      'mutation',
      { sessionToken: string; body: string } & ServerProof,
      { threadId: Id<'supportThreads'>; message: IntakeSupportMessage }
    >(getFunctionName(api.intake.sendIntakeSupportMessage))
  )
)
