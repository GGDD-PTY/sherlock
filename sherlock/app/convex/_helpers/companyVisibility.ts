import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { AuthResult } from './auth'
import {
  isCurrentCompanyAuthorizationSession,
  type CompanyAuthorization,
  type CompanyManagementAuthorizationDecision,
} from './companyAuthorization'

type CompanyVisibilityContext = QueryCtx | MutationCtx
type AnonymizedCompany = Partial<Doc<'companies'>> &
  Pick<Doc<'companies'>, '_creationTime' | 'name' | 'country'> & {
    _id: Id<'companies'>
  }
export type VisibleCompany = Doc<'companies'> | AnonymizedCompany

const ANONYMOUS_COMPANY_NAME = 'Empresa verificada por Sherlock'
const ANONYMOUS_COMPANY_DESCRIPTION =
  'Identidad reservada hasta que el equipo autorice el acceso a la sala.'

/**
 * Quién puede ver la identidad real de una empresa. No queda una compuerta de
 * contraparte que abrir: revela el equipo (ADMIN) y revela la propia empresa
 * con su autorización vigente. Todo lo demás ve el teaser.
 */
type CompanyVisibilityGate = {
  hasAuthorizedCompanyAccess: boolean
  isAdmin: boolean
  isOwner: boolean
}

/**
 * Evidence produced by the central WorkOS-aware company authorization layer.
 *
 * A read authorization already carries its exact company. Management callers
 * carry the company id beside the decision so a decision for one organization
 * can never be replayed to reveal another issuer.
 */
export type CompanyVisibilityAuthorization =
  | CompanyAuthorization
  | {
      companyId: Id<'companies'>
      decision: CompanyManagementAuthorizationDecision
    }

function canRevealCompanyIdentity(gate: CompanyVisibilityGate): boolean {
  return gate.isAdmin || gate.hasAuthorizedCompanyAccess
}

type VisibilityGateArgs = {
  profile: Doc<'profiles'> | null
  company: Doc<'companies'> | null
  ownerCanReveal?: boolean
  auth?: AuthResult | null
  companyAuthorization?: CompanyVisibilityAuthorization | null
}

function getCompanyVisibilityGate(args: VisibilityGateArgs): CompanyVisibilityGate {
  const isSameLivePrincipal = Boolean(
    args.auth &&
      args.profile &&
      args.auth.profile._id === args.profile._id &&
      isCurrentCompanyAuthorizationSession(args.auth)
  )
  const isAdmin = Boolean(isSameLivePrincipal && args.profile?.role === 'ADMIN')
  const authorization = args.companyAuthorization
  const authorizationCompanyId = authorization
    ? 'company' in authorization
      ? authorization.company._id
      : authorization.companyId
    : null
  const authorizationGranted = authorization
    ? 'company' in authorization
      ? true
      : authorization.decision.authorized
    : false
  const hasAuthorizedCompanyAccess = Boolean(
    args.ownerCanReveal !== false &&
      args.profile?.role === 'COMPANY' &&
      args.company &&
      authorizationGranted &&
      authorizationCompanyId === args.company._id
  )
  const isOwner = Boolean(
    hasAuthorizedCompanyAccess &&
      args.profile &&
      args.company &&
      args.profile._id === args.company.ownerId
  )

  return { hasAuthorizedCompanyAccess, isAdmin, isOwner }
}

function anonymousCompanyId(company: Pick<Doc<'companies'>, '_creationTime'>): Id<'companies'> {
  return `anonymous-company-${company._creationTime}` as Id<'companies'>
}

function anonymizeCompany(company: Doc<'companies'>): AnonymizedCompany {
  // Explicit teaser whitelist. Do not spread the raw company document here:
  // new free-text/schema fields should stay private until identity gates clear.
  const anonymizedCompany = {
    _id: anonymousCompanyId(company),
    _creationTime: company._creationTime,
    name: ANONYMOUS_COMPANY_NAME,
    country: company.country,
    sector: company.sector,
    industry: company.industry,
    businessModel: company.businessModel,
    stage: company.stage,
    currency: company.currency,
    seekingType: company.seekingType,
    isPublic: company.isPublic,
    isFeatured: company.isFeatured,
    tagline: 'Teaser anonimizado',
    description: ANONYMOUS_COMPANY_DESCRIPTION,
    managementTeam: [],
  } satisfies AnonymizedCompany

  return anonymizedCompany
}

export function applyCompanyVisibility(
  ctx: CompanyVisibilityContext,
  args: VisibilityGateArgs
): Promise<VisibleCompany | null> {
  void ctx
  const company = args.company
  if (!company) {
    return Promise.resolve(null)
  }

  const gate = getCompanyVisibilityGate({ ...args, company })
  return Promise.resolve(canRevealCompanyIdentity(gate) ? company : anonymizeCompany(company))
}
