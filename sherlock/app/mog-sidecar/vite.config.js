import { resolve } from 'node:path'

const OUT_DIR = resolve(import.meta.dirname, '../public/mog')

// Orden del prefetch: primero lo que mas pesa y mas tarde se pide. El WASM
// (15 MB comprimido) solo se descarga cuando el sidecar crea el motor, ya con
// el libro en mano; el JS del sidecar va en el `<script type=module>` del
// iframe; las fuentes se piden al montar la hoja.
const PREFETCH_RANK = [/\.wasm$/, /\.js$/, /\.css$/, /\.(ttf|otf|woff2?)$/]

export function orderForPrefetch(files) {
  const rank = (file) => {
    const index = PREFETCH_RANK.findIndex((pattern) => pattern.test(file))
    return index === -1 ? PREFETCH_RANK.length : index
  }
  return [...files].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
}

// Manifiesto de prefetch (`/mog/assets-manifest.json`): la sala lo lee para
// calentar la cache HTTP con los assets del sidecar mientras el cliente mira la
// lista, asi la primera apertura de un libro no paga los 18 MB al pulsar
// "Abrir" (`xlsxSidecarPrefetch.ts`). Los nombres llevan hash de Vite, asi que
// solo el build sabe cuales son.
export function mogAssetManifestPlugin() {
  return {
    name: 'sherlock-mog-asset-manifest',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((file) => file !== 'index.html')
      this.emitFile({
        type: 'asset',
        fileName: 'assets-manifest.json',
        source: JSON.stringify(
          { prefetch: orderForPrefetch(files).map((file) => `/mog/${file}`) },
          null,
          2
        ),
      })
    },
  }
}

// Sin `@vitejs/plugin-react`: este bundle no tiene JSX propio — React entra
// como dependencia de `@mog-sdk/spreadsheet-app`, que ya viene compilado. El
// plugin ademas arrastraba una segunda copia de Vite al arbol y rompia los
// tipos de `vitest.config.ts` en la app.
const config = {
  // Servido por Next bajo el prefijo /mog/ (bypass del proxy + headers propios).
  base: '/mog/',
  plugins: [mogAssetManifestPlugin()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    // El runtime de Mog pesa ~19 MB: el aviso de chunk no aporta nada aqui.
    chunkSizeWarningLimit: 32_000,
  },
  optimizeDeps: {
    // Los paquetes @mog-sdk se sirven pre-empaquetados; pasarlos por el
    // dep-optimizer rompe sus exports CJS (LESSONS 2026-08-23).
    exclude: ['@mog-sdk/spreadsheet-app'],
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'zustand',
      'zustand/middleware',
      'zustand/react/shallow',
      'zustand/traditional',
      'use-sync-external-store',
      'use-sync-external-store/shim',
      'use-sync-external-store/shim/with-selector',
    ],
  },
}

export default config
