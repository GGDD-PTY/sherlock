// ============================================================================
// VITEST SETUP
// ============================================================================
// Configuración global para todos los tests.
// Este archivo se ejecuta antes de cada test y proporciona mocks globales
// para dependencias externas como Convex, Next.js, etc.
// ============================================================================

import '@testing-library/jest-dom'
import { createElement, Fragment, type ReactNode } from 'react'
import { vi, afterEach, beforeEach } from 'vitest'

import esMessages from '../messages/es.json'

// Guest boundary tests share process.env across Vitest workers. Establish the
// test-only boundary without vi.stubEnv so another suite's vi.unstubAllEnvs()
// cannot erase it mid-request.
process.env.VDR_GUEST_SERVER_SECRET = 'server-boundary-secret-for-tests-123456789'
process.env.VDR_GUEST_SERVER_AUDIENCE = 'sherlock-test:guest-boundary'

// ============================================================================
// MOCK NEXT.JS
// ============================================================================

// ===== MOCK NEXT.JS ROUTER =====
const mockRouter = {
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
}

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ locale: 'es' }),
  redirect: vi.fn(),
  notFound: vi.fn(),
}))

// ===== MOCK NEXT/IMAGE =====
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => props,
}))

// ===== MOCK WORKOS AUTHKIT =====
vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: vi.fn().mockResolvedValue({ user: null }),
  getSignInUrl: vi.fn().mockResolvedValue('https://auth.workos.test/login'),
  getSignUpUrl: vi.fn().mockResolvedValue('https://auth.workos.test/signup'),
  handleAuth: vi.fn(() => vi.fn()),
  signOut: vi.fn(),
  authkit: vi.fn().mockResolvedValue({
    session: { user: null },
    headers: new Headers(),
    authorizationUrl: 'https://auth.workos.test/login',
  }),
  partitionAuthkitHeaders: vi.fn((_request: unknown, headers: Headers) => ({
    requestHeaders: new Headers(),
    responseHeaders: headers,
  })),
  applyResponseHeaders: vi.fn((response: unknown) => response),
}))

vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  AuthKitProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: vi.fn().mockReturnValue({
    user: null,
    loading: false,
    signOut: vi.fn(),
  }),
  useAccessToken: vi.fn().mockReturnValue({
    getAccessToken: vi.fn().mockResolvedValue(null),
    refresh: vi.fn().mockResolvedValue(null),
    accessToken: undefined,
    loading: false,
  }),
  useTokenClaims: vi.fn().mockReturnValue({ claims: {}, loading: false }),
}))

// ===== MOCK useAuth HOOK (nuestro wrapper) =====
vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn().mockReturnValue({
    user: null,
    isLoaded: true,
    isSignedIn: false,
    userId: null,
    signOut: vi.fn(),
    getToken: vi.fn().mockResolvedValue(null),
  }),
  default: vi.fn().mockReturnValue({
    user: null,
    isLoaded: true,
    isSignedIn: false,
    userId: null,
    signOut: vi.fn(),
    getToken: vi.fn().mockResolvedValue(null),
  }),
}))

// ===== MOCK PRISMA CLIENT =====
vi.mock('@/lib/db/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    profile: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    deal: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}))

// ============================================================================
// MOCK CONVEX
// ============================================================================

// ===== MOCK CONVEX REACT =====
vi.mock('convex/react', () => ({
  useQuery: vi.fn().mockReturnValue(undefined),
  useMutation: vi.fn().mockReturnValue(vi.fn()),
  useAction: vi.fn().mockReturnValue(vi.fn()),
  useConvex: vi.fn().mockReturnValue({
    query: vi.fn(),
    mutation: vi.fn(),
    action: vi.fn(),
  }),
  ConvexProvider: ({ children }: { children: ReactNode }) => children,
  ConvexReactClient: vi.fn(),
  // Los hooks que llaman queries autenticadas esperan a que Convex acepte el
  // token; el default del suite es "sesión ya establecida".
  useConvexAuth: vi.fn().mockReturnValue({
    isLoading: false,
    isAuthenticated: true,
    isRefreshing: false,
  }),
  Authenticated: ({ children }: { children: ReactNode }) => children,
  Unauthenticated: ({ children }: { children: ReactNode }) => children,
  AuthLoading: () => null,
}))

// ===== MOCK CONVEX NEXTJS =====
vi.mock('convex/nextjs', () => ({
  fetchQuery: vi.fn(),
  fetchMutation: vi.fn(),
  fetchAction: vi.fn(),
  preloadQuery: vi.fn(),
  ConvexClientProvider: ({ children }: { children: ReactNode }) => children,
}))

// ===== MOCK CONVEX API (generated) =====
vi.mock('../../../convex/_generated/api', () => ({
  internal: {
    notifications: { _recordEmailFailure: 'notifications:_recordEmailFailure' },
  },
  api: {
    deals: {
      list: 'deals:list',
      getDeal: 'deals:getDeal',
      createDeal: 'deals:createDeal',
      updateDeal: 'deals:updateDeal',
      search: 'deals:search',
    },
    companies: {
      getCompany: 'companies:getCompany',
      getByOwner: 'companies:getByOwner',
      createCompany: 'companies:createCompany',
      updateCompany: 'companies:updateCompany',
    },
    connections: {
      list: 'connections:list',
      create: 'connections:create',
      accept: 'connections:accept',
    },
    credits: {
      getBalance: 'credits:getBalance',
    },
    notifications: {
      list: 'notifications:list',
      markAsRead: 'notifications:markAsRead',
    },
    documents: {
      list: 'documents:list',
      get: 'documents:get',
    },
    ndas: {
      check: 'ndas:check',
      sign: 'ndas:sign',
    },
    debtAnalyses: {
      list: 'debtAnalyses:list',
      get: 'debtAnalyses:get',
    },
    equityValuations: {
      list: 'equityValuations:list',
      get: 'equityValuations:get',
    },
    activityLogs: {
      create: 'activityLogs:create',
    },
  },
}))

// ============================================================================
// MOCK NEXT-INTL
// ============================================================================

// El mock viejo era `useTranslations: () => (key) => key`: devolvia la clave e
// IGNORABA `values` por completo. Por ese agujero paso el bug del 2026-08-28, en
// que el boton de voto del roadmap se anunciaba como "roadmap.board.voteAria" a
// los lectores de pantalla: ningun test de componente podia notarlo, porque en
// el test la interpolacion nunca ocurria. Ahora el mock resuelve contra el
// catalogo real y formatea, asi que una interpolacion rota se ve en el test.
// Una clave ausente sigue devolviendo la clave, para no romper las suites que
// usan namespaces inventados a proposito.
function lookupMessage(path: string): string | undefined {
  let node: unknown = esMessages
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

// Formateador ICU minimo: cubre `{x}` y `{n, plural, one {...} other {...}}`,
// que es todo lo que usa el catalogo. No pretende ser next-intl; pretende que
// pasar `values` cambie el resultado, que es justo lo que el mock viejo no hacia.
function formatMessage(message: string, values?: Record<string, unknown>): string {
  // El cuerpo se toma con llaves BALANCEADAS. Un `[\s\S]*?` seguido de `}}`
  // cortaba en la primera llave doble y se comia el brazo `other`: todo plural
  // con count != 1 renderizaba vacio y ningun test lo notaba.
  const withPlurals = message.replace(
    /\{\s*(\w+)\s*,\s*plural\s*,((?:[^{}]|\{[^{}]*\})*)\}/g,
    (whole, name: string, body: string) => {
      const count = Number(values?.[name])
      if (Number.isNaN(count)) return whole
      const arms: Record<string, string> = {}
      for (const arm of body.matchAll(/(=?\w+)\s*\{([^{}]*)\}/g)) arms[arm[1]] = arm[2]
      const chosen = arms[`=${count}`] ?? (count === 1 ? arms.one : arms.other) ?? arms.other ?? ''
      return chosen.replace(/#/g, String(count))
    }
  )

  return withPlurals.replace(/\{\s*(\w+)\s*\}/g, (whole, name: string) =>
    values && name in values ? String(values[name]) : whole
  )
}

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const t = (key: string, values?: Record<string, unknown>) => {
      const path = namespace ? `${namespace}.${key}` : key
      const message = lookupMessage(path)
      return message === undefined ? path : formatMessage(message, values)
    }
    // El catálogo ya usa rich text (`<link>…</link>`): igual que next-intl, cada
    // par de tags llama a su renderer con el contenido y el texto suelto queda
    // como string entre los nodos.
    const rich = (key: string, values?: Record<string, (chunks: ReactNode) => ReactNode>) => {
      const path = namespace ? `${namespace}.${key}` : key
      const message = lookupMessage(path) ?? path
      const nodes: ReactNode[] = []
      const push = (node: ReactNode) =>
        nodes.push(createElement(Fragment, { key: `rich-${nodes.length}` }, node))
      const tagPattern = /<(\w+)>([\s\S]*?)<\/\1>/g
      let lastIndex = 0
      for (const match of message.matchAll(tagPattern)) {
        if (match.index > lastIndex) push(message.slice(lastIndex, match.index))
        const renderer = values?.[match[1]]
        push(renderer ? renderer(match[2]) : match[2])
        lastIndex = match.index + match[0].length
      }
      if (lastIndex < message.length) push(message.slice(lastIndex))
      return nodes
    }
    return Object.assign(t, { rich })
  },
  useLocale: () => 'es',
  useMessages: () => ({}),
  useNow: () => new Date(),
  useTimeZone: () => 'America/Mexico_City',
  useFormatter: () => ({
    number: (n: number) => n.toString(),
    dateTime: (d: Date) => d.toISOString(),
    relativeTime: (d: Date) => d.toISOString(),
  }),
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}))

// Mock Link component that returns a proper anchor element
const MockLink = ({
  children,
  href,
  prefetch,
  ...props
}: {
  children: ReactNode
  href: string
  prefetch?: boolean | 'auto' | null
  [key: string]: unknown
}) => {
  // React 19 no deja un booleano `false` en el DOM. `data-prefetch` es la
  // señal que los tests leen cuando un Link del panel apaga el prefetch.
  return createElement(
    'a',
    {
      ...props,
      href,
      ...(prefetch === false ? { 'data-prefetch': 'false' } : null),
    },
    children
  )
}

vi.mock('next-intl/navigation', () => ({
  Link: MockLink,
  redirect: vi.fn(),
  useRouter: () => mockRouter,
  usePathname: () => '/',
  // createNavigation is used by i18n/navigation.ts to create locale-aware navigation
  createNavigation: () => ({
    Link: MockLink,
    redirect: vi.fn(),
    useRouter: () => mockRouter,
    usePathname: () => '/',
    getPathname: () => '/',
  }),
}))

// ============================================================================
// MOCK POSTHOG
// ============================================================================

vi.mock('posthog-js', () => ({
  default: {
    __loaded: false,
    init: vi.fn(),
    capture: vi.fn(),
    captureException: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    people: {
      set: vi.fn(),
    },
  },
}))

vi.mock('posthog-js/react', () => ({
  usePostHog: vi.fn().mockReturnValue({
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
  }),
  useFeatureFlagEnabled: vi.fn().mockReturnValue(false),
  useFeatureFlagPayload: vi.fn().mockReturnValue(null),
  PostHogProvider: ({ children }: { children: ReactNode }) => children,
}))

// ============================================================================
// MOCK SONNER (Toast)
// ============================================================================

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
  Toaster: () => null,
}))

// ============================================================================
// MOCK ZUSTAND
// ============================================================================

// Zustand works well in tests by default, but we can add helpers if needed

// ============================================================================
// MOCK BROWSER APIS
// ============================================================================

// ===== MOCK INTERSECTION OBSERVER =====
const mockIntersectionObserver = vi.fn()
mockIntersectionObserver.mockReturnValue({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
})
global.IntersectionObserver = mockIntersectionObserver

// ===== MOCK RESIZE OBSERVER =====
// Clase, no `vi.fn()`: el visor de PDF hace `new ResizeObserver(...)` para
// ajustar la pagina al ancho, y un spy con `mockReturnValue` lanza al llamarse
// con `new` (vitest 4). Con la clase, cualquier componente puede construirlo.
class MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

// Node-only surfaces (the VDR read MCP reads XLSX and PDF through native and
// WASM code) run their tests with `@vitest-environment node`, and load this
// same setup file. The jsdom-only shims below are skipped there instead of
// crashing the whole file at import time.
const DOM_AVAILABLE = typeof window !== 'undefined'

// ===== MOCK MATCH MEDIA =====
if (DOM_AVAILABLE) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })

  // ===== MOCK SCROLL =====
  window.scrollTo = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
}

// ===== POINTER CAPTURE (jsdom no lo implementa) =====
// Radix (Select, Slider, Dropdown...) llama a estas tres en el handler de
// pointerdown. Sin ellas, abrir un <Select> desde un test lanza
// "target.hasPointerCapture is not a function" como error no capturado, aunque
// el componente funcione en un navegador real.
if (DOM_AVAILABLE) {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
}

// ===== MOCK CLIPBOARD =====
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  },
  writable: true,
})

// ===== MOCK URL.createObjectURL =====
URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url')
URL.revokeObjectURL = vi.fn()

// ============================================================================
// BLOB POLYFILLS (jsdom doesn't have arrayBuffer/text methods)
// ============================================================================

// Polyfill Blob.prototype.arrayBuffer if not available
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new (global.FileReader || FileReader)()
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result)
        } else {
          reject(new Error('Failed to read blob as ArrayBuffer'))
        }
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}

// Polyfill Blob.prototype.text if not available
if (!Blob.prototype.text) {
  Blob.prototype.text = function (): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new (global.FileReader || FileReader)()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result)
        } else {
          reject(new Error('Failed to read blob as text'))
        }
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsText(this)
    })
  }
}

// ============================================================================
// MOCK FILE API
// ============================================================================

// Note: We use jsdom's native FileReader with the Blob polyfills above
// No need to override FileReader since jsdom has a working implementation

// ============================================================================
// MOCK FETCH
// ============================================================================

// Default fetch mock - can be overridden in individual tests
global.fetch = vi.fn().mockImplementation(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    blob: () => Promise.resolve(new Blob()),
    headers: new Headers(),
  })
)

// ============================================================================
// CLEANUP
// ============================================================================

// ===== RESET MOCKS BEFORE EACH TEST =====
beforeEach(() => {
  // Reset router mocks
  mockRouter.push.mockClear()
  mockRouter.replace.mockClear()
  mockRouter.prefetch.mockClear()
  mockRouter.back.mockClear()
  mockRouter.forward.mockClear()
  mockRouter.refresh.mockClear()
})

// ===== CLEANUP AFTER EACH TEST =====
afterEach(() => {
  vi.clearAllMocks()
})

// ============================================================================
// EXPORT MOCK FUNCTIONS FOR TESTS
// ============================================================================

export { mockRouter }
