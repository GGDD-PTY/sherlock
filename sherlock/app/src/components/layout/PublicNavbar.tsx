'use client'

// Lockup oficial del kit (SVG), nunca el wordmark tipeado (BRAND.md §6).
//
// La barra del sitio público, con el mismo markup y las mismas clases que la
// `LandingNavbar` de `Navbar.tsx`, menos la sesión: no la consulta, así que no
// arrastra el cliente de Convex ni AuthKit al first-load JS de la landing
// (tarjeta O2-06). Consecuencia aceptada por la tarjeta: quien ya
// tiene sesión abierta ve «Iniciar sesión» en estas páginas en vez del atajo a
// su sala; el atajo sigue en la barra de la app.
//
// `/sign-in` es la única página pública sin barra, igual que hoy: la puerta no
// se pinta con la navegación del sitio detrás.

import { useState } from 'react'
import { Schema } from 'effect'
import { useTranslations } from 'next-intl'
import { CircleHelp, LogIn, Menu } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Link, usePathname } from '@/i18n/navigation'
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
import { SherlockLockup } from '@/components/shared/SherlockLockup'
import { SignInLink } from '@/components/layout/SignInLink'
import { SITE_BRAND_NAME } from '@/lib/site/brand'

// Un solo enlace de ayuda: el roadmap dejó de ser una página propia y vive
// dentro de /ayuda ([F] 2026-09-01). Dos entradas al mismo hub era copy de más.
const LandingNavHrefSchema = Schema.Literals(['/ayuda'])
type LandingNavHref = typeof LandingNavHrefSchema.Type

const AuthNavbarSkipPrefixSchema = Schema.Literals(['/sign-in'])
// El segmento exacto y lo que cuelgue de él: un `startsWith` pelado también
// taparía la barra en una ruta futura tipo `/sign-in-help`.
const hidesNavbar = (pathname: string) =>
  AuthNavbarSkipPrefixSchema.literals.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )

export function PublicNavbar() {
  const pathname = usePathname()
  const t = useTranslations('common.navbar')
  const tButtons = useTranslations('common.buttons')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const landingLinkByHref = {
    '/ayuda': { label: t('helpAndHow'), icon: CircleHelp },
  } satisfies Record<LandingNavHref, { readonly label: string; readonly icon: LucideIcon }>
  const landingLinks = LandingNavHrefSchema.literals.map((href) => ({
    href,
    ...landingLinkByHref[href],
  }))

  if (hidesNavbar(pathname)) return null

  return (
    <nav
      aria-label={t('aria.mainNavigation')}
      className="bg-background border-border sticky top-0 z-50 h-14 border-b"
    >
      <div className="mx-auto flex h-full max-w-6xl items-center gap-6 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          aria-label={t('aria.sherlockHome')}
          className="focus-visible:ring-ring flex min-w-0 items-center gap-3 transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:outline-none"
        >
          <SherlockLockup className="text-primary dark:text-foreground h-8 sm:h-9" />
        </Link>

        {/* lg, no xl: la landing lleva pocos items y a 1240px el hamburger se
            sentía prematuro (anotación [F] 2026-08-27). */}
        <div
          className="ml-3 hidden items-center gap-1 lg:flex"
          data-testid="landing-primary-navigation"
        >
          {landingLinks.map(({ href, label, icon: Icon }) => (
            <Button key={href} variant="ghost" size="sm" asChild>
              <Link href={href}>
                {Icon ? <Icon className="h-4 w-4" /> : null}
                {label}
              </Link>
            </Button>
          ))}
          <ThemeToggle showLabel />
          <Button variant="ghost" size="sm" asChild>
            <SignInLink>
              <LogIn className="h-4 w-4" aria-hidden="true" />
              {tButtons('signIn')}
            </SignInLink>
          </Button>
        </div>

        <div className="ml-auto lg:hidden">
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
                    igual que en `SiteFooter`. */}
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
                      <Link
                        href={href}
                        className="hover:bg-muted focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                      >
                        {Icon ? <Icon className="h-4 w-4" /> : null}
                        {label}
                      </Link>
                    </SheetClose>
                  ))}
                </div>

                <div className="border-border grid gap-2 border-y py-4">
                  <ThemeToggle showLabel />
                </div>

                <div className="grid gap-2">
                  <SheetClose asChild>
                    <Button variant="outline" className="min-h-11 w-full" asChild>
                      <SignInLink>
                        <LogIn className="h-4 w-4" aria-hidden="true" />
                        {tButtons('signIn')}
                      </SignInLink>
                    </Button>
                  </SheetClose>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </nav>
  )
}
