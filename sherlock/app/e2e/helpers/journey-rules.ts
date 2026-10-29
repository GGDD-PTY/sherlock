// ============================================================================
// REGLAS PURAS DE LOS JOURNEYS (sin Playwright)
// ============================================================================
// J4 recarga una vez solo ante un chunk truncado de `next dev`. J3 exige un
// pull fresco cuando J1 o J2 acaban de subir archivos en la misma ejecución.
// ============================================================================

const NEXT_DEV_TRUNCATED_CHUNK = ['ChunkLoadError', 'Unexpected end of JSON input'] as const

export function parseJourneyKeys(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw
    .split(',')
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean)
}

export function isNextDevTruncatedChunk(messages: readonly string[]): boolean {
  return messages.some((message) =>
    NEXT_DEV_TRUNCATED_CHUNK.some((marker) => message.includes(marker))
  )
}

export function j3PullRequiresFreshDownload(journeys: readonly string[]): boolean {
  return journeys.includes('j1') || journeys.includes('j2')
}

export function j3PullMeetsFloor(
  downloaded: number,
  omitted: number,
  journeys: readonly string[]
): boolean {
  return j3PullRequiresFreshDownload(journeys) ? downloaded >= 1 : downloaded + omitted >= 1
}

export function j3PullFloorMessage(
  journeys: readonly string[],
  stdout: string,
  company: string
): string {
  if (j3PullRequiresFreshDownload(journeys)) {
    return `J1 o J2 corrieron en esta ejecución y el pull no bajó archivos nuevos: ${stdout.trim()}`
  }
  return `la sala de ${company} no tiene documentos. Corre J1 antes o siembra con --docs: ${stdout.trim()}`
}
