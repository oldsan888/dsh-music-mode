import { defineConfig } from 'tsdown'

/**
 * @deepseek-ai/dsh-regret-radio is a self-contained app spawned by the
 * music-mode host plugin (`node --import tsx/esm src/server.ts`), NOT a DSH
 * library to bundle. tsdown still visits it because it matches the workspace
 * glob (`vendor/*`); this minimal empty entry keeps the visit a no-op so the
 * root default entry glob (`lib/types/{index,invariant,startup}.js`) never
 * applies to this package.
 */
export default defineConfig({
  entry: ['src/empty.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
})
