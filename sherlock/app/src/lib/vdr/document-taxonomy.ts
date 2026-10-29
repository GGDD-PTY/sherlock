// ============================================================================
// TAXONOMÍA DE CARPETAS DEL DATA ROOM
// ============================================================================
// Todo en este módulo es una búsqueda que puede fallar y caer a un default.
// Antes cada default era una posición del arreglo (`VDR_DOCUMENT_FOLDERS[
// length - 1]`, `VDR_SHELL_FOLDERS[1]`): reordenar la tabla —algo que nadie
// asocia con romper nada— cambiaba en silencio a qué carpeta cae un documento
// sin clasificar. Con `Option` el default se nombra en el `getOrElse` y deja de
// depender del orden. `Schema.Literals` fija el dominio de las cinco carpetas
// del shell, así que `VDR_SHELL_FALLBACK_FOLDER` no puede apuntar a un valor
// que no existe sin que el compilador lo diga.
// ============================================================================

import { Array as EffectArray, Option, Schema } from 'effect'

export type VdrLocale = 'es'

export type VdrFolderOption = {
  value: string
  label: Record<VdrLocale, string>
  aliases?: string[]
}

// El dominio cerrado de la estructura visible. Cualquier valor fuera de estos
// cinco no es una carpeta del shell, es texto libre que hay que rutear.
const VdrShellFolderValueSchema = Schema.Literals([
  'room_legal',
  'room_corporate',
  'room_financial',
  'room_operations',
  'room_marketing',
])
export type VdrShellFolderValue = typeof VdrShellFolderValueSchema.Type

const VDR_LEGACY_FOLDERS: VdrFolderOption[] = [
  {
    value: 'teaser',
    label: { es: 'Teaser / Resumen Ejecutivo' },
  },
  {
    value: 'management_presentation',
    label: { es: 'Presentación de Management' },
    aliases: ['pitch', 'deck', 'presentation', 'presentacion'],
  },
  {
    value: 'financials',
    label: { es: 'Estados Financieros' },
    aliases: ['financieros', 'financial', 'financial statements'],
  },
  {
    value: 'model',
    label: { es: 'Modelo Financiero' },
    aliases: ['modelo', 'financial model', 'projections', 'proyecciones'],
  },
  {
    value: 'cap_table',
    label: { es: 'Tabla de Capitalización' },
    aliases: [
      'cap table',
      'capitalization',
      'capitalization table',
      'cap ownership',
      'accionistas',
    ],
  },
  {
    value: 'qoe',
    label: { es: 'Quality of Earnings' },
    aliases: ['qoe', 'earnings quality', 'calidad de utilidades'],
  },
  {
    value: 'debt_schedule',
    label: { es: 'Cronograma de deuda' },
    aliases: ['debt schedule', 'cronograma deuda', 'loan schedule', 'covenant'],
  },
  {
    value: 'legal',
    label: { es: 'Documentos Legales' },
    aliases: ['legal', 'legal documents'],
  },
  {
    value: 'operations',
    label: { es: 'KPIs operativos' },
    aliases: ['operaciones', 'operating', 'operating kpis', 'operations', 'kpi'],
  },
  {
    value: 'data_room_index',
    label: { es: 'Índice del Data Room' },
    aliases: ['data room index', 'diligence', 'manifest', 'source index', 'indice', 'index'],
  },
  {
    value: 'technical',
    label: { es: 'Técnico / Producto' },
    aliases: ['technical', 'technical product', 'tecnico', 'product'],
  },
]

const VDR_OTHER_FOLDER: VdrFolderOption = {
  value: 'other',
  label: { es: 'Otros' },
  aliases: ['other', 'otros', 'general'],
}

// Estructura VISIBLE del shell del data room: cinco carpetas fijas de primer
// nivel, sin subcarpetas. No es una jerarquía — no existen nodos, padres ni
// rutas. Cada entrada absorbe (por alias) los valores heredados de la taxonomía
// de 12 categorías, que se conserva intacta para los documentos ya guardados.
//
// La etiqueta del default vive en su propia constante porque
// `getVdrShellFolderLabel` la necesita como salida terminal: sin ella el default
// volvía a ser una posición del arreglo (`VDR_SHELL_FOLDERS[1]`).
const VDR_SHELL_FALLBACK_LABEL: Record<VdrLocale, string> = { es: '2. Corporativos' }

const SHELL_FOLDERS = [
  {
    value: 'room_legal',
    label: { es: '1. Legales' },
    aliases: ['1. legal', 'legal', 'legales'],
  },
  {
    value: 'room_corporate',
    label: VDR_SHELL_FALLBACK_LABEL,
    aliases: ['2. corporate', 'cap_table', 'data_room_index', 'corporativos', 'corporate'],
  },
  {
    value: 'room_financial',
    label: { es: '3. Financieros' },
    aliases: ['3. financial', 'financials', 'model', 'qoe', 'debt_schedule', 'financieros'],
  },
  {
    value: 'room_operations',
    label: { es: '4. Operaciones' },
    aliases: ['4. operations', 'operations', 'technical', 'operaciones'],
  },
  {
    value: 'room_marketing',
    label: { es: '5. Materiales de mercadeo' },
    aliases: [
      '5. marketing materials',
      'teaser',
      'management_presentation',
      'materiales de mercadeo',
      'mercadeo financiero',
    ],
  },
] satisfies ReadonlyArray<{
  value: VdrShellFolderValue
  label: Record<VdrLocale, string>
  aliases: string[]
}>

// El `satisfies` de arriba es el candado: una carpeta del shell cuyo `value` no
// esté en `VdrShellFolderValueSchema` no compila, y el dominio deja de poder
// divergir de la tabla.
export const VDR_SHELL_FOLDERS: VdrFolderOption[] = [...SHELL_FOLDERS]

// El orden manda para agrupar y para la primera coincidencia de `findVdrFolder`,
// pero ya NO decide el default: ese es `VDR_OTHER_FOLDER` por nombre.
export const VDR_DOCUMENT_FOLDERS: VdrFolderOption[] = [
  ...VDR_LEGACY_FOLDERS,
  ...VDR_SHELL_FOLDERS,
  VDR_OTHER_FOLDER,
]

export const VDR_SHELL_FOLDER_VALUES = VDR_SHELL_FOLDERS.map((folder) => folder.value)

/** Carpeta de destino para todo valor heredado o desconocido. */
export const VDR_SHELL_FALLBACK_FOLDER = 'room_corporate' satisfies VdrShellFolderValue

export const VDR_DOCUMENT_CATEGORY_TABS: VdrFolderOption[] = [
  { value: 'all', label: { es: 'Todos' } },
  ...VDR_DOCUMENT_FOLDERS,
]

function normalizeValue(value: string | null | undefined) {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_/-]+/g, ' ')
    .trim()
}

/** Los términos por los que se puede nombrar una carpeta: valor, etiqueta y alias. */
function folderTerms(option: VdrFolderOption): string[] {
  return [option.value, option.label.es, ...(option.aliases ?? [])].map(normalizeValue)
}

// El default es `VDR_OTHER_FOLDER` por nombre, no por posición: antes era la
// última entrada de la tabla y mover `other` de lugar mandaba los documentos sin
// clasificar a `technical`.
function findVdrFolder(value: string | null | undefined): VdrFolderOption {
  const normalizedValue = normalizeValue(value)

  return EffectArray.findFirst(VDR_DOCUMENT_FOLDERS, (option) =>
    folderTerms(option).includes(normalizedValue)
  ).pipe(Option.getOrElse(() => VDR_OTHER_FOLDER))
}

// Valor canónico de carpeta (cae a `other`). La tabla del data room agrupa por
// este valor y ordena los grupos según VDR_DOCUMENT_FOLDERS, no alfabéticamente
// por la etiqueta traducida.
// ============================================================================
// RUTEO POR NOMBRE — la landing no pregunta carpeta; el nombre del archivo decide
// ============================================================================
// Tabla de reglas en orden de prioridad: la primera que coincide gana. Los
// tokens cortos (`ina`, `int`, `eeff`, `nda`, `cim`) sólo cuentan como palabra
// completa; el resto se busca como frase dentro del nombre normalizado. Sin
// coincidencia cae a `VDR_SHELL_FALLBACK_FOLDER`, donde el equipo lo mueve.
// INA/INT (informes de actualización anual y trimestral de la SMV) van a
// Financieros porque el checklist del cliente pide "algo en Financieros" y esos
// son los estados financieros que el equipo necesita primero.

const INTAKE_FOLDER_RULES: ReadonlyArray<{
  folder: string
  tokens: readonly string[]
  phrases: readonly string[]
}> = [
  {
    folder: 'room_financial',
    tokens: ['ina', 'int', 'eeff', 'ef', 'pl', 'p&l'],
    phrases: [
      'estados financieros',
      'estado financiero',
      'financial statement',
      'financials',
      'financieros',
      'auditad',
      'audited',
      'balance',
      'flujo de caja',
      'cash flow',
      'presupuesto',
      'budget',
      'modelo financiero',
      'financial model',
      'informe de actualizacion',
      'informe trimestral',
      'resultados',
      'income statement',
    ],
  },
  {
    folder: 'room_marketing',
    tokens: ['cim', 'deck'],
    phrases: [
      'teaser',
      'presentacion',
      'presentation',
      'brochure',
      'mercadeo',
      'marketing',
      'memorandum',
    ],
  },
  {
    folder: 'room_legal',
    tokens: ['nda'],
    phrases: [
      'contrato',
      'contract',
      'confidencialidad',
      'licencia',
      'license',
      'permiso',
      'poder',
      'litigio',
      'demanda',
      'legal',
      'garantia',
      'fideicomiso',
      'prospecto',
    ],
  },
  {
    folder: 'room_operations',
    tokens: [],
    phrases: [
      'operacion',
      'operation',
      'inventario',
      'inventory',
      'nomina',
      'payroll',
      'planta',
      'proceso',
      'proveedor',
      'supplier',
      'kpi',
    ],
  },
  {
    folder: 'room_corporate',
    tokens: ['ruc'],
    phrases: [
      'pacto social',
      'estatuto',
      'acta',
      'asamblea',
      'junta directiva',
      'organigrama',
      'cap table',
      'accionista',
      'shareholder',
      'registro publico',
      'aviso de operacion',
      'certificado',
    ],
  },
]

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, '')
}

export function inferVdrFolderFromName(name: string | null | undefined): string {
  const haystack = normalizeValue(stripExtension(name ?? ''))
  if (!haystack) return VDR_SHELL_FALLBACK_FOLDER
  const tokens = new Set(haystack.split(/[^a-z0-9&]+/).filter(Boolean))

  return EffectArray.findFirst(
    INTAKE_FOLDER_RULES,
    (rule) =>
      rule.tokens.some((token) => tokens.has(token)) ||
      rule.phrases.some((phrase) => haystack.includes(phrase))
  ).pipe(
    Option.map((rule) => rule.folder),
    Option.getOrElse(() => VDR_SHELL_FALLBACK_FOLDER)
  )
}

export function getVdrFolderValue(value: string | null | undefined): string {
  return findVdrFolder(value).value
}

export function getVdrFolderLabel(value: string | null | undefined, locale: VdrLocale) {
  return findVdrFolder(value).label[locale]
}

// Primera entrada gana: dos carpetas del shell que reclamen el mismo término
// harían el ruteo dependiente del orden de la tabla. Que no haya colisiones lo
// fija `document-taxonomy.test.ts`; acá el desempate es determinista y no
// revienta la sala en el navegador.
const SHELL_FOLDER_BY_TERM = new Map<string, VdrShellFolderValue>()
for (const folder of SHELL_FOLDERS) {
  for (const term of folderTerms(folder)) {
    if (!SHELL_FOLDER_BY_TERM.has(term)) SHELL_FOLDER_BY_TERM.set(term, folder.value)
  }
}

const isShellFolderValue = Schema.is(VdrShellFolderValueSchema)

function lookupShellFolder(value: string | null | undefined): Option.Option<VdrShellFolderValue> {
  return Option.fromUndefinedOr(SHELL_FOLDER_BY_TERM.get(normalizeValue(value)))
}

/**
 * Migración suave en cliente: traduce cualquier valor de `folder` guardado
 * (taxonomía de 12, etiquetas legadas o texto libre) a una de las cinco
 * carpetas fijas del shell. Nunca escribe en la base: solo decide dónde se ve.
 */
export function getVdrShellFolderValue(value: string | null | undefined): string {
  // Un valor ya canónico se devuelve tal cual, sin pasar por el mapa de alias.
  if (isShellFolderValue(value)) return value

  return lookupShellFolder(value).pipe(
    Option.orElse(() => lookupShellFolder(getVdrFolderValue(value))),
    Option.getOrElse(() => VDR_SHELL_FALLBACK_FOLDER)
  )
}

// El default se nombra: `VDR_SHELL_FALLBACK_LABEL`, la etiqueta de la carpeta a
// la que cae todo lo no reconocido. Antes era `VDR_SHELL_FOLDERS[1]`, correcto
// sólo mientras `room_corporate` siguiera segunda en la tabla.
export function getVdrShellFolderLabel(value: string | null | undefined, locale: VdrLocale) {
  const resolved = getVdrShellFolderValue(value)

  return EffectArray.findFirst(SHELL_FOLDERS, (option) => option.value === resolved).pipe(
    Option.map((folder) => folder.label),
    Option.getOrElse(() => VDR_SHELL_FALLBACK_LABEL),
    (label) => label[locale]
  )
}
