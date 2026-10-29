import * as Schema from 'effect/Schema'

const AdminActivityEntrySchema = Schema.Struct({
  _id: Schema.String,
  userId: Schema.optional(Schema.String),
  action: Schema.String,
  entityId: Schema.optional(Schema.NullOr(Schema.String)),
  entityType: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        details: Schema.optional(Schema.Unknown),
      })
    )
  ),
  ipAddress: Schema.optional(Schema.NullOr(Schema.String)),
  userAgent: Schema.optional(Schema.NullOr(Schema.String)),
  _creationTime: Schema.Number,
})

const decodeAdminActivityEntry = Schema.decodeUnknownOption(AdminActivityEntrySchema)

type AdminActivityLogEntry = {
  _id: string
  userId?: string
  action: string
  entityId?: string | null
  entityType?: string | null
  metadata?: { details?: unknown } | null
  ipAddress?: string | null
  userAgent?: string | null
  _creationTime: number
}

function toAdminActivityResponse(entry: AdminActivityLogEntry) {
  return {
    id: entry._id,
    user_id: entry.userId,
    activity_type: entry.action,
    metadata: {
      resourceId: entry.entityId,
      resourceType: entry.entityType,
      details: entry.metadata?.details,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
    },
    created_at: new Date(entry._creationTime).toISOString(),
  }
}

export function formatAdminActivityLog(entry: AdminActivityLogEntry) {
  const decoded = decodeAdminActivityEntry(entry)
  return toAdminActivityResponse(decoded._tag === 'Some' ? decoded.value : entry)
}
