// ============================================================================
// PRODUCT TYPES
// ============================================================================
// Shared product-layer vocabulary for shells, states, and core entities.
// Keep these aligned with Convex schema + routing architecture.
//
// EL VOCABULARIO SE ESCRIBE UNA VEZ. Cada lista es un `Schema.Literals` y el
// tipo de TypeScript sale de ahí (`typeof X.Type`), no de un `as const`
// paralelo: agregar un rol o un shell en un solo lado deja de compilar.
// ============================================================================

import { Schema } from 'effect'

export const ActorRoleSchema = Schema.Literals(['GUEST', 'COMPANY', 'ADMIN'])
export const ACTOR_ROLES = ActorRoleSchema.literals
export type ActorRole = typeof ActorRoleSchema.Type

export const AppShellSchema = Schema.Literals(['PUBLIC', 'COMPANY', 'ADMIN'])
export const APP_SHELLS = AppShellSchema.literals
export type AppShell = typeof AppShellSchema.Type

const ProductCoreEntitySchema = Schema.Literals([
  'USER',
  'PROFILE',
  'COMPANY',
  'DOCUMENT',
  'ANALYSIS_RUN',
])
export const PRODUCT_CORE_ENTITIES = ProductCoreEntitySchema.literals

const RouteSurfaceSchema = Schema.Literals(['PUBLIC', 'SHARED', 'COMPANY', 'ADMIN'])
export const ROUTE_SURFACES = RouteSurfaceSchema.literals
type RouteSurface = typeof RouteSurfaceSchema.Type

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
export type AccessGate =
  | 'NONE'
  | 'AUTH'
  | 'ROLE_COMPANY'
  | 'ROLE_ADMIN'
  | 'OWNER_OR_ADMIN'
  | 'ACTIVE_NDA'
  | 'AUDIT_LOG_REQUIRED'

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type DataOwner = 'PLATFORM' | 'COMPANY' | 'ADMIN' | 'SHARED_USER' | 'SYSTEM'

// La forma de una ruta del producto. Vive acá, con el resto del vocabulario,
// porque hay dos sitios que declaran rutas: `product/architecture.ts` (todas
// las superficies) y `product/admin-routes.ts` (el panel del equipo, que
// además dice cómo se pinta cada ruta en la barra). Tenerla en uno de los dos
// haría que el otro importara de vuelta.
export interface ProductRouteDefinition {
  id: string
  paths: readonly string[]
  surface: RouteSurface
  shells: readonly AppShell[]
  roles: readonly ActorRole[]
  goal: string
  primaryCta: string
  secondaryCta?: string
  emptyState?: string
  gating: readonly AccessGate[]
  dataOwner: DataOwner
  analyticsEvent?: string
  entrypoints: readonly string[]
}

const KycStatusSchema = Schema.Literals([
  'PENDING',
  'SUBMITTED',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
  'RESUBMIT_REQUIRED',
])
export const KYC_STATUSES = KycStatusSchema.literals
