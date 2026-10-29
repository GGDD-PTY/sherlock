import { Schema } from 'effect'

import { parseJsonRequest, type JsonRequestResult } from '@/lib/api/effect-json'

const ROOM_JOURNEY_MAX_BODY_BYTES = 512

const noPropertiesSchema = Schema.Record(Schema.String, Schema.Never)
const documentKindSchema = Schema.Literals(['pdf', 'spreadsheet', 'other'])

export const roomJourneyEventSchema = Schema.Union([
  Schema.Struct({ event: Schema.Literal('room_entered'), properties: noPropertiesSchema }),
  Schema.Struct({
    event: Schema.Literal('document_opened'),
    properties: Schema.Struct({ documentKind: documentKindSchema }),
  }),
  Schema.Struct({ event: Schema.Literal('company_profile_saved'), properties: noPropertiesSchema }),
  Schema.Struct({ event: Schema.Literal('contact_saved'), properties: noPropertiesSchema }),
  Schema.Struct({ event: Schema.Literal('assistant_opened'), properties: noPropertiesSchema }),
  Schema.Struct({ event: Schema.Literal('dashboard_opened'), properties: noPropertiesSchema }),
])

export type RoomJourneyEvent = typeof roomJourneyEventSchema.Type
type RoomJourneyEventName = RoomJourneyEvent['event']

type RoomJourneyPropertiesByEvent = {
  [Event in RoomJourneyEvent as Event['event']]: Event['properties']
}

export type RoomJourneyTrackArgs = {
  [Event in RoomJourneyEventName]: [
    eventName: Event,
    properties: RoomJourneyPropertiesByEvent[Event],
  ]
}[RoomJourneyEventName]

export type RoomJourneyJsonResult = JsonRequestResult<RoomJourneyEvent>

export function parseRoomJourneyJson(request: Request): Promise<RoomJourneyJsonResult> {
  return parseJsonRequest({
    request,
    schema: roomJourneyEventSchema,
    maxBytes: ROOM_JOURNEY_MAX_BODY_BYTES,
  })
}
