// ============================================================================
// LEGAL NOTICES PAGE
// ============================================================================
// Avisos importantes y descargos de responsabilidad
// Public scope: company-first sell-side preparation with controlled sharing.
// ============================================================================

import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { Schema } from 'effect'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { buildLocalizedPageMetadata } from '@/lib/site/brand'
import { Info, Calendar } from 'lucide-react'

// TODO: completar razón social tras constitución — mientras tanto, esta página
// se refiere al operador de la Plataforma sin nombrar una entidad específica.
//
// Los mapas `{ es: … }` de una sola llave y el `_locale` que nadie leía eran
// residuo del corte a un solo idioma ([F] 2026-09-03, DECISIONS): no hay
// segundo locale entre el que elegir, así que el documento es uno solo.
const LEGAL_TITLE = 'Avisos importantes'
const LEGAL_IMAGE_ALT = 'Avisos de preparación sell-side de Sherlock'
const LEGAL_UPDATED = 'Última actualización: agosto de 2026'
const LEGAL_VERSION_NOTICE = 'Versión preliminar sujeta a revisión legal.'

// A diferencia de sus dos hermanas, la copia de esta página son nodos de React
// (`<strong>` dentro de la oración), no cadenas: no hay `Schema` que
// decodifique los párrafos ni las listas. Lo que sí es cadena pura es el
// título de cada sección, y el render lo usa como `key={section.title}` más
// abajo — un título repetido no lanza: React simplemente reutiliza el nodo
// del primero para el segundo, en silencio. `NonEmptyTextSchema` sigue el
// mismo patrón que `privacy` y `terms`; `Schema.UniqueArray` es lo que
// decodifica esa garantía de la clave de render.
const NonEmptyTextSchema = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))
const decodeLegalSectionTitles = Schema.decodeSync(
  Schema.UniqueArray(NonEmptyTextSchema).pipe(Schema.check(Schema.isNonEmpty()))
)

const LEGAL_SECTIONS = [
  {
    title: '1. Lo que Sherlock es — y lo que no es',
    paragraphs: [
      <>
        Sherlock es un servicio de preparación sell-side centrado en empresas de América Latina.{' '}
        {/* TODO: completar razón social tras constitución */}
        El equipo organiza tus fuentes y prepara entregables transaccionales como modelos
        financieros, teasers, CIMs, management presentations y decks de crédito o equity. El trabajo
        se mantiene en un workspace privado de empresa y se revisa con humanos antes de entregarlo o
        compartirlo.
      </>,
      <>
        <strong>Sherlock NO es:</strong>
      </>,
    ] as ReactNode[],
    list: [
      <>
        <strong>Una oferta pública ni un catálogo de oportunidades.</strong> El sitio público no
        publica oportunidades ni ofrece cuentas autoservicio de proveedores de capital. Si un
        proceso privado avanza, el equipo puede enviarte un teaser y emitir una invitación de
        invitado a la sala correspondiente.
      </>,
      <>
        <strong>Un corredor, bolsa ni asesor de inversiones.</strong> Sherlock no hace
        recomendaciones de inversión, no organiza una oferta pública ni sustituye a tus propios
        asesores profesionales.
      </>,
      <>
        <strong>Una auditoría ni una certificación.</strong> La revisión del equipo y cualquier
        procesamiento de Mycroft son herramientas de preparación. No auditan, certifican ni
        verifican de forma independiente la información financiera, comercial, legal, contable o
        fiscal de una empresa.
      </>,
      <>
        <strong>Un custodio de fondos.</strong> Sherlock nunca recibe, retiene ni transfiere dinero
        de las transacciones. Sherlock no promete financiamiento, venta, cierre ni rendimiento.
      </>,
    ] as ReactNode[],
  },
  {
    title: '2. Advertencia de riesgo',
    paragraphs: [
      <>
        Los materiales de preparación apoyan el proceso transaccional privado de una empresa; no son
        asesoría financiera, legal, contable, fiscal ni de inversión. Cualquier decisión de
        financiamiento, venta, compra u otra transacción corresponde a las partes y a sus propios
        asesores. <strong>Sherlock no promete ni proyecta ningún rendimiento ni resultado.</strong>
      </>,
    ] as ReactNode[],
  },
  {
    title: '3. Verificación con alcance limitado',
    paragraphs: [
      <>
        El equipo puede solicitar información de la empresa antes de compartir materiales o emitir
        acceso de invitado. Esa revisión se maneja manualmente y tiene un propósito operativo
        limitado. <strong>No es una auditoría</strong>, certificación ni opinión sobre el mérito de
        una transacción. Cada parte sigue siendo responsable de su propia diligencia.
      </>,
    ] as ReactNode[],
  },
  {
    title: '4. Rol del equipo y de las herramientas internas',
    paragraphs: [
      <>
        El equipo revisa el intake, el procesamiento y los entregables antes de entregarlos o
        compartirlos. Mycroft es un servicio externo hermano sin conexión con esta aplicación: el
        equipo baja los materiales autorizados a un entorno privado, trabaja ahí y sube a tu Data
        Room solo los entregables revisados. Las herramientas analíticas o de inteligencia
        artificial son instrumentos de trabajo para acelerar la preparación — <strong>no</strong>{' '}
        generan recomendaciones ni sustituyen tu juicio o el de las partes.
      </>,
    ] as ReactNode[],
  },
  {
    title: '5. Jurisdicción',
    paragraphs: [
      <>
        Este aviso público no determina una jurisdicción ni un asunto regulatorio. Cualquier
        revisión de elegibilidad de una empresa, de compartir materiales o de acceso de invitados se
        maneja manualmente por el equipo y, cuando corresponda, se describe en los términos de
        servicio u otro acuerdo del trabajo relevante.
      </>,
    ] as ReactNode[],
  },
  {
    title: '6. Confidencialidad',
    paragraphs: [
      <>
        Los materiales de la empresa se mantienen en el workspace privado salvo que la empresa y el
        equipo autoricen compartirlos. Cuando un proceso privado avanza, el equipo puede emitir una
        invitación de invitado para una sala específica; puede requerirse un código de un solo uso y
        un NDA antes de mostrar materiales confidenciales. Sigue los términos de confidencialidad
        aplicables a cada documento que recibas.
      </>,
    ] as ReactNode[],
  },
] as const

// Revienta al importar el módulo si dos secciones comparten título, en vez de
// dejar que el aviso legal renderice con una tarjeta duplicada/perdida en
// producción, que es cuando ya nadie está mirando la consola de React.
decodeLegalSectionTitles(LEGAL_SECTIONS.map((section) => section.title))

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'legal.meta' })

  return buildLocalizedPageMetadata({
    locale,
    path: '/legal',
    title: t('title'),
    description: t('description'),
    imageAlt: LEGAL_IMAGE_ALT,
  })
}

export default async function LegalNoticesPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const tLanding = await getTranslations('landing')
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      {/* ===== HEADER ===== */}
      <div className="mb-6 max-w-3xl">
        <div className="mb-2 flex items-center gap-3">
          <Info className="text-primary h-5 w-5 shrink-0" />
          <h1 className="text-2xl font-normal tracking-tight">{LEGAL_TITLE}</h1>
        </div>
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Calendar className="h-4 w-4" />
          {LEGAL_UPDATED}
        </div>
        <p className="text-muted-foreground mt-2 text-xs italic">{LEGAL_VERSION_NOTICE}</p>
      </div>

      {/* ===== CONTENT ===== */}
      <div className="prose prose-sherlock max-w-2xl">
        {LEGAL_SECTIONS.map((section, sectionIndex) => (
          <Card
            key={section.title}
            className="mb-8 gap-2 rounded-none border-0 bg-transparent py-0 shadow-none"
          >
            <CardHeader className="grid-rows-[auto] gap-0 px-0">
              {/* Titulo de seccion real, no un parrafo con aspecto de titulo: dentro
                  de `main` solo existia el h1 y los once numerales del documento no
                  se podian saltar con lector de pantalla. Las clases repiten lo que
                  daba `CardTitle` (16px, sans, semibold) y ganan por `!` a la regla
                  `.prose-sherlock :is(h1, h2, ...)` de `globals.css`, que si no
                  pintaria el titulo en Fraunces borgona. El texto legal no cambia. */}
              <h2
                data-slot="card-title"
                className="text-card-foreground! font-sans! text-base leading-snug font-semibold tracking-normal"
              >
                {section.title}
              </h2>
            </CardHeader>
            <CardContent className="text-foreground space-y-3 px-0 text-base leading-relaxed">
              {section.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={`${sectionIndex}-${paragraphIndex}`}>{paragraph}</p>
              ))}
              {'list' in section && section.list ? (
                <ul className="list-disc space-y-2 pl-6">
                  {section.list.map((item, itemIndex) => (
                    <li key={`${sectionIndex}-${itemIndex}`}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* El pie del sitio enlaza aquí una sola vez («Legal»); esta página reúne
          las otras dos salidas legales — «Avisos» es esta misma página. */}
      <nav
        aria-label={tLanding('footer.legal.title')}
        className="mt-6 flex flex-wrap gap-x-6 gap-y-2 pt-2"
      >
        <Link
          href="/privacy"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {tLanding('footer.legal.privacy')}
        </Link>
        <Link
          href="/terms"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {tLanding('footer.legal.terms')}
        </Link>
      </nav>
    </div>
  )
}
