'use client'

// Lockup oficial del kit (SVG), nunca el wordmark tipeado (BRAND.md §6).

import { useState, useEffect, forwardRef, type ComponentProps } from 'react'
import dynamic from 'next/dynamic'
import { Schema } from 'effect'
import { runSignOut } from '@/components/layout/run-sign-out'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { homePathForRole } from '@/lib/navigation/home'
import {
  PRIMARY_NAV_ITEMS,
  getAccountRoom,
  getVisibleNavbarSecondaryItems,
} from '@/lib/navigation/registry'
import type { AppShell } from '@/lib/product/types'
import { Menu, LogOut, Bell, CircleHelp } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useAuth } from '@/hooks/useAuth'
import { useNotifications } from '@/hooks/useNotifications'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth'
import { NavbarUserSkeleton } from '@/components/ui/premium-skeleton'
import { Skeleton } from '@/components/ui/skeleton'
import { SherlockLockup } from '@/components/shared/SherlockLockup'
import { SITE_BRAND_NAME } from '@/lib/site/brand'
import { ViewAsSelector } from '@/components/admin/ViewAsSelector'
import { NavbarUtilityMenu } from '@/components/layout/NavbarUtilityMenu'
import { SignInLink } from '@/components/layout/SignInLink'
import { runClientEffect } from '@/lib/effect/client-runtime'

export function NotificationBellFallback() {
  const t = useTranslations('common.navbar')
  return (
    <Button variant="ghost" size="icon" className="h-9 w-9" disabled aria-busy="true">
      <Bell className="text-muted-foreground h-4 w-4" />
      <span className="sr-only">{t('aria.notifications')}</span>
    </Button>
  )
}

const NotificationBell = dynamic(
  () => import('@/components/notifications/NotificationBell').then((m) => m.NotificationBell),
  {
    ssr: false,
    loading: () => <NotificationBellFallback />,
  }
)

// El product navbar solo pinta destinos de ADMIN y COMPANY. Un rol fuera de esos
// dormante: un rol que no es de esos dos cae a PUBLIC, igual que un visitante.
const ProductNavbarShellSchema = Schema.Literals(['ADMIN', 'COMPANY'])
const isProductNavbarShell = Schema.is(ProductNavbarShellSchema)

// `/sign-in` lo pinta `PublicNavbar`, que también la oculta. Se queda en la
// lista por si esta barra se montara sobre esa ruta (tarjeta O2-06).
const AuthNavbarSkipPrefixSchema = Schema.Literals(['/sign-in', '/sign-up', '/dev-login'])

const LandingNavHrefSchema = Schema.Literals(['/ayuda'])
type LandingNavHref = typeof LandingNavHrefSchema.Type

// `window.scrollY` es entrada del DOM. El umbral de 20px era un `>` suelto;
// `isGreaterThan(20)` es el mismo corte (21 en adelante) con nombre.
const NavbarScrolledYSchema = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(20)))
const isNavbarScrolled = Schema.is(NavbarScrolledYSchema)

// Las dos rutas con sesión que igual llevan la barra del landing: una sola
// fila, los enlaces al centro y la cuenta a la derecha. La segunda fila de
// destinos que pintaba la barra de producto para visitantes duplicaba esos
// mismos enlaces (la sección «Screens and canvas» del contrato de diseño).
//
// El sitio público —landing, ayuda, legales, sign-in, 404— ya no pasa por acá:
// su barra es `PublicNavbar`, que no consulta sesión (tarjeta O2-06).
const PublicShellPathSchema = Schema.Literals(['/intake', '/vdr-guest'])
const isPublicShellPath = (pathname: string) =>
  PublicShellPathSchema.literals.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )

// Next prefetchea cada Link que entra al viewport. Una URL de /admin hace que
// el proxy corra getCurrentUserState antes del render, una vez por destino. El
// clic sigue pasando por ese gate; solo se apaga el prefetch.
function adminPathSkipsPrefetch(href: ComponentProps<typeof Link>['href']): boolean {
  const path = typeof href === 'string' ? href : href.pathname
  return path === '/admin' || (typeof path === 'string' && path.startsWith('/admin/'))
}

const NavbarLink = forwardRef<HTMLAnchorElement, ComponentProps<typeof Link>>(function NavbarLink(
  { href, ...props },
  ref
) {
  return (
    <Link
      ref={ref}
      href={href}
      {...props}
      {...(adminPathSkipsPrefetch(href) ? { prefetch: false } : {})}
    />
  )
})

export function Navbar() {
  const pathname = usePathname()

  if (isPublicShellPath(pathname)) {
    return <LandingNavbar />
  }

  return <ProductNavbar />
}

function LandingNavbar() {
  const router = useRouter()
  const t = useTranslations('common.navbar')
  const tButtons = useTranslations('common.buttons')
  const { hasRole, isAdmin, isLoading, isSignedIn } = useCurrentUser()
  const { isSignedIn: devSignedIn, signOut } = useAuth()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const isAuthenticated = DEV_AUTH_ENABLED ? devSignedIn : isSignedIn
  const accountRoom = getAccountRoom({ isCompany: hasRole('COMPANY'), isAdmin })
  // El rol lo trae Convex y llega después de la sesión. Hasta entonces
  // `getAccountRoom` no encuentra sala y devuelve su fallback.
  const isRoomKnown = DEV_AUTH_ENABLED || !isLoading
  const AccountRoomIcon = accountRoom.icon
  const companyHref = '/#intake'

  const handleSignOut = async () => {
    setMobileMenuOpen(false)
    await runClientEffect(runSignOut(signOut))
    if (DEV_AUTH_ENABLED) router.refresh()
  }

  // Un solo enlace de ayuda: el roadmap dejó de ser una página propia y vive
  // dentro de /ayuda ([F] 2026-09-01). Dos entradas al mismo hub era copy de más.
  const landingLinkByHref = {
    '/ayuda': { label: t('support'), icon: CircleHelp },
  } satisfies Record<LandingNavHref, { readonly label: string; readonly icon: LucideIcon }>
  const landingLinks = LandingNavHrefSchema.literals.map((href) => ({
    href,
    ...landingLinkByHref[href],
  }))

  return (
    <nav
      aria-label={t('aria.mainNavigation')}
      className="bg-background border-border sticky top-0 z-50 border-b"
    >
      <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <NavbarLink
          href={isAuthenticated ? accountRoom.href : '/'}
          aria-label={t('aria.sherlockHome')}
          className="focus-visible:ring-ring flex min-w-0 items-center gap-3 transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:outline-none"
        >
          <SherlockLockup className="text-primary dark:text-foreground h-8 sm:h-9" />
        </NavbarLink>

        {/* lg, no xl: la landing lleva pocos items y a 1240px el hamburger se
            sentía prematuro (anotación [F] 2026-08-27). */}
        <div className="hidden items-center gap-1 lg:flex" data-testid="landing-primary-navigation">
          {landingLinks.map(({ href, label, icon: Icon }) => (
            <Button key={href} variant="ghost" size="sm" asChild>
              <NavbarLink href={href}>
                {Icon ? <Icon className="h-4 w-4" /> : null}
                {label}
              </NavbarLink>
            </Button>
          ))}
        </div>

        {/* En la landing el intake ya es el único CTA lleno del primer viewport:
            el atajo del header va en outline para no competir con él. */}
        <div className="hidden shrink-0 items-center gap-1 lg:flex">
          <ThemeToggle showLabel />
          {/* La sala propia, nombrada por su destino («Data Room» o «Panel»).
              El logotipo lleva al inicio y esto lleva a donde trabaja el cliente.
              El esqueleto espera a `isLoading`, no a `isAuthLoading`: el rol lo
              trae Convex y llega después de la sesión. Con solo la sesión
              resuelta el botón salía diciendo «Cuenta» y apuntando a `/`, la
              página en la que ya estabas, y un segundo después se corregía a
              «Data Room» ([F] 2026-09-08 18:10, capturas en el hilo). Un control
              con el texto equivocado que además no lleva a ningún lado es peor
              que el esqueleto. `ProductNavbar` ya esperaba las dos respuestas. */}
          {!isRoomKnown ? (
            <Skeleton className="h-8 w-24" data-testid="navbar-skeleton" />
          ) : isAuthenticated ? (
            <Button variant="ghost" size="sm" asChild>
              <NavbarLink href={accountRoom.href}>
                <AccountRoomIcon className="mr-2 h-4 w-4" aria-hidden="true" />
                {t(accountRoom.labelKey)}
              </NavbarLink>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" asChild>
                <SignInLink>{tButtons('signIn')}</SignInLink>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <NavbarLink href={companyHref}>{t('startDataRoom')}</NavbarLink>
              </Button>
            </>
          )}
        </div>

        <div className="lg:hidden">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild aria-controls="sherlock-landing-mobile-nav">
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                aria-label={t('aria.mobileMenu')}
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent id="sherlock-landing-mobile-nav" side="right" className="w-[320px] p-0">
              <SheetHeader className="border-b">
                {/* El lockup sin `title` va `aria-hidden`, así que el diálogo se
                    quedaba sin nombre accesible. El nombre sale de `brand.ts`,
                    igual que en `SiteFooter` y en `PublicNavbar`. */}
                <SheetTitle className="flex items-center gap-2">
                  <SherlockLockup
                    title={SITE_BRAND_NAME}
                    className="text-primary dark:text-foreground h-7"
                  />
                </SheetTitle>
                <SheetDescription>{t('aria.mobileNavigation')}</SheetDescription>
              </SheetHeader>

              <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
                <div className="grid gap-1">
                  {landingLinks.map(({ href, label, icon: Icon }) => (
                    <SheetClose asChild key={href}>
                      <NavbarLink
                        href={href}
                        className="hover:bg-muted focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                      >
                        {Icon ? <Icon className="h-4 w-4" /> : null}
                        {label}
                      </NavbarLink>
                    </SheetClose>
                  ))}
                </div>

                <div className="border-border grid gap-2 border-y py-4">
                  <ThemeToggle showLabel />
                </div>

                {isAuthenticated ? (
                  <div className="grid gap-2">
                    {/* Mismo candado que la barra ancha: sin el rol de Convex
                        el enlace saldría como «Cuenta» hacia `/`. */}
                    {isRoomKnown ? (
                      <SheetClose asChild>
                        <Button variant="ghost" className="w-full justify-start" asChild>
                          <NavbarLink href={accountRoom.href}>
                            <AccountRoomIcon className="h-4 w-4" aria-hidden="true" />
                            {t(accountRoom.labelKey)}
                          </NavbarLink>
                        </Button>
                      </SheetClose>
                    ) : (
                      <Skeleton className="h-9 w-full" data-testid="navbar-skeleton-compact" />
                    )}
                    <Button
                      variant="ghost"
                      className="w-full justify-start"
                      onClick={() => void handleSignOut()}
                    >
                      <LogOut className="h-4 w-4" />
                      {tButtons('signOut')}
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <SheetClose asChild>
                      <Button variant="outline" className="min-h-11 w-full" asChild>
                        <SignInLink>{tButtons('signIn')}</SignInLink>
                      </Button>
                    </SheetClose>
                    <SheetClose asChild>
                      <Button variant="cta" className="min-h-11 w-full" asChild>
                        <NavbarLink href={companyHref}>{t('startDataRoom')}</NavbarLink>
                      </Button>
                    </SheetClose>
                  </div>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </nav>
  )
}

// El menú compacto no tenía avisos: la campana vive solo en
// `desktop-secondary-navigation`, que está oculto bajo xl, así que en teléfono
// no había forma de llegar a las notificaciones. Esta fila lleva el mismo dato
// a la sala angosta: el conteo sale de `useNotifications`, el hook que la
// campana usa, con `emitToasts: false` para no repetir el aviso. Solo monta
// cuando el Sheet está abierto, así que la query extra no corre con el menú
// cerrado.
function MobileNotificationsLink() {
  const t = useTranslations('notifications.bell')
  const { unreadCount } = useNotifications({ emitToasts: false })

  return (
    <SheetClose asChild>
      <NavbarLink
        href="/notifications"
        data-testid="compact-notifications-link"
        aria-label={unreadCount > 0 ? t('ariaLabelUnread', { count: unreadCount }) : undefined}
        className="text-muted-foreground hover:bg-muted/50 hover:text-foreground flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
      >
        <Bell className="h-4 w-4" />
        <span className="flex-1">{t('title')}</span>
        {unreadCount > 0 && (
          <Badge
            variant="destructive"
            className="min-w-5 justify-center px-1.5 text-xs"
            data-testid="compact-notifications-unread"
          >
            {/* Mismo corte que la campana (tarjeta O2-02): «99+» a partir de
                100, y la píldora crece con el número. */}
            {unreadCount > 99 ? '99+' : unreadCount}
          </Badge>
        )}
      </NavbarLink>
    </SheetClose>
  )
}

function ProductNavbar() {
  const router = useRouter()
  const pathname = usePathname()
  const t = useTranslations('common.navbar')
  const tNavDescriptions = useTranslations('common.navbarDescriptions')
  const tButtons = useTranslations('common.buttons')

  // ===== SCROLL STATE =====
  // Track si el usuario ha scrolleado para aplicar efectos
  const [scrolled, setScrolled] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // ===== CURRENT USER (para verificar rol) =====
  // Usamos hasRole (effectiveRole) para mostrar opciones de UI
  // Usamos isAdmin (realRole) para controles que solo el admin debe ver
  const { hasRole, isAdmin: isRealAdmin, isLoading, isSignedIn, effectiveRole } = useCurrentUser()
  const isAdmin = isRealAdmin // Siempre true si el rol REAL es ADMIN
  const isCompany = hasRole('COMPANY')

  // ===== DEV AUTH STATE =====
  // ES: En demo evitamos componentes de auth del proveedor.
  // EN: In demo we avoid provider auth components.
  const { isSignedIn: devSignedIn, signOut } = useAuth()
  const isDemoMode = DEV_AUTH_ENABLED

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(isNavbarScrolled(window.scrollY))
    }

    handleScroll()
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const handleSignOut = async () => {
    setMobileMenuOpen(false)
    await runClientEffect(runSignOut(signOut))
    if (isDemoMode) router.refresh()
  }

  const currentShell: AppShell = !isSignedIn
    ? 'PUBLIC'
    : isProductNavbarShell(effectiveRole)
      ? effectiveRole
      : 'PUBLIC'

  // ===== HELPER: VERIFICAR SI UNA RUTA ESTÁ ACTIVA =====
  const isActive = (href: string) => {
    return pathname.startsWith(href)
  }

  // Skip Navbar on auth pages
  if (AuthNavbarSkipPrefixSchema.literals.some((prefix) => pathname.startsWith(prefix))) {
    return null
  }

  const mobileSecondaryItems = getVisibleNavbarSecondaryItems({
    isCompany,
    isAdmin,
    placement: 'mobile',
  })
  const desktopSecondaryItems = getVisibleNavbarSecondaryItems({
    isCompany,
    isAdmin,
    placement: 'desktop',
  })
  const isAuthenticatedForNavbar = isDemoMode ? devSignedIn : isSignedIn
  // Anonymous visitors see the public primary navigation; authenticated users
  // get their workspace destinations in the secondary navigation.
  const visibleNavItems = PRIMARY_NAV_ITEMS.filter((item) => item.shells.includes(currentShell))
  // Public product navigation is for anonymous visitors only; signed-in users
  // rely on secondary workspace navigation.
  const primaryNavItems = isAuthenticatedForNavbar ? [] : visibleNavItems
  const showMobileMenu =
    visibleNavItems.length > 0 ||
    (isAuthenticatedForNavbar && mobileSecondaryItems.length > 0) ||
    !isAuthenticatedForNavbar
  const renderMobileLink = (item: (typeof mobileSecondaryItems)[number]) => {
    const Icon = item.icon
    return (
      <SheetClose asChild key={item.href}>
        <NavbarLink
          href={item.href}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
            item.highlight
              ? 'text-primary hover:bg-primary/10 font-medium'
              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
          }`}
        >
          <Icon className="h-4 w-4" />
          {t(item.labelKey)}
        </NavbarLink>
      </SheetClose>
    )
  }
  // El menú compacto refleja la barra ancha: primero los destinos (la sala,
  // Ayuda) y después «Cuenta», que agrupa configuración, tema y cerrar sesión
  // igual que el menú desplegable ([F] 2026-09-07 09:00).
  const mobileNavigationItems = mobileSecondaryItems.filter((item) => item.group !== 'account')
  const mobileAccountItems = mobileSecondaryItems.filter((item) => item.group === 'account')
  const mobileSecondaryLinks = (
    <div className="space-y-1">
      {mobileNavigationItems.map(renderMobileLink)}
      <MobileNotificationsLink />
    </div>
  )
  const mobileAccountGroup = (
    <div className="border-t pt-3" data-testid="compact-account-group">
      <p className="text-muted-foreground px-3 pb-1 text-xs font-medium">{t('account')}</p>
      <div className="space-y-1">
        {mobileAccountItems.map(renderMobileLink)}
        <div className="px-3 py-1">
          <ThemeToggle showLabel />
        </div>
        <Button
          variant="ghost"
          className="text-muted-foreground hover:text-foreground w-full justify-start gap-3 px-3"
          onClick={() => void handleSignOut()}
        >
          <LogOut className="h-4 w-4" />
          {tButtons('signOut')}
        </Button>
      </div>
    </div>
  )

  const desktopPrimaryLinks = primaryNavItems.map((item) => {
    const Icon = item.icon
    const active = isActive(item.href)

    return (
      <Button key={item.href} variant={active ? 'secondary' : 'ghost'} size="sm" asChild>
        <NavbarLink
          href={item.href}
          aria-current={active ? 'page' : undefined}
          className="flex items-center gap-2 whitespace-nowrap"
        >
          <Icon className="h-4 w-4" />
          <span>{t(item.nameKey)}</span>
        </NavbarLink>
      </Button>
    )
  })

  const desktopSecondaryLinks = (
    <div className="hidden items-center gap-1 xl:flex" data-testid="desktop-secondary-navigation">
      {desktopSecondaryItems.map((item) => {
        const Icon = item.icon
        return (
          <Button key={item.href} variant="ghost" size="sm" className="px-2" asChild>
            <NavbarLink
              href={item.href}
              className="relative flex items-center space-x-1"
              aria-label={t(item.labelKey)}
              title={t(item.labelKey)}
            >
              <Icon className="hidden h-4 w-4 2xl:block" />
              <span>{t(item.labelKey)}</span>
            </NavbarLink>
          </Button>
        )
      })}
      <NotificationBell showLabel />
    </div>
  )

  return (
    <nav
      aria-label={t('aria.mainNavigation')}
      className={`sticky top-0 z-50 border-b transition-all duration-300 ${
        scrolled ? 'border-border bg-background shadow-sm' : 'bg-background border-transparent'
      }`}
    >
      <div className="mx-auto max-w-7xl px-2 sm:px-6 lg:px-8">
        <div className="flex min-h-16 min-w-0 items-center justify-between gap-2 sm:gap-4 md:min-h-[68px]">
          {/* ===== LOGO Y BRAND ===== */}
          <div className="flex min-w-0 items-center" data-testid="navbar-brand-cluster">
            {/* ===== MOBILE MENU ===== */}
            {showMobileMenu && (
              <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
                <SheetTrigger asChild aria-controls="sherlock-mobile-nav-sheet">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mr-1 gap-2 sm:mr-2 xl:hidden"
                    aria-label={t('aria.mobileMenu')}
                  >
                    <Menu className="h-5 w-5" />
                    {/* En pantallas angostas la marca vale más que la palabra
                        "menú", que ya viaja en el `aria-label`. */}
                    <span className="hidden sm:inline">{t('aria.mobileMenu')}</span>
                  </Button>
                </SheetTrigger>
                <SheetContent
                  id="sherlock-mobile-nav-sheet"
                  side="left"
                  className="w-[320px] p-0 sm:w-[380px]"
                >
                  <SheetHeader className="border-b">
                    {/* Mismo caso que el panel del landing: sin `title` el lockup
                        va `aria-hidden` y el diálogo queda sin nombre accesible. */}
                    <SheetTitle className="flex items-center gap-2">
                      <SherlockLockup
                        title={SITE_BRAND_NAME}
                        className="text-primary dark:text-foreground h-7"
                      />
                    </SheetTitle>
                    <SheetDescription>{t('aria.mobileNavigation')}</SheetDescription>
                  </SheetHeader>

                  <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
                    {/* ===== PRIMARY NAV ===== */}
                    <div className="space-y-1">
                      {primaryNavItems.map((item) => {
                        const Icon = item.icon
                        const active = isActive(item.href)

                        return (
                          <SheetClose asChild key={item.href}>
                            <NavbarLink
                              href={item.href}
                              aria-current={active ? 'page' : undefined}
                              className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                                active
                                  ? 'border-primary/20 bg-primary/5 text-foreground'
                                  : 'hover:bg-muted/50 border-transparent'
                              }`}
                            >
                              <Icon
                                className={`mt-0.5 h-4 w-4 ${
                                  active ? 'text-primary' : 'text-muted-foreground'
                                }`}
                              />
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">{t(item.nameKey)}</span>
                                </div>
                                <span className="text-muted-foreground text-xs">
                                  {tNavDescriptions(item.descriptionKey)}
                                </span>
                              </div>
                            </NavbarLink>
                          </SheetClose>
                        )
                      })}
                    </div>

                    {isAdmin && (
                      <div className="border-y py-3">
                        <ViewAsSelector />
                      </div>
                    )}

                    {/* Anonymous compact layouts keep the named display control
                        here; signed in, it lives inside «Cuenta» below. */}
                    {!isAuthenticatedForNavbar && (
                      <div
                        className="grid gap-2 border-y py-3"
                        data-testid="compact-display-controls"
                      >
                        <ThemeToggle showLabel />
                      </div>
                    )}

                    {/* ===== SECONDARY LINKS + «CUENTA» (SIGNED IN) ===== */}
                    {isAuthenticatedForNavbar && (
                      <>
                        {mobileSecondaryLinks}
                        {mobileAccountGroup}
                      </>
                    )}

                    {/* ===== AUTH (SIGNED OUT) ===== */}
                    {isDemoMode
                      ? !devSignedIn && (
                          <div className="grid gap-2">
                            <Button asChild className="w-full">
                              <NavbarLink href="/dev-login">{t('demoLogin')}</NavbarLink>
                            </Button>
                          </div>
                        )
                      : !isSignedIn && (
                          <div className="grid gap-2">
                            <Button asChild variant="outline" className="w-full">
                              <SignInLink onClick={() => setMobileMenuOpen(false)}>
                                {tButtons('signIn')}
                              </SignInLink>
                            </Button>
                            <Button asChild className="w-full">
                              <NavbarLink href="/#intake" onClick={() => setMobileMenuOpen(false)}>
                                {t('startDataRoom')}
                              </NavbarLink>
                            </Button>
                          </div>
                        )}
                  </div>
                </SheetContent>
              </Sheet>
            )}

            <NavbarLink
              href={isAuthenticatedForNavbar ? homePathForRole(effectiveRole) : '/'}
              aria-label={t('aria.sherlockHome')}
              className="group flex min-w-0 items-center gap-2 transition-opacity duration-200 hover:opacity-85 sm:gap-3"
            >
              <SherlockLockup className="text-primary dark:text-foreground h-7 sm:h-8 md:h-9" />
            </NavbarLink>

            {/* Signed in, only the Data Room entry sits beside the brand; the
                full public navigation renders on its own row below so it never
                overflows under the right-side controls (max-w-7xl cannot fit
                both clusters on one row). */}
            {isAuthenticatedForNavbar && primaryNavItems.length > 0 && (
              <div
                className="ml-4 hidden min-w-0 items-center gap-1 xl:flex"
                data-testid="desktop-primary-navigation"
              >
                {desktopPrimaryLinks}
              </div>
            )}
          </div>

          {/* ===== USUARIO / AUTH (DERECHA) ===== */}
          {/* Derecha: mantenemos compacto para que no parezca “párrafo” */}
          <div
            className="flex shrink-0 items-center gap-1 sm:gap-2 xl:gap-3"
            data-testid="navbar-desktop-controls"
          >
            {/* Wide layouts keep a direct display control in the header:
                named for anonymous visitors, icon only (with its accessible
                label) once signed in, where «Cuenta» keeps the named copy.
                Compact layouts still use the named menu. */}
            <div className="hidden xl:contents">
              <ThemeToggle showLabel={!isAuthenticatedForNavbar} />
            </div>

            {/* ===== USUARIO LOGUEADO ===== */}
            {/* Product decision: keep authenticated wayfinding in this main
                row. Labels are mandatory; decorative workspace icons stay
                hidden until 2xl to preserve room near the xl breakpoint. */}
            {isLoading ? (
              <NavbarUserSkeleton label={t('aria.userMenu')} />
            ) : isDemoMode ? (
              devSignedIn && desktopSecondaryLinks
            ) : (
              isSignedIn && (
                <>
                  {desktopSecondaryLinks}
                  <NavbarUtilityMenu onSignOut={handleSignOut} />
                </>
              )
            )}

            {/* ===== DEV USER MENU (DEMO) ===== */}
            {isDemoMode && devSignedIn && <NavbarUtilityMenu onSignOut={handleSignOut} />}

            {/* ===== USUARIO NO LOGUEADO ===== */}
            {isDemoMode
              ? !devSignedIn && (
                  <div className="hidden items-center space-x-2 xl:flex">
                    <Button asChild variant="ghost">
                      <NavbarLink href="/dev-login">{t('demoLogin')}</NavbarLink>
                    </Button>
                  </div>
                )
              : !isSignedIn && (
                  <div className="hidden items-center space-x-2 xl:flex">
                    <Button asChild variant="ghost">
                      <SignInLink>{tButtons('signIn')}</SignInLink>
                    </Button>
                    <Button asChild>
                      <NavbarLink href="/#intake">{t('startDataRoom')}</NavbarLink>
                    </Button>
                  </div>
                )}
          </div>
        </div>

        {/* ===== PUBLIC PRIMARY NAV (SIGNED OUT, WIDE LAYOUT) ===== */}
        {/* The five public destinations get their own row: the single-row
            header cannot host them next to the labeled utility and auth
            controls without overflowing at xl. Below xl the compact sheet
            menu keeps covering navigation. */}
        {!isAuthenticatedForNavbar && primaryNavItems.length > 0 && (
          <div
            className="hidden items-center gap-1 pb-2 xl:flex"
            data-testid="desktop-primary-navigation"
          >
            {desktopPrimaryLinks}
          </div>
        )}
      </div>
    </nav>
  )
}
