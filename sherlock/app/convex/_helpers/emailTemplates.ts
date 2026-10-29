// ============================================================================
// EMAIL TEMPLATES — el timbre de Sherlock
// ============================================================================
// Correo transaccional plataforma→usuario, un solo sentido. Regla dura: el
// contenido es ESTÁTICO por evento — sin nombres, sin títulos, sin montos. Un
// email se reenvía, se indexa y vive en servidores ajenos: no puede filtrar lo
// que la app anonimiza. El detalle vive detrás del login.
//
// Un solo idioma: el sitio ships en español ([F] 2026-09-03) y estos correos
// también. No se agrega un segundo locale acá sin revertir esa decisión.
// ============================================================================

// El catálogo de eventos, escrito una vez. `CONTENT` se indexa con el mismo
// tipo, así que un evento sin contenido —o un contenido sin evento— no compila.
// Quedó un solo evento con emisor vivo, así que el vocabulario es el tipo: no
// hay nada que decodificar desde afuera.
export type ProductEmailEvent = 'deliverable_published'

interface EmailContent {
  subject: string
  heading: string
  body: string
  cta: string
  path: string
}

const CONTENT: Record<ProductEmailEvent, EmailContent> = {
  deliverable_published: {
    subject: 'Hay un entregable nuevo en tu sala de Sherlock',
    heading: 'Entregable nuevo en tu sala',
    body: 'El equipo publicó un documento nuevo en tu sala. Ábrelo en Sherlock para revisarlo; si tienes comentarios, escríbelos desde la misma sala.',
    cta: 'Abrir mi sala',
    path: '/es/my-company/documents',
  },
}

export interface ProductEmail {
  subject: string
  html: string
  text: string
}

/**
 * Construye el correo de un evento. `appUrl` es el origin absoluto (sin slash
 * final); el único dato variable del correo es ese link de entrada.
 */
export function buildProductEmail(event: ProductEmailEvent, appUrl: string): ProductEmail {
  const content = CONTENT[event]
  const url = `${appUrl.replace(/\/$/, '')}${content.path}`

  const text = `${content.heading}\n\n${content.body}\n\n${content.cta}: ${url}\n`

  const html = [
    '<div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #0E1A2B;">',
    '<p style="font-family: Georgia, serif; font-size: 20px; margin: 0 0 16px;">Sherlock</p>',
    `<h1 style="font-size: 18px; margin: 0 0 12px;">${content.heading}</h1>`,
    `<p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px; color: #545B65;">${content.body}</p>`,
    `<a href="${url}" style="display: inline-block; background: #5A2331; color: #FFFFFF; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px;">${content.cta}</a>`,
    '</div>',
  ].join('')

  return { subject: content.subject, html, text }
}
