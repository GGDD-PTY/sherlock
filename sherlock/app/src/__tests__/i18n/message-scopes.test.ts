import { describe, expect, it } from 'vitest'

import {
  PUBLIC_MESSAGE_NAMESPACES,
  ROOT_MESSAGE_NAMESPACES,
  pickMessages,
} from '@/i18n/message-scopes'
import esMessages from '@/messages/es.json'

describe('message scopes of the two shells', () => {
  it('keeps the public catalog to the namespaces those pages actually read', () => {
    expect(ROOT_MESSAGE_NAMESPACES).toEqual(['common', 'errors'])
    expect(PUBLIC_MESSAGE_NAMESPACES).toEqual(['common', 'errors', 'mycroft', 'roadmap'])
  })

  it('drops namespaces that the public shell does not mount', () => {
    const picked = pickMessages(esMessages, PUBLIC_MESSAGE_NAMESPACES)

    expect(picked).toEqual({
      common: esMessages.common,
      errors: esMessages.errors,
      mycroft: esMessages.mycroft,
      roadmap: esMessages.roadmap,
    })
    expect(picked).not.toHaveProperty('admin')
    expect(picked).not.toHaveProperty('vdr')
    expect(picked).not.toHaveProperty('landing')
  })

  it('omits a namespace that is not in the catalog instead of sending undefined', () => {
    const picked = pickMessages({ common: { ok: true } }, ['common', 'missing'])

    expect(picked).toEqual({ common: { ok: true } })
    expect(picked).not.toHaveProperty('missing')
  })
})
