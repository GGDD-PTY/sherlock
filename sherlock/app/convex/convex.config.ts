import { defineApp } from 'convex/server'
import resend from '@convex-dev/resend/convex.config.js'
import { Schema } from 'effect'

// Componentes de Convex montados en este deployment, como catálogo real en vez
// de una secuencia de `app.use` sueltos. El componente oficial de Resend
// aporta la cola durable de email (batching, idempotencia, retries, rate
// limiting) — ver convex/email.ts para el uso.
//
// Hoy es un componente solo, así que el catálogo es corto a propósito: el
// `.literals` de abajo es lo que de verdad registra cada uno (no hay
// `Schema.Literals` decorativo cuyo único consumidor sea un tipo), y agregar
// un componente nuevo sin su entrada en `COMPONENTS` revienta el typecheck en
// vez de quedar registrado a medias.
const MountedComponentSchema = Schema.Literals(['resend'])
const COMPONENTS = { resend }

const app = defineApp()

for (const name of MountedComponentSchema.literals) {
  app.use(COMPONENTS[name])
}

export default app
