import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { agentAuthMdRewrite } from './src/lib/agent-auth-md'
import { localConvexCspOrigins, withCspOrigins } from './src/lib/security/local-convex-csp'

type BundleAnalyzerFactory = (options: {
  enabled: boolean
  openAnalyzer: boolean
}) => (config: NextConfig) => NextConfig

// ===== NEXT-INTL PLUGIN =====
// Carga los archivos de traducción y configura i18n
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')
const require = createRequire(import.meta.url)
const withBundleAnalyzer = (require('@next/bundle-analyzer') as BundleAnalyzerFactory)({
  enabled: process.env.ANALYZE === 'true',
  openAnalyzer: false,
})
const appRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(appRoot, '..', '..')

const nextConfig: NextConfig = {
  // `AGENTS.md` de esta carpeta es doctrina del repo y solo apunta al AGENTS.md raíz.
  // Con el default (`true`), cada `next dev` le appendea su bloque
  // `nextjs-agent-rules` y deja el árbol sucio antes de que alguien escriba una
  // línea. Los docs de la versión siguen en `node_modules/next/dist/docs/`.
  agentRules: false,

  allowedDevOrigins: ['127.0.0.1', 'localhost'],

  webpack: (config, { dev }) =>
    Effect.runSync(
      Effect.sync(() => {
        if (dev) {
          const ignored = config.watchOptions?.ignored
          // SQLite y blobs cambian durante los journeys; no son código fuente.
          config.watchOptions = {
            ...config.watchOptions,
            ignored:
              ignored instanceof RegExp
                ? new RegExp(
                    `${ignored.source}|(^|[/\\\\])\\.convex-local([/\\\\]|$)`,
                    ignored.flags
                  )
                : [
                    ...(Array.isArray(ignored) ? ignored : ignored ? [ignored] : []),
                    '**/.convex-local/**',
                  ],
          }
        }
        return config
      })
    ),

  // Prod anunciaba `x-powered-by: Next.js` en cada página (A14-S2): un banner
  // de versión que no sirve a nadie de este lado.
  poweredByHeader: false,

  // Keep Turbopack scoped to this repository instead of walking up to
  // machine-level lockfiles outside the workspace.
  turbopack: {
    root: repoRoot,
  },

  // El lambda de /api/vdr-mcp resuelve el addon nativo de MOG con un nombre
  // calculado por plataforma y el tracer no lo ve; pdfjs y @napi-rs/canvas ya
  // entran por los literales de src/lib/vdr-mcp/extract.ts. En Vercel el addon
  // es linux-x64-gnu.
  outputFileTracingIncludes: {
    '/api/vdr-mcp': ['../../node_modules/@mog-sdk/linux-x64-gnu/**'],
  },

  // ===== REACT COMPILER =====
  reactCompiler: true,

  // ===== POSTHOG PROXY (EVITA BLOQUEADORES) =====
  // Los ad-blockers bloquean requests a "posthog.com".
  // Solución: Reescribir /ingest/* → us.i.posthog.com/*
  // Esto hace que las requests parezcan ir a tu propio dominio.
  // Documentación: https://posthog.com/docs/advanced/proxy/nextjs
  async rewrites() {
    const authMdRewrite = agentAuthMdRewrite(
      process.env.MCP_OAUTH_ISSUER,
      process.env.VDR_MCP_ENABLED === 'true'
    )
    return {
      // beforeFiles se ejecuta ANTES de que Next.js busque archivos/páginas
      // Esto es CRÍTICO para que el rewrite funcione correctamente
      beforeFiles: [
        ...(authMdRewrite === null ? [] : [authMdRewrite]),
        // Assets estáticos de PostHog (session replay scripts, etc.)
        {
          source: '/ingest/static/:path*',
          destination: 'https://us-assets.i.posthog.com/static/:path*',
        },
        // Todos los demás endpoints de PostHog (batch, decide, flags, e, etc.)
        {
          source: '/ingest/:path*',
          destination: 'https://us.i.posthog.com/:path*',
        },
      ],
      afterFiles: [],
      fallback: [],
    }
  },

  // ===== SECURITY HEADERS =====
  // Headers de seguridad para prevenir ataques comunes (OWASP)
  async headers() {
    // ===== CONTENT SECURITY POLICY =====
    // CSP restrictivo para prevenir XSS, injection, y otros ataques.
    // - 'self': Solo permite recursos del mismo origen
    // - 'unsafe-inline': Necesario para Next.js styles (idealmente usar nonces en producción)
    // - 'unsafe-eval': Necesario para Next.js dev mode (removido en producción)
    // - Dominios específicos: Solo los servicios que usamos (WorkOS, Convex, etc.)
    const isDev = process.env.NODE_ENV === 'development'

    // `bun run dev:local` apunta el cliente Convex a http://127.0.0.1:3210 (y el
    // site URL a 3211); sin estos orígenes Chrome bloquea el WebSocket de sync
    // y ningún query del cliente llega. Fuera de dev, o con una URL de la nube,
    // las listas vienen vacías y la CSP no cambia ni en un byte.
    const localConvex = localConvexCspOrigins({
      isDev,
      convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
      convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? process.env.CONVEX_SITE_URL,
    })

    // WorkOS AuthKit is the active auth provider. The hosted sign-in/callback
    // navigation and the client-side access-token refresh flow need WorkOS
    // origins allowlisted, otherwise OAuth breaks under the strict prod CSP.
    const workosDomains = [
      'https://*.workos.com',
      'https://api.workos.com',
      'https://*.authkit.app',
    ].join(' ')

    const cspDirectives = [
      // Default: bloquear todo excepto lo explícitamente permitido
      "default-src 'self'",

      // Scripts: self + servicios necesarios
      // unsafe-eval solo en dev para hot reload de Next.js
      // unsafe-inline:
      // Next.js inyecta scripts inline de bootstrap/hidratación. Sin nonce todavía,
      // bloquear inline scripts rompe la app en producción local y previews.
      // Mantenemos unsafe-inline hasta migrar a CSP basada en nonces.
      // PostHog: us-assets.i.posthog.com para session replay scripts
      [
        "script-src 'self'",
        "'unsafe-inline'",
        isDev ? "'unsafe-eval'" : null,
        workosDomains,
        'https://challenges.cloudflare.com',
        'https://us-assets.i.posthog.com',
      ]
        .filter(Boolean)
        .join(' '),

      // Estilos: self + inline (Next.js lo requiere para CSS-in-JS)
      "style-src 'self' 'unsafe-inline'",

      // Imágenes: self + data URIs + servicios de imágenes
      withCspOrigins(
        "img-src 'self' data: blob: https://*.convex.cloud https://*.workos.com https://*.workoscdn.com",
        localConvex.imgSrc
      ),

      // Conexiones API: self + nuestros servicios backend
      // PostHog: us.i.posthog.com (API) + us-assets.i.posthog.com (session replay)
      withCspOrigins(
        `connect-src 'self' ${workosDomains} https://*.convex.cloud wss://*.convex.cloud https://us.i.posthog.com https://us-assets.i.posthog.com`,
        localConvex.connectSrc
      ),

      // Fonts: self + Google Fonts si los usamos
      "font-src 'self' data:",

      // Objects/embeds: bloquear (previene plugins maliciosos)
      "object-src 'none'",

      // Base URI: solo self (previene ataques de base tag)
      "base-uri 'self'",

      // Form actions: solo self
      "form-action 'self'",

      // Frame ancestors: none (ya tenemos X-Frame-Options: DENY)
      "frame-ancestors 'none'",

      // Frames: permitir WorkOS para auth widgets/redirects
      `frame-src 'self' ${workosDomains} https://challenges.cloudflare.com`,

      // Workers: self para service workers
      "worker-src 'self' blob:",

      // HSTS below handles real HTTPS production enforcement.
      // Do not emit `upgrade-insecure-requests` here because local `next start`
      // runs over HTTP and browsers upgrade localhost prefetches to broken HTTPS.
    ].join('; ')

    return [
      {
        // Aplicar a todas las rutas
        source: '/(.*)',
        headers: [
          // ===== CONTENT SECURITY POLICY =====
          // Principal defensa contra XSS y injection attacks
          { key: 'Content-Security-Policy', value: cspDirectives },

          // ===== HSTS (HTTP Strict Transport Security) =====
          // Fuerza HTTPS en producción - previene man-in-the-middle
          // max-age=31536000: 1 año
          // includeSubDomains: aplica a todos los subdominios
          // preload: permite incluir en lista de preload de navegadores
          ...(isDev
            ? []
            : [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=31536000; includeSubDomains; preload',
                },
              ]),

          // Previene clickjacking (iframe embedding)
          { key: 'X-Frame-Options', value: 'DENY' },

          // Previene MIME type sniffing
          { key: 'X-Content-Type-Options', value: 'nosniff' },

          // Controla información enviada en Referer header
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

          // NOTA: X-XSS-Protection REMOVIDO - deprecated y puede causar vulnerabilidades
          // Los navegadores modernos lo ignoran. CSP es la protección correcta.

          // Controla qué features del navegador puede usar el sitio
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
      {
        // ===== VISOR INLINE DEL VDR =====
        // El stream de PDF con ?disposition=inline se embebe en un <iframe>
        // mismo-origen (DocumentViewerDialog). El bloque global fija
        // X-Frame-Options: DENY + frame-ancestors 'none', que bloquearían ese
        // iframe; esta regla más específica los relaja SOLO a same-origin para
        // esta ruta (Next aplica la última regla coincidente por header key).
        // Se emite el CSP COMPLETO del sitio (no solo frame-ancestors): como
        // Next hace last-wins por key, un CSP parcial aquí reemplazaría todas
        // las directivas endurecidas del bloque global en esta ruta.
        // La ruta ya exige auth + grant single-use, así que el riesgo de
        // clickjacking se mantiene acotado.
        source: '/api/documents/access/:grantId',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: cspDirectives.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
          },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
      {
        // ===== SIDECAR MOG (visor XLSX del VDR) =====
        // `public/mog/` es un build de Vite servido como estático y montado en
        // un <iframe> mismo-origen desde XlsxViewer. Necesita dos relajaciones
        // sobre el bloque global, y NADA más:
        //   1. `frame-ancestors 'self'` + XFO SAMEORIGIN, como el visor inline.
        //   2. `'wasm-unsafe-eval'` en script-src: el motor de cálculo es un
        //      módulo WebAssembly de 41 MB y `WebAssembly.instantiate` está
        //      bloqueado por el script-src estricto sin esa fuente.
        // Se emite el CSP COMPLETO por la misma razón que el bloque de arriba:
        // Next hace last-wins por clave, así que un CSP parcial reemplazaría
        // todas las directivas endurecidas en esta ruta.
        source: '/mog/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: cspDirectives
              .replace("frame-ancestors 'none'", "frame-ancestors 'self'")
              .replace('script-src ', "script-src 'wasm-unsafe-eval' "),
          },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
      {
        // El bundle del sidecar lleva hash en el nombre (Vite): inmutable.
        // `index.html` NO entra aquí — se revalida para que un redeploy no
        // deje al iframe pidiendo assets que ya no existen.
        source: '/mog/assets/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        // Worker, cmaps, fuentes estándar y WASM de pdfjs-dist. Van versionados
        // con la dependencia, así que se cachean fuerte; no se embeben en un
        // iframe, por eso conservan el `frame-ancestors 'none'` global.
        source: '/pdfjs/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },

  // ===== IMAGE OPTIMIZATION =====
  images: {
    // Formatos modernos para mejor compresión
    formats: ['image/avif', 'image/webp'],
    // Device sizes para responsive images
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048],
    // Image sizes para imágenes más pequeñas
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    // Remote patterns for external image sources. Solo Convex: los logos de
    // Financial Modeling Prep, Clearbit y las fotos de Unsplash eran restos del
    // marketplace sin un solo caller en `src` (A14-S4) y ampliaban `/_next/image`.
    remotePatterns: [
      {
        // Convex Storage (avatars, logos, documents)
        protocol: 'https',
        hostname: '*.convex.cloud',
        pathname: '/api/storage/**',
      },
    ],
  },

  // ===== SERVER-ONLY PACKAGES (moved from experimental in Next.js 15) =====
  // Prevent server-only packages from being bundled in client
  // Saves ~4.6MB from client bundle
  serverExternalPackages: [
    'svix', // Webhook verification (4.4 MB)
    // VDR read MCP (Node runtime only, /api/vdr-mcp). Both ship optional
    // platform bindings that webpack must not try to resolve: @mog-sdk/sdk
    // reaches for @tauri-apps/api when bundled, and pdfjs-dist for canvas.
    // Leaving them external keeps them out of every client bundle too.
    '@mog-sdk/sdk',
    'pdfjs-dist',
  ],

  // ===== EXPERIMENTAL OPTIMIZATIONS =====
  experimental: {
    // 404 global brandeado (app/global-not-found.tsx) — sirve el /404 que
    // Vercel usa para rewrites con status 404 desde el proxy.
    globalNotFound: true,
    // El CSS viaja dentro del HTML en vez de tres <link> que bloquean el
    // render. Medido en la landing el 2026-09-11 con Lighthouse móvil: los tres
    // stylesheets costaban 1.2 s de bloqueo y, peor, escondían el @font-face
    // detrás de un salto de red — el navegador solo descubría Fraunces después
    // de bajar el CSS, así que la fuente entraba en el grafo del LCP. Con el
    // CSS en el HTML el hero pinta antes de que llegue nada más. El precio es
    // que el CSS no se cachea aparte; con Tailwind son 23 KB y el sitio vive
    // de primeras visitas (docs de Next: inlineCss, «Trade-Offs»).
    inlineCss: true,
    // Optimistic package imports - tree-shake large packages
    optimizePackageImports: [
      'lucide-react',
      // Radix UI (used by shadcn)
      '@radix-ui/react-accordion',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-popover',
      '@radix-ui/react-progress',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-select',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      // Form validation
      'zod',
    ],
  },
}

// ===== EXPORT WITH PLUGINS =====
const configWithIntl = withNextIntl(nextConfig)

export default withBundleAnalyzer(configWithIntl)
