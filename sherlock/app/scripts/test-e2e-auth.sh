#!/bin/bash
# ============================================================================
# TEST E2E WITH AUTH (No Bypass)
# ============================================================================
# Este script corre los tests E2E con autenticación real (WorkOS AuthKit).
# Temporalmente desactiva BYPASS_AUTH para que los tests de protección funcionen.
#
# PREREQUISITO: Detener el servidor de desarrollo antes de correr este script.
#   Ctrl+C en la terminal donde corre `bun run dev`
#
# Uso:
#   ./scripts/test-e2e-auth.sh           # Corre todos los E2E tests
#   ./scripts/test-e2e-auth.sh --headed  # Con browser visible
#   ./scripts/test-e2e-auth.sh intake-temporary-journey.spec.ts  # Solo un archivo vivo
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$APP_DIR/.env.local"
BACKUP_FILE="$APP_DIR/.env.local.backup"

echo "🔒 Preparando ambiente para E2E tests con auth..."

# ===== CHECK IF DEV SERVER IS RUNNING =====
if lsof -i :3000 > /dev/null 2>&1; then
  echo ""
  echo "⚠️  ADVERTENCIA: Hay un proceso en el puerto 3000."
  echo "   Los E2E tests necesitan iniciar su propio servidor."
  echo ""
  echo "   Para continuar, primero detén el servidor de desarrollo:"
  echo "   - Ctrl+C en la terminal donde corre 'bun run dev'"
  echo "   - O ejecuta: kill \$(lsof -t -i:3000)"
  echo ""
  read -p "   ¿Deseas que lo detenga automáticamente? (y/n): " -n 1 -r
  echo ""

  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "   🛑 Deteniendo proceso en puerto 3000..."
    lsof -t -i:3000 | xargs -r kill 2>/dev/null || true
    sleep 2
  else
    echo "   ❌ Abortando. Detén el servidor manualmente y vuelve a intentar."
    exit 1
  fi
fi

# ===== CLEAN NEXT.JS LOCK =====
if [ -f "$APP_DIR/.next/dev/lock" ]; then
  rm -f "$APP_DIR/.next/dev/lock"
  echo "   🧹 Lock de Next.js limpiado"
fi

# ===== BACKUP .env.local SI EXISTE =====
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$BACKUP_FILE"
  echo "   📋 Backup creado: .env.local.backup"
fi

# ===== DESACTIVAR BYPASS =====
# Crear .env.local temporal sin BYPASS_AUTH
if [ -f "$BACKUP_FILE" ]; then
  grep -v "BYPASS_AUTH" "$BACKUP_FILE" > "$ENV_FILE" || true
  echo "BYPASS_AUTH=false" >> "$ENV_FILE"
else
  echo "BYPASS_AUTH=false" > "$ENV_FILE"
fi
echo "   ✅ BYPASS_AUTH=false"

# ===== FUNCTION TO RESTORE =====
cleanup() {
  echo ""
  echo "🔄 Restaurando ambiente..."

  if [ -f "$BACKUP_FILE" ]; then
    mv "$BACKUP_FILE" "$ENV_FILE"
    echo "   ✅ .env.local restaurado"
  else
    rm -f "$ENV_FILE"
    echo "   ✅ .env.local limpiado"
  fi

  echo ""
  echo "💡 Para volver a desarrollo, ejecuta: bun run dev"
  echo "✨ Cleanup completo"
}

# Trap para restaurar en caso de error o Ctrl+C
trap cleanup EXIT

# ===== CORRER TESTS =====
echo ""
echo "🧪 Corriendo E2E tests con autenticación WorkOS..."
echo ""

cd "$APP_DIR"

# Parse arguments
if [ "$1" = "--headed" ]; then
  npx playwright test --headed "${@:2}"
elif [ -n "$1" ]; then
  npx playwright test "$@"
else
  npx playwright test
fi

# El trap cleanup() se ejecutará automáticamente al salir
