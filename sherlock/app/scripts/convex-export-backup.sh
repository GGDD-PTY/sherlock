#!/usr/bin/env bash
# ============================================================================
# CONVEX EXPORT BACKUP
# ============================================================================
# Exports the Convex deployment to a timestamped zip under backups/convex/.
# Requires CONVEX_DEPLOYMENT and CONVEX_DEPLOY_KEY in the environment.
#
# Usage:
#   cd sherlock/app
#   CONVEX_DEPLOY_KEY=... CONVEX_DEPLOYMENT=... ./scripts/convex-export-backup.sh
# ============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-./backups/convex}"
RETENTION="${BACKUP_RETENTION:-10}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUTPUT="$BACKUP_DIR/convex-export-${TIMESTAMP}.zip"

if [[ -z "${CONVEX_DEPLOYMENT:-}" ]]; then
  echo "error: CONVEX_DEPLOYMENT is required" >&2
  exit 1
fi

if [[ -z "${CONVEX_DEPLOY_KEY:-}" ]]; then
  echo "error: CONVEX_DEPLOY_KEY is required" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# --include-file-storage NO es opcional: `convex export` sin ese flag exporta
# solo las tablas, así que un restore dejaba el VDR con filas de `documents`
# apuntando a blobs que ya no existen. Con el flag, los archivos viajan en la
# carpeta `_storage` del ZIP y `convex import --replace-all` los repone.
echo "Exporting Convex deployment (tablas + file storage) to ${OUTPUT}..."
bunx convex export --include-file-storage --path "$OUTPUT"

if [[ ! -f "$OUTPUT" ]]; then
  echo "error: export reported success but backup zip is missing: ${OUTPUT}" >&2
  exit 1
fi

if [[ ! -s "$OUTPUT" ]]; then
  echo "error: export reported success but backup zip is empty: ${OUTPUT}" >&2
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "error: unzip is required to verify the backup archive integrity" >&2
  exit 1
fi

if ! unzip -tqq "$OUTPUT" >/dev/null 2>&1; then
  echo "error: export produced a corrupt backup zip (failed integrity check): ${OUTPUT}" >&2
  exit 1
fi

echo "Backup complete: ${OUTPUT}"

if [[ "$RETENTION" =~ ^[0-9]+$ ]] && (( RETENTION > 0 )); then
  ls -t "$BACKUP_DIR"/convex-export-*.zip 2>/dev/null | tail -n +$((RETENTION + 1)) | while read -r old; do
    rm -f "$old"
    echo "Removed old backup: ${old}"
  done
fi
