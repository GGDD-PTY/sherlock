// ============================================================================
// useDirectVdrUpload — SUBIDA DIRECTA NAVEGADOR → CONVEX STORAGE
// ============================================================================
// Sin directiva de frontera cliente: los hooks internos heredan la frontera
// de su consumidor (convención de src/hooks y del ratchet
// maxClientEntryPoints en rendering-policy.ts); todos los consumidores ya
// son componentes cliente.
// Adapter fino de React sobre performDirectVdrUpload (el núcleo puro vive en
// src/lib/documents/direct-upload.ts). Emite un intent sellado antes de obtener
// la URL y luego entrega a la action solo intentId+storageId. La action lee la
// firma real y consume el intent al registrar una versión inmutable. El
// mutation legacy queda fail-closed en cuarentena.
// El archivo hace POST directo a *.convex.cloud y NUNCA pasa por una ruta
// Next en Vercel — por eso el techo es MAX_DIRECT_UPLOAD_BYTES (50MB) y no el
// 413 de ~4.5MB de la plataforma.
//
// ===== LA COSTURA CON EFFECT =====
// La subida son tres llamadas a Convex encadenadas: emitir el intent, subir los
// bytes, registrar la versión. Si la del medio falla hay que abandonar el
// intent. Ese encadenado ya existía, pero cada paso era una función anónima
// async sin nombre, así que una subida que se cae a la mitad no dejaba rastro
// de en qué paso se cayó.
//
// Ahora cada paso es un `Effect.fn` con nombre de span. En una traza la subida
// se lee como `VdrUpload.issueIntent`, `VdrUpload.abandonIntent` y
// `VdrUpload.register`. El contrato con `performDirectVdrUpload` no cambia: los
// tres callbacks siguen devolviendo promesas, y la conversión ocurre en el
// borde de cada uno.
//
// Los tres programas viven fuera del componente y reciben sus dependencias por
// argumento. Definidos adentro serían una función nueva por render, y el
// compilador de React rechaza un `useCallback` cuyo primer argumento no es una
// función escrita ahí mismo, porque no puede ver de qué depende.
// ============================================================================

import { useCallback } from 'react'
import { useAction, useMutation } from 'convex/react'
import { Effect } from 'effect'

import { runClientEffect } from '@/lib/effect/client-runtime'

import { api } from '@/../convex/_generated/api'
import { adminVdrTarget } from '@/../convex/_adminVdr/capabilityFormat'
import type { Id } from '@/../convex/_generated/dataModel'
import { useAdminVdrCapability } from '@/components/company/vdr/AdminVdrCapabilityContext'
import {
  performDirectVdrUpload,
  type DirectVdrUploadInput,
  type DirectVdrUploadResult,
} from '@/lib/documents/direct-upload'

export type { DirectVdrUploadInput, DirectVdrUploadResult }

type UploadPorts = Parameters<typeof performDirectVdrUpload>[0]
type IssueArgs = Parameters<UploadPorts['issueUploadIntent']>[0]
type IssueDeps = {
  authorizeAdminVdr: ReturnType<typeof useAdminVdrCapability>
  issueDirectUploadIntent: ReturnType<
    typeof useMutation<typeof api.documents.issueDirectUploadIntent>
  >
}

// El intent se sella antes de pedir la URL de subida. El destino de la
// capacidad admin depende de qué se está reemplazando: un documento o la
// empresa entera.
const issueIntent = Effect.fn('VdrUpload.issueIntent')(function* (
  deps: IssueDeps,
  args: IssueArgs
) {
  const mutationInput = {
    companyId: args.companyId as Id<'companies'>,
    ...(args.replaceDocumentId
      ? { replaceDocumentId: args.replaceDocumentId as Id<'documents'> }
      : {}),
    fileName: args.fileName,
    declaredMimeType: args.declaredMimeType,
    declaredByteSize: args.declaredByteSize,
    declaredSha256: args.declaredSha256,
    name: args.name,
    accessLevel: args.accessLevel,
    classification: args.classification,
    folder: args.folder,
  }

  const target = args.replaceDocumentId
    ? adminVdrTarget('DOCUMENT', args.replaceDocumentId)
    : adminVdrTarget('COMPANY', args.companyId)

  const authorized = yield* Effect.promise(() =>
    deps.authorizeAdminVdr('DOCUMENT_UPLOAD_INTENT', target, mutationInput)
  )

  return yield* Effect.promise(() => deps.issueDirectUploadIntent(authorized))
})

const abandonIntent = Effect.fn('VdrUpload.abandonIntent')(function* (
  abandon: ReturnType<typeof useMutation<typeof api.documents.abandonDirectUploadIntent>>,
  args: { intentId: string }
) {
  return yield* Effect.promise(() => abandon({ intentId: args.intentId as Id<'vdrUploadIntents'> }))
})

const registerUpload = Effect.fn('VdrUpload.register')(function* (
  register: ReturnType<typeof useAction<typeof api.documents.inspectAndRegisterDirectUpload>>,
  args: { intentId: string; storageId: string }
) {
  return yield* Effect.promise(() =>
    register({
      intentId: args.intentId as Id<'vdrUploadIntents'>,
      storageId: args.storageId as Id<'_storage'>,
    })
  )
})

export function useDirectVdrUpload(): (
  input: DirectVdrUploadInput
) => Promise<DirectVdrUploadResult> {
  const issueDirectUploadIntent = useMutation(api.documents.issueDirectUploadIntent)
  const abandonDirectUploadIntent = useMutation(api.documents.abandonDirectUploadIntent)
  const inspectAndRegisterDirectUpload = useAction(api.documents.inspectAndRegisterDirectUpload)
  const authorizeAdminVdr = useAdminVdrCapability()

  return useCallback(
    (input: DirectVdrUploadInput) =>
      performDirectVdrUpload(
        {
          issueUploadIntent: (args) =>
            runClientEffect(issueIntent({ authorizeAdminVdr, issueDirectUploadIntent }, args)),
          abandonUploadIntent: (args) =>
            runClientEffect(abandonIntent(abandonDirectUploadIntent, args)),
          registerDirectUpload: (args) =>
            runClientEffect(registerUpload(inspectAndRegisterDirectUpload, args)),
        },
        input
      ),
    [
      abandonDirectUploadIntent,
      authorizeAdminVdr,
      inspectAndRegisterDirectUpload,
      issueDirectUploadIntent,
    ]
  )
}
