// ============================================================================
// COPY — ACTIVIDAD DEL DATA ROOM
// ============================================================================
// Español panameño (tuteo). Sin emojis, sin lenguaje de retornos. Al equipo
// se le dice "el equipo".
//
// ===== LA COSTURA CON EFFECT =====
// Las dos listas cerradas de esta pantalla —el idioma y los cuatro períodos—
// se definen con `Schema.Literals` y su tipo se deriva de ahí. El período
// importa: viaja a la query de Convex, y el `<Select>` lo entrega como cadena.
// Con la definición a mano, `Number(value)` metía cualquier número en la
// consulta; con el schema, o es uno de los cuatro o no es.
// ============================================================================

import { Option, Schema } from 'effect'

const LocaleSchema = Schema.Literals(['es'])
export type Locale = typeof LocaleSchema.Type

const decodeLocale = Schema.decodeUnknownOption(LocaleSchema)

export function normalizeLocale(locale: string): Locale {
  const decoded = decodeLocale(locale)
  return Option.isSome(decoded) ? decoded.value : 'es'
}

export const WINDOW_OPTIONS = [7, 30, 90, 365] as const
const WindowDaysSchema = Schema.Literals(WINDOW_OPTIONS)
export type WindowDays = typeof WindowDaysSchema.Type

const decodeWindowDays = Schema.decodeUnknownOption(WindowDaysSchema)

/** El período pedido por el `<Select>`, o el que ya estaba si no es ninguno. */
export function windowDaysOr(value: unknown, fallback: WindowDays): WindowDays {
  const decoded = decodeWindowDays(typeof value === 'string' ? Number(value) : value)
  return Option.isSome(decoded) ? decoded.value : fallback
}

export const activityCopy = {
  es: {
    backToDataRoom: 'Volver al Data Room',
    title: 'Actividad del Data Room',
    subtitle: (companyName: string) =>
      `Quién abrió y quién descargó los documentos de ${companyName}`,
    window: 'Período',
    window7: 'Últimos 7 días',
    window30: 'Últimos 30 días',
    window90: 'Últimos 90 días',
    window365: 'Último año',
    statViews: 'Vistas',
    statDownloads: 'Descargas',
    statCounterparties: 'Contrapartes',
    statDocuments: 'Documentos con actividad',
    tabDocuments: 'Por documento',
    tabCounterparties: 'Por contraparte',
    colDocument: 'Documento',
    colAccess: 'Acceso',
    colCounterparty: 'Contraparte',
    colCounterparties: 'Contrapartes',
    colDocuments: 'Documentos',
    colViews: 'Vistas',
    colDownloads: 'Descargas',
    colBlocked: 'Bloqueados',
    colLastAccess: 'Último acceso',
    accessPublic: 'Teaser',
    accessNda: 'NDA',
    accessPrivate: 'Privado',
    counterpartyPrefix: 'Contraparte',
    teamLabel: 'Equipo Sherlock',
    unknownLabel: 'Perfil no disponible',
    unknownDocument: 'Documento sin nombre',
    unknownDate: 'Fecha no disponible',
    identityHidden: 'Identidad no revelada',
    identityHiddenHint:
      'Ves la actividad, no la identidad. El nombre aparece cuando se aprueba el acceso.',
    kindView: 'Vista',
    kindDownload: 'Descarga',
    kindLink: 'Enlace generado',
    kindBlocked: 'Bloqueado',
    kindOther: 'Otro',
    linkNote: 'Un enlace generado que no terminó en entrega no cuenta como descarga.',
    drawerTitle: 'Eventos',
    // El rótulo «(UTC)» se cae con la zona: desde [F] 2026-09-17 la columna
    // imprime hora de Panamá, y un encabezado que dijera UTC mentiría.
    drawerColWhen: 'Fecha y hora',
    drawerColAction: 'Acción',
    drawerColDocument: 'Documento',
    drawerColCounterparty: 'Contraparte',
    truncatedNotice: (count: number) => `Mostrando los ${count} eventos más recientes del período.`,
    emptyActionDataRoom: 'Ir al Data Room',
    emptyNoActivityTitle: 'Sin actividad en este período',
    emptyNoActivityBody: 'Nadie abrió tus documentos en el rango seleccionado.',
    emptyNoActivityAction: 'Ampliar a un año',
  },
} satisfies Record<Locale, Record<string, unknown>>
