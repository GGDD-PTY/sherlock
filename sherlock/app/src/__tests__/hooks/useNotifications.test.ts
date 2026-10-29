// ============================================================================
// TESTS: useNotifications Hook
// ============================================================================
// Tests for the notifications hook that manages real-time notifications
// via Convex queries/mutations.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ===== HOISTED MOCKS (available before vi.mock factories) =====
const {
  mockUseCurrentUser,
  mockUseQuery,
  mockMarkAsReadMutation,
  mockMarkAllAsReadMutation,
  mockUpdatePreferencesMutation,
  mockToastSuccess,
  mockToastError,
  mockToastFn,
  mockLocale,
  mockSafeRedirect,
} = vi.hoisted(() => ({
  mockUseCurrentUser: vi.fn(),
  mockUseQuery: vi.fn(),
  mockMarkAsReadMutation: vi.fn(),
  mockMarkAllAsReadMutation: vi.fn(),
  mockUpdatePreferencesMutation: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastFn: vi.fn(),
  mockLocale: vi.fn(() => 'es'),
  mockSafeRedirect: vi.fn(),
}))

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>()
  const es = await import('@/messages/es.json')

  return {
    ...actual,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: mockLocale(),
        messages: es.default,
        namespace: namespace as never,
      }),
  }
})

vi.mock('@/lib/utils/safe-redirect', () => ({ safeRedirect: mockSafeRedirect }))

// ===== MOCK useCurrentUser =====
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mockUseCurrentUser(),
}))

// ===== MOCK CONVEX =====
vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (name: string) => {
    if (name === 'notifications:markAsRead') return mockMarkAsReadMutation
    if (name === 'notifications:markAllAsRead') return mockMarkAllAsReadMutation
    if (name === 'notifications:updatePreferences') return mockUpdatePreferencesMutation
    return vi.fn()
  },
}))

// ===== MOCK CONVEX API =====
vi.mock('../../../convex/_generated/api', () => ({
  api: {
    notifications: {
      getNotifications: 'notifications:getNotifications',
      getUnreadCount: 'notifications:getUnreadCount',
      getPreferences: 'notifications:getPreferences',
      markAsRead: 'notifications:markAsRead',
      markAllAsRead: 'notifications:markAllAsRead',
      updatePreferences: 'notifications:updatePreferences',
    },
  },
}))

// ===== MOCK sonner =====
vi.mock('sonner', () => {
  const toastObj = Object.assign(mockToastFn, {
    success: mockToastSuccess,
    error: mockToastError,
  })
  return { toast: toastObj }
})

// ===== MOCK dev-auth =====
vi.mock('@/lib/dev-auth', () => ({
  DEV_AUTH_ENABLED: false,
  useDevAuth: vi.fn(),
}))

import { useNotifications } from '@/hooks/useNotifications'

// ============================================================================
// HELPERS
// ============================================================================

function mockProfile(id = 'profile_123') {
  return {
    _id: id,
    userId: 'user_456',
    isVerified: true,
  }
}

function mockConvexNotification(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'notif_1',
    _creationTime: Date.now(),
    userId: 'user_456',
    type: 'new_message',
    title: 'New Message',
    message: 'You have a new message',
    link: '/messages',
    isRead: false,
    actorId: 'actor_1',
    entityType: 'message',
    entityId: 'msg_1',
    ...overrides,
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('useNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: signed-in user with profile and a Convex session already applied
    mockUseCurrentUser.mockReturnValue({
      profile: mockProfile(),
      isLoading: false,
      isConvexSessionReady: true,
    })

    // Default: no notifications
    mockUseQuery.mockReturnValue(undefined)
    mockMarkAsReadMutation.mockResolvedValue(undefined)
    mockMarkAllAsReadMutation.mockResolvedValue(3)
    mockUpdatePreferencesMutation.mockResolvedValue(undefined)
    mockLocale.mockReturnValue('es')
  })

  // ==========================================================================
  // INITIAL STATE
  // ==========================================================================

  describe('initial state', () => {
    it('returns loading state when user is loading', () => {
      mockUseCurrentUser.mockReturnValue({
        profile: null,
        isLoading: true,
      })

      const { result } = renderHook(() => useNotifications())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns loading state when notifications not yet loaded', () => {
      mockUseQuery.mockReturnValue(undefined)

      const { result } = renderHook(() => useNotifications())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns empty notifications array by default', () => {
      mockUseQuery.mockImplementation((queryName: string) => {
        if (queryName === 'notifications:getNotifications') return []
        if (queryName === 'notifications:getUnreadCount') return 0
        if (queryName === 'notifications:getPreferences') return null
        return undefined
      })

      const { result } = renderHook(() => useNotifications())

      expect(result.current.notifications).toEqual([])
      expect(result.current.unreadCount).toBe(0)
    })

    it('does not expose a dummy error field', () => {
      const { result } = renderHook(() => useNotifications())

      expect(result.current).not.toHaveProperty('error')
    })
  })

  // ==========================================================================
  // NOTIFICATIONS DATA
  // ==========================================================================

  describe('notifications data', () => {
    it('transforms Convex notifications to legacy format', () => {
      const notif = mockConvexNotification()
      mockUseQuery.mockImplementation((queryName: string) => {
        if (queryName === 'notifications:getNotifications') return [notif]
        if (queryName === 'notifications:getUnreadCount') return 1
        if (queryName === 'notifications:getPreferences') return null
        return undefined
      })

      const { result } = renderHook(() => useNotifications())

      expect(result.current.notifications).toHaveLength(1)
      expect(result.current.notifications[0]).toEqual({
        id: 'notif_1',
        user_id: 'user_456',
        type: 'new_message',
        title: 'New Message',
        message: 'You have a new message',
        link: '/messages',
        is_read: false,
        created_at: expect.any(String),
        metadata: {
          actorId: 'actor_1',
          entityType: 'message',
          entityId: 'msg_1',
        },
      })
    })

    it('handles multiple notifications', () => {
      const notifs = [
        mockConvexNotification({ _id: 'notif_1', type: 'new_message' }),
        mockConvexNotification({ _id: 'notif_2', type: 'deal_update', isRead: true }),
        mockConvexNotification({ _id: 'notif_3', type: 'connection_request' }),
      ]

      mockUseQuery.mockImplementation((queryName: string) => {
        if (queryName === 'notifications:getNotifications') return notifs
        if (queryName === 'notifications:getUnreadCount') return 2
        if (queryName === 'notifications:getPreferences') return null
        return undefined
      })

      const { result } = renderHook(() => useNotifications())

      expect(result.current.notifications).toHaveLength(3)
      expect(result.current.unreadCount).toBe(2)
    })

    it('handles isRead being null (defaults to false)', () => {
      const notif = mockConvexNotification({ isRead: null })
      mockUseQuery.mockImplementation((queryName: string) => {
        if (queryName === 'notifications:getNotifications') return [notif]
        return undefined
      })

      const { result } = renderHook(() => useNotifications())

      expect(result.current.notifications[0].is_read).toBe(false)
    })
  })

  // ==========================================================================
  // PREFERENCES
  // ==========================================================================

  describe('preferences', () => {
    it('uses default preferences when none loaded', () => {
      mockUseQuery.mockImplementation((queryName: string) => {
        if (queryName === 'notifications:getPreferences') return null
        return undefined
      })

      const { result } = renderHook(() => useNotifications())

      expect(result.current.preferences).toEqual({
        emailNewConnection: true,
        emailNewMessage: true,
        emailRoomUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      })
    })

    it('uses Convex preferences when available', () => {
      const customPrefs = {
        emailNewConnection: false,
        emailNewMessage: true,
        emailRoomUpdates: false,
        emailWeeklyDigest: false,
        emailAnalysisComplete: true,
        pushEnabled: false,
      }

      mockUseQuery.mockImplementation((queryName: string) => {
        if (queryName === 'notifications:getPreferences') return customPrefs
        return undefined
      })

      const { result } = renderHook(() => useNotifications())

      expect(result.current.preferences).toEqual(customPrefs)
    })
  })

  // ==========================================================================
  // MARK AS READ
  // ==========================================================================

  describe('markAsRead', () => {
    it('calls markAsRead mutation with notification ID', async () => {
      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAsRead('notif_123' as never)
      })

      expect(mockMarkAsReadMutation).toHaveBeenCalledWith({ notificationId: 'notif_123' })
    })

    it('handles markAsRead mutation error gracefully', async () => {
      mockMarkAsReadMutation.mockRejectedValueOnce(new Error('DB error'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAsRead('notif_bad' as never)
      })

      expect(consoleSpy).toHaveBeenCalledWith(
        '[useNotifications] Error marking as read:',
        expect.objectContaining({ _tag: 'NotificationActionError' })
      )
      expect(mockToastError).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    // El fallo era mudo: el programa devolvía `ok: false` y el handler lo
    // descartaba, así que el aviso se quedaba sin marcar sin decir nada.
    it('avisa al cliente cuando marcar una notificación falla', async () => {
      mockMarkAsReadMutation.mockRejectedValueOnce(new Error('DB error'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAsRead('notif_bad' as never)
      })

      expect(mockToastError).toHaveBeenCalledWith(
        'No pudimos marcar la notificación. Inténtalo de nuevo.'
      )
      consoleSpy.mockRestore()
    })

    it('no avisa de error cuando el marcado sí entra', async () => {
      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAsRead('notif_ok' as never)
      })

      expect(mockToastError).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // MARK ALL AS READ
  // ==========================================================================

  describe('markAllAsRead', () => {
    it('calls markAllAsRead mutation', async () => {
      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAllAsRead()
      })

      expect(mockMarkAllAsReadMutation).toHaveBeenCalledWith({})
    })

    it('shows success toast after marking all as read', async () => {
      mockMarkAllAsReadMutation.mockResolvedValueOnce(5)

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAllAsRead()
      })

      expect(mockToastSuccess).toHaveBeenCalledWith('5 notificaciones marcadas como le\u00EDdas')
    })

    // El caso hermano corría la misma confirmación en inglés. Retirado el
    // locale, lo que se pinnea es que el plural ICU resuelve en singular sin
    // caer a la cadena inglesa.
    it('resolves the mark-all confirmation plural without an English fallback', async () => {
      mockMarkAllAsReadMutation.mockResolvedValueOnce(1)
      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAllAsRead()
      })

      expect(mockToastSuccess).toHaveBeenCalledWith('1 notificación marcada como leída')
    })

    it('does nothing when no profile exists', async () => {
      mockUseCurrentUser.mockReturnValue({
        profile: null,
        isLoading: false,
      })

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAllAsRead()
      })

      expect(mockMarkAllAsReadMutation).not.toHaveBeenCalled()
    })

    it('handles markAllAsRead mutation error gracefully', async () => {
      mockMarkAllAsReadMutation.mockRejectedValueOnce(new Error('DB error'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAllAsRead()
      })

      expect(consoleSpy).toHaveBeenCalledWith(
        '[useNotifications] Error marking all as read:',
        expect.any(Error)
      )
      consoleSpy.mockRestore()
    })
  })

  // ==========================================================================
  // UPDATE PREFERENCES
  // ==========================================================================

  describe('updatePreferences', () => {
    it('calls updatePreferences mutation with profile ID and partial prefs', async () => {
      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.updatePreferences({ pushEnabled: false })
      })

      expect(mockUpdatePreferencesMutation).toHaveBeenCalledWith({
        userId: 'profile_123',
        pushEnabled: false,
      })
    })

    it('shows success toast on preference update', async () => {
      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.updatePreferences({ emailNewMessage: false })
      })

      expect(mockToastSuccess).toHaveBeenCalledWith('Preferencias actualizadas')
    })

    it('reports the preference failure from the same catalog as the success', async () => {
      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.updatePreferences({ emailNewMessage: false })
      })

      expect(mockToastSuccess).toHaveBeenCalledWith('Preferencias actualizadas')

      mockUpdatePreferencesMutation.mockRejectedValueOnce(new Error('DB error'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await act(async () => {
        await result.current.updatePreferences({ pushEnabled: false })
      })
      expect(mockToastError).toHaveBeenCalledWith('No pudimos actualizar las preferencias')
      consoleSpy.mockRestore()
    })

    it('does nothing when no profile exists', async () => {
      mockUseCurrentUser.mockReturnValue({
        profile: null,
        isLoading: false,
      })

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.updatePreferences({ pushEnabled: false })
      })

      expect(mockUpdatePreferencesMutation).not.toHaveBeenCalled()
    })

    it('shows error toast on preference update failure', async () => {
      mockUpdatePreferencesMutation.mockRejectedValueOnce(new Error('DB error'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.updatePreferences({ pushEnabled: false })
      })

      expect(mockToastError).toHaveBeenCalledWith('No pudimos actualizar las preferencias')
      consoleSpy.mockRestore()
    })
  })

  // ==========================================================================
  // EL CANAL DE ERROR TIPADO
  // ==========================================================================
  // Las tres acciones comparten un solo programa Effect. Lo que se registra ya
  // no es un `unknown` atrapado: es el error etiquetado, con la acción que lo
  // produjo y el rechazo original intacto en `cause`.

  describe('tagged action failures', () => {
    it('etiqueta el fallo de cada acción y conserva el rechazo original', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const rechazoRead = new Error('DB error read')
      const rechazoAll = new Error('DB error all')
      const rechazoPrefs = new Error('DB error prefs')
      mockMarkAsReadMutation.mockRejectedValueOnce(rechazoRead)
      mockMarkAllAsReadMutation.mockRejectedValueOnce(rechazoAll)
      mockUpdatePreferencesMutation.mockRejectedValueOnce(rechazoPrefs)

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAsRead('notif_1' as never)
        await result.current.markAllAsRead()
        await result.current.updatePreferences({ pushEnabled: false })
      })

      expect(consoleSpy).toHaveBeenCalledWith(
        '[useNotifications] Error marking as read:',
        expect.objectContaining({
          _tag: 'NotificationActionError',
          action: 'markAsRead',
          cause: rechazoRead,
        })
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        '[useNotifications] Error marking all as read:',
        expect.objectContaining({
          _tag: 'NotificationActionError',
          action: 'markAllAsRead',
          cause: rechazoAll,
        })
      )
      expect(consoleSpy).toHaveBeenCalledWith(
        '[useNotifications] Error updating preferences:',
        expect.objectContaining({
          _tag: 'NotificationActionError',
          action: 'updatePreferences',
          cause: rechazoPrefs,
        })
      )

      consoleSpy.mockRestore()
    })

    it('no canta éxito cuando markAllAsRead falla', async () => {
      mockMarkAllAsReadMutation.mockRejectedValueOnce(new Error('DB error'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.markAllAsRead()
      })

      expect(mockToastSuccess).not.toHaveBeenCalled()
      expect(mockToastError).toHaveBeenCalledWith(
        'No pudimos marcar la notificación. Inténtalo de nuevo.'
      )
      consoleSpy.mockRestore()
    })

    it('no canta éxito ni error a la vez cuando updatePreferences falla', async () => {
      mockUpdatePreferencesMutation.mockRejectedValueOnce(new Error('DB error'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => useNotifications())

      await act(async () => {
        await result.current.updatePreferences({ pushEnabled: false })
      })

      expect(mockToastSuccess).not.toHaveBeenCalled()
      expect(mockToastError).toHaveBeenCalledWith('No pudimos actualizar las preferencias')
      consoleSpy.mockRestore()
    })
  })

  // ==========================================================================
  // REFRESH
  // ==========================================================================

  describe('refresh', () => {
    it('is a no-op function (Convex auto-updates)', async () => {
      const { result } = renderHook(() => useNotifications())

      // Should not throw
      await act(async () => {
        await result.current.refresh()
      })
    })
  })

  // ==========================================================================
  // TOAST DE NOTIFICACIONES NUEVAS
  // ==========================================================================

  describe('new-notification toast', () => {
    function setQueries(unreadCount: number | undefined, notifs: unknown[] | undefined) {
      mockUseQuery.mockImplementation((queryName: string) => {
        if (queryName === 'notifications:getNotifications') return notifs
        if (queryName === 'notifications:getUnreadCount') return unreadCount
        if (queryName === 'notifications:getPreferences') return null
        return undefined
      })
    }

    it('does not toast when unread notifications arrive on the initial load', () => {
      // Fase de carga: las queries aún no resolvieron.
      setQueries(undefined, undefined)

      const { rerender } = renderHook(() => useNotifications())

      // Llegan 3 no leídas de antes — NO es una notificación nueva.
      setQueries(3, [
        mockConvexNotification({ _id: 'notif_old_1' }),
        mockConvexNotification({ _id: 'notif_old_2' }),
        mockConvexNotification({ _id: 'notif_old_3' }),
      ])
      rerender()

      expect(mockToastFn).not.toHaveBeenCalled()
    })

    it('toasts when a genuinely new notification raises the unread count', () => {
      setQueries(undefined, undefined)

      const { rerender } = renderHook(() => useNotifications())

      setQueries(1, [mockConvexNotification({ _id: 'notif_1', title: 'Vieja' })])
      rerender()

      expect(mockToastFn).not.toHaveBeenCalled()

      setQueries(2, [
        mockConvexNotification({ _id: 'notif_2', title: 'Nueva conexión' }),
        mockConvexNotification({ _id: 'notif_1', title: 'Vieja' }),
      ])
      rerender()

      expect(mockToastFn).toHaveBeenCalledTimes(1)
      expect(mockToastFn).toHaveBeenCalledWith(
        'Nueva conexión',
        expect.objectContaining({ description: 'You have a new message' })
      )
    })

    it('labels the toast action from the catalog and keeps redirects on the safe boundary', () => {
      setQueries(1, [mockConvexNotification({ _id: 'notif_1' })])
      const { rerender } = renderHook(() => useNotifications())

      setQueries(2, [
        mockConvexNotification({ _id: 'notif_2', link: '/messages' }),
        mockConvexNotification({ _id: 'notif_1' }),
      ])
      rerender()

      const toastOptions = mockToastFn.mock.calls[0]?.[1] as {
        action?: { label: string; onClick: () => void }
      }
      expect(toastOptions.action?.label).toBe('Ver')
      toastOptions.action?.onClick()
      expect(mockSafeRedirect).toHaveBeenCalledWith('/messages', '/notifications')
    })

    it('does not toast when the unread count stays flat across rerenders', () => {
      setQueries(2, [
        mockConvexNotification({ _id: 'notif_1' }),
        mockConvexNotification({ _id: 'notif_2' }),
      ])

      const { rerender } = renderHook(() => useNotifications())
      rerender()
      rerender()

      expect(mockToastFn).not.toHaveBeenCalled()
    })

    it('does not toast when the count drops (notifications marked as read)', () => {
      setQueries(undefined, undefined)

      const { rerender } = renderHook(() => useNotifications())

      setQueries(2, [
        mockConvexNotification({ _id: 'notif_1' }),
        mockConvexNotification({ _id: 'notif_2' }),
      ])
      rerender()

      setQueries(0, [])
      rerender()

      expect(mockToastFn).not.toHaveBeenCalled()
    })

    it('does not toast from a count-only instance sitting next to the bell', () => {
      setQueries(undefined, undefined)

      const { rerender } = renderHook(() => ({
        bell: useNotifications(),
        row: useNotifications({ emitToasts: false }),
      }))

      setQueries(1, [mockConvexNotification({ _id: 'notif_1', title: 'Vieja' })])
      rerender()
      expect(mockToastFn).not.toHaveBeenCalled()

      setQueries(2, [
        mockConvexNotification({ _id: 'notif_2', title: 'Nueva conexión' }),
        mockConvexNotification({ _id: 'notif_1', title: 'Vieja' }),
      ])
      rerender()

      expect(mockToastFn).toHaveBeenCalledTimes(1)
    })
  })

  // ==========================================================================
  // SKIPPING QUERIES WHEN NO PROFILE
  // ==========================================================================

  describe('query skipping', () => {
    it('skips Convex queries when no profile ID', () => {
      mockUseCurrentUser.mockReturnValue({
        profile: null,
        isLoading: false,
      })

      renderHook(() => useNotifications())

      // All queries should be called with 'skip'
      const queryCalls = mockUseQuery.mock.calls
      queryCalls.forEach((call: unknown[]) => {
        expect(call[1]).toBe('skip')
      })
    })
  })
})
