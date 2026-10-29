// ============================================================================
// CASA POR ROL
// ============================================================================
// `/dashboard` era una ruta que solo miraba el rol y respondía 307; `/data-room`
// hacía lo mismo hacia la sala del cliente. Un salto de más entre el click y el
// destino, y dos URLs que nadie puede abrir a propósito ([F] 2026-09-07 09:00:
// «si la página no existe, no debería existir y redirigir»). El destino se
// resuelve ahora en el origen: quien antes mandaba a `/dashboard` nombra aquí
// la casa del rol.
//
// Una sesión cuyo perfil de Convex todavía no llega no tiene sala que nombrar:
// cae al home público, que sí existe.
//
// La tabla reemplaza la cadena de `if`s: el rol se valida contra el vocabulario
// de `product/types.ts` antes de usarse como llave, así que un rol renombrado
// allá deja de compilar acá en vez de caer al home público sin decir nada.
// ============================================================================

import { Schema } from 'effect'

import { ActorRoleSchema } from '@/lib/product/types'
import type { ActorRole } from '@/lib/product/types'

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type HomePath = '/admin' | '/my-company/documents' | '/'

const PUBLIC_HOME: HomePath = '/'

const HOME_BY_ROLE: Record<ActorRole, HomePath> = {
  GUEST: PUBLIC_HOME,
  COMPANY: '/my-company/documents',
  ADMIN: '/admin',
}

const isActorRole = Schema.is(ActorRoleSchema)

export function homePathForRole(role: string | null | undefined): HomePath {
  return isActorRole(role) ? HOME_BY_ROLE[role] : PUBLIC_HOME
}
