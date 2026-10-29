// ============================================================================
// Sherlock UNIFIED - CONVEX SCHEMA
// ============================================================================
// Este schema define todas las tablas de la base de datos Convex.
// Equivalente al schema.prisma pero en TypeScript puro.
//
// Convex maneja automáticamente:
// - Migrations (no necesitas correr comandos)
// - Tipos (se generan automáticamente)
// - Real-time (todos los queries son reactivos)
//
// NOTA IMPORTANTE - Sectores e Industrias:
// Los campos sector/industry de `companies` son texto libre ([F] 2026-09-17).
// Ninguna lista cerrada alcanza para describir a una empresa de la región.
// ============================================================================

import { defineSchema, defineTable } from 'convex/server'
import { v, type VLiteral } from 'convex/values'
import { Schema } from 'effect'
import {
  deliverableKindValidator,
  deliverableProducerValidator,
  deliverableRenditionFormatValidator,
  deliverableStatusValidator,
} from './_deliverables/model'
import {
  intakeAssessmentReviewStateValidator,
  intakeAssessmentSourceValidator,
  intakeAssessmentStatusValidator,
  intakeClaimStatusValidator,
  intakeEventTypeValidator,
  intakeInspectionStatusValidator,
  intakeProofOperationValidator,
  intakeSessionStatusValidator,
  intakeStorageStateValidator,
  intakeUploadIntentStatusValidator,
} from './_intake/model'
import { supportMessageAuthorValidator, supportThreadScopeValidator } from './_support/model'

// ============================================================================
// UNIONES DE LITERALES — UNA LISTA, DOS CONSUMIDORES
// ============================================================================
// Los `defineTable` y los `v.*` se quedan: son lo que lee el codegen de Convex.
// Lo que cambia es de dónde salen las listas de literales.
//
// Hasta hoy cada estado, rol y tipo de evento se escribía a mano en cada tabla
// que lo usa. «ACTIVE | WITHDRAWN | REJECTED | REVOKED | EXPIRED | CLOSED»
// aparecía tres veces; el rol de workflow, cinco. Agregar un estado obligaba a
// encontrar todas las copias, y la que se olvidara no fallaba en el typecheck:
// fallaba en runtime, cuando una fila válida para una tabla resultaba inválida
// para la de al lado.
//
// Ahora la lista se escribe una sola vez como `Schema.Literals` y el validador
// de Convex se deriva de ella. La dirección Schema → validador es la canónica:
// es la que implementa Confect, la única integración Effect+Convex con una capa
// dedicada a esto (`packages/server/src/SchemaToValidator.ts` compila el
// `SchemaAST` en runtime — `Match.tag('Literal', …) => v.literal(l)`,
// `Match.tag('Union', …) => v.union(…)`), y su app de ejemplo le entrega a
// Convex un `defineSchema` armado así (`apps/example/convex/schema.ts`).
//
// Construir el validador en runtime es seguro porque Convex EVALÚA este módulo:
// el push serializa `validator.json` de cada tabla (`TableDefinition.export()`
// en `convex/dist/esm/server/schema.js`), no analiza el AST del archivo. Y
// `_generated/dataModel.d.ts` deriva del *tipo* de este `export default`, que el
// mapeo de abajo conserva literal por literal.
// ============================================================================

/**
 * El validador de Convex de una unión de literales, derivado de su `Schema`.
 *
 * Sin castes: `schema.literals` ya es la tupla de literales, y el tipo de la
 * unión que Convex publica —`VUnion<T[number]['type'], …>`— sale de ahí. Es lo
 * único que el codegen lee de un `v.union` de literales, así que anotar los
 * miembros como lista basta y el documento sigue tipado literal por literal.
 */
function literalValidator<const L extends readonly [string, string, ...Array<string>]>(
  schema: Schema.Literals<L>
) {
  const members: Array<VLiteral<L[number]>> = schema.literals.map((literal) => v.literal(literal))
  return v.union(...members)
}

/**
 * Una unión de literales con sus dos caras: el `Schema` de Effect (el que
 * decodifica y estrecha en la lógica) y el validador que lee el codegen.
 */
function literalSet<const L extends readonly [string, string, ...Array<string>]>(literals: L) {
  const schema = Schema.Literals(literals)
  return { schema, validator: literalValidator(schema) } as const
}

// Las uniones que más de una tabla comparte. Se exportan porque varias de ellas
// están escritas otra vez en `src/` (por ejemplo `lib/auth/provider-boundary.ts`
// y `components/company/vdr/config.ts`): converger esos archivos contra esta
// lista es un import, no una segunda copia.

/** Proveedor de identidad. Clerk sobrevive solo en filas históricas. */
export const AuthProvider = literalSet(['clerk', 'workos'])

/** Rol de producto. Solo existen estos dos ([F] 2026-09-16). */
export const ProfileRole = literalSet(['COMPANY', 'ADMIN'])

/**
 * Idioma persistido. El sitio ships solo en `es` ([F] 2026-09-03 23:30); `en`
 * se conserva porque las filas viejas lo traen, no porque haya segundo locale.
 */
export const StoredLocale = literalSet(['es', 'en'])

/** Rol de la beta por organización, mapeado desde los grupos de directorio. */
export const BetaRole = literalSet([
  'ADMIN',
  'COMPANY_OWNER',
  'COMPANY_MEMBER',
  'COUNSEL_REVIEWER',
])

/** Estado que WorkOS reporta para directorios, usuarios y grupos. */
export const DirectoryState = literalSet(['ACTIVE', 'INACTIVE', 'DELETED'])

/** Lo que un grant autoriza sobre un documento. */
export const RoomAccessAction = literalSet(['VIEW', 'DOWNLOAD'])

/** Qué busca la empresa. */
export const CapitalSeekingType = literalSet(['DEBT', 'EQUITY', 'BOTH', 'BRIDGE'])

/** Familia de bytes que el inspector reconoció, en intake y en la versión final. */
export const DocumentSignatureKind = literalSet(['PDF', 'ZIP', 'OLE', 'TEXT', 'UNKNOWN'])

/** Qué exige el documento para verse. Lo comparten el documento, el intent, el log y el grant. */
export const DocumentAccessLevel = literalSet(['PUBLIC', 'NDA_REQUIRED', 'PRIVATE'])

/** Qué tan sensible es el contenido. Mismos cuatro consumidores que `DocumentAccessLevel`. */
export const DocumentClassification = literalSet([
  'PUBLIC_TEASER',
  'CONFIDENTIAL',
  'RESTRICTED',
  'LEGAL',
  'KYC_SENSITIVE',
])

// ============================================================================
// SCHEMA DEFINITION
// ============================================================================

export default defineSchema({
  // ==========================================================================
  // USERS (Convex Auth maneja esto automáticamente, pero agregamos campos extra)
  // ==========================================================================
  // Nota: Convex Auth crea tablas 'users' y 'authSessions' automáticamente.
  // Aquí definimos campos adicionales que necesitamos.

  users: defineTable({
    // Provider-neutral auth identity. legacy Clerk identities persist alongside WorkOS.
    authProvider: v.optional(AuthProvider.validator),
    providerUserId: v.optional(v.string()),
    clerkId: v.optional(v.string()), // ID del usuario en Clerk
    workosUserId: v.optional(v.string()),

    // Campos del usuario
    email: v.string(), // Email del usuario (único)
    name: v.optional(v.string()), // Nombre completo
    image: v.optional(v.string()), // URL de avatar
    role: v.optional(ProfileRole.validator),

    // Estado de verificación
    emailVerified: v.optional(v.boolean()), // Si el email está verificado
  })
    .index('by_email', ['email']) // Para buscar usuarios por email
    .index('by_role', ['role']) // Para filtrar por rol
    .index('by_providerUserId', ['authProvider', 'providerUserId'])
    .index('by_workosUserId', ['workosUserId'])
    .index('by_clerkId', ['clerkId']), // Para buscar por Clerk ID

  // ==========================================================================
  // PROFILES
  // ==========================================================================
  // Datos adicionales del usuario (preferencias, verificación, etc.)

  profiles: defineTable({
    // Relación con User
    userId: v.id('users'),

    // Rol del usuario
    role: ProfileRole.validator,

    // Datos básicos
    fullName: v.optional(v.string()),
    phone: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),

    // Preferencias (union literals para type-safety)
    language: v.optional(StoredLocale.validator),
    timezone: v.optional(v.string()), // Demasiados para enumerar, se queda string
    emailNotifications: v.optional(v.boolean()), // default: true

    // Verificación
    isVerified: v.optional(v.boolean()), // default: false
    isActive: v.optional(v.boolean()), // default: true

    // Origen de la desactivación — decide si un evento del IdP puede reactivar.
    // ADMIN (panel admin, p.ej. AML/fraude) y USER (self-service) son PEGAJOSAS:
    // solo un admin reactiva. PROVIDER (user.deleted / deprovision de Directory
    // Sync) es sincronizable: un evento autoritativo del IdP la revierte.
    // Ausente + isActive:false = desactivación legacy sin origen conocido — se
    // trata como pegajosa (fail-closed para el caso AML).
    deactivatedBy: v.optional(
      v.union(v.literal('ADMIN'), v.literal('USER'), v.literal('PROVIDER'))
    ),
    deactivationReason: v.optional(v.string()),

    // KYC/AML Status (V2 Feature)
    // Status: PENDING, SUBMITTED, VERIFIED, REJECTED, EXPIRED
    kycStatus: v.optional(
      v.union(
        v.literal('PENDING'),
        v.literal('SUBMITTED'),
        v.literal('VERIFIED'),
        v.literal('REJECTED'),
        v.literal('EXPIRED'),
        v.literal('RESUBMIT_REQUIRED')
      )
    ),
    kycProvider: v.optional(v.string()), // 'stripe_identity', 'plaid', 'onfido', etc.
    kycVerifiedAt: v.optional(v.number()), // Timestamp when KYC was verified
    kycExpiresAt: v.optional(v.number()), // Timestamp when KYC expires (annual renewal)
    kycRejectionReason: v.optional(v.string()), // If rejected, why

    // ===== DENORMALIZED COUNTERS (PERFORMANCE OPTIMIZATION) =====
    // Estos campos se actualizan incrementalmente para evitar full table scans
    unreadMessageCount: v.optional(v.number()), // Contador de mensajes no leídos (default: 0)

    // ===== ONBOARDING =====
    // Track if user has explicitly confirmed their role during onboarding
    roleConfirmed: v.optional(v.boolean()), // true after role selection page
    usPersonAttestation: v.optional(
      v.object({
        isUsPerson: v.boolean(),
        source: v.union(v.literal('role-selection')),
        confirmedAt: v.number(),
      })
    ),
  })
    .index('by_userId', ['userId'])
    .index('by_role', ['role'])
    // El aviso al equipo lee ADMIN ACTIVOS. Filtrar `isActive` DESPUÉS del
    // `.take()` deja de notificar en silencio en cuanto 25 admins desactivados
    // ordenan antes que los vivos: la condición va dentro del rango del índice.
    .index('by_role_isActive', ['role', 'isActive'])
    .index('by_kycStatus', ['kycStatus']),

  // ==========================================================================
  // ORGANIZATION MEMBERSHIPS
  // ==========================================================================
  // Provider-neutral mapping between WorkOS organizations and Sherlock roles.
  // WorkOS orgs represent firms/workspaces; companies and VDR documents
  // remain first-class Sherlock business entities in Convex.

  organizationMemberships: defineTable({
    userId: v.id('users'),
    profileId: v.id('profiles'),
    authProvider: AuthProvider.validator,
    providerMembershipId: v.optional(v.string()),
    providerOrgId: v.string(),
    workosOrgId: v.optional(v.string()),
    name: v.optional(v.string()),
    betaRole: BetaRole.validator,
    profileRole: ProfileRole.validator,
    status: v.optional(v.union(v.literal('ACTIVE'), v.literal('INACTIVE'))),
    workosDirectoryId: v.optional(v.string()),
    workosDirectoryUserId: v.optional(v.string()),
    workosDirectoryGroupId: v.optional(v.string()),
    // Timestamp del OBJETO membership según el proveedor (no de la entrega):
    // permite la ordenación causal frente a eventos dsync entregados tarde.
    providerUpdatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index('by_userId', ['userId'])
    .index('by_profileId', ['profileId'])
    .index('by_providerMembershipId', ['authProvider', 'providerMembershipId'])
    .index('by_providerOrgId', ['authProvider', 'providerOrgId'])
    .index('by_workosOrgId', ['workosOrgId'])
    .index('by_workosDirectoryUserId', ['workosDirectoryUserId'])
    .index('by_workosDirectoryGroupId', ['workosDirectoryGroupId']),

  // Server-only authority binding between one Sherlock company and the exact
  // WorkOS organization allowed to operate it. Keeping provider locators out
  // of `companies` prevents public/company projections from leaking them.
  companyOrganizationBindings: defineTable({
    companyId: v.id('companies'),
    ownerProfileId: v.id('profiles'),
    authProvider: v.literal('workos'),
    providerOrgId: v.string(),
    createdAt: v.number(),
    createdByProfileId: v.id('profiles'),
    source: v.optional(
      v.union(v.literal('COMPANY_CREATE'), v.literal('BACKFILL'), v.literal('ADMIN_RESOLUTION'))
    ),
    updatedAt: v.optional(v.number()),
    updatedByProfileId: v.optional(v.id('profiles')),
    resolutionReason: v.optional(v.string()),
  })
    .index('by_companyId', ['companyId'])
    .index('by_providerOrgId', ['authProvider', 'providerOrgId']),

  companyAuthorizationControls: defineTable({
    key: v.literal('WORKOS_COMPANY_ORG_BINDING_V1'),
    status: v.union(v.literal('UNENFORCED'), v.literal('PREPARING'), v.literal('ENFORCED')),
    updatedAt: v.number(),
    inventoryEpoch: v.optional(v.string()),
    inventoryStartedAt: v.optional(v.number()),
    inventoryNextCursor: v.optional(v.string()),
    inventoryCompletedAt: v.optional(v.number()),
    activatedAt: v.optional(v.number()),
    activatedByProfileId: v.optional(v.id('profiles')),
  }).index('by_key', ['key']),

  // Durable, paginated rollout evidence. Cutover reads this compact ledger
  // instead of issuing several provider/binding queries per company in one
  // oversized Convex transaction.
  companyAuthorizationInventoryRows: defineTable({
    companyId: v.id('companies'),
    ownerProfileId: v.id('profiles'),
    epoch: v.string(),
    workosOwned: v.boolean(),
    status: v.union(
      v.literal('LEGACY'),
      v.literal('BOUND'),
      v.literal('UNRESOLVED'),
      v.literal('AMBIGUOUS'),
      v.literal('INVALID_BINDING')
    ),
    candidateCount: v.number(),
    bindingCount: v.number(),
    observedAt: v.number(),
  })
    .index('by_companyId', ['companyId'])
    .index('by_epoch', ['epoch'])
    .index('by_epoch_status', ['epoch', 'status']),

  // Delete-first WorkOS events need durable causal evidence even when neither
  // the local user nor membership row exists yet. A strictly newer provider
  // regrant consumes the tombstone; unresolved tombstones are retained.
  organizationMembershipTombstones: defineTable({
    authProvider: v.literal('workos'),
    providerMembershipId: v.string(),
    providerOrgId: v.string(),
    providerUserId: v.string(),
    providerUpdatedAt: v.optional(v.number()),
    deletedAt: v.number(),
  })
    .index('by_providerMembershipId', ['authProvider', 'providerMembershipId'])
    .index('by_providerOrgUser', ['authProvider', 'providerOrgId', 'providerUserId'])
    .index('by_providerUserId', ['authProvider', 'providerUserId']),

  // `user.deleted` puede llegar antes de la fila local. WorkOS no reutiliza
  // el id, así que el marcador es terminal: ni un membership posterior ni
  // `ensureCompanyWorkspace` pueden aprovisionar un perfil activo. Tabla
  // nueva: las filas actuales no cambian.
  providerUserTombstones: defineTable({
    authProvider: v.literal('workos'),
    providerUserId: v.string(),
    deletedAt: v.number(),
  }).index('by_providerUserId', ['authProvider', 'providerUserId']),

  workosDirectories: defineTable({
    directoryId: v.string(),
    workosOrgId: v.optional(v.string()),
    name: v.optional(v.string()),
    type: v.optional(v.string()),
    domains: v.optional(v.array(v.string())),
    state: DirectoryState.validator,
    active: v.boolean(),
    // Timestamp del OBJETO directory según el proveedor (no de la entrega):
    // permite descartar activaciones/shutdowns dsync entregados fuera de orden.
    providerUpdatedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index('by_directoryId', ['directoryId'])
    .index('by_workosOrgId', ['workosOrgId'])
    .index('by_active', ['active']),

  workosDirectoryUsers: defineTable({
    directoryUserId: v.string(),
    workosDirectoryId: v.string(),
    workosOrgId: v.optional(v.string()),
    workosUserId: v.optional(v.string()),
    userId: v.optional(v.id('users')),
    email: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    state: DirectoryState.validator,
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deprovisionedAt: v.optional(v.number()),
  })
    .index('by_directoryUserId', ['directoryUserId'])
    .index('by_workosDirectoryId', ['workosDirectoryId'])
    .index('by_workosOrgId', ['workosOrgId'])
    .index('by_userId', ['userId'])
    .index('by_email', ['email']),

  workosDirectoryGroups: defineTable({
    directoryGroupId: v.string(),
    workosDirectoryId: v.string(),
    workosOrgId: v.optional(v.string()),
    name: v.optional(v.string()),
    state: DirectoryState.validator,
    active: v.boolean(),
    mappedBetaRole: v.optional(BetaRole.validator),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index('by_directoryGroupId', ['directoryGroupId'])
    .index('by_workosDirectoryId', ['workosDirectoryId'])
    .index('by_workosOrgId', ['workosOrgId'])
    .index('by_mappedBetaRole', ['mappedBetaRole']),

  workosDirectoryGroupMemberships: defineTable({
    workosDirectoryId: v.string(),
    workosOrgId: v.optional(v.string()),
    directoryUserId: v.string(),
    directoryGroupId: v.string(),
    mappedBetaRole: v.optional(BetaRole.validator),
    active: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    removedAt: v.optional(v.number()),
  })
    .index('by_directoryUserId', ['directoryUserId'])
    .index('by_directoryGroupId', ['directoryGroupId'])
    .index('by_directoryUserId_active', ['directoryUserId', 'active'])
    .index('by_directoryGroupId_active', ['directoryGroupId', 'active'])
    .index('by_workosOrgId', ['workosOrgId']),

  // ==========================================================================
  // COMPANIES
  // ==========================================================================
  // Perfiles de empresas buscando capital

  companies: defineTable({
    // Dueño (Profile)
    ownerId: v.id('profiles'),

    // Marca de data sintética: true solo para registros creados por seeds
    // (seed.ts / seedGlobal.ts / seedLatinex.ts). Ausente = registro real.
    demo: v.optional(v.boolean()),

    // Información básica
    name: v.string(),
    legalName: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
    website: v.optional(v.string()),
    tagline: v.optional(v.string()),

    // Ubicación
    country: v.string(), // ISO code: PA, CO, MX, etc.
    city: v.optional(v.string()),
    address: v.optional(v.string()),

    // Clasificación Sectorial: texto libre ([F] 2026-09-17). El sector y la
    // industria los escribe la empresa con sus palabras; una lista cerrada
    // deja fuera al conglomerado que hace agro, alimentos y transporte.
    sector: v.optional(v.string()),
    industry: v.optional(v.string()),
    // Modelo de negocio: texto libre. Una lista cerrada nunca alcanza (un
    // conglomerado de agro, alimentos y vehículos no cabe en B2B/SAAS/...).
    businessModel: v.optional(v.string()),

    // Etapa de la empresa: texto libre ([F] 2026-09-17). La escalera de venture
    // (PRE_SEED, SEED, SERIES_A...) no describe a una empresa familiar con
    // treinta años de operación.
    stage: v.optional(v.string()),
    foundedYear: v.optional(v.number()),
    employeesCount: v.optional(v.number()),
    employees: v.optional(v.string()), // Rango: "10-50"
    revenueRange: v.optional(v.string()), // Rango: "$1M-$5M"

    // Descripción
    description: v.optional(v.string()),
    longDescription: v.optional(v.string()),
    mission: v.optional(v.string()),
    vision: v.optional(v.string()),

    // Financieros (usamos number en vez de Decimal)
    revenueCurrent: v.optional(v.number()),
    revenuePrevious: v.optional(v.number()),
    revenueGrowthYoy: v.optional(v.number()),
    grossMargin: v.optional(v.number()),
    ebitdaMargin: v.optional(v.number()),
    netMargin: v.optional(v.number()),
    totalAssets: v.optional(v.number()),
    totalLiabilities: v.optional(v.number()),
    totalEquity: v.optional(v.number()),
    currency: v.optional(v.string()), // default: "USD"

    // Qué buscan
    seekingAmount: v.optional(v.number()),
    seekingType: v.optional(CapitalSeekingType.validator),
    useOfFunds: v.optional(v.string()),
    // Términos buscados cuando hay deuda en juego ([F] 2026-09-07 09:00): el
    // equipo los necesita para el modelo y los decks de crédito.
    debtTermYears: v.optional(v.number()), // 1–30
    debtIndicativeRate: v.optional(v.number()), // % anual, dos decimales
    fundraisingTimeline: v.optional(
      v.union(
        v.literal('3_MONTHS'),
        v.literal('6_MONTHS'),
        v.literal('12_MONTHS'),
        v.literal('FLEXIBLE')
      )
    ), // Ej: "3_MONTHS", "6_MONTHS", "12_MONTHS", "FLEXIBLE"

    // Management team (array de objetos)
    managementTeam: v.optional(
      v.array(
        v.object({
          name: v.string(),
          title: v.string(),
          bio: v.optional(v.string()),
          linkedin: v.optional(v.string()),
        })
      )
    ),

    // Campos de onboarding Step 2 (texto libre para simplificar)
    foundersDescription: v.optional(v.string()), // Descripción libre de fundadores
    teamSize: v.optional(v.string()), // Tamaño del equipo como texto
    companyLinkedin: v.optional(v.string()), // URL de LinkedIn de la empresa

    // Onboarding
    onboardingStep: v.optional(v.number()), // default: 1
    onboardingCompletedAt: v.optional(v.number()), // timestamp

    // Visibilidad
    isPublic: v.optional(v.boolean()), // default: false
    isFeatured: v.optional(v.boolean()), // default: false
  })
    .index('by_ownerId', ['ownerId'])
    .index('by_isPublic', ['isPublic'])
    .index('by_isFeatured', ['isFeatured']), // For getFeaturedCompanies query

  // ==========================================================================
  // GUEST IDENTITY AND COMPANY-ROOM NDA EVIDENCE
  // ==========================================================================
  // Email verification creates identity only. A company-room invitation binds
  // explicit document versions and approved NDA text. Email and secrets stay
  // hashed.

  guestInvitations: defineTable({
    companyId: v.id('companies'),
    companyRoom: v.optional(
      v.object({
        documents: v.array(
          v.object({ documentId: v.id('documents'), versionId: v.id('documentVersions') })
        ),
        ndaTemplateId: v.id('guestNdaTemplates'),
      })
    ),
    guestId: v.string(),
    principalKey: v.string(),
    emailHash: v.string(),
    emailMasked: v.string(),
    invitationHandleHash: v.string(),
    status: v.union(
      v.literal('PENDING'),
      v.literal('VERIFIED'),
      v.literal('REVOKED'),
      v.literal('EXPIRED')
    ),
    createdAt: v.number(),
    createdByProfileId: v.id('profiles'),
    expiresAt: v.number(),
    verifiedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    revokedByProfileId: v.optional(v.id('profiles')),
    revokedReason: v.optional(v.string()),
    extendedAt: v.optional(v.number()),
    extendedByProfileId: v.optional(v.id('profiles')),
    // Idioma con el que se invitó al destinatario. Es la ÚNICA fuente válida
    // para todo email posterior (OTP incluido): esos correos salen fuera del
    // contexto del navegador, así que el locale del request no aplica.
    // Opcional por filas legacy: sin valor, la entrega asume español.
    locale: v.optional(StoredLocale.validator),
  })
    .index('by_company_status', ['companyId', 'status'])
    .index('by_company_emailHash', ['companyId', 'emailHash'])
    .index('by_invitationHandleHash', ['invitationHandleHash'])
    .index('by_principalKey', ['principalKey'])
    .index('by_expiresAt', ['expiresAt']),

  // Only ADMIN operators may configure the exact approved text. No default text.
  guestNdaTemplates: defineTable({
    companyId: v.id('companies'),
    title: v.string(),
    content: v.string(),
    contentHash: v.string(),
    locale: StoredLocale.validator,
    version: v.string(),
    active: v.boolean(),
    approvedAt: v.number(),
    approvedByProfileId: v.id('profiles'),
  }).index('by_company_locale_active', ['companyId', 'locale', 'active']),

  guestNdaAcceptances: defineTable({
    guestInvitationId: v.id('guestInvitations'),
    guestId: v.string(),
    companyId: v.id('companies'),
    templateId: v.id('guestNdaTemplates'),
    contentHash: v.string(),
    content: v.string(),
    signatoryName: v.string(),
    acceptedAt: v.number(),
  }).index('by_invitation', ['guestInvitationId']),

  guestOtpChallenges: defineTable({
    guestInvitationId: v.id('guestInvitations'),
    guestId: v.string(),
    challengeTokenHash: v.string(),
    otpSalt: v.string(),
    otpHash: v.string(),
    status: v.union(
      v.literal('ISSUED'),
      v.literal('USED'),
      v.literal('LOCKED'),
      v.literal('EXPIRED')
    ),
    attempts: v.number(),
    maxAttempts: v.number(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    cooldownUntil: v.number(),
    consumedAt: v.optional(v.number()),
    lockedAt: v.optional(v.number()),
  })
    .index('by_challengeTokenHash', ['challengeTokenHash'])
    .index('by_invitation_issuedAt', ['guestInvitationId', 'issuedAt'])
    .index('by_invitation_status', ['guestInvitationId', 'status'])
    .index('by_expiresAt', ['expiresAt']),

  guestSessions: defineTable({
    guestInvitationId: v.id('guestInvitations'),
    guestId: v.string(),
    principalKey: v.string(),
    sessionTokenHash: v.string(),
    status: v.union(
      v.literal('ACTIVE'),
      v.literal('ROTATED'),
      v.literal('REVOKED'),
      v.literal('EXPIRED')
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
    rotatedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
    revokedReason: v.optional(v.string()),
  })
    .index('by_sessionTokenHash', ['sessionTokenHash'])
    .index('by_invitation_status', ['guestInvitationId', 'status'])
    .index('by_expiresAt', ['expiresAt']),

  // ==========================================================================
  // TEMPORARY INTAKE
  // ==========================================================================

  intakeSessions: defineTable({
    sessionTokenHash: v.string(),
    anonymousKeyHash: v.string(),
    audience: v.string(),
    status: intakeSessionStatusValidator,
    identityEvidence: v.optional(
      v.object({
        kind: v.literal('NAME'),
        name: v.string(),
        capturedAt: v.number(),
      })
    ),
    claimDigest: v.optional(v.string()),
    claimStatus: intakeClaimStatusValidator,
    claimResult: v.optional(
      v.object({
        status: v.union(v.literal('SUCCEEDED'), v.literal('FAILED')),
        completedAt: v.number(),
        code: v.optional(v.string()),
      })
    ),
    claimedProfileId: v.optional(v.id('profiles')),
    claimedCompanyId: v.optional(v.id('companies')),
    createdAt: v.number(),
    accessExpiresAt: v.number(),
    absoluteExpiresAt: v.number(),
    deletionProofExpiresAt: v.number(),
    rotatedAt: v.optional(v.number()),
    rotationCount: v.number(),
    revokedAt: v.optional(v.number()),
    revokedReason: v.optional(v.string()),
    expiredAt: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    documentCount: v.number(),
    totalStagedBytes: v.number(),
  })
    .index('by_sessionTokenHash', ['sessionTokenHash'])
    .index('by_anonymousKey_status', ['anonymousKeyHash', 'status'])
    .index('by_status_accessExpiresAt', ['status', 'accessExpiresAt'])
    .index('by_claimDigest', ['claimDigest'])
    .index('by_claimedProfileId', ['claimedProfileId'])
    .index('by_claimedCompanyId', ['claimedCompanyId'])
    .index('by_deletionProofExpiresAt', ['deletionProofExpiresAt']),

  intakeDocuments: defineTable({
    intakeSessionId: v.id('intakeSessions'),
    uploadIntentId: v.id('intakeUploadIntents'),
    displayName: v.string(),
    declaredMimeType: v.string(),
    detectedMimeType: v.string(),
    byteSize: v.number(),
    sha256: v.string(),
    storageId: v.id('_storage'),
    storageState: intakeStorageStateValidator,
    inspectionStatus: intakeInspectionStatusValidator,
    claimable: v.boolean(),
    signatureKind: DocumentSignatureKind.validator,
    scannerEngine: v.optional(v.string()),
    scannerScanId: v.optional(v.string()),
    scannerDefinitionVersion: v.optional(v.string()),
    scannedAt: v.optional(v.number()),
    quarantineReason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_session_createdAt', ['intakeSessionId', 'createdAt'])
    .index('by_session_inspection', ['intakeSessionId', 'inspectionStatus'])
    .index('by_storageId', ['storageId'])
    .index('by_storageState', ['storageState']),

  intakeUploadIntents: defineTable({
    intakeSessionId: v.id('intakeSessions'),
    status: intakeUploadIntentStatusValidator,
    fileName: v.string(),
    declaredMimeType: v.string(),
    declaredByteSize: v.number(),
    declaredSha256: v.string(),
    storageId: v.optional(v.id('_storage')),
    documentId: v.optional(v.id('intakeDocuments')),
    rejectionReason: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    preparedAt: v.optional(v.number()),
    consumedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
    uncertainAt: v.optional(v.number()),
  })
    .index('by_session_status', ['intakeSessionId', 'status'])
    .index('by_session_sha_status', ['intakeSessionId', 'declaredSha256', 'status'])
    .index('by_status_expiresAt', ['status', 'expiresAt'])
    .index('by_storageId', ['storageId']),

  intakeAssessments: defineTable({
    intakeSessionId: v.id('intakeSessions'),
    status: intakeAssessmentStatusValidator,
    source: intakeAssessmentSourceValidator,
    findings: v.array(
      v.object({
        // `v.string()` a propósito: el catálogo vivo está en `_intake/model.ts`.
        // Estrechar aquí a esa unión rechazaría filas viejas con otra categoría.
        category: v.string(),
        evidenceDocumentIds: v.array(v.id('intakeDocuments')),
        confidence: v.number(),
        reviewState: intakeAssessmentReviewStateValidator,
      })
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_session', ['intakeSessionId'])
    .index('by_status_updatedAt', ['status', 'updatedAt']),

  intakeEvents: defineTable({
    intakeSessionId: v.id('intakeSessions'),
    type: intakeEventTypeValidator,
    documentId: v.optional(v.id('intakeDocuments')),
    uploadIntentId: v.optional(v.id('intakeUploadIntents')),
    outcomeCode: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_session_createdAt', ['intakeSessionId', 'createdAt'])
    .index('by_type_createdAt', ['type', 'createdAt']),

  intakeProofNonces: defineTable({
    proofDigest: v.string(),
    operation: intakeProofOperationValidator,
    intakeSessionId: v.optional(v.id('intakeSessions')),
    consumedAt: v.number(),
    expiresAt: v.number(),
  })
    .index('by_digest', ['proofDigest'])
    .index('by_expiresAt', ['expiresAt'])
    .index('by_sessionId', ['intakeSessionId']),

  // ==========================================================================
  // FRESH COMPANY ↔ TEAM SUPPORT
  // ==========================================================================

  supportThreads: defineTable({
    scope: supportThreadScopeValidator,
    scopeKey: v.string(),
    lastSequence: v.number(),
    adminReadThroughSequence: v.number(),
    clientReadThroughSequence: v.number(),
    adminUnreadCount: v.number(),
    clientUnreadCount: v.number(),
    adminUnread: v.boolean(),
    clientUnread: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastMessageAt: v.number(),
    // ===== EL TIMBRE DEL EQUIPO (convex/_support/teamEmail.ts) =====
    // Los cuatro son OPCIONALES: las filas que ya viven en producción no los
    // traen y siguen siendo válidas sin migración.
    // `adminEmailJobId` es el envío diferido vivo — la ráfaga lo cancela y lo
    // reprograma, así que tres mensajes seguidos siguen siendo un solo correo.
    // `adminEmailPendingSince` ancla el techo de ese debounce: un goteo no
    // puede posponer el aviso para siempre.
    // `adminEmailThroughSequence` es la primitiva de idempotencia — hasta qué
    // mensaje ya se avisó — y se escribe ANTES de encolar, igual que
    // `emailDispatchedAt` en `teamAlerts`.
    adminEmailJobId: v.optional(v.id('_scheduled_functions')),
    adminEmailPendingSince: v.optional(v.number()),
    adminEmailThroughSequence: v.optional(v.number()),
    adminEmailDispatchedAt: v.optional(v.number()),
  })
    .index('by_scopeKey', ['scopeKey'])
    .index('by_lastMessageAt', ['lastMessageAt'])
    .index('by_adminUnread_lastMessageAt', ['adminUnread', 'lastMessageAt']),

  supportMessages: defineTable({
    threadId: v.id('supportThreads'),
    sequence: v.number(),
    author: supportMessageAuthorValidator,
    body: v.string(),
    createdAt: v.number(),
  }).index('by_thread_sequence', ['threadId', 'sequence']),

  // ==========================================================================
  // DOCUMENTS
  // ==========================================================================
  // Documentos subidos por empresas (VDR - Virtual Data Room)

  documents: defineTable({
    companyId: v.id('companies'),

    // Información
    name: v.string(),
    description: v.optional(v.string()),
    // Tipo de archivo: PDF, XLSX, XLS, DOCX, DOC, PPTX, PPT, CSV, TXT, PNG, JPG, JPEG, OTHER
    fileType: v.optional(v.string()),
    fileSize: v.optional(v.number()), // Tamaño en bytes

    // Ubicación (Convex Storage ID)
    storageId: v.optional(v.id('_storage')),
    storagePath: v.optional(v.string()), // Para compatibilidad

    // Identidad lógica estable + punteros a blobs inmutables. Los campos son
    // opcionales durante la migración aditiva de documentos legacy.
    lifecycleStatus: v.optional(
      v.union(v.literal('ACTIVE'), v.literal('QUARANTINED'), v.literal('ARCHIVED'))
    ),
    currentVersionId: v.optional(v.id('documentVersions')),
    publishedVersionId: v.optional(v.id('documentVersions')),
    currentVersionNumber: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
    archivedByProfileId: v.optional(v.id('profiles')),

    // Acceso
    accessLevel: v.optional(DocumentAccessLevel.validator),
    classification: v.optional(DocumentClassification.validator),
    protectionPolicyVersion: v.optional(v.string()),
    // Última edición de metadata del documento. Ausente en documentos previos:
    // la capa de mapeo cae a `_creationTime`.
    updatedAt: v.optional(v.number()),
    folder: v.optional(v.string()), // default: "General"
    // TEAM_DELIVERABLE: lo que el equipo devolvió a la sala (`vdr:push` o
    // «Marcar como entrega»). La procedencia es un campo, no una heurística
    // sobre el nombre del archivo.
    sourceType: v.optional(
      v.union(
        v.literal('USER_UPLOAD'),
        v.literal('PUBLIC_SOURCE'),
        v.literal('SYNTHETIC_DEMO'),
        v.literal('TEAM_DELIVERABLE')
      )
    ),
    sourceUrl: v.optional(v.string()),
    sourceName: v.optional(v.string()),
    provenanceNotes: v.optional(v.string()),

    // ===== ACCESS EXPIRY (Trust Feature) =====
    // Permite que documentos expiren automáticamente
    expiresAt: v.optional(v.number()), // Timestamp cuando expira el acceso
    isExpired: v.optional(v.boolean()), // Flag para queries rápidas (actualizado por cron)
  })
    .index('by_companyId', ['companyId'])
    .index('by_classification_isExpired', ['classification', 'isExpired'])
    .index('by_expiresAt', ['expiresAt']) // Para cron de expiración
    .index('by_isExpired_expiresAt', ['isExpired', 'expiresAt'])
    .index('by_storagePath', ['storagePath'])
    .index('by_storageId', ['storageId']),

  // A direct-upload URL is never ambient authority for the VDR. The browser
  // first receives one short-lived intent whose immutable fields bind the
  // upload to an issuer, an exact room scope, and the expected file metadata.
  // The client-declared SHA-256 raises the cost of copying an unrelated
  // storageId into this flow: the caller must know the exact content/hash. It
  // still is not provider attestation that uploadUrl produced that storageId.
  // Terminal states are append-like evidence: intents are never recycled.
  vdrUploadIntents: defineTable({
    companyId: v.id('companies'),
    requestedByProfileId: v.id('profiles'),
    status: v.union(
      v.literal('ISSUED'),
      v.literal('ACTIVE'),
      v.literal('INSPECTING'),
      v.literal('UNCERTAIN'),
      v.literal('ABORTED'),
      v.literal('CONSUMED'),
      v.literal('REJECTED'),
      v.literal('EXPIRED')
    ),
    fileName: v.string(),
    declaredMimeType: v.string(),
    declaredByteSize: v.number(),
    declaredSha256: v.string(),
    replaceDocumentId: v.optional(v.id('documents')),
    name: v.string(),
    description: v.optional(v.string()),
    accessLevel: DocumentAccessLevel.validator,
    classification: v.optional(DocumentClassification.validator),
    // La clase de admisión: ausente es el VDR de siempre. Presente estrecha
    // mime y techo, y obliga a redactar antes de persistir.
    documentClass: v.optional(v.literal('SESSION_TRANSCRIPT')),
    folder: v.string(),
    documentExpiresAt: v.optional(v.number()),
    storageId: v.optional(v.id('_storage')),
    documentId: v.optional(v.id('documents')),
    documentVersionId: v.optional(v.id('documentVersions')),
    rejectionReason: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    preparedAt: v.optional(v.number()),
    uncertainAt: v.optional(v.number()),
    consumedAt: v.optional(v.number()),
    abortedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
  })
    .index('by_requester_status', ['requestedByProfileId', 'status'])
    .index('by_status_expiresAt', ['status', 'expiresAt'])
    .index('by_company_createdAt', ['companyId', 'createdAt'])
    .index('by_reconciliation_key_status', [
      'requestedByProfileId',
      'companyId',
      'replaceDocumentId',
      'declaredSha256',
      'status',
    ])
    .index('by_storageId', ['storageId']),

  // Public profile assets use a separate, purpose-bound upload authority.
  // These rows are terminal evidence: a raw Convex upload URL or storageId is
  // never enough to resolve bytes, and VDR upload intents are never reused as
  // a public-asset escape hatch.
  assetUploadIntents: defineTable({
    requestedByProfileId: v.id('profiles'),
    purpose: v.union(v.literal('AVATAR'), v.literal('LOGO')),
    status: v.union(
      v.literal('ISSUED'),
      v.literal('CONSUMED'),
      v.literal('REJECTED'),
      v.literal('EXPIRED')
    ),
    declaredMimeType: v.string(),
    declaredByteSize: v.number(),
    declaredSha256: v.string(),
    storageId: v.optional(v.id('_storage')),
    signatureKind: v.optional(
      v.union(v.literal('JPEG'), v.literal('PNG'), v.literal('GIF'), v.literal('WEBP'))
    ),
    malwareScanStatus: v.optional(v.union(v.literal('NOT_CONFIGURED'), v.literal('CLEAN'))),
    scannerEngine: v.optional(v.string()),
    scannerScanId: v.optional(v.string()),
    scannerDefinitionVersion: v.optional(v.string()),
    scannedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    preparedAt: v.optional(v.number()),
    consumedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
  })
    .index('by_requester_status', ['requestedByProfileId', 'status'])
    .index('by_status_expiresAt', ['status', 'expiresAt'])
    .index('by_storageId', ['storageId']),

  // Cada fila representa un blob inmutable. "SIGNATURE_VERIFIED" afirma solo
  // la verificación real de firma/MIME; nunca se presenta como antivirus CLEAN.
  documentVersions: defineTable({
    documentId: v.id('documents'),
    companyId: v.id('companies'),
    versionNumber: v.number(),
    storageId: v.id('_storage'),
    displayName: v.string(),
    declaredMimeType: v.string(),
    detectedMimeType: v.string(),
    byteSize: v.number(),
    sha256: v.string(),
    signatureKind: DocumentSignatureKind.validator,
    verificationStatus: v.union(
      v.literal('QUARANTINED'),
      v.literal('SIGNATURE_VERIFIED'),
      v.literal('REJECTED')
    ),
    malwareScanStatus: v.union(
      v.literal('NOT_CONFIGURED'),
      v.literal('PENDING'),
      v.literal('CLEAN'),
      v.literal('INFECTED'),
      v.literal('ERROR')
    ),
    scannerEngine: v.optional(v.string()),
    scannerScanId: v.optional(v.string()),
    scannerDefinitionVersion: v.optional(v.string()),
    scannedAt: v.optional(v.number()),
    publicationStatus: v.union(
      v.literal('DRAFT'),
      v.literal('PUBLISHED'),
      v.literal('SUPERSEDED'),
      v.literal('ARCHIVED')
    ),
    replacesVersionId: v.optional(v.id('documentVersions')),
    restoredFromVersionId: v.optional(v.id('documentVersions')),
    // Heredada del intent que la publicó. En SESSION_TRANSCRIPT estos bytes
    // son los REDACTADOS: los crudos nunca fueron una versión.
    documentClass: v.optional(v.literal('SESSION_TRANSCRIPT')),
    // Sello del entregable que el equipo devuelve a mano desde Mycroft
    // (`convex/operatorDeliverables.ts`). La etiqueta es la que el cliente ve
    // junto al número de versión; la nota es texto de cara al cliente.
    deliveryLabel: v.optional(v.string()),
    deliveryNote: v.optional(v.string()),
    createdAt: v.number(),
    createdByProfileId: v.id('profiles'),
    publishedAt: v.optional(v.number()),
  })
    .index('by_document_version', ['documentId', 'versionNumber'])
    .index('by_storageId', ['storageId'])
    .index('by_company_createdAt', ['companyId', 'createdAt']),

  // El equipo publica esta fila a mano después de revisar las cifras contra
  // versiones vigentes de documentos de la sala. No hay parser ni conexión a
  // Mycroft: una sola fila reemplazable por empresa alimenta el resumen.
  financialSnapshots: defineTable({
    companyId: v.id('companies'),
    publishedAt: v.number(),
    reviewedByProfileId: v.id('profiles'),
    reviewNote: v.string(),
    metrics: v.array(
      v.object({
        metric: v.union(
          v.literal('REVENUE'),
          v.literal('EBITDA'),
          v.literal('NET_INCOME'),
          v.literal('TOTAL_ASSETS'),
          v.literal('TOTAL_DEBT'),
          v.literal('CASH')
        ),
        period: v.string(),
        periodEnd: v.string(),
        value: v.number(),
        currency: v.union(
          v.literal('USD'),
          v.literal('PAB'),
          v.literal('EUR'),
          v.literal('MXN'),
          v.literal('COP'),
          v.literal('PEN'),
          v.literal('CLP'),
          v.literal('ARS'),
          v.literal('CRC'),
          v.literal('GTQ')
        ),
        source: v.object({
          documentId: v.id('documents'),
          versionId: v.id('documentVersions'),
          locator: v.union(
            v.object({ kind: v.literal('PAGE'), page: v.number() }),
            v.object({ kind: v.literal('CELL'), sheet: v.string(), range: v.string() })
          ),
        }),
      })
    ),
  }).index('by_companyId', ['companyId']),

  // Legal hold is independent from room visibility. A held document may be
  // archived, but its bytes and immutable history cannot be purged until an
  // administrator explicitly releases the hold with a reason.
  documentLegalHolds: defineTable({
    documentId: v.id('documents'),
    companyId: v.id('companies'),
    status: v.union(v.literal('ACTIVE'), v.literal('RELEASED')),
    reason: v.string(),
    externalReference: v.optional(v.string()),
    placedAt: v.number(),
    placedByProfileId: v.id('profiles'),
    releasedAt: v.optional(v.number()),
    releasedByProfileId: v.optional(v.id('profiles')),
    releaseReason: v.optional(v.string()),
  })
    .index('by_document_status', ['documentId', 'status'])
    .index('by_company_status', ['companyId', 'status']),

  // ==========================================================================
  // DOCUMENT ACCESS LOGS
  // ==========================================================================
  // Log de quién accedió a qué documentos (para compliance)

  documentAccessLogs: defineTable({
    documentId: v.id('documents'),
    // Desnormalizado desde el documento en el momento del acceso. La vista de
    // actividad pregunta "¿qué pasó en ESTA sala?" y la tabla no tenía forma de
    // responderlo: había que abanicarse por documento, y esa consulta es
    // reactiva — se recalcula en cada acceso. Opcional solo por las filas
    // anteriores al backfill (`_backfillAccessLogCompanyId`).
    companyId: v.optional(v.id('companies')),
    accessedById: v.id('profiles'),

    // Datos
    accessedAt: v.optional(v.number()), // timestamp (Convex agrega _creationTime)
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    // Tipo de acción: VIEW, DOWNLOAD, SHARE
    action: v.optional(v.string()),
    decision: v.optional(
      v.union(
        v.literal('ALLOW'),
        v.literal('DENY'),
        v.literal('REQUIRE_STEP_UP'),
        v.literal('REQUIRE_REVIEW')
      )
    ),
    outcome: v.optional(v.string()),
    reason: v.optional(v.string()),
    stepUpRequirement: v.optional(v.string()),
    riskScore: v.optional(v.number()),
    classification: v.optional(DocumentClassification.validator),
    accessLevel: v.optional(DocumentAccessLevel.validator),
    grantId: v.optional(v.id('documentAccessGrants')),
  })
    .index('by_documentId', ['documentId'])
    .index('by_accessedById', ['accessedById'])
    // La alarma de descargas masivas pregunta "¿cuántas DESCARGAS hizo este
    // perfil en la última hora?". Sin este índice había que leer su historial
    // completo para responderlo. Orden forzado por Convex: campos de igualdad
    // primero, un solo campo de rango al final.
    .index('by_accessedById_action_accessedAt', ['accessedById', 'action', 'accessedAt'])
    // El dashboard de la empresa solo reporta los últimos 7 días, pero leía el
    // historial completo de cada documento y lo filtraba en JS. Con una fila por
    // VISTA además de por descarga, ese escaneo crece el doble de rápido.
    .index('by_documentId_accessedAt', ['documentId', 'accessedAt'])
    // Igualdad primero, un solo campo de rango al final: la ventana de la vista
    // de actividad se acota por `accessedAt` sin leer la sala entera.
    .index('by_companyId_accessedAt', ['companyId', 'accessedAt']),

  // ==========================================================================
  // VDR READ MCP — audit + text index
  // ==========================================================================
  // Evidence for the client-facing read-only MCP surface (`/api/vdr-mcp`).
  // One row per tool invocation, written by the route after the server-side
  // binding resolved which room the caller actually holds. `argsSha256` keeps
  // the evidence linkable without persisting caller-supplied text.
  vdrReadAudits: defineTable({
    principalId: v.string(),
    clientId: v.string(),
    companyId: v.optional(v.id('companies')),
    tool: v.string(),
    argsSha256: v.string(),
    outcome: v.union(
      v.literal('OK'),
      v.literal('DENIED'),
      v.literal('NOT_FOUND'),
      v.literal('ERROR')
    ),
    errorCode: v.optional(v.string()),
    resultSummary: v.optional(v.string()),
    occurredAt: v.number(),
  }).index('by_company_occurredAt', ['companyId', 'occurredAt']),

  // Extracted plain text per immutable blob, keyed by the version it came from.
  // Never authority: a row here is only reachable after the same authorization
  // that would have delivered the bytes. `sha256` pins the row to the exact
  // publication so a replaced version can never serve stale text.
  documentTextIndex: defineTable({
    documentVersionId: v.id('documentVersions'),
    documentId: v.id('documents'),
    companyId: v.id('companies'),
    sha256: v.string(),
    extractor: v.union(v.literal('PDF'), v.literal('DOCX'), v.literal('PPTX'), v.literal('TXT')),
    pages: v.array(v.object({ n: v.number(), text: v.string() })),
    totalChars: v.number(),
    truncated: v.boolean(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index('by_documentVersionId', ['documentVersionId'])
    .index('by_documentId', ['documentId'])
    .index('by_expiresAt', ['expiresAt']),

  // ==========================================================================
  // ROOM ASSISTANT — client-owned inference credential and transcript
  // ==========================================================================
  // The API key belongs to the company and is billed to the company. Convex
  // only ever sees AES-256-GCM ciphertext: the plaintext is encrypted in the
  // Node tier with `VDR_ASSISTANT_KEK` and is never returned by any function.
  companyInferenceCredentials: defineTable({
    companyId: v.id('companies'),
    provider: v.union(v.literal('anthropic'), v.literal('openai')),
    model: v.string(),
    /** base64(AES-256-GCM ciphertext || 16-byte auth tag). */
    ciphertext: v.string(),
    /** base64 12-byte nonce. */
    iv: v.string(),
    keyVersion: v.number(),
    /** Last four characters of the key, the only plaintext fragment kept. */
    last4: v.string(),
    createdBy: v.id('profiles'),
    createdAt: v.number(),
    rotatedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  }).index('by_companyId', ['companyId']),

  documentAccessGrants: defineTable({
    documentId: v.id('documents'),
    // New grants bind byte delivery to one immutable, inspected publication.
    // Optional only for the bounded migration of pre-existing 5-minute grants;
    // the consumer rejects every row missing this evidence.
    documentVersionId: v.optional(v.id('documentVersions')),
    documentSha256: v.optional(v.string()),
    companyId: v.optional(v.id('companies')),
    protectionPolicyVersion: v.optional(v.string()),
    profileId: v.id('profiles'),
    // Intención declarada al EMITIR el grant. Vive aquí y no en la URL para que
    // `consumeDownloadGrant` decida si audita VIEW o DOWNLOAD sin depender de un
    // query param que el navegador controla. Opcional: los grants emitidos antes
    // de este cambio (TTL 5 min) se leen como DOWNLOAD.
    action: v.optional(RoomAccessAction.validator),
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    useCount: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    // Marcado por `releaseFailedDelivery` cuando la capa HTTP no pudo entregar
    // los bytes (watermark/proxy fallido) y el grant consumido se reabrió para
    // UN reintento. Solo se libera una vez por grant: si el reintento también
    // falla, el usuario pide un grant nuevo.
    releasedAt: v.optional(v.number()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    classification: v.optional(DocumentClassification.validator),
    accessLevel: v.optional(DocumentAccessLevel.validator),
    outcome: v.optional(v.string()),
    riskScore: v.optional(v.number()),
  })
    .index('by_documentId', ['documentId'])
    .index('by_documentId_revokedAt_expiresAt', ['documentId', 'revokedAt', 'expiresAt'])
    .index('by_profileId', ['profileId'])
    .index('by_expiresAt', ['expiresAt'])
    // El único punto de entrada del carril MCP (change 12): `sm-doc://` no
    // porta un `grantId` de Convex, porta el token en claro (la misma pieza
    // que `consumeDownloadGrant` ya trata como el secreto real, no el _id).
    // Sin este índice, resolverlo sería un scan de la tabla entera.
    .index('by_tokenHash', ['tokenHash']),

  // ==========================================================================
  // DELIVERABLES — workflow del paquete transaccional (pipeline sell-side)
  // ==========================================================================
  // Capa de WORKFLOW sobre la custodia: un slot por (empresa, kind) — "el
  // teaser de X", "el CIM de X". El contenido vive en `documents` /
  // `documentVersions` (custodia VDR); Mycroft entrega a mano por
  // `vdr:push`. Esta tabla solo apunta y lleva el ciclo. El productor es un
  // dato (MYCROFT_RUN | TEAM). Kinds, estados y transiciones se declaran UNA
  // vez en `_deliverables/model.ts`.

  deliverables: defineTable({
    companyId: v.id('companies'),
    kind: deliverableKindValidator,
    status: deliverableStatusValidator,
    producedBy: v.optional(deliverableProducerValidator),
    // Custodia del puente borrado el 2026-09-06 ([F], DECISIONS): filas viejas
    // con producedBy = MYCROFT_RUN traen el id de su corrida. Sin tabla detrás.
    modelRunId: v.optional(v.string()),
    // Cada rendition es un document en custodia (HTML nativo primero; PPTX/PDF
    // como exports). Los bytes JAMÁS viven fuera del storage custodiado.
    // El cliente es dueño de su sala y puede quitar de ella el documento que
    // respalda una entrega ([F] 2026-09-17). El retiro se marca EN LA RENDITION
    // y no en `status`: la máquina de estados es del equipo y ningún lector de
    // `status` cambia de significado. El sello es el recibo de quién retiró y
    // cuándo; que al slot le quede o no una entrega vigente se pregunta por
    // documento (`loadDeliverablePublishedVersion`), nunca contando sellos.
    renditions: v.optional(
      v.array(
        v.object({
          format: deliverableRenditionFormatValidator,
          documentId: v.id('documents'),
          withdrawnByClientAt: v.optional(v.number()),
          withdrawnByProfileId: v.optional(v.id('profiles')),
        })
      )
    ),
    // GIGO auditable: las versiones EXACTAS de los insumos con que se produjo
    // el contenido vigente. Una corrida no se contamina si el cliente sube
    // documentos a mitad de camino — los nuevos alimentan el ciclo siguiente.
    inputManifest: v.optional(v.array(v.id('documentVersions'))),
    requestedByProfileId: v.optional(v.id('profiles')),
    // La aprobación y la entrega son transiciones humanas.
    reviewedByProfileId: v.optional(v.id('profiles')),
    approvedAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index('by_company_kind', ['companyId', 'kind'])
    .index('by_companyId', ['companyId'])
    .index('by_status', ['status'])
    .index('by_modelRunId', ['modelRunId']),

  // ==========================================================================
  // SUBSCRIPTIONS
  // ==========================================================================

  subscriptions: defineTable({
    userId: v.id('profiles'),

    // IDs de Lemon Squeezy
    lemonCustomerId: v.optional(v.string()),
    lemonSubscriptionId: v.optional(v.string()),
    lemonOrderId: v.optional(v.string()),

    // Plan
    planName: v.optional(v.string()), // 'company_starter', 'company_pro', etc.
    planVariant: v.optional(v.string()),

    // Estado
    status: v.optional(
      v.union(
        v.literal('ACTIVE'),
        v.literal('CANCELLED'),
        v.literal('PAST_DUE'),
        v.literal('TRIALING')
      )
    ),

    // Fechas
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),

    // Precio
    price: v.optional(v.number()),
    currency: v.optional(v.string()), // default: "USD"
  })
    .index('by_userId', ['userId'])
    .index('by_status', ['status'])
    .index('by_lemonSubscriptionId', ['lemonSubscriptionId']),

  // ==========================================================================
  // ACTIVITY LOGS
  // ==========================================================================
  // Log de actividad para auditoría y analytics

  activityLogs: defineTable({
    userId: v.optional(v.id('profiles')),

    // Acción - dejamos como string para compatibilidad con código legacy
    // Valores comunes: LOGIN, LOGOUT, DOCUMENT_VIEWED, etc.
    action: v.string(),

    // Entidad - dejamos como string para compatibilidad
    // Valores comunes: COMPANY, DOCUMENT, etc.
    entityType: v.optional(v.string()),
    entityId: v.optional(v.string()),
    viewDay: v.optional(v.string()),

    // Metadata
    metadata: v.optional(v.any()),

    // Sesión
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  })
    .index('by_userId', ['userId'])
    .index('by_action', ['action'])
    .index('by_entityType', ['entityType'])
    .index('by_action_entityId', ['action', 'entityId'])
    .index('by_userId_action_entityId_viewDay', ['userId', 'action', 'entityId', 'viewDay']),
  // Nota: _creationTime se agrega automáticamente a todos los índices por Convex

  // ==========================================================================
  // NOTIFICATIONS
  // ==========================================================================
  // Notificaciones in-app en tiempo real para usuarios

  notifications: defineTable({
    // Usuario destinatario
    userId: v.id('profiles'),

    // Tipo de notificación
    type: v.union(
      v.literal('new_message'),
      v.literal('nda_signed'),
      v.literal('document_shared'),
      v.literal('analysis_complete'),
      v.literal('subscription_update'),
      v.literal('council_completed'),
      v.literal('screening_complete'),
      v.literal('news_alert_triggered'),
      v.literal('portfolio_alert'),
      v.literal('system')
    ),

    // Contenido
    title: v.string(),
    message: v.string(),
    link: v.optional(v.string()), // URL para navegar al click

    // Estado
    isRead: v.optional(v.boolean()), // default: false

    // Contexto
    actorId: v.optional(v.id('profiles')), // Quién generó la notificación
    entityType: v.optional(v.string()), // 'document', 'deliverable', etc.
    entityId: v.optional(v.string()), // ID de la entidad relacionada
  })
    .index('by_userId', ['userId'])
    .index('by_userId_unread', ['userId', 'isRead'])
    .index('by_userId_type', ['userId', 'type']),

  // ==========================================================================
  // NOTIFICATION PREFERENCES
  // ==========================================================================
  // Preferencias de notificación por usuario
  //
  // LIMITACIÓN: Convex no soporta constraints de unicidad en el schema.
  // Teóricamente pueden existir múltiples registros por userId bajo
  // requests concurrentes. El handler updatePreferences incluye lógica
  // defensiva para detectar y consolidar duplicados automáticamente.
  // También existe una mutación cleanupDuplicatePreferences para
  // mantenimiento manual (solo ADMIN).

  notificationPreferences: defineTable({
    userId: v.id('profiles'),

    // Email notifications
    emailNewConnection: v.optional(v.boolean()), // default: true
    emailNewMessage: v.optional(v.boolean()), // default: true
    emailRoomUpdates: v.optional(v.boolean()), // default: true
    emailWeeklyDigest: v.optional(v.boolean()), // default: true
    emailAnalysisComplete: v.optional(v.boolean()), // default: true

    // Push notifications (futuro)
    pushEnabled: v.optional(v.boolean()), // default: false
  }).index('by_userId', ['userId']),

  // ==========================================================================
  // TEAM ALERTS
  // ==========================================================================
  // El aviso al equipo (ADMIN) de que un cliente se movió: creó su espacio o
  // soltó documentos. Una fila POR TANDA, no por archivo: `batchKey` agrupa la
  // subida (`vdr:<companyId>` en la sala, `intake:<sessionId>` en /mycroft) y
  // la ventana la mantiene abierta mientras sigan llegando archivos.
  //
  // La fila ES la primitiva de idempotencia. `emailDispatchedAt` hace el correo
  // exactamente-una-vez por tanda aunque el finalize se reintente, y
  // `notificationIds` deja parchear la misma campanita en vez de insertar otra.

  teamAlerts: defineTable({
    kind: v.union(v.literal('COMPANY_DOCUMENTS_UPLOADED'), v.literal('COMPANY_WORKSPACE_CREATED')),
    batchKey: v.string(),

    companyId: v.optional(v.id('companies')),
    companyName: v.string(),
    link: v.string(),

    fileCount: v.number(),
    folders: v.array(v.string()),
    fileNames: v.array(v.string()),

    notificationIds: v.array(v.id('notifications')),
    openedAt: v.number(),
    lastEventAt: v.number(),

    emailJobId: v.optional(v.id('_scheduled_functions')),
    emailDispatchedAt: v.optional(v.number()),
  })
    .index('by_batchKey', ['batchKey'])
    .index('by_openedAt', ['openedAt']),

  // ==========================================================================
  // SERVER ERROR ALERTS — un 5xx despierta a un humano (A7)
  // ==========================================================================
  // Una fila por VENTANA DE CORREO, no por excepción. La llave de dedupe es
  // (plantilla de ruta, nombre del error): veinte 500 del mismo handler son un
  // incidente, no veinte correos. La fila que abre la ventana manda el correo
  // de una vez; toda repetición dentro de los 15 minutos siguientes sube
  // `occurrences` y PARCHA la campanita existente, sin correo. La ventana que
  // se abra después hereda ese conteo en `suppressedRepeats` y lo dice.
  //
  // NADA DE ESTO LLEVA REQUEST. El payload llega ya redactado desde
  // `src/lib/observability/server-error-alert.ts`: plantilla de ruta, método,
  // status, nombre del error y 120 caracteres de mensaje tachado. Nunca headers,
  // cookies, cuerpo, stack, paths con ids ni PII.
  serverErrorAlerts: defineTable({
    dedupeKey: v.string(),
    route: v.string(),
    errorName: v.string(),
    method: v.optional(v.string()),
    status: v.number(),
    message: v.string(),
    // Huella del mensaje tachado: junta avisos cortados en el mismo punto y los
    // busca en PostHog, que es donde vive el mensaje entero.
    digest: v.optional(v.string()),
    requestId: v.string(),
    synthetic: v.boolean(),

    occurrences: v.number(),
    suppressedRepeats: v.number(),

    notificationIds: v.array(v.id('notifications')),
    openedAt: v.number(),
    lastEventAt: v.number(),
    emailedAt: v.optional(v.number()),
  })
    .index('by_dedupeKey', ['dedupeKey'])
    .index('by_openedAt', ['openedAt']),

  // ==========================================================================
  // COMPANY CHECKLIST — activación artesanal de la sala ([F] 2026-09-01)
  // ==========================================================================
  // Una fila por empresa, creada perezosamente en el primer write. Sin fila =
  // checklist en cero. nameConfirmedAt marca que el nombre lo puso una persona
  // (claim del intake o rename de la sala), no el alta automática. Los ítems
  // de carpeta, teléfono y el rail se derivan; no se persisten aquí.
  companyChecklist: defineTable({
    companyId: v.id('companies'),
    nameConfirmedAt: v.optional(v.number()),
    nameConfirmedSource: v.optional(v.union(v.literal('INTAKE_CLAIM'), v.literal('ROOM_RENAME'))),
    financialsDepthConfirmedAt: v.optional(v.number()),
    financialsDepthConfirmedBy: v.optional(v.id('profiles')),
    financialsDepthNote: v.optional(v.string()),
    kickoffCallAt: v.optional(v.number()),
    kickoffCallBy: v.optional(v.id('profiles')),
    kickoffCallNote: v.optional(v.string()),
    activatedAt: v.optional(v.number()),
    activatedBy: v.optional(v.id('profiles')),
    activationNote: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_companyId', ['companyId']),

  // ==========================================================================
  // CONSENTS (GDPR)
  // ==========================================================================
  // Registro de consentimientos del usuario para cumplir con GDPR

  consents: defineTable({
    profileId: v.id('profiles'),

    // Tipo de consentimiento
    consentType: v.union(
      v.literal('terms_of_service'),
      v.literal('privacy_policy'),
      v.literal('marketing_emails'),
      v.literal('analytics_tracking'),
      v.literal('third_party_sharing')
    ),

    // Estado
    accepted: v.boolean(),
    acceptedAt: v.number(), // Timestamp

    // Metadata para auditoría
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  })
    .index('by_profileId', ['profileId'])
    // `recordConsent`/`revokeConsent` buscan el vigente de UN tipo.
    .index('by_profileId_consentType', ['profileId', 'consentType']),

  // ==========================================================================
  // DELETION REQUESTS (GDPR Art. 17 - Right to be Forgotten)
  // ==========================================================================
  // Solicitudes de eliminación de cuenta para cumplir con GDPR

  deletionRequests: defineTable({
    profileId: v.id('profiles'),
    email: v.string(), // Respaldo del email

    // Razón opcional
    reason: v.optional(v.string()),

    // Estado
    status: v.union(
      v.literal('PENDING'),
      v.literal('PROCESSING'),
      v.literal('COMPLETED'),
      v.literal('CANCELLED')
    ),

    // Fechas
    requestedAt: v.number(),
    processedAt: v.optional(v.number()),
    processedBy: v.optional(v.id('profiles')), // Admin que procesó
  })
    .index('by_profileId', ['profileId'])
    .index('by_status', ['status']),

  // ==========================================================================
  // SECURITY EVENTS (V2 - SECURITY MONITORING)
  // ==========================================================================
  // Registro de eventos de seguridad para monitoreo y alertas.

  securityEvents: defineTable({
    // Tipo de evento de seguridad
    type: v.union(
      v.literal('FAILED_LOGIN'), // Intento de login fallido
      v.literal('RATE_LIMIT_EXCEEDED'), // Rate limit excedido
      v.literal('DATA_ROOM_BULK_DOWNLOAD'), // Descarga masiva de data room
      v.literal('DATA_ROOM_BULK_ACCESS'), // Extracción masiva (vistas + descargas)
      v.literal('NDA_ACCESS_DENIED'), // Acceso a NDA denegado
      v.literal('PASSWORD_RESET_ABUSE'), // Abuso de reset de password
      v.literal('ACCOUNT_ENUMERATION'), // Intento de enumeración de cuentas
      v.literal('REAUTH_LOCKOUT'), // Bloqueo por reauth fallido
      v.literal('UNAUTHORIZED_API_ACCESS'), // Acceso API no autorizado
      v.literal('SUSPICIOUS_PROFILE_CHANGE'), // Cambio sospechoso de perfil
      v.literal('ACCOUNT_SELF_DEACTIVATION') // Usuario pausó su propia cuenta (traza self-service)
    ),

    // Severidad del evento
    severity: v.union(
      v.literal('INFO'),
      v.literal('WARNING'),
      v.literal('ALERT'),
      v.literal('CRITICAL')
    ),

    // Identificadores (opcionales porque puede no haber usuario autenticado)
    userId: v.optional(v.id('users')),
    userEmail: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),

    // Detalles del evento (JSON flexible)
    details: v.optional(v.any()),

    // Estado de resolución
    resolved: v.boolean(),
    resolvedByProfileId: v.optional(v.id('profiles')),
    resolvedAt: v.optional(v.number()),
    resolutionNotes: v.optional(v.string()),
  })
    .index('by_type', ['type'])
    .index('by_severity', ['severity'])
    .index('by_userId', ['userId'])
    // Dedupe de alarmas por (usuario, tipo). Sin el par, "¿ya alerté a este
    // usuario en esta hora?" tenía que leer TODOS sus eventos sin resolver.
    .index('by_userId_type', ['userId', 'type'])
    .index('by_resolved', ['resolved']),

  // ==========================================================================
  // RATE LIMITS (Convex-level throttling)
  // ==========================================================================
  // Per-key rate limiting records used by Convex mutations.

  rateLimits: defineTable({
    key: v.string(), // e.g. "guestInvite:profileId" or "guestRevoke:profileId"
    count: v.number(),
    windowStart: v.number(), // epoch ms
    windowMs: v.number(), // window duration in ms
    lastHitAt: v.number(), // epoch ms
  }).index('by_key', ['key']),

  // ==========================================================================
  // CREDITS (Sistema de Créditos para Análisis)
  // ==========================================================================
  // Balance de créditos por usuario para usar herramientas de análisis

  webhookEvents: defineTable({
    // Identificador único del evento (del proveedor)
    provider: v.union(
      v.literal('clerk'),
      v.literal('lemonsqueezy'),
      v.literal('workos'),
      v.literal('stripe_identity'),
      v.literal('checkout')
    ),
    eventId: v.string(), // ID único del evento del proveedor
    eventType: v.string(), // 'subscription_created', 'user.created', etc.
    claimVersion: v.optional(v.number()), // Generación del intento que puede escribir el resultado.

    // Estado del procesamiento
    status: v.union(
      v.literal('received'), // Recibido, pendiente de procesar
      v.literal('processing'), // En proceso
      v.literal('completed'), // Procesado exitosamente
      v.literal('failed'), // Falló el procesamiento
      v.literal('skipped') // Ignorado (evento no relevante)
    ),

    // Payload original (para debugging)
    payload: v.optional(v.any()),

    // Resultado del procesamiento
    result: v.optional(
      v.object({
        action: v.optional(v.string()), // 'created_user', 'added_credits', etc.
        resourceId: v.optional(v.string()), // ID del recurso creado/modificado
        details: v.optional(v.string()),
      })
    ),

    // Error si falló
    error: v.optional(v.string()),
    errorCode: v.optional(v.string()),

    // Timestamps
    receivedAt: v.number(), // Reloj del claim: el alta y cada reclaim de registerEvent
    processedAt: v.optional(v.number()), // Cuando terminamos de procesar

    // Metadata adicional
    requestId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  })
    .index('by_provider_eventId', ['provider', 'eventId']) // Para idempotencia
    .index('by_provider', ['provider'])
    .index('by_status', ['status'])
    .index('by_receivedAt', ['receivedAt']), // OPTIMIZACIÓN: Para queries por tiempo sin full scan

  // ==========================================================================
  // SYSTEM STATS (PERFORMANCE OPTIMIZATION)
  // ==========================================================================
  // Contadores globales actualizados incrementalmente para evitar full table scans.
  // Se actualiza en cada mutation relevante (create/delete users, etc.)
  // Permite que getAdminStats sea O(1) en lugar de O(n) sobre varias tablas.

  systemStats: defineTable({
    // Identificador: 'global' para stats generales, 'YYYY-MM-DD' para stats diarios
    key: v.string(),

    // ===== CONTADORES DE USUARIOS =====
    totalUsers: v.number(),
    totalCompanies: v.number(),
    totalAdmins: v.number(),

    // ===== CONTADORES INERTES =====
    // Ya no se calculan ni se leen: el subsistema que los alimentaba salió del
    // árbol. Se conservan como `v.optional` porque la única fila de producción
    // (`k78dbce970641841d113c3ce39604a12`, medida 2026-09-17) todavía los trae
    // en cero, y una tabla sin el campo rechaza esa fila en el push del schema.
    // Una fila nueva los omite.
    totalDeals: v.optional(v.number()),
    openDeals: v.optional(v.number()),
    closedDeals: v.optional(v.number()),
    draftDeals: v.optional(v.number()),
    totalDealVolume: v.optional(v.number()),

    // ===== METADATA =====
    lastUpdated: v.number(), // Timestamp de última actualización
  }).index('by_key', ['key']),

  // ==========================================================================
  // REPORTES DE PODA (dry-run del cron de storage)
  // ==========================================================================
  // Una fila por corrida de `operatorPrune.pruneDryRun`. Es la bitácora de la
  // poda: el cron corre con la deploy key, sin sesión y sin perfil ADMIN al
  // cual atribuir un `adminAuditLogs` (`logAdminAction` exige uno), así que la
  // fila del reporte ES el registro auditable. `mode` es un literal y no un
  // booleano para que el día que exista una corrida que sí borra entre como
  // variante nueva sin reinterpretar las filas ya escritas.
  pruneReports: defineTable({
    generatedAt: v.number(),
    mode: v.literal('DRY_RUN'),
    categories: v.array(
      v.object({
        key: v.union(
          v.literal('SUPERSEDED_VERSIONS'),
          v.literal('ORPHAN_BLOBS'),
          v.literal('EXPIRED_UPLOAD_INTENTS'),
          v.literal('STALE_QUARANTINE'),
          v.literal('EXPIRED_GRANTS')
        ),
        candidates: v.number(),
        // Bytes de blob que la categoría liberaría. Las categorías que solo
        // acumulan filas (grants, intents sin blob) reportan 0: una fila no
        // factura el GB de archivos, y decir lo contrario inventaría ahorro.
        bytes: v.number(),
        oldestAgeDays: v.union(v.number(), v.null()),
        // El barrido está acotado por categoría: `capped` avisa que el conteo
        // es un piso, no el total.
        capped: v.boolean(),
      })
    ),
    totals: v.object({ candidates: v.number(), bytes: v.number() }),
    scanLimit: v.number(),
  }).index('by_generatedAt', ['generatedAt']),

  // ==========================================================================
  // PROGRESO DE UNA PURGA DE EMPRESA (operador)
  // ==========================================================================
  // Una purga por empresa cruza ~45 tablas y no cabe en una transacción: se
  // trocea en lotes encadenados con `ctx.scheduler.runAfter`, y ahí se pierde
  // el todo-o-nada de Convex. Esta fila ES el estado que sobrevive entre
  // lotes: cuántas filas lleva borradas cada tabla, cuántos blobs, y si la
  // corrida sigue viva. Sin ella, un lote que muere deja la purga a medias sin
  // forma de saber dónde quedó.
  //
  // `companyId` apunta a una fila que la última pasada BORRA. Convex no tiene
  // integridad referencial: el id sigue siendo un valor válido y la fila queda
  // como recibo de que esa empresa existió y fue purgada.
  companyPurgeRuns: defineTable({
    companyId: v.id('companies'),
    // El nombre se copia al empezar porque la empresa deja de existir al final
    // y el recibo tiene que seguir siendo legible.
    companyName: v.string(),
    status: v.union(v.literal('RUNNING'), v.literal('COMPLETED')),
    operatorProfileId: v.id('profiles'),
    reason: v.string(),
    batchSize: v.number(),
    passes: v.number(),
    startedAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    deletedRows: v.number(),
    markedRows: v.number(),
    deletedBlobs: v.number(),
    byTable: v.array(v.object({ table: v.string(), deleted: v.number() })),
    workosUserIds: v.array(v.string()),
    workosOrganizationId: v.optional(v.string()),
  })
    .index('by_companyId', ['companyId'])
    .index('by_status', ['status']),

  // Opaque, session-bound, one-use capabilities for privileged admin VDR writes.
  // The raw bearer and WorkOS subject/session are never persisted; only
  // one-way binding digests are stored until the bounded expiry purge.
  adminVdrCapabilities: defineTable({
    tokenHash: v.string(),
    profileId: v.id('profiles'),
    identityBindingDigest: v.string(),
    companyId: v.id('companies'),
    action: v.string(),
    target: v.string(),
    inputDigest: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_profile_expiresAt', ['profileId', 'expiresAt'])
    .index('by_expiresAt', ['expiresAt']),

  adminAuditLogs: defineTable({
    // Admin que realizó la acción
    adminProfileId: v.id('profiles'),
    adminEmail: v.string(),

    // Tipo de acción
    action: v.union(
      // User management
      v.literal('USER_CREATE'),
      v.literal('USER_PROFILE_UPDATE'),
      v.literal('USER_ROLE_CHANGE'),
      v.literal('USER_VERIFICATION_CHANGE'),
      v.literal('USER_STATUS_CHANGE'),
      v.literal('USER_DELETE'),

      // KYC
      v.literal('KYC_APPROVE'),
      v.literal('KYC_REJECT'),
      v.literal('KYC_REQUEST_REVISION'),
      v.literal('KYC_DATA_ACCESS'),

      // NDA de sala de empresa (`guestNdaTemplates`)
      v.literal('NDA_TEMPLATE_CREATE'),

      // VDR lifecycle
      v.literal('VDR_ADMIN_CAPABILITY_ISSUE'),
      v.literal('VDR_ADMIN_CAPABILITY_CONSUME'),
      v.literal('DOCUMENT_ARCHIVE'),
      // Vuelta del archivado (`operatorRestore:restoreArchivedDocuments`).
      v.literal('DOCUMENT_RESTORE'),
      v.literal('DOCUMENT_PURGE'),
      v.literal('DOCUMENT_UPLOAD'),
      v.literal('DOCUMENT_VERSION_RESTORE'),
      v.literal('DOCUMENT_LEGAL_HOLD_PLACE'),
      v.literal('DOCUMENT_LEGAL_HOLD_RELEASE'),
      v.literal('DOCUMENT_METADATA_UPDATE'),
      v.literal('GUEST_INVITATION_CREATE'),
      v.literal('GUEST_INVITATION_REVOKE'),
      v.literal('GUEST_INVITATION_EXTEND'),

      // Security
      v.literal('SECURITY_EVENT_RESOLVE'),

      // Company management
      // Renombre desde el operador (`operatorRestore:setCompanyName`).
      v.literal('COMPANY_RENAME'),
      v.literal('COMPANY_VERIFY'),
      v.literal('COMPANY_UNVERIFY'),
      v.literal('COMPANY_VISIBILITY_CHANGE'),

      // Impersonation
      v.literal('IMPERSONATION_LIST_SEARCH'),
      v.literal('IMPERSONATION_USER_ACCESS'),

      // Deliverables (pipeline sell-side)
      v.literal('DELIVERABLE_REQUEST'),
      v.literal('DELIVERABLE_TRANSITION'),
      v.literal('DELIVERABLE_RENDITION_ATTACH'),
      v.literal('CHECKLIST_ITEM_SET'),
      v.literal('COMPANY_ROOM_ACTIVATION'),
      v.literal('SUPPORT_MESSAGE_SEND'),
      v.literal('SUPPORT_THREAD_READ'),
      v.literal('NOTIFICATION_PREFERENCES_UPDATE'),
      v.literal('NOTIFICATION_PREFERENCES_CLEANUP'),
      v.literal('VDR_ASSISTANT_CREDENTIAL_SET'),
      v.literal('VDR_ASSISTANT_CREDENTIAL_REVOKE'),

      // System
      v.literal('SEED_DATA'),
      v.literal('SEED_DATA_CLEAR'),
      // Purga completa de una empresa de prueba (`operatorPurge:purgeCompany`).
      v.literal('COMPANY_PURGE'),
      v.literal('SYSTEM_CONFIG_CHANGE')
    ),

    // Target entity (what was affected)
    targetType: v.union(
      v.literal('USER'),
      v.literal('PROFILE'),
      v.literal('COMPANY'),
      v.literal('GUEST_INVITATION'),
      v.literal('DOCUMENT'),
      v.literal('DELIVERABLE'),
      v.literal('SUPPORT_THREAD'),
      v.literal('SECURITY_EVENT'),
      v.literal('SYSTEM')
    ),
    targetId: v.optional(v.string()), // ID of the affected entity

    // Details of the action
    previousValue: v.optional(v.any()), // State before change
    newValue: v.optional(v.any()), // State after change
    notes: v.optional(v.string()), // Admin notes/reason

    // Metadata
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  })
    .index('by_adminProfileId', ['adminProfileId'])
    .index('by_action', ['action'])
    .index('by_targetType', ['targetType'])
    .index('by_targetId', ['targetId']),

  // ==========================================================================
  // AI AGENT SESSIONS
  // ==========================================================================
  // Tracks conversations with AI agents (Code Guardian, DCF Assistant, etc.)

  codeAudits: defineTable({
    // Unique run identifier
    runId: v.string(),

    // Who triggered the audit
    triggeredBy: v.id('profiles'),

    // Scope of the audit
    scope: v.union(
      v.literal('full'),
      v.literal('mutations'),
      v.literal('queries'),
      v.literal('components')
    ),

    // Status
    status: v.union(v.literal('running'), v.literal('completed'), v.literal('failed')),

    // Findings (array of security/quality issues found)
    findings: v.array(
      v.object({
        severity: v.union(
          v.literal('critical'),
          v.literal('high'),
          v.literal('medium'),
          v.literal('low')
        ),
        rule: v.string(), // Rule ID (e.g., "AUTH_001")
        file: v.string(),
        line: v.number(),
        message: v.string(),
        suggestion: v.optional(v.string()),
        codeSnippet: v.optional(v.string()),
      })
    ),

    // Summary statistics
    summary: v.object({
      totalFiles: v.number(),
      totalFindings: v.number(),
      criticalCount: v.number(),
      highCount: v.number(),
      mediumCount: v.number(),
      lowCount: v.number(),
      passedRules: v.array(v.string()),
      failedRules: v.array(v.string()),
    }),

    // Risk score (0-100)
    riskScore: v.optional(v.number()),

    // Timestamps
    startedAt: v.number(),
    completedAt: v.optional(v.number()),

    // Error message if failed
    error: v.optional(v.string()),

    // Git context (optional)
    gitBranch: v.optional(v.string()),
    gitCommit: v.optional(v.string()),
  })
    .index('by_runId', ['runId'])
    .index('by_triggeredBy', ['triggeredBy'])
    .index('by_status', ['status']),

  // ==========================================================================
  // ROADMAP PÚBLICO
  // ==========================================================================
  // Respaldan el tablero público de /roadmap, que no tiene sesión: los votos se
  // atribuyen a un token de dispositivo y las peticiones entran a una cola que
  // el equipo cura a mano antes de publicar nada.

  roadmapVotes: defineTable({
    featureKey: v.string(),
    deviceToken: v.string(),
    // Residuo del modelo viejo, cuando un dispositivo podia votar la misma
    // funcion hasta 3 veces. Hoy la fila ES el voto y no se escribe `count`,
    // pero las filas de entonces lo traen: opcional para que validen sin
    // migracion, y `vote` lo usa como peso al restar del total.
    count: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index('by_feature_device', ['featureKey', 'deviceToken'])
    .index('by_device', ['deviceToken']),

  roadmapVoteTotals: defineTable({
    featureKey: v.string(),
    total: v.number(),
  }).index('by_feature', ['featureKey']),

  roadmapFeatureRequests: defineTable({
    body: v.string(),
    normalizedBody: v.string(),
    locale: v.string(),
    deviceToken: v.string(),
    status: v.union(
      v.literal('NEW'),
      v.literal('GROUPED'),
      v.literal('PUBLISHED'),
      v.literal('DISMISSED')
    ),
    createdAt: v.number(),
  })
    .index('by_status', ['status'])
    .index('by_device_created', ['deviceToken', 'createdAt'])
    .index('by_normalized', ['normalizedBody']),
})
