import { expect, type Page, type TestInfo } from '@playwright/test'

const DEMO_DOCUMENTS_KEY = 'sherlock.demo.documents.v1'

export const SYNTHETIC_VDR_DOCUMENT_COUNT = 500
export const SYNTHETIC_VDR_MATCH_COUNT = 20

const SYNTHETIC_VDR_SCOPE = {
  companyId: 'demo_company_001',
} as const

const SYNTHETIC_FOLDERS = [
  'teaser',
  'management_presentation',
  'financials',
  'model',
  'cap_table',
  'qoe',
  'debt_schedule',
  'legal',
  'operations',
  'data_room_index',
] as const

// Reuse the four built-in demo IDs so the browser store replaces, rather than
// appends to, the default company documents. The fixture remains exactly 500.
const DEFAULT_DEMO_DOCUMENT_IDS = [
  'demo_doc_espave_teaser',
  'demo_doc_espave_financials',
  'demo_doc_espave_source_manifest',
  'demo_doc_espave_legal_diligence',
] as const

type SyntheticAccess = 'PUBLIC' | 'NDA_REQUIRED' | 'PRIVATE'

function classificationFor(accessLevel: SyntheticAccess) {
  if (accessLevel === 'PUBLIC') return 'PUBLIC_TEASER'
  if (accessLevel === 'PRIVATE') return 'RESTRICTED'
  return 'CONFIDENTIAL'
}

function buildSyntheticDocuments() {
  const createdAtBase = Date.parse('2026-08-02T12:00:00.000Z')

  return Array.from({ length: SYNTHETIC_VDR_DOCUMENT_COUNT }, (_, offset) => {
    const ordinal = offset + 1
    const accessLevel: SyntheticAccess =
      ordinal % 3 === 0 ? 'PUBLIC' : ordinal % 3 === 1 ? 'NDA_REQUIRED' : 'PRIVATE'
    const marker = ordinal % 25 === 0 ? ' needle alpha' : ''

    return {
      id:
        DEFAULT_DEMO_DOCUMENT_IDS[offset] ??
        `e2e_large_room_doc_${String(ordinal).padStart(4, '0')}`,
      companyId: SYNTHETIC_VDR_SCOPE.companyId,
      name: `Synthetic VDR document ${String(ordinal).padStart(4, '0')}${marker}`,
      accessLevel,
      classification: classificationFor(accessLevel),
      fileType: ordinal % 4 === 0 ? 'application/vnd.ms-excel' : 'application/pdf',
      folder: SYNTHETIC_FOLDERS[offset % SYNTHETIC_FOLDERS.length],
      createdAt: new Date(createdAtBase + offset * 1_000).toISOString(),
    }
  })
}

/**
 * Installs a browser-local, deterministic 500-document room.
 *
 * This fixture never calls Convex, a seed mutation, or a production endpoint.
 * Each Playwright BrowserContext receives an isolated localStorage snapshot.
 */
export async function installSyntheticLargeRoom(page: Page) {
  const documents = buildSyntheticDocuments()

  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value)
    },
    { key: DEMO_DOCUMENTS_KEY, value: JSON.stringify(documents) }
  )
}

async function settleResponsiveLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

export async function captureDomObservation(page: Page) {
  return page.evaluate(() => ({
    bodyNodes: document.body.querySelectorAll('*').length,
    rootClientWidth: document.documentElement.clientWidth,
    rootScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }))
}

export async function expectNoRootOverflow(page: Page, context: string) {
  await settleResponsiveLayout(page)
  const geometry = await captureDomObservation(page)

  expect(
    geometry.rootScrollWidth,
    `${context}: page width ${geometry.rootScrollWidth}px exceeds ${geometry.rootClientWidth}px`
  ).toBeLessThanOrEqual(geometry.rootClientWidth)
  expect(geometry.rootClientWidth).toBe(geometry.viewportWidth)

  return geometry
}

type SyntheticPerformanceObservation = {
  initialRenderMs?: number
  loadMoreMs?: number
  filterMs?: number
  initialDomNodes?: number
  expandedDomNodes?: number
  viewport?: { width: number; height: number }
}

/**
 * Timings are attached as advisory observations, not treated as backend p95s or
 * hard pass/fail gates. Deterministic DOM/window bounds remain real assertions.
 */
export async function attachSyntheticPerformanceObservation(
  testInfo: TestInfo,
  observation: SyntheticPerformanceObservation
) {
  await testInfo.attach('synthetic-vdr-performance-observation.json', {
    body: Buffer.from(
      JSON.stringify(
        {
          scope: 'browser-local deterministic fixture; not a backend p95 measurement',
          fixtureDocuments: SYNTHETIC_VDR_DOCUMENT_COUNT,
          advisoryThresholds: {
            initialRenderMs: 15_000,
            interactionMs: 5_000,
            domNodes: 7_500,
          },
          observation,
        },
        null,
        2
      )
    ),
    contentType: 'application/json',
  })
}
