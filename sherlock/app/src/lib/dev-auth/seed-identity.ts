// ============================================================================
// seed-identity — la identidad dev de un dueño sembrado sale del email
// ============================================================================
// Dos corridas de `seed:company` con el mismo nombre y correos distintos son
// dueños distintos: derivar clerkId/workosUserId del slug de la empresa los
// chocaba. La regla vive aquí una sola vez: la importa `_localSeed.ts` al
// sembrar y el dev-login al reconstruir la sesión. `convex-local.mjs` no la
// duplica: imprime el subject que `seedCompany` devuelve.
//
// Y como la regla es una función y no una tabla, el dev-login puede recorrerla
// en los dos sentidos: del correo a la identidad (`devUserFromEmail`, lo que
// hace el formulario) y del id de la cookie de vuelta al usuario
// (`devUserFromId`, lo que hacen el SSR, el proxy y las API routes). Los dos
// usuarios fijos de `DEV_USERS` ganan siempre: su identidad la escribieron a
// mano los seeds y no sale de este slug.
// ============================================================================

import { Option, Schema } from 'effect'

import {
  DEV_USERS,
  DEV_WORKOS_ISSUER,
  DevUserEmailSchema,
  type DevUser,
  type DevUserEmail,
} from './types'

const DEV_EMAIL_DOMAIN = '@dev.local'

// El slug del dominio, calculado con la misma regla que el resto del correo:
// es el sufijo que `devUserFromId` tiene que reconocer para volver al email.
const DEV_DOMAIN_SLUG_SUFFIX = `-${seedIdentitySlug(DEV_EMAIL_DOMAIN)}`

const DEV_USER_ID_PREFIX = 'dev_'

const isDevUserEmail = Schema.is(DevUserEmailSchema)

export function seedIdentitySlug(email: string): string {
  return email
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
}

export function devSeedOwnerIds(email: string): {
  clerkId: string
  workosUserId: string
} {
  const slug = seedIdentitySlug(email)
  return {
    clerkId: `${DEV_USER_ID_PREFIX}${slug}`,
    workosUserId: `${DEV_USER_ID_PREFIX}${slug}_workos`,
  }
}

// «samplefoods-foods» -> «SampleFoods Foods». Es la etiqueta que el navegador muestra y la
// que viaja en la identidad impersonada; el nombre que guarda Convex es el de
// la empresa y lo escribe el seed, no esto.
function displayNameFor(localPart: string): string {
  return localPart
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function seededDevUser(email: DevUserEmail): DevUser {
  const { clerkId, workosUserId } = devSeedOwnerIds(email)
  const name = displayNameFor(email.slice(0, -DEV_EMAIL_DOMAIN.length))
  const [firstName = '', ...rest] = name.split(' ')
  return {
    id: clerkId,
    providerUserId: clerkId,
    email,
    name,
    firstName,
    lastName: rest.join(' '),
    imageUrl: null,
    // Un dueño sembrado es siempre el cliente de su propia sala: `seed:company`
    // no crea admins.
    role: 'COMPANY',
    convexIdentity: { subject: workosUserId, issuer: DEV_WORKOS_ISSUER },
  }
}

/** El usuario dev de un correo: la fila fija si el correo es de las dos
 *  escritas a mano, el dueño sembrado si es cualquier otro `*@dev.local`, y
 *  `null` para todo lo demás. */
export function devUserFromEmail(email: string): DevUser | null {
  const normalized = email.trim().toLowerCase()
  const fixed = DEV_USERS.find((candidate) => candidate.email === normalized)
  if (fixed) return fixed
  return isDevUserEmail(normalized) ? seededDevUser(normalized) : null
}

/** La inversa por el id `dev_<slug>` que guarda la cookie de dev-auth. El slug
 *  no es reversible carácter por carácter (`samplefoods.foods` y `samplefoods-foods` comparten
 *  slug), así que el correo reconstruido se acepta solo si vuelve a producir el
 *  mismo id: la identidad Convex, que es lo que importa, es la misma. */
export function devUserFromId(id: string): DevUser | null {
  const fixed = DEV_USERS.find((candidate) => candidate.id === id)
  if (fixed) return fixed
  return Option.getOrNull(Option.map(seededEmailFromId(id), seededDevUser))
}

function seededEmailFromId(id: string): Option.Option<DevUserEmail> {
  if (!id.startsWith(DEV_USER_ID_PREFIX)) return Option.none()
  const slug = id.slice(DEV_USER_ID_PREFIX.length)
  if (!slug.endsWith(DEV_DOMAIN_SLUG_SUFFIX)) return Option.none()

  const localPart = slug.slice(0, -DEV_DOMAIN_SLUG_SUFFIX.length)
  const email = `${localPart}${DEV_EMAIL_DOMAIN}`
  if (!isDevUserEmail(email) || devSeedOwnerIds(email).clerkId !== id) return Option.none()
  return Option.some(email)
}

/** Admin role switching chooses the fixed dev identity for that role. */
export function devUserForRole(user: DevUser, selectedRole: unknown): DevUser {
  if (user.role !== 'ADMIN' || selectedRole !== 'COMPANY') return user
  return DEV_USERS.find((candidate) => candidate.role === 'COMPANY') ?? user
}
