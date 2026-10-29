import { Schema } from 'effect'
import { isSafeRedirectUrl } from '@/lib/utils/safe-redirect'

// `returnTo` viene del query string: es un destino que no controlamos.
const SafeReturnToSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((url: string) =>
      isSafeRedirectUrl(url) ? undefined : 'Destino de redirección no permitido'
    )
  )
)

export const decodeSafeReturnTo = Schema.decodeUnknownOption(SafeReturnToSchema)
