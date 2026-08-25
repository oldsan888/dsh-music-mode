// DSH overlay（2026-08-19 端到端联调）：音乐 tab 是 DSH 内 iframe，不需要注册
// legacy PWA（离线缓存 / APP_SHELL / beatmap 预取都已随上游 A/C 派一并退出）。
// SW 代理 /api/player/link 这类 SSE 长连会 fetch 失败（FetchEvent network
// error），因此保留一个最小 SW 仅做：① 更新即自我卸载；② 未卸载期间对
// /api/*（含 SSE）一律放行直连网络，绝不代理。

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) { /* ignore */ }
    try { if (self.registration) self.registration.unregister(); } catch (e) { /* ignore */ }
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API / SSE 直连，SW 一律不 respondWith（不缓存、不代理、不中断长连）。
  if (url.pathname.includes('/api/')) return;
});
