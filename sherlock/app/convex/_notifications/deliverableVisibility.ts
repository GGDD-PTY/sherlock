// La fila document_shared puede traer, en avisos ya guardados, la nota del
// equipo y el nombre del documento. La campanita y el export GDPR usan esta
// misma puerta: si hay empresa y la decisión no autoriza, esas filas no salen.
// Sin empresa, o con autorización (ADMIN incluido), se quedan.

import { Effect } from 'effect'

const DOCUMENT_SHARED = 'document_shared'

export const omitUnauthorizedDeliverableRows = <Row extends { type: string }>(
  rows: readonly Row[],
  decision: { authorized: boolean } | null
) =>
  Effect.sync((): readonly Row[] => {
    if (!decision || decision.authorized) return rows
    return rows.filter((row) => row.type !== DOCUMENT_SHARED)
  })
