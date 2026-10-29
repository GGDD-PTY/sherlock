#!/usr/bin/env node
// ============================================================================
// VDR PUSH (operador)
// ============================================================================
// Devuelve UN entregable de Mycroft a la sala de UNA empresa, con etiqueta y
// nota. Es la mitad de salida del ciclo manual; la de entrada es `vdr-pull.mjs`.
//
// Idempotente por sha: antes de subir bytes le pregunta al deployment si ese
// mismo contenido ya es la versión vigente del documento. Ese sondeo evita el
// blob huérfano, pero no es la autoridad — la mutation vuelve a resolver el
// destino del lado servidor.
//
// Su única superficie Convex es `operatorDeliverables:*`, toda `internal*` y por
// lo tanto solo alcanzable con la deploy key del deployment.
//
// `--company` acepta el nombre EXACTO o el companyId, igual que el pull. El
// nombre resuelto se imprime antes de escribir; con un id (que nadie puede
// leer) hace falta `--yes`.
//
// Uso:
//   bun --cwd=sherlock/app run vdr:push -- --company "Sample Hydro" \
//     --file ~/Developer/mycroft-taller/inbox/…/modelo.xlsx --folder room_financial \
//     --name "Modelo financiero" --label v1 --note "Borrador para revisión." \
//     --slot MODEL
//   bun --cwd=sherlock/app run vdr:push -- --company "Sintética Uno, S. A." \
//     --deployment local --file modelo.xlsx --version v1 --note "prueba local"
//
// `--slot <KIND>` es opcional y avanza la fila de `deliverables` de esa empresa
// hasta DELIVERED en la misma mutation que publica la versión: sin él el rail
// del cliente se queda quieto hasta que alguien mueva el slot a mano en admin.
// Si el sha ya es la versión vigente, `--slot` (con `--note`) sella el slot
// sobre esa versión sin subir bytes: así se repara una entrega que salió sin
// `--slot`.
// ============================================================================

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXIT_FAILED,
  EXIT_REFUSED,
  OperatorCliError,
  resolveDeployment,
  restoreEnvLocal,
  runOperatorFunction as runConvexFunction,
} from './convex-deployment.mjs'

// Espejo de `VDR_SHELL_FOLDERS` en `src/lib/vdr/document-taxonomy.ts`, que un
// script `.mjs` no puede importar. Es cinturón, no tirante: la mutation corre
// `validateVdrShellFolderDestination` igual, y esta lista solo existe para que
// una llave mal escrita muera en la Mac del operador y no gaste una subida.
const ROOM_FOLDERS = [
  'room_legal',
  'room_corporate',
  'room_financial',
  'room_operations',
  'room_marketing',
]

// Espejo de `DELIVERABLE_KINDS` en `convex/_deliverables/model.ts`, por la misma
// razón que `ROOM_FOLDERS`: un kind mal escrito muere acá, antes de gastar una
// subida. La autoridad sigue siendo el validador de la mutation.
const DELIVERABLE_KINDS = [
  'MODEL',
  'TEASER',
  'CIM',
  'MGMT_PRESENTATION',
  'DEBT_DECK',
  'EQUITY_DECK',
  'QA',
  'IRL',
]

// Mismo techo que impone `normalizeDeliveryNote` (`convex/_deliverables/
// manualDelivery.ts`), la única frontera que valida la nota del lado servidor.
// Se comprueba acá porque la mutation la rechaza DESPUÉS de subir los bytes: sin
// este freno, una nota larga deja el blob escrito y la entrega a medias.
const NOTE_MAX_CHARS = 500

const CONTENT_TYPE_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.csv': 'text/csv',
}

function log(message) {
  process.stdout.write(`[vdr-push] ${message}\n`)
}

function warn(message) {
  process.stderr.write(`[vdr-push] ${message}\n`)
}

// Mismo criterio que `matchesExactName` del lado servidor: nombre EXACTO, sin
// exigir mayúsculas idénticas y sin parecidos.
function sameName(candidate, needle) {
  if (!candidate) return false
  return candidate.trim().localeCompare(needle, undefined, { sensitivity: 'accent' }) === 0
}

function warnSlotUnmoved(slot) {
  warn(`el slot ${slot} NO se movió. Muévelo desde admin si el rail tiene que avanzar.`)
}

function fail(message, code = EXIT_FAILED) {
  process.stderr.write(`[vdr-push] ${message}\n`)
  process.exit(code)
}

async function orFail(action) {
  try {
    const result = await action()
    return result
  } catch (error) {
    if (error instanceof OperatorCliError) fail(error.message, error.code)
    throw error
  }
}

function parseArgs(argv) {
  const options = {
    company: null,
    file: null,
    folder: null,
    name: null,
    label: null,
    note: null,
    document: null,
    slot: null,
    deployment: 'dev',
    yes: false,
  }
  const single = {
    '--company': 'company',
    '--file': 'file',
    '--folder': 'folder',
    '--name': 'name',
    '--label': 'label',
    '--note': 'note',
    '--document': 'document',
    '--slot': 'slot',
    '--deployment': 'deployment',
    '--version': 'label',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--yes') {
      options.yes = true
      continue
    }
    const key = single[arg]
    if (!key) {
      fail(`argumento desconocido: ${arg}`, EXIT_REFUSED)
    }
    options[key] = argv[++index] ?? null
  }

  if (!options.company) fail('falta --company <companyId|nombre exacto>', EXIT_REFUSED)
  if (!options.file) fail('falta --file <ruta>', EXIT_REFUSED)
  if (!options.folder) {
    if (options.deployment === 'local') {
      options.folder = 'room_financial'
    } else {
      fail(`falta --folder, una de: ${ROOM_FOLDERS.join(', ')}`, EXIT_REFUSED)
    }
  }
  if (!ROOM_FOLDERS.includes(options.folder)) {
    fail(
      `--folder ${options.folder} no existe. Usa una de: ${ROOM_FOLDERS.join(', ')}`,
      EXIT_REFUSED
    )
  }
  if (options.slot !== null && !DELIVERABLE_KINDS.includes(options.slot)) {
    fail(
      `--slot ${options.slot} no existe. Usa uno de: ${DELIVERABLE_KINDS.join(', ')}`,
      EXIT_REFUSED
    )
  }
  if (options.note !== null && options.note.trim().length > NOTE_MAX_CHARS) {
    fail(`La nota tiene ${options.note.trim().length} caracteres; el máximo es ${NOTE_MAX_CHARS}.`)
  }
  // Escribir en la sala de un cliente real no se hace por inercia: prod exige
  // la confirmación explícita ANTES de tocar la red.
  if (options.deployment === 'prod' && !options.yes) {
    fail('--deployment prod exige --yes', EXIT_REFUSED)
  }
  if (!existsSync(options.file)) {
    fail(`el archivo no existe: ${options.file}`, EXIT_REFUSED)
  }
  options.name ??= basename(options.file, extname(options.file))
  return options
}

// Resolver la empresa como lo hace el pull: por id o por nombre EXACTO. El push
// aceptaba cualquier `companyId` válido sin decir de quién era la sala, así que
// un id de más en el portapapeles escribía en la empresa equivocada en silencio.
async function resolveCompany(target, typed) {
  const resolved = await orFail(() =>
    runConvexFunction(target, 'operatorDeliverables:resolveCompany', { query: typed })
  )
  const matches = resolved?.matches ?? []
  if (matches.length === 0) {
    fail(`ninguna empresa coincide con "${typed}"`, EXIT_REFUSED)
  }
  if (matches.length > 1) {
    process.stderr.write(`[vdr-push] "${typed}" coincide con ${matches.length} empresas:\n`)
    for (const match of matches) {
      process.stderr.write(`[vdr-push]   ${match.companyId}  ${match.name}\n`)
    }
    fail('pasa el companyId exacto en --company', EXIT_REFUSED)
  }
  return matches[0]
}

// Mismos bytes y `--slot`: el rail se mueve sobre la versión vigente sin
// subir nada. Es la única forma de reparar una entrega cuyo push salió sin
// `--slot` (o cuyo slot no se movió). La nota es obligatoria porque es el
// sello de la versión y lo que el cliente lee en la campanita. Lo llaman el
// sondeo previo (sin haber subido nada) y, si el sha entró como vigente entre
// el sondeo y la subida, la respuesta ALREADY_CURRENT de la propia mutation de
// publicación: ahí los bytes SÍ viajaron, y el log lo dice tal cual.
async function sealCurrentVersion(
  target,
  { companyId, documentId, versionNumber, uploaded, options }
) {
  if (!options.note) {
    fail('sellar el slot sobre la versión vigente exige --note', EXIT_REFUSED)
  }
  const sealed = await orFail(() =>
    runConvexFunction(target, 'operatorDeliverables:sealCurrentVersion', {
      companyId,
      documentId,
      slot: options.slot,
      note: options.note,
    })
  )
  if (sealed?.delivered) {
    log(
      `slot ${options.slot}: ${sealed.from} → ${sealed.status} ` +
        `(v${sealed.versionNumber ?? versionNumber}, versión vigente, ` +
        `${uploaded ? 'tras subir bytes' : 'sin subir bytes'})`
    )
    if (sealed.noteApplied === false) {
      warn('la versión ya traía nota del equipo: se conservó la anterior, --note se ignoró')
    }
  } else {
    log(`slot ${options.slot} ya estaba entregado con esta versión`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const target = await orFail(() => resolveDeployment({ deployment: options.deployment }))
  log(`deployment ${target.deployment}`)

  const company = await resolveCompany(target, options.company)
  // El nombre se imprime ANTES de cualquier escritura: es lo único que el
  // operador puede leer para saber en qué sala va a caer el entregable.
  log(`empresa ${company.name} (${company.companyId})`)
  if (!options.yes && !sameName(company.name, options.company)) {
    fail(
      `--company "${options.company}" resolvió a "${company.name}". ` +
        'Escribe el nombre exacto o confirma con --yes.',
      EXIT_REFUSED
    )
  }
  const companyId = company.companyId

  const bytes = readFileSync(options.file)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const contentType =
    CONTENT_TYPE_BY_EXTENSION[extname(options.file).toLowerCase()] ?? 'application/octet-stream'

  const probe = await orFail(() =>
    runConvexFunction(target, 'operatorDeliverables:inspectDeliverableTarget', {
      companyId,
      ...(options.document ? { documentId: options.document } : {}),
      name: options.name,
      sha256,
    })
  )

  // El deployment vuelve a decir de quién es la sala, ya con el `companyId`
  // resuelto: si no coincide con lo que se le mostró al operador, no se escribe.
  if (probe?.companyName && !sameName(probe.companyName, company.name)) {
    fail(
      `el deployment dice que ${companyId} es "${probe.companyName}", no "${company.name}"`,
      EXIT_REFUSED
    )
  }
  log(`sala de ${probe?.companyName ?? company.name} · destino ${probe?.status ?? 'desconocido'}`)

  if (probe?.status === 'ALREADY_CURRENT') {
    log(
      `"${options.name}" ya es la versión vigente del documento ${probe.documentId} ` +
        `(v${probe.versionNumber}, sha ${sha256.slice(0, 12)}…). No se sube nada.`
    )
    if (!options.slot) return
    await sealCurrentVersion(target, {
      companyId,
      documentId: probe.documentId,
      versionNumber: probe.versionNumber,
      uploaded: false,
      options,
    })
    return
  }
  if (probe?.status === 'AMBIGUOUS') {
    process.stderr.write(`[vdr-push] "${options.name}" coincide con varios documentos activos:\n`)
    for (const candidate of probe.candidates ?? []) {
      process.stderr.write(
        `[vdr-push]   ${candidate.documentId}  ${candidate.folder}  ${candidate.name}\n`
      )
    }
    fail('indica cuál con --document <documentId>')
  }
  if (probe?.status === 'MISMATCH') {
    fail(`--document ${options.document} no pertenece a la empresa ${companyId}`)
  }

  const uploadUrl = await orFail(() =>
    runConvexFunction(target, 'operatorDeliverables:createDeliverableUploadUrl', {
      companyId,
    })
  )
  if (typeof uploadUrl !== 'string' || uploadUrl.length === 0) {
    fail('operatorDeliverables:createDeliverableUploadUrl no devolvió una URL')
  }

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: bytes,
  })
  if (!response.ok) {
    fail(`la subida a Convex Storage falló (${response.status})`)
  }
  const payload = await response.json()
  const storageId = payload?.storageId
  if (typeof storageId !== 'string' || storageId.length === 0) {
    fail('Convex Storage no devolvió storageId')
  }

  const published = await orFail(() =>
    runConvexFunction(target, 'operatorDeliverables:publishDeliverable', {
      companyId,
      ...(options.document ? { documentId: options.document } : {}),
      storageId,
      name: options.name,
      folder: options.folder,
      ...(options.label ? { label: options.label } : {}),
      ...(options.note ? { note: options.note } : {}),
      ...(options.slot ? { slot: options.slot } : {}),
    })
  )

  if (published?.kind === 'ALREADY_CURRENT') {
    log(
      `el deployment ya tenía este sha como versión vigente del documento ${published.documentId}`
    )
    // El sha entró como vigente entre el sondeo y la subida. El slot se sella
    // igual que si el sondeo lo hubiera dicho: dejarlo en «NO se movió» obligaba
    // a un segundo push para reparar lo que este ya podía cerrar.
    if (options.slot) {
      await sealCurrentVersion(target, {
        companyId,
        documentId: published.documentId,
        versionNumber: published.versionNumber,
        uploaded: true,
        options,
      })
    }
    return
  }

  const folder = published?.folder ?? options.folder
  if (published?.folderIgnored) {
    warn(
      `--folder ${options.folder} se IGNORÓ: el documento ${published?.documentId} vive en ` +
        `${folder} y una versión nueva no lo mueve. Muévelo desde la sala si de verdad va en ` +
        `${options.folder}.`
    )
  }

  // La firma la deriva la mutation del content-type que el storage registró.
  // Un `.xlsx` sin extensión, o una extensión que no está en la tabla, cae a
  // UNKNOWN: el entregable NO quedó publicado. Anunciarlo como "versión nueva"
  // es la mentira cara — el operador cierra la terminal creyendo que entregó.
  if (published?.signatureVerified === false) {
    warn(
      `el entregable quedó EN CUARENTENA (v${published?.versionNumber ?? '?'} del documento ` +
        `${published?.documentId}): la firma no se pudo verificar desde ` +
        `${extname(options.file) || 'un archivo sin extensión'}. El cliente sigue viendo la ` +
        'versión anterior. Vuelve a subirlo con la extensión correcta.'
    )
    if (options.slot) warnSlotUnmoved(options.slot)
    process.exit(EXIT_FAILED)
  }

  const what =
    published?.kind === 'CREATED'
      ? 'documento nuevo'
      : `versión nueva v${published?.versionNumber ?? '?'}`
  const stamp = [
    options.label ? `etiqueta ${options.label}` : null,
    options.note ? `nota "${options.note}"` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  log(`${what} en ${folder}: documento ${published?.documentId}${stamp ? ` · ${stamp}` : ''}`)

  // El estado de antes y el de después en una línea: es lo único que le dice al
  // operador si el rail del cliente se movió con este push.
  if (published?.slot) {
    log(
      `slot ${published.slot.kind}: ${published.slot.from} → ${published.slot.to} ` +
        `(v${published?.versionNumber ?? '?'})`
    )
  } else if (options.slot) {
    warnSlotUnmoved(options.slot)
  }
}

// Importar el módulo no puede correr el push: los tests cargan este archivo
// y sin este guard `main()` se comía el proceso de vitest. `realpath` iguala
// `/var/folders` con `/private/var/folders` cuando el test copia el script.
function isDirectRun(argvPath) {
  if (!argvPath) return false
  const self = fileURLToPath(import.meta.url)
  try {
    return realpathSync(self) === realpathSync(argvPath)
  } catch {
    return self === resolve(argvPath)
  }
}

if (isDirectRun(process.argv[1])) {
  try {
    await main()
  } finally {
    restoreEnvLocal()
  }
}
