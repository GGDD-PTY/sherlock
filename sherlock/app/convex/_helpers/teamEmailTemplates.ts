// ============================================================================
// TEAM EMAIL TEMPLATES — el correo interno del equipo
// ============================================================================
// Carril aparte de `emailTemplates.ts` a propósito. Aquel correo va a una
// contraparte y por eso su contenido es ESTÁTICO: no puede filtrar lo que la
// app anonimiza antes del NDA. Este va a los perfiles ADMIN, que ya ven todo
// dentro del producto, así que sí nombra la empresa y los archivos.
//
// El ASUNTO es la excepción: es la única parte del correo que queda en claro en
// cada salto de la entrega. En el alta del espacio el nombre todavía no es un
// nombre de empresa — `ensureCompanyWorkspace` lo deriva del usuario o del
// local-part de su correo — así que ese evento no lo pone en el asunto. El
// cuerpo, que sí viaja cifrado, lo nombra igual.
// ============================================================================

import { Schema } from 'effect'

// Los dos avisos del carril interno, escritos una vez. `buildBody` ramifica
// sobre este mismo catálogo, así que un aviso nuevo no puede quedarse sin
// cuerpo.
const TeamAlertKindSchema = Schema.Literals([
  'COMPANY_DOCUMENTS_UPLOADED',
  'COMPANY_WORKSPACE_CREATED',
])

export type TeamAlertKind = typeof TeamAlertKindSchema.Type

// El alta del espacio es el único aviso que NO nombra la empresa en el asunto:
// ahí el nombre todavía lo derivó `ensureCompanyWorkspace` del usuario o del
// local-part de su correo, y el asunto es la parte del correo que queda en
// claro en cada salto.
const isWorkspaceCreatedAlert = Schema.is(TeamAlertKindSchema.pick(['COMPANY_WORKSPACE_CREATED']))

export interface TeamAlertEmailInput {
  kind: TeamAlertKind
  companyName: string
  fileCount: number
  folders: string[]
  fileNames: string[]
  url: string
}

export interface TeamAlertEmail {
  subject: string
  html: string
  text: string
}

const RENDERED_FILE_NAME_CAP = 8

// ===== CARPETAS DE LA SALA: LLAVE ADENTRO, ETIQUETA AFUERA =====
// La tanda guarda la carpeta por su llave (`room_corporate`) o por un alias
// heredado (`teaser`, `financials`). El correo y la campanita dicen lo que
// muestra la sala. La tabla repite la de `getVdrShellFolderLabel` en
// `src/lib/vdr/document-taxonomy.ts` porque convex no importa del cliente; un
// test de paridad en `email-templates.test.ts` la mantiene alineada. Primero
// la llave canónica, después el alias normalizado, y si no hay coincidencia
// cae en «2. Corporativos» (por ejemplo `General`).
const ROOM_FOLDER_FALLBACK_LABEL = '2. Corporativos'

const ROOM_SHELL_FOLDERS = [
  {
    value: 'room_legal',
    label: '1. Legales',
    aliases: ['1. legal', 'legal', 'legales'],
  },
  {
    value: 'room_corporate',
    label: ROOM_FOLDER_FALLBACK_LABEL,
    aliases: ['2. corporate', 'cap_table', 'data_room_index', 'corporativos', 'corporate'],
  },
  {
    value: 'room_financial',
    label: '3. Financieros',
    aliases: ['3. financial', 'financials', 'model', 'qoe', 'debt_schedule', 'financieros'],
  },
  {
    value: 'room_operations',
    label: '4. Operaciones',
    aliases: ['4. operations', 'operations', 'technical', 'operaciones'],
  },
  {
    value: 'room_marketing',
    label: '5. Materiales de mercadeo',
    aliases: [
      '5. marketing materials',
      'teaser',
      'management_presentation',
      'materiales de mercadeo',
      'mercadeo financiero',
    ],
  },
] as const

function normalizeFolderTerm(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_/-]+/g, ' ')
    .trim()
}

const ROOM_FOLDER_LABEL_BY_VALUE = new Map<string, string>(
  ROOM_SHELL_FOLDERS.map((folder) => [folder.value, folder.label])
)

const ROOM_FOLDER_LABEL_BY_TERM = new Map<string, string>()
for (const folder of ROOM_SHELL_FOLDERS) {
  for (const term of [folder.value, folder.label, ...folder.aliases]) {
    const key = normalizeFolderTerm(term)
    if (!ROOM_FOLDER_LABEL_BY_TERM.has(key)) ROOM_FOLDER_LABEL_BY_TERM.set(key, folder.label)
  }
}

/** Etiquetas visibles de las carpetas de una tanda, sin repetir y sin llaves crudas. */
export function roomFolderLabels(folders: readonly string[]): string[] {
  const labels = folders.map((folder) => {
    const canonical = ROOM_FOLDER_LABEL_BY_VALUE.get(folder)
    if (canonical) return canonical
    return ROOM_FOLDER_LABEL_BY_TERM.get(normalizeFolderTerm(folder)) ?? ROOM_FOLDER_FALLBACK_LABEL
  })
  return [...new Set(labels)]
}

// Estos strings vienen del cliente (nombre de empresa, nombre de archivo). El
// correo es la frontera donde se escapan.
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function summarizeFileNames(fileNames: string[]): string[] {
  const shown = fileNames.slice(0, RENDERED_FILE_NAME_CAP)
  const hidden = fileNames.length - shown.length
  return hidden > 0 ? [...shown, `y ${hidden} más`] : shown
}

function buildBody(input: TeamAlertEmailInput): { heading: string; body: string; cta: string } {
  if (isWorkspaceCreatedAlert(input.kind)) {
    return {
      heading: 'Espacio nuevo',
      body: `${input.companyName} creó su espacio en Sherlock. Abre la sala para ver con qué llegó y coordina el KYB por llamada.`,
      cta: 'Abrir la sala',
    }
  }

  const documents =
    input.fileCount === 1 ? '1 documento nuevo' : `${input.fileCount} documentos nuevos`
  const folderLabels = roomFolderLabels(input.folders)
  const folders = folderLabels.length > 0 ? ` en ${folderLabels.join(', ')}` : ''

  return {
    heading: 'Documentos nuevos',
    body: `${input.companyName} subió ${documents}${folders}.`,
    cta: 'Abrir la sala',
  }
}

function renderTeamEmailHtml(args: {
  heading: string
  body: string
  bullets: string[]
  cta: string
  url: string
}): string {
  return [
    '<div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #0E1A2B;">',
    '<p style="font-family: Georgia, serif; font-size: 20px; margin: 0 0 16px;">Sherlock</p>',
    `<h1 style="font-size: 18px; margin: 0 0 12px;">${escapeHtml(args.heading)}</h1>`,
    `<p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px; color: #545B65;">${escapeHtml(args.body)}</p>`,
    ...(args.bullets.length > 0
      ? [
          '<ul style="font-size: 14px; line-height: 1.6; margin: 0 0 24px; padding-left: 20px; color: #545B65;">',
          ...args.bullets.map((line) => `<li>${escapeHtml(line)}</li>`),
          '</ul>',
        ]
      : []),
    `<a href="${escapeHtml(args.url)}" style="display: inline-block; background: #5A2331; color: #FFFFFF; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px;">${escapeHtml(args.cta)}</a>`,
    '</div>',
  ].join('')
}

export function buildTeamAlertEmail(input: TeamAlertEmailInput): TeamAlertEmail {
  const { heading, body, cta } = buildBody(input)
  const fileNames = summarizeFileNames(input.fileNames)
  const subject = isWorkspaceCreatedAlert(input.kind)
    ? `[Sherlock] ${heading}`
    : `[Sherlock] ${heading}: ${input.companyName}`

  const text = [
    `${heading} — ${input.companyName}`,
    '',
    body,
    ...(fileNames.length > 0 ? ['', ...fileNames.map((name) => `- ${name}`)] : []),
    '',
    `${cta}: ${input.url}`,
    '',
  ].join('\n')

  return {
    subject,
    html: renderTeamEmailHtml({ heading, body, bullets: fileNames, cta, url: input.url }),
    text,
  }
}

// ============================================================================
// MENSAJE NUEVO EN «HABLA CON EL EQUIPO» — el timbre del hilo de soporte
// ============================================================================
// Mismo carril interno que los avisos de arriba, con una regla propia: el
// CUERPO DEL MENSAJE DEL CLIENTE NO VIAJA. Ni en el asunto ni en el cuerpo del
// correo. Lo que sale es que hay algo que leer, de quién, y el enlace al hilo;
// el texto se lee dentro del producto, que es donde ya está la autorización.
// La empresa sí va en el asunto: el hilo nace en una sala de empresa y el
// equipo necesita saber a cuál abrir sin entrar.
// ============================================================================

export interface SupportMessageEmailInput {
  companyName: string
  messageCount: number
  url: string
}

export function buildSupportMessageEmail(input: SupportMessageEmailInput): TeamAlertEmail {
  const heading = 'Mensaje nuevo de soporte'
  const messages =
    input.messageCount === 1 ? 'un mensaje nuevo' : `${input.messageCount} mensajes nuevos`
  const body = `${input.companyName} dejó ${messages} en «Habla con el equipo». El texto no viaja por correo: ábrelo en el panel para leerlo y responder.`
  const cta = 'Abrir la conversación'

  const text = [`${heading} — ${input.companyName}`, '', body, '', `${cta}: ${input.url}`, ''].join(
    '\n'
  )

  return {
    subject: `[Sherlock] ${heading}: ${input.companyName}`,
    html: renderTeamEmailHtml({ heading, body, bullets: [], cta, url: input.url }),
    text,
  }
}

// ============================================================================
// ENTREGA RETIRADA POR EL CLIENTE — el dueño quitó de su sala lo que el equipo
// le entregó
// ============================================================================
// Mismo carril interno que los avisos de arriba: va a perfiles ADMIN, así que
// nombra la empresa, el documento y el entregable. El asunto lleva la empresa
// por la misma razón que el de soporte — el equipo tiene que saber qué sala
// abrir sin entrar.
// ============================================================================

export interface DeliverableWithdrawnEmailInput {
  companyName: string
  summary: string
  documentNames: string[]
  url: string
}

export function buildDeliverableWithdrawnEmail(
  input: DeliverableWithdrawnEmailInput
): TeamAlertEmail {
  const heading = 'Entrega retirada'
  const cta = 'Abrir la sala'
  const bullets = summarizeFileNames(input.documentNames)

  const text = [
    `${heading} — ${input.companyName}`,
    '',
    input.summary,
    ...(bullets.length > 0 ? ['', ...bullets.map((name) => `- ${name}`)] : []),
    '',
    `${cta}: ${input.url}`,
    '',
  ].join('\n')

  return {
    subject: `[Sherlock] ${heading}: ${input.companyName}`,
    html: renderTeamEmailHtml({ heading, body: input.summary, bullets, cta, url: input.url }),
    text,
  }
}

// ============================================================================
// ALERTA DE 5xx (A7) — mismo canal, otro asunto
// ============================================================================
// Va por el mismo carril que los avisos de arriba: perfiles ADMIN, Resend, y
// el asunto como única parte en claro de cada salto. Acá eso está resuelto por
// construcción — la ruta es una PLANTILLA (`/[locale]/my-company/[section]`) o viene
// tachada, así que el asunto no puede nombrar una sala ni un documento. El
// requestId, el mensaje y el conteo van en el cuerpo, que sí viaja cifrado.
// ============================================================================

export interface ServerErrorAlertEmailInput {
  route: string
  errorName: string
  status: number
  message: string
  requestId: string
  method?: string
  synthetic: boolean
  digest?: string
  occurrences: number
  suppressedRepeats: number
  url: string
}

export function buildServerErrorAlertEmail(input: ServerErrorAlertEmailInput): TeamAlertEmail {
  const heading = input.synthetic ? 'Probe sintético de 5xx' : 'Error 5xx en producción'
  const where = input.method ? `${input.method} ${input.route}` : input.route
  const body = input.synthetic
    ? `Alguien del equipo forzó un ${input.status} en ${where} para comprobar que la alerta llega. No hay nada roto.`
    : `${where} respondió ${input.status}. Revisa los logs del deploy y el evento en PostHog antes de tocar producto.`

  const bullets = [
    `Error: ${input.errorName}`,
    `Mensaje: ${input.message}`,
    `requestId: ${input.requestId}`,
    ...(input.digest ? [`Huella del mensaje: ${input.digest}`] : []),
    ...(input.occurrences > 1 ? [`Repeticiones en esta ventana: ${input.occurrences}`] : []),
    ...(input.suppressedRepeats > 0
      ? [`Repeticiones silenciadas desde el aviso anterior: ${input.suppressedRepeats}`]
      : []),
  ]
  const cta = 'Abrir el panel del equipo'

  const text = [
    `${heading} — ${where}`,
    '',
    body,
    '',
    ...bullets.map((line) => `- ${line}`),
    '',
    `${cta}: ${input.url}`,
    '',
  ].join('\n')

  return {
    subject: `[Sherlock] Error 5xx en ${input.route}`,
    html: renderTeamEmailHtml({ heading, body, bullets, cta, url: input.url }),
    text,
  }
}
