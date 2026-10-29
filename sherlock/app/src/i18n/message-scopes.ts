// ============================================================================
// QUÉ MENSAJES BAJA CADA SHELL
// ============================================================================
// `src/messages/es.json` pesa 92 KB y viaja entero dentro del HTML de cada
// ruta: `NextIntlClientProvider` serializa lo que recibe en el payload RSC.
// El shell público (landing, ayuda, legales, sign-in, 404) usa cuatro de sus
// treinta y dos namespaces, así que manda esos cuatro y no los veintiocho del
// producto. El shell de la app sigue mandando el bundle completo.
//
// Los catálogos son `Schema.Literals` y no arreglos sueltos: la llave que se
// escriba mal no compila contra el JSON, y `pickMessages` decide por
// pertenencia al schema en vez de por un `includes` sobre strings.
// ============================================================================

import { Schema } from 'effect'

// Lo que se evalúa fuera de los dos shells: `[locale]/error.tsx` monta
// `RouteErrorBoundary` (namespace `errors`) directamente bajo el layout raíz,
// y su `Link` necesita el locale del provider para resolver el prefijo.
// `common` entra por el límite de error del grupo `(app)`, que pinta la barra
// pública para no salir desnudo: son 0.5 KB gzip y los dos shells ya lo
// mandaban (tarjeta O2-06, decisión de la estación 2026-09-12).
const RootMessageNamespaceSchema = Schema.Literals(['common', 'errors'])

// El shell público: `common` para la barra y el toggle de tema, `mycroft` para
// la landing, `roadmap` para el tablero de /ayuda, `errors` para el límite de
// error que cuelga del layout raíz.
const PublicMessageNamespaceSchema = Schema.Literals(['common', 'errors', 'mycroft', 'roadmap'])

export const ROOT_MESSAGE_NAMESPACES = RootMessageNamespaceSchema.literals
export const PUBLIC_MESSAGE_NAMESPACES = PublicMessageNamespaceSchema.literals

/**
 * Recorta el bundle de mensajes a los namespaces pedidos. Un namespace que no
 * esté en el JSON se omite en vez de viajar como `undefined`: next-intl trata
 * la llave ausente y la llave en `undefined` distinto al resolver mensajes.
 */
export function pickMessages<Messages extends Record<string, unknown>>(
  messages: Messages,
  namespaces: readonly string[]
): Messages {
  const picked: Record<string, unknown> = {}
  for (const namespace of namespaces) {
    if (namespace in messages) picked[namespace] = messages[namespace]
  }
  return picked as Messages
}
