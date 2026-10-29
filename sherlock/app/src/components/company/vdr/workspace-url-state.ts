// ============================================================================
// ESTADO DE LA SALA EN LA URL
// ============================================================================
// Este archivo es una frontera: todo lo que entra viene de la barra de
// direcciones, o sea de fuera del programa. La sala es una por empresa y su
// única pantalla es la de documentos, así que la URL ya no elige sala ni vista:
// lo que queda variable es la categoría y la búsqueda, y las dos se recortan
// contra su propio catálogo.

import { Option, Schema } from 'effect'

import { VDR_DOCUMENT_CATEGORIES } from './config'
import type { VdrRoomScope } from './types'

export const MAX_VDR_SEARCH_LENGTH = 120

export const VDR_CATEGORY_VALUES = new Set(
  VDR_DOCUMENT_CATEGORIES.map((category) => category.value)
)

export type VdrWorkspaceUrlState = {
  room: VdrRoomScope
  view: 'documents'
  category: string
  search: string
}

export function sanitizeSearch(value: string | null) {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_VDR_SEARCH_LENGTH)
}

export const COMPANY_ROOM: VdrRoomScope = { kind: 'COMPANY', id: 'company' }

export function resolveWorkspaceUrlState(searchParams: URLSearchParams) {
  const requestedCategory = searchParams.get('category')

  return {
    room: COMPANY_ROOM,
    view: 'documents' as const,
    category:
      requestedCategory && VDR_CATEGORY_VALUES.has(requestedCategory) ? requestedCategory : 'all',
    search: sanitizeSearch(searchParams.get('q')),
  } satisfies VdrWorkspaceUrlState
}

export function serializeWorkspaceUrlState(pathname: string, state: VdrWorkspaceUrlState) {
  const nextParams = new URLSearchParams()
  nextParams.set('room', 'company')
  nextParams.set('view', 'documents')
  nextParams.set('category', state.category)
  if (state.search) nextParams.set('q', state.search)
  else nextParams.delete('q')
  return `${pathname}?${nextParams.toString()}`
}

// ===== ABRIR UNA FUENTE DESDE OTRA PANTALLA =====
// Preparación cita una fuente y la sala la abre al llegar. Formas:
// `?source=<documentId>` (versión actual), `?source=<documentId>:<versionId>`,
// y opcionalmente `&page=N` o `&sheet=<hoja>&range=<rango>`. La sala consume
// los parámetros una vez y los borra de la URL al normalizar su propio estado.
const OPEN_SOURCE_PARAM = 'source'

const OpenSourceNavigateSchema = Schema.Union([
  Schema.Struct({ page: Schema.Int.check(Schema.isGreaterThan(0)) }),
  Schema.Struct({ sheet: Schema.NonEmptyString, range: Schema.NonEmptyString }),
])

export type OpenSourceRequest = {
  documentId: string
  versionId?: string
  navigate?: typeof OpenSourceNavigateSchema.Type
}

function parseOpenSource(source: string): { documentId: string; versionId?: string } | null {
  const separator = source.indexOf(':')
  if (separator === -1) return { documentId: source }
  if (separator <= 0 || separator === source.length - 1) return null
  return {
    documentId: source.slice(0, separator),
    versionId: source.slice(separator + 1),
  }
}

export function readOpenSourceRequest(searchParams: URLSearchParams): OpenSourceRequest | null {
  const source = searchParams.get(OPEN_SOURCE_PARAM)
  if (!source) return null
  const parsed = parseOpenSource(source)
  if (!parsed) return null

  const page = searchParams.get('page')
  const sheet = searchParams.get('sheet')
  const range = searchParams.get('range')
  const hasCitation = page !== null || sheet !== null || range !== null
  if (!hasCitation) return parsed

  const candidate =
    page !== null ? { page: Number(page) } : { sheet: sheet ?? '', range: range ?? '' }
  const navigate = Schema.decodeUnknownOption(OpenSourceNavigateSchema)(candidate)
  return Option.isSome(navigate) ? { ...parsed, navigate: navigate.value } : null
}

export function serializeOpenSourceRequest(request: OpenSourceRequest): string {
  const params = new URLSearchParams()
  params.set(
    OPEN_SOURCE_PARAM,
    request.versionId ? `${request.documentId}:${request.versionId}` : request.documentId
  )
  if (!request.navigate) return params.toString()
  if ('page' in request.navigate) params.set('page', String(request.navigate.page))
  else {
    params.set('sheet', request.navigate.sheet)
    params.set('range', request.navigate.range)
  }
  return params.toString()
}
