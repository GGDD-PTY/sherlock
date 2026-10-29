#!/usr/bin/env bash
# ============================================================================
# CONVEX RESTORE (DESTRUCTIVE)
# ============================================================================
# Restores a Convex deployment from a snapshot .zip produced by
# convex-export-backup.sh. Uses `convex import --replace-all`, which makes the
# target deployment EXACTLY match the snapshot — deleting tables/documents that
# are not present in it. Use only for disaster recovery / rollback.
#
# Usage:
#   cd sherlock/app
#   CONVEX_DEPLOY_KEY=... CONVEX_DEPLOYMENT=... CONFIRM_RESTORE=yes \
#     ./scripts/convex-restore-backup.sh ./backups/convex/convex-export-YYYYMMDD_HHMMSS.zip
#
# Any extra args after the snapshot are forwarded to `convex import`
# (e.g. --prod, or --deployment <name> to target a specific deployment).
# ============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SNAPSHOT="${1:-}"
if [[ -n "$SNAPSHOT" ]]; then
  shift
fi

usage() {
  echo "usage: CONFIRM_RESTORE=yes $0 <snapshot.zip> [extra convex import flags]" >&2
}

if [[ -z "$SNAPSHOT" ]]; then
  echo "error: snapshot path is required" >&2
  usage
  exit 1
fi

if [[ ! -f "$SNAPSHOT" ]]; then
  echo "error: snapshot file not found: $SNAPSHOT" >&2
  exit 1
fi

case "$SNAPSHOT" in
  *.zip) ;;
  *)
    echo "error: expected a .zip snapshot from convex-export-backup.sh, got: $SNAPSHOT" >&2
    exit 1
    ;;
esac

if [[ -z "${CONVEX_DEPLOY_KEY:-}" ]]; then
  echo "error: CONVEX_DEPLOY_KEY is required" >&2
  exit 1
fi

# Destructive guard: --replace-all deletes data that is absent from the snapshot.
if [[ "${CONFIRM_RESTORE:-}" != "yes" ]]; then
  echo "REFUSING TO RUN: this performs a DESTRUCTIVE --replace-all restore." >&2
  echo "It will overwrite the target Convex deployment to match: $SNAPSHOT" >&2
  echo "Re-run with CONFIRM_RESTORE=yes to proceed. Command that would run:" >&2
  echo "  bunx convex import --replace-all --yes \"$SNAPSHOT\" $*" >&2
  exit 1
fi

echo "Restoring Convex deployment from ${SNAPSHOT} (--replace-all)..."
bunx convex import --replace-all --yes "$SNAPSHOT" "$@"
echo "Restore complete from: ${SNAPSHOT}"
