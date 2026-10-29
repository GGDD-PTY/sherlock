// ============================================================================
// AYUDA — UN SOLO HUB
// ============================================================================
// Reemplaza tres superficies sueltas: /help (Centro de Ayuda con buscador y
// seis tarjetas), /roadmap (tablero + changelog) y la puerta de soporte que el
// cliente solo encontraba dentro de su sala. Las dos rutas viejas responden 308
// aquí desde `src/proxy.ts`.
//
// El orden del DOM es el del uso, no el del catálogo: primero se escribe al
// equipo, después se vota lo que sigue, y al final está la documentación
// operativa. En pantalla ancha ese orden se reparte en dos columnas (pasada
// 2026-09-04, [F]: «excesos de altura»): a la izquierda la caja de texto y,
// debajo, las seis preguntas; a la derecha el tablero completo. Así lo
// importante queda a la vista sin bajar, y la izquierda no deja medio metro
// de canvas vacío bajo un formulario de tres filas.
// ============================================================================

import type { Metadata } from 'next'
import { Schema } from 'effect'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { ROADMAP_REGISTRY } from '@/../convex/_roadmap/registry'
import { AyudaFeedback, type AyudaFeedbackLabels } from '@/components/ayuda/AyudaFeedback'
import { HelpCenter, type HelpCenterCopy } from '@/components/ayuda/HelpCenter'
import {
  RoadmapBoard,
  type RoadmapBoardLabels,
  type RoadmapCard,
} from '@/components/roadmap/RoadmapBoard'
import { buildLocalizedPageMetadata } from '@/lib/site/brand'

// Las preguntas del hub, definidas una vez. El orden de la lista es el orden
// del vocabulario, y el tipo sale de la misma definición: una pregunta nueva se
// agrega en un solo lugar. La clave es además el ancla de la fila: la sala
// enlaza `/es/ayuda#mcp` desde «Conecta tu agente» (tarjeta O4-02).
const DocKeySchema = Schema.Literals(['upload', 'deliverables', 'room', 'mcp', 'contact', 'price'])

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const [t, siteMeta] = await Promise.all([
    getTranslations({ locale, namespace: 'ayuda.meta' }),
    getTranslations({ locale, namespace: 'site.meta' }),
  ])

  return buildLocalizedPageMetadata({
    locale,
    path: '/ayuda',
    title: t('title'),
    description: t('description'),
    imageAlt: siteMeta('imageAlt'),
  })
}

export default async function AyudaPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  setRequestLocale(locale)
  const t = await getTranslations({ locale, namespace: 'ayuda' })
  const tRoadmap = await getTranslations({ locale, namespace: 'roadmap' })

  const feedbackLabels: AyudaFeedbackLabels = {
    heading: t('feedback.heading'),
    label: t('feedback.label'),
    placeholder: t('feedback.placeholder'),
    submit: t('feedback.submit'),
    sending: t('feedback.sending'),
    resolving: t('feedback.resolving'),
    sentCompany: t('feedback.sentCompany'),
    sentAnonymous: t('feedback.sentAnonymous'),
    duplicate: t('feedback.duplicate'),
    error: t('feedback.error'),
    rateLimited: t('feedback.rateLimited'),
    emailFallback: t('feedback.emailFallback'),
    emailSubject: t('feedback.emailSubject'),
  }

  const cards: RoadmapCard[] = ROADMAP_REGISTRY.filter((entry) => entry.key !== 'marketplace').map(
    (entry) => ({
      key: entry.key,
      status: entry.status,
      board: entry.board,
      added: entry.added,
      title: tRoadmap(`board.items.${entry.key}.title`),
      body: tRoadmap(`board.items.${entry.key}.body`),
      statusLabel: tRoadmap(`board.status.${entry.status}`),
      // El aria se formatea AQUI, con su valor, no en el cliente sobre una
      // plantilla. `tRoadmap('board.voteAria')` sin `values` no deja `{title}`
      // intacto: next-intl lo corre por ICU, falla y devuelve la ruta de la clave.
      voteAria: tRoadmap('board.voteAria', { title: tRoadmap(`board.items.${entry.key}.title`) }),
      unvoteAria: tRoadmap('board.unvoteAria', {
        title: tRoadmap(`board.items.${entry.key}.title`),
      }),
    })
  )

  const boardLabels: RoadmapBoardLabels = {
    sortTop: tRoadmap('board.sort.top'),
    sortNew: tRoadmap('board.sort.new'),
    filterAll: tRoadmap('board.filters.all'),
    filterFeature: tRoadmap('board.filters.feature'),
    filterBug: tRoadmap('board.filters.bug'),
    sortGroup: tRoadmap('board.groups.sort'),
    filterGroup: tRoadmap('board.groups.filter'),
    emptyBug: tRoadmap('board.empty.bug'),
    votesCapReached: tRoadmap('board.votesCapReached'),
    votedHint: tRoadmap('board.votedHint'),
    doingColumn: tRoadmap('board.doingColumn'),
    doneColumn: tRoadmap('board.doneColumn'),
  }

  const docsCopy: HelpCenterCopy = {
    heading: t('docs.heading'),
    items: DocKeySchema.literals.map((key) => ({
      id: key,
      q: t(`docs.items.${key}.q`),
      a: t(`docs.items.${key}.a`),
    })),
  }

  return (
    <div className="bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 lg:px-8">
        {/* El h1 va en la escala base (32, Fraunces): esto es un hub de trabajo,
            no un hero público. El subtítulo va pegado y la regla ocre cierra la
            cabecera: es la única geometría dorada de la página y la única regla
            suelta — las demás líneas viven dentro de las listas. */}
        <header className="max-w-2xl">
          <h1 className="text-2xl">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-base leading-relaxed">{t('subtitle')}</p>
        </header>

        {/* Dos columnas desde lg (5/12 – 7/12). El tablero ocupa las dos filas
            de la derecha; las preguntas van explícitas a la fila 2 de la
            izquierda para que el DOM conserve el orden feedback → tablero →
            docs (es el que leen la asistiva y el test del hub) y aun así el
            acordeón quede debajo del formulario. Las filas van `auto 1fr`: sin
            eso la grilla reparte la altura del tablero entre las dos filas y
            deja 140px de hueco entre el botón Enviar y el acordeón (medido en
            Chromium a 1280). Debajo de lg el DOM no cambia; `order-first` en
            HelpCenter pone las preguntas arriba. */}
        <div className="mt-4 grid gap-6 lg:grid-cols-[5fr_7fr] lg:grid-rows-[auto_1fr] lg:gap-x-8">
          <AyudaFeedback labels={feedbackLabels} />

          <section
            aria-labelledby="ayuda-roadmap-heading"
            className="grid content-start gap-4 lg:row-span-2"
          >
            <div>
              <h2
                id="ayuda-roadmap-heading"
                className="font-sans text-base leading-tight font-semibold"
              >
                {t('roadmap.heading')}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                {t('roadmap.hint')}
              </p>
            </div>
            <RoadmapBoard cards={cards} labels={boardLabels} />
          </section>

          <HelpCenter
            copy={docsCopy}
            className="order-first lg:order-none lg:col-start-1 lg:row-start-2"
          />
        </div>
      </div>
    </div>
  )
}
