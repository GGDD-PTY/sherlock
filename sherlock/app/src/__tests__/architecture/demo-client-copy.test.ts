import { describe, expect, it } from 'vitest'

import messages from '@/messages/es.json'

describe('client copy for the complete Data Room journey', () => {
  it('describes an unavailable verification without naming internal infrastructure', () => {
    expect(messages.intakeWorkspace.notConfigured).toBe('Verificación no disponible')
    expect(messages.intakeWorkspace.clean).toBe('Verificado')
    expect(messages.intakeWorkspace.uninspected).toBe('Pendiente de verificación')
  })

  it('explains retained documents and names the existing deletion action after access ends', () => {
    expect(messages.intakeWorkspace.ended).toBe(
      'El acceso temporal terminó. Tus documentos siguen guardados. Puedes eliminarlos con el botón Eliminar mis datos temporales.'
    )
    expect(messages.intakeWorkspace.ended).toContain(messages.intakeWorkspace.deleteData)
    expect(messages.intakeWorkspace.deleteData).toBe('Eliminar mis datos temporales')
  })

  it('explains the invitation scope without exposing token handling', () => {
    expect(messages.vdrGuest.invitationIds).toBe(
      'Tu invitación te permite acceder solo a los documentos que el equipo te haya compartido.'
    )
  })

  it('names the deliverables in the landing metadata', () => {
    expect(messages.mycroft.meta.title).toBe('Modelo financiero, teaser, CIM y presentaciones')
  })

  it('keeps the activation date placeholder with a sentence separator', () => {
    expect(messages.roomProgress.activated).toBe('Data Room activado. {date}')
  })
})
