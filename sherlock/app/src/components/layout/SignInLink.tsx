'use client'

// ============================================================================
// PUERTA DE AUTENTICACIÓN: ANCLA NATIVA, NUNCA NAVEGACIÓN DE CLIENTE
// ============================================================================
// `/sign-in` no termina en una página: redirige a `/login`, que es un route
// handler que manda a WorkOS, otro origen. Con un `<Link>` de next-intl el
// router pide el payload RSC de esa URL, recibe un 307 cross-origin que no
// puede parsear, loguea «Failed to fetch RSC payload for /login?returnTo=…»
// y recién entonces cae a navegación completa. Eso costaba el segundo de
// espera antes de que cambiara la URL, y quemaba un `state` y un
// `code_challenge` PKCE por clic.
//
// Un ancla nativa hace navegación de documento: el navegador sigue los dos
// 307 sin pedir RSC. Tampoco prefetchea, que es lo que queremos en una
// puerta de un solo uso.
//
// El prefijo de locale lo ponemos a mano porque next-intl no toca un `<a>`:
// `localePrefix: 'always'` exige que toda URL interna lo lleve
// (`locale-navigation-boundary.test.ts`).
// ============================================================================

import { forwardRef, type AnchorHTMLAttributes } from 'react'
import { useLocale } from 'next-intl'

type SignInLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>

export const SignInLink = forwardRef<HTMLAnchorElement, SignInLinkProps>(function SignInLink(
  { children, ...props },
  ref
) {
  const locale = useLocale()

  return (
    <a ref={ref} href={`/${locale}/sign-in`} {...props}>
      {children}
    </a>
  )
})
