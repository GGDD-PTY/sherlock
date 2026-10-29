// ============================================================================
// CONVEX AUTH CONFIG - WorkOS AuthKit
// ============================================================================
// Convex validates WorkOS AuthKit access tokens directly via custom JWT
// providers. Do not use CONVEX_DEPLOY_KEY or any admin key for end-user auth.
//
// El client id se interpola en la URL de JWKS y en el issuer. Un valor con `/`,
// `?`, `#` o un espacio no falla acá: acuña una URL DISTINTA, el deployment
// arranca creyéndose sano y la falla aparece mucho después, en el primer login,
// con un error que no nombra la causa. Por eso la forma del valor se declara y
// se verifica al arrancar, no solo su presencia.
// ============================================================================

import { Schema } from 'effect'

const WorkosClientId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)))
const isWorkosClientId = Schema.is(WorkosClientId)

const clientId = process.env.WORKOS_CLIENT_ID

if (!isWorkosClientId(clientId)) {
  throw new TypeError(
    'WORKOS_CLIENT_ID is missing or malformed. Configure it in Convex deployment env and local app env.'
  )
}

const authConfig = {
  providers: [
    {
      type: 'customJwt',
      issuer: 'https://api.workos.com/',
      algorithm: 'RS256',
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
      applicationID: clientId,
    },
    {
      type: 'customJwt',
      issuer: `https://api.workos.com/user_management/${clientId}`,
      algorithm: 'RS256',
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
    },
  ],
}

export default authConfig
