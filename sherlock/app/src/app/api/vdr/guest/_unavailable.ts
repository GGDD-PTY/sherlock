import * as Schema from 'effect/Schema'
import { NextResponse } from 'next/server'
import { secureGuestResponse } from '@/lib/auth/vdr-guest-api'

const RequestIdSchema = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))
const decodeRequestId = Schema.decodeUnknownOption(RequestIdSchema)

export function guestUnavailable(requestId: string) {
  const decoded = decodeRequestId(requestId)
  const id = decoded._tag === 'Some' ? decoded.value : requestId
  return secureGuestResponse(
    NextResponse.json(
      { error: 'Acceso temporalmente no disponible', requestId: id },
      { status: 503 }
    ),
    id
  )
}
