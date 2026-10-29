'use client'

// ============================================================================
// THEME PROVIDER
// ============================================================================
// Proveedor de tema para la app. El primer paint lo resuelve el boot script
// inline del layout raíz (mismo STORAGE_KEY y misma semántica de resolución);
// aquí el estado inicial se lee síncrono de localStorage para que la clase que
// puso el boot script no se pise al hidratar. En SSR el estado cae al default
// light; el DOM inicial no depende del contexto (los consumidores que sí
// renderizan según el tema se montan después o van gateados por mounted).
// ============================================================================

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Option } from 'effect'

import { decodeTheme, type ResolvedTheme, type Theme } from './theme-schema'

interface ThemeProviderProps {
  children: ReactNode
}

// ===== LA COSTURA CON EFFECT =====
// El vocabulario del tema vive en `theme-schema.ts` y de ahí salen el tipo, lo
// que se acepta de `localStorage` y las opciones del menú de «Cuenta». Antes
// eran tres listas: la unión de tipos, el arreglo del menú y la comparación
// triple que leía el storage.

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const STORAGE_KEY = 'theme'
// Sin preferencia guardada, el tema sigue al sistema ([F] 2026-09-14, que
// restaura la orden del 2026-09-03 y supersede la crema por defecto del
// 2026-09-11 18:53). Claro, oscuro y «sistema» siguen en el menú de Cuenta.
// Debe coincidir con THEME_BOOT_SCRIPT en `src/lib/theme/boot-script.ts`,
// que decide el primer paint.
const DEFAULT_THEME: Theme = 'system'
// Fallback de SSR únicamente: en el servidor no hay `prefers-color-scheme` que
// consultar, así que 'system' se resuelve a claro hasta que el boot script y la
// hidratación corrigen en el cliente.
const DEFAULT_RESOLVED_THEME: ResolvedTheme = 'light'

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  resolvedTheme: DEFAULT_RESOLVED_THEME,
  setTheme: () => {},
})

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return DEFAULT_RESOLVED_THEME
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? getSystemTheme() : theme
}

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME

  try {
    return Option.getOrElse(
      decodeTheme(window.localStorage.getItem(STORAGE_KEY)),
      () => DEFAULT_THEME
    )
  } catch {
    // Local storage can be unavailable in hardened/private browser contexts.
    return DEFAULT_THEME
  }
}

function applyTheme(resolvedTheme: ResolvedTheme) {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(resolvedTheme)
  root.style.colorScheme = resolvedTheme
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(getStoredTheme())
  )

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme)

    try {
      window.localStorage.setItem(STORAGE_KEY, nextTheme)
    } catch {
      // Local storage can be unavailable in hardened/private browser contexts.
    }
  }, [])

  useEffect(() => {
    const updateResolvedTheme = () => {
      const nextResolvedTheme = resolveTheme(theme)
      setResolvedTheme(nextResolvedTheme)
      applyTheme(nextResolvedTheme)
    }

    updateResolvedTheme()

    if (theme !== 'system') return

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', updateResolvedTheme)

    return () => {
      media.removeEventListener('change', updateResolvedTheme)
    }
  }, [theme])

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
    }),
    [resolvedTheme, setTheme, theme]
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}

export function useTheme() {
  return useContext(ThemeContext)
}

export type { Theme, ResolvedTheme }
