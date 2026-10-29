// ============================================================================
// DEV AUTH CONFIG
// ============================================================================
import { Config, ConfigProvider, Effect, Schema } from 'effect'

// Configuración para determinar si el bypass de auth está activo.
// ============================================================================

const optionalString = (name: string) => Config.schema(Schema.UndefinedOr(Schema.String), name)

const devAuthConfig = Config.all({
  nodeEnv: optionalString('NODE_ENV'),
  publicBypassAuth: optionalString('NEXT_PUBLIC_BYPASS_AUTH'),
  serverBypassAuth: optionalString('BYPASS_AUTH'),
  publicDevAuthEnabled: optionalString('NEXT_PUBLIC_DEV_AUTH_ENABLED'),
})

function devAuthConfigProvider(): ConfigProvider.ConfigProvider {
  // Estas referencias estáticas conservan la sustitución de NEXT_PUBLIC_* que
  // hace Next en el bundle cliente; ConfigProvider queda como única frontera de
  // lectura para el programa Effect.
  return ConfigProvider.fromEnvRecord(
    {
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_BYPASS_AUTH: process.env.NEXT_PUBLIC_BYPASS_AUTH,
      BYPASS_AUTH: process.env.BYPASS_AUTH,
      NEXT_PUBLIC_DEV_AUTH_ENABLED: process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED,
    },
    { preserveEmptyStrings: true }
  )
}

// ===== ¿ESTÁ ACTIVO EL BYPASS? =====
// Solo se activa si:
// 1. BYPASS_AUTH=true (server) / NEXT_PUBLIC_BYPASS_AUTH=true (client)
// 2. NEXT_PUBLIC_DEV_AUTH_ENABLED=true (alias adicional para compatibilidad)
// 3. Estamos en desarrollo/test. En builds production se mantiene apagado para
//    que server y cliente rendericen el mismo arbol de auth.
const isDevAuthEnabledEffect = Effect.fn('DevAuth.isEnabled')(function* () {
  const config = yield* devAuthConfig.parse(devAuthConfigProvider())

  // ===== FLAG UNIFICADO (SERVER + CLIENT) =====
  // ES: En cliente solo existen NEXT_PUBLIC_*; en server usamos ambos.
  // EN: Client only has NEXT_PUBLIC_*; server can read both.
  const rawFlag = config.publicBypassAuth ?? config.serverBypassAuth ?? config.publicDevAuthEnabled

  // ===== SEGURIDAD + HIDRATACIÓN =====
  // ES: No activar el bypass en production builds. Si el cliente decide por
  // hostname pero el servidor no, Next hidrata un árbol distinto y rompe.
  // EN: Keep production builds deterministic and auth-safe.
  if (config.nodeEnv === 'production') {
    return false
  }

  return rawFlag === 'true'
})

// Puente síncrono para callers existentes (incluidos bundles React).
export function isDevAuthEnabled(): boolean {
  return Effect.runSync(isDevAuthEnabledEffect())
}

// ===== EXPORT PARA USO RÁPIDO =====
export const DEV_AUTH_ENABLED = isDevAuthEnabled()
