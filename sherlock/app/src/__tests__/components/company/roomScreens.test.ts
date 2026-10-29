import { describe, expect, it } from 'vitest'

import { roomScreenFromPathname, roomScreensFor } from '@/components/company/roomScreens'

describe('roomScreenFromPathname', () => {
  it('decodes the screen with or without the locale prefix', () => {
    expect(roomScreenFromPathname('/es/my-company/company')).toBe('company')
    expect(roomScreenFromPathname('/my-company/team?x=1')).toBe('team')
  })

  it('returns null for retired or nested paths', () => {
    expect(roomScreenFromPathname('/es/my-company/profile')).toBeNull()
    expect(roomScreenFromPathname('/es/my-company/documents/activity')).toBe('documents')
    expect(roomScreenFromPathname('/es/admin/companies')).toBeNull()
  })
})

describe('roomScreensFor', () => {
  it('gives the owner every screen, guests only with an NDA', () => {
    expect(
      roomScreensFor({ accessMode: 'MANAGE', adminOperator: false, guestsAvailable: true })
    ).toEqual(['documents', 'company', 'preparation', 'team', 'guests'])
    expect(
      roomScreensFor({ accessMode: 'MANAGE', adminOperator: false, guestsAvailable: false })
    ).toEqual(['documents', 'company', 'preparation', 'team'])
  })

  it('keeps a read-only member on the documents screen', () => {
    expect(
      roomScreensFor({ accessMode: 'READ_ONLY', adminOperator: false, guestsAvailable: true })
    ).toEqual(['documents'])
  })

  it('hides the client-only screens from the team', () => {
    expect(
      roomScreensFor({ accessMode: 'MANAGE', adminOperator: true, guestsAvailable: false })
    ).toEqual(['documents', 'preparation'])
  })
})
