import { Schema } from 'effect'

// ============================================================================
// BOOT SCRIPT DE TEMA (PRE-PAINT)
// ============================================================================
// Script inline bloqueante que corre antes del primer paint: lee la preferencia
// guardada y setea la clase + `color-scheme` en <html> para que ninguna
// superficie flashee el tema equivocado.
//
// Semántica (idéntica a `ThemeProvider`, que decide el estado de React):
//   'dark'                        → oscuro
//   'light'                       → claro
//   'system', ausente o inválido  → sigue a `prefers-color-scheme` ([F] 2026-09-14)
//
// Vive en un módulo y no copiado en cada layout porque lo necesitan TRES
// superficies con su propio <html>: el layout de `[locale]`, `global-error` y
// `global-not-found`. Las dos últimas reemplazan el layout raíz, así que no
// heredan ni el provider ni el script — sin esto, un usuario en modo oscuro que
// cae en un 404 global ve una página blanca.
//
// La CSP de producción permite 'unsafe-inline' en script-src (sin nonces
// todavía), así que este inline pasa.
//
// El contrato está fijado por `src/__tests__/app/theme-default.test.tsx`, que
// ejecuta este mismo string y falla si su default diverge del provider.
//
// ===== EL VOCABULARIO DUPLICADO A PROPÓSITO =====
// `src/components/providers/theme-schema.ts` ya declara este mismo trío como
// `Schema.Literals`, pero `src/lib` nunca importa de `src/components` (ver
// AGENTS.md de src/lib): la dependencia va en un solo sentido. Este módulo
// además corre ANTES del bundle de React — es texto de un `<script>` inline,
// no un módulo que React importe — así que ni siquiera podría compartir el
// runtime de Effect con el provider aunque la regla de dirección no existiera.
// La solución es declarar el vocabulario acá también y usarlo para GENERAR el
// string del script (`.literals` alimenta la condición), en vez de escribir
// 'light'/'dark'/'system' dos veces sueltos. Duplicación real, documentada;
// candidato a recorte si algún día se decide compartir el vocabulario por otra
// vía. Ver reporte del lote.
// ============================================================================

const THEME_STORAGE_KEY = 'theme'

const ThemeSchema = Schema.Literals(['light', 'dark', 'system'])

const storedThemeCheck = ThemeSchema.literals.map((value) => `s==='${value}'`).join('||')

export const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');var t=(${storedThemeCheck})?s:'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var c=d?'dark':'light';var r=document.documentElement;r.classList.remove('light','dark');r.classList.add(c);r.style.colorScheme=c}catch(e){}})()`
