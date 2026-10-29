import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runReachabilityGate } from '../../../scripts/security-audit-reachability'

const scriptPath = resolve(process.cwd(), 'scripts/security-audit-reachability.ts')
// Con el install limpio de bun en el workspace raíz, `tsx` queda hoisted en el
// `.bin` del repo raíz y `sherlock/app/node_modules/.bin/tsx` no existe.
// Resolver ambos candidatos y usar el primero presente.
const tsxCandidates = [
  resolve(process.cwd(), 'node_modules/.bin/tsx'),
  resolve(process.cwd(), '../../node_modules/.bin/tsx'),
]
const tsxBin = tsxCandidates.find((candidate) => existsSync(candidate)) ?? tsxCandidates[0]

const tempDirs: string[] = []

// Una corrida del CLI tarda de 0,4 a 2,4 s en local y hasta 1,4 s en
// Blacksmith. Sin tope, un hijo de `tsx` que se queda esperando bloquea el
// `spawnSync`: el worker de vitest no llega a disparar su testTimeout, no
// imprime nada y el job muere a los 30 min (PR Gate 34879645865, 2026-09-14).
// El tope va con SIGKILL porque con SIGTERM `spawnSync` sigue esperando a un
// hijo que no sale.
const GATE_TIMEOUT_MS = 30_000
// Después de un tope, el resto del archivo falla sin lanzar otra corrida: si el
// cuelgue alcanzara a todas, 112 esperas de 30 s también se comerían el job.
let gateTimedOut = false

type GateOptions = {
  auditStdout: string
  auditExitCode?: number
  auditStderr?: string
  policy?: unknown
  lockfile?: unknown
  sourceFiles?: Record<string, string>
  existingMatrix?: string
}

/**
 * Corre el gate con un `bun` falso primero en PATH, para poder fijar
 * exactamente qué devuelve `bun audit --json` (payload y exit code).
 * Es el mismo patrón que validate-prod-setup.test.ts usa con un `bunx` falso.
 */
function prepareGateHome(options: GateOptions) {
  const dir = mkdtempSync(join(tmpdir(), 'reachability-gate-'))
  tempDirs.push(dir)
  const matrixPath = join(dir, 'matrix.md')
  if (options.existingMatrix !== undefined) writeFileSync(matrixPath, options.existingMatrix)

  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const fakeBun = join(binDir, 'bun')
  writeFileSync(
    fakeBun,
    [
      '#!/usr/bin/env node',
      'if (process.env.FAKE_BUN_STDERR) process.stderr.write(process.env.FAKE_BUN_STDERR)',
      "process.stdout.write(process.env.FAKE_BUN_STDOUT ?? '')",
      'process.exit(Number(process.env.FAKE_BUN_EXIT ?? 0))',
    ].join('\n')
  )
  chmodSync(fakeBun, 0o755)

  const policyPath = join(dir, 'policy.json')
  writeFileSync(
    policyPath,
    JSON.stringify(options.policy ?? { generatedOn: '2026-07-30', rules: {} })
  )

  const lockfilePath = join(dir, 'bun.lock')
  writeFileSync(
    lockfilePath,
    JSON.stringify(
      options.lockfile ?? {
        lockfileVersion: 1,
        packages: {
          eslint: [
            'eslint@9.39.4',
            '',
            { dependencies: { minimatch: '^9.0.0' } },
            'sha512-fixture',
          ],
          minimatch: ['minimatch@9.0.3', '', {}, 'sha512-fixture'],
        },
      }
    )
  )

  // Raíz de código de runtime aislada del repo real: sin fixtures, el escaneo
  // de imports no encuentra nada (src/ vacío).
  const sourceRoot = join(dir, 'source-root')
  mkdirSync(join(sourceRoot, 'src'), { recursive: true })
  for (const [relativePath, content] of Object.entries(options.sourceFiles ?? {})) {
    const filePath = join(sourceRoot, relativePath)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, content)
  }

  return {
    matrixPath,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_BUN_STDOUT: options.auditStdout,
      FAKE_BUN_STDERR: options.auditStderr ?? '',
      FAKE_BUN_EXIT: String(options.auditExitCode ?? 0),
      SECURITY_REACHABILITY_POLICY: policyPath,
      SECURITY_REACHABILITY_MATRIX_OUT: matrixPath,
      SECURITY_REACHABILITY_LOCKFILE: lockfilePath,
      SECURITY_REACHABILITY_SOURCE_ROOT: sourceRoot,
    },
  }
}

const GATE_ENV_KEYS = [
  'PATH',
  'FAKE_BUN_STDOUT',
  'FAKE_BUN_STDERR',
  'FAKE_BUN_EXIT',
  'SECURITY_REACHABILITY_POLICY',
  'SECURITY_REACHABILITY_MATRIX_OUT',
  'SECURITY_REACHABILITY_LOCKFILE',
  'SECURITY_REACHABILITY_SOURCE_ROOT',
] as const

async function runGate(options: GateOptions) {
  const { matrixPath, env } = prepareGateHome(options)
  const previous = Object.fromEntries(GATE_ENV_KEYS.map((key) => [key, process.env[key]]))
  const stdout: string[] = []
  const stderr: string[] = []
  const log = console.log
  const error = console.error
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '))
  }
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '))
  }

  try {
    Object.assign(process.env, env)
    const status = await runReachabilityGate()
    return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n'), matrixPath }
  } finally {
    console.log = log
    console.error = error
    for (const key of GATE_ENV_KEYS) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function runGateCli(options: GateOptions) {
  const { matrixPath, env } = prepareGateHome(options)
  if (gateTimedOut) {
    throw new Error(`Una corrida anterior del gate pasó de ${GATE_TIMEOUT_MS} ms; esta no se lanza.`)
  }
  const result = spawnSync(tsxBin, [scriptPath], {
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: GATE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      ...env,
    },
  })
  if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
    gateTimedOut = true
    throw new Error(
      `El gate no terminó en ${GATE_TIMEOUT_MS} ms y spawnSync lo mató.\nstdout: ${result.stdout.slice(-2000)}\nstderr: ${result.stderr.slice(-2000)}`
    )
  }
  return Object.assign(result, { matrixPath })
}

const HIGH_ADVISORY = {
  id: 1113544,
  url: 'https://github.com/advisories/GHSA-7r86-cg39-jmmj',
  title: 'minimatch has ReDoS via GLOBSTAR backtracking',
  severity: 'high',
  vulnerable_versions: '>=9.0.0 <9.0.7',
}

function rule(
  reviewBy: string,
  advisories: Record<string, string> = {
    [HIGH_ADVISORY.url]: HIGH_ADVISORY.vulnerable_versions,
  },
  lockEntries: Record<string, string> = { minimatch: '9.0.3' },
  consumers: string[] = ['eslint#dependencies'],
  runtimeImports?: Record<string, string[]>
) {
  return {
    generatedOn: '2026-07-30',
    rules: {
      minimatch: {
        classification: 'build_pipeline_only',
        rationale: 'Solo lo ejecuta el toolchain de lint en CI.',
        reviewBy,
        owner: 'app-security',
        advisories,
        lockEntries,
        consumers,
        ...(runtimeImports === undefined ? {} : { runtimeImports }),
      },
    },
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('reachability gate — fail closed', () => {
  it('falla cuando el audit devuelve un payload de error en vez de un reporte', async () => {
    // Esta es la regresión del blocker: `npm audit` sin package-lock salía
    // ENOLOCK con este payload, el wrapper lo parseaba como audit vacío y el
    // check requerido reportaba PASS. Un payload que no entendemos NO pasa.
    const result = await runGate({
      auditStdout: JSON.stringify({
        error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' },
      }),
      auditExitCode: 1,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ENOLOCK')
  })

  it('falla cuando el audit sale con un status inesperado aunque el stdout parsee', async () => {
    // `bun audit` sale con 1 cuando ENCUENTRA avisos: ese es el único exit
    // distinto de cero cuyo stdout es un reporte. Un auditor caído puede salir
    // 2 habiendo emitido `{}`; interpretarlo como árbol limpio sería otro
    // camino false-green.
    const result = await runGate({
      auditStdout: '{}',
      auditExitCode: 2,
      auditStderr: 'internal auditor failure',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unexpected status 2')
  })

  it('falla cuando el audit no produce salida alguna', async () => {
    const result = await runGate({
      auditStdout: '',
      auditExitCode: 127,
      auditStderr: 'bun: command not found',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('no report')
  })

  it('falla cuando un advisory no tiene forma válida (sin severity)', async () => {
    // Payload con arrays pero elementos sin forma de advisory: aceptarlo haría
    // que `selectFindings` viera severity undefined y el gate saliera en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [{}] }),
      auditExitCode: 1,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('advisory without a valid shape')
  })

  it('falla cuando un advisory trae una severidad desconocida', async () => {
    // "HIGH" (o un valor nuevo del tool) no pasaría el filtro high/critical y
    // se descartaría en silencio; una severidad fuera del enum no es un
    // reporte interpretable.
    const result = await runGate({
      auditStdout: JSON.stringify({
        minimatch: [{ ...HIGH_ADVISORY, severity: 'HIGH' }],
      }),
      auditExitCode: 1,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unrecognized severity')
  })

  it('falla cuando un advisory viene sin rango de versiones vulnerables', async () => {
    // Regresión del ALLOW vacuo: un advisory con severity y URL válidos pero
    // sin `vulnerable_versions` degradaba la cobertura a '' y una regla con
    // rango vacío lo eximía. Un aviso sin rango no es interpretable: no hay
    // nada que comparar contra el rango revisado.
    const advisory: Record<string, unknown> = { ...HIGH_ADVISORY }
    delete advisory.vulnerable_versions
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [advisory] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', { [HIGH_ADVISORY.url]: '' }),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('without a vulnerable_versions range')
  })

  it('falla cuando la política trae una clasificación desconocida', async () => {
    // "runtime-reachabl" (mal tipeada) no debe caer en el camino permisivo:
    // política malformada no emite veredicto.
    const policy = rule('2099-01-01') as ReturnType<typeof rule> & {
      rules: { minimatch: { classification: string } }
    }
    policy.rules.minimatch.classification = 'runtime-reachabl'
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unrecognized classification')
  })

  it('falla cuando la salida del audit no es JSON', async () => {
    const result = await runGate({ auditStdout: 'not json at all', auditExitCode: 1 })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('JSON')
  })
})

describe('reachability gate — veredicto', () => {
  it('conserva la matriz commiteada cuando solo cambia la fecha', async () => {
    const first = await runGate({ auditStdout: '{}' })
    const produced = readFileSync(first.matrixPath, 'utf8')
    const dated = produced.replace(/^Generated on: .*$/m, 'Generated on: 2000-01-01')

    const second = await runGate({ auditStdout: '{}', existingMatrix: dated })

    expect(second.status).toBe(0)
    expect(readFileSync(second.matrixPath, 'utf8')).toBe(dated)
  })

  it('reescribe la matriz cuando cambian los hallazgos', async () => {
    const result = await runGate({ auditStdout: '{}', existingMatrix: 'Generated on: 2000-01-01\nvieja' })

    expect(result.status).toBe(0)
    expect(readFileSync(result.matrixPath, 'utf8')).toContain(
      `Generated on: ${new Date().toISOString().slice(0, 10)}`
    )
  })

  it('pasa cuando el árbol no tiene avisos', async () => {
    const result = await runGate({ auditStdout: '{}', auditExitCode: 0 })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Reachability gate passed')
  })

  it('pasa cuando solo hay avisos por debajo de high', async () => {
    const result = await runGate({
      auditStdout: JSON.stringify({
        dompurify: [{ ...HIGH_ADVISORY, severity: 'moderate' }],
      }),
      auditExitCode: 1,
    })

    expect(result.status).toBe(0)
  })

  it('bloquea un high sin regla de reachability', async () => {
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('permite un high con regla vigente que lo declara fuera del runtime', async () => {
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
    })

    expect(result.status).toBe(0)
  })

  it('bloquea un aviso nuevo que la regla vigente no lista', async () => {
    // La excepción cubre avisos concretos, no al paquete para siempre: un
    // advisory nuevo para un paquete ya triado vuelve a bloquear como
    // untriaged hasta clasificarse con evidencia propia.
    const result = await runGate({
      auditStdout: JSON.stringify({
        minimatch: [
          HIGH_ADVISORY,
          {
            ...HIGH_ADVISORY,
            id: 9999999,
            url: 'https://github.com/advisories/GHSA-new1-new1-new1',
          },
        ],
      }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea cuando un GHSA ya triado amplía su rango de versiones vulnerables', async () => {
    // Un GHSA enmendado conserva URL e id, así que la cobertura por URL sola
    // lo seguiría aceptando aunque ahora cubra una copia instalada que el
    // triaje declaró fuera de rango (p.ej. ws@8.21.0 en runtime), sin ningún
    // cambio de lockfile. El rango revisado está pinneado: un rango distinto
    // exige re-triaje.
    const result = await runGate({
      auditStdout: JSON.stringify({
        minimatch: [{ ...HIGH_ADVISORY, vulnerable_versions: '>=9.0.0 <9.1.0' }],
      }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('falla cuando la política pinnea avisos sin rango (forma legacy)', async () => {
    // La forma vieja (array de URLs) no pinnea `vulnerable_versions`; tratarla
    // como "nada cubierto" en silencio bloquearía sin explicar. Política
    // malformada no emite veredicto.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', [HIGH_ADVISORY.url] as unknown as Record<string, string>),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed "advisories"')
  })

  it('falla cuando la política pinnea un rango vacío para un aviso', async () => {
    // Un rango vacío no pinnea nada: igualaría a un aviso sin rango y la
    // "cobertura" sería vacua. Política malformada no emite veredicto.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', { [HIGH_ADVISORY.url]: '' }),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed "advisories"')
  })

  it('bloquea cuando el lockfile gana una copia del paquete que la regla no revisó', async () => {
    // El rationale justifica copias concretas en caminos concretos (clave de
    // bun.lock → versión). La misma advisory llegando por una copia nueva
    // (p.ej. una runtime dependency que trae la versión vulnerable por otro
    // camino) no hereda la excepción vieja.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      lockfile: {
        lockfileVersion: 1,
        packages: {
          minimatch: ['minimatch@9.0.3', '', {}, 'sha512-fixture'],
          'some-runtime-dep/minimatch': ['minimatch@9.0.3', '', {}, 'sha512-fixture'],
        },
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea cuando un consumidor nuevo reutiliza la copia hoisted ya revisada', async () => {
    // Una runtime dependency nueva que declara depender del paquete no crea
    // clave ni cambia versión (reutiliza la copia hoisted), pero sí cambia la
    // reachability: la arista nueva exige re-triaje.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      lockfile: {
        lockfileVersion: 1,
        packages: {
          eslint: [
            'eslint@9.39.4',
            '',
            { dependencies: { minimatch: '^9.0.0' } },
            'sha512-fixture',
          ],
          'some-runtime-dep': [
            'some-runtime-dep@1.0.0',
            '',
            { dependencies: { minimatch: '^9.0.0' } },
            'sha512-fixture',
          ],
          minimatch: ['minimatch@9.0.3', '', {}, 'sha512-fixture'],
        },
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea cuando un consumidor nuevo llega por un intermediario ya revisado', async () => {
    // `runtime-framework -> glob -> minimatch`: la arista nueva queda
    // registrada bajo glob y no toca ninguna arista directa de minimatch,
    // pero crea un camino runtime nuevo hacia él. La excepción pinnea el
    // cierre transitivo de aristas entrantes, así que el ancestro nuevo
    // bloquea hasta re-triar.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, ['glob#dependencies']),
      lockfile: {
        lockfileVersion: 1,
        packages: {
          glob: ['glob@10.4.5', '', { dependencies: { minimatch: '^9.0.0' } }, 'sha512-fixture'],
          'runtime-framework': [
            'runtime-framework@1.0.0',
            '',
            { dependencies: { glob: '^10.0.0' } },
            'sha512-fixture',
          ],
          minimatch: ['minimatch@9.0.3', '', {}, 'sha512-fixture'],
        },
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea cuando un consumidor mueve el paquete de devDependencies a dependencies', async () => {
    // El mismo consumidor y la misma copia hoisted, pero la arista cambia de
    // sección: el lockfile ahora declara el paquete como runtime. La sección
    // es parte de la identidad pinneada ("<consumidor>#<sección>"), así que
    // la excepción build_pipeline_only deja de aplicar hasta re-triar.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, ['workspace:sherlock/app#devDependencies']),
      lockfile: {
        lockfileVersion: 1,
        workspaces: {
          'sherlock/app': { dependencies: { minimatch: '^9.0.0' } },
        },
        packages: {
          minimatch: ['minimatch@9.0.3', '', {}, 'sha512-fixture'],
        },
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea cuando el código de runtime importa directamente un paquete exceptuado', async () => {
    // Un import directo no toca bun.lock (la copia ya está hoisted), así que
    // ni claves ni aristas lo delatan; el escaneo de src/convex sí.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/globbing.ts': "import { minimatch } from 'minimatch'\nexport { minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no bloquea por un import que solo existe en un comentario', async () => {
    // `// import { minimatch } from 'minimatch'` es documentación, no
    // reachability: los comentarios se descartan antes de decidir.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/notes.ts':
          "// import { minimatch } from 'minimatch'\nexport const nota = 'documentado'\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('no deja invisible un import que sigue a un literal de regex con /*', async () => {
    // `/[/*]/` contiene los chars crudos `/*`: tratarlos como apertura de
    // comentario de bloque blanquearía todo hasta el próximo `*/`, dejando
    // invisible un import real de runtime — falso negativo del gate.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/pattern.ts':
          "const separadores = /[/*]/\nimport { minimatch } from 'minimatch'\nexport { separadores, minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no deja invisible un import tras una regex que sigue a una condición de control-flow', async () => {
    // En `if (ok) /[/*]/.test(value)` el ')' cierra una CONDICIÓN, no un
    // operando: el '/' siguiente abre regex. Clasificarlo como división
    // trataría el `/*` interno como comentario de bloque y blanquearía el
    // import real que sigue — falso negativo del gate.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/guard.ts':
          "const ok = true\nconst value = 'x'\nif (ok) /[/*]/.test(value)\nimport { minimatch } from 'minimatch'\nexport { minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no deja invisible un import tras una regex que sigue a un límite de sentencia', async () => {
    // En `debugger\n/[/*]/.test(v)` el ASI cierra la sentencia `debugger` y
    // el '/' abre regex, no división. Clasificarlo como división trataría el
    // `/*` interno como comentario de bloque y blanquearía el import real
    // que sigue — falso negativo del gate. Igual con keywords separadas por
    // whitespace (`export default /[/*]/`): sin límite de palabra se
    // fusionarían en "exportdefault" y la keyword nunca matchearía.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/boundary.ts':
          "debugger\n/[/*]/.test('v')\nimport { minimatch } from 'minimatch'\nexport { minimatch }\n",
        'src/lib/default-regex.ts':
          "export default /[/*]/\nimport { minimatch } from 'minimatch'\nexport { minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no deja invisible un import tras una regex que sigue a un break/continue con label', async () => {
    // En `break outer\n/[/*]/.test(v)` la última palabra es el LABEL, no la
    // keyword: `break label` / `continue label` terminan la sentencia
    // (producción restringida + ASI), así que el '/' siguiente abre regex.
    // Clasificarlo como división trataría el `/*` interno como comentario de
    // bloque y blanquearía el import real que sigue — falso negativo del gate.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/labeled-break.ts':
          "outer: for (const v of ['v']) {\n  if (v) break outer\n  /[/*]/.test(v)\n}\nimport { minimatch } from 'minimatch'\nexport { minimatch }\n",
        'src/lib/labeled-continue.ts':
          "outer: for (const v of ['v']) {\n  if (v) continue outer\n  /[/*]/.test(v)\n}\nimport { minimatch } from 'minimatch'\nexport { minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no deja invisible un import tras texto JSX que empieza con /*', async () => {
    // En un `.tsx`, `<span>/*</span>` es texto JSX (un token JsxText que se
    // renderiza tal cual), no la apertura de un comentario de bloque. Un
    // lexer sin modelo de JSX entraba en estado de comentario y blanqueaba
    // el resto del archivo, ocultando el require real que sigue — falso
    // negativo del gate. El stripper usa el parser real de TypeScript, que
    // sí distingue texto JSX de trivia de comentario.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/jsx-text.tsx':
          "export const C = () => <span>/*</span>\nconst mm = require('minimatch')\nexport { mm }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no deja invisible un import tras una regex que sigue a una declaración de import', async () => {
    // En `import x from 'foo'\n/[/*]/.test(v)` el cierre del module
    // specifier TERMINA la declaración (nada salvo `;` o atributos puede
    // seguir): el '/' siguiente abre regex por ASI, no división. Marcar el
    // string como operando trataría el `/*` interno como comentario de
    // bloque y blanquearía el import real que sigue — falso negativo.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/decl-regex.ts':
          "import path from 'node:path'\n/[/*]/.test('v')\nimport { minimatch } from 'minimatch'\nexport { path, minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no bloquea por un import type-only de un paquete vigilado', async () => {
    // `import type ... from 'minimatch'` se borra en compilación y nunca
    // carga el módulo: no es reachability de runtime y no debe romper el
    // gate requerido.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/types.ts':
          "import type { MinimatchOptions } from 'minimatch'\nexport type Opciones = MinimatchOptions\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('no bloquea por las formas type-only borradas con default o import-equals', async () => {
    // `import type Foo, { Bar } from 'x'` e `import type Foo = require('x')`
    // también se borran completos en compilación: ninguna carga el módulo.
    // Sin cubrirlas, el escáner genérico de `from`/`require` las contaría
    // como hits de runtime y rompería una política revisada sin cambios.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/tipos-default.ts':
          "import type Minimatch, { MinimatchOptions } from 'minimatch'\nexport type Par = [Minimatch, MinimatchOptions]\n",
        'src/lib/tipos-equals.ts':
          "import type Todo = require('minimatch')\nexport type Alias = typeof Todo\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('bloquea un import-equals de valor de un paquete vigilado', async () => {
    // `import Foo = require('x')` SIN `type` emite un require real: solo la
    // variante type-only queda excluida (fail-closed).
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/equals.ts': "import mm = require('minimatch')\nexport const usar = mm\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea un import mixto aunque incluya specifiers type', async () => {
    // `import { type A, b } from 'x'` mantiene el import en runtime: el
    // specifier de valor sobrevive a la compilación (fail-closed).
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/mixto.ts':
          "import { type MinimatchOptions, minimatch } from 'minimatch'\nexport { minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no bloquea por una cláusula named cuyos specifiers son todos inline type', async () => {
    // `import { type A } from 'x'` se elide completo con la config real del
    // repo (sin verbatimModuleSyntax): el módulo nunca se carga en runtime,
    // así que no es reachability y no debe romper el gate requerido.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/tipos-inline.ts':
          "import { type MinimatchOptions, type Minimatch as MM } from 'minimatch'\nexport type Par = [MinimatchOptions, MM]\n",
        'src/lib/reexport-inline.ts': "export { type MinimatchOptions } from 'minimatch'\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('no bloquea por un re-export inline all-type con alias de módulo string', async () => {
    // `export { type X as "alias" } from 'x'` también se elide completo en
    // compilación, pero el blanqueo textual no reconoce el alias string y el
    // camino AST registraba la declaración entera antes de filtrar sus
    // specifiers: el `from` visible dejaba un hit `minimatch []` falso y una
    // anotación borrada rompía el gate requerido.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/reexport-string.ts':
          'export { type MinimatchOptions as "opciones" } from \'minimatch\'\n',
      },
    })

    expect(result.status).toBe(0)
  })

  it('no deja invisible un require tras un string que imita un import type', async () => {
    // `const s = "import type Foo from " + require("minimatch")`: el regex
    // textual de type-only arrancaba DENTRO del string, tomaba su comilla de
    // cierre como apertura del module specifier y blanqueaba a través de
    // `require("` — el paquete vigilado cargaba en runtime con el gate
    // requerido en verde. En archivos que parsean, el blanqueo type-only usa
    // ahora los rangos de nodo del parser; el regex queda solo como fallback
    // de archivos que no parsean.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/etiqueta.ts':
          'const s = "import type Foo from " + require("minimatch")\nexport { s }\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no bloquea por un import de augmentación en un archivo de declaraciones', async () => {
    // Un `.d.ts` nunca se emite ni se ejecuta: `import 'minimatch'` en
    // `src/global.d.ts` es augmentación de módulo que el compilador borra,
    // pero `extname` lo clasifica como `.ts` y el walk lo escaneaba como
    // fuente de runtime — una anotación legítima rompía el gate requerido.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/global.d.ts':
          "import 'minimatch'\ndeclare module 'minimatch' {\n  interface MinimatchOptions {\n    extra?: string\n  }\n}\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('bloquea un binding de valor llamado `type` y una cláusula vacía', async () => {
    // `import { type } from 'x'` importa un VALOR llamado `type` (no es un
    // specifier inline type) e `import {} from 'x'` ejecuta el módulo por
    // side effects: ambos cargan el paquete en runtime (fail-closed).
    for (const source of [
      "import { type } from 'minimatch'\nexport const usar = type\n",
      "import {} from 'minimatch'\nexport const cargado = true\n",
    ]) {
      const result = await runGate({
        auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
        auditExitCode: 1,
        policy: rule('2099-01-01'),
        sourceFiles: { 'src/lib/valor.ts': source },
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('minimatch')
    }
  })

  it('bloquea un require con llamada opcional de un paquete vigilado', async () => {
    // `require?.('minimatch')` es sintaxis válida que carga el paquete igual
    // que `require(...)`: exigir `(` inmediato tras `require` lo dejaría
    // invisible y una copia hoisted vulnerable se volvería runtime-reachable
    // sin tocar el lockfile.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/opcional.ts': "const mm = require?.('minimatch')\nexport { mm }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea un require de un paquete vigilado vía alias de createRequire', async () => {
    // `const localRequire = createRequire(import.meta.url)` seguido de
    // `localRequire('minimatch')` carga el paquete instalado igual que
    // `require(...)`, pero el escáner textual no ve ni `from`, ni `require`
    // ni `import`: sin seguir el binding, una copia hoisted High/Critical se
    // volvería runtime-reachable sin drift del lockfile y el gate requerido
    // quedaría en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/loader.ts':
          "import { createRequire } from 'node:module'\n" +
          'const localRequire = createRequire(import.meta.url)\n' +
          "const mm = localRequire('minimatch')\n" +
          'export { mm }\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  // Alias directo de `require`, re-alias transitivo con llamada opcional,
  // import de createRequire con alias, la forma directa
  // `createRequire(...)('x')`, y alias de la FÁBRICA misma vía destructuring
  // o acceso a propiedad: todas cargan el módulo completo en runtime y
  // ninguna es visible para el escaneo textual. Un test por fuente: cada
  // invocación del gate compila el script completo y varias en un solo test
  // rebasan el timeout de Vitest.
  for (const [label, source] of [
    [
      'un alias directo de require',
      "const r = require\nconst mm = r('minimatch')\nexport { mm }\n",
    ],
    [
      'un re-alias transitivo con llamada opcional',
      "const r = require\nconst r2 = r\nconst mm = r2?.('minimatch')\nexport { mm }\n",
    ],
    [
      'un import de createRequire con alias',
      "import { createRequire as cr } from 'module'\nconst carga = cr(import.meta.url)\nexport const mm = carga('minimatch')\n",
    ],
    [
      'la forma directa createRequire(...)(...)',
      "import { createRequire } from 'node:module'\nexport const mm = createRequire(import.meta.url)('minimatch')\n",
    ],
    [
      'un destructuring de la fábrica createRequire',
      // La fábrica aliada por destructuring (`const { createRequire: cr } =
      // mod`) no pasa por el import nombrado: sin seguirla, `cr(...)` no se
      // reconoce como un require real y la carga queda invisible.
      "import * as mod from 'node:module'\nconst { createRequire: cr } = mod\nconst r = cr(import.meta.url)\nexport const mm = r('minimatch')\n",
    ],
    [
      'un alias de la fábrica createRequire por acceso a propiedad',
      "import * as mod from 'node:module'\nconst cr = mod.createRequire\nconst r = cr(import.meta.url)\nexport const mm = r('minimatch')\n",
    ],
    [
      'un alias bound de require',
      // `Function.prototype.bind` con ≤1 argumento solo liga `this`: el
      // resultado es el MISMO loader. Sin seguirlo, `r('minimatch')` carga
      // el paquete con el gate en verde.
      "const r = require.bind(module)\nconst mm = r('minimatch')\nexport { mm }\n",
    ],
    [
      'un bind parcial que pre-liga el specifier',
      // El specifier viaja como SEGUNDO argumento de `.bind`: el escáner
      // textual no ve comilla tras `require(` y el recorrido normal leería
      // el thisArg.
      "export const carga = require.bind(null, 'minimatch')\n",
    ],
    ['una invocación con call', "const mm = require.call(null, 'minimatch')\nexport { mm }\n"],
    ['una invocación con apply', "const mm = require.apply(null, ['minimatch'])\nexport { mm }\n"],
    [
      'module.require con una constante string local',
      // `module.require` es el loader estándar de CommonJS y carga igual que
      // `require`: con el specifier en una constante, ni el escáner textual
      // (no hay comilla tras `require(`) ni el parser lo clasificaban — la
      // copia hoisted quedaba runtime-reachable con el gate en verde.
      "const p = 'minimatch'\nexport const mm = module.require(p)\n",
    ],
    ['un alias de module.require', "const r = module.require\nexport const mm = r('minimatch')\n"],
  ] as const) {
    it(`bloquea un require de un paquete vigilado vía ${label}`, async () => {
      const result = await runGate({
        auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
        auditExitCode: 1,
        policy: rule('2099-01-01'),
        sourceFiles: { 'src/lib/alias.ts': source },
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('minimatch')
    })
  }

  // El specifier puede llegar por una constante string local en vez de un
  // literal: `specifierText` devuelve undefined y el escáner textual no ve
  // ninguna comilla tras `require(` — sin resolver el binding estático, Node
  // carga la copia hoisted vulnerable con el gate requerido en verde. Un
  // test por fuente (cada invocación del gate compila el script completo).
  for (const [label, source] of [
    [
      'require con una constante string local',
      "const packageName = 'minimatch'\nconst mm = require(packageName)\nexport { mm }\n",
    ],
    [
      'import dinámico con una constante re-aliased',
      "const nombre = 'minimatch'\nconst alias = nombre\nexport const carga = () => import(alias)\n",
    ],
  ] as const) {
    it(`bloquea un ${label} de un paquete vigilado`, async () => {
      const result = await runGate({
        auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
        auditExitCode: 1,
        policy: rule('2099-01-01'),
        sourceFiles: { 'src/lib/constante.ts': source },
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('minimatch')
    })
  }

  it('rechaza sin veredicto un argumento de loader no resoluble estáticamente', async () => {
    // `require(nombre)` donde `nombre` no es una constante string única del
    // archivo puede cargar CUALQUIER paquete: ni el parser ni el escáner
    // textual pueden acotarlo. El gate no puede pasar por un camino que no
    // entendió — sale con diagnóstico, nunca con un PASS (ni siquiera con un
    // audit limpio).
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/dinamico.ts':
          "const nombre = process.env.PAQUETE ?? 'x'\nconst mm = require(nombre)\nexport { mm }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('require(nombre)')
  })

  it('rechaza sin veredicto un require.call con specifier no resoluble', async () => {
    // `require.call(null, expr)` entrega el specifier fuera del primer
    // argumento; si no se puede acotar estáticamente puede cargar CUALQUIER
    // paquete y el gate no puede emitir un veredicto — rechaza, nunca pasa.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/indirecto.ts':
          "const mm = require.call(null, process.env.PAQUETE ?? 'x')\nexport { mm }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
  })

  it('rechaza sin veredicto un loader que escapa a una propiedad de objeto', async () => {
    // `const loaders = { load: require }; loaders.load('minimatch')` carga
    // la copia hoisted en runtime, pero no hay ni `require(` textual ni un
    // alias seguible: un loader que escapa del análisis estático puede
    // cargar CUALQUIER paquete — rechazo con diagnóstico, nunca un
    // veredicto.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/escape.ts':
          "const loaders = { load: require }\nexport const mm = loaders.load('minimatch')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('escapes')
  })

  it('no rechaza los usos seguros del loader (typeof, receptor, alias simple)', async () => {
    // `typeof require` solo observa existencia, un acceso de propiedad con
    // el loader como receptor (`require.resolve`) no carga módulos por sí
    // mismo, y `const r = require` es el alias simple que el fixpoint ya
    // sigue: ninguno es un escape que amerite rechazo.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/seguro.ts':
          "export const disponible = typeof require === 'function'\n" +
          'const localRequire = require\n' +
          "export const ruta = localRequire.resolve('node:path')\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('rechaza sin veredicto el require de createRequire guardado en una propiedad de objeto', async () => {
    // `const loaders = { load: createRequire(import.meta.url) };
    // loaders.load('minimatch')` carga la copia hoisted en runtime, pero el
    // identifier `createRequire` está en posición segura de callee y el alias
    // tracking solo sigue declaraciones simples: el require REAL que devuelve
    // la fábrica escapaba guardado en la propiedad y la llamada posterior
    // quedaba invisible con el gate requerido en verde. El VALOR producido
    // también debe consumirse donde el análisis lo siga — rechazo con
    // diagnóstico, nunca un veredicto.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/factory-result-escape.ts':
          "import { createRequire } from 'node:module'\n" +
          'const loaders = { load: createRequire(import.meta.url) }\n' +
          "export const mm = loaders.load('minimatch')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('escapes')
  })

  it('rechaza sin veredicto un bind puro del loader guardado en una propiedad de objeto', async () => {
    // `require.bind(module)` devuelve el MISMO loader: guardado en una
    // propiedad (`{ load: require.bind(module) }`) escapa igual que el
    // resultado de `createRequire(...)` — el receptor `require` está en
    // posición segura de acceso a propiedad, callSites no clasifica el bind
    // puro y la llamada posterior quedaba invisible con el gate en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/bind-escape.ts':
          'const loaders = { load: require.bind(module) }\n' +
          "export const mm = loaders.load('minimatch')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('escapes')
  })

  it('rechaza sin veredicto una fábrica createRequire asignada por destructuring de asignación', async () => {
    // `({ createRequire: cr } = require('node:module'))` alía la FÁBRICA por
    // un patrón de ASIGNACIÓN (no declaración): sin registrarlo, `cr(...)`
    // no se reconocía como un require real y `r('minimatch')` cargaba la
    // copia hoisted invisible para el escaneo con el gate requerido en
    // verde. El alias registrado cae en el paso de escapes (una
    // PropertyAssignment no es posición segura): rechazo con diagnóstico,
    // nunca un veredicto.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/factory-assign.js':
          'let cr\n' +
          ";({ createRequire: cr } = require('node:module'))\n" +
          'const r = cr(__filename)\n' +
          "const mm = r('minimatch')\n" +
          'module.exports = { mm }\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('escapes')
  })

  it('rechaza sin veredicto un module.require con specifier no resoluble', async () => {
    // `module.require(expr)` es el loader estándar de CommonJS: un specifier
    // que no se puede acotar estáticamente puede cargar CUALQUIER paquete —
    // mismo contrato fail-closed que `require(expr)`, nunca un veredicto.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/module-require.ts':
          "const mm = module.require(process.env.PAQUETE ?? 'x')\nexport { mm }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('module.require')
  })

  it('bloquea un import de un paquete vigilado en el App Router raíz app/', async () => {
    // Next.js sirve `app/` en la raíz del proyecto cuando no existe `src/`:
    // un `app/page.ts` que importa el paquete vulnerable es tan
    // runtime-reachable como uno bajo `src/`, pero un scan limitado a
    // `src/`+`convex/` devolvería `{}` con el gate requerido en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'app/page.ts': "import { minimatch } from 'minimatch'\nexport const cargado = minimatch\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no rechaza un import dinámico relativo interpolado con tail de datos', async () => {
    // El patrón i18n real (`import(\`./messages/${locale}.json\`)`) solo
    // puede resolver a archivos JSON, que no importan paquetes: es el único
    // template relativo no resoluble que queda exento del rechazo.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/i18n.ts': 'export const carga = (l: string) => import(`./messages/${l}.json`)\n',
      },
    })

    expect(result.status).toBe(0)
  })

  it('no rechaza un import interpolado vía el path alias @/ con tail de datos', async () => {
    // `import(\`@/messages/${locale}.json\`)` (el patrón i18n real vía el
    // path alias de tsconfig) nunca puede nombrar un paquete npm (un scope
    // vacío no es válido): cuenta como relativo y su tail JSON lo exime.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/i18n-alias.ts':
          'export const carga = (l: string) => import(`@/messages/${l}.json`)\n',
      },
    })

    expect(result.status).toBe(0)
  })

  it('rechaza sin veredicto un import interpolado vía @/ hacia módulos de runtime', async () => {
    // Sin tail de datos, `import(\`@/lib/${name}\`)` puede resolver a un
    // helper local que importe un paquete vigilado: mismo rechazo que un
    // template relativo hacia fuentes de runtime.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/entry.ts': 'export const carga = (name: string) => import(`@/lib/${name}`)\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
  })

  it('rechaza sin veredicto un import interpolado vía un alias comodín configurado', async () => {
    // Con `~m/*` -> `./modules/*` en el tsconfig del source root,
    // `import(\`~m/${name}\`)` es una carga LOCAL: dejarla caer a la rama de
    // paquete bare registraba el paquete ficticio `~m` y seguía en verde,
    // mientras el contexto de Webpack puede cargar un helper bajo `modules/`
    // que importe un paquete vigilado — invisible para el gate requerido.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { '~m/*': ['./modules/*'] } },
        }),
        'src/entry.ts': 'export const carga = (name: string) => import(`~m/${name}`)\n',
        'modules/runtime-helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
  })

  it('no rechaza un import interpolado vía alias configurado con tail de datos', async () => {
    // Igual que el patrón i18n relativo o vía `@/`: un template por alias
    // configurado cuyo tail fija una extensión que no es fuente de runtime
    // (`~m/messages/${l}.json`) solo puede resolver a datos y queda exento.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { '~m/*': ['./modules/*'] } },
        }),
        'src/lib/i18n-alias-config.ts':
          'export const carga = (l: string) => import(`~m/messages/${l}.json`)\n',
      },
    })

    expect(result.status).toBe(0)
  })

  it('rechaza sin veredicto un template bare que compone el nombre a través de la interpolación', async () => {
    // `require(\`mini${sufijo}\`)` puede COMPONER el nombre de un paquete
    // vigilado (`minimatch`): el escáner textual exige el nombre completo
    // antes de la primera interpolación, así que el hit quedaría invisible
    // con el gate requerido en verde. Un head estático que no fija el nombre
    // completo del paquete puede nombrar CUALQUIERA — rechazo, nunca
    // veredicto (ni siquiera con un audit limpio).
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/lib/compuesto.ts':
          "const sufijo = process.env.SUFIJO ?? 'x'\n" +
          'const mm = require(`mini${sufijo}`)\n' +
          'export { mm }\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
  })

  it('bloquea un template bare cuyo head fija el paquete vigilado completo', async () => {
    // Cuando el head estático ya contiene el nombre COMPLETO del paquete
    // terminado en `/` (`import(\`minimatch/${sub}\`)`), la identidad del
    // paquete es estática aunque el subpath varíe: se registra un hit `*`
    // sobre el paquete en vez de exentar la carga.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/subpath.ts': 'export const carga = (sub: string) => import(`minimatch/${sub}`)\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('rechaza sin veredicto un import relativo interpolado hacia módulos de runtime', async () => {
    // `import(\`../runtime/${name}.ts\`)` puede resolver a un helper local
    // fuera de los roots que importe un paquete vigilado, y la travesía de
    // módulos locales solo sigue specifiers estáticos: exentarlo dejaba el
    // paquete runtime-reachable sin tocar el lockfile con el gate requerido
    // en verde. Sin resolución estática, la carga no se puede acotar — el
    // gate rechaza con diagnóstico, nunca con un veredicto.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/entry.ts': 'export const carga = (name: string) => import(`../runtime/${name}.ts`)\n',
        'runtime/vulnerable.ts': "import { minimatch } from 'minimatch'\nexport { minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('../runtime/')
  })

  it('bloquea un import relativo interpolado que resuelve estáticamente a un helper vulnerable', async () => {
    // Si TODAS las interpolaciones son constantes string resolubles, el
    // specifier se compone y la travesía de módulos locales sigue la arista:
    // el import vigilado dentro del helper registra el hit en vez de caer al
    // rechazo genérico.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/entry.ts':
          "const nombre = 'vulnerable'\nexport const carga = () => import(`../runtime/${nombre}.ts`)\n",
        'runtime/vulnerable.ts': "import { minimatch } from 'minimatch'\nexport { minimatch }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no bloquea por una función local ajena que recibe el nombre del paquete', async () => {
    // Un callable local que NO es alias de require (`cargar('minimatch')`)
    // no carga el módulo: registrarlo rompería políticas revisadas sin
    // cambio real de reachability.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/cargador.ts':
          "const cargar = (nombre: string) => nombre\nconst mm = cargar('minimatch')\nexport { mm }\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('bloquea un import dinámico con template literal estático', async () => {
    // `import(\`minimatch\`)` carga el paquete igual que con comillas:
    // aceptar solo comillas simples/dobles lo dejaría invisible al escaneo.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/lazy.ts': 'export const carga = () => import(`minimatch`)\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('no deja invisible un import tras un template anidado en una interpolación', async () => {
    // En `const s = \`${\`/*\`}\`` el backtick del template ANIDADO no cierra
    // el exterior: tratarlo como cierre convertiría el `/*` interno en
    // apertura de comentario de bloque y blanquearía el resto del archivo,
    // ocultando un import real de runtime — falso negativo del gate.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/anidado.ts':
          'const s = `${`/*`}`\n' +
          "import { minimatch } from 'minimatch'\n" +
          'export { s, minimatch }\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea un import de runtime en instrumentation-client.ts', async () => {
    // Next.js carga `instrumentation-client.ts` de la raíz antes de que el
    // frontend sea interactivo: es un entrypoint de runtime del cliente,
    // igual que los sentry.*.config.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'instrumentation-client.ts': "import { minimatch } from 'minimatch'\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea un import de runtime en un entrypoint de la raíz de la app', async () => {
    // sentry.server.config.ts vive fuera de src/ pero `src/instrumentation.ts`
    // lo carga con `await import(...)` en producción: un import ahí es tan
    // runtime como uno en src/.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'sentry.server.config.ts': "import { minimatch } from 'minimatch'\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea un import de runtime en mdx-components.tsx de la raíz', async () => {
    // Con `@next/mdx` habilitado, Next usa el `mdx-components.tsx` de la
    // raíz como registro runtime de componentes del App Router: un import
    // ahí es alcanzable en runtime sin drift del lockfile, así que el gate
    // debe verlo aunque hoy la app no use MDX.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'mdx-components.tsx': "import { minimatch } from 'minimatch'\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea un import vigilado en un helper local fuera de las raíces del escaneo', async () => {
    // `src/entry.ts -> ../runtime-helper.ts -> minimatch`: el helper queda
    // fuera de src/, convex/ y el allowlist de entrypoints de raíz, pero el
    // bundler lo empaqueta en el runtime igualmente. Sin seguir la arista
    // relativa, el import vigilado dentro del helper queda invisible y el
    // gate en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/entry.ts': "import { helper } from '../runtime-helper'\nexport { helper }\n",
        'runtime-helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea un import vigilado alcanzado vía el path alias @/ fuera de las raíces', async () => {
    // `src/x.ts -> @/../runtime-helper.ts -> minimatch`: el alias de
    // tsconfig (`@/*` -> `./src/*`) resuelve al mismo helper que un import
    // relativo y el bundler lo empaqueta igual, pero la travesía solo
    // seguía specifiers con punto — la arista quedaba invisible y el import
    // vigilado dentro del helper dejaba el gate requerido en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/x.ts': "import { helper } from '@/../runtime-helper.ts'\nexport { helper }\n",
        'runtime-helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('resuelve los alias comodín configurados en el tsconfig del source root', async () => {
    // La convención `@/* -> ./src/*` es solo el fallback: cuando el
    // tsconfig del source root define sus propios mapeos comodín en
    // `compilerOptions.paths`, la travesía debe resolverlos tal cual.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { '~m/*': ['./modules/*'] } },
        }),
        'src/x.ts': "import { helper } from '~m/runtime-helper'\nexport { helper }\n",
        'modules/runtime-helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('resuelve los alias exactos configurados en el tsconfig del source root', async () => {
    // Un mapeo exacto ("runtime-helper": ["./runtime-helper.ts"]) también es
    // una arista local: exigir el comodín `/*` lo ignoraba y el helper fuera
    // de las raíces quedaba sin travesía — su import vigilado invisible con
    // el gate requerido en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { 'runtime-helper': ['./runtime-helper.ts'] } },
        }),
        'src/x.ts': "import { helper } from 'runtime-helper'\nexport { helper }\n",
        'runtime-helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea un import vigilado alcanzado vía un mapeo `imports` de package.json', async () => {
    // Con `{"imports": {"#glob": "minimatch"}}` en package.json, Node
    // resuelve `import '#glob'` ejecutando minimatch — sin tocar versiones
    // ni aristas del lockfile. El escaneo solo cargaba alias de tsconfig,
    // así que `#glob` ni se recorría ni matcheaba el nombre vigilado: la
    // copia hoisted vulnerable quedaba runtime-reachable con el gate en
    // verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'package.json': JSON.stringify({ imports: { '#glob': 'minimatch' } }),
        'src/x.ts': "import { minimatch } from '#glob'\nexport const ok = minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('recorre un target local de un mapeo `imports` comodín de package.json', async () => {
    // `#helpers/*` -> `./helpers/*` empaqueta el helper en el runtime igual
    // que un import relativo: sin seguir el mapeo, el import vigilado dentro
    // del helper quedaba invisible con el gate en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'package.json': JSON.stringify({ imports: { '#helpers/*': './helpers/*' } }),
        'src/x.ts': "import { helper } from '#helpers/runtime-helper'\nexport { helper }\n",
        'helpers/runtime-helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('rechaza sin veredicto un specifier `#` sin mapeo `imports` acotable', async () => {
    // Un specifier `#` que ningún mapeo de package.json acota puede cargar
    // cualquier cosa según el entorno de resolución: el gate no puede emitir
    // un veredicto sobre una carga que no entendió — rechazo con
    // diagnóstico, nunca un pase (ni siquiera con un audit limpio).
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/x.ts': "import '#unmapped'\nexport const cargado = true\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('#unmapped')
  })

  it('bloquea un import vigilado en un helper bajo un directorio excluido del walk', async () => {
    // Las exclusiones de directorio (`__tests__`, `_generated`, `.next`)
    // aplican solo al descubrimiento inicial: en `src/x.ts ->
    // ./__tests__/helper.ts -> minimatch` el bundler empaqueta el helper en
    // el runtime igualmente. Descartar la arista explícita dejaba el import
    // vigilado invisible con el gate requerido en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/x.ts': "import { helper } from './__tests__/helper'\nexport { helper }\n",
        'src/__tests__/helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('rechaza sin veredicto un import relativo que resuelve dentro de node_modules', async () => {
    // Un path relativo hacia dentro de un paquete instalado esconde la
    // identidad del paquete en el path: los hits se atribuyen por specifier
    // de paquete, así que la carga no se puede atribuir a un paquete vigilado
    // — rechazo con diagnóstico, nunca un veredicto (ni siquiera con un
    // audit limpio).
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/entry.ts':
          "import '../node_modules/minimatch/index.js'\nexport const cargado = true\n",
        'node_modules/minimatch/index.js': 'module.exports = () => true\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
    expect(result.stderr).toContain('node_modules')
  })

  it('bloquea cuando runtime importa un ancestro revisado del paquete', async () => {
    // Importar eslint (consumidor revisado de minimatch) no cambia bun.lock
    // ni el cierre pinneado, pero vuelve runtime el camino build-only hacia
    // minimatch. Solo los imports listados en `runtimeImports` quedan
    // justificados.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/lint.ts': "import { Linter } from 'eslint'\nexport { Linter }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('permite un import de ancestro que el triaje listó en runtimeImports', async () => {
    // El pin lleva los nombres EXPORTADOS: un alias local distinto
    // (`Linter as L`) sigue alcanzando el mismo binding revisado.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        eslint: ['src/lib/lint.ts -> eslint [Linter]'],
      }),
      sourceFiles: {
        'src/lib/lint.ts': "import { Linter as L } from 'eslint'\nexport { L }\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('bloquea un subpath o sitio de import nuevo de un ancestro ya revisado', async () => {
    // El triaje revisó `src/lib/lint.ts -> eslint [Linter]`; un subpath
    // distinto del mismo ancestro (o el mismo specifier desde un archivo
    // nuevo) puede exponer el camino transitivo vulnerable. Pinnear solo el
    // nombre lo dejaría pasar; el pin es hit por hit
    // ("archivo -> specifier [bindings]").
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        eslint: ['src/lib/lint.ts -> eslint [Linter]'],
      }),
      sourceFiles: {
        'src/lib/lint.ts': "import { Linter } from 'eslint'\nexport { Linter }\n",
        'src/lib/risky.ts': "import { builtinRules } from 'eslint/use-at-your-own-risk'\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('bloquea cuando un sitio aprobado empieza a importar un binding nuevo del mismo specifier', async () => {
    // El archivo y el specifier no cambian, pero el import gana un binding
    // que el triaje no revisó (p.ej. sumar el build-only `withSentryConfig`
    // al `captureException` aprobado): el hit "archivo -> specifier" solo
    // sería byte-idéntico y el camino build-only se volvería runtime sin
    // drift. Los bindings son parte de la identidad del hit.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        eslint: ['src/lib/lint.ts -> eslint [Linter]'],
      }),
      sourceFiles: {
        'src/lib/lint.ts': "import { Linter, RuleTester } from 'eslint'\nexport { Linter }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('pinnea las propiedades accedidas sobre un namespace import', async () => {
    // `import * as lint` no colapsa a `*` de entrada: se pinnean las
    // propiedades accedidas (`lint.Linter` → `Linter`), así que el sitio
    // aprobado que empieza a usar OTRA API del mismo namespace (el caso
    // `Sentry.withSentryConfig` en instrumentation.ts) sí drift-ea.
    const allowed = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        eslint: ['src/lib/lint.ts -> eslint [Linter]'],
      }),
      sourceFiles: {
        'src/lib/lint.ts': "import * as lint from 'eslint'\nexport const l = lint.Linter\n",
      },
    })
    expect(allowed.status).toBe(0)

    const drifted = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        eslint: ['src/lib/lint.ts -> eslint [Linter]'],
      }),
      sourceFiles: {
        'src/lib/lint.ts':
          "import * as lint from 'eslint'\nexport const l = lint.Linter\nexport const r = lint.RuleTester\n",
      },
    })
    expect(drifted.status).not.toBe(0)
    expect(drifted.stderr).toContain('minimatch')
  })

  // Un namespace re-exportado entero (`export { lint }`) y `require(...)`
  // entregan el objeto módulo completo a usos que el análisis no sigue:
  // ningún listado de nombres acota qué API se usa después, así que un pin
  // de bindings concretos no los cubre — solo `[*]` (triaje que aceptó
  // acceso total) los deja pasar. Un test por fuente: cada invocación del
  // gate compila el script completo y dos pares en un solo test rebasan el
  // timeout de Vitest.
  for (const [label, source] of [
    ['el namespace que escapa', "import * as lint from 'eslint'\nexport { lint }\n"],
    ['el require', "const lint = require('eslint')\nexport { lint }\n"],
  ] as const) {
    it(`pinnea como módulo completo (*) ${label}`, async () => {
      const blocked = await runGate({
        auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
        auditExitCode: 1,
        policy: rule('2099-01-01', undefined, undefined, undefined, {
          eslint: ['src/lib/lint.ts -> eslint [Linter]'],
        }),
        sourceFiles: { 'src/lib/lint.ts': source },
      })
      expect(blocked.status).not.toBe(0)
      expect(blocked.stderr).toContain('minimatch')

      const allowed = await runGate({
        auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
        auditExitCode: 1,
        policy: rule('2099-01-01', undefined, undefined, undefined, {
          eslint: ['src/lib/lint.ts -> eslint [*]'],
        }),
        sourceFiles: { 'src/lib/lint.ts': source },
      })
      expect(allowed.status).toBe(0)
    })
  }

  it('pinnea la API accedida en el callback then de un import dinámico', async () => {
    // El patrón de los error boundaries: `import('@sentry/nextjs')
    // .then((Sentry) => Sentry.captureException(...))`. Colapsarlo a `[*]`
    // pre-aprueba TODA la superficie del módulo: cambiar el callback a un
    // export build-only (`withSentryConfig`) no produciría drift. El
    // parámetro del callback se sigue como un namespace import: la API
    // revisada pasa contra su pin exacto, y una API distinta bloquea.
    const policyPin = rule('2099-01-01', undefined, undefined, undefined, {
      eslint: ['src/lib/lazy.ts -> eslint [Linter]'],
    })
    const allowed = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: policyPin,
      sourceFiles: {
        'src/lib/lazy.ts': "void import('eslint').then((lint) => {\n  lint.Linter\n})\n",
      },
    })
    expect(allowed.status).toBe(0)

    const drifted = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: policyPin,
      sourceFiles: {
        'src/lib/lazy.ts': "void import('eslint').then((lint) => {\n  lint.RuleTester\n})\n",
      },
    })
    expect(drifted.status).not.toBe(0)
    expect(drifted.stderr).toContain('minimatch')
  })

  it('degrada a * cuando el módulo escapa del callback del import dinámico', async () => {
    // Si el callback entrega el objeto módulo entero a un uso que el
    // análisis no sigue, ningún listado de nombres acota qué API se usa
    // después: el hit debe seguir siendo `[*]`, no un pin vacío que la
    // política aceptaría sin triaje de acceso total.
    const source =
      'const registrar = (mod: unknown) => mod\n' +
      "void import('eslint').then((lint) => registrar(lint))\n"
    const blocked = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        eslint: ['src/lib/lazy.ts -> eslint [Linter]'],
      }),
      sourceFiles: { 'src/lib/lazy.ts': source },
    })
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('minimatch')

    const allowed = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        eslint: ['src/lib/lazy.ts -> eslint [*]'],
      }),
      sourceFiles: { 'src/lib/lazy.ts': source },
    })
    expect(allowed.status).toBe(0)
  })

  it('no registra hit para un import de valor usado solo en posiciones de tipo', async () => {
    // Sin `verbatimModuleSyntax` el compilador elide la declaración completa
    // cuando TODOS sus bindings se usan únicamente como tipos: el módulo
    // nunca se carga en runtime, igual que un `import type` explícito, así
    // que no hay reachability que pinnear.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/lint.ts':
          "import { MinimatchOptions } from 'minimatch'\nexport const defaults: MinimatchOptions | null = null\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('no registra hit para una expresión de tipo import(...) borrada en compilación', async () => {
    // `export type Opciones = import('minimatch').MinimatchOptions` (y
    // `typeof import('minimatch')`) son ImportTypeNode: el compilador las
    // borra por completo — el emit es `export {};` — y el módulo nunca se
    // carga, pero el patrón textual `import(` las leería como un import
    // dinámico y registraría `minimatch [*]`: una anotación legítima
    // rompería el gate requerido en falso.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/tipos.ts':
          "export type Opciones = import('minimatch').MinimatchOptions\n" +
          "export type Modulo = typeof import('minimatch')\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('sigue contando el import cuando algún binding tiene un uso de valor', async () => {
    // Basta UNA referencia de valor (o un binding sin referencias: la
    // elisión del import no usado depende del transpiler — fail closed)
    // para conservar la declaración y exigir el pin.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/lint.ts':
          "import { minimatch, MinimatchOptions } from 'minimatch'\nconst opts: MinimatchOptions = {}\nexport const ok = minimatch('a', 'a', opts)\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('pinnea solo los bindings emitidos en un import mixto valor + tipo', async () => {
    // En `import { minimatch, MinimatchOptions } from 'minimatch'` con
    // `MinimatchOptions` usado solo como tipo, el compilador emite
    // únicamente `minimatch`: el binding type-only se elide del clause.
    // Pinnearlo convertiría un tipo ordinario en falsa "API de runtime" y
    // agregar o quitar un type-only rompería el gate requerido en falso.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        minimatch: ['src/lib/lint.ts -> minimatch [minimatch]'],
      }),
      sourceFiles: {
        'src/lib/lint.ts':
          "import { minimatch, MinimatchOptions } from 'minimatch'\nconst opts: MinimatchOptions = {}\nexport const ok = minimatch('a', 'a', opts)\n",
      },
    })

    expect(result.status).toBe(0)
  })

  it('sigue pinneando un binding mixto sin referencias (fail closed)', async () => {
    // Un binding sin NINGUNA referencia no se borra del pin: la elisión del
    // import no usado depende del transpiler, así que sigue contando como
    // API emitida y un pin que lo omite exige re-triaje.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        minimatch: ['src/lib/lint.ts -> minimatch [minimatch]'],
      }),
      sourceFiles: {
        'src/lib/lint.ts':
          "import { minimatch, MinimatchOptions } from 'minimatch'\nexport const ok = minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('falla cuando la política pinnea hits de import sin bindings (forma sin corchetes)', async () => {
    // La forma intermedia "archivo -> specifier" colapsa QUÉ API usa el
    // archivo: un sitio aprobado podría empezar a importar un binding
    // build-only nuevo sin drift. Política malformada no emite veredicto.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01', undefined, undefined, undefined, {
        eslint: ['src/lib/lint.ts -> eslint'],
      }),
      sourceFiles: {
        'src/lib/lint.ts': "import { Linter } from 'eslint'\nexport { Linter }\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed "runtimeImports"')
  })

  it('bloquea cuando la versión de una copia pinneada cambió sin re-triaje', async () => {
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule(
        '2099-01-01',
        { [HIGH_ADVISORY.url]: HIGH_ADVISORY.vulnerable_versions },
        { minimatch: '9.0.2' }
      ),
    })

    expect(result.status).not.toBe(0)
  })

  it('bloquea el mismo high cuando la regla ya venció', async () => {
    // Una regla caducada seguía permitiendo para siempre: el triaje no expiraba
    // nunca y `reviewBy` era decorativo.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2020-01-01'),
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('2020-01-01')
  })

  it('bloquea cuando reviewBy no es una fecha ISO', async () => {
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('pendiente'),
    })

    expect(result.status).not.toBe(0)
  })

  it('bloquea cuando reviewBy tiene forma ISO pero no es una fecha real', async () => {
    // "2026-99-99" pasa el regex y compara lexicográficamente como futuro;
    // una fecha que no existe en el calendario no es un triaje vigente.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2026-99-99'),
    })

    expect(result.status).not.toBe(0)
  })

  it('bloquea una carga vía module.require destructurado y re-ligado', async () => {
    // `const { require: moduleRequire } = module` alía el LOADER mismo: el
    // reconocimiento de destructuring solo registraba `createRequire`, así
    // que `moduleRequire.bind(module)` no contaba como bind puro del loader
    // y `r('minimatch')` cargaba la copia hoisted con el gate requerido en
    // verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/lib/destructurado.js':
          'const { require: moduleRequire } = module\n' +
          'const r = moduleRequire.bind(module)\n' +
          "const mm = r('minimatch')\n" +
          'module.exports = { mm }\n',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('sigue los alias de paths heredados vía extends del tsconfig', async () => {
    // Un `tsconfig.json` que solo hace `extends` no trae `compilerOptions`
    // propias: leer el JSON crudo del hijo ignoraba el `baseUrl`/`paths`
    // heredados (`~/*` -> `runtime/*`) y la arista local vía alias quedaba
    // sin travesía — el import vigilado del helper invisible con el gate
    // requerido en verde.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
        'tsconfig.base.json': JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '~/*': ['runtime/*'] } },
        }),
        'src/x.ts': "import { helper } from '~/runtime-helper'\nexport { helper }\n",
        'runtime/runtime-helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('recorre el directorio de un require.context con argumento estático', async () => {
    // `require.context('../runtime', true, /\.ts$/)` incluye en el bundle
    // TODOS los módulos del directorio: el paso de escapes trataba el acceso
    // a propiedad sobre `require` como seguro y callSites ignoraba
    // `.context`, así que el helper del contexto — y su import vigilado —
    // quedaban invisibles con el gate requerido en verde. Con directorio
    // estático, la travesía escanea el directorio completo.
    const result = await runGate({
      auditStdout: JSON.stringify({ minimatch: [HIGH_ADVISORY] }),
      auditExitCode: 1,
      policy: rule('2099-01-01'),
      sourceFiles: {
        'src/x.ts': "export const ctx = require.context('../runtime', true, /\\.ts$/)\n",
        'runtime/helper.ts':
          "import { minimatch } from 'minimatch'\nexport const helper = () => minimatch('a', 'a')\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('minimatch')
  })

  it('rechaza sin veredicto un require.context con directorio no resoluble', async () => {
    // Un primer argumento que no es una constante local resoluble puede
    // registrar un contexto sobre CUALQUIER directorio: el gate no puede
    // acotar qué carga — rechazo con diagnóstico, nunca un veredicto (ni
    // siquiera con un audit limpio).
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/x.ts': "export const ctx = require.context(process.env.CONTEXT_DIR ?? '.', true)\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
  })

  it('rechaza sin veredicto un require.context sin invocar que escapa como fábrica', async () => {
    // `const crearContexto = require.context` alía la FÁBRICA de contextos:
    // el contexto que cree después (`crearContexto('../runtime')`) queda
    // fuera del paso de callSites — el acceso `.context` solo es seguro
    // invocado inmediatamente.
    const result = await runGate({
      auditStdout: JSON.stringify({}),
      auditExitCode: 0,
      sourceFiles: {
        'src/x.ts':
          'const crearContexto = require.context\n' +
          "export const ctx = crearContexto('../runtime', true)\n",
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Reachability gate could not run')
  })
})

describe('reachability gate — CLI entrypoint', () => {
  it('sale 0 cuando el árbol no tiene avisos', () => {
    const result = runGateCli({ auditStdout: '{}', auditExitCode: 0 })

    expect(result.status).toBe(0)
  })

  it('sale distinto de 0 cuando el audit no es un reporte', () => {
    const result = runGateCli({
      auditStdout: JSON.stringify({
        error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' },
      }),
      auditExitCode: 1,
    })

    expect(result.status).not.toBe(0)
  })
})
