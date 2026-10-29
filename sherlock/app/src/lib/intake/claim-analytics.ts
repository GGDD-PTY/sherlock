// La marca del reintento del claim viaja en una cookie, así que lo que se lee
// de vuelta lo escribió el navegador: el valor y el guardia que lo reconoce
// salen del mismo literal en vez de compararse a mano contra una constante.
import { Schema } from 'effect'

export const INTAKE_CLAIM_RETRY_COOKIE = 'sherlock_intake_claim_retry'

const IntakeClaimRetryMarkerSchema = Schema.Literals(['1'])

export const INTAKE_CLAIM_RETRY_MARKER = IntakeClaimRetryMarkerSchema.literals[0]
