import { Config, ConfigProvider, Effect, Exit, Schema } from 'effect'

// ES: Los HTTP actions de Convex no viven en el host de la API sino en el
// gesamplefoods `.convex.site` del mismo deployment. Se deriva de `NEXT_PUBLIC_CONVEX_URL`
// para que no exista una segunda variable capaz de apuntar a otro deployment.
// Falla cerrado: cualquier host que no sea el del deployment devuelve null y
// quien llama contesta 503 en vez de mandar una prueba de servidor a un tercero.
// EN: derive the HTTP-actions origin from the API url; fail closed otherwise.

const API_SUFFIX = '.convex.cloud'
const SITE_SUFFIX = '.convex.site'

const convexDeploymentUrlSchema = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'https:' &&
    (url.hostname.endsWith(API_SUFFIX) || url.hostname.endsWith(SITE_SUFFIX))
      ? undefined
      : 'Expected an HTTPS Convex deployment URL'
  )
)

const convexDeploymentUrlConfig = Config.schema(convexDeploymentUrlSchema, 'NEXT_PUBLIC_CONVEX_URL')

const resolveConvexSiteOriginEffect = Effect.fn('ConvexSite.resolveOrigin')(function* (
  convexUrl: string | undefined
) {
  const provider = ConfigProvider.fromEnvRecord(
    { NEXT_PUBLIC_CONVEX_URL: convexUrl },
    { preserveEmptyStrings: true }
  )
  const parsed = yield* Effect.exit(convexDeploymentUrlConfig.parse(provider))
  if (Exit.isFailure(parsed)) return null

  const url = parsed.value
  if (url.hostname.endsWith(SITE_SUFFIX)) return `https://${url.hostname}`

  return `https://${url.hostname.slice(0, -API_SUFFIX.length)}${SITE_SUFFIX}`
})

// Puente síncrono para los handlers existentes.
export function resolveConvexSiteOrigin(convexUrl: string | undefined): string | null {
  return Effect.runSync(resolveConvexSiteOriginEffect(convexUrl))
}
