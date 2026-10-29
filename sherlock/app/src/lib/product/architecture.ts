// ============================================================================
// PRODUCT ARCHITECTURE SOURCE OF TRUTH
// ============================================================================
// Typed registry for the live sell-side product: intake, company workspace/VDR,
// invited VDR guests, and the team's admin surfaces. Las rutas del panel del
// equipo se declaran una sola vez en `product/admin-routes.ts` —con su fila de
// la barra— y entran acá por `PRODUCT_ROUTES`.
// ============================================================================

import { homePathForRole } from '@/lib/navigation/home'
import { ADMIN_ROUTES } from '@/lib/product/admin-routes'
import { ActorRoleSchema, AppShellSchema } from '@/lib/product/types'
import type { AccessGate, ActorRole, AppShell, ProductRouteDefinition } from '@/lib/product/types'

// Los dos roles con tablero no son una segunda lista: salen de `ActorRoleSchema`
// con `pick`, así que renombrar un rol en `product/types.ts` rompe acá.
const DashboardRoleSchema = ActorRoleSchema.pick(['COMPANY', 'ADMIN'])
type DashboardRole = typeof DashboardRoleSchema.Type

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type GapPriority = 'P0' | 'P1' | 'P2'

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type ExecutionStandard = 'FUNCTIONAL' | 'FAST' | 'SECURE' | 'VISUALLY_POLISHED' | 'VDR_EXCELLENT'

export interface CapabilityMatrixEntry {
  id: string
  role: ActorRole
  page: string
  action: string
  allowed: boolean
  gates: readonly AccessGate[]
  notes: string
}

interface DashboardCardDefinition {
  id: string
  title: string
  metric: string
  primaryAction: string
  sourceOfTruth: string
}

export interface DashboardDefinition {
  role: DashboardRole
  shell: AppShell
  homePath: string
  summary: string
  primaryJobs: readonly string[]
  cards: readonly DashboardCardDefinition[]
}

export interface WorkflowDefinition {
  id: string
  name: string
  actors: readonly ActorRole[]
  startRoute: string
  targetRoute: string
  steps: readonly string[]
  successMetric: string
}

export interface ProductGapDefinition {
  priority: GapPriority
  title: string
  description: string
  impact: string
}

export interface UnknownUnknownDefinition {
  id: string
  question: string
  whyItMatters: string
  affectedAreas: readonly string[]
}

export interface ProductNorthStarDefinition {
  positioning: string
  promise: string
  executionStandard: readonly ExecutionStandard[]
  sourceMaterials: readonly string[]
  launchWedge: string
  proprietaryCapitalLayer: string
  antiPositioning: readonly string[]
  designPrinciples: readonly string[]
  operatingModel: readonly string[]
  analyticsRole: string
  mvpProofPoints: readonly string[]
  revenueStreams: readonly string[]
  successMetrics: readonly string[]
  explicitDeferrals: readonly string[]
}

// Estas tres listas eran copias a mano del vocabulario de `product/types.ts`.
// Derivadas, un rol o un shell renombrado allá deja de compilar acá.
const ALL_ROLES: readonly ActorRole[] = ActorRoleSchema.literals
const WORKSPACE_ROLES: readonly ActorRole[] = DashboardRoleSchema.literals
const WORKSPACE_SHELLS: readonly AppShell[] = AppShellSchema.pick(['COMPANY', 'ADMIN']).literals

// La casa de cada rol la resuelve `navigation/home.ts`, que es el módulo que
// la navegación llama de verdad. Este registro la cita, no la vuelve a
// escribir: eran dos tablas idénticas y nada obligaba a que siguieran así.
export const DEFAULT_HOME_BY_ACTOR: Record<ActorRole, string> = {
  GUEST: homePathForRole('GUEST'),
  COMPANY: homePathForRole('COMPANY'),
  ADMIN: homePathForRole('ADMIN'),
}

export const PRODUCT_NORTH_STAR: ProductNorthStarDefinition = {
  positioning: 'Sell-side preparation and a beautiful, easy VDR for Latin American companies',
  promise:
    'Turn a company document dump into an organized workspace and a transaction-ready package without putting a regulatory or workflow tollbooth before the first useful result.',
  executionStandard: ['FUNCTIONAL', 'FAST', 'SECURE', 'VISUALLY_POLISHED', 'VDR_EXCELLENT'],
  sourceMaterials: [
    'docs/north/true-north.md',
    'llm-wiki/bundle/governance/current-rules.md — the rule in force',
  ],
  launchWedge:
    'Companies that need a financial model, teaser, CIM, management presentation, or financing deck and need their source documents organized for the process.',
  proprietaryCapitalLayer:
    'Enola is the separately governed proprietary-capital and investment-fund layer above Sherlock. Enola may review company materials only with conflict controls, clear disclosure, and no automatic investment or hidden advantage.',
  antiPositioning: [
    'Not crowdfunding',
    'Not a public securities offering or public investing portal',
    'Not a self-serve transaction board',
    'No promised returns, automatic matching, guaranteed allocation, or guaranteed closing',
    'Not a customer-facing analysis-credit product',
  ],
  designPrinciples: [
    'Deliver the dopamine hit before asking the client to complete a workflow',
    'Make the persistent VDR the company workspace and the highest product-quality priority',
    'Keep access controls scoped to each room and transaction',
    'Use progressive human KYB when the client wants to publish or share, never as an entry gate',
    'Use AI and external financial engines to accelerate the team, not to replace judgment',
  ],
  operatingModel: [
    'Mycroft corre fuera; el equipo baja los documentos con vdr:pull, corre el modelo y sube los entregables con vdr:push.',
    'The team turns company evidence into a model, teaser, CIM, management presentation, and credit or equity decks',
    'Companies own their workspace; invited guests enter a scoped room through guest OTP and NDA controls',
    'Debt, equity, and M&A rooms do not share information or language by default',
    'Financial engines remain external in ~/Developer/financial-engines',
  ],
  analyticsRole:
    'Credit and equity analytics are internal servicing tools that accelerate the work — AI and engines are a delivery advantage, never a customer-facing product.',
  mvpProofPoints: [
    'A company can upload documents and reach its workspace without a wizard or role selector',
    'The team can assess completeness and produce the agreed sell-side deliverables',
    'The company can share a transaction-scoped VDR with invited guests under explicit access controls',
  ],
  revenueStreams: [
    'Fixed or scoped fees for financial models, teasers, CIMs, management presentations, and financing decks',
    'Preparation packages and revision work',
    'Human support for diligence readiness and transaction-room preparation',
  ],
  successMetrics: [
    'Time from first upload to a useful workspace signal',
    'Completion and approval of paid deliverables',
    'VDR readiness and document completeness',
    'Invited guest access that succeeds without support intervention',
    'Repeat preparation work and referrals from completed engagements',
  ],
  explicitDeferrals: [
    'Public transaction discovery and company directories',
    'Self-serve matching, messaging, checkout, and subscription flows',
    'Any proprietary-capital workflow before conflict governance is written',
  ],
}

export const PRODUCT_ROUTES: readonly ProductRouteDefinition[] = [
  {
    id: 'public-home',
    paths: ['/'],
    surface: 'PUBLIC',
    shells: ['PUBLIC'],
    roles: ALL_ROLES,
    goal: 'Start Mycroft intake and explain the sell-side preparation service.',
    primaryCta: 'Subir documentos',
    secondaryCta: 'Conocer el proceso',
    gating: ['NONE'],
    dataOwner: 'PLATFORM',
    analyticsEvent: 'intake_started',
    entrypoints: ['/'],
  },
  {
    id: 'public-help',
    paths: ['/ayuda'],
    surface: 'PUBLIC',
    shells: ['PUBLIC'],
    roles: ALL_ROLES,
    goal: 'Let a company write to the team, vote on what comes next, and read how the Data Room works.',
    primaryCta: 'Escríbele al equipo',
    gating: ['NONE'],
    dataOwner: 'PLATFORM',
    entrypoints: ['/', '/my-company/documents'],
  },
  {
    id: 'public-intake',
    paths: ['/intake'],
    surface: 'PUBLIC',
    shells: ['PUBLIC'],
    roles: ALL_ROLES,
    goal: 'Host the temporary demo intake workspace when the explicit mode is enabled.',
    primaryCta: 'Agregar documentos',
    secondaryCta: 'Reclamar workspace',
    gating: ['NONE'],
    dataOwner: 'SHARED_USER',
    analyticsEvent: 'workspace_entered',
    entrypoints: ['/'],
  },
  {
    id: 'guest-vdr',
    paths: ['/vdr-guest'],
    surface: 'PUBLIC',
    shells: ['PUBLIC'],
    roles: ['GUEST'],
    goal: 'Let an invited guest enter a scoped room with OTP and NDA controls.',
    primaryCta: 'Entrar a la sala',
    emptyState: 'Solicita una invitación vigente al equipo que administra la sala.',
    gating: ['NONE'],
    dataOwner: 'COMPANY',
    entrypoints: ['invitation-link'],
  },
  {
    id: 'public-sign-in',
    paths: ['/sign-in'],
    surface: 'PUBLIC',
    shells: ['PUBLIC'],
    roles: ALL_ROLES,
    goal: 'Authenticate an existing company or team member and return to the intended route.',
    primaryCta: 'Iniciar sesión',
    gating: ['NONE'],
    dataOwner: 'PLATFORM',
    entrypoints: ['/', '/my-company/documents', '/admin'],
  },
  {
    id: 'public-sign-up',
    paths: ['/sign-up'],
    surface: 'PUBLIC',
    shells: ['PUBLIC'],
    roles: ['GUEST'],
    goal: 'Create a company identity and provision its workspace with minimal friction.',
    primaryCta: 'Crear workspace',
    gating: ['NONE'],
    dataOwner: 'PLATFORM',
    entrypoints: ['/'],
  },
  {
    id: 'workspace-provisioning',
    paths: ['/onboarding'],
    surface: 'SHARED',
    shells: WORKSPACE_SHELLS,
    roles: WORKSPACE_ROLES,
    goal: 'Provision or resume the company workspace without a role-selection wizard.',
    primaryCta: 'Continuar al workspace',
    gating: ['AUTH'],
    dataOwner: 'SHARED_USER',
    analyticsEvent: 'onboarding_started',
    entrypoints: ['/sign-up', '/sign-in'],
  },
  {
    id: 'shared-notifications',
    paths: ['/notifications'],
    surface: 'SHARED',
    shells: WORKSPACE_SHELLS,
    roles: WORKSPACE_ROLES,
    goal: 'Surface preparation, document, access, and support events.',
    primaryCta: 'Abrir notificación',
    emptyState: 'No tienes notificaciones nuevas.',
    gating: ['AUTH'],
    dataOwner: 'SYSTEM',
    analyticsEvent: 'notifications_viewed',
    entrypoints: ['/my-company/documents', '/admin'],
  },
  {
    id: 'shared-settings',
    paths: ['/settings', '/settings/privacy'],
    surface: 'SHARED',
    shells: WORKSPACE_SHELLS,
    roles: WORKSPACE_ROLES,
    goal: 'Control account, privacy, and consent preferences.',
    primaryCta: 'Actualizar preferencias',
    gating: ['AUTH'],
    dataOwner: 'SHARED_USER',
    analyticsEvent: 'settings_viewed',
    entrypoints: ['/my-company/documents', '/admin'],
  },
  {
    id: 'company-documents',
    paths: ['/my-company/documents'],
    surface: 'COMPANY',
    shells: ['COMPANY'],
    roles: ['COMPANY'],
    goal: 'Manage source documents, preparation status, the company profile the team works from, and transaction-scoped VDR access.',
    primaryCta: 'Subir documento',
    secondaryCta: 'Revisar preparación',
    emptyState: 'Sube documentos para comenzar a preparar tu workspace.',
    gating: ['AUTH', 'ROLE_COMPANY', 'OWNER_OR_ADMIN'],
    dataOwner: 'COMPANY',
    analyticsEvent: 'company_documents_viewed',
    entrypoints: ['/onboarding'],
  },
  {
    id: 'company-document-activity',
    paths: ['/my-company/documents/activity'],
    surface: 'COMPANY',
    shells: ['COMPANY'],
    roles: ['COMPANY'],
    goal: 'Review scoped document access and download activity.',
    primaryCta: 'Ver eventos',
    emptyState: 'No hay actividad en el rango seleccionado.',
    gating: ['AUTH', 'ROLE_COMPANY', 'OWNER_OR_ADMIN'],
    dataOwner: 'COMPANY',
    analyticsEvent: 'company_data_room_activity_viewed',
    entrypoints: ['/my-company/documents'],
  },
  // El panel del equipo se declara en `product/admin-routes.ts`, que además
  // lleva el rótulo, el icono y la sección con que la barra lateral pinta cada
  // ruta. Este registro lo cita, no lo vuelve a escribir.
  ...ADMIN_ROUTES,
]

export const ACTOR_CAPABILITY_MATRIX: readonly CapabilityMatrixEntry[] = [
  {
    id: 'guest-start-intake',
    role: 'GUEST',
    page: '/',
    action: 'start_intake',
    allowed: true,
    gates: ['NONE'],
    notes: 'The first useful upload does not require an account first.',
  },
  {
    id: 'guest-enter-invited-vdr',
    role: 'GUEST',
    page: '/vdr-guest',
    action: 'enter_scoped_room',
    allowed: true,
    gates: ['ACTIVE_NDA'],
    notes: 'Guest OTP, NDA, room scope, and document policy remain enforced at their boundaries.',
  },
  {
    id: 'company-upload-vdr-document',
    role: 'COMPANY',
    page: '/my-company/documents',
    action: 'upload_document',
    allowed: true,
    gates: ['AUTH', 'ROLE_COMPANY', 'OWNER_OR_ADMIN'],
    notes: 'Document ownership remains attached to the company workspace.',
  },
  {
    id: 'company-manage-other-workspace',
    role: 'COMPANY',
    page: '/my-company/documents',
    action: 'manage_other_company_documents',
    allowed: false,
    gates: ['OWNER_OR_ADMIN'],
    notes: 'A company cannot cross the ownership boundary into another workspace.',
  },
  {
    // El KYB vive en la fila de la empresa desde que D2 retiró `/admin/kyc`
    // ([F] 2026-09-11): la decisión se sigue registrando, en otra pantalla.
    id: 'admin-review-kyc',
    role: 'ADMIN',
    page: '/admin/companies',
    action: 'record_verification_decision',
    allowed: true,
    gates: ['AUTH', 'ROLE_ADMIN', 'AUDIT_LOG_REQUIRED'],
    notes: 'Verification is human and progressive; every action is audited.',
  },
  {
    id: 'admin-view-as',
    role: 'ADMIN',
    page: '/admin',
    action: 'view_as_company',
    allowed: true,
    gates: ['AUTH', 'ROLE_ADMIN', 'AUDIT_LOG_REQUIRED'],
    notes: 'View As supports QA and support without changing the stored role.',
  },
] as const

export const DASHBOARD_INVENTORY: readonly DashboardDefinition[] = [
  {
    role: 'COMPANY',
    shell: 'COMPANY',
    homePath: '/my-company/documents',
    summary: 'Company workspace focused on evidence, deliverables, and VDR readiness.',
    primaryJobs: [
      'Upload and organize source documents',
      'Review completeness and preparation status',
      'Receive and review sell-side deliverables',
      'Control invited access to transaction rooms',
    ],
    cards: [
      {
        id: 'documents',
        title: 'Documentos',
        metric: 'documentCount',
        primaryAction: 'Abrir VDR',
        sourceOfTruth: 'api.documents.listDocuments',
      },
      {
        id: 'preparation-status',
        title: 'Preparación',
        metric: 'completionBand',
        primaryAction: 'Revisar pendientes',
        sourceOfTruth: 'company workspace assessment',
      },
      {
        id: 'deliverables',
        title: 'Entregables',
        metric: 'deliverableCount',
        primaryAction: 'Abrir paquete',
        sourceOfTruth: 'deliverable slot hub',
      },
      {
        id: 'document-engagement',
        title: 'Actividad del VDR',
        metric: 'documentViews7d',
        primaryAction: 'Ver actividad',
        sourceOfTruth: 'api.documents.getActivity',
      },
    ],
  },
  {
    role: 'ADMIN',
    shell: 'ADMIN',
    homePath: '/admin',
    summary: 'Team backoffice for preparation, VDR operations, support, and security.',
    primaryJobs: [
      'Review company workspaces and preparation work',
      'Manage document and VDR requests',
      'Record progressive human verification decisions',
      'Audit access, support, and security events',
    ],
    cards: [
      {
        id: 'companies',
        title: 'Empresas',
        metric: 'companies.total',
        primaryAction: 'Abrir empresas',
        sourceOfTruth: 'api.analytics.getOperationsOverview',
      },
      {
        id: 'intake',
        title: 'Intakes activos',
        metric: 'intake.active',
        primaryAction: 'Revisar documentos preparados',
        sourceOfTruth: 'api.analytics.getOperationsOverview',
      },
      {
        id: 'deliverables',
        title: 'Entregables por revisar',
        metric: 'deliverables.reviewQueue',
        primaryAction: 'Revisar entregables',
        sourceOfTruth: 'api.analytics.getOperationsOverview',
      },
    ],
  },
] as const

export const CORE_WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    id: 'intake-to-workspace',
    name: 'Upload -> identity -> company workspace',
    actors: ['GUEST', 'COMPANY'],
    startRoute: '/',
    targetRoute: '/my-company/documents',
    steps: [
      'Select documents',
      'Create or resume identity',
      'Provision workspace',
      'Persist uploads',
    ],
    successMetric: 'Time from first file selection to durable workspace',
  },
  {
    id: 'company-preparation',
    name: 'Evidence -> assessment -> deliverables',
    actors: ['COMPANY', 'ADMIN'],
    startRoute: '/my-company/documents',
    targetRoute: '/my-company/documents',
    steps: ['Organize evidence', 'Assess completeness', 'Resolve requests', 'Publish deliverables'],
    successMetric: 'Time to approved preparation package',
  },
  {
    id: 'guest-vdr-access',
    name: 'Invitation -> OTP -> NDA -> scoped room',
    actors: ['GUEST', 'COMPANY', 'ADMIN'],
    startRoute: '/vdr-guest',
    targetRoute: '/vdr-guest',
    steps: ['Open invitation', 'Verify OTP', 'Accept NDA if required', 'Enter scoped room'],
    successMetric: 'Invited guest access completion rate',
  },
  {
    id: 'admin-review',
    name: 'Team review / support / audit',
    actors: ['ADMIN'],
    startRoute: '/admin',
    targetRoute: '/admin/companies',
    steps: ['Monitor queue', 'Review a company workspace', 'Act with audit trail'],
    successMetric: 'Time to resolve a preparation or access request',
  },
] as const

export const PRODUCT_GAPS: readonly ProductGapDefinition[] = [
  {
    priority: 'P0',
    title: 'Workspace readiness is not summarized in one durable signal',
    description:
      'Document completeness, requests, and deliverables still span several data sources.',
    impact: 'The company and team can disagree about what is actually ready.',
  },
  {
    priority: 'P0',
    title: 'Temporary intake handoff needs one explicit contract',
    description:
      'The demo intake and permanent company workspace use different persistence boundaries.',
    impact: 'A claim or sign-up edge case can lose the dopamine hit after upload.',
  },
  {
    priority: 'P1',
    title: 'Transaction-room scope needs stronger product visibility',
    description:
      'The backend separates room access, but the UI must make transaction scope unmistakable.',
    impact: 'Users may assume documents are shared more broadly than they are.',
  },
  {
    priority: 'P1',
    title: 'Deliverable review state is not yet a complete workflow',
    description:
      'Draft, review, revision, approval, and final delivery need one visible lifecycle.',
    impact: 'The team relies on support context instead of a shared operating state.',
  },
  {
    priority: 'P2',
    title: 'Admin remains one wide role',
    description: 'Preparation, support, verification, and security share the ADMIN role.',
    impact: 'Future least-privilege work will need scoped capabilities or sub-roles.',
  },
] as const

export const UNKNOWN_UNKNOWNS: readonly UnknownUnknownDefinition[] = [
  {
    id: 'readiness-anchor',
    question: 'What single signal should represent transaction-ready preparation?',
    whyItMatters: 'It determines the dashboard, completion criteria, and team handoff.',
    affectedAreas: ['Workspace', 'Deliverables', 'Analytics'],
  },
  {
    id: 'claim-boundary',
    question: 'At exactly what point does a temporary intake become durable company data?',
    whyItMatters: 'The answer controls data loss, consent, and recovery behavior.',
    affectedAreas: ['Intake', 'Auth', 'Documents'],
  },
  {
    id: 'deliverable-lifecycle',
    question: 'Which review states are required for each deliverable type?',
    whyItMatters: 'Models, teasers, CIMs, and decks may need different approval loops.',
    affectedAreas: ['Deliverables', 'Support', 'Notifications'],
  },
  {
    id: 'room-creation',
    question: 'When should one company workspace create a new transaction-scoped room?',
    whyItMatters: 'Debt, equity, and M&A must not leak information across processes.',
    affectedAreas: ['VDR', 'Permissions', 'Documents'],
  },
  {
    id: 'guest-reverification',
    question: 'Which room or document changes require a guest to verify again?',
    whyItMatters: 'Security and usability trade off at the session and NDA boundaries.',
    affectedAreas: ['Guest OTP', 'NDA', 'VDR'],
  },
  {
    id: 'human-kyb-trigger',
    question: 'Which client action should trigger founder-led KYB?',
    whyItMatters: 'The trigger must protect consequential sharing without gating initial value.',
    affectedAreas: ['Company', 'Admin KYC', 'Sharing'],
  },
  {
    id: 'support-thread-scope',
    question: 'Should support context attach to the company, a document request, or a deliverable?',
    whyItMatters: 'It determines continuity and who can see the conversation.',
    affectedAreas: ['Support', 'VDR Requests', 'Deliverables'],
  },
  {
    id: 'document-versioning',
    question:
      'Which uploaded replacements require explicit version history and guest notification?',
    whyItMatters: 'Financial evidence changes during preparation and diligence.',
    affectedAreas: ['Documents', 'Audit', 'Notifications'],
  },
  {
    id: 'engine-evidence',
    question: 'What evidence must accompany outputs returned by external financial engines?',
    whyItMatters: 'The team needs reproducible work without re-embedding the engines.',
    affectedAreas: ['Model Runs', 'Deliverables', 'Audit'],
  },
  {
    id: 'north-star-metrics',
    question: 'Which small set of metrics proves the preparation service is working?',
    whyItMatters: 'Busy dashboards can obscure time-to-value and delivery quality.',
    affectedAreas: ['Dashboards', 'Analytics', 'Operations'],
  },
] as const
