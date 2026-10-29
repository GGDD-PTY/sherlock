// Bytes de fixtures para el banco dev (solo dev/E2E).
// Sirve los archivos de `e2e/fixtures` al navegador para que el banco
// `/[locale]/dev-viewers` pueda montar los visores reales (Mog, pdf.js,
// docx-preview) con bytes de verdad sin Convex ni grants. El E2E intercepta la
// red con page.route; un navegador humano necesita esta ruta.
//
// Fail-closed en dos capas, igual que la page del banco: NODE_ENV de
// produccion o dev-auth apagado responden 404 y la allowlist es cerrada —
// jamas se lee un path derivado del request.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Effect } from 'effect'
import { NextResponse } from 'next/server'

import { routePromise, runRouteEffect } from '@/lib/api/effect-route'

const ROUTE = '/api/dev-fixtures/[name]'

const MIME = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  png: 'image/png',
} as const

const FIXTURE_FILES: Record<string, { path: string; mime: string }> = {
  'contrato-ppa-resumen.docx': { path: 'andina-solar/contrato-ppa-resumen.docx', mime: MIME.docx },
  'estados-financieros-fy24.pdf': {
    path: 'andina-solar/estados-financieros-fy24.pdf',
    mime: MIME.pdf,
  },
  'supuestos-operativos.xlsx': { path: 'andina-solar/supuestos-operativos.xlsx', mime: MIME.xlsx },
  'teaser-credito.pptx': { path: 'andina-solar/teaser-credito.pptx', mime: MIME.pptx },
  'logo-andina.png': { path: 'andina-solar/logo-andina.png', mime: MIME.png },
  'andina-solar-modelo.xlsx': { path: 'andina-solar-modelo.xlsx', mime: MIME.xlsx },
  'andina-solar-negocio.docx': { path: 'andina-solar-negocio.docx', mime: MIME.docx },
  'andina-solar-eeff.pdf': { path: 'andina-solar-eeff.pdf', mime: MIME.pdf },
  'andina-solar-parque.png': { path: 'andina-solar-parque.png', mime: MIME.png },
  'andina-solar-gerencia.pptx': { path: 'andina-solar-gerencia.pptx', mime: MIME.pptx },
}

function isEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED === 'true'
  )
}

type RouteContext = { params: Promise<{ name: string }> }

const getFixture = Effect.fn('DevFixture.GET')(function* (request: Request, context: RouteContext) {
  if (!isEnabled()) return new NextResponse(null, { status: 404 })

  const { name } = yield* routePromise('DevFixture.params', () => context.params)
  const entry = FIXTURE_FILES[name]
  if (!entry) return new NextResponse(null, { status: 404 })

  const bytes = yield* routePromise('DevFixture.read', () =>
    readFile(join(process.cwd(), 'e2e', 'fixtures', entry.path))
  )

  // Igual que la ruta de grants: `rendition=pdf` entrega la VISTA en PDF de un
  // OOXML con el mismo permiso; el original queda intacto.
  const rendition = new URL(request.url).searchParams.get('rendition')
  if (rendition === 'pdf' && (name.endsWith('.pptx') || name.endsWith('.docx'))) {
    const converters = yield* routePromise(
      'DevFixture.loadConverter',
      () => import('@/lib/documents/renditions/ooxml-to-pdf')
    )
    const pdf = yield* routePromise('DevFixture.convertPdf', () =>
      name.endsWith('.pptx')
        ? converters.convertPptxToPdf(new Uint8Array(bytes))
        : converters.convertDocxToPdf(new Uint8Array(bytes))
    )
    return new NextResponse(Buffer.from(pdf), {
      headers: { 'Content-Type': MIME.pdf, 'Cache-Control': 'private, no-store' },
    })
  }

  return new NextResponse(bytes, {
    headers: { 'Content-Type': entry.mime, 'Cache-Control': 'private, no-store' },
  })
})

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return runRouteEffect(request, ROUTE, getFixture(request, context))
}
