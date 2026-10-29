#!/usr/bin/env bash
set -euo pipefail

# Vercel build entrypoint (referenced by vercel.json buildCommand).
#
# Production and the isolated staging target: deploy Convex functions first
# and let `convex deploy` inject the derived NEXT_PUBLIC_CONVEX_URL into the
# Next build. Each target carries its own deployment-scoped key in Vercel.
#
# Preview: build only — NEVER deploy Convex from a preview. The bundle points
# at the dev Convex deployment via the NEXT_PUBLIC_CONVEX_URL variable defined
# in Vercel's Preview environment scope.
# Assets estáticos de los visores del VDR (sidecar Mog + worker de pdfjs). Van
# antes de las dos ramas porque `public/` se sirve desde el build de Next y CI
# nunca ejecuta este script: la otra cadena es `package.json` → `build`.
node scripts/build-viewer-assets.mjs
test -f public/mog/index.html || { echo 'public/mog/index.html no existe' >&2; exit 1; }
test -f public/pdfjs/pdf.worker.min.mjs || { echo 'public/pdfjs/pdf.worker.min.mjs no existe' >&2; exit 1; }

if [ "${VERCEL_ENV:-}" = "production" ]; then
  bunx convex deploy --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL --cmd 'node scripts/quarantine-next-ds-store.mjs && next build --webpack'
elif [ "${VERCEL_TARGET_ENV:-}" = "staging" ]; then
  # Convex treats every Vercel custom environment as a preview. This target is
  # intentionally backed by a permanent prod-type deployment in its own
  # sherlock-staging project, so disable only that heuristic guard.
  bunx convex deploy --check-build-environment disable --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL --cmd 'node scripts/quarantine-next-ds-store.mjs && next build --webpack'
else
  node scripts/quarantine-next-ds-store.mjs
  next build --webpack
fi
