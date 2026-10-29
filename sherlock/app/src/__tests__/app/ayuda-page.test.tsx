import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import esMessages from '@/messages/es.json'

// Resuelve contra el catálogo real, no contra un mapa de copy a mano.
function resolve(locale: string, path: string): string {
  const root: unknown = esMessages
  const value = path
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], root)

  if (typeof value !== 'string') throw new Error(`missing message ${locale}:${path}`)
  return value
}

// El mock del servidor tambien FORMATEA: la página arma el aria de cada tarjeta
// con `t('board.voteAria', { title })` y un mock que ignore `values` dejaría el
// `{title}` crudo en el nombre accesible.
function format(message: string, values?: Record<string, unknown>): string {
  return message.replace(/\{\s*(\w+)\s*\}/g, (whole, name: string) =>
    values && name in values ? String(values[name]) : whole
  )
}

vi.mock('next-intl/server', () => ({
  getTranslations:
    async ({ locale, namespace }: { locale: string; namespace: string }) =>
    (key: string, values?: Record<string, unknown>) =>
      format(resolve(locale, `${namespace}.${key}`), values),
  setRequestLocale: vi.fn(),
}))

vi.mock('@/lib/site/brand', () => ({
  buildLocalizedPageMetadata: (input: Record<string, unknown>) => input,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: { getMyVdrWorkspace: 'companies:getMyVdrWorkspace' },
    support: { sendCompanyMessage: 'support:sendCompanyMessage' },
    roadmap: {
      getVoteTotals: 'roadmap:getVoteTotals',
      getDeviceVotes: 'roadmap:getDeviceVotes',
      vote: 'roadmap:vote',
      submitFeatureRequest: 'roadmap:submitFeatureRequest',
    },
  },
}))

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ hasRole: () => false }),
}))

// `mcp` entró con la tarjeta O4-02: la sala enlaza `/es/ayuda#mcp` desde la
// fila «Conecta tu agente», así que la pregunta y su ancla viven aquí.
// `price` entró con la tarjeta AU-08, al final: responde qué cuesta sin
// publicar precio ni bandas ([F] 2026-09-13 18:00).
const DOC_KEYS = ['upload', 'deliverables', 'room', 'mcp', 'contact', 'price'] as const
// Los votables del registry: el resto vive en las pilas congeladas de la derecha.
// `support` y `voting` pasaron a Construido ([F] 2026-09-06, auditoría F08);
// `vdr` y `deliverables` el 2026-09-11, así que en construcción solo queda `mcp`.
const BACKLOG_KEYS = ['guestRooms'] as const
const DONE_KEYS = ['support', 'voting', 'vdr', 'deliverables'] as const

async function renderPage(locale: string) {
  const { default: AyudaPage } = await import('@/app/[locale]/(public)/ayuda/page')
  return render(await AyudaPage({ params: Promise.resolve({ locale }) }))
}

// Las tarjetas del tablero también son h2, así que el orden se lee de los
// encabezados de sección — los únicos que llevan id — y no de todos los h2.
function sectionHeadings(container: HTMLElement): string[] {
  return [...container.querySelectorAll('h2[id^="ayuda-"]')].map((node) => node.textContent ?? '')
}

describe('ayuda hub', () => {
  it('opens the Spanish hub with its own identity', async () => {
    const locale = 'es'
    await renderPage(locale)

    expect(
      screen.getByRole('heading', { level: 1, name: resolve(locale, 'ayuda.title') })
    ).toBeInTheDocument()
    expect(screen.getByText(resolve(locale, 'ayuda.subtitle'))).toBeInTheDocument()
  })

  // El bug del 2026-08-27: dos cajas de texto en la pantalla de soporte. El hub
  // fusiona tres superficies y sigue teniendo exactamente una.
  it('ships exactly one text box on the whole page', async () => {
    await renderPage('es')

    const boxes = screen.getAllByRole('textbox')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toHaveAccessibleName(resolve('es', 'ayuda.feedback.label'))
    // El buscador del Centro de Ayuda viejo era el segundo campo de texto.
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('orders the page: feedback, then roadmap, then docs', async () => {
    const { container } = await renderPage('es')

    expect(sectionHeadings(container)).toEqual([
      resolve('es', 'ayuda.feedback.heading'),
      resolve('es', 'ayuda.roadmap.heading'),
      resolve('es', 'ayuda.docs.heading'),
    ])
  })

  it('renders the roadmap as one votable row per item, with counts at zero', async () => {
    await renderPage('es')

    for (const key of BACKLOG_KEYS) {
      const title = resolve('es', `roadmap.board.items.${key}.title`)
      // El nombre accesible es el mensaje ya interpolado, no la ruta de la clave.
      const button = screen.getByRole('button', {
        name: format(resolve('es', 'roadmap.board.voteAria'), { title }),
      })
      expect(button).toHaveTextContent('0')
      expect(button).toHaveAttribute('aria-pressed', 'false')
    }
    expect(
      screen.queryByRole('heading', {
        name: resolve('es', 'roadmap.board.items.marketplace.title'),
      })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /roadmap\.board\./ })).not.toBeInTheDocument()

    const doing = within(screen.getByTestId('roadmap-doing'))
    expect(
      doing.getByRole('heading', { name: resolve('es', 'roadmap.board.items.mcp.title') })
    ).toBeInTheDocument()

    // Lo construido va en la pila de la derecha, sin control de voto.
    const done = within(screen.getByTestId('roadmap-done'))
    for (const key of DONE_KEYS) {
      const title = resolve('es', `roadmap.board.items.${key}.title`)
      expect(done.getByRole('heading', { name: title })).toBeInTheDocument()
      expect(
        screen.queryByRole('button', {
          name: format(resolve('es', 'roadmap.board.voteAria'), { title }),
        })
      ).not.toBeInTheDocument()
    }
  })

  // Auditoría 2026-09-06 (F08): el tablero dice lo que existe. Sin «Mycroft»
  // de cara al cliente y sin marcas de agua ni bitácora que el producto no da.
  it('names only what the product has today on the roadmap cards', () => {
    const items = JSON.stringify(
      (esMessages as { roadmap: { board: { items: unknown } } }).roadmap.board.items
    )

    expect(items).not.toMatch(/mycroft/i)
    expect(items).not.toMatch(/marcas de agua|bitácora/i)
    expect(resolve('es', 'roadmap.board.items.intake.title')).toBe('Carga de documentos')
  })

  it('keeps the roadmap filters working inside the hub', async () => {
    await renderPage('es')

    await userEvent.click(
      screen.getByRole('button', { name: resolve('es', 'roadmap.board.filters.bug') })
    )

    expect(screen.getByText(resolve('es', 'roadmap.board.empty.bug'))).toBeInTheDocument()
  })

  it.each(['es'] as const)('answers the %s operating questions', async (locale) => {
    await renderPage(locale)

    for (const key of DOC_KEYS) {
      expect(
        screen.getByRole('button', { name: resolve(locale, `ayuda.docs.items.${key}.q`) })
      ).toBeInTheDocument()
    }
  })

  // El enlace «Cómo funciona» de la sala cae en `/es/ayuda#mcp`: sin el id en
  // la fila, el ancla aterriza arriba de la página y el cliente no encuentra
  // el comando.
  it('anchors every question by its key, closed, so /es/ayuda#mcp lands on the row', async () => {
    const { container } = await renderPage('es')

    for (const key of DOC_KEYS) {
      const item = container.querySelector(`#${key}`)
      expect(item, `missing anchor #${key}`).not.toBeNull()
      expect(item).toHaveAttribute('data-state', 'closed')
    }
    expect(
      [...container.querySelectorAll('[data-slot="accordion-item"]')].map((node) => node.id)
    ).toEqual([...DOC_KEYS])

    const mcpAnswer = resolve('es', 'ayuda.docs.items.mcp.a')
    expect(mcpAnswer).toContain('URL MCP de tu instalación')
    expect(mcpAnswer).not.toContain('sherlock.capital')
    expect(mcpAnswer).toContain('la misma cuenta')
    // Desde #624 y #631 el agente también sube documentos a la sala.
    expect(mcpAnswer).toContain('subir documentos')
    expect(mcpAnswer).not.toContain('solo lee')

    // Qué cuesta se conversa: la respuesta no publica un precio ni una banda.
    expect(resolve('es', 'ayuda.docs.items.price.a')).not.toMatch(/\$|USD|\d/)
  })

  // Llegar por `/es/ayuda#mcp` desde la sala abre ESA pregunta y deja las demás
  // cerradas; volver al mismo enlace no recarga la página, así que el acordeón
  // también escucha `hashchange`.
  it('opens the row named by the hash, and follows a later hashchange', async () => {
    try {
      window.location.hash = '#mcp'
      const { container } = await renderPage('es')

      await waitFor(() => {
        expect(container.querySelector('#mcp')).toHaveAttribute('data-state', 'open')
      })
      expect(container.querySelector('#upload')).toHaveAttribute('data-state', 'closed')

      window.location.hash = '#upload'

      await waitFor(() => {
        expect(container.querySelector('#upload')).toHaveAttribute('data-state', 'open')
      })
      expect(container.querySelector('#mcp')).toHaveAttribute('data-state', 'closed')

      // Volver atrás hasta la página sin ancla la deja como se mide.
      window.location.hash = ''

      await waitFor(() => {
        expect(container.querySelector('#upload')).toHaveAttribute('data-state', 'closed')
      })
    } finally {
      window.location.hash = ''
    }
  })

  // Un porcentaje suelto en el hash hace lanzar a `decodeURIComponent`. Dentro
  // de un efecto eso tumba la página: aquí solo significa que no abre nada.
  it('survives a hash it cannot decode', async () => {
    try {
      window.location.hash = '#%'
      const { container } = await renderPage('es')

      expect(container.querySelectorAll('[data-slot="accordion-item"]').length).toBe(
        DOC_KEYS.length
      )
      for (const key of DOC_KEYS) {
        expect(container.querySelector(`#${key}`)).toHaveAttribute('data-state', 'closed')
      }
    } finally {
      window.location.hash = ''
    }
  })

  // «Deal desk» está vetado como posicionamiento: se dice «el equipo».
  it('never says deal desk and never sells inside the docs', async () => {
    const docs = JSON.stringify((esMessages as Record<string, unknown>).ayuda)

    expect(docs).not.toMatch(/deal desk/i)
    expect(docs).not.toMatch(/marketplace|inversionista/i)
  })

  it('is indexable and carries its own localized metadata', async () => {
    const { generateMetadata } = await import('@/app/[locale]/(public)/ayuda/page')

    const metadata = await generateMetadata({ params: Promise.resolve({ locale: 'es' }) })

    expect(metadata.robots).toBeUndefined()
    expect(metadata).toMatchObject({
      locale: 'es',
      path: '/ayuda',
      title: resolve('es', 'ayuda.meta.title'),
      description: resolve('es', 'ayuda.meta.description'),
    })
  })
})
