import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RoadmapBoard,
  type RoadmapBoardLabels,
  type RoadmapCard,
} from '@/components/roadmap/RoadmapBoard'

const TOTALS = 'roadmap:getVoteTotals'

const mockUseQuery = vi.fn()
const mockVote = vi.fn()
const mockSubmitRequest = vi.fn()

// El mock global de next-intl en setup.ts devuelve la CLAVE e ignora `values`,
// que es justo el agujero por el que se colo el bug del aria: ningun test de
// componente podia cazar una interpolacion rota. Aqui se sustituye por uno que
// si formatea el plural ICU, para que el conteo se pruebe de verdad.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'votesCount') {
      const n = Number(values?.count ?? 0)
      return n === 1 ? '1 vote' : `${n} votes`
    }
    return key
  },
}))

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (reference: string) => (reference === 'roadmap:vote' ? mockVote : mockSubmitRequest),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    roadmap: {
      getVoteTotals: 'roadmap:getVoteTotals',
      getDeviceVotes: 'roadmap:getDeviceVotes',
      vote: 'roadmap:vote',
      submitFeatureRequest: 'roadmap:submitFeatureRequest',
    },
  },
}))

const labels: RoadmapBoardLabels = {
  sortTop: 'Top',
  sortNew: 'New',
  filterAll: 'All',
  filterFeature: 'Features',
  filterBug: 'Bugs',
  sortGroup: 'Sort',
  filterGroup: 'Filter',
  emptyBug: 'No bug reports yet',
  votesCapReached: 'You have used your 3 votes.',
  votedHint: 'You voted for this one.',
  doingColumn: 'In progress',
  doneColumn: 'Shipped',
}

function card(overrides: Partial<RoadmapCard> & Pick<RoadmapCard, 'key' | 'title'>): RoadmapCard {
  return {
    status: 'planned',
    board: 'feature',
    added: '2026-08',
    body: `${overrides.key} body`,
    statusLabel: 'Planned',
    // La página formatea el aria por tarjeta en el servidor; aquí se imita esa
    // salida ya resuelta, no una plantilla con `{title}`.
    voteAria: `Vote for ${overrides.title}`,
    unvoteAria: `Remove your vote from ${overrides.title}`,
    ...overrides,
  }
}

/** Lo que el servidor responde para un dispositivo con `voted` ya gastados. */
function deviceVotes(voted: string[] = [], cap = 3) {
  return { featureKeys: voted, remaining: Math.max(0, cap - voted.length), cap }
}

function setQueries({
  totals,
  votes,
}: {
  totals?: Record<string, number>
  votes?: ReturnType<typeof deviceVotes>
}) {
  mockUseQuery.mockImplementation((reference: string, args: unknown) => {
    if (reference === TOTALS) return totals
    if (args === 'skip') return undefined
    return votes
  })
}

function backlog() {
  return within(screen.getByTestId('roadmap-backlog'))
}

function backlogTitles(): string[] {
  return backlog()
    .queryAllByRole('heading', { level: 2 })
    .map((node) => node.textContent ?? '')
}

function voteButton(title: string): HTMLElement {
  return screen.getByRole('button', { name: `Vote for ${title}` })
}

function unvoteButton(title: string): HTMLElement {
  return screen.getByRole('button', { name: `Remove your vote from ${title}` })
}

beforeEach(() => {
  setQueries({ totals: undefined, votes: deviceVotes() })
  mockVote.mockResolvedValue({ accepted: true, voted: true, remaining: 2 })
  mockSubmitRequest.mockResolvedValue({ stored: true, duplicate: false })
})

describe('RoadmapBoard', () => {
  it('renders every count as zero while the totals query has no data', () => {
    render(
      <RoadmapBoard
        cards={[card({ key: 'alpha', title: 'Alpha' }), card({ key: 'beta', title: 'Beta' })]}
        labels={labels}
      />
    )

    expect(voteButton('Alpha')).toHaveTextContent('0')
    expect(voteButton('Beta')).toHaveTextContent('0')
  })

  it('orders by live totals and keeps registry order on a tie', () => {
    setQueries({ totals: { alpha: 5, beta: 5, gamma: 3 }, votes: deviceVotes() })

    render(
      <RoadmapBoard
        cards={[
          card({ key: 'alpha', title: 'Alpha' }),
          card({ key: 'beta', title: 'Beta' }),
          card({ key: 'gamma', title: 'Gamma' }),
        ]}
        labels={labels}
      />
    )

    expect(backlogTitles()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(voteButton('Alpha')).toHaveTextContent('5')
  })

  it('orders new cards by added month, then by live total', async () => {
    setQueries({
      totals: { 'old-high': 99, 'new-low': 1, 'new-high': 4 },
      votes: deviceVotes(),
    })

    render(
      <RoadmapBoard
        cards={[
          card({ key: 'old-high', title: 'Old high', added: '2026-07' }),
          card({ key: 'new-low', title: 'New low' }),
          card({ key: 'new-high', title: 'New high' }),
        ]}
        labels={labels}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'New' }))

    expect(backlogTitles()).toEqual(['New high', 'New low', 'Old high'])
  })

  it('keeps shipped and in-progress cards out of the votable backlog', () => {
    render(
      <RoadmapBoard
        cards={[
          card({ key: 'planned', title: 'Planned one' }),
          card({ key: 'interest', title: 'Interest one', status: 'gatheringInterest' }),
          card({ key: 'doing', title: 'Doing one', status: 'inProgress' }),
          card({ key: 'done', title: 'Done one', status: 'shipped' }),
        ]}
        labels={labels}
      />
    )

    expect(backlogTitles()).toEqual(['Planned one', 'Interest one'])

    const doing = within(screen.getByTestId('roadmap-doing'))
    const done = within(screen.getByTestId('roadmap-done'))
    expect(doing.getByRole('heading', { name: 'Doing one' })).toBeInTheDocument()
    expect(done.getByRole('heading', { name: 'Done one' })).toBeInTheDocument()

    // Las pilas de la derecha muestran conteos congelados, sin control de voto.
    expect(doing.queryAllByRole('button')).toHaveLength(0)
    expect(done.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Vote for Done one' })).not.toBeInTheDocument()
  })

  it('filters the backlog without touching the frozen stacks', async () => {
    render(
      <RoadmapBoard
        cards={[
          card({ key: 'feature', title: 'Feature request' }),
          card({ key: 'done', title: 'Done one', status: 'shipped' }),
        ]}
        labels={labels}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Bugs' }))

    expect(backlog().getByText('No bug reports yet')).toBeInTheDocument()
    expect(backlogTitles()).toEqual([])
    expect(
      within(screen.getByTestId('roadmap-done')).getByRole('heading', { name: 'Done one' })
    ).toBeInTheDocument()
  })

  it('names the control from the card, never from an unformatted message key', () => {
    render(<RoadmapBoard cards={[card({ key: 'alpha', title: 'Alpha' })]} labels={labels} />)

    // La regresión concreta: el board interpolaba `{title}` sobre un mensaje
    // que next-intl ya había resuelto a la ruta de la clave, y el botón se
    // anunciaba "roadmap.board.voteAria".
    expect(voteButton('Alpha')).toHaveAccessibleName('Vote for Alpha')
    expect(screen.queryByRole('button', { name: /roadmap\.board\./ })).not.toBeInTheDocument()
  })

  it('votes with the feature key and a server-shaped device token', async () => {
    render(<RoadmapBoard cards={[card({ key: 'alpha', title: 'Alpha' })]} labels={labels} />)

    await userEvent.click(voteButton('Alpha'))

    await waitFor(() => expect(mockVote).toHaveBeenCalledTimes(1))
    const [payload] = mockVote.mock.calls[0]
    expect(payload.featureKey).toBe('alpha')
    expect(payload.deviceToken).toMatch(/^[A-Za-z0-9-]{16,64}$/)
  })

  it('shows a vote this device already cast, without waiting for a click', () => {
    setQueries({ totals: { alpha: 4 }, votes: deviceVotes(['alpha']) })

    render(
      <RoadmapBoard
        cards={[card({ key: 'alpha', title: 'Alpha' }), card({ key: 'beta', title: 'Beta' })]}
        labels={labels}
      />
    )

    // El estado sale de la query, así que sobrevive a un recargue: antes vivía
    // sólo en React y cada recarga volvía a pintar todo como votable.
    expect(unvoteButton('Alpha')).toHaveAttribute('aria-pressed', 'true')
    expect(voteButton('Beta')).toHaveAttribute('aria-pressed', 'false')
    expect(backlog().getByText(/You voted for this one/)).toBeInTheDocument()
  })

  it('says "1 vote", not "1 votes", in the count read out to a screen reader', () => {
    setQueries({ totals: { alpha: 1, beta: 4 }, votes: deviceVotes() })

    render(
      <RoadmapBoard
        cards={[card({ key: 'alpha', title: 'Alpha' }), card({ key: 'beta', title: 'Beta' })]}
        labels={labels}
      />
    )

    expect(backlog().getByText(/^1 vote\b/)).toBeInTheDocument()
    expect(backlog().getByText(/^4 votes\b/)).toBeInTheDocument()
  })

  it('says "1 vote", not "1 votes", in Doing and Done frozen stacks', () => {
    setQueries({ totals: { doing: 1, done: 1 }, votes: deviceVotes() })

    render(
      <RoadmapBoard
        cards={[
          card({ key: 'doing', title: 'Doing one', status: 'inProgress' }),
          card({ key: 'done', title: 'Done one', status: 'shipped' }),
        ]}
        labels={labels}
      />
    )

    const doing = within(screen.getByTestId('roadmap-doing'))
    const done = within(screen.getByTestId('roadmap-done'))
    const doingAnnouncement = doing.getByText(/^1 vote\b/)
    const doneAnnouncement = done.getByText(/^1 vote\b/)
    expect(doingAnnouncement).toHaveClass('sr-only')
    expect(doneAnnouncement).toHaveClass('sr-only')
    expect(doing.queryByText(/^1 votes\b/)).not.toBeInTheDocument()
    expect(done.queryByText(/^1 votes\b/)).not.toBeInTheDocument()
  })

  it('sends a second click on a voted card as a removal', async () => {
    setQueries({ totals: { alpha: 4 }, votes: deviceVotes(['alpha']) })
    mockVote.mockResolvedValue({ accepted: true, voted: false, remaining: 3 })

    render(<RoadmapBoard cards={[card({ key: 'alpha', title: 'Alpha' })]} labels={labels} />)

    await userEvent.click(unvoteButton('Alpha'))

    await waitFor(() => expect(mockVote).toHaveBeenCalledTimes(1))
    expect(mockVote.mock.calls[0][0].featureKey).toBe('alpha')
  })

  it('locks the unvoted cards once the three-feature budget is spent', () => {
    setQueries({ totals: {}, votes: deviceVotes(['alpha', 'beta', 'gamma']) })

    render(
      <RoadmapBoard
        cards={[
          card({ key: 'alpha', title: 'Alpha' }),
          card({ key: 'beta', title: 'Beta' }),
          card({ key: 'gamma', title: 'Gamma' }),
          card({ key: 'delta', title: 'Delta' }),
        ]}
        labels={labels}
      />
    )

    expect(voteButton('Delta')).toBeDisabled()
    expect(voteButton('Delta')).toHaveAttribute('title', labels.votesCapReached)
    expect(backlog().getByText(labels.votesCapReached)).toBeInTheDocument()
  })

  it('leaves the spent votes removable so the budget is never a dead end', () => {
    setQueries({ totals: {}, votes: deviceVotes(['alpha', 'beta', 'gamma']) })

    render(
      <RoadmapBoard
        cards={[
          card({ key: 'alpha', title: 'Alpha' }),
          card({ key: 'beta', title: 'Beta' }),
          card({ key: 'gamma', title: 'Gamma' }),
          card({ key: 'delta', title: 'Delta' }),
        ]}
        labels={labels}
      />
    )

    expect(unvoteButton('Alpha')).toBeEnabled()
    expect(unvoteButton('Beta')).toBeEnabled()
    expect(unvoteButton('Gamma')).toBeEnabled()
  })

  // El formulario de peticiones salió del tablero: la única caja de texto del
  // hub vive arriba, en AyudaFeedback ([F] 2026-09-01). Sus casos viven ahora en
  // src/__tests__/components/AyudaFeedback.test.tsx.
  it('leaves the request box and its mailto fallback to the hub', () => {
    render(<RoadmapBoard cards={[card({ key: 'alpha', title: 'Alpha' })]} labels={labels} />)

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(mockSubmitRequest).not.toHaveBeenCalled()
  })
  it('announces a rejected vote while keeping the server count', async () => {
    setQueries({ totals: { feature: 2 }, votes: deviceVotes() })
    mockVote.mockRejectedValueOnce(new Error('network unavailable'))
    render(<RoadmapBoard cards={[card({ key: 'feature', title: 'Feature' })]} labels={labels} />)
    fireEvent.click(voteButton('Feature'))
    expect(await screen.findByRole('alert')).toHaveTextContent('voteError')
    expect(voteButton('Feature')).toHaveTextContent('2')
  })
})
