import type { Metadata } from 'next'
import { parseAppOrigin } from './app-url'

export const SITE_BRAND_NAME = 'Sherlock'

function resolvePublicAppUrl(): string {
  const production = process.env.NODE_ENV === 'production'
  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim()
  const origin = parseAppOrigin(
    configuredAppUrl || (production ? '' : 'http://localhost:3000'),
    production
  )
  if (!origin) {
    throw new Error('NEXT_PUBLIC_APP_URL must be a valid application origin (HTTPS in production).')
  }
  return origin
}
const PUBLIC_APP_URL = resolvePublicAppUrl()

// PNG a propósito: los scrapers sociales (X, LinkedIn, Slack, WhatsApp)
// no renderizan OG en SVG.
const SITE_OG_IMAGE = {
  url: '/og-image.png',
  width: 1200,
  height: 630,
} as const

const SITE_OPEN_GRAPH_LOCALE = 'es_PA'

export function getPublicAppUrl() {
  return PUBLIC_APP_URL
}

// Misma ruta que `VDR_MCP_AUDIENCE_PATH`, escrita acá para no meter el módulo
// del servidor MCP en el bundle del cliente.
const VDR_MCP_PATH = '/api/vdr-mcp'

// El endpoint MCP del cliente sale del host de este deployment, como el resto
// de las URLs absolutas: staging muestra y copia el suyo, no el de producción.
export function getPublicVdrMcpUrl(): string {
  return new URL(VDR_MCP_PATH, `${PUBLIC_APP_URL.replace(/\/$/, '')}/`).href
}

export function getPublicAppHost() {
  return new URL(PUBLIC_APP_URL).hostname.toLowerCase()
}

type LocalizedPageMetadataInput = {
  readonly locale: string
  readonly path: string
  readonly title: string
  readonly description: string
  readonly imageAlt: string
}

export function buildLocalizedPageMetadata({
  locale: _locale,
  path,
  title,
  description,
  imageAlt,
}: LocalizedPageMetadataInput): Metadata {
  const normalizedPath = path ? `/${path.replace(/^\/+/, '')}` : ''
  const canonical = `${PUBLIC_APP_URL}/es${normalizedPath}`
  const brandedTitle = `${title} | ${SITE_BRAND_NAME}`
  const image = {
    ...SITE_OG_IMAGE,
    alt: imageAlt,
  }

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: 'website',
      url: canonical,
      siteName: SITE_BRAND_NAME,
      locale: SITE_OPEN_GRAPH_LOCALE,
      title: brandedTitle,
      description,
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title: brandedTitle,
      description,
      images: [SITE_OG_IMAGE.url],
    },
  }
}
