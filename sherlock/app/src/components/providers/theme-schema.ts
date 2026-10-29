// ============================================================================
// EL VOCABULARIO DEL TEMA
// ============================================================================
// Los tres temas se declaran una vez y todo lo demás sale de aquí: el tipo, lo
// que se acepta de `localStorage` y las opciones que pinta el menú de «Cuenta».
// El tema resuelto es esta misma unión sin `system`, no una segunda lista, así
// que un tema nuevo no puede aparecer en una y faltar en la otra.
//
// Vive fuera de `ThemeProvider.tsx` por una razón concreta: los tests de
// componentes reemplazan ese módulo entero con `vi.mock`, y un consumidor que
// solo necesita la lista no debería depender de que ese doble la reexporte.
// ============================================================================

import { Schema } from 'effect'

export const ThemeSchema = Schema.Literals(['light', 'dark', 'system'])
export type Theme = typeof ThemeSchema.Type
export type ResolvedTheme = Exclude<Theme, 'system'>

/** Qué se acepta de `localStorage` y del control del menú: entrada no controlada. */
export const isTheme = Schema.is(ThemeSchema)
export const decodeTheme = Schema.decodeUnknownOption(ThemeSchema)
