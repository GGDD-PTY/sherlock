import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { IntakeDocumentView } from '@/lib/intake/session'

const IntakeInspectionStatusSchema = Schema.Literals([
  'CLEAN',
  'NOT_CONFIGURED',
  'UNINSPECTED',
  'SUSPICIOUS',
])

const IntakeDocumentViewSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, 256))),
  displayName: Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, 255))),
  declaredMimeType: Schema.String,
  byteSize: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
  ),
  inspectionStatus: IntakeInspectionStatusSchema,
  claimable: Schema.Boolean,
  createdAt: Schema.Number,
})

const decodeIntakeDocument = Schema.decodeUnknownOption(IntakeDocumentViewSchema)

export function projectIntakeDocument(value: unknown): IntakeDocumentView | null {
  return Option.getOrNull(decodeIntakeDocument(value))
}
