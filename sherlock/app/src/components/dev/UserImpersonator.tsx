'use client'

// ============================================================================
// USER IMPERSONATOR COMPONENT
// ============================================================================
// Allows ADMIN users to search and select a specific user to impersonate.
// This enables viewing the app exactly as that user would see it.
//
// Features:
// - Search users by name or email
// - Shows user role, verification status
// - Sets impersonation cookie for SSR compatibility
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Effect, Exit } from 'effect'
import type { Fiber } from 'effect'
import { useMutation } from 'convex/react'
import { api } from '@/../convex/_generated/api'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import type { Id } from '@/../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { runClientEffect, runClientFork } from '@/lib/effect/client-runtime'
import { UserCog, Search, Building2, Shield, CheckCircle, X } from 'lucide-react'

// ============================================================================
// CONSTANTS
// ============================================================================

const roleColors = {
  ADMIN: 'bg-accent/10 text-accent',
  COMPANY: 'bg-info/10 text-info',
}

const roleIcons = {
  ADMIN: Shield,
  COMPANY: Building2,
}

const fallbackRoleColor = 'bg-muted text-muted-foreground'

// ===== LA COSTURA CON EFFECT =====
// Las dos lecturas de esta herramienta terminan igual cuando fallan: sin
// candidatos y sin usuario. Eso no cambia —es lo correcto para tooling de
// desarrollo— pero deja de escribirse como un `catch` vacío por llamada.
//
// La carga del usuario impersonado corre además en una fibra: cambiar de
// usuario o cerrar el diálogo interrumpe la anterior, así que una respuesta
// tardía ya no pisa a la nueva.
const listCandidates = Effect.fn('DevImpersonation.listCandidates')(function* <A>(
  load: () => Promise<readonly A[]>
): Effect.fn.Return<readonly A[]> {
  return yield* Effect.tryPromise({ try: load, catch: (cause) => cause }).pipe(
    Effect.orElseSucceed((): readonly A[] => [])
  )
})

const loadImpersonatedUser = Effect.fn('DevImpersonation.loadUser')(function* <A>(
  load: () => Promise<A | null>
): Effect.fn.Return<A | null> {
  return yield* Effect.tryPromise({ try: load, catch: (cause) => cause }).pipe(
    Effect.orElseSucceed((): A | null => null)
  )
})

// ============================================================================
// TYPES
// ============================================================================

type ImpersonatedUser = {
  id: Id<'profiles'>
  fullName: string
  email: string
  role: 'COMPANY' | 'ADMIN'
  avatarUrl?: string
  isVerified: boolean
  companyName?: string
}

interface UserForImpersonation {
  id: Id<'profiles'>
  fullName: string
  email: string
  role: 'COMPANY' | 'ADMIN'
  avatarUrl?: string
  isVerified: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export function UserImpersonator() {
  // Defensa en profundidad: la impersonación de usuarios concretos es tooling
  // solo-dev — jamás se monta en producción (NODE_ENV se inlinea en build).
  if (process.env.NODE_ENV === 'production') {
    return null
  }

  return <UserImpersonatorInner />
}

function UserImpersonatorInner() {
  const router = useRouter()
  const { isAdmin, isImpersonating, impersonateUserId, setImpersonateUser, clearImpersonate } =
    useCurrentUser()

  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [users, setUsers] = useState<UserForImpersonation[] | undefined>(undefined)
  const [impersonatedUser, setImpersonatedUser] = useState<ImpersonatedUser | null>(null)

  const listUsersMutation = useMutation(api.admin.listUsersForImpersonation)
  const getUserMutation = useMutation(api.admin.getUserForImpersonation)

  // Debounce timer ref para la búsqueda
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Buscar usuarios cuando cambia el search o se abre el diálogo
  const fetchUsers = useCallback(
    async (searchTerm: string) => {
      if (!isAdmin) return
      const result = await runClientEffect(
        listCandidates(() => listUsersMutation({ search: searchTerm || undefined, limit: 20 }))
      )
      setUsers([...result])
    },
    [isAdmin, listUsersMutation]
  )

  useEffect(() => {
    if (!isOpen || !isAdmin) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void fetchUsers(search)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search, isOpen, isAdmin, fetchUsers])

  // Cargar datos del usuario impersonado
  const userFiberRef = useRef<Fiber.Fiber<ImpersonatedUser | null> | null>(null)

  useEffect(() => {
    userFiberRef.current?.interruptUnsafe()
    userFiberRef.current = null
    if (!isAdmin || !impersonateUserId) {
      // Use a microtask to avoid synchronous setState in effect
      queueMicrotask(() => setImpersonatedUser(null))
      return
    }
    const fiber = runClientFork(
      loadImpersonatedUser(() => getUserMutation({ userId: impersonateUserId }))
    )
    userFiberRef.current = fiber
    fiber.addObserver((exit) => {
      if (userFiberRef.current === fiber) userFiberRef.current = null
      // Interrumpida por otro usuario o por el desmontaje: no pinta nada.
      if (Exit.isSuccess(exit)) setImpersonatedUser(exit.value)
    })
  }, [isAdmin, impersonateUserId, getUserMutation])

  // Don't render if not admin
  if (!isAdmin) {
    return null
  }

  const handleSelectUser = (user: UserForImpersonation) => {
    if (user.role !== 'COMPANY') {
      // Can't impersonate other admins
      return
    }
    setImpersonateUser(user.id, user.role)
    setIsOpen(false)
    router.refresh()
  }

  const handleStopImpersonating = () => {
    clearImpersonate()
    router.refresh()
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        User Impersonation
      </p>

      {isImpersonating && impersonatedUser ? (
        // Currently impersonating - show user info
        <div className="border-warning/30 bg-warning/10 flex items-center gap-2 rounded-md border p-2">
          <Avatar className="h-8 w-8">
            <AvatarImage src={impersonatedUser.avatarUrl} />
            <AvatarFallback className="text-xs">
              {impersonatedUser.fullName?.slice(0, 2).toUpperCase() || '??'}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{impersonatedUser.fullName}</p>
            <p className="text-muted-foreground truncate text-xs">{impersonatedUser.email}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={handleStopImpersonating}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        // Not impersonating - show search button
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="w-full">
              <UserCog className="mr-2 h-3 w-3" />
              Impersonate User
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserCog className="h-5 w-5" />
                Impersonate User
              </DialogTitle>
              <DialogDescription>
                Search for a user to view the app as they would see it. You cannot impersonate other
                admins.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Search input */}
              <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
                <Input
                  placeholder="Search by name or email..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>

              {/* User list */}
              <div className="max-h-[300px] overflow-y-auto rounded-md border">
                {users === undefined ? (
                  // Loading
                  <div className="space-y-3 p-4">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="flex items-center gap-3">
                        <Skeleton className="h-10 w-10 rounded-full" />
                        <div className="flex-1 space-y-1">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-3 w-48" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : users.length === 0 ? (
                  // No results
                  <div className="text-muted-foreground p-8 text-center">
                    <Search className="mx-auto mb-2 h-8 w-8 opacity-50" />
                    <p className="text-sm">No users found</p>
                  </div>
                ) : (
                  // User list
                  <div className="divide-y">
                    {users.map((user) => {
                      const RoleIcon =
                        user.role === 'ADMIN' || user.role === 'COMPANY'
                          ? roleIcons[user.role]
                          : Building2
                      const isDisabled = user.role !== 'COMPANY'

                      return (
                        <button
                          key={user.id}
                          onClick={() => handleSelectUser(user)}
                          disabled={isDisabled}
                          className={`hover:bg-muted/50 flex w-full items-center gap-3 p-3 text-left transition-colors ${isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} `}
                        >
                          <Avatar className="h-10 w-10">
                            <AvatarImage src={user.avatarUrl} />
                            <AvatarFallback>
                              {user.fullName?.slice(0, 2).toUpperCase() || '??'}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate font-medium">{user.fullName}</p>
                              {user.isVerified && (
                                <CheckCircle className="text-success h-3 w-3 shrink-0" />
                              )}
                            </div>
                            <p className="text-muted-foreground truncate text-xs">{user.email}</p>
                          </div>
                          <Badge
                            className={
                              user.role === 'ADMIN' || user.role === 'COMPANY'
                                ? roleColors[user.role]
                                : fallbackRoleColor
                            }
                          >
                            <RoleIcon className="mr-1 h-3 w-3" />
                            {user.role}
                          </Badge>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Warning */}
              <div className="text-muted-foreground bg-muted/50 rounded-md p-3 text-xs">
                <strong>Note:</strong> Impersonation only affects reads. Any mutations will still be
                performed as your admin account.
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
