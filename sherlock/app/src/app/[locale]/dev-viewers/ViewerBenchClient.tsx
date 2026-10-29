'use client'

import { useState } from 'react'
import { Schema } from 'effect'
import { DocumentBytesProvider } from '@/components/documents/viewers/useDocumentBytes'

import {
  DocumentViewer,
  type DocumentViewerNavigate,
} from '@/components/documents/viewers/DocumentViewer'
import type { Id } from '@/../convex/_generated/dataModel'

// `?page=` llega como texto de la URL. `Number.parseInt` devolvía `NaN` para
// cualquier cosa que no fuera un número y ese `NaN` entraba al visor como si
// fuera una página. El esquema exige un entero de verdad y descarta el resto.
const PageNumberSchema = Schema.FiniteFromString.pipe(Schema.check(Schema.isInt()))

const decodePageNumber = Schema.decodeUnknownOption(PageNumberSchema)

function pageNumber(raw: string | undefined): number | undefined {
  const decoded = decodePageNumber(raw)
  return decoded._tag === 'Some' ? decoded.value : undefined
}

export function ViewerBenchClient({
  fileName,
  mimeType,
  viewUrl,
  sheet,
  range,
  page,
  retryViewUrl,
}: {
  fileName: string
  mimeType: string
  viewUrl: string
  sheet?: string
  range?: string
  page?: string
  retryViewUrl?: string
}) {
  const [activeUrl, setActiveUrl] = useState(viewUrl)
  const [mount, setMount] = useState(0)
  // La navegacion arranca vacia y se aplica con el boton: asi la prueba
  // verifica que `navigate` funciona DESPUES del montaje, que es como llegan
  // las citas del asistente de sala.
  const [navigate, setNavigate] = useState<DocumentViewerNavigate | undefined>(undefined)

  return (
    <div className="flex h-dvh flex-col gap-3 p-4">
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          data-testid="viewer-bench-navigate"
          onClick={() =>
            setNavigate({
              sheet,
              range,
              page: pageNumber(page),
            })
          }
          className="border-line rounded-md border px-3 py-1.5 text-sm"
        >
          Navegar
        </button>
        <button type="button" onClick={() => setMount((value) => value + 1)}>
          Remontar visor
        </button>
        <span data-testid="viewer-bench-file" className="text-muted-foreground font-mono text-xs">
          {fileName}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <DocumentBytesProvider activeUrl={activeUrl}>
          <DocumentViewer
            key={mount}
            documentId={'document_bench' as Id<'documents'>}
            versionId={'version_bench' as Id<'documentVersions'>}
            fileName={fileName}
            mimeType={mimeType}
            sizeBytes={0}
            viewUrl={activeUrl}
            downloadUrl={viewUrl}
            navigate={navigate}
            onRetry={retryViewUrl ? () => setActiveUrl(retryViewUrl) : undefined}
          />
        </DocumentBytesProvider>
      </div>
    </div>
  )
}
