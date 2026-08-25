/**
 * Deliberately-empty entry for @deepseek-ai/dsh-regret-radio.
 *
 * This package is a self-contained app spawned by the music-mode host plugin
 * (`node --import tsx/esm src/server.ts`), NOT a DSH library to bundle. tsdown
 * still visits it because it matches the workspace glob (`vendor/*`); this
 * empty entry makes that visit a no-op bundle (harmless, never imported) so
 * the root default entry glob (`lib/types/{index,invariant,startup}.js`) never
 * applies to this package.
 */
export {}
