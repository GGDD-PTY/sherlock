// ============================================================================
// DEV AUTH TYPES
// ============================================================================
// Tipos para el sistema de autenticación de desarrollo.
// Solo se usa cuando BYPASS_AUTH=true
// ============================================================================

// Relativo, no `@/`: `convex/_localSeed.ts` importa este módulo y lo typechequea
// bajo `convex/tsconfig.json`, que no conoce el alias.
import { Effect, Schema } from 'effect'

import { ActorRoleSchema } from '../product/types'

// ===== ROLES DISPONIBLES =====
// ADMIN y COMPANY salen del vocabulario de producto con `pick`: dev-auth no
// puede inventar un rol que el resto de la app no conozca, y renombrar uno
// allá rompe acá.
export const DevRoleSchema = ActorRoleSchema.pick(['ADMIN', 'COMPANY'])
export type DevRole = typeof DevRoleSchema.Type

// ===== EL DOMINIO CERRADO DE LOS CORREOS DE PRUEBA =====
// El bypass ya no vive de una lista de dos correos: `seed:company` fabrica un
// dueño por empresa y su correo lo escribe quien siembra ([F] D1, tarjeta
// O3-01). Lo que sigue cerrado —y es lo único que hace alcanzable el camino de
// bypass— es el dominio: `@dev.local` no resuelve en ninguna red, así que un
// correo real no entra por descuido ni en `DEV_USERS` ni por el campo del
// dev-login. La parte local no puede ser vacía: `@dev.local` a secas no
// identifica a nadie y produciría un slug de identidad compartido.
export const DevUserEmailSchema = Schema.TemplateLiteral([
  Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  '@dev.local',
])
export type DevUserEmail = typeof DevUserEmailSchema.Type

// El emisor sintético de las identidades de desarrollo. `auth.identity.ts`
// resuelve el proveedor por este valor; los dos fijos y los dueños sembrados
// (`seed-identity.ts`) tienen que declarar el mismo.
export const DEV_WORKOS_ISSUER = 'https://api.workos.com/'

// Identidad WorkOS sintética del admin local. `_localSeed.ts` liga este mismo
// subject a la fila real; el session id solo existe durante `dev:local`.
export const DEV_ADMIN_WORKOS_USER_ID = 'dev_admin_001_workos'
const DEV_ADMIN_LOCAL_SESSION_ID = 'dev_admin_001_local_session'

// ===== USUARIO DE DESARROLLO =====
export interface DevUser {
  id: string
  email: DevUserEmail
  name: string
  firstName: string
  lastName: string
  imageUrl: string | null
  role: DevRole
  providerUserId: string
  /** Con qué identidad se impersona a este usuario en el backend Convex LOCAL
   *  (`local-convex-identity.ts`). `issuer` decide el proveedor que resuelve
   *  `_helpers/auth.identity.ts` y `subject` es lo que la fila de `users`
   *  guarda para ese proveedor. */
  convexIdentity: { subject: string; issuer: string; sessionId?: string }
}

// ===== ESTADO DE AUTH =====
export interface DevAuthState {
  isLoaded: boolean
  isSignedIn: boolean
  user: DevUser | null
  // Role actual (admin puede switchear)
  currentRole: DevRole | null
}

// ===== USUARIOS FAKE PREDEFINIDOS =====
export const DEV_USERS: DevUser[] = [
  {
    id: 'dev_admin_001',
    providerUserId: 'dev_admin_001',
    email: 'admin@dev.local',
    name: 'Dev Admin User',
    firstName: 'Dev',
    lastName: 'Admin',
    imageUrl: null,
    role: 'ADMIN',
    // El seed local conserva `clerkId` para el fallback de dev-auth, pero liga
    // esta identidad WorkOS a la misma fila para ejercitar los guards reales.
    convexIdentity: {
      subject: DEV_ADMIN_WORKOS_USER_ID,
      issuer: DEV_WORKOS_ISSUER,
      sessionId: DEV_ADMIN_LOCAL_SESSION_ID,
    },
  },
  {
    id: 'dev_company_001',
    providerUserId: 'dev_company_001',
    email: 'company@dev.local',
    name: 'Sample Hydro, S. A.',
    firstName: 'Sample',
    lastName: 'Hydro',
    imageUrl: null,
    role: 'COMPANY',
    // Los seeds (`convex/_localSeed.ts`, `convex/_demoSeed.ts`) le parchan
    // `workosUserId = dev_company_001_workos` porque registrar documentos exige
    // subject WorkOS; con ese id puesto, una identidad Clerk se rechaza como
    // «sesión de proveedor incompatible». Se resuelve por `by_workosUserId`.
    convexIdentity: { subject: 'dev_company_001_workos', issuer: DEV_WORKOS_ISSUER },
  },
]

// ===== INTEGRIDAD DE LA LISTA =====
// `DevRole` y `DevUserEmail` ya pinnean cada campo en compile-time. Lo que el
// compilador no ve es la lista completa: dos filas con el mismo correo
// compilan igual de bien que dos filas distintas, y el bypass de auth resuelve
// "por correo" en más de un lugar (`_localSeed.ts`, `context.tsx`). Un
// duplicado ahí no es un error de tipos, es dos usuarios peleándose por la
// misma sesión. Con el dominio abierto a cualquier `*@dev.local`, este chequeo
// es además lo que impide que un correo real se cuele en las dos filas fijas.
const isDevRole = Schema.is(DevRoleSchema)
const isDevUserEmail = Schema.is(DevUserEmailSchema)

Effect.runSync(
  Effect.sync(() => {
    const seenEmails = new Set<string>()
    for (const user of DEV_USERS) {
      if (!isDevRole(user.role)) {
        throw new Error(`dev-auth: rol fuera de catálogo para "${user.email}": ${user.role}`)
      }
      if (!isDevUserEmail(user.email)) {
        throw new Error(`dev-auth: correo fuera de catálogo: ${user.email}`)
      }
      if (seenEmails.has(user.email)) {
        throw new Error(`dev-auth: correo repetido en DEV_USERS: ${user.email}`)
      }
      seenEmails.add(user.email)
    }
  }).pipe(Effect.withSpan('DevAuth.assertUsersIntegrity'))
)

// ===== STORAGE KEY =====
export const DEV_AUTH_STORAGE_KEY = 'sherlock_dev_auth'

// ===== COOKIE KEYS (SSR SYNC) =====
// ES: Cookies para que el servidor detecte el rol demo.
// EN: Cookies so the server can read demo role/user.
export const DEV_AUTH_COOKIE_USER = 'sherlock_dev_user'
export const DEV_AUTH_COOKIE_ROLE = 'sherlock_dev_role'
