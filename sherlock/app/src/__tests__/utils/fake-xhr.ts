// ============================================================================
// XMLHttpRequest FALSO PARA LOS TESTS DEL INTAKE
// ============================================================================
// `uploadIntakeFile` manda los bytes por XHR (la única vía con progreso por
// bytes en todos los navegadores). jsdom trae un XHR real que intentaría la
// red; este doble deja que el test conduzca cada request: `progress`, `respond`
// y `fail` disparan los handlers que el uploader colgó, y `abort()` se
// comporta como el del navegador (dispara `onabort` una sola vez).
// ============================================================================

import { vi } from 'vitest'

type ProgressHandler = (event: { loaded: number; total: number; lengthComputable: boolean }) => void

export class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = []
  /** Guion por request: se llama en `send` con la instancia para conducirla. */
  static onSend: ((xhr: FakeXMLHttpRequest) => void) | null = null

  static reset(): void {
    FakeXMLHttpRequest.instances = []
    FakeXMLHttpRequest.onSend = null
  }

  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  status = 0
  responseText = ''
  responseType = ''
  withCredentials = false
  sent = false
  aborted = false
  settled = false
  upload: { onprogress: ProgressHandler | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXMLHttpRequest.instances.push(this)
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }

  send(body: unknown): void {
    this.sent = true
    this.body = body
    FakeXMLHttpRequest.onSend?.(this)
  }

  abort(): void {
    if (this.settled) return
    this.settled = true
    this.aborted = true
    this.onabort?.()
  }

  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true })
  }

  respond(status: number, body: unknown): void {
    if (this.settled) return
    this.settled = true
    this.status = status
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body)
    this.onload?.()
  }

  fail(): void {
    if (this.settled) return
    this.settled = true
    this.onerror?.()
  }
}

/** Instala el doble como `XMLHttpRequest` global; `vi.unstubAllGlobals()` lo quita. */
export function installFakeXhr(): typeof FakeXMLHttpRequest {
  FakeXMLHttpRequest.reset()
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
  return FakeXMLHttpRequest
}

/** Cada POST de bytes responde de inmediato con un `storageId` correlativo. */
export function respondStorageImmediately(prefix = 'storage'): void {
  FakeXMLHttpRequest.onSend = (xhr) => {
    const index = FakeXMLHttpRequest.instances.indexOf(xhr) + 1
    xhr.respond(200, { storageId: `${prefix}_${index}` })
  }
}
