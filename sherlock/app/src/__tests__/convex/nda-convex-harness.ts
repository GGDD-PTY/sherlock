// ============================================================================
// HARNESS CONVEX FIEL (para los tests de evidencia de NDA)
// ============================================================================
// El harness anterior, embebido en nda-signature-evidence.test.ts, era infiel en
// dos puntos que son EXACTAMENTE los dos mecanismos que fallaban en producción:
//
//   1. `.filter()` era `vi.fn(() => builder)`: descartaba el predicado. Un
//      lookup mal filtrado (por deal, por empresa, por status) pasaba verde.
//   2. `db.patch` era `vi.fn(async () => undefined)`: no mutaba nada. Convex
//      BORRA todo campo que reciba con valor `undefined` en un patch
//      (node_modules/convex/dist/cjs-types/server/database.d.ts: "Fields set to
//      `undefined` are removed"), y ese borrado — que destruía el contentHash de
//      la firma original — era invisible para el test.
//
// Este harness reproduce las dos semánticas: evalúa los predicados de `.filter()`
// y aplica los patches sobre las filas sembradas, borrando las claves
// `undefined`. Sin esto, un test de "no se borra la evidencia" no puede ponerse
// en rojo.
// ============================================================================

import { vi } from 'vitest'

export type Row = Record<string, unknown> & { _id: string; _creationTime?: number }
export type Tables = Record<string, Row[]>

// ============================================================================
// EXPRESIONES DE FILTRO
// ============================================================================
// Convex expone `q.field(name)`, `q.eq(a, b)`, `q.and(...)`, etc. Se modelan
// como operandos resolubles contra una fila.

type FieldRef = { __field: string }
type Predicate = { __predicate: (row: Row) => unknown }

function isFieldRef(value: unknown): value is FieldRef {
  return typeof value === 'object' && value !== null && '__field' in value
}

function isPredicate(value: unknown): value is Predicate {
  return typeof value === 'object' && value !== null && '__predicate' in value
}

// Convex resuelve RUTAS de campo, no solo claves: `field('author.kind')` baja
// por el objeto anidado. Sin esto, un filtro sobre un campo anidado leía
// `undefined` acá y pasaba verde con la implementación rota.
function readFieldPath(row: Row, fieldPath: string): unknown {
  return fieldPath
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)[key]
          : undefined,
      row
    )
}

function resolveOperand(operand: unknown, row: Row): unknown {
  if (isFieldRef(operand)) return readFieldPath(row, operand.__field)
  if (isPredicate(operand)) return operand.__predicate(row)
  return operand
}

const predicate = (fn: (row: Row) => unknown): Predicate => ({ __predicate: fn })

const compare = (a: unknown, b: unknown, op: (x: number, y: number) => boolean) =>
  predicate((row) => op(Number(resolveOperand(a, row)), Number(resolveOperand(b, row))))

/** Réplica del `FilterBuilder` de Convex, suficiente para lo que usa el backend. */
export const filterApi = {
  field: (name: string): FieldRef => ({ __field: name }),
  eq: (a: unknown, b: unknown) =>
    predicate((row) => resolveOperand(a, row) === resolveOperand(b, row)),
  neq: (a: unknown, b: unknown) =>
    predicate((row) => resolveOperand(a, row) !== resolveOperand(b, row)),
  lt: (a: unknown, b: unknown) => compare(a, b, (x, y) => x < y),
  lte: (a: unknown, b: unknown) => compare(a, b, (x, y) => x <= y),
  gt: (a: unknown, b: unknown) => compare(a, b, (x, y) => x > y),
  gte: (a: unknown, b: unknown) => compare(a, b, (x, y) => x >= y),
  and: (...parts: unknown[]) =>
    predicate((row) => parts.every((part) => Boolean(resolveOperand(part, row)))),
  or: (...parts: unknown[]) =>
    predicate((row) => parts.some((part) => Boolean(resolveOperand(part, row)))),
  not: (part: unknown) => predicate((row) => !resolveOperand(part, row)),
}

// ============================================================================
// QUERY BUILDER
// ============================================================================

type IndexOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
type IndexCondition = { field: string; op: IndexOp; value: unknown }

/**
 * Réplica mínima del `IndexRangeBuilder` real de Convex: encadena `.eq()` para
 * los campos fijos del índice y, opcionalmente, UNA cota de rango (`.gt` /
 * `.gte` / `.lt` / `.lte`) sobre el siguiente campo — el patrón que usan los
 * crons acotados por `by_creation_time`/`by_kycStatus`/`by_isActive`.
 */
type IndexRangeBuilderMock = {
  eq: (field: string, value: unknown) => IndexRangeBuilderMock
  gt: (field: string, value: unknown) => IndexRangeBuilderMock
  gte: (field: string, value: unknown) => IndexRangeBuilderMock
  lt: (field: string, value: unknown) => IndexRangeBuilderMock
  lte: (field: string, value: unknown) => IndexRangeBuilderMock
}

/**
 * `rows` es la referencia VIVA del array de la tabla: los inserts hechos durante
 * la mutation tienen que ser visibles para las queries posteriores, igual que en
 * una transacción real de Convex.
 */
function createQueryBuilder(rows: Row[]) {
  let indexConditions: IndexCondition[] = []
  const predicates: Array<(row: Row) => boolean> = []
  let direction: 'asc' | 'desc' = 'asc'

  const indexConditionHolds = (row: Row, condition: IndexCondition): boolean => {
    const actual = row[condition.field]
    switch (condition.op) {
      case 'eq':
        return actual === condition.value
      case 'gt':
        return Number(actual) > Number(condition.value)
      case 'gte':
        return Number(actual) >= Number(condition.value)
      case 'lt':
        return Number(actual) < Number(condition.value)
      case 'lte':
        return Number(actual) <= Number(condition.value)
    }
  }

  const matches = () => {
    const selected = rows.filter(
      (row) =>
        indexConditions.every((condition) => indexConditionHolds(row, condition)) &&
        predicates.every((fn) => Boolean(fn(row)))
    )
    // Convex ordena por los campos del índice y, empatados esos, por
    // `_creationTime`. Con los campos del índice fijados por `eq`, el orden
    // efectivo es el de creación — que es justo lo que decide qué fila devuelve
    // `.first()`.
    const ordered = [...selected].sort((a, b) => (a._creationTime ?? 0) - (b._creationTime ?? 0))
    return direction === 'desc' ? ordered.reverse() : ordered
  }

  const builder = {
    withIndex: vi.fn((_index: string, callback?: (q: IndexRangeBuilderMock) => unknown) => {
      indexConditions = []
      const push = (field: string, op: IndexOp, value: unknown) => {
        indexConditions.push({ field, op, value })
        return rangeBuilder
      }
      const rangeBuilder: IndexRangeBuilderMock = {
        eq: (field, value) => push(field, 'eq', value),
        gt: (field, value) => push(field, 'gt', value),
        gte: (field, value) => push(field, 'gte', value),
        lt: (field, value) => push(field, 'lt', value),
        lte: (field, value) => push(field, 'lte', value),
      }
      callback?.(rangeBuilder)
      return builder
    }),
    filter: vi.fn((callback: (q: typeof filterApi) => unknown) => {
      const expression = callback(filterApi)
      predicates.push((row) => Boolean(resolveOperand(expression, row)))
      return builder
    }),
    order: vi.fn((order: 'asc' | 'desc' = 'asc') => {
      direction = order
      return builder
    }),
    first: vi.fn(async () => matches()[0] ?? null),
    unique: vi.fn(async () => matches()[0] ?? null),
    collect: vi.fn(async () => matches()),
    take: vi.fn(async (count?: number) =>
      count === undefined ? matches() : matches().slice(0, count)
    ),
    // Cursor-based y consciente de `numItems`: sin opciones (o sin
    // `numItems`), devuelve todo en una sola página como antes — retro-
    // compatible con los tests que ya usaban este mock. Con `numItems`
    // fija el tamaño de página y sigue el cursor, para poder probar que un
    // handler procesa en lotes acotados en vez de un `.collect()` sin techo.
    paginate: vi.fn(async (opts?: { numItems?: number; cursor?: string | null }) => {
      const all = matches()
      const start = opts?.cursor ? Number(opts.cursor) : 0
      const numItems = opts?.numItems ?? all.length
      const page = all.slice(start, start + numItems)
      const nextIndex = start + page.length
      return { page, isDone: nextIndex >= all.length, continueCursor: String(nextIndex) }
    }),
  }

  return builder
}

// ============================================================================
// CTX
// ============================================================================

export type HarnessCtx = ReturnType<typeof createConvexCtx>

export function createConvexCtx(
  tables: Tables,
  options: { identity?: Record<string, unknown> | null } = {}
) {
  const inserted: Array<{ table: string; row: Row }> = []
  let sequence = 1_000

  const findRow = (id: string): { row: Row } | null => {
    for (const rows of Object.values(tables)) {
      const row = rows.find((candidate) => candidate._id === id)
      if (row) return { row }
    }
    return null
  }

  return {
    tables,
    inserted,
    auth: {
      getUserIdentity: vi.fn(async () =>
        options.identity === undefined ? null : options.identity
      ),
    },
    db: {
      query: vi.fn((table: string) => {
        tables[table] ??= []
        return createQueryBuilder(tables[table])
      }),
      get: vi.fn(async (id: string) => findRow(id)?.row ?? null),
      /**
       * Metadatos de blob: Convex los sirve desde `db.system`, no desde las
       * tablas de usuario. El harness los siembra en la tabla `_storage`.
       */
      system: {
        get: vi.fn(
          async (id: string) =>
            (tables._storage ?? []).find((candidate) => candidate._id === id) ?? null
        ),
        query: vi.fn((table: string) => {
          tables[table] ??= []
          return createQueryBuilder(tables[table])
        }),
      },
      /**
       * Convex resuelve `normalizeId` contra la tabla codificada en el id. El
       * harness lo aproxima con la pertenencia real de la fila: un id de otra
       * tabla (o inventado) devuelve null, igual que en producción.
       */
      normalizeId: vi.fn((table: string, id: string) =>
        (tables[table] ?? []).some((row) => row._id === id) ? id : null
      ),
      /**
       * Semántica real de Convex: las claves con valor `undefined` se BORRAN del
       * documento. Reproducirla es el punto entero de este harness.
       */
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const found = findRow(id)
        if (!found) throw new Error(`patch sobre id inexistente: ${id}`)
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) {
            delete found.row[key]
          } else {
            found.row[key] = value
          }
        }
        return undefined
      }),
      replace: vi.fn(async (id: string, doc: Record<string, unknown>) => {
        const found = findRow(id)
        if (!found) throw new Error(`replace sobre id inexistente: ${id}`)
        for (const key of Object.keys(found.row)) {
          if (key !== '_id' && key !== '_creationTime') delete found.row[key]
        }
        Object.assign(found.row, doc)
        return undefined
      }),
      insert: vi.fn(async (table: string, doc: Record<string, unknown>) => {
        sequence += 1
        const _id = `${table}_${sequence}`
        const row = { ...doc, _id, _creationTime: sequence } as Row
        tables[table] ??= []
        tables[table].push(row)
        inserted.push({ table, row })
        return _id
      }),
      delete: vi.fn(async (id: string) => {
        for (const rows of Object.values(tables)) {
          const index = rows.findIndex((candidate) => candidate._id === id)
          if (index >= 0) {
            rows.splice(index, 1)
            return undefined
          }
        }
        return undefined
      }),
    },
    // El scheduler real de Convex devuelve una promesa. El mock devolvía
    // `undefined`, que `await` tolera y `Effect.tryPromise` no: le llama
    // `.then` y muere con «Cannot read properties of undefined (reading
    // 'then')». Dos workers convirtiendo `convex/` chocaron con esto y tuvieron
    // que envolver su llamada en `async () =>` para esquivarlo. El mock era
    // menos fiel que lo que imita; se arregla acá y no en cada llamador.
    scheduler: {
      runAfter: vi.fn().mockResolvedValue('scheduled_test'),
      runAt: vi.fn().mockResolvedValue('scheduled_test'),
      cancel: vi.fn(() => Promise.resolve()),
    },
  }
}

/** Invoca el handler crudo de una función Convex, saltando el wrapper. */
export function runHandler<TArgs, TResult = unknown>(
  fn: unknown,
  ctx: unknown,
  args: TArgs
): Promise<TResult> {
  return (fn as { _handler: (ctx: unknown, args: TArgs) => Promise<TResult> })._handler(ctx, args)
}

// Convex ejecuta cada mutation con aislamiento serializable y reintenta el
// perdedor de un conflicto OCC sobre el snapshot nuevo. El harness in-memory
// comparte arrays mutables y no tiene un scheduler transaccional; esta cola
// reproduce el resultado observable de ese retry para tests concurrentes.
const mutationQueues = new WeakMap<object, Promise<void>>()

export async function runMutationHandlerWithOcc<TArgs, TResult = unknown>(
  fn: unknown,
  ctx: object,
  args: TArgs
): Promise<TResult> {
  const previous = mutationQueues.get(ctx) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  mutationQueues.set(
    ctx,
    previous.then(() => current)
  )
  await previous
  try {
    return await runHandler<TArgs, TResult>(fn, ctx, args)
  } finally {
    release()
  }
}
