// ============================================================================
// Carril de entregables del operador (convex/operatorDeliverables.ts)
// ============================================================================
// Lo que este carril no puede equivocarse:
//  - resolver la empresa: por id, por nombre exacto, y decir "hay varias" en vez
//    de escoger una (ahí es donde un script mezclaría dos clientes);
//  - traducir la carpeta guardada a la llave que la sala muestra;
//  - subir el mismo sha dos veces sin duplicar versión ni fila.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'

import {
  inspectDeliverableTarget,
  listCompanyDocuments,
  publishDeliverable,
  resolveCompany,
  sealCurrentVersion,
} from '../../../convex/operatorDeliverables'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const COMPANY = 'company_sampleenergy'
const COMPANY_NAME = 'Sample Hydro, S.A.'
const OTHER_COMPANY = 'company_andina'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

// El harness no simula `ctx.storage`; `listCompanyDocuments` pide una URL de
// descarga y este envoltorio la devuelve determinista.
function ctxWithStorage(tables: Tables) {
  const base = createConvexCtx(tables)
  return {
    ...base,
    storage: { getUrl: vi.fn(async (id: string) => `https://storage.test/${id}`) },
  }
}

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    companies: [
      {
        _id: COMPANY,
        name: COMPANY_NAME,
        legalName: 'Sample Hydro',
        ownerId: 'profile_owner',
      },
      { _id: OTHER_COMPANY, name: 'Andina Capital', ownerId: 'profile_owner' },
    ],
    profiles: [
      { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY' },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
    ],
    users: [
      { _id: 'user_owner', email: 'fixture-befbb74d@example.com' },
      { _id: 'user_admin', email: 'fixture-dbeda5ff@example.com' },
    ],
    documents: [],
    documentVersions: [],
    documentAccessGrants: [],
    activityLogs: [],
    adminAuditLogs: [],
    _storage: [{ _id: 'blob_a', contentType: XLSX_MIME, size: 2048, sha256: SHA_A }],
    ...overrides,
  }
}

function publishArgs(overrides: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY,
    storageId: 'blob_a',
    name: 'Modelo financiero',
    folder: 'room_financial',
    ...overrides,
  }
}

describe('operatorDeliverables.resolveCompany', () => {
  it('resuelve por companyId', async () => {
    const ctx = ctxWithStorage(baseTables())

    const result = await runHandler<{ query: string }, { matches: Array<{ companyId: string }> }>(
      resolveCompany,
      ctx,
      { query: COMPANY }
    )

    expect(result.matches).toEqual([
      { companyId: COMPANY, name: COMPANY_NAME, legalName: 'Sample Hydro' },
    ])
  })

  it('resuelve por nombre exacto y no por parecido', async () => {
    const ctx = ctxWithStorage(baseTables())

    const exact = await runHandler<{ query: string }, { matches: unknown[] }>(resolveCompany, ctx, {
      query: COMPANY_NAME,
    })
    const partial = await runHandler<{ query: string }, { matches: unknown[] }>(
      resolveCompany,
      ctx,
      { query: 'Sample' }
    )

    expect(exact.matches).toHaveLength(1)
    expect(partial.matches).toEqual([])
  })

  it('el nombre exacto gana sobre una razón social igual en otra empresa', async () => {
    const tables = baseTables()
    tables.companies.push({
      _id: 'company_seed',
      name: 'Sample Hydro',
      legalName: COMPANY_NAME,
      ownerId: 'profile_seed',
    })
    const ctx = ctxWithStorage(tables)

    const byName = await runHandler<{ query: string }, { matches: Array<{ companyId: string }> }>(
      resolveCompany,
      ctx,
      { query: COMPANY_NAME }
    )
    const seedByName = await runHandler<
      { query: string },
      { matches: Array<{ companyId: string }> }
    >(resolveCompany, ctx, { query: 'Sample Hydro' })

    expect(byName.matches.map((match) => match.companyId)).toEqual([COMPANY])
    expect(seedByName.matches.map((match) => match.companyId)).toEqual(['company_seed'])
  })

  it('cae a la razón social sólo cuando ningún nombre coincide', async () => {
    const tables = baseTables()
    tables.companies.push({
      _id: 'company_legal',
      name: 'Otra, S.A.',
      legalName: 'Sociedad Legal Exacta',
      ownerId: 'profile_legal',
    })
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<{ query: string }, { matches: Array<{ companyId: string }> }>(
      resolveCompany,
      ctx,
      { query: 'Sociedad Legal Exacta' }
    )

    expect(result.matches.map((match) => match.companyId)).toEqual(['company_legal'])
  })

  it('devuelve las dos empresas homónimas en vez de escoger una', async () => {
    const tables = baseTables()
    tables.companies.push({ _id: 'company_gemela', name: COMPANY_NAME, ownerId: 'profile_owner' })
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<{ query: string }, { matches: Array<{ companyId: string }> }>(
      resolveCompany,
      ctx,
      { query: COMPANY_NAME }
    )

    expect(result.matches.map((match) => match.companyId).sort()).toEqual(
      [COMPANY, 'company_gemela'].sort()
    )
  })
})

describe('operatorDeliverables.listCompanyDocuments', () => {
  it('traduce la carpeta heredada a la llave de la sala y omite lo archivado', async () => {
    const tables = baseTables({
      documents: [
        {
          _id: 'doc_modelo',
          companyId: COMPANY,
          name: 'Modelo financiero',
          folder: 'model',
          lifecycleStatus: 'ACTIVE',
          currentVersionId: 'ver_modelo',
        },
        {
          _id: 'doc_viejo',
          companyId: COMPANY,
          name: 'Contrato antiguo',
          folder: 'legal',
          lifecycleStatus: 'ARCHIVED',
          currentVersionId: 'ver_viejo',
        },
      ],
      documentVersions: [
        {
          _id: 'ver_modelo',
          documentId: 'doc_modelo',
          companyId: COMPANY,
          versionNumber: 3,
          storageId: 'blob_a',
          byteSize: 2048,
          sha256: SHA_A,
          detectedMimeType: XLSX_MIME,
        },
        {
          _id: 'ver_viejo',
          documentId: 'doc_viejo',
          companyId: COMPANY,
          versionNumber: 1,
          storageId: 'blob_a',
          byteSize: 10,
          sha256: SHA_B,
          detectedMimeType: 'application/pdf',
        },
      ],
    })
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<
      { companyId: string },
      {
        companyName: string
        documents: Array<{
          documentId: string
          folder: string | null
          shellFolder: string
          url: string
        }>
      }
    >(listCompanyDocuments, ctx, { companyId: COMPANY })

    expect(result.companyName).toBe(COMPANY_NAME)
    expect(result.documents).toHaveLength(1)
    // `folder` conserva el valor GUARDADO y `shellFolder` dice dónde lo ve el
    // cliente hoy. Colapsarlos perdía la clasificación original del documento.
    expect(result.documents[0]).toMatchObject({
      documentId: 'doc_modelo',
      versionId: 'ver_modelo',
      folder: 'model',
      shellFolder: 'room_financial',
      versionNumber: 3,
      url: 'https://storage.test/blob_a',
    })
  })
})

describe('operatorDeliverables.inspectDeliverableTarget', () => {
  // El sondeo es lo único que el push puede imprimir antes de subir bytes: si
  // no dice de quién es la sala, un `companyId` equivocado no se ve nunca.
  it('nombra la empresa del destino en cada respuesta', async () => {
    const ctx = ctxWithStorage(baseTables())

    const nuevo = await runHandler<Record<string, unknown>, { companyName: string | null }>(
      inspectDeliverableTarget,
      ctx,
      { companyId: COMPANY, name: 'Modelo financiero', sha256: SHA_A }
    )

    expect(nuevo.companyName).toBe(COMPANY_NAME)
  })
})

describe('operatorDeliverables.publishDeliverable', () => {
  it('crea el documento y la v1 con etiqueta y nota', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, { kind: string; documentId: string }>(
      publishDeliverable,
      ctx,
      publishArgs({ label: 'v1', note: 'Borrador para revisión del equipo.' })
    )

    expect(result.kind).toBe('CREATED')
    expect(tables.documents).toHaveLength(1)
    expect(tables.documents[0]).toMatchObject({
      companyId: COMPANY,
      name: 'Modelo financiero',
      folder: 'room_financial',
      accessLevel: 'NDA_REQUIRED',
      lifecycleStatus: 'ACTIVE',
      currentVersionNumber: 1,
      sourceType: 'TEAM_DELIVERABLE',
    })
    expect(tables.documentVersions).toHaveLength(1)
    expect(tables.documentVersions[0]).toMatchObject({
      versionNumber: 1,
      sha256: SHA_A,
      signatureKind: 'ZIP',
      verificationStatus: 'SIGNATURE_VERIFIED',
      publicationStatus: 'PUBLISHED',
      deliveryLabel: 'v1',
      deliveryNote: 'Borrador para revisión del equipo.',
    })
    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.activityLogs[0]).toMatchObject({ action: 'VDR_DOCUMENT_VERSION_INGESTED' })
  })

  it('el mismo sha no inserta nada la segunda vez', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    const first = await runHandler<Record<string, unknown>, { versionId: string }>(
      publishDeliverable,
      ctx,
      publishArgs()
    )
    const second = await runHandler<
      Record<string, unknown>,
      { kind: string; versionId: string; versionNumber: number }
    >(publishDeliverable, ctx, publishArgs())

    expect(second).toEqual({
      kind: 'ALREADY_CURRENT',
      documentId: tables.documents[0]._id,
      versionId: first.versionId,
      versionNumber: 1,
    })
    expect(tables.documentVersions).toHaveLength(1)
    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.activityLogs).toHaveLength(1)
  })

  it('un sha distinto publica la v2, reemplaza la v1 y reapunta el documento', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    const first = await runHandler<Record<string, unknown>, { versionId: string }>(
      publishDeliverable,
      ctx,
      publishArgs()
    )
    const documentId = tables.documents[0]._id
    tables.documentAccessGrants.push({
      _id: 'grant_vigente',
      documentId,
      companyId: COMPANY,
      expiresAt: Date.now() + 60_000,
    })
    tables._storage.push({ _id: 'blob_b', contentType: XLSX_MIME, size: 4096, sha256: SHA_B })

    const second = await runHandler<
      Record<string, unknown>,
      { kind: string; versionId: string; versionNumber: number }
    >(publishDeliverable, ctx, publishArgs({ storageId: 'blob_b', label: 'v2' }))

    expect(second.kind).toBe('NEW_VERSION')
    expect(second.versionNumber).toBe(2)
    expect(tables.documentVersions).toHaveLength(2)

    const superseded = tables.documentVersions.find((row) => row._id === first.versionId)
    expect(superseded).toMatchObject({ publicationStatus: 'SUPERSEDED' })

    const published = tables.documentVersions.find((row) => row._id === second.versionId)
    expect(published).toMatchObject({
      versionNumber: 2,
      sha256: SHA_B,
      replacesVersionId: first.versionId,
      deliveryLabel: 'v2',
      publicationStatus: 'PUBLISHED',
    })

    expect(tables.documents[0]).toMatchObject({
      storageId: 'blob_b',
      fileSize: 4096,
      currentVersionId: second.versionId,
      publishedVersionId: second.versionId,
      currentVersionNumber: 2,
    })
    expect(tables.documentAccessGrants[0]).toMatchObject({
      outcome: 'DOCUMENT_VERSION_RESTORED',
    })
  })

  // El CLI formatea la nota, pero la mutation es la frontera: el mismo tope y
  // el mismo mensaje que el panel y el sello, antes de escribir una sola fila.
  it('acota la nota a 500 caracteres antes de escribir', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    await expect(
      runHandler(publishDeliverable, ctx, publishArgs({ note: 'x'.repeat(501) }))
    ).rejects.toThrow('La nota de la entrega va entre 1 y 500 caracteres.')
    expect(tables.documents).toEqual([])
    expect(tables.documentVersions).toEqual([])
    expect(tables.notifications ?? []).toEqual([])
  })

  it('rechaza una llave de carpeta que no es de la sala', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    await expect(
      runHandler(publishDeliverable, ctx, publishArgs({ folder: 'modelo-financiero' }))
    ).rejects.toThrow(/carpeta/i)
    expect(tables.documents).toEqual([])
  })

  it('un documento de otra empresa se rechaza como MISMATCH', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs())
    const documentId = tables.documents[0]._id

    const probe = await runHandler<Record<string, unknown>, { status: string }>(
      inspectDeliverableTarget,
      ctx,
      { companyId: OTHER_COMPANY, documentId, name: 'Modelo financiero', sha256: SHA_B }
    )

    expect(probe.status).toBe('MISMATCH')
    await expect(
      runHandler(publishDeliverable, ctx, publishArgs({ companyId: OTHER_COMPANY, documentId }))
    ).rejects.toThrow(/no pertenece/i)
  })
})

// ============================================================================
// `--slot`: el push mueve el rail del cliente, no solo los bytes
// ============================================================================
// Sin esto el rail miente: el documento aparece en la sala y la fila de
// `deliverables` se queda donde estaba hasta que alguien la mueva a mano.

describe('operatorDeliverables.publishDeliverable --slot', () => {
  it('sin --slot no crea ni toca ninguna fila de deliverables', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    await runHandler(publishDeliverable, ctx, publishArgs())

    expect(tables.deliverables ?? []).toEqual([])
  })

  it('crea el slot que falta, lo entrega y le cuelga la rendition en custodia', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<
      Record<string, unknown>,
      { slot: { kind: string; from: string; to: string } | null }
    >(publishDeliverable, ctx, publishArgs({ slot: 'MODEL', label: 'v1' }))

    expect(result.slot).toMatchObject({ kind: 'MODEL', from: 'REQUESTED', to: 'DELIVERED' })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({
      companyId: COMPANY,
      kind: 'MODEL',
      status: 'DELIVERED',
      producedBy: 'TEAM',
      renditions: [{ format: 'XLSX', documentId: tables.documents[0]._id }],
    })
    expect(tables.deliverables[0].deliveredAt).toEqual(expect.any(Number))
    expect(tables.adminAuditLogs.map((row) => row.action)).toEqual([
      'DOCUMENT_UPLOAD',
      'DELIVERABLE_TRANSITION',
    ])
  })

  it('repetir el mismo sha no avanza dos veces ni duplica la auditoría', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    await runHandler(publishDeliverable, ctx, publishArgs({ slot: 'MODEL' }))
    const advancedAt = tables.deliverables[0].updatedAt
    const second = await runHandler<Record<string, unknown>, { kind: string; slot: unknown }>(
      publishDeliverable,
      ctx,
      publishArgs({ slot: 'MODEL' })
    )

    expect(second.kind).toBe('ALREADY_CURRENT')
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({ status: 'DELIVERED', updatedAt: advancedAt })
    expect(tables.adminAuditLogs).toHaveLength(2)
  })

  it('un slot ya entregado reabre el ciclo y vuelve a entregarse con la v2', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs({ slot: 'MODEL', label: 'v1' }))
    tables._storage.push({ _id: 'blob_b', contentType: XLSX_MIME, size: 4096, sha256: SHA_B })

    const second = await runHandler<
      Record<string, unknown>,
      { versionNumber: number; slot: { from: string; to: string } | null }
    >(publishDeliverable, ctx, publishArgs({ slot: 'MODEL', storageId: 'blob_b', label: 'v2' }))

    expect(second.versionNumber).toBe(2)
    expect(second.slot).toMatchObject({ from: 'DELIVERED', to: 'DELIVERED' })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0].renditions).toEqual([
      { format: 'XLSX', documentId: tables.documents[0]._id },
    ])
  })

  it('una versión nueva con --slot de otro kind no le gana un segundo slot al documento', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs({ slot: 'MODEL', label: 'v1' }))
    tables._storage.push({ _id: 'blob_b', contentType: XLSX_MIME, size: 4096, sha256: SHA_B })

    // Es el mismo corte que `markDocumentAsDelivery` aplica desde el panel: el
    // xlsx que ya salió como MODEL no deja el TEASER en «Entregado» con una v2.
    // El corte corre en el tramo compartido, después de escribir la versión:
    // en Convex el throw descarta la mutation entera y solo el blob subido
    // queda huérfano en Storage. El harness no revierte, así que acá se mira
    // el rail y la campanita, que son lo que el cliente ve.
    await expect(
      runHandler(publishDeliverable, ctx, publishArgs({ slot: 'TEASER', storageId: 'blob_b' }))
    ).rejects.toThrow(/ya se entregó como MODEL/)

    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({ kind: 'MODEL', status: 'DELIVERED' })
    expect(tables.notifications).toHaveLength(1)
    expect(
      tables.adminAuditLogs.filter((row) => row.action === 'DELIVERABLE_TRANSITION')
    ).toHaveLength(1)
  })

  it('parte del status vigente del slot en vez de reiniciarlo', async () => {
    const tables = baseTables({
      deliverables: [
        {
          _id: 'deliverable_model',
          companyId: COMPANY,
          kind: 'MODEL',
          status: 'IN_REVIEW',
          updatedAt: 1,
        },
      ],
    })
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<
      Record<string, unknown>,
      { slot: { from: string; to: string } | null }
    >(publishDeliverable, ctx, publishArgs({ slot: 'MODEL' }))

    expect(result.slot).toMatchObject({ from: 'IN_REVIEW', to: 'DELIVERED' })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({ _id: 'deliverable_model', status: 'DELIVERED' })
  })

  it('el slot de una empresa no se mueve con el push de otra', async () => {
    const tables = baseTables({
      deliverables: [
        {
          _id: 'deliverable_otro',
          companyId: OTHER_COMPANY,
          kind: 'MODEL',
          status: 'IN_REVIEW',
          updatedAt: 1,
        },
      ],
    })
    const ctx = ctxWithStorage(tables)

    await runHandler(publishDeliverable, ctx, publishArgs({ slot: 'MODEL' }))

    expect(tables.deliverables).toHaveLength(2)
    expect(tables.deliverables[0]).toMatchObject({ status: 'IN_REVIEW' })
  })

  it('un formato sin rendition no puede marcar el slot como entregado', async () => {
    const tables = baseTables()
    tables._storage.push({
      _id: 'blob_doc',
      contentType: 'application/msword',
      size: 1024,
      sha256: SHA_B,
    })
    const ctx = ctxWithStorage(tables)

    await expect(
      runHandler(publishDeliverable, ctx, publishArgs({ slot: 'CIM', storageId: 'blob_doc' }))
    ).rejects.toThrow(/rendition/i)
    expect(tables.documents).toEqual([])
    expect(tables.deliverables ?? []).toEqual([])
  })

  it('un entregable en cuarentena publica nada y deja el slot quieto', async () => {
    const tables = baseTables()
    tables._storage.push({
      _id: 'blob_raro',
      contentType: 'application/zip',
      size: 1024,
      sha256: SHA_B,
    })
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<
      Record<string, unknown>,
      { signatureVerified: boolean; slot: unknown }
    >(publishDeliverable, ctx, publishArgs({ slot: 'MODEL', storageId: 'blob_raro' }))

    expect(result.signatureVerified).toBe(false)
    expect(result.slot).toBeNull()
    expect(tables.deliverables ?? []).toEqual([])
  })
})

// ============================================================================
// REGRESIONES DEL DIGEST Y DE LA PROCEDENCIA
// ============================================================================
// Convex Storage entrega el sha en base64 aunque su doc diga base16, y solo
// algunas rutas de escritura lo normalizan antes de guardarlo: la columna mezcla
// las dos formas. Estas pruebas fijan las dos consecuencias que rompían el ciclo.

describe('operatorDeliverables digest y procedencia', () => {
  const SHA_HEX = '10149b2bef54e295e188646ee7dd5f18a22314' + '4da80943b98cefd8152de230ea'
  // Los MISMOS bytes que SHA_HEX, en la forma que Convex Storage devuelve.
  const SHA_BASE64 = Buffer.from(SHA_HEX, 'hex').toString('base64')

  function tablesWithCurrentSha(storedSha: string): Tables {
    return baseTables({
      documents: [
        {
          _id: 'doc_modelo',
          companyId: COMPANY,
          name: 'Modelo financiero',
          folder: 'room_financial',
          lifecycleStatus: 'ACTIVE',
          currentVersionId: 'ver_modelo',
          currentVersionNumber: 1,
          storageId: 'blob_a',
        },
      ],
      documentVersions: [
        {
          _id: 'ver_modelo',
          documentId: 'doc_modelo',
          companyId: COMPANY,
          versionNumber: 1,
          storageId: 'blob_a',
          byteSize: 2048,
          sha256: storedSha,
          detectedMimeType: XLSX_MIME,
          publicationStatus: 'PUBLISHED',
        },
      ],
    })
  }

  it('reconoce como vigente un sha guardado en base64 contra el hex del CLI', async () => {
    const ctx = ctxWithStorage(tablesWithCurrentSha(SHA_BASE64))

    const probe = await runHandler<Record<string, unknown>, { status: string }>(
      inspectDeliverableTarget,
      ctx,
      { companyId: COMPANY, name: 'Modelo financiero', sha256: SHA_HEX }
    )

    expect(probe.status).toBe('ALREADY_CURRENT')
  })

  it('devuelve el sha normalizado a hex, que es lo que el pull compara', async () => {
    const ctx = ctxWithStorage(tablesWithCurrentSha(SHA_BASE64))

    const result = await runHandler<
      { companyId: string },
      { documents: Array<{ sha256: string }> }
    >(listCompanyDocuments, ctx, { companyId: COMPANY })

    expect(result.documents[0].sha256).toBe(SHA_HEX)
  })

  // `normalizeSha256Hex` devuelve null cuando no puede probar ninguna forma. Dos
  // nulls comparados con === se leían como «ya publicado» y el entregable se
  // perdía en silencio, que es peor que un error ruidoso.
  it('no declara vigente un par de digests que no puede probar', async () => {
    const ctx = ctxWithStorage(tablesWithCurrentSha('no-es-un-sha'))

    const probe = await runHandler<Record<string, unknown>, { status: string }>(
      inspectDeliverableTarget,
      ctx,
      { companyId: COMPANY, name: 'Modelo financiero', sha256: 'tampoco-es-un-sha' }
    )

    expect(probe.status).not.toBe('ALREADY_CURRENT')
  })

  it('rehusa publicar en un deployment sin perfil ADMIN', async () => {
    const tables = baseTables({
      profiles: [{ _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY' }],
    })
    const ctx = ctxWithStorage(tables)

    await expect(runHandler(publishDeliverable, ctx, publishArgs())).rejects.toThrow(/ADMIN/i)
    expect(tables.documents).toHaveLength(0)
  })

  it('resuelve el nombre exacto sin exigir may\u00fasculas id\u00e9nticas', async () => {
    const ctx = ctxWithStorage(baseTables())

    const result = await runHandler<{ query: string }, { matches: Array<{ companyId: string }> }>(
      resolveCompany,
      ctx,
      { query: '  sample hydro, s.a.  ' }
    )

    expect(result.matches.map((match) => match.companyId)).toEqual([COMPANY])
  })
})

// ============================================================================
// LA ENTREGA VIGENTE NO SE DESARMA POR UN PUSH QUE NO SE PUDO VERIFICAR
// ============================================================================
// Una mutation ve los METADATOS del blob, no sus bytes: la "firma" es el
// content-type que el storage registró. Un `.xlsx` sin extensión, o un blob sin
// content-type, cae a UNKNOWN. Eso NO puede costarle al cliente la versión que
// ya estaba publicada: la versión nueva entra en cuarentena y el documento se
// queda exactamente donde estaba.

describe('operatorDeliverables firma no verificada', () => {
  function tablesWithPublishedV1(): Tables {
    return baseTables({
      documents: [
        {
          _id: 'doc_modelo',
          companyId: COMPANY,
          name: 'Modelo financiero',
          folder: 'room_financial',
          lifecycleStatus: 'ACTIVE',
          currentVersionId: 'ver_v1',
          publishedVersionId: 'ver_v1',
          currentVersionNumber: 1,
          storageId: 'blob_a',
          fileType: XLSX_MIME,
          fileSize: 2048,
        },
      ],
      documentVersions: [
        {
          _id: 'ver_v1',
          documentId: 'doc_modelo',
          companyId: COMPANY,
          versionNumber: 1,
          storageId: 'blob_a',
          byteSize: 2048,
          sha256: SHA_A,
          detectedMimeType: XLSX_MIME,
          publicationStatus: 'PUBLISHED',
          verificationStatus: 'SIGNATURE_VERIFIED',
        },
      ],
      // Sin `contentType`: es lo que deja una subida de un `.xlsx` sin extensión.
      _storage: [
        { _id: 'blob_a', contentType: XLSX_MIME, size: 2048, sha256: SHA_A },
        { _id: 'blob_ciego', size: 4096, sha256: SHA_B },
      ],
    })
  }

  it('el documento conserva ACTIVE, publishedVersionId y currentVersionId', async () => {
    const tables = tablesWithPublishedV1()
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<
      Record<string, unknown>,
      { kind: string; versionId: string; signatureVerified: boolean }
    >(publishDeliverable, ctx, publishArgs({ storageId: 'blob_ciego', label: 'v2' }))

    expect(result.signatureVerified).toBe(false)
    expect(tables.documents[0]).toMatchObject({
      lifecycleStatus: 'ACTIVE',
      publishedVersionId: 'ver_v1',
      currentVersionId: 'ver_v1',
      currentVersionNumber: 1,
      storageId: 'blob_a',
      fileSize: 2048,
    })
    // La v1 sigue publicada: nadie la reemplazó.
    expect(tables.documentVersions.find((row) => row._id === 'ver_v1')).toMatchObject({
      publicationStatus: 'PUBLISHED',
    })
    // Y la versión nueva queda en cuarentena, como borrador.
    const quarantined = tables.documentVersions.find((row) => row._id === result.versionId)
    expect(quarantined).toMatchObject({
      verificationStatus: 'QUARANTINED',
      publicationStatus: 'DRAFT',
    })
    expect(quarantined?.publishedAt).toBeUndefined()
  })

  it('no revoca los grants vigentes: los bytes que sirve la sala no cambiaron', async () => {
    const tables = tablesWithPublishedV1()
    tables.documentAccessGrants.push({
      _id: 'grant_vigente',
      documentId: 'doc_modelo',
      companyId: COMPANY,
      expiresAt: Date.now() + 60_000,
    })
    const ctx = ctxWithStorage(tables)

    await runHandler(publishDeliverable, ctx, publishArgs({ storageId: 'blob_ciego' }))

    expect(tables.documentAccessGrants[0].outcome).toBeUndefined()
  })

  it('un documento nuevo sin firma verificada sí entra en cuarentena', async () => {
    const tables = baseTables({
      _storage: [{ _id: 'blob_ciego', size: 4096, sha256: SHA_B }],
    })
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, { signatureVerified: boolean }>(
      publishDeliverable,
      ctx,
      publishArgs({ storageId: 'blob_ciego' })
    )

    expect(result.signatureVerified).toBe(false)
    expect(tables.documents[0]).toMatchObject({ lifecycleStatus: 'QUARANTINED' })
    expect(tables.documents[0].publishedVersionId).toBeUndefined()
  })

  // Dos pushes sin firma verificada seguidos: `keepsLiveDocument` no sube
  // `currentVersionNumber`, así que derivar el número del puntero le daba `2` a
  // los dos y dejaba dos filas homónimas en `by_document_version`.
  it('dos versiones en cuarentena seguidas no reusan el mismo número', async () => {
    const tables = tablesWithPublishedV1()
    tables._storage.push({ _id: 'blob_ciego_2', size: 8192, sha256: 'd'.repeat(64) })
    const ctx = ctxWithStorage(tables)

    const first = await runHandler<Record<string, unknown>, { versionNumber: number }>(
      publishDeliverable,
      ctx,
      publishArgs({ storageId: 'blob_ciego' })
    )
    const second = await runHandler<Record<string, unknown>, { versionNumber: number }>(
      publishDeliverable,
      ctx,
      publishArgs({ storageId: 'blob_ciego_2' })
    )

    expect(first.versionNumber).toBe(2)
    expect(second.versionNumber).toBe(3)
    const numbers = tables.documentVersions
      .filter((row) => row.documentId === 'doc_modelo')
      .map((row) => row.versionNumber)
    expect(new Set(numbers).size).toBe(numbers.length)
    // Y el documento sigue sirviendo la v1: nada de esto la desarmo.
    expect(tables.documents[0]).toMatchObject({
      currentVersionId: 'ver_v1',
      currentVersionNumber: 1,
    })
  })

  it('una firma verificada sigue publicando y superseding como antes', async () => {
    const tables = tablesWithPublishedV1()
    tables._storage.push({ _id: 'blob_b', contentType: XLSX_MIME, size: 4096, sha256: SHA_B })
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<
      Record<string, unknown>,
      { versionId: string; signatureVerified: boolean }
    >(publishDeliverable, ctx, publishArgs({ storageId: 'blob_b' }))

    expect(result.signatureVerified).toBe(true)
    expect(tables.documents[0]).toMatchObject({
      currentVersionId: result.versionId,
      publishedVersionId: result.versionId,
      currentVersionNumber: 2,
    })
    expect(tables.documentVersions.find((row) => row._id === 'ver_v1')).toMatchObject({
      publicationStatus: 'SUPERSEDED',
    })
  })
})

// ============================================================================
// `--folder` NO MUEVE UN DOCUMENTO QUE YA EXISTE
// ============================================================================
// Reubicar en `NEW_VERSION` movía el documento de sala sin evidencia: el
// cliente lo perdía de vista donde lo dejó. La carpeta de un documento vivo
// solo cambia por su propia ruta de movimiento, con su auditoría.

describe('operatorDeliverables carpeta en NEW_VERSION', () => {
  it('ignora --folder cuando difiere y lo dice en la respuesta', async () => {
    const tables = baseTables({
      documents: [
        {
          _id: 'doc_modelo',
          companyId: COMPANY,
          name: 'Modelo financiero',
          folder: 'room_financial',
          lifecycleStatus: 'ACTIVE',
          currentVersionId: 'ver_v1',
          publishedVersionId: 'ver_v1',
          currentVersionNumber: 1,
          storageId: 'blob_previo',
        },
      ],
      documentVersions: [
        {
          _id: 'ver_v1',
          documentId: 'doc_modelo',
          companyId: COMPANY,
          versionNumber: 1,
          storageId: 'blob_previo',
          byteSize: 10,
          sha256: SHA_B,
          detectedMimeType: XLSX_MIME,
          publicationStatus: 'PUBLISHED',
        },
      ],
    })
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<
      Record<string, unknown>,
      { folder: string; folderIgnored: boolean }
    >(publishDeliverable, ctx, publishArgs({ folder: 'room_legal' }))

    expect(result.folderIgnored).toBe(true)
    expect(result.folder).toBe('room_financial')
    expect(tables.documents[0].folder).toBe('room_financial')
  })

  it('un documento nuevo sí aterriza en la carpeta pedida', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)

    const result = await runHandler<
      Record<string, unknown>,
      { folder: string; folderIgnored: boolean }
    >(publishDeliverable, ctx, publishArgs({ folder: 'room_legal' }))

    expect(result.folderIgnored).toBe(false)
    expect(result.folder).toBe('room_legal')
    expect(tables.documents[0].folder).toBe('room_legal')
  })
})

// ============================================================================
// EL MISMO SHA CON `--slot` SÍ MUEVE EL RAIL
// ============================================================================
// Un push que salió sin `--slot` dejaba el archivo en la sala y el slot quieto,
// y repetirlo con `--slot` era ALREADY_CURRENT: cero bytes, cero movimiento.
// `sealCurrentVersion` es el reintento que repara esa entrega sin subir nada.

describe('operatorDeliverables.sealCurrentVersion', () => {
  function sealArgs(documentId: string, overrides: Record<string, unknown> = {}) {
    return {
      companyId: COMPANY,
      documentId,
      slot: 'MODEL',
      note: 'Modelo v1 listo para revisión.',
      ...overrides,
    }
  }

  it('avanza el slot sobre la versión vigente, sella la nota y avisa una vez', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    const published = await runHandler<Record<string, unknown>, { versionId: string }>(
      publishDeliverable,
      ctx,
      publishArgs()
    )
    const documentId = tables.documents[0]._id
    expect(tables.deliverables ?? []).toEqual([])

    const result = await runHandler<
      Record<string, unknown>,
      { delivered: boolean; from: string; status: string; noteApplied: boolean }
    >(sealCurrentVersion, ctx, sealArgs(documentId))

    expect(result).toMatchObject({
      delivered: true,
      from: 'REQUESTED',
      status: 'DELIVERED',
      noteApplied: true,
    })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({
      companyId: COMPANY,
      kind: 'MODEL',
      status: 'DELIVERED',
      producedBy: 'TEAM',
      renditions: [{ format: 'XLSX', documentId }],
    })
    // Sin subir bytes: la misma versión, ahora sellada con la nota.
    expect(tables.documentVersions).toHaveLength(1)
    expect(tables.documentVersions[0]).toMatchObject({
      _id: published.versionId,
      deliveryNote: 'Modelo v1 listo para revisión.',
    })
    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0]).toMatchObject({ entityId: published.versionId })
    expect(tables.adminAuditLogs.map((row) => row.action)).toEqual([
      'DOCUMENT_UPLOAD',
      'DELIVERABLE_TRANSITION',
    ])
  })

  it('la segunda llamada idéntica no mueve, no avisa y no audita otra vez', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs())
    const documentId = tables.documents[0]._id
    await runHandler(sealCurrentVersion, ctx, sealArgs(documentId))
    const advancedAt = tables.deliverables[0].updatedAt

    const second = await runHandler<
      Record<string, unknown>,
      { delivered: boolean; status: string }
    >(
      sealCurrentVersion,
      ctx,
      sealArgs(documentId, { note: 'Otra nota que no debe pisar la primera.' })
    )

    expect(second).toMatchObject({ delivered: false, status: 'DELIVERED' })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({ status: 'DELIVERED', updatedAt: advancedAt })
    expect(tables.documentVersions[0].deliveryNote).toBe('Modelo v1 listo para revisión.')
    expect(tables.notifications).toHaveLength(1)
    expect(tables.adminAuditLogs).toHaveLength(2)
  })

  it('conserva la nota que la versión ya traía del push y lo dice', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs({ note: 'Nota del push.' }))
    const documentId = tables.documents[0]._id

    const result = await runHandler<
      Record<string, unknown>,
      { delivered: boolean; noteApplied: boolean }
    >(sealCurrentVersion, ctx, sealArgs(documentId, { note: 'Nota del reintento.' }))

    expect(result).toMatchObject({ delivered: true, noteApplied: false })
    expect(tables.documentVersions[0].deliveryNote).toBe('Nota del push.')
    expect(tables.deliverables[0]).toMatchObject({ status: 'DELIVERED' })
    // La campanita ya sonó con el push: `entityId` es la versión y no se repite.
    expect(tables.notifications).toHaveLength(1)
  })

  it('rehúsa sellar como otro kind un documento que ya se entregó', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs({ slot: 'MODEL', note: 'Modelo v1.' }))
    const documentId = tables.documents[0]._id

    // `vdr:push modelo.xlsx --slot MODEL` y después los mismos bytes con
    // `--slot TEASER`: el sondeo contesta ALREADY_CURRENT y el sello es lo
    // único que corre. Sin el corte por documento, el TEASER quedaba
    // «Entregado» con el archivo del modelo y la campanita — deduplicada por
    // versión — no volvía a sonar.
    await expect(
      runHandler(
        sealCurrentVersion,
        ctx,
        sealArgs(documentId, { slot: 'TEASER', note: 'Teaser listo para revisión.' })
      )
    ).rejects.toThrow(/ya se entregó como MODEL/)

    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({
      kind: 'MODEL',
      status: 'DELIVERED',
      renditions: [{ format: 'XLSX', documentId }],
    })
    expect(tables.documentVersions[0].deliveryNote).toBe('Modelo v1.')
    expect(tables.notifications).toHaveLength(1)
    expect(tables.adminAuditLogs).toHaveLength(2)
  })

  it('rehúsa sellar un documento que no tiene versión publicada y verificada', async () => {
    const tables = baseTables({ _storage: [{ _id: 'blob_ciego', size: 4096, sha256: SHA_B }] })
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs({ storageId: 'blob_ciego' }))
    const documentId = tables.documents[0]._id

    await expect(runHandler(sealCurrentVersion, ctx, sealArgs(documentId))).rejects.toThrow(
      /publicada/i
    )
    expect(tables.deliverables ?? []).toEqual([])
    expect(tables.documentVersions[0].deliveryNote).toBeUndefined()
  })

  it('rehúsa un documento de otra empresa y una nota vacía sin tocar nada', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs())
    const documentId = tables.documents[0]._id

    await expect(
      runHandler(sealCurrentVersion, ctx, sealArgs(documentId, { companyId: OTHER_COMPANY }))
    ).rejects.toThrow(/no pertenece/i)
    await expect(
      runHandler(sealCurrentVersion, ctx, sealArgs(documentId, { note: '   ' }))
    ).rejects.toThrow(/nota/i)
    expect(tables.deliverables ?? []).toEqual([])
  })

  // El mismo tope que el panel («Marcar como entrega»), con el mismo mensaje:
  // la nota se acota UNA vez en `normalizeDeliveryNote`, no por carril.
  it('acota la nota a 500 caracteres con el mismo mensaje que el panel, sin tocar nada', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs())
    const documentId = tables.documents[0]._id

    await expect(
      runHandler(sealCurrentVersion, ctx, sealArgs(documentId, { note: 'x'.repeat(501) }))
    ).rejects.toThrow('La nota de la entrega va entre 1 y 500 caracteres.')
    expect(tables.deliverables ?? []).toEqual([])
    expect(tables.documentVersions[0].deliveryNote).toBeUndefined()
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  // Un push sin `--slot` y sin nota ya le avisó al cliente («El equipo publicó
  // …») y el cliente lo leyó. El sello llega después con la nota y mueve el
  // rail: la campanita no puede quedarse muda ni con el texto viejo, y tampoco
  // sonar por duplicado. Como la dedupe es por versión, la fila de esa versión
  // se refresca en sitio: mensaje con la nota y de vuelta a no leída.
  it('el sello sobre un push sin nota refresca el aviso de esa versión en vez de duplicarlo', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    const published = await runHandler<Record<string, unknown>, { versionId: string }>(
      publishDeliverable,
      ctx,
      publishArgs()
    )
    const documentId = tables.documents[0]._id
    expect(tables.notifications).toHaveLength(1)
    const notice = tables.notifications[0]
    expect(notice.message).not.toContain('Nota del equipo')
    // El cliente ya lo leyó antes de que el sello llegara.
    notice.isRead = true

    const result = await runHandler<
      Record<string, unknown>,
      { delivered: boolean; notification: string }
    >(sealCurrentVersion, ctx, sealArgs(documentId))

    expect(result).toMatchObject({ delivered: true, notification: 'refreshed' })
    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0]).toMatchObject({
      _id: notice._id,
      entityId: published.versionId,
      title: 'Nuevo en tu sala',
      message: 'El equipo publicó un documento en tu sala. Ábrelo para revisarlo.',
      isRead: false,
    })
  })

  it('el segundo sello idéntico deja el aviso refrescado tal como está', async () => {
    const tables = baseTables()
    const ctx = ctxWithStorage(tables)
    await runHandler(publishDeliverable, ctx, publishArgs())
    const documentId = tables.documents[0]._id
    await runHandler(sealCurrentVersion, ctx, sealArgs(documentId))
    const refreshed = { ...tables.notifications[0] }
    // Ya sonó una vez con la nota y el cliente lo leyó: el reintento no lo
    // vuelve a poner en no leído ni lo reescribe.
    tables.notifications[0].isRead = true

    const second = await runHandler<Record<string, unknown>, { delivered: boolean }>(
      sealCurrentVersion,
      ctx,
      sealArgs(documentId)
    )

    expect(second).toMatchObject({ delivered: false })
    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0]).toMatchObject({
      _id: refreshed._id,
      message: refreshed.message,
      isRead: true,
    })
  })
})

// ============================================================================
// LA PROCEDENCIA ES UN CAMPO, NO UNA HEURÍSTICA SOBRE EL NOMBRE
// ============================================================================
// `TEAM_DELIVERABLE` acompaña a los bytes que el equipo devolvió: lo escribe el
// push que publica y el sello sobre la versión vigente. Una versión en
// cuarentena no lo toca porque la sala sigue sirviendo los bytes anteriores.

describe('operatorDeliverables procedencia TEAM_DELIVERABLE', () => {
  function tablesWithClientUpload(): Tables {
    return baseTables({
      documents: [
        {
          _id: 'doc_modelo',
          companyId: COMPANY,
          name: 'Modelo financiero',
          folder: 'room_financial',
          lifecycleStatus: 'ACTIVE',
          currentVersionId: 'ver_v1',
          publishedVersionId: 'ver_v1',
          currentVersionNumber: 1,
          storageId: 'blob_a',
          fileType: XLSX_MIME,
          fileSize: 2048,
          sourceType: 'USER_UPLOAD',
        },
      ],
      documentVersions: [
        {
          _id: 'ver_v1',
          documentId: 'doc_modelo',
          companyId: COMPANY,
          versionNumber: 1,
          storageId: 'blob_a',
          byteSize: 2048,
          sha256: SHA_A,
          detectedMimeType: XLSX_MIME,
          publicationStatus: 'PUBLISHED',
          verificationStatus: 'SIGNATURE_VERIFIED',
          malwareScanStatus: 'NOT_CONFIGURED',
        },
      ],
      _storage: [
        { _id: 'blob_a', contentType: XLSX_MIME, size: 2048, sha256: SHA_A },
        { _id: 'blob_b', contentType: XLSX_MIME, size: 4096, sha256: SHA_B },
        { _id: 'blob_ciego', size: 4096, sha256: 'd'.repeat(64) },
      ],
    })
  }

  it('una versión nueva publicada reetiqueta el documento que subió el cliente', async () => {
    const tables = tablesWithClientUpload()
    const ctx = ctxWithStorage(tables)

    await runHandler(publishDeliverable, ctx, publishArgs({ storageId: 'blob_b' }))

    expect(tables.documents[0]).toMatchObject({
      currentVersionNumber: 2,
      sourceType: 'TEAM_DELIVERABLE',
    })
  })

  it('una versión en cuarentena deja la procedencia como estaba', async () => {
    const tables = tablesWithClientUpload()
    const ctx = ctxWithStorage(tables)

    await runHandler(publishDeliverable, ctx, publishArgs({ storageId: 'blob_ciego' }))

    expect(tables.documents[0]).toMatchObject({
      currentVersionNumber: 1,
      sourceType: 'USER_UPLOAD',
    })
  })

  it('el sello sobre la versión vigente también reetiqueta el documento', async () => {
    const tables = tablesWithClientUpload()
    const ctx = ctxWithStorage(tables)

    await runHandler(sealCurrentVersion, ctx, {
      companyId: COMPANY,
      documentId: 'doc_modelo',
      slot: 'MODEL',
      note: 'Modelo v1 listo.',
    })

    expect(tables.documents[0].sourceType).toBe('TEAM_DELIVERABLE')
    expect(tables.deliverables[0]).toMatchObject({ kind: 'MODEL', status: 'DELIVERED' })
  })
})
