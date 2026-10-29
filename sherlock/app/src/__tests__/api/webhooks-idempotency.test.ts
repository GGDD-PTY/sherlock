// ============================================================================
// Webhook idempotency helpers
// ============================================================================
// Un evento que quedó en 'failed' NO es un duplicado terminal: el proveedor
// va a reintentarlo y ese reintento debe volver a procesarse, o el fallo
// transitorio se convierte en pérdida permanente.
// ============================================================================

import { describe, it, expect } from 'vitest'
import {
  isReplayableWebhookRegistration,
  shouldProcessWebhookEvent,
  type WebhookRegistration,
} from '@/app/api/webhooks/_shared/idempotency'

function registration(overrides: Partial<WebhookRegistration> = {}): WebhookRegistration {
  return {
    isNew: false,
    eventId: 'webhook_event_123',
    status: 'completed',
    message: 'Evento ya procesado',
    ...overrides,
  }
}

describe('shouldProcessWebhookEvent()', () => {
  it('procesa eventos nuevos', () => {
    expect(shouldProcessWebhookEvent(registration({ isNew: true, status: 'processing' }))).toBe(
      true
    )
  })

  it('reprocesa un evento existente que quedó en failed', () => {
    expect(shouldProcessWebhookEvent(registration({ status: 'failed' }))).toBe(true)
  })

  it('reprocesa un evento registrado que nunca fue tomado (received)', () => {
    expect(shouldProcessWebhookEvent(registration({ status: 'received' }))).toBe(true)
  })

  it('descarta duplicados completados', () => {
    expect(shouldProcessWebhookEvent(registration({ status: 'completed' }))).toBe(false)
  })

  it('descarta duplicados ignorados (skipped)', () => {
    expect(shouldProcessWebhookEvent(registration({ status: 'skipped' }))).toBe(false)
  })

  it('no reprocesa un evento en vuelo (processing) para evitar doble aplicación', () => {
    expect(shouldProcessWebhookEvent(registration({ status: 'processing' }))).toBe(false)
  })

  it('descarta estados desconocidos por defecto (fail-closed)', () => {
    expect(shouldProcessWebhookEvent(registration({ status: 'weird_new_status' }))).toBe(false)
  })
})

describe('isReplayableWebhookRegistration()', () => {
  it('es false para eventos nuevos (no son reintentos)', () => {
    expect(isReplayableWebhookRegistration(registration({ isNew: true, status: 'failed' }))).toBe(
      false
    )
  })

  it('es true solo para reintentos de eventos sin efecto aplicado', () => {
    expect(isReplayableWebhookRegistration(registration({ status: 'failed' }))).toBe(true)
    expect(isReplayableWebhookRegistration(registration({ status: 'received' }))).toBe(true)
    expect(isReplayableWebhookRegistration(registration({ status: 'completed' }))).toBe(false)
  })
})
