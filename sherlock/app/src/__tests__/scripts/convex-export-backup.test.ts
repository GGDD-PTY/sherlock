import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'scripts/convex-export-backup.sh')

// ZIP "stored" válido de 168 bytes con un único miembro (`payload` = "data").
//
// Antes el happy path construía este archivo llamando al binario `zip` desde el
// bunx falso. `zip` NO está instalado en los runners Ubuntu de CI (Depot),
// así que la acción de export fallaba, el script no encontraba el archivo y el
// test veía exit 1 en vez de 0 — rojo determinista en CI, verde en macOS, que
// sí trae el binario. Un test unitario no puede depender de un binario opcional
// del sistema: el fixture viaja embebido.
//
// `unzip` sí existe en esos runners y el script lo sigue exigiendo de verdad —
// lo prueba el caso "corrupt backup zip", que pasa en CI y sólo puede pasar si
// `unzip -tqq` corrió y reportó corrupción.
const VALID_ZIP_BASE64 =
  'UEsDBAoAAAAAAC0TEF1j8/OtBAAAAAQAAAAHABwAcGF5bG9hZFVUCQAD5WWBauVlgWp1eAsAAQT1AQAABBQAAABkYXRhUEsBAh4DCgAAAAAALRMQXWPz860EAAAABAAAAAcAGAAAAAAAAQAAAKSBAAAAAHBheWxvYWRVVAUAA+VlgWp1eAsAAQT1AQAABBQAAABQSwUGAAAAAAEAAQBNAAAARQAAAAAA'

describe('convex-export-backup', () => {
  let tempDir: string | undefined

  function runBackup(exportAction: string) {
    tempDir = mkdtempSync(join(tmpdir(), 'sherlock-convex-backup-'))
    const binDir = join(tempDir, 'bin')
    mkdirSync(binDir)
    const fixtureZip = join(tempDir, 'fixture.zip')
    writeFileSync(fixtureZip, Buffer.from(VALID_ZIP_BASE64, 'base64'))
    const fakeBunx = join(binDir, 'bunx')
    writeFileSync(
      fakeBunx,
      [
        '#!/usr/bin/env bash',
        'while (( $# )); do',
        '  if [[ "$1" == "--path" ]]; then',
        `    ${exportAction}`,
        '    exit 0',
        '  fi',
        '  shift',
        'done',
        'exit 1',
        '',
      ].join('\n')
    )
    chmodSync(fakeBunx, 0o755)

    return spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKUP_DIR: join(tempDir, 'backups'),
        BACKUP_RETENTION: '0',
        CONVEX_DEPLOYMENT: 'prod:test',
        CONVEX_DEPLOY_KEY: 'test-deploy-key',
        FIXTURE_ZIP: fixtureZip,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      },
    })
  }

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('fails when Convex reports success without creating the backup archive', () => {
    // Given
    const exportAction = 'true'

    // When
    const result = runBackup(exportAction)

    // Then
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('backup zip is missing')
  })

  it('fails when Convex creates an empty backup archive', () => {
    // Given
    const exportAction = ': > "$2"'

    // When
    const result = runBackup(exportAction)

    // Then
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('backup zip is empty')
  })

  it('fails when Convex creates a corrupt backup archive', () => {
    // Given
    const exportAction = 'printf "PKfake" > "$2"'

    // When
    const result = runBackup(exportAction)

    // Then
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('corrupt backup zip')
  })

  it('completes when Convex creates a valid backup archive', () => {
    // Given
    const exportAction = 'cp "$FIXTURE_ZIP" "$2"'

    // When
    const result = runBackup(exportAction)

    // Then
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Backup complete')
  })
})
