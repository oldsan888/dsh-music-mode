# @deepseek-ai/dsh-regret-radio (vendored Regret-radio music core)

Vendored copy of Regret-radio's backend + frontend static, repackaged as a
self-contained DSH workspace package. It is spawned by the DSH music-mode host
plugin (`@deepseek-ai/dsh-server-regret-visual`) which also serves `public/`
and proxies music APIs.

- `src/` — backend TypeScript (Fastify, runs via `node --import tsx/esm src/server.ts`)
- `public/` — Regret-radio frontend static (source, no build)
- `.env.example` — env template (no secrets)
- Data (SQLite/db/beatmaps/cookies/logs) lands in `./data/` relative to this package.

## Relationship to the upstream repo

Upstream: the public Regret-radio repository (the original checkout is kept
unchanged).

This vendor is a **DSH-specialized fork**:
- AI brain (LLM / memory / feishu bridge / weather / scheduler / proactivity / STT)
  is stripped; 阿呆 (the DSH agent) is the brain.
- Added: local command injection endpoint for player control (see src/routes/player.ts).

## ⚠️ Sync policy (read before running any sync script)

`sync-regret.mjs` (if added later) must follow these rules — **never blindly
overwrite this vendor**:

1. **Whitelist upstream files only**: sync only files that exist in upstream
   and are NOT DSH-specialized (e.g. `src/music/`, `src/routes/netease.ts`,
   `src/routes/qq.ts` …).
2. **Preserve DSH-specific overlays as patches**: stripped AI files, the added
   command-injection endpoint, path/env specializations must NOT be re-added or
   clobbered by an upstream copy.
3. A convenient shape is: upstream = baseline, DSH edits = a declared overlay
   list; the sync script diffs only the shared whitelist and reports conflicts
   instead of overwriting.

## Layout / conventions

- Keep relative imports as-is (no `@/` alias is actually used by src/).
- The host plugin resolves this package's path via `import.meta.url` (relative),
  never via an absolute machine path.

## Deployer: player `user_id` is configurable

The player's identity on the in-presence channel (`GET /api/player/link?user_id=…`)
defaults to **`default`** so the DSH `music_*` tools (which use the same default)
can drive this player out of the box. **The id is yours to choose, not scoped to
one person**:

- **Default**: `default` — aligns with `@deepseek-ai/dsh-tool-music`'s default `userId`.
- **Custom id**: the deploying AI / operator asks the human what id they want, then
  sets `localStorage.regretradio.user_id` to any non-empty value on the music-tab
  page and refreshes the iframe (the player reconnects SSE under that id). A shared
  deployment where every instance is a separate backend can even all keep the
  default — the id only needs to be unique within one backend instance.
- **Keep both sides in sync**: the same id must be configured on the DSH side —
  `@deepseek-ai/dsh-tool-music` `config.userId` (e.g. in `cordis.patch.yml`).
  A mismatched id makes `relayPlayerCommand` report `no_player`: the player is
  reachable in the browser, but under a different id than the tools send.
- **Migration**: an untouched upstream checkout may leave a random `u_*` identity
  in `localStorage` (upstream generates one when unset); this fork migrates such
  leftovers to the default on the next page load, so a fresh deploy just works.
