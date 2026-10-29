import { Schema } from 'effect'

import type { DocumentAccessLevel, DocumentClassification } from '@/lib/documents/classification'
import type { RoomDocumentMoveOutcome } from '@/lib/documents/room-tree-command-state'

/**
 * Controlled bulk-selection authority for the room shell. The active row is
 * intentionally absent: it belongs to the shell's details/viewer navigation.
 */
export type RoomBulkSelection = {
  selectedIds: ReadonlySet<string>
  isUpdating: boolean
  onToggle: (documentId: string, selected: boolean) => void
  onSelectMany: (documentIds: readonly string[], selected: boolean) => void
  onClear: () => void
  onMove: (folder: string) => Promise<RoomDocumentMoveOutcome>
  onChangeDisclosure: (
    accessLevel: DocumentAccessLevel,
    classification: DocumentClassification
  ) => Promise<boolean>
  onArchive: () => Promise<boolean>
  /**
   * Borrado permanente de la selección. Ausente = la sala no ofrece la acción
   * (demo, solo lectura); «Archivar» sigue disponible igual.
   */
  onPurge?: () => Promise<boolean>
}

// Puro contrato de props: no hay dato que entre sin decodificar ni lista que
// recorrer, así que no hay una frontera real para Effect en este archivo. El
// único campo del contrato que es dato (no callback) es `selectedIds`; este
// guard lo deja verificable en runtime sin agregar un export nuevo que knip
// marcaría muerto (ningún caller de RoomBulkSelection está en este lote).
// Candidato a recorte, ver reporte del lote.
Schema.is(Schema.ReadonlySet(Schema.String))
