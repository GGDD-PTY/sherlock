# Design System: la sala del cliente (VDR)

Status: binding product contract
Canonical path: `docs/design-system-vdr.md`
Parent contract: `docs/design-system.md` (tokens, tipografía, accesibilidad, motion)
Pin test: `sherlock/app/src/__tests__/architecture/design-system-vdr-contract.test.ts`
Decision: [F] 2026-09-11 17:15, «tus recomendaciones me gustaron» sobre la opción de rutas reales.
Revisado contra el código: 2026-09-17. Sigue vigente: la sala es una por empresa y sus cinco
pantallas están en el catálogo.

## Authority and scope

`docs/design-system.md` excluye la sala del rediseño general. Este archivo cubre ese hueco: la
sala del cliente bajo `/my-company/*`, la barra de secciones y las pantallas que cuelgan de ella.
Los tokens, la paleta de seis pigmentos y las reglas de accesibilidad vienen del contrato padre y
no se repiten aquí. En conflicto gana `docs/compliance.md`, después este archivo, después la
regla vigente en `llm-wiki/bundle/governance/current-rules.md`.

## Por qué existe

Sin contrato, cada cambio apiló una sección más debajo del shell de documentos. El 2026-09-11 la
portada tenía siete bloques en una sola columna con el mismo tratamiento (título Fraunces, línea,
filas) y una barra de secciones que solo hacía scroll. Maintainer: «parece un cuaderno». El
problema era de arquitectura de información, no de tokens.

## Una pantalla por intención

La sala es un conjunto de pantallas. Cada una responde a una sola pregunta del dueño y cabe en
un viewport de 1440x900 sin scroll de página. El catálogo vive en
`sherlock/app/src/components/company/roomScreens.ts` y es la única fuente para rutas, enlaces
cruzados y la barra.

| Pantalla    | Ruta                      | Pregunta que responde            | Contenido                                                                                     |
| ----------- | ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| Documentos  | `/my-company/documents`   | Qué hay en mi sala               | Árbol, ficha y subida dentro del shell. Nada debajo.                                          |
| Tu empresa  | `/my-company/company`     | Qué sabe el equipo de mí         | Formulario de perfil y contacto, un solo Guardar en pie fijo.                                 |
| Preparación | `/my-company/preparation` | Qué me falta y qué me entregaron | Barra de avance, «Te falta», entregables con estado, dashboard financiero cuando hay datos.   |
| Equipo      | `/my-company/team`        | Cómo hablo con el equipo         | El hilo de soporte.                                                                           |
| Invitados   | `/my-company/guests`      | Quién más entra                  | Panel de invitados. Solo aparece en la barra cuando la sala tiene invitados o puede tenerlos. |

Reglas:

- La barra de secciones enlaza rutas con `Link` de `@/i18n/navigation` y marca la activa con
  `aria-current="page"` leyendo el pathname. No hay anclas `#seccion` ni scroll a secciones.
- El shell de documentos llena el alto disponible (viewport menos navbar) y es la única cosa en su
  pantalla. La ficha del documento y la cola de subida viven dentro del shell. El toolbar no
  ofrece asistente desde AU-06, por decisión de Maintainer del 13 de septiembre.
- Un título Fraunces por pantalla. Dentro de la pantalla, subtítulos en el tipo de texto normal.
- Un formulario tiene su Guardar en un pie visible sin scroll (sticky al fondo del viewport dentro
  del contenedor del formulario). Un botón de guardar nunca queda solo después de una línea.
- Los enlaces cruzados apuntan a la ruta de la pantalla destino, nunca a un ancla.
- La bitácora `/my-company/documents/activity` es una vista de detalle de Documentos. Se entra
  desde admin, no está en el catálogo y no aparece en la barra.

## Estático y dinámico se ven distintos

El dueño tiene que saber qué está vivo y qué es promesa.

- Una etapa de entregables sin estado (`PENDING`) no se pinta como fila. Las etapas futuras se
  resumen en una sola línea en `text-muted-foreground`: «Después vienen teaser, CIM, ...». La
  lista de filas contiene solo etapas con estado (`REQUESTED`, `NEEDS_INPUT`, `IN_PREP`,
  `DELIVERED`).
- Un campo editable se ve como input desde el primer pixel. Un dato de solo lectura (email de la
  cuenta) no se pinta como input deshabilitado; se pinta como texto con su etiqueta.
- Un placeholder que no lleva a ninguna acción no ocupa una fila.

## Contenedor compartido

La navbar de producto y las pantallas de la sala usan el mismo contenedor, `mx-auto max-w-7xl`
con `px-4 sm:px-6 lg:px-8`, así el wordmark y el borde izquierdo del shell caen en la misma
columna. Ninguna pantalla de la sala es full-bleed.

## Densidad y espaciado

- Padding de sección `py-6` o `py-8`. Filas de lista `py-2`. Ver [F] 2026-09-10 «verticalmente
  demasiado alto».
- Las líneas horizontales separan filas dentro de una lista. No separan bloques de una pantalla:
  si dos bloques necesitan una línea entre ellos, son dos pantallas.

## Verification

- El pin test lee este archivo, el catálogo de pantallas, el cliente de documentos y la barra de
  secciones. Falla si el cliente vuelve a importar un panel de otra pantalla, si la barra vuelve a
  usar anclas o si una ruta del catálogo no tiene página.
- Cada PR que toque `/my-company/*` adjunta una captura a 1440x900 por pantalla tocada, sin scroll.
