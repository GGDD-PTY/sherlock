import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Effect, Option, Schema } from 'effect'

import { runRouteEffect } from '@/lib/api/effect-route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ROUTE = '/api/dev/jwks'
const JWKS_PATH = join(process.cwd(), '.convex-local', 'dev-jwks.json')
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const JwksDocumentSchema = Schema.Struct({
  keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeJwks = Schema.decodeUnknownOption(JwksDocumentSchema)

const DEV_NOT_FOUND_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

function notFound(): Response {
  return new Response(null, { status: 404, headers: DEV_NOT_FOUND_HEADERS })
}

function isDevAuthEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return (
    process.env.NEXT_PUBLIC_BYPASS_AUTH === 'true' ||
    process.env.BYPASS_AUTH === 'true' ||
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED === 'true'
  )
}

function isLoopbackRequest(request: Request): boolean {
  try {
    const url = new URL(request.url)
    return LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

const getJwks = Effect.fn('DevJwks.GET')(function* (request: Request) {
  if (!isDevAuthEnabled() || !isLoopbackRequest(request)) return notFound()
  if (!existsSync(JWKS_PATH)) return notFound()

  const parsed = yield* Effect.sync(() => {
    try {
      return JSON.parse(readFileSync(JWKS_PATH, 'utf8')) as unknown
    } catch {
      return null
    }
  })
  const document = decodeJwks(parsed)
  if (Option.isNone(document)) return notFound()

  return Response.json(document.value, { headers: DEV_NOT_FOUND_HEADERS })
})

export function GET(request: Request): Promise<Response> {
  return runRouteEffect(request, ROUTE, getJwks(request))
}

export function POST(): Response {
  return notFound()
}

export function PUT(): Response {
  return notFound()
}

export function PATCH(): Response {
  return notFound()
}

export function DELETE(): Response {
  return notFound()
}

export function OPTIONS(): Response {
  return notFound()
}
